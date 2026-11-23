import { z } from "zod";
import type { OperationKind } from "../operations.js";
import { APP_TEMPLATE_LIMITS, AppStackKeySchema } from "./limits.js";
import { AppEntityIdSchema } from "./stack-ids.js";
import type { AppStackStatus } from "./stack-status.js";

/**
 * Backup and restore of an application (ADR-0038). A family of its own beside the seven stack kinds: these
 * operations have no deployment row, never pass through `updating`, and bring the application back with a chained
 * `stack.start` / `stack.restart` operation.
 */
export const APP_STACK_BACKUP_OPERATION_KINDS = [
  "stack.backup",
  "stack.restore",
  "stack.prune",
] as const satisfies readonly OperationKind[];
export type AppStackBackupOperationKind = (typeof APP_STACK_BACKUP_OPERATION_KINDS)[number];

export const APP_STACK_BACKUP_STEP_KEYS = ["validate", "unpublish", "stop", "copy", "restore", "expire", "settle"] as const;
export type AppStackBackupStepKey = (typeof APP_STACK_BACKUP_STEP_KEYS)[number];

/** Shown to the customer: no technical object is named. */
export const APP_STACK_BACKUP_STEP_LABELS: Readonly<Record<AppStackBackupStepKey, string>> = Object.freeze({
  validate: "Check the request",
  unpublish: "Withdraw the web addresses",
  stop: "Stop the application",
  copy: "Save a copy of the data",
  restore: "Put the saved data back",
  expire: "Remove old backups",
  settle: "Finish",
});

export const APP_STACK_BACKUP_STEPS_BY_KIND: Readonly<Record<AppStackBackupOperationKind, readonly AppStackBackupStepKey[]>> =
  Object.freeze({
    "stack.backup": ["validate", "unpublish", "stop", "copy", "settle"],
    // `copy` is the safety backup of the data as they are now.
    "stack.restore": ["validate", "unpublish", "stop", "copy", "restore", "settle"],
    "stack.prune": ["validate", "expire", "settle"],
  });

export function appStackBackupOperationSteps(kind: AppStackBackupOperationKind): { key: AppStackBackupStepKey; label: string }[] {
  return APP_STACK_BACKUP_STEPS_BY_KIND[kind].map((key) => ({ key, label: APP_STACK_BACKUP_STEP_LABELS[key] }));
}

/**
 * Outbox payload. `backupId` is the row the operation writes (the `pre_restore` safety backup for a restore, null
 * for a prune); `sourceBackupId` is the backup a restore reads.
 */
export const AppStackBackupOperationPayloadSchema = z.object({
  stackId: AppEntityIdSchema,
  backupId: AppEntityIdSchema.nullable(),
  sourceBackupId: AppEntityIdSchema.nullable(),
});
export type AppStackBackupOperationPayload = z.infer<typeof AppStackBackupOperationPayloadSchema>;

/**
 * Status the application takes when a backup or a restore is accepted: a live application is stopped first, a
 * stopped one stays stopped. `null` = refused (busy, draft, unknown, deleted).
 */
export function appStackBackupEnqueueTarget(current: AppStackStatus): AppStackStatus | null {
  if (current === "running" || current === "degraded" || current === "failed") return "stopping";
  return current === "stopped" ? "stopped" : null;
}

export const APP_STACK_BACKUP_KINDS = ["manual", "pre_restore"] as const;
export type AppStackBackupKind = (typeof APP_STACK_BACKUP_KINDS)[number];
export const APP_STACK_BACKUP_STATUSES = ["running", "succeeded", "partial", "failed"] as const;
export type AppStackBackupStatus = (typeof APP_STACK_BACKUP_STATUSES)[number];
export const APP_STACK_BACKUP_COPY_STATUSES = ["running", "succeeded", "failed"] as const;
export type AppStackBackupCopyStatus = (typeof APP_STACK_BACKUP_COPY_STATUSES)[number];
export const APP_STACK_RESTORE_STATUSES = ["running", "succeeded", "failed"] as const;
export type AppStackRestoreStatus = (typeof APP_STACK_RESTORE_STATUSES)[number];

/** Safety backups (`pre_restore`) kept per application, in their own slots like the sites' `pre_update` copies. */
export const APP_STACK_PRE_RESTORE_BACKUPS_KEPT = 3;
/** Backups and restores a customer may start per application per hour; administrators are not limited. */
export const APP_STACK_BACKUP_ACTIONS_PER_HOUR = 6;
export const APP_STACK_BACKUP_ACTION_WINDOW_MS = 3_600_000;

/** Why «Create backup» is not offered; null when it is. */
export const APP_STACK_BACKUP_UNAVAILABLE_REASONS = ["not_available", "no_destination", "no_data"] as const;
export type AppStackBackupUnavailableReason = (typeof APP_STACK_BACKUP_UNAVAILABLE_REASONS)[number];

const IsoDateTimeSchema = z.string().datetime({ offset: true });
/** A backup problem class or an ErrorCode, never free text. */
const ProblemSchema = z.string().max(64).nullable();

export const CreateAppStackBackupInputSchema = z.object({}).strict();
export const RestoreAppStackBackupInputSchema = z.object({ confirmName: z.string().max(64) }).strict();
export type RestoreAppStackBackupInput = z.infer<typeof RestoreAppStackBackupInputSchema>;

export const AppStackBackupDtoSchema = z.object({
  id: AppEntityIdSchema,
  kind: z.enum(APP_STACK_BACKUP_KINDS),
  status: z.enum(APP_STACK_BACKUP_STATUSES),
  problem: ProblemSchema,
  sizeBytes: z.number().int().nonnegative().nullable(),
  volumeKeys: z.array(AppStackKeySchema).max(APP_TEMPLATE_LIMITS.volumes),
  // One per destination, by priority. No destination name, address or path.
  copies: z.array(
    z.object({
      priority: z.number().int().positive(),
      status: z.enum(APP_STACK_BACKUP_COPY_STATUSES),
      problem: ProblemSchema,
    }),
  ),
  startedAt: IsoDateTimeSchema,
  finishedAt: IsoDateTimeSchema.nullable(),
  /** The last restore that read this backup. */
  restore: z
    .object({ status: z.enum(APP_STACK_RESTORE_STATUSES), problem: ProblemSchema, at: IsoDateTimeSchema.nullable() })
    .nullable(),
  /** At least one good copy, and data that still belongs to the application. */
  restorable: z.boolean(),
});
export type AppStackBackupDto = z.infer<typeof AppStackBackupDtoSchema>;

export const AppStackBackupsDtoSchema = z.object({
  backups: z.array(AppStackBackupDtoSchema), // newest first
  unavailableReason: z.enum(APP_STACK_BACKUP_UNAVAILABLE_REASONS).nullable(),
});
export type AppStackBackupsDto = z.infer<typeof AppStackBackupsDtoSchema>;
