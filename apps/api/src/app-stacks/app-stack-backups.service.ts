import { Inject, Injectable } from "@nestjs/common";
import {
  APP_AUDIT_ACTIONS,
  type AppStackBackupUnavailableReason,
  type AppStackBackupsDto,
  type RestoreAppStackBackupInput,
} from "@hosting-panel/contracts";
import {
  enqueueAppStackBackupTransactional,
  listAppStackBackupCopies,
  listAppStackBackups,
  listAppStackVolumes,
  resolveAppStackBackupTargets,
  type AppStackBackupWriteResult,
  type AppStackRow,
  type AppStackWriteResult,
  type DatabaseClient,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
import { appRefusal, guardedApp } from "../app-templates/app-template-errors.js";
import { canonicalRequestHash } from "../common/request-hash.js";
import { CONTROL_PLANE_CONFIG_TOKEN, DATABASE_CLIENT_TOKEN, DOCKER_EXECUTOR_TOKEN, type ControlPlaneRuntimeConfig } from "../tokens.js";
import { appStackBackupToGoBackTo } from "./app-stack-backup-retention.js";
import { appStackBackupsAvailable } from "./app-stack-backup-runtime.js";
import { appStackBackupDto } from "./app-stack-dto.js";
import { mapAppStackError } from "./app-stack-errors.js";
import type { AppStackRequestContext } from "./app-stacks.service.js";

/** Who asks: a customer is limited per hour, a server administrator is not (ADR-0038 K8). */
export interface AppStackBackupRequester {
  readonly limited: boolean;
}

/**
 * Backups of an application and the restore into the same application (ADR-0038). Both are queued: the worker stops
 * the application, copies or writes its data and starts it again. Nothing here names a destination, a path or a
 * snapshot: the customer sees that a copy exists and whether it is good.
 */
@Injectable()
export class AppStackBackupsService {
  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) private readonly config: ControlPlaneRuntimeConfig,
    @Inject(DOCKER_EXECUTOR_TOKEN) private readonly executor: DockerExecutorPort,
  ) {}

  /** Newest first, with the reason «Create backup» is not offered when it is not. */
  public async list(stack: AppStackRow): Promise<AppStackBackupsDto> {
    const db = this.dbClient.db;
    const scope = { organizationId: stack.organizationId, stackId: stack.id };
    const [rows, volumes] = await Promise.all([listAppStackBackups(db, scope), listAppStackVolumes(db, scope)]);
    const copies = await listAppStackBackupCopies(
      db,
      rows.map((row) => row.id),
    );
    const present = new Set(volumes.filter((volume) => volume.status === "present").map((volume) => volume.volumeKey));
    return {
      backups: rows.map((row) => appStackBackupDto(row, copies.get(row.id) ?? [], present)),
      unavailableReason: await this.#unavailableReason(present.size),
      goBackTo: appStackBackupToGoBackTo(rows)?.id ?? null,
    };
  }

  public create(ctx: AppStackRequestContext, stack: AppStackRow, requester: AppStackBackupRequester): Promise<AppStackWriteResult> {
    return this.#enqueue(ctx, stack, requester, null, {});
  }

  /** The name is typed again, like for a delete: a restore replaces what the application holds now. */
  public restore(
    ctx: AppStackRequestContext,
    stack: AppStackRow,
    backupId: string,
    input: RestoreAppStackBackupInput,
    requester: AppStackBackupRequester,
  ): Promise<AppStackWriteResult> {
    if (input.confirmName !== stack.name) {
      const message = "Type the name of the application to confirm.";
      throw appRefusal("VALIDATION_ERROR", message, { field: "confirmName", message, reason: "confirmation_mismatch" });
    }
    return this.#enqueue(ctx, stack, requester, backupId, { backupId });
  }

  async #unavailableReason(presentVolumes: number): Promise<AppStackBackupUnavailableReason | null> {
    if (!appStackBackupsAvailable(this.executor, this.config.runtimeBackend)) return "not_available";
    if (presentVolumes === 0) return "no_data";
    return (await resolveAppStackBackupTargets(this.dbClient.db)).length === 0 ? "no_destination" : null;
  }

  async #enqueue(
    ctx: AppStackRequestContext,
    stack: AppStackRow,
    requester: AppStackBackupRequester,
    sourceBackupId: string | null,
    body: Record<string, unknown>,
  ): Promise<AppStackWriteResult> {
    if (!appStackBackupsAvailable(this.executor, this.config.runtimeBackend)) {
      const message = "Application backups are not available on this server.";
      throw appRefusal("NOT_SUPPORTED", message, { message, reason: "STACK_UNSUPPORTED_FEATURE" });
    }
    const action = sourceBackupId === null ? APP_AUDIT_ACTIONS.backupCreate : APP_AUDIT_ACTIONS.backupRestore;
    const requestHash = canonicalRequestHash({ route: action, organizationId: ctx.organizationId, stackId: stack.id, body });
    const written: AppStackBackupWriteResult = await guardedApp(mapAppStackError, () =>
      this.dbClient.db.transaction(async (raw) => {
        const tx = raw as unknown as HostingPanelDatabase;
        const r = await enqueueAppStackBackupTransactional(tx, {
          organizationId: ctx.organizationId,
          stackId: stack.id,
          kind: sourceBackupId === null ? "stack.backup" : "stack.restore",
          sourceBackupId,
          requestedByUserId: ctx.userId,
          idempotencyKey: ctx.idempotencyKey,
          requestHash,
          limited: requester.limited,
        });
        if (!r.idempotentReplay) {
          // Ids of the panel's own rows only: no destination, path or snapshot.
          await ctx.audit(tx, {
            action,
            targetType: "app_stack",
            targetId: stack.id,
            details: {
              operationId: r.operation.id,
              backupId: r.backup.id,
              ...(sourceBackupId === null ? {} : { sourceBackupId }),
              status: r.stack.status,
            },
          });
        }
        return r;
      }),
    );
    return { stack: written.stack, revision: null, deployment: null, operation: written.operation, idempotentReplay: written.idempotentReplay };
  }
}
