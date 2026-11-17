import { setTimeout as sleep } from "node:timers/promises";
import {
  HOST_JOB_KIND,
  HOST_JOB_LOCK_KEY,
  PLATFORM_OPS_ORG_ID,
  WORDPRESS_IMPORT_KIND,
  type ErrorCode,
  type HOST_JOB_RESULTS,
  type HostService,
} from "@hosting-panel/contracts";
import {
  ACTIVE_OPERATION_LOCK_STATUSES,
  and,
  appendAuditEvent,
  auditEvents,
  enqueueOperationTransactional,
  eq,
  inArray,
  operations,
  renewOperationLease,
  settleOperation,
  sql,
  updateOperationStepTransactional,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import type { HostAgentPort, HostJob, HostJobState } from "@hosting-panel/host-agent-contracts";
import { ensurePlatformOpsOrg } from "../backups/backup-scheduler.service.js";
import { ControlPlaneError } from "../common/control-plane.error.js";
import { PANEL_RESTART_MAX_AGE_MS, PANEL_RESTART_START_DELAY_MS } from "../health/panel-restart.js";
import { BACKUP_OPERATION_KINDS } from "../runtime/outbox-worker.service.js";
import { installedPanelVersion } from "../updates/release-version.js";

type OperationRow = typeof operations.$inferSelect;

export const HOST_JOB_LEASE_MS = 30_000;
export const HOST_JOB_POLL_MS = 2_000;
export const HOST_JOB_START_DEADLINE_MS = 120_000;
export const HOST_JOB_WATCH_MAX_MS = 2 * 3600_000;
export const HOST_JOB_STEPS = [{ key: "run", label: "Run the job" }];
export const HOST_SERVICE_JOB = {
  api: "restart_hp_api",
  web: "restart_hp_web",
  executor: "restart_hp_docker_executor",
  host_agent: "restart_hp_host_agent",
} as const satisfies Record<HostService, HostJob>;
export const SITE_WORK_BLOCKED_JOBS: readonly HostJob[] = ["restart_hp_docker_executor", "panel_update", "os_upgrade"];
export const SITE_WORK_KINDS = [...BACKUP_OPERATION_KINDS, "site.wordpress.update", WORDPRESS_IMPORT_KIND] as const;
export const HOST_JOB_END_ACTION: Record<HostJob, string> = {
  restart_hp_api: "admin.host_service.restart.end",
  restart_hp_web: "admin.host_service.restart.end",
  restart_hp_docker_executor: "admin.host_service.restart.end",
  restart_hp_host_agent: "admin.host_service.restart.end",
  panel_update: "admin.update.panel.end",
  os_refresh: "admin.os_packages.refresh.end",
  os_upgrade: "admin.os_packages.upgrade.end",
};

export interface EnqueueHostJobInput {
  readonly job: HostJob;
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly audit: {
    readonly action: string;
    readonly targetType: string;
    readonly targetId: string | null;
    readonly details: Record<string, unknown>;
    readonly ipAddress: string | null;
    readonly userAgent: string | null;
  };
}

const locked = (reason: "host_job_running" | "site_work_running", message: string) =>
  new ControlPlaneError("RESOURCE_LOCKED", message, { details: [{ message, reason }] });

/** Refuses with site_work_running while a backup, a restore or an import runs; call it inside the enqueue transaction. */
export async function assertNoSiteWork(tx: HostingPanelDatabase): Promise<void> {
  const [busy] = await tx
    .select({ id: operations.id })
    .from(operations)
    .where(and(inArray(operations.kind, [...SITE_WORK_KINDS]), inArray(operations.status, [...ACTIVE_OPERATION_LOCK_STATUSES])))
    .limit(1);
  if (busy) throw locked("site_work_running", "Site work is running. Try again when it has finished.");
}

/** One host job at a time; the request row is written in the enqueue transaction. */
export async function enqueueHostJob(db: HostingPanelDatabase, input: EnqueueHostJobInput): Promise<{ operationId: string }> {
  return db.transaction(async (tx) => {
    await ensurePlatformOpsOrg(tx);
    let enqueued;
    try {
      enqueued = await enqueueOperationTransactional(tx as unknown as HostingPanelDatabase, {
        organizationId: PLATFORM_OPS_ORG_ID,
        kind: HOST_JOB_KIND,
        resourceType: "host",
        resourceId: input.job,
        requestedByUserId: input.actorId,
        idempotencyKey: input.idempotencyKey,
        lockKey: HOST_JOB_LOCK_KEY,
        leaseDurationMs: HOST_JOB_LEASE_MS,
        steps: HOST_JOB_STEPS,
        outboxPayload: {},
      });
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === "RESOURCE_LOCKED") {
        throw locked("host_job_running", "Another host job is running. Try again when it has finished.");
      }
      throw err;
    }
    const operationId = enqueued.operation.id;
    if (!enqueued.idempotentReplay) {
      // R201 1.2: only a new operation waits for site work; throwing here rolls the whole enqueue back.
      if (SITE_WORK_BLOCKED_JOBS.includes(input.job)) await assertNoSiteWork(tx as unknown as HostingPanelDatabase);
      await appendAuditEvent(tx, {
        actorId: input.actorId,
        actorType: "user",
        organizationId: PLATFORM_OPS_ORG_ID,
        action: input.audit.action,
        targetType: input.audit.targetType,
        targetId: input.audit.targetId,
        ipAddress: input.audit.ipAddress,
        userAgent: input.audit.userAgent,
        details: { ...input.audit.details, operationId },
      });
    }
    return { operationId };
  });
}

type HostJobResult = (typeof HOST_JOB_RESULTS)[number];
/** How a job ended: its exit status, or the code of a request that never started it. */
export type HostJobEnd = { readonly exitStatus: number | null } | { readonly notStarted: ErrorCode };

const FAILED_MESSAGE = "The job ended with an error. Read its log on the Logs page, then try again.";
const NOT_STARTED_MESSAGE = "The job did not start. Check Health, then try again.";
const SUCCEEDED_RESULTS: readonly HostJobResult[] = ["succeeded", "updated", "already_current"];

const codeOf = (err: unknown): unknown => (err as { code?: unknown } | null)?.code;

/** The result of a run that ended with this exit status (update.sh: 6 rolled back, 7 rollback unhealthy). */
export function hostJobResult(job: HostJob, exitStatus: number, versionChanged: boolean): HostJobResult {
  if (job === "panel_update") {
    if (exitStatus === 0) return versionChanged ? "updated" : "already_current";
    if (exitStatus === 6) return "rolled_back";
    if (exitStatus === 7) return "rollback_unhealthy";
  }
  return exitStatus === 0 ? "succeeded" : "failed";
}

/** A read job state, "not_supported" when the agent cannot read it, or null when it is out of reach. */
type HostJobRead = HostJobState | "not_supported" | null;
const readHostJob = (hostAgent: HostAgentPort, job: HostJob): Promise<HostJobRead> =>
  hostAgent.readHostJob(job).catch((err: unknown) => (codeOf(err) === "NOT_SUPPORTED" ? "not_supported" : null));

/** The end a read job state means for the operation, or null while it is not over. */
function endOf(state: HostJobRead, opStartMs: number, nowMs: number): HostJobEnd | null {
  if (state === null) return null; // an agent out of reach is not an end, also past the deadline
  // R202 2.1, R203 1.2: the agent answers NOT_SUPPORTED on a job call only when the units are missing.
  if (state === "not_supported") return nowMs - opStartMs > HOST_JOB_START_DEADLINE_MS ? { notStarted: "NOT_SUPPORTED" } : null;
  // R198 2.5: systemd gives whole seconds, so the operation's start is cut to its second.
  const ours = state.startedAt !== null && Date.parse(state.startedAt) >= Math.floor(opStartMs / 1000) * 1000;
  if (ours && (state.state === "succeeded" || state.state === "failed")) return { exitStatus: state.exitStatus };
  if (!ours && nowMs - opStartMs > HOST_JOB_START_DEADLINE_MS) return { notStarted: "OPERATION_INTERRUPTED" };
  return null;
}

/** Settles a host job and writes its end row in the same transaction; false when already settled. */
export async function settleHostJob(db: HostingPanelDatabase, op: OperationRow, end: HostJobEnd): Promise<boolean> {
  const job = op.resourceId as HostJob;
  let versions = {};
  let changed = false;
  if (job === "panel_update") {
    const [request] = await db
      .select({ fromVersion: sql<string | null>`${auditEvents.details}->>'fromVersion'` })
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "admin.update.panel"), sql`${auditEvents.details}->>'operationId' = ${op.id}`))
      .limit(1);
    const fromVersion = request?.fromVersion ?? null;
    const toVersion = installedPanelVersion();
    changed = toVersion !== null && toVersion !== fromVersion;
    versions = { fromVersion, toVersion };
  }
  const exitStatus = "exitStatus" in end ? end.exitStatus : null;
  const result: HostJobResult =
    "notStarted" in end ? "not_started" : exitStatus === null ? "failed" : hostJobResult(job, exitStatus, changed);
  const ok = SUCCEEDED_RESULTS.includes(result);
  const message = "notStarted" in end ? NOT_STARTED_MESSAGE : FAILED_MESSAGE;
  return settleOperation(
    db,
    op.id,
    ok ? { status: "succeeded" } : { status: "failed", errorCode: "notStarted" in end ? end.notStarted : "HOST_JOB_FAILED", errorMessage: message },
    async (tx) => {
      await updateOperationStepTransactional(tx, op.id, "run", ok ? "succeeded" : "failed", ok ? "Job finished" : message);
      await appendAuditEvent(tx, {
        actorId: null,
        actorType: "system",
        organizationId: op.organizationId,
        action: HOST_JOB_END_ACTION[job],
        targetType: "host",
        targetId: job,
        details: { operationId: op.id, outcome: ok ? "succeeded" : "failed", result, exitStatus, ...versions },
      });
    },
  );
}

/** Asks the agent for one host job and follows it until the run of this request has ended. */
export async function executeHostJob(
  db: HostingPanelDatabase,
  hostAgent: HostAgentPort,
  op: OperationRow,
  now: () => number = Date.now,
  signal?: AbortSignal,
): Promise<void> {
  const job = op.resourceId as HostJob;
  const age = now() - op.submittedAt.getTime();
  if (age > PANEL_RESTART_MAX_AGE_MS) {
    await settleHostJob(db, op, { notStarted: "OPERATION_INTERRUPTED" });
    return;
  }
  // R201 1.1: a stop ends either wait at once; the follow then writes nothing, the lease lapses and recovery takes over.
  const wait = (ms: number) => sleep(ms, undefined, { signal }).catch(() => undefined);
  await renewOperationLease(db, op.id, HOST_JOB_LEASE_MS);
  if (age < PANEL_RESTART_START_DELAY_MS) await wait(PANEL_RESTART_START_DELAY_MS - age); // the 202 leaves first
  if (signal?.aborted) return; // never requested: recovery ends it as not started
  // The row the worker passes predates its move to processing, which set startedAt.
  const [current] = await db.select({ startedAt: operations.startedAt }).from(operations).where(eq(operations.id, op.id));
  const startMs = (current?.startedAt ?? op.startedAt ?? op.submittedAt).getTime();
  await updateOperationStepTransactional(db, op.id, "run", "running", "Running the job");
  try {
    await hostAgent.requestHostJob(job);
  } catch (err) {
    const code = codeOf(err);
    if (code === "RESOURCE_LOCKED" || code === "HOST_AGENT_UNAVAILABLE" || code === "NOT_SUPPORTED") {
      await settleHostJob(db, op, { notStarted: code });
      return;
    }
    // Anything else (OPERATION_AMBIGUOUS) may have started it: the polling finds out.
  }
  for (;;) {
    const state = await readHostJob(hostAgent, job);
    if (signal?.aborted) return;
    const end = endOf(state, startMs, now());
    if (end) {
      await settleHostJob(db, op, end);
      return;
    }
    if (now() - startMs > HOST_JOB_WATCH_MAX_MS) return; // the lease lapses and recovery takes over
    await wait(HOST_JOB_POLL_MS);
    if (signal?.aborted) return;
    await renewOperationLease(db, op.id, HOST_JOB_LEASE_MS);
  }
}

/** Settles a host job left unknown once its run has ended; pending while it runs or the agent is away. */
export async function recoverHostJob(
  db: HostingPanelDatabase,
  hostAgent: HostAgentPort,
  op: OperationRow,
): Promise<"settled" | "pending"> {
  const state = await readHostJob(hostAgent, op.resourceId as HostJob);
  const end = endOf(state, (op.startedAt ?? op.submittedAt).getTime(), Date.now());
  if (!end) return "pending";
  await settleHostJob(db, op, end);
  return "settled";
}
