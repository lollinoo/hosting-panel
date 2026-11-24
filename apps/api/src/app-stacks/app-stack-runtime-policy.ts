import { createHash } from "node:crypto";
import {
  aggregateAppStackStatus,
  canTransitionAppStack,
  effectiveComponentHealth,
  isTerminalOperationStatus,
  type AppStackComponentHealth,
  type AppStackComponentObservation,
  type AppStackHostRoute,
  type AppStackOperationKind,
  type AppStackStatus,
  type AppStackStatusIpcResult,
  type AppStackStepKey,
  type ApprovedStackPlan,
  type ErrorCode,
  type OperationStatus,
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
  readonly hosts: AppStackHostRoute[];
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
 *
 * ADR-0037. An address that redirects sits in the entry of its destination and is published with it, so the redirect
 * needs only the destination to be ready; a path rule is published while its own target is ready. An option that is
 * not set adds no key: the entries of addresses without options are what they were before the options existed.
 */
export function appStackRoutePlan(input: {
  readonly plan: Pick<ApprovedStackPlan, "ingress">;
  readonly domains: readonly AppStackDomainRow[];
  readonly include: ReadonlySet<string>;
  readonly now: Date;
  readonly acmeEnabled: boolean;
}): { readonly entries: AppStackRouteEntry[]; readonly orphaned: number } {
  const isIngress = (componentKey: string, port: number): boolean =>
    input.plan.ingress.some((r) => r.componentKey === componentKey && r.port === port);
  const receives = (componentKey: string, port: number): boolean => input.include.has(componentKey) && isIngress(componentKey, port);
  const routed = input.domains.filter((row) => isIngress(row.componentKey, row.internalPort));
  const byId = new Map(routed.map((row) => [row.id, row]));
  const hostOf = (row: AppStackDomainRow): SiteHostRoute =>
    buildSiteHostRoutes([toDomainPolicyRow(row)], input.now, { acmeEnabled: input.acmeEnabled })[0]!;

  const groups = new Map<string, AppStackRouteEntry>();
  for (const row of routed) {
    const serving = row.redirectToDomainId === null ? row : byId.get(row.redirectToDomainId);
    // A destination that is not routed, not ready, or that redirects itself takes the addresses pointing at it out.
    if (serving === undefined || (serving !== row && serving.redirectToDomainId !== null)) continue;
    if (!receives(serving.componentKey, serving.internalPort)) continue;
    const id = `${serving.componentKey}:${String(serving.internalPort)}`;
    const group = groups.get(id) ?? { componentKey: serving.componentKey, internalPort: serving.internalPort, hosts: [] };
    group.hosts.push(
      serving === row
        ? { ...hostOf(row), ...contentOptions(row, receives) }
        : { ...hostOf(row), redirectTo: `${hostOf(serving).httpsRedirect ? "https" : "http"}://${serving.hostname}` },
    );
    groups.set(id, group);
  }
  const entries = [...groups.values()].sort((a, b) =>
    a.componentKey === b.componentKey ? a.internalPort - b.internalPort : a.componentKey < b.componentKey ? -1 : 1,
  );
  return { entries, orphaned: input.domains.length - routed.length };
}

/** What an address that serves content asks for beyond its host, in the key order of the route request. */
function contentOptions(
  row: AppStackDomainRow,
  receives: (componentKey: string, port: number) => boolean,
): Pick<AppStackHostRoute, "compress" | "protection" | "paths"> {
  const paths = row.pathRoutes
    .filter((path) => receives(path.componentKey, path.port))
    .map((path) => ({ pathPrefix: path.pathPrefix, componentKey: path.componentKey, internalPort: path.port, stripPrefix: path.stripPrefix }))
    .sort((a, b) => (a.pathPrefix < b.pathPrefix ? -1 : 1));
  return {
    ...(row.compression ? { compress: true as const } : {}),
    ...(row.accessUsername !== null && row.accessPasswordHash !== null
      ? { protection: { username: row.accessUsername, passwordHash: row.accessPasswordHash } }
      : {}),
    ...(paths.length > 0 ? { paths } : {}),
  };
}

/**
 * The hosts are hashed as a site's are (a redirect included); the options of an entry follow as one more element only
 * when one of its hosts has any, so the hash of addresses without options is the one already stored.
 */
export function appStackRoutesHash(entries: readonly AppStackRouteEntry[]): string {
  const canonical = entries.map((e) => {
    const options = [...e.hosts]
      .sort((a, b) => a.hostname.localeCompare(b.hostname))
      .filter((h) => h.compress !== undefined || h.protection !== undefined || h.paths !== undefined)
      .map((h) => [
        h.hostname,
        h.compress === true ? 1 : 0,
        h.protection ? [h.protection.username, h.protection.passwordHash] : null,
        h.paths ? h.paths.map((path) => [path.pathPrefix, path.componentKey, path.internalPort, path.stripPrefix]) : null,
      ]);
    const hosts = [e.componentKey, e.internalPort, routePlanHash(e.hosts, null)];
    return options.length > 0 ? [...hosts, options] : hosts;
  });
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

/**
 * ADR-0037: the fingerprint of the saved addresses and options a route publication is made from, bound to the routes
 * hash it was published as (a writer of that hash that does not know the fingerprint leaves one that no longer
 * matches). Neither the health of the targets nor a certificate is in it: only what the customer saves.
 */
export function appStackAddressesHash(domains: readonly AppStackDomainRow[], appliedRoutesHash: string | null): string {
  const rows = [...domains]
    .sort((a, b) => (a.hostname < b.hostname ? -1 : a.hostname > b.hostname ? 1 : 0))
    .map((row) => [
      row.hostname,
      row.componentKey,
      row.internalPort,
      row.redirectToDomainId,
      row.compression,
      row.accessUsername,
      row.accessPasswordHash,
      [...row.pathRoutes]
        .sort((a, b) => (a.pathPrefix < b.pathPrefix ? -1 : 1))
        .map((path) => [path.pathPrefix, path.componentKey, path.port, path.stripPrefix]),
    ]);
  return createHash("sha256").update(JSON.stringify([appliedRoutesHash, rows])).digest("hex");
}

/**
 * ADR-0037: the saved addresses and options differ from those the last successful route publication was made from,
 * whatever the health of the targets then and now. Exact: it compares what was saved, not what a subset of healthy
 * targets would publish. Nothing published (no routes hash, no fingerprint: never installed, stopped) holds nothing
 * back; a fingerprint that is not known while routes are published counts as pending.
 */
export function appStackRoutesPending(input: {
  readonly domains: readonly AppStackDomainRow[];
  readonly appliedRoutesHash: string | null;
  readonly appliedAddressesHash: string | null;
}): boolean {
  if (input.appliedRoutesHash === null && input.appliedAddressesHash === null) return false;
  return input.appliedAddressesHash !== appStackAddressesHash(input.domains, input.appliedRoutesHash);
}

/** The observer's route refresh: a system stack.deploy under the routes key prefix (a customer request carries a user id). */
export function appStackRoutesRefresh(op: {
  readonly kind: string;
  readonly requestedByUserId: string | null;
  readonly idempotencyKey: string | null;
}): boolean {
  return op.kind === "stack.deploy" && op.requestedByUserId === null && op.idempotencyKey?.startsWith(APP_STACK_ROUTES_KEY_PREFIX) === true;
}

/**
 * Whether the observer keeps the routes of this stack in line with its addresses: its applied revision runs (also when
 * a newer one is desired: the refresh publishes what runs), no action is in progress, and its last one was not a stop.
 */
export function appStackRoutesFollowAddresses(
  stack: Pick<AppStackRow, "status" | "appliedRevisionId">,
  last: { readonly kind: string; readonly status: OperationStatus } | undefined,
): boolean {
  if (stack.status !== "running" && stack.status !== "degraded") return false;
  if (stack.appliedRevisionId === null) return false;
  // The routes of a stack the customer last asked to stop stay withdrawn.
  if (last?.kind === "stack.stop") return false;
  return last === undefined || isTerminalOperationStatus(last.status);
}

/**
 * ADR-0037: when a change of the routing options reaches the route file. "shortly": the observer rewrites it now, or
 * its own route refresh is under way (it reads the addresses when it runs, and the pass after it sees a change it
 * missed). "at_start": nothing of the stack is published (never installed, or stopped, which withdraws the routes) and
 * the next start publishes the options. null: a route file may be in place that nothing rewrites until the customer
 * acts, so the change is refused rather than shown as active.
 */
export function appStackOptionsApply(
  stack: Pick<AppStackRow, "status" | "appliedRevisionId">,
  last:
    | {
        readonly kind: string;
        readonly status: OperationStatus;
        readonly requestedByUserId: string | null;
        readonly idempotencyKey: string | null;
      }
    | undefined,
): "shortly" | "at_start" | null {
  if (appStackRoutesFollowAddresses(stack, last)) return "shortly";
  if (last !== undefined && !isTerminalOperationStatus(last.status) && appStackRoutesRefresh(last)) return "shortly";
  if (stack.appliedRevisionId === null || stack.status === "stopped") return "at_start";
  return null;
}

/**
 * ADR-0037: removing an address must end its route, so it is accepted only when the refresh queued with it withdraws the
 * name now (the routes follow the addresses), or when nothing is published and no action is open. Not while the panel's
 * own refresh runs (it may have read the address already) nor during a first install. The name stays held until a route
 * file without it is published (issue #112).
 */
export function appStackAddressRemovable(
  stack: Pick<AppStackRow, "status" | "appliedRevisionId" | "appliedRoutesHash">,
  last: { readonly kind: string; readonly status: OperationStatus } | undefined,
): boolean {
  if (appStackRoutesFollowAddresses(stack, last)) return true;
  const idle = last === undefined || isTerminalOperationStatus(last.status);
  return idle && stack.appliedRoutesHash === null && (stack.appliedRevisionId === null || stack.status === "stopped");
}

/** The stored statuses whose shown status is computed from the health of the components; the others are shown as stored. */
export const APP_STACK_STATUSES_SHOWN_FROM_HEALTH: readonly AppStackStatus[] = ["running", "degraded"];

/**
 * The health a component shows (ADR-0035, issue #208). An observation older than five minutes reads `unknown`
 * (`effectiveComponentHealth`), except the `stopped` reading of an application stored as `stopped`: the observer stops
 * reading a stopped application, so no newer reading will come and the old one is still true. Any other reading, and a
 * `stopped` one of an application in any other stored status, keeps the five-minute rule. The time of the last check is
 * not touched here: it stays the stored one.
 */
export function shownComponentHealth(
  stackStatus: AppStackStatus,
  health: AppStackComponentHealth,
  observedAt: Date | null,
  now: Date,
): AppStackComponentHealth {
  if (stackStatus === "stopped" && health === "stopped" && observedAt !== null) return "stopped";
  return effectiveComponentHealth(health, observedAt, now);
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
  if (!APP_STACK_STATUSES_SHOWN_FROM_HEALTH.includes(stack.status) || plan === null) return stack.status;
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
    // No component whose hash changed replaced the applied one: settled like a pre-flight failure. A container
    // replaced only for its body version carries the applied hash too and counts as the applied one's, running or not.
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
