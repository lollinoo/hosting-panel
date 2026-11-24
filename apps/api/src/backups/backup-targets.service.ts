import { Inject, Injectable } from "@nestjs/common";
import {
  BACKUP_FAILURE_CLASSES,
  BackupTargetIdSchema,
  CreateBackupTargetInputSchema,
  UpdateBackupTargetInputSchema,
  isBackupAvailable,
  type AdminBackupTargetDto,
  type BackupPolicyScope,
  type BackupProblem,
  type BackupTargetsDto,
  type BackupTestResultDto,
} from "@hosting-panel/contracts";
import {
  BackupTargetsRepositoryError,
  appendAuditEvent,
  archiveBackupTarget,
  backupTargets,
  deleteBackupTargetIfUnreferenced,
  eq,
  getBackupTargetRow,
  insertLocalTarget,
  insertS3Target,
  listBackupTargets,
  markLocalTargetInitialized,
  recordBackupTest,
  recordTargetTest,
  resolveDispatchTarget,
  sql,
  updateBackupTarget,
  type BackupTargetRow,
  type DatabaseClient,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
import { ControlPlaneError } from "../common/control-plane.error.js";
import {
  CONTROL_PLANE_CONFIG_TOKEN,
  DATABASE_CLIENT_TOKEN,
  DOCKER_EXECUTOR_TOKEN,
  type ControlPlaneRuntimeConfig,
} from "../tokens.js";

const FAILURE_CLASS_SET: ReadonlySet<string> = new Set(BACKUP_FAILURE_CLASSES);
const AUDIT_TARGET_TYPE = "backup_target";

/** A connectivity test answer; the space and the root of a local target are the executor's, never an input. */
export interface BackupTargetTestResultDto extends BackupTestResultDto {
  availableBytes?: number;
  totalBytes?: number;
}

type Tx = Parameters<Parameters<DatabaseClient["db"]["transaction"]>[0]>[0];
interface Usage {
  copies: number;
  policies: BackupPolicyScope[];
}

const invalid = (reason: string): ControlPlaneError =>
  new ControlPlaneError("VALIDATION_ERROR", reason, { details: [{ message: reason, reason }] });

function mapExecutorError(err: unknown): ControlPlaneError {
  if (err instanceof ControlPlaneError) {
    return err;
  }
  const obj = typeof err === "object" && err !== null ? (err as { code?: unknown; ambiguousOutcome?: unknown }) : null;
  if (obj?.ambiguousOutcome === true || obj?.code === "OPERATION_AMBIGUOUS") {
    return new ControlPlaneError(
      "OPERATION_AMBIGUOUS",
      "The backup connectivity test timed out before an outcome was received.",
    );
  }
  if (obj?.code === "RESOURCE_LOCKED") {
    return new ControlPlaneError("RESOURCE_LOCKED", "Another backup connectivity test is already in progress.", {
      retryable: true,
    });
  }
  return new ControlPlaneError("DOCKER_ENGINE_UNAVAILABLE", "Backup executor is temporarily unavailable.", {
    retryable: true,
  });
}

function mapRepositoryError(err: unknown): unknown {
  return err instanceof BackupTargetsRepositoryError ? new ControlPlaneError(err.code, err.reason, { details: [{ message: err.reason, reason: err.reason }] }) : err;
}

const notFound = (): ControlPlaneError => new ControlPlaneError("NOT_FOUND", "Backup target not found.");

function toDto(row: BackupTargetRow, usage: Usage): AdminBackupTargetDto {
  const c = row.config;
  const str = (key: string): string | null => (typeof c[key] === "string" ? (c[key] as string) : null);
  const endpoint = str("endpoint");
  const region = str("region");
  const bucket = str("bucket");
  const accessKeyId = str("accessKeyId");
  const s3 =
    row.kind === "s3" && endpoint !== null && region !== null && bucket !== null && accessKeyId !== null
      ? { endpoint, region, bucket, prefix: str("prefix") ?? "", accessKeyId, secretAccessKeySet: true as const }
      : null;
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    enabled: row.enabled,
    customerSelectable: row.customerSelectable,
    legacy: row.legacySettings,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    retentionDays: null,
    s3,
    local:
      row.kind === "local"
        ? { root: row.localRoot || null, initializedAt: row.localInitializedAt?.toISOString() ?? null }
        : null,
    lastTest:
      row.lastTestAt && row.lastTestOutcome
        ? {
            at: row.lastTestAt.toISOString(),
            outcome: row.lastTestOutcome,
            problem: row.lastTestProblem,
            availableBytes: row.lastTestAvailableBytes,
            totalBytes: row.lastTestTotalBytes,
          }
        : null,
    usage,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Site, application and panel copies per target, and the policies that name it. A target id is never filtered by user input. */
async function usageByTarget(db: HostingPanelDatabase | Tx, targetId?: string): Promise<Map<string, Usage>> {
  const only = (column: string) => (targetId === undefined ? sql`` : sql` WHERE ${sql.raw(column)} = ${targetId}`);
  const copies = await db.execute(sql`SELECT target_id AS "targetId", SUM(n)::int AS n FROM (
    SELECT target_id, COUNT(*) AS n FROM site_backup_copies${only("target_id")} GROUP BY target_id
    UNION ALL SELECT target_id, COUNT(*) AS n FROM app_stack_backup_copies${only("target_id")} GROUP BY target_id
    UNION ALL SELECT target_id, COUNT(*) AS n FROM panel_backup_copies${only("target_id")} GROUP BY target_id) c
    GROUP BY target_id`);
  const policies = await db.execute(sql`SELECT DISTINCT pt.target_id AS "targetId", p.scope AS scope
    FROM backup_policy_targets pt JOIN backup_policies p ON p.id = pt.policy_id${only("pt.target_id")}`);
  const usage = new Map<string, Usage>();
  const of = (id: string): Usage => {
    const existing = usage.get(id);
    if (existing) return existing;
    const created: Usage = { copies: 0, policies: [] };
    usage.set(id, created);
    return created;
  };
  for (const r of copies.rows as unknown as { targetId: string; n: number }[]) of(r.targetId).copies = Number(r.n);
  for (const r of policies.rows as unknown as { targetId: string; scope: BackupPolicyScope }[]) {
    of(r.targetId).policies.push(r.scope);
  }
  return usage;
}

const EMPTY_USAGE: Usage = { copies: 0, policies: [] };

/** The executor refuses HP_BACKUP_LOCAL_ROOT (every call answers local_target_unsafe) when the newest live local target's last test/initialise says so. */
function localRootRefused(rows: BackupTargetRow[]): boolean {
  const tested = rows
    .filter((r) => r.kind === "local" && r.archivedAt === null && r.lastTestAt !== null)
    .sort((a, b) => b.lastTestAt!.getTime() - a.lastTestAt!.getTime())[0];
  return tested?.lastTestOutcome === "failed" && tested.lastTestProblem === "local_target_unsafe";
}

/** Administrator CRUD, test and initialisation of backup targets. Non-destructive: repository data is never touched. */
@Injectable()
export class BackupTargetsService {
  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(DOCKER_EXECUTOR_TOKEN) private readonly dockerExecutor: DockerExecutorPort,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) private readonly config: ControlPlaneRuntimeConfig,
  ) {}

  public async list(): Promise<BackupTargetsDto> {
    const db = this.dbClient.db;
    const [rows, usage] = await Promise.all([listBackupTargets(db), usageByTarget(db)]);
    return {
      targets: rows.map((row) => toDto(row, usage.get(row.id) ?? EMPTY_USAGE)),
      localRootConfigured: isBackupAvailable(this.config.runtimeBackend) && !localRootRefused(rows),
    };
  }

  public async create(rawInput: unknown, actorId: string): Promise<AdminBackupTargetDto> {
    this.#assertAvailable();
    const input = CreateBackupTargetInputSchema.parse(rawInput ?? {});
    try {
      return await this.dbClient.db.transaction(async (tx) => {
        const { id } =
          input.kind === "s3"
            ? await insertS3Target(tx, this.config.secretsMasterKey, {
                name: input.name,
                endpoint: input.endpoint,
                region: input.region,
                bucket: input.bucket,
                prefix: input.prefix,
                accessKeyId: input.accessKeyId,
                secretAccessKey: input.secretAccessKey,
                customerSelectable: input.customerSelectable,
                actorId,
              })
            : await insertLocalTarget(tx, { name: input.name, customerSelectable: input.customerSelectable, actorId });
        if (!input.enabled) {
          await updateBackupTarget(tx, id, { enabled: false, actorId }, this.config.secretsMasterKey);
        }
        await this.#audit(tx, actorId, "create", id, input.kind, {});
        return this.#dto(tx, id);
      });
    } catch (err) {
      throw mapRepositoryError(err);
    }
  }

  public async update(targetId: string, rawInput: unknown, actorId: string): Promise<AdminBackupTargetDto> {
    this.#assertAvailable();
    const id = this.#parseId(targetId);
    const input = UpdateBackupTargetInputSchema.parse(rawInput ?? {});
    if (input.endpoint !== undefined || input.bucket !== undefined || input.prefix !== undefined) {
      throw invalid("location_immutable");
    }
    if (input.retentionDays !== undefined) {
      throw invalid("retention_not_editable");
    }
    const { archived, ...fields } = input;
    const credentials = fields.region !== undefined || fields.accessKeyId !== undefined || fields.secretAccessKey !== undefined;
    try {
      return await this.dbClient.db.transaction(async (tx) => {
        const current = await this.#lock(tx, id);
        if (current.legacySettings && credentials) {
          throw invalid("legacy_target_locked");
        }
        const editsFields = Object.keys(fields).length > 0;
        if (editsFields) {
          await updateBackupTarget(tx, id, { ...fields, actorId }, this.config.secretsMasterKey);
          await this.#audit(tx, actorId, "update", id, current.kind, {
            fields: Object.keys(fields).map((k) => (k === "region" || k === "accessKeyId" || k === "secretAccessKey" ? "credentials" : k)).filter((k, i, all) => all.indexOf(k) === i),
          });
        }
        if (archived === true && current.archivedAt === null) {
          await archiveBackupTarget(tx, id);
          await this.#audit(tx, actorId, "archive", id, current.kind, {});
        }
        return this.#dto(tx, id);
      });
    } catch (err) {
      throw mapRepositoryError(err);
    }
  }

  /** Asks the executor to reach the target's repository and stores the outcome (and, for a local target, its space). */
  public async test(targetId: string, actorId: string): Promise<BackupTargetTestResultDto> {
    this.#assertAvailable();
    const id = this.#parseId(targetId);
    const row = await getBackupTargetRow(this.dbClient.db, id);
    if (!row) throw notFound();
    const target = await resolveDispatchTarget(this.dbClient.db, this.config.secretsMasterKey, id);
    if (!target) throw invalid("not_configured");

    const answer = await this.#executor(() => this.dockerExecutor.backups({ action: "test", target }));
    const result = this.#settled(answer);
    await this.dbClient.db.transaction(async (tx) => {
      await this.#lock(tx, id);
      const at = new Date();
      await recordTargetTest(tx, id, {
        at,
        outcome: result.outcome,
        problem: result.problem,
        availableBytes: answer.availableBytes ?? null,
        totalBytes: answer.totalBytes ?? null,
        root: row.kind === "local" ? (answer.localRoot ?? null) : null,
      });
      if (row.legacySettings) {
        await recordBackupTest(tx, at, result.outcome, result.problem);
      }
      await this.#audit(tx, actorId, "test", id, row.kind, { outcome: result.outcome, problem: result.problem });
    });
    return {
      ...result,
      ...(answer.availableBytes === undefined ? {} : { availableBytes: answer.availableBytes }),
      ...(answer.totalBytes === undefined ? {} : { totalBytes: answer.totalBytes }),
    };
  }

  /** Local targets only: the executor writes the marker file; the root it reports is stored for display. */
  public async initialize(targetId: string, actorId: string): Promise<AdminBackupTargetDto> {
    this.#assertAvailable();
    const id = this.#parseId(targetId);
    const row = await getBackupTargetRow(this.dbClient.db, id);
    if (!row) throw notFound();
    if (row.kind !== "local") throw invalid("not_local");
    if (row.archivedAt !== null) throw invalid("target_archived");

    const answer = await this.#executor(() =>
      this.dockerExecutor.backups({ action: "localInit", target: { kind: "local", targetId: id } }),
    );
    const result = this.#settled(answer);
    return this.dbClient.db.transaction(async (tx) => {
      await this.#lock(tx, id);
      const at = new Date();
      await recordTargetTest(tx, id, {
        at,
        outcome: result.outcome,
        problem: result.problem,
        availableBytes: answer.availableBytes ?? null,
        totalBytes: answer.totalBytes ?? null,
        root: answer.localRoot ?? null,
      });
      if (result.outcome === "ok") {
        await markLocalTargetInitialized(tx, id, at, answer.localRoot ?? row.localRoot ?? "");
      }
      await this.#audit(tx, actorId, "initialize", id, row.kind, { outcome: result.outcome, problem: result.problem });
      return this.#dto(tx, id);
    });
  }

  /** Removes the row of a target nothing refers to. The legacy target and any referenced one answer 409. */
  public async delete(targetId: string, actorId: string): Promise<void> {
    this.#assertAvailable();
    const id = this.#parseId(targetId);
    await this.dbClient.db.transaction(async (tx) => {
      const current = await this.#lock(tx, id);
      const outcome = await deleteBackupTargetIfUnreferenced(tx, id);
      if (outcome === "not_found") throw notFound();
      if (outcome === "in_use") {
        throw new ControlPlaneError("BACKUP_TARGET_IN_USE", "backup_target_in_use", {
          details: [{ message: "backup_target_in_use", reason: "backup_target_in_use" }],
        });
      }
      await this.#audit(tx, actorId, "delete", id, current.kind, {});
    });
  }

  #parseId(raw: string): string {
    const parsed = BackupTargetIdSchema.safeParse(raw);
    if (!parsed.success) throw notFound();
    return parsed.data;
  }

  /** Locks the target row for the rest of the transaction. */
  async #lock(tx: Tx, id: string): Promise<BackupTargetRow> {
    const [locked] = await tx.select({ id: backupTargets.id }).from(backupTargets).where(eq(backupTargets.id, id)).limit(1).for("update");
    const row = locked ? await getBackupTargetRow(tx, id) : null;
    if (!row) throw notFound();
    return row;
  }

  async #dto(tx: Tx, id: string): Promise<AdminBackupTargetDto> {
    const [row, usage] = await Promise.all([getBackupTargetRow(tx, id), usageByTarget(tx, id)]);
    if (!row) throw notFound();
    return toDto(row, usage.get(id) ?? EMPTY_USAGE);
  }

  async #executor<R>(call: () => Promise<R>): Promise<R> {
    try {
      return await call();
    } catch (err: unknown) {
      throw mapExecutorError(err);
    }
  }

  #settled(answer: { outcome: "ok" | "failed"; problem: string | null }): BackupTestResultDto {
    const problem: BackupProblem | null =
      answer.outcome === "ok" ? null : answer.problem !== null && FAILURE_CLASS_SET.has(answer.problem) ? (answer.problem as BackupProblem) : "other";
    return { outcome: answer.outcome, problem };
  }

  /** Audit details are the target id and kind plus stable codes; never a name, a path or a credential. */
  async #audit(
    tx: Tx,
    actorId: string,
    action: "create" | "update" | "test" | "archive" | "initialize" | "delete",
    targetId: string,
    targetKind: string,
    extra: Record<string, unknown>,
  ): Promise<void> {
    await appendAuditEvent(tx as unknown as HostingPanelDatabase, {
      actorId,
      actorType: "user",
      action: `admin.backup_target.${action}`,
      targetType: AUDIT_TARGET_TYPE,
      targetId,
      details: { targetId, targetKind, ...extra },
    });
  }

  #assertAvailable(): void {
    if (!isBackupAvailable(this.config.runtimeBackend)) {
      throw new ControlPlaneError("NOT_SUPPORTED", "Backups are only available on the linux-systemd runtime backend");
    }
  }
}
