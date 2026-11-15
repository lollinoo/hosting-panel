import { Inject, Injectable } from "@nestjs/common";
import {
  backupArchiveFileName,
  isBackupAvailable,
  type BackupArchiveChunk,
  type BackupArchiveChunkDto,
  type RestoreBackupInput,
  type SiteBackupAcceptedDto,
} from "@hosting-panel/contracts";
import {
  and,
  appendAuditEvent,
  clearSiteArchive,
  enqueueOperationTransactional,
  eq,
  getBackupSettingsPublic,
  getSiteBackup,
  heavyActionRetryAt,
  markSiteArchivePreparing,
  markSiteRestoreRunning,
  outboxEvents,
  sql,
  type DatabaseClient,
  type DatabaseExecutor,
  type HostingPanelDatabase,
  type SiteBackupRow,
} from "@hosting-panel/database";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
import {
  ControlPlaneError,
  extractClientIp,
  extractRawHeader,
  resolveRequestId,
} from "../common/control-plane.error.js";
import {
  CONTROL_PLANE_CONFIG_TOKEN,
  DATABASE_CLIENT_TOKEN,
  DOCKER_EXECUTOR_TOKEN,
  type ControlPlaneRuntimeConfig,
} from "../tokens.js";
import { BACKUP_LEASE_MS } from "./site-backups-applier.js";
import { SITE_ARCHIVE_STEPS, SITE_RESTORE_STEPS } from "./site-restore-applier.js";
import type { BackupSiteRef, SiteBackupActor } from "./site-backups.service.js";

const BACKUP_ID_PATTERN = /^bkp_[0-9a-f]{32}$/;

/** Byte-range query accepted when reading a prepared backup archive chunk. */
export interface BackupArchiveReadQuery {
  readonly offset: number;
  readonly length: number;
}

function backupNotFoundError(): ControlPlaneError {
  return new ControlPlaneError("NOT_FOUND", "Backup not found");
}

function archiveGoneError(): ControlPlaneError {
  return new ControlPlaneError(
    "NOT_FOUND",
    "This download is no longer available. Prepare it again.",
    { details: [{ reason: "archive_gone", message: "archive_gone" }] },
  );
}

function archivePreparingError(): ControlPlaneError {
  return new ControlPlaneError(
    "RESOURCE_LOCKED",
    "This download is still being prepared. Try again in a moment.",
    { details: [{ reason: "archive_preparing", message: "archive_preparing" }] },
  );
}

/** Throws NOT_SUPPORTED when the configured runtime backend cannot execute site backups. */
function assertBackupRuntimeAvailable(
  runtimeBackend: ControlPlaneRuntimeConfig["runtimeBackend"],
): void {
  if (!isBackupAvailable(runtimeBackend)) {
    throw new ControlPlaneError(
      "NOT_SUPPORTED",
      "Backups are only available on the linux-systemd runtime backend",
    );
  }
}

/** Validates backend availability, target settings configuration, and site readiness before queuing a backup mutation. */
export async function assertBackupInfrastructureReady(
  db: DatabaseExecutor,
  runtimeBackend: ControlPlaneRuntimeConfig["runtimeBackend"],
  siteStatus: string,
): Promise<void> {
  assertBackupRuntimeAvailable(runtimeBackend);

  const settings = await getBackupSettingsPublic(db);
  if (!settings) {
    throw new ControlPlaneError("VALIDATION_ERROR", "not_configured", {
      details: [{ message: "not_configured" }],
    });
  }

  if (siteStatus === "deploying" || siteStatus === "maintenance") {
    throw new ControlPlaneError("RESOURCE_LOCKED", "not_ready", {
      details: [{ message: "not_ready", reason: "not_ready" }],
    });
  }
}

/** Appends a standardized user-initiated backup audit event inside or after the calling unit of work. */
export async function appendUserBackupAudit(
  db: DatabaseExecutor,
  site: Pick<BackupSiteRef, "id" | "organizationId">,
  actor: SiteBackupActor,
  actionSuffix: "create" | "restore" | "download" | "download.fetched",
  details: Record<string, unknown>,
): Promise<void> {
  const actionPrefix = actor.actionPrefix ?? "site.backups";
  await appendAuditEvent(db as unknown as HostingPanelDatabase, {
    actorId: actor.auth.user.id,
    actorType: "user",
    organizationId: site.organizationId,
    action: `${actionPrefix}.${actionSuffix}`,
    targetType: "site",
    targetId: site.id,
    ipAddress: extractClientIp(actor.req),
    userAgent: extractRawHeader(
      actor.req.headers as Record<string, string | string[] | undefined>,
      "user-agent",
    ),
    details: {
      outcome: "succeeded",
      ...details,
    },
  });
}

/** Rejects a customer's 7th heavy backup action on a site within 60 minutes; admins bypass. */
export async function assertHeavyActionAllowed(
  tx: DatabaseExecutor,
  siteId: string,
  actor: SiteBackupActor,
  op: { id: string; submittedAt: Date },
): Promise<void> {
  if (actor.actionPrefix === "admin.site.backups") {
    return;
  }
  const retryAt = await heavyActionRetryAt(tx, siteId, op.submittedAt, op.id);
  if (!retryAt) {
    return;
  }
  const iso = retryAt.toISOString();
  throw new ControlPlaneError(
    "QUOTA_EXCEEDED",
    `Too many backup actions on this site; try again at ${iso}`,
    {
      details: [{ field: "retryAt", reason: "too_many_requests", message: iso }],
      retryAfterMs: Math.max(1_000, retryAt.getTime() - op.submittedAt.getTime()),
    },
  );
}

/** API domain service for queueing M3b backup restores, preparing downloadable archives, and reading archive chunks. */
@Injectable()
export class SiteRestoreService {
  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(DOCKER_EXECUTOR_TOKEN) private readonly dockerExecutor: DockerExecutorPort,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) private readonly config: ControlPlaneRuntimeConfig,
  ) {}

  /** Queues an asynchronous site restore from one succeeded backup after checking preconditions, confirmation, and heavy-action quota. */
  public async restore(
    site: BackupSiteRef & { name: string },
    actor: SiteBackupActor,
    backupId: string,
    input: RestoreBackupInput,
    idempotencyKey: string,
  ): Promise<SiteBackupAcceptedDto> {
    const row = await this.#requireManagedBackup(site.id, backupId);
    await assertBackupInfrastructureReady(this.dbClient.db, this.config.runtimeBackend, site.status);

    if (input.confirmName.trim() !== site.name) {
      throw new ControlPlaneError(
        "VALIDATION_ERROR",
        "Type the exact name of the site to restore it.",
        {
          details: [
            {
              field: "confirmName",
              message: "Type the exact name of the site to restore it.",
            },
          ],
        },
      );
    }

    return await this.#enqueueBackupAction({
      site,
      actor,
      backupId: row.id,
      idempotencyKey,
      kind: "site.backups.restore",
      steps: SITE_RESTORE_STEPS,
      markRunning: (tx, operationId) => markSiteRestoreRunning(tx, row.id, operationId),
      auditSuffix: "restore",
    });
  }

  /** Reuses an active preparing/ready archive or queues preparation of a downloadable backup zip archive. */
  public async prepareDownload(
    site: BackupSiteRef & { name: string },
    actor: SiteBackupActor,
    backupId: string,
    idempotencyKey: string,
  ): Promise<SiteBackupAcceptedDto> {
    const row = await this.#requireManagedBackup(site.id, backupId);
    await assertBackupInfrastructureReady(this.dbClient.db, this.config.runtimeBackend, site.status);

    const nowMs = Date.now();
    const isActiveArchive =
      row.archiveOperationId !== null &&
      (row.archiveStatus === "preparing" ||
        (row.archiveStatus === "ready" &&
          row.archiveReadyUntil !== null &&
          row.archiveReadyUntil.getTime() > nowMs));

    if (isActiveArchive) {
      return {
        siteId: site.id,
        backupId: row.id,
        operationId: row.archiveOperationId!,
      };
    }

    return await this.#enqueueBackupAction({
      site,
      actor,
      backupId: row.id,
      idempotencyKey,
      kind: "site.backups.download",
      steps: SITE_ARCHIVE_STEPS,
      markRunning: (tx, operationId) => markSiteArchivePreparing(tx, site.id, row.id, operationId),
      auditSuffix: "download",
    });
  }

  /** Streams one byte range from a prepared backup zip archive and audits the initial chunk read. */
  public async readArchive(
    site: BackupSiteRef & { name: string },
    actor: SiteBackupActor,
    backupId: string,
    query: BackupArchiveReadQuery,
  ): Promise<BackupArchiveChunkDto> {
    assertBackupRuntimeAvailable(this.config.runtimeBackend);
    const row = await this.#requireManagedBackup(site.id, backupId);

    if (row.archiveStatus === "preparing") {
      throw archivePreparingError();
    }

    if (
      row.archiveStatus !== "ready" ||
      !row.archiveReadyUntil ||
      row.archiveReadyUntil.getTime() <= Date.now() ||
      !row.archiveOperationId
    ) {
      throw archiveGoneError();
    }

    let chunk: BackupArchiveChunk;
    try {
      chunk = await this.dockerExecutor.backups({
        action: "readArchive",
        jobId: row.archiveOperationId,
        offset: query.offset,
        length: query.length,
      });
    } catch (err) {
      const rawCode =
        typeof err === "object" && err !== null && "code" in err
          ? (err as { code?: unknown }).code
          : undefined;
      if (rawCode === "NOT_FOUND") {
        // Executor lost or expired the staged file ahead of DB metadata; clear stale state lazily.
        await clearSiteArchive(this.dbClient.db, row.id, row.archiveOperationId);
        throw archiveGoneError();
      }
      if (rawCode === "RESOURCE_LOCKED") {
        throw archivePreparingError();
      }
      const ambiguous =
        (typeof err === "object" &&
          err !== null &&
          (err as { ambiguousOutcome?: unknown }).ambiguousOutcome === true) ||
        rawCode === "OPERATION_AMBIGUOUS";
      if (ambiguous) {
        throw new ControlPlaneError(
          "OPERATION_AMBIGUOUS",
          "Could not confirm the backup archive read.",
        );
      }
      if (rawCode === "VALIDATION_ERROR") {
        throw new ControlPlaneError("VALIDATION_ERROR", "The archive read range is invalid.");
      }
      throw new ControlPlaneError(
        "DOCKER_ENGINE_UNAVAILABLE",
        "Backup archive downloads are temporarily unavailable.",
      );
    }

    if (query.offset === 0) {
      await appendUserBackupAudit(this.dbClient.db, site, actor, "download.fetched", {
        requestId: resolveRequestId(actor.req),
        backupId: row.id,
        operationId: row.archiveOperationId,
        size: chunk.size,
      });
    }

    return {
      dataBase64: chunk.dataBase64,
      size: chunk.size,
      eof: chunk.eof,
      fileName: backupArchiveFileName(site.name, row.startedAt),
    };
  }

  async #requireManagedBackup(siteId: string, backupId: string): Promise<SiteBackupRow> {
    if (!BACKUP_ID_PATTERN.test(backupId)) {
      throw backupNotFoundError();
    }
    const row = await getSiteBackup(this.dbClient.db, siteId, backupId);
    if (!row || row.status !== "succeeded" || row.snapshotId === null) {
      throw backupNotFoundError();
    }
    return row;
  }

  async #enqueueBackupAction(opts: {
    readonly site: BackupSiteRef & { name: string };
    readonly actor: SiteBackupActor;
    readonly backupId: string;
    readonly idempotencyKey: string;
    readonly kind: "site.backups.restore" | "site.backups.download";
    readonly steps: readonly { readonly key: string; readonly label: string }[];
    readonly markRunning: (tx: DatabaseExecutor, operationId: string) => Promise<void>;
    readonly auditSuffix: "restore" | "download";
  }): Promise<SiteBackupAcceptedDto> {
    const operationId = await this.dbClient.db.transaction(async (tx) => {
      const enqueued = await enqueueOperationTransactional(
        tx as unknown as HostingPanelDatabase,
        {
          organizationId: opts.site.organizationId,
          kind: opts.kind,
          resourceType: "site",
          resourceId: opts.site.id,
          requestedByUserId: opts.actor.auth.user.id,
          idempotencyKey: opts.idempotencyKey,
          lockKey: `site:${opts.site.id}`,
          leaseDurationMs: BACKUP_LEASE_MS,
          steps: opts.steps,
          outboxPayload: { siteId: opts.site.id, backupId: opts.backupId },
        },
      );

      if (enqueued.idempotentReplay) {
        const [replayedEvent] = await tx
          .select({ payload: outboxEvents.payload })
          .from(outboxEvents)
          .where(
            and(
              eq(outboxEvents.aggregateId, opts.site.id),
              sql`${outboxEvents.payload}->>'operationId' = ${enqueued.operation.id}`,
            ),
          )
          .limit(1);

        const replayedBackupId =
          replayedEvent &&
          typeof replayedEvent.payload === "object" &&
          replayedEvent.payload !== null
            ? (replayedEvent.payload as { backupId?: unknown }).backupId
            : undefined;

        if (replayedBackupId !== opts.backupId) {
          throw new ControlPlaneError(
            "IDEMPOTENCY_CONFLICT",
            "Idempotency key was already used for a different backup",
          );
        }
        return enqueued.operation.id;
      }

      // Check heavy-action quota inside the transaction so a refusal leaves no operation behind.
      await assertHeavyActionAllowed(tx, opts.site.id, opts.actor, {
        id: enqueued.operation.id,
        submittedAt: enqueued.operation.submittedAt,
      });

      await opts.markRunning(tx, enqueued.operation.id);
      await appendUserBackupAudit(tx, opts.site, opts.actor, opts.auditSuffix, {
        requestId: resolveRequestId(opts.actor.req),
        backupId: opts.backupId,
        operationId: enqueued.operation.id,
      });

      return enqueued.operation.id;
    });

    return {
      siteId: opts.site.id,
      backupId: opts.backupId,
      operationId,
    };
  }
}
