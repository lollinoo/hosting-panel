import { z } from "zod";

export const APP_TEMPLATE_STATES = ["draft", "published", "archived"] as const;
export type AppTemplateState = (typeof APP_TEMPLATE_STATES)[number];
/** Derived, never stored: archived_at wins, then enabled. */
export function appTemplateState(row: { readonly enabled: boolean; readonly archivedAt: Date | string | null }): AppTemplateState {
  if (row.archivedAt !== null) return "archived";
  return row.enabled ? "published" : "draft";
}

export const APP_STACK_STATUSES = [
  "draft",
  "queued",
  "deploying",
  "running",
  "degraded",
  "failed",
  "unknown",
  "stopping",
  "stopped",
  "starting",
  "updating",
  "deleting",
  "deleted",
  "delete_failed",
] as const;
export const AppStackStatusSchema = z.enum(APP_STACK_STATUSES);
export type AppStackStatus = z.infer<typeof AppStackStatusSchema>;

/** Statuses that mean "an operation is (or should be) running" — the request transaction sets them. */
export const APP_STACK_BUSY_STATUSES = ["queued", "deploying", "starting", "stopping", "updating", "deleting"] as const satisfies readonly AppStackStatus[];

/** Spec §10.1 plus the additions of ADR-0035; every live status may go to `deleting`. */
export const ALLOWED_APP_STACK_TRANSITIONS: Readonly<Record<AppStackStatus, readonly AppStackStatus[]>> = Object.freeze({
  draft: Object.freeze(["queued", "deleting"] as const),
  queued: Object.freeze(["deploying", "failed", "deleting"] as const),
  deploying: Object.freeze(["running", "degraded", "failed", "unknown", "deleting"] as const),
  running: Object.freeze(["stopping", "starting", "updating", "deleting"] as const),
  degraded: Object.freeze(["stopping", "starting", "updating", "deleting"] as const),
  failed: Object.freeze(["starting", "stopping", "updating", "deleting"] as const),
  unknown: Object.freeze(["running", "degraded", "stopped", "failed", "starting", "stopping", "updating", "deleting"] as const),
  stopping: Object.freeze(["stopped", "running", "degraded", "failed", "unknown", "deleting"] as const),
  stopped: Object.freeze(["starting", "updating", "deleting"] as const),
  starting: Object.freeze(["running", "degraded", "failed", "unknown", "deleting"] as const),
  updating: Object.freeze(["running", "degraded", "failed", "unknown", "deleting"] as const),
  deleting: Object.freeze(["deleted", "delete_failed"] as const),
  delete_failed: Object.freeze(["deleting"] as const),
  deleted: Object.freeze([] as const),
});
export function canTransitionAppStack(from: AppStackStatus, to: AppStackStatus): boolean {
  return ALLOWED_APP_STACK_TRANSITIONS[from].includes(to);
}

export const APP_STACK_COMPONENT_HEALTH = ["unknown", "starting", "healthy", "unhealthy", "stopped", "missing"] as const;
export const AppStackComponentHealthSchema = z.enum(APP_STACK_COMPONENT_HEALTH);
export type AppStackComponentHealth = z.infer<typeof AppStackComponentHealthSchema>;
/** An observation older than this reads as `unknown` (spec §16). Same value as sites' 5 min. */
export const APP_STACK_HEALTH_STALE_AFTER_MS = 5 * 60_000;
export function effectiveComponentHealth(
  health: AppStackComponentHealth,
  observedAt: Date | null,
  now: Date,
): AppStackComponentHealth {
  if (observedAt === null || now.getTime() - observedAt.getTime() > APP_STACK_HEALTH_STALE_AFTER_MS) return "unknown";
  return health;
}

/**
 * Spec §16: `failed` when an essential component is not healthy, `degraded` when another one is not or the routes of an
 * ingress stack are not published, `running` otherwise.
 */
export function aggregateAppStackStatus(input: {
  readonly components: readonly { readonly health: AppStackComponentHealth; readonly essential: boolean }[];
  readonly hasIngress: boolean;
  readonly routesPublished: boolean;
}): "running" | "degraded" | "failed" {
  if (input.components.some((c) => c.essential && c.health !== "healthy")) return "failed";
  if (input.components.some((c) => c.health !== "healthy")) return "degraded";
  return input.hasIngress && !input.routesPublished ? "degraded" : "running";
}

export const APP_STACK_DEPLOYMENT_STATUSES = ["queued", "running", "succeeded", "failed", "unknown", "cancelled"] as const;
export const AppStackDeploymentStatusSchema = z.enum(APP_STACK_DEPLOYMENT_STATUSES);
export type AppStackDeploymentStatus = z.infer<typeof AppStackDeploymentStatusSchema>;
export const APP_STACK_TERMINAL_DEPLOYMENT_STATUSES = ["succeeded", "failed", "cancelled"] as const satisfies readonly AppStackDeploymentStatus[];

export const APP_STACK_VOLUME_STATUSES = ["pending", "present", "retained", "removed", "missing"] as const;
export type AppStackVolumeStatus = (typeof APP_STACK_VOLUME_STATUSES)[number];
export const APP_STACK_RETENTION_POLICIES = ["retain", "destroy"] as const;
export type AppStackRetentionPolicy = (typeof APP_STACK_RETENTION_POLICIES)[number];
