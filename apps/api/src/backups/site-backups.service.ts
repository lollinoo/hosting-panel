import { Inject, Injectable } from "@nestjs/common";
import {
  DEFAULT_BACKUP_RETENTION_DAYS,
  MANUAL_BACKUPS_KEPT,
  isBackupAvailable,
  type BackupKind,
  type SiteBackupAcceptedDto,
  type SiteBackupsDto,
} from "@hosting-panel/contracts";
import {
  appendAuditEvent,
  enqueueOperationTransactional,
  eq,
  getBackupSettingsPublic,
  insertSiteBackup,
  listSiteBackups,
  siteBackups,
  type DatabaseClient,
  type DatabaseExecutor,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import type { FastifyRequest } from "fastify";
import type { AuthenticatedRequestContext } from "../auth/authz-context.service.js";
import {
  ControlPlaneError,
  extractClientIp,
  extractRawHeader,
  resolveRequestId,
} from "../common/control-plane.error.js";
import { CONTROL_PLANE_CONFIG_TOKEN, DATABASE_CLIENT_TOKEN, type ControlPlaneRuntimeConfig } from "../tokens.js";
import { BACKUP_LEASE_MS } from "./site-backups-applier.js";

export const SITE_BACKUP_STEPS = [
  { key: "backup", label: "Back up files and databases" },
  { key: "retention", label: "Remove old backups" },
] as const satisfies readonly { key: string; label: string }[];

export const SITE_BACKUP_PRUNE_STEPS = [
  { key: "retention", label: "Remove old backups" },
] as const satisfies readonly { key: string; label: string }[];

export interface SiteBackupActor {
  readonly auth: AuthenticatedRequestContext;
  readonly req: FastifyRequest;
  readonly actionPrefix?: "site.backups" | "admin.site.backups";
}

export interface BackupSiteRef {
  readonly id: string;
  readonly organizationId: string;
  readonly status: string;
}

export interface EnqueueBackupTxInput {
  readonly kind: BackupKind;
  readonly requestedByUserId?: string;
  readonly idempotencyKey?: string;
}

export interface EnqueueBackupTxResult {
  readonly backupId: string;
  readonly operationId: string;
  readonly idempotentReplay: boolean;
}

async function enqueueSiteBackupTx(
  tx: DatabaseExecutor,
  site: BackupSiteRef,
  input: EnqueueBackupTxInput,
): Promise<EnqueueBackupTxResult> {
  const enqueued = await enqueueOperationTransactional(
    tx as unknown as HostingPanelDatabase,
    {
      organizationId: site.organizationId,
      kind: "site.backups.create",
      resourceType: "site",
      resourceId: site.id,
      ...(input.requestedByUserId !== undefined
        ? { requestedByUserId: input.requestedByUserId }
        : {}),
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
      lockKey: `site:${site.id}`,
      leaseDurationMs: BACKUP_LEASE_MS,
      steps: SITE_BACKUP_STEPS,
      outboxPayload: { siteId: site.id },
    },
  );

  if (enqueued.idempotentReplay) {
    const [existing] = await tx
      .select({ id: siteBackups.id })
      .from(siteBackups)
      .where(eq(siteBackups.operationId, enqueued.operation.id))
      .limit(1);
    if (!existing) {
      throw new ControlPlaneError(
        "INTERNAL_ERROR",
        "Backup record for replayed operation was not found",
      );
    }
    return {
      backupId: existing.id,
      operationId: enqueued.operation.id,
      idempotentReplay: true,
    };
  }

  const { id: backupId } = await insertSiteBackup(tx, {
    siteId: site.id,
    kind: input.kind,
    status: "running",
    operationId: enqueued.operation.id,
  });

  return {
    backupId,
    operationId: enqueued.operation.id,
    idempotentReplay: false,
  };
}

/** Manages listing and queuing encrypted backups for a managed site. */
@Injectable()
export class SiteBackupsService {
  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) private readonly config: ControlPlaneRuntimeConfig,
  ) {}

  /** Enqueues a site backup operation and initial running row inside an existing transaction. */
  public static async enqueueBackupTx(
    tx: DatabaseExecutor,
    site: BackupSiteRef,
    input: EnqueueBackupTxInput,
  ): Promise<EnqueueBackupTxResult> {
    return enqueueSiteBackupTx(tx, site, input);
  }

  /** Enqueues a site backup operation and initial running row inside an existing transaction. */
  public async enqueueBackupTx(
    tx: DatabaseExecutor,
    site: BackupSiteRef,
    input: EnqueueBackupTxInput,
  ): Promise<EnqueueBackupTxResult> {
    return enqueueSiteBackupTx(tx, site, input);
  }

  /** Returns backup availability, settings summary, and sanitized backup history for a site. */
  public async list(site: Pick<BackupSiteRef, "id">): Promise<SiteBackupsDto> {
    const available = isBackupAvailable(this.config.runtimeBackend);
    const settings = await getBackupSettingsPublic(this.dbClient.db);
    const configured = settings !== null;
    const retentionDays = settings?.retentionDays ?? DEFAULT_BACKUP_RETENTION_DAYS;

    if (!available) {
      return {
        available: false,
        configured,
        retentionDays,
        manualKept: MANUAL_BACKUPS_KEPT,
        runningOperationId: null,
        backups: [],
      };
    }

    const rows = await listSiteBackups(this.dbClient.db, site.id);
    const runningOperationId = rows.find((row) => row.status === "running")?.operationId ?? null;

    return {
      available: true,
      configured,
      retentionDays,
      manualKept: MANUAL_BACKUPS_KEPT,
      runningOperationId,
      backups: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        status: row.status,
        startedAt: row.startedAt.toISOString(),
        finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
        sizeBytes: row.sizeBytes,
        problem: row.problem,
      })),
    };
  }

  /** Validates backup preconditions, queues a manual backup, and audits new requests. */
  public async create(
    site: BackupSiteRef,
    actor: SiteBackupActor,
    idempotencyKey: string,
  ): Promise<SiteBackupAcceptedDto> {
    if (!isBackupAvailable(this.config.runtimeBackend)) {
      throw new ControlPlaneError(
        "NOT_SUPPORTED",
        "Backups are only available on the linux-systemd runtime backend",
      );
    }

    const settings = await getBackupSettingsPublic(this.dbClient.db);
    if (!settings) {
      throw new ControlPlaneError("VALIDATION_ERROR", "not_configured", {
        details: [{ message: "not_configured" }],
      });
    }

    if (site.status === "deploying" || site.status === "maintenance") {
      throw new ControlPlaneError("RESOURCE_LOCKED", "not_ready", {
        details: [{ message: "not_ready", reason: "not_ready" }],
      });
    }

    const result = await this.dbClient.db.transaction(async (tx) => {
      const enqueued = await enqueueSiteBackupTx(tx, site, {
        kind: "manual",
        requestedByUserId: actor.auth.user.id,
        idempotencyKey,
      });

      if (!enqueued.idempotentReplay) {
        const actionPrefix = actor.actionPrefix ?? "site.backups";
        await appendAuditEvent(tx as unknown as HostingPanelDatabase, {
          actorId: actor.auth.user.id,
          actorType: "user",
          organizationId: site.organizationId,
          action: `${actionPrefix}.create`,
          targetType: "site",
          targetId: site.id,
          ipAddress: extractClientIp(actor.req),
          userAgent: extractRawHeader(
            actor.req.headers as Record<string, string | string[] | undefined>,
            "user-agent",
          ),
          details: {
            outcome: "succeeded",
            requestId: resolveRequestId(actor.req),
            backupId: enqueued.backupId,
            operationId: enqueued.operationId,
            kind: "manual",
          },
        });
      }

      return enqueued;
    });

    return {
      siteId: site.id,
      backupId: result.backupId,
      operationId: result.operationId,
    };
  }
}
