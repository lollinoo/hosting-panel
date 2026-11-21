import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  backupArchiveFileName,
  isBackupAvailable,
  type AdminRestoreBackupInput,
  type BackupArchiveChunk,
  type BackupArchiveChunkDto,
  type BackupTargetKind,
  type PrepareDownloadInput,
  type RestoreBackupInput,
  type SiteBackupAcceptedDto,
} from "@hosting-panel/contracts";
import {
  and,
  anyUsableTarget,
  appendAuditEvent,
  clearSiteArchive,
  enqueueOperationTransactional,
  eq,
  getSiteBackup,
  heavyActionRetryAt,
  LEGACY_BACKUP_TARGET_ID,
  listSiteBackupCopies,
  listSiteBackups,
  markSiteArchivePreparing,
  markSiteRestoreRunning,
  operations,
  organizations,
  outboxEvents,
  resolveEffectiveTargets,
  siteBackups,
  sites,
  sql,
  type CopyRow,
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
import {
  ADMIN_SITE_RESTORE_STEPS,
  SITE_ARCHIVE_STEPS,
  SITE_RESTORE_STEPS,
} from "./site-restore-applier.js";
import type { BackupSiteRef, SiteBackupActor } from "./site-backups.service.js";

const BACKUP_ID_PATTERN = /^bkp_[0-9a-f]{32}$/;
/** Backup statuses with something to read; `partial` arrives with two destinations (M4). */
const READABLE_STATUSES: ReadonlySet<string> = new Set(["succeeded", "partial"]);

/** Byte-range query accepted when reading a prepared backup archive chunk. */
export interface BackupArchiveReadQuery {
  readonly offset: number;
  readonly length: number;
}

function backupNotFoundError(): ControlPlaneError {
  return new ControlPlaneError("NOT_FOUND", "Backup not found");
}

function noSucceededBackupError(): ControlPlaneError {
  return new ControlPlaneError("VALIDATION_ERROR", "There is no succeeded backup of this site to restore.", {
    details: [{ field: "backupId", message: "no_succeeded_backup" }],
  });
}

function confirmNameError(): ControlPlaneError {
  const message = "Type the exact name of the site to restore it.";
  return new ControlPlaneError("VALIDATION_ERROR", message, {
    details: [{ field: "confirmName", message }],
  });
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

/** Restore and download need the runtime and an idle site, not a configured destination: archived targets stay restorable. */
export function assertBackupRuntimeReady(
  runtimeBackend: ControlPlaneRuntimeConfig["runtimeBackend"],
  siteStatus: string,
): void {
  assertBackupRuntimeAvailable(runtimeBackend);
  if (siteStatus === "deploying" || siteStatus === "maintenance") {
    throw new ControlPlaneError("RESOURCE_LOCKED", "not_ready", {
      details: [{ message: "not_ready", reason: "not_ready" }],
    });
  }
}

/**
 * Backups to create: the runtime offers them, a destination is usable (the site's effective ones when `siteId` is
 * given, else any), and the site is idle.
 */
export async function assertBackupInfrastructureReady(
  db: DatabaseExecutor,
  runtimeBackend: ControlPlaneRuntimeConfig["runtimeBackend"],
  siteStatus: string,
  siteId?: string,
): Promise<void> {
  assertBackupRuntimeAvailable(runtimeBackend);

  const configured = siteId
    ? (await resolveEffectiveTargets(db, siteId)).length > 0
    : await anyUsableTarget(db);
  if (!configured) {
    throw new ControlPlaneError("VALIDATION_ERROR", "not_configured", {
      details: [{ message: "not_configured" }],
    });
  }

  assertBackupRuntimeReady(runtimeBackend, siteStatus);
}

/** The copy a restore or download reads: its target (null = the legacy S3 target of an older release) and kind. */
interface SelectedCopy {
  readonly targetId: string | null;
  readonly targetKind: BackupTargetKind | null;
}

/**
 * The requested target must hold a succeeded copy of this backup; without one, the lowest-priority succeeded copy.
 * A backup without copy rows but with a snapshot is the legacy S3 copy. Null: nothing restorable matches.
 */
function selectCopy(
  row: SiteBackupRow,
  copies: readonly CopyRow[],
  requested: string | undefined,
): SelectedCopy | null {
  if (copies.length === 0) {
    return row.snapshotId !== null && (requested === undefined || requested === LEGACY_BACKUP_TARGET_ID)
      ? { targetId: null, targetKind: "s3" }
      : null;
  }
  const succeeded = copies.filter((c) => c.status === "succeeded");
  const copy = requested === undefined ? succeeded[0] : succeeded.find((c) => c.targetId === requested);
  return copy ? { targetId: copy.targetId, targetKind: copy.targetKind } : null;
}

/** Canonical request identity of a restore or download: replaying a key with another backup or target conflicts. */
function requestHashOf(backupId: string, targetId: string | null): string {
  return createHash("sha256").update(JSON.stringify({ backupId, targetId })).digest("hex");
}

/** Appends a standardized user-initiated backup audit event inside or after the calling unit of work. */
export async function appendUserBackupAudit(
  db: DatabaseExecutor,
  site: Pick<BackupSiteRef, "id" | "organizationId">,
  actor: SiteBackupActor,
  actionSuffix: "create" | "restore" | "restore.requested" | "download" | "download.fetched",
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

/** Rejects a customer's heavy action over the site's or the organisation's hourly limit; admins bypass. */
export async function assertHeavyActionAllowed(
  tx: DatabaseExecutor,
  siteId: string,
  actor: SiteBackupActor,
  op: { id: string; submittedAt: Date },
): Promise<void> {
  if (actor.actionPrefix === "admin.site.backups") {
    return;
  }
  // Serialises the organisation's count (R182.1: FOR UPDATE would conflict with the KEY SHARE of every insert).
  const [org] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .innerJoin(sites, eq(sites.organizationId, organizations.id))
    .where(eq(sites.id, siteId))
    .for("no key update", { of: organizations });
  const siteAt = await heavyActionRetryAt(tx, { siteId }, op.submittedAt, op.id);
  const orgAt = org ? await heavyActionRetryAt(tx, { organizationId: org.id }, op.submittedAt, op.id) : null;
  const retryAt = siteAt && orgAt ? (siteAt >= orgAt ? siteAt : orgAt) : (siteAt ?? orgAt);
  if (!retryAt) {
    return;
  }
  const iso = retryAt.toISOString();
  throw new ControlPlaneError(
    "QUOTA_EXCEEDED",
    retryAt === siteAt
      ? `Too many backup actions on this site; try again at ${iso}`
      : `Too many backup actions in this organisation; try again at ${iso}`,
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
    const { row, copy } = await this.#requireManagedBackup(site.id, backupId, input.targetId);
    assertBackupRuntimeReady(this.config.runtimeBackend, site.status);

    if (input.confirmName.trim() !== site.name) {
      throw confirmNameError();
    }

    return await this.#enqueueBackupAction({
      site,
      actor,
      backupId: row.id,
      copy,
      idempotencyKey,
      kind: "site.backups.restore",
      steps: SITE_RESTORE_STEPS,
      markRunning: async (tx, operationId) => {
        await markSiteRestoreRunning(tx, row.id, operationId);
        await tx.update(siteBackups).set({ restoreTargetId: copy.targetId }).where(eq(siteBackups.id, row.id));
      },
      auditSuffix: "restore",
    });
  }

  /** Queues an administrator's restore of the named or newest succeeded copy, without the customers' limit. */
  public async restoreAsAdmin(
    site: BackupSiteRef & { name: string },
    actor: SiteBackupActor,
    input: AdminRestoreBackupInput,
    idempotencyKey: string,
  ): Promise<SiteBackupAcceptedDto> {
    // A replay keeps the copy the first request chose, even when a newer one exists now.
    const backupId =
      input.backupId ?? (await this.#replayedBackupId(site, idempotencyKey)) ?? null;
    let found: { row: SiteBackupRow; copy: SelectedCopy } | undefined;
    if (backupId !== null) {
      found = await this.#requireManagedBackup(site.id, backupId, input.targetId).catch(() => undefined);
    } else {
      const rows = await listSiteBackups(this.dbClient.db, site.id);
      const copies = await listSiteBackupCopies(this.dbClient.db, rows.map((r) => r.id));
      for (const candidate of rows) {
        const copy = this.#restorableCopy(candidate, copies.get(candidate.id) ?? [], input.targetId);
        if (copy) {
          found = { row: candidate, copy };
          break;
        }
      }
    }
    if (!found) {
      throw noSucceededBackupError();
    }
    assertBackupRuntimeReady(this.config.runtimeBackend, site.status);
    if (input.confirmName.trim() !== site.name) {
      throw confirmNameError();
    }

    const backupRowId = found.row.id;
    const copy = found.copy;
    return await this.#enqueueBackupAction({
      site,
      actor,
      backupId: backupRowId,
      copy,
      idempotencyKey,
      kind: "site.backups.restore",
      steps: ADMIN_SITE_RESTORE_STEPS,
      markRunning: async (tx, operationId) => {
        await markSiteRestoreRunning(tx, backupRowId, operationId);
        await tx.update(siteBackups).set({ restoreTargetId: copy.targetId }).where(eq(siteBackups.id, backupRowId));
      },
      auditSuffix: "restore.requested",
    });
  }

  /** Reuses an active preparing/ready archive or queues preparation of a downloadable backup zip archive. */
  public async prepareDownload(
    site: BackupSiteRef & { name: string },
    actor: SiteBackupActor,
    backupId: string,
    idempotencyKey: string,
    input: PrepareDownloadInput = {},
  ): Promise<SiteBackupAcceptedDto> {
    const { row, copy } = await this.#requireManagedBackup(site.id, backupId, input.targetId);
    assertBackupRuntimeReady(this.config.runtimeBackend, site.status);

    const nowMs = Date.now();
    // An archive prepared from another copy is not this request's: queue a new one.
    const isActiveArchive =
      row.archiveOperationId !== null &&
      row.archiveTargetId === copy.targetId &&
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
      copy,
      idempotencyKey,
      kind: "site.backups.download",
      steps: SITE_ARCHIVE_STEPS,
      markRunning: async (tx, operationId) => {
        await markSiteArchivePreparing(tx, site.id, row.id, operationId);
        await tx.update(siteBackups).set({ archiveTargetId: copy.targetId }).where(eq(siteBackups.id, row.id));
      },
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
    // A row with no restorable copy is the same 404 as on POST: "prepare it again" could never succeed.
    const { row } = await this.#requireManagedBackup(site.id, backupId, undefined);

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

  /** A backup of this site that finished with at least one copy: succeeded or partial. */
  async #requireBackupRow(siteId: string, backupId: string): Promise<SiteBackupRow> {
    if (!BACKUP_ID_PATTERN.test(backupId)) {
      throw backupNotFoundError();
    }
    const row = await getSiteBackup(this.dbClient.db, siteId, backupId);
    if (!row || !READABLE_STATUSES.has(row.status)) {
      throw backupNotFoundError();
    }
    return row;
  }

  /** The backup and the copy to read; a foreign, failed or absent copy is the same 404 (no oracle on other targets). */
  async #requireManagedBackup(
    siteId: string,
    backupId: string,
    targetId: string | undefined,
  ): Promise<{ row: SiteBackupRow; copy: SelectedCopy }> {
    const row = await this.#requireBackupRow(siteId, backupId);
    const copies = (await listSiteBackupCopies(this.dbClient.db, [row.id])).get(row.id) ?? [];
    const copy = selectCopy(row, copies, targetId);
    if (!copy) {
      throw backupNotFoundError();
    }
    return { row, copy };
  }

  #restorableCopy(
    row: SiteBackupRow,
    copies: readonly CopyRow[],
    targetId: string | undefined,
  ): SelectedCopy | null {
    return READABLE_STATUSES.has(row.status) ? selectCopy(row, copies, targetId) : null;
  }

  /** Backup id of an earlier restore of this site queued with the same idempotency key, if any. */
  async #replayedBackupId(site: BackupSiteRef, idempotencyKey: string): Promise<string | undefined> {
    const [evt] = await this.dbClient.db
      .select({ backupId: sql<string | null>`${outboxEvents.payload}->>'backupId'` })
      .from(outboxEvents)
      .innerJoin(operations, sql`${operations.id} = ${outboxEvents.payload}->>'operationId'`)
      .where(
        and(
          eq(operations.organizationId, site.organizationId),
          eq(operations.idempotencyKey, idempotencyKey),
          eq(operations.kind, "site.backups.restore"),
          eq(operations.resourceId, site.id),
        ),
      )
      .limit(1);
    return evt?.backupId ?? undefined;
  }

  async #enqueueBackupAction(opts: {
    readonly site: BackupSiteRef & { name: string };
    readonly actor: SiteBackupActor;
    readonly backupId: string;
    readonly copy: SelectedCopy;
    readonly idempotencyKey: string;
    readonly kind: "site.backups.restore" | "site.backups.download";
    readonly steps: readonly { readonly key: string; readonly label: string }[];
    readonly markRunning: (tx: DatabaseExecutor, operationId: string) => Promise<void>;
    readonly auditSuffix: "restore" | "restore.requested" | "download";
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
          requestHash: requestHashOf(opts.backupId, opts.copy.targetId),
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
        targetId: opts.copy.targetId,
        targetKind: opts.copy.targetKind,
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
