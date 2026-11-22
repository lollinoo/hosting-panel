import { createHash } from "node:crypto";
import {
  aggregateAppStackStatus,
  canTransitionAppStack,
  effectiveComponentHealth,
  type AppStackComponentHealth,
  type AppStackComponentObservation,
  type AppStackOperationKind,
  type AppStackStatus,
  type AppStackStatusIpcResult,
  type AppStackStepKey,
  type ApprovedStackPlan,
  type ErrorCode,
  type SiteHostRoute,
} from "@hosting-panel/contracts";
import type { AppStackComponentRow, AppStackDomainRow, AppStackRow, DomainRow } from "@hosting-panel/database";
import { computeAppStackComponentHash } from "@hosting-panel/hosting-domain";
import { buildSiteHostRoutes, routePlanHash } from "../sites/domain-policy.js";

/** Lease renewed before every executor call and every readiness poll (> the longest call budget, 300 s). */
export const APP_STACK_STEP_LEASE_MS = 12 * 60_000;
/** Spec §10.2.6: one readiness budget for the whole start+health of an operation. Code policy, never the template. */
export const APP_STACK_HEALTH_BUDGET_MS = 10 * 60_000;
/** Pause between two readiness polls (each poll is one GET with bounded probes). */
export const APP_STACK_HEALTH_POLL_MS = 5_000;
/** Observer: at most this many stacks get a health read per pass, and a pass stops starting reads after this long. */
export const APP_STACK_OBSERVE_BATCH = 20;
export const APP_STACK_OBSERVE_PASS_BUDGET_MS = 45_000;
/** Observer: no system route refresh while the stack's last operation failed less than this long ago. */
export const APP_STACK_ROUTE_REFRESH_BACKOFF_MS = 10 * 60_000;
/** Observer: at most one route refresh per stack this often while only the health of its targets changes. */
export const APP_STACK_ROUTE_REFRESH_INTERVAL_MS = 5 * 60_000;
/** Idempotency key prefix of the observer's route refresh, a stack.deploy that only changes routes (spec §3.9). */
export const APP_STACK_ROUTES_KEY_PREFIX = "sys_routes_";
/** Customer log reads. */
export const APP_STACK_LOG_TAIL_DEFAULT = 200;
export const APP_STACK_LOG_TAIL_MAX = 500;

/** Step messages (operation timeline). Keys = APP_STACK_STEP_KEYS (core-data §4.2). */
export const APP_STACK_STEP_DONE_TEXT: Readonly<Record<AppStackStepKey, string>> = Object.freeze({
  validate: "Request checked",
  reserve: "Resources reserved",
  pull: "Software downloaded",
  prepare: "Environment ready",
  create: "Components ready",
  start: "Components started",
  health: "Application ready",
  publish: "Web addresses published",
  unpublish: "Web addresses withdrawn",
  stop: "Components stopped",
  remove: "Components removed",
  settle: "Done",
});
export const APP_STACK_STEP_RUNNING_TEXT = "In progress";
export const APP_STACK_STEP_FAILED_TEXT = "Could not finish this step";
export const APP_STACK_STEP_SKIPPED_TEXT = "Skipped";
export const APP_STACK_NO_ADDRESS_TEXT = "No web address to publish";
/** Steps a route refresh does not run. */
export const APP_STACK_STEP_NOT_NEEDED_TEXT = "Not needed to update the web addresses";
/** Start step done text when the readiness budget ran out before every component was started. */
export const APP_STACK_START_INCOMPLETE_TEXT = "Some components were not started in time";
/** Operation errorMessage while the outcome is in doubt (thrown as OPERATION_AMBIGUOUS). */
export const APP_STACK_UNCERTAIN_TEXT = "The result of this action is being checked.";

/** Problem codes the runtime writes to app_stack_deployments.problem (each /^[A-Z][A-Z0-9_]{0,63}$/). */
export const APP_STACK_RUNTIME_PROBLEMS = [
  "STACK_TEMPLATE_INVALID",
  "STACK_IMAGE_NOT_ALLOWED",
  "STACK_SECRET_MISSING",
  "STACK_UNSUPPORTED_FEATURE",
  "STACK_HEALTH_TIMEOUT",
  "STACK_VOLUME_IN_USE",
  "DOCKER_ENGINE_UNAVAILABLE",
  "OPERATION_INTERRUPTED",
  "OPERATION_AMBIGUOUS",
] as const;
export type AppStackRuntimeProblem = (typeof APP_STACK_RUNTIME_PROBLEMS)[number];

/** Operation errorCode (an existing ErrorCode, L9) and errorMessage for each problem. */
export const APP_STACK_FAILURE: Readonly<Record<AppStackRuntimeProblem, { readonly code: ErrorCode; readonly text: string }>> =
  Object.freeze({
    STACK_TEMPLATE_INVALID: {
      code: "VALIDATION_ERROR",
      text: "The application could not be prepared. Ask the administrator for help.",
    },
    STACK_IMAGE_NOT_ALLOWED: {
      code: "HOST_POLICY_DENIED",
      text: "The application uses software this server does not allow. Ask the administrator for help.",
    },
    STACK_SECRET_MISSING: { code: "VALIDATION_ERROR", text: "A required password or key is not set. Set it and try again." },
    STACK_UNSUPPORTED_FEATURE: { code: "NOT_SUPPORTED", text: "Applications are not available on this server." },
    STACK_HEALTH_TIMEOUT: {
      code: "DOCKER_ENGINE_UNAVAILABLE",
      text: "The application did not become ready in time. Check its logs and try again.",
    },
    STACK_VOLUME_IN_USE: { code: "RESOURCE_LOCKED", text: "The application's data is still in use. Try again in a few minutes." },
    DOCKER_ENGINE_UNAVAILABLE: {
      code: "DOCKER_ENGINE_UNAVAILABLE",
      text: "The server could not finish this action. Try again in a few minutes.",
    },
    OPERATION_INTERRUPTED: {
      code: "OPERATION_INTERRUPTED",
      text: "This action was interrupted. The application was checked and its state is shown.",
    },
    OPERATION_AMBIGUOUS: { code: "OPERATION_AMBIGUOUS", text: APP_STACK_UNCERTAIN_TEXT },
  });

const PROBLEM_BY_CODE: Readonly<Partial<Record<string, AppStackRuntimeProblem>>> = {
  HOST_POLICY_DENIED: "STACK_IMAGE_NOT_ALLOWED",
  VALIDATION_ERROR: "STACK_TEMPLATE_INVALID",
  NOT_SUPPORTED: "STACK_UNSUPPORTED_FEATURE",
};
const isRuntimeProblem = (value: unknown): value is AppStackRuntimeProblem =>
  (APP_STACK_RUNTIME_PROBLEMS as readonly unknown[]).includes(value);

/** details[0].reason when it is a runtime problem, else by code. Never reads err.message (executor text never travels on). */
export function appStackProblemOf(err: unknown): AppStackRuntimeProblem {
  const e = err as { code?: unknown; details?: unknown } | null | undefined;
  const reason: unknown = Array.isArray(e?.details) ? (e.details[0] as { reason?: unknown } | null | undefined)?.reason : undefined;
  if (isRuntimeProblem(reason)) return reason;
  return (typeof e?.code === "string" ? PROBLEM_BY_CODE[e.code] : undefined) ?? "DOCKER_ENGINE_UNAVAILABLE";
}

/** A plan key absent from `components` is "missing". */
export type ObservedAppStack = AppStackStatusIpcResult;
export type ObservedAppStackComponent = AppStackComponentObservation;
type HealthPhase = "waiting" | "final" | "observer";
type HealthRow = { componentKey: string; health: AppStackComponentHealth };

export function appStackObservedComponent(observed: ObservedAppStack, key: string): ObservedAppStackComponent | undefined {
  return observed.components.find((c) => c.componentKey === key);
}

/** R7: ingress targets; every component when the plan has no ingress. */
export function appStackEssentialKeys(plan: Pick<ApprovedStackPlan, "components" | "ingress">): ReadonlySet<string> {
  return new Set(plan.ingress.length > 0 ? plan.ingress.map((r) => r.componentKey) : plan.components.map((c) => c.key));
}

/** Ready = running and (no healthcheck or probe healthy). */
export function appStackComponentReady(observed: ObservedAppStackComponent | undefined): boolean {
  return observed !== undefined && observed.state === "running" && observed.health === "healthy";
}

/** Health written to app_stack_components; inside the budget ("waiting") a running-but-unhealthy component is "starting". */
export function appStackRecordedHealth(observed: ObservedAppStackComponent | undefined, phase: HealthPhase): AppStackComponentHealth {
  if (observed === undefined) return "missing";
  if (appStackComponentReady(observed)) return "healthy";
  if (observed.state === "running" || observed.state === "restarting") return phase === "waiting" ? "starting" : "unhealthy";
  return "stopped";
}

/** One entry per plan component, in plan order, for recordAppStackComponentHealthTransactional. */
export function appStackHealthRows(
  plan: Pick<ApprovedStackPlan, "components">,
  observed: ObservedAppStack,
  phase: HealthPhase,
): HealthRow[] {
  return plan.components.map((c) => ({
    componentKey: c.key,
    health: appStackRecordedHealth(appStackObservedComponent(observed, c.key), phase),
  }));
}

export function appStackAggregate(input: {
  readonly plan: Pick<ApprovedStackPlan, "components" | "ingress">;
  readonly health: ReadonlyMap<string, AppStackComponentHealth>;
  readonly domainCount: number;
  readonly routesPublished: boolean;
}): "running" | "degraded" | "failed" {
  const essential = appStackEssentialKeys(input.plan);
  return aggregateAppStackStatus({
    components: input.plan.components.map((c) => ({ health: input.health.get(c.key) ?? "unknown", essential: essential.has(c.key) })),
    hasIngress: input.plan.ingress.length > 0 && input.domainCount > 0,
    routesPublished: input.routesPublished,
  });
}

/** Components whose computeAppStackComponentHash differs between the two plans or that are new (previous null ⇒ all). */
export function appStackReplacedComponents(previous: ApprovedStackPlan | null, next: ApprovedStackPlan): readonly string[] {
  return next.components
    .filter(
      (c) =>
        previous === null ||
        !previous.components.some((p) => p.key === c.key) ||
        computeAppStackComponentHash(previous, c.key) !== computeAppStackComponentHash(next, c.key),
    )
    .map((c) => c.key);
}

/** Transitive dependents (in `next`) of `changed`, minus `changed`, in plan order: restarted, never recreated. */
export function appStackRestartSet(next: Pick<ApprovedStackPlan, "components">, changed: readonly string[]): readonly string[] {
  // Plan components are in topological order, so one pass sees every dependency before its dependents.
  const affected = new Set(changed);
  const restart: string[] = [];
  for (const c of next.components) {
    if (!affected.has(c.key) && c.dependsOn.some((d) => affected.has(d))) {
      affected.add(c.key);
      restart.push(c.key);
    }
  }
  return restart;
}

/** A route entry sent to publishAppStackRoutes. */
export interface AppStackRouteEntry {
  readonly componentKey: string;
  readonly internalPort: number;
  readonly hosts: SiteHostRoute[];
}

const toDomainPolicyRow = (row: AppStackDomainRow): DomainRow => ({
  ...row,
  status: "active",
  isPrimary: false,
  certMode: "acme",
  siteId: row.stackId,
  manualCertificateVersionId: null,
});

/**
 * R13. Rows on a (componentKey, internalPort) outside plan.ingress are left out and counted in `orphaned`; `include`
 * filters the ingress targets. Entries sorted by (componentKey, internalPort), empty ones dropped.
 */
export function appStackRoutePlan(input: {
  readonly plan: Pick<ApprovedStackPlan, "ingress">;
  readonly domains: readonly AppStackDomainRow[];
  readonly include: ReadonlySet<string>;
  readonly now: Date;
  readonly acmeEnabled: boolean;
}): { readonly entries: AppStackRouteEntry[]; readonly orphaned: number } {
  const groups = new Map<string, { componentKey: string; internalPort: number; rows: DomainRow[] }>();
  let orphaned = 0;
  for (const row of input.domains) {
    if (!input.plan.ingress.some((r) => r.componentKey === row.componentKey && r.port === row.internalPort)) {
      orphaned += 1;
      continue;
    }
    if (!input.include.has(row.componentKey)) continue;
    const id = `${row.componentKey}:${String(row.internalPort)}`;
    const group = groups.get(id) ?? { componentKey: row.componentKey, internalPort: row.internalPort, rows: [] };
    group.rows.push(toDomainPolicyRow(row));
    groups.set(id, group);
  }
  const entries = [...groups.values()]
    .map((g) => ({
      componentKey: g.componentKey,
      internalPort: g.internalPort,
      hosts: buildSiteHostRoutes(g.rows, input.now, { acmeEnabled: input.acmeEnabled }),
    }))
    .filter((e) => e.hosts.length > 0)
    .sort((a, b) =>
      a.componentKey === b.componentKey ? a.internalPort - b.internalPort : a.componentKey < b.componentKey ? -1 : 1,
    );
  return { entries, orphaned };
}

export function appStackRoutesHash(entries: readonly AppStackRouteEntry[]): string {
  const canonical = entries.map((e) => [e.componentKey, e.internalPort, routePlanHash(e.hosts, null)]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * True when the published routes are the current addresses of some set of ingress targets: since they were written only
 * the health of the targets changed, not the addresses (none added, removed, moved or with another certificate state).
 */
export function appStackRoutesHealthOnly(input: {
  readonly plan: Pick<ApprovedStackPlan, "ingress">;
  readonly domains: readonly AppStackDomainRow[];
  readonly now: Date;
  readonly acmeEnabled: boolean;
  readonly appliedRoutesHash: string | null;
}): boolean {
  const targets = [...new Set(input.plan.ingress.map((r) => r.componentKey))];
  for (let mask = 0; mask < 2 ** targets.length; mask += 1) {
    const { entries } = appStackRoutePlan({ ...input, include: new Set(targets.filter((_, i) => (mask >> i) & 1)) });
    if ((entries.length > 0 ? appStackRoutesHash(entries) : null) === input.appliedRoutesHash) return true;
  }
  return false;
}

/** The observer's route refresh: a system stack.deploy under the routes key prefix (a customer request carries a user id). */
export function appStackRoutesRefresh(op: {
  readonly kind: string;
  readonly requestedByUserId: string | null;
  readonly idempotencyKey: string | null;
}): boolean {
  return op.kind === "stack.deploy" && op.requestedByUserId === null && op.idempotencyKey?.startsWith(APP_STACK_ROUTES_KEY_PREFIX) === true;
}

/** R12 read-time view: a stale or unobserved component of a running|degraded stack reads "unknown". */
export function appStackDisplayStatus(input: {
  readonly stack: Pick<AppStackRow, "status" | "appliedRoutesHash">;
  readonly plan: Pick<ApprovedStackPlan, "components" | "ingress"> | null;
  readonly components: readonly Pick<AppStackComponentRow, "componentKey" | "health" | "healthObservedAt">[];
  readonly domainCount: number;
  readonly now: Date;
}): AppStackStatus {
  const { stack, plan } = input;
  if ((stack.status !== "running" && stack.status !== "degraded") || plan === null) return stack.status;
  const rows = new Map(input.components.map((c) => [c.componentKey, c]));
  const health = new Map<string, AppStackComponentHealth>();
  for (const c of plan.components) {
    const row = rows.get(c.key);
    health.set(c.key, row ? effectiveComponentHealth(row.health, row.healthObservedAt, input.now) : "unknown");
  }
  if ([...health.values()].includes("unknown")) return "unknown";
  return appStackAggregate({ plan, health, domainCount: input.domainCount, routesPublished: stack.appliedRoutesHash !== null });
}

export type AppStackRecoveryVerdict = {
  readonly outcome: "succeeded" | "failed";
  readonly stackStatus: "running" | "degraded" | "stopped" | "failed" | "deleted" | "delete_failed";
  /** true: set applied_revision_id = target revision. */
  readonly applied: boolean;
  /** [] for delete. */
  readonly health: HealthRow[];
  readonly problem: "OPERATION_INTERRUPTED" | null;
};

/** Settles an `unknown` operation from one status read (arch-runtime §2.4). */
export function appStackRecoveryVerdict(input: {
  readonly kind: AppStackOperationKind;
  /** Deploy kinds: the deployment's revision plan; lifecycle: applied ?? desired; null when none. */
  readonly plan: ApprovedStackPlan | null;
  /** Deploy kinds: the applied revision's plan, if any. */
  readonly previous?: ApprovedStackPlan | null;
  readonly observed: ObservedAppStack;
  readonly domainCount: number;
  /** Delete: some volume has retention_policy 'destroy'. */
  readonly destroyVolumes: boolean;
}): AppStackRecoveryVerdict {
  const { kind, plan, observed } = input;
  if (kind === "stack.delete") {
    const gone =
      observed.components.length === 0 &&
      !observed.networks.internal &&
      !observed.networks.edge &&
      !observed.routes.published &&
      (!input.destroyVolumes || observed.volumes.length === 0);
    return gone
      ? { outcome: "succeeded", stackStatus: "deleted", applied: false, health: [], problem: null }
      : { outcome: "failed", stackStatus: "delete_failed", applied: false, health: [], problem: "OPERATION_INTERRUPTED" };
  }
  if (plan === null) {
    return kind === "stack.stop"
      ? { outcome: "succeeded", stackStatus: "stopped", applied: false, health: [], problem: null }
      : { outcome: "failed", stackStatus: "failed", applied: false, health: [], problem: "OPERATION_INTERRUPTED" };
  }
  if (kind === "stack.stop") {
    const health = appStackHealthRows(plan, observed, "observer");
    const active = plan.components.some((c) => {
      const state = appStackObservedComponent(observed, c.key)?.state;
      return state === "running" || state === "restarting";
    });
    return active
      ? { outcome: "failed", stackStatus: "degraded", applied: false, health, problem: "OPERATION_INTERRUPTED" }
      : { outcome: "succeeded", stackStatus: "stopped", applied: false, health, problem: null };
  }
  const matches = (p: ApprovedStackPlan) =>
    p.components.every((c) => appStackObservedComponent(observed, c.key)?.componentHash === computeAppStackComponentHash(p, c.key));
  const health = appStackHealthRows(plan, observed, "final");
  if (!matches(plan)) {
    const { previous } = input;
    if (!previous || !matches(previous)) return { outcome: "failed", stackStatus: "failed", applied: false, health, problem: "OPERATION_INTERRUPTED" };
    // Nothing of the new revision replaced the applied one, which still serves: settled like a pre-flight failure.
    const before = appStackHealthRows(previous, observed, "observer");
    const stackStatus = appStackAggregate({
      plan: previous,
      health: new Map(before.map((h) => [h.componentKey, h.health])),
      domainCount: input.domainCount,
      routesPublished: observed.routes.published,
    });
    return { outcome: "failed", stackStatus, applied: false, health: before, problem: "OPERATION_INTERRUPTED" };
  }
  const aggregate = appStackAggregate({
    plan,
    health: new Map(health.map((h) => [h.componentKey, h.health])),
    domainCount: input.domainCount,
    routesPublished: observed.routes.published,
  });
  return aggregate === "failed"
    ? { outcome: "failed", stackStatus: "failed", applied: true, health, problem: "OPERATION_INTERRUPTED" }
    : { outcome: "succeeded", stackStatus: aggregate, applied: true, health, problem: null };
}

/** The status a settle may write: wanted when allowed (or unchanged), "failed" from queued, else null (leave it). */
export function appStackSettleTarget(current: AppStackStatus, wanted: AppStackStatus): AppStackStatus | null {
  if (current === wanted || canTransitionAppStack(current, wanted)) return wanted;
  return current === "queued" ? "failed" : null;
}
