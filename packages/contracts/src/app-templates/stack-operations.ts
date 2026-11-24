import { z } from "zod";
import type { OperationKind } from "../operations.js";
import type { PermissionKey } from "../permissions.js";
import { AppEntityIdSchema } from "./stack-ids.js";
import { APP_STACK_STATUSES, type AppStackStatus } from "./stack-status.js";

export const APP_STACK_OPERATION_KINDS = [
  "stack.deploy",
  "stack.start",
  "stack.stop",
  "stack.restart",
  "stack.upgrade",
  "stack.rollback",
  "stack.delete",
] as const satisfies readonly OperationKind[];
export type AppStackOperationKind = (typeof APP_STACK_OPERATION_KINDS)[number];
/** Kinds that carry a revision to deploy (a new one for upgrade/rollback, the desired one for deploy). */
export const APP_STACK_REVISION_KINDS = ["stack.deploy", "stack.upgrade", "stack.rollback"] as const satisfies readonly AppStackOperationKind[];

export const APP_STACK_RESOURCE_TYPE = "stack" as const;
/** Operation lock of one stack; unique among active operations by uq_operations_active_lock. */
export function appStackLockKey(stackId: string): string {
  return `stack:${stackId}`;
}

export const APP_STACK_STEP_KEYS = [
  "validate",
  "reserve",
  "pull",
  "prepare",
  "create",
  "start",
  "health",
  "publish",
  "unpublish",
  "stop",
  "remove",
  "settle",
] as const;
export type AppStackStepKey = (typeof APP_STACK_STEP_KEYS)[number];
export const APP_STACK_STEP_LABELS: Readonly<Record<AppStackStepKey, string>> = Object.freeze({
  validate: "Check the request",
  reserve: "Reserve resources",
  pull: "Download the software",
  prepare: "Prepare the environment",
  create: "Create the components",
  start: "Start the components",
  health: "Wait until the application is ready",
  publish: "Publish the web addresses",
  unpublish: "Withdraw the web addresses",
  stop: "Stop the components",
  remove: "Remove the components",
  settle: "Finish",
});
const DEPLOY_STEPS = ["validate", "reserve", "pull", "prepare", "create", "start", "health", "publish", "settle"] as const;
export const APP_STACK_STEPS_BY_KIND: Readonly<Record<AppStackOperationKind, readonly AppStackStepKey[]>> = Object.freeze({
  "stack.deploy": DEPLOY_STEPS,
  "stack.upgrade": DEPLOY_STEPS,
  "stack.rollback": DEPLOY_STEPS,
  "stack.start": ["validate", "start", "health", "publish", "settle"],
  "stack.restart": ["validate", "start", "health", "publish", "settle"],
  "stack.stop": ["validate", "unpublish", "stop", "settle"],
  "stack.delete": ["validate", "unpublish", "stop", "remove", "settle"],
});
/** The `steps` argument of enqueueOperationTransactional for a kind. */
export function appStackOperationSteps(kind: AppStackOperationKind): { key: AppStackStepKey; label: string }[] {
  return APP_STACK_STEPS_BY_KIND[kind].map((key) => ({ key, label: APP_STACK_STEP_LABELS[key] }));
}

/**
 * The business part of the outbox payload (enqueue adds operationId, organizationId, kind, resourceType, resourceId).
 * Not strict: the worker parses the stored payload, which also carries those five keys; zod strips them.
 */
export const AppStackOperationPayloadSchema = z.object({
  stackId: AppEntityIdSchema,
  deploymentId: AppEntityIdSchema,
  revisionId: AppEntityIdSchema.nullable(),
});
export type AppStackOperationPayload = z.infer<typeof AppStackOperationPayloadSchema>;

/** Per stack: at most this many web addresses (≤ the executor's 20 hosts per route file). */
export const MAX_APP_STACK_DOMAINS = 8;

/** Audit actions (spec §16 mapped onto the existing writer). */
export const APP_AUDIT_ACTIONS = Object.freeze({
  templateCreate: "admin.app_template.create",
  templateVersion: "admin.app_template.version",
  templatePublish: "admin.app_template.publish",
  templateUpdate: "admin.app_template.update",
  templateArchive: "admin.app_template.archive",
  stackLimit: "admin.customer.app_stack_limit",
  stackCreate: "app.stack.create",
  stackDeploy: "app.stack.deploy",
  stackStart: "app.stack.start",
  stackStop: "app.stack.stop",
  stackRestart: "app.stack.restart",
  stackUpgrade: "app.stack.upgrade",
  stackRollback: "app.stack.rollback",
  stackDelete: "app.stack.delete",
  secretRotate: "app.stack.secret.rotate",
  domainAssign: "app.stack.domain.assign",
  domainRemove: "app.stack.domain.remove",
  domainUpdate: "app.stack.domain.update",
  backupCreate: "app.stack.backup.create",
  backupRestore: "app.stack.backup.restore",
  linkCreate: "app.stack.link.create",
  linkRemove: "app.stack.link.remove",
} as const);
export const APP_AUDIT_TARGET_TYPES = Object.freeze({
  template: "app_template",
  stack: "app_stack",
  domain: "app_stack_domain",
  link: "app_stack_link",
} as const);

const LIVE = ["running", "degraded", "stopped", "failed", "unknown"] as const;
const toUpdating = Object.fromEntries(LIVE.map((s) => [s, "updating"] as const));
/** Status written by the request transaction that enqueues each kind, per current status. */
export const APP_STACK_ENQUEUE_TRANSITIONS: Readonly<
  Record<AppStackOperationKind, Readonly<Partial<Record<AppStackStatus, AppStackStatus>>>>
> = Object.freeze({
  "stack.deploy": Object.freeze({ draft: "queued", ...toUpdating }),
  "stack.upgrade": Object.freeze({ ...toUpdating }),
  "stack.rollback": Object.freeze({ ...toUpdating }),
  "stack.start": Object.freeze({ stopped: "starting", failed: "starting", unknown: "starting" }),
  "stack.restart": Object.freeze({ running: "starting", degraded: "starting", failed: "starting", unknown: "starting" }),
  "stack.stop": Object.freeze({ running: "stopping", degraded: "stopping", failed: "stopping", unknown: "stopping" }),
  "stack.delete": Object.freeze(
    Object.fromEntries(
      APP_STACK_STATUSES.filter((s) => s !== "deleting" && s !== "deleted").map((s) => [s, "deleting"] as const),
    ),
  ),
});
/** The status the request transaction writes, or null when the kind is not allowed from `current`. */
export function appStackEnqueueTarget(kind: AppStackOperationKind, current: AppStackStatus): AppStackStatus | null {
  return APP_STACK_ENQUEUE_TRANSITIONS[kind][current] ?? null;
}

/** The permission the route of each kind asks of the caller; a deploy that carries settings also asks `app.update`. */
export const APP_STACK_KIND_PERMISSIONS: Readonly<Record<AppStackOperationKind, PermissionKey>> = Object.freeze({
  "stack.deploy": "app.control",
  "stack.start": "app.control",
  "stack.stop": "app.control",
  "stack.restart": "app.control",
  "stack.upgrade": "app.update",
  "stack.rollback": "app.update",
  "stack.delete": "app.delete",
});

/**
 * Why the request transaction refuses `kind` now, or null when it accepts it: an active operation holding the stack's
 * lock refuses every kind (`locked`, retryable), then the table decides from the stored status (`status`). The status
 * the page shows (health included) never enters: only an operation changes the stored one.
 */
export function appStackEnqueueRefusal(kind: AppStackOperationKind, stored: AppStackStatus, locked: boolean): "locked" | "status" | null {
  if (locked) return "locked";
  return appStackEnqueueTarget(kind, stored) === null ? "status" : null;
}

/** The kinds the API accepts now from a caller who holds the permissions `may` grants, in APP_STACK_OPERATION_KINDS order. */
export function appStackAllowedActions(
  stored: AppStackStatus,
  locked: boolean,
  may: (permission: PermissionKey) => boolean,
): AppStackOperationKind[] {
  return APP_STACK_OPERATION_KINDS.filter((kind) => appStackEnqueueRefusal(kind, stored, locked) === null && may(APP_STACK_KIND_PERMISSIONS[kind]));
}
