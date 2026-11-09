import { z } from "zod";
import { ErrorCodeSchema } from "./errors.js";

const IsoDateTimeSchema = z.string().datetime({ offset: true });

export const OPERATION_STATUSES = [
  "queued",
  "processing",
  "accepted",
  "reconciling",
  "succeeded",
  "failed",
  "unknown",
  "cancelled",
] as const;

export const OperationStatusSchema = z.enum(OPERATION_STATUSES);
export type OperationStatus = z.infer<typeof OperationStatusSchema>;

export const OPERATION_TERMINAL_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
] as const satisfies readonly OperationStatus[];

export const OperationTerminalStatusSchema = z.enum(OPERATION_TERMINAL_STATUSES);
export type OperationTerminalStatus = z.infer<typeof OperationTerminalStatusSchema>;

const TERMINAL_STATUS_SET: ReadonlySet<OperationStatus> = new Set(OPERATION_TERMINAL_STATUSES);

export function isTerminalOperationStatus(
  status: OperationStatus,
): status is OperationTerminalStatus {
  return TERMINAL_STATUS_SET.has(status);
}

export const OPERATION_KINDS = [
  "service.deploy",
  "service.restart",
  "service.stop",
  "site.deploy",
  "site.provision",
  "site.delete",
  "site.reassign",
  "host.maintenance",
  "host.security",
  "host.allocate",
] as const;

export const OperationKindSchema = z.enum(OPERATION_KINDS);
export type OperationKind = z.infer<typeof OperationKindSchema>;

export const ALLOWED_OPERATION_TRANSITIONS: Readonly<
  Record<OperationStatus, readonly OperationStatus[]>
> = Object.freeze({
  queued: Object.freeze<readonly OperationStatus[]>(["processing", "cancelled"]),
  processing: Object.freeze<readonly OperationStatus[]>([
    "accepted",
    "reconciling",
    "failed",
    "unknown",
  ]),
  accepted: Object.freeze<readonly OperationStatus[]>(["reconciling", "failed", "unknown"]),
  reconciling: Object.freeze<readonly OperationStatus[]>([
    "succeeded",
    "failed",
    "unknown",
    "cancelled",
  ]),
  unknown: Object.freeze<readonly OperationStatus[]>(["reconciling", "failed"]),
  succeeded: Object.freeze<readonly OperationStatus[]>([]),
  failed: Object.freeze<readonly OperationStatus[]>([]),
  cancelled: Object.freeze<readonly OperationStatus[]>([]),
});

export function canTransitionOperation(from: OperationStatus, to: OperationStatus): boolean {
  return ALLOWED_OPERATION_TRANSITIONS[from].includes(to);
}

export const OPERATION_STEP_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
  "unknown",
] as const;

export const OperationStepStatusSchema = z.enum(OPERATION_STEP_STATUSES);
export type OperationStepStatus = z.infer<typeof OperationStepStatusSchema>;

export const OPERATION_RESOURCE_TYPES = [
  "host",
  "allocation",
  "site",
  "service",
  "domain",
  "quota",
] as const;

export const OperationResourceTypeSchema = z.enum(OPERATION_RESOURCE_TYPES);
export type OperationResourceType = z.infer<typeof OperationResourceTypeSchema>;

export const OperationTimelineStepSchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  label: z.string().min(1),
  status: OperationStepStatusSchema,
  message: z.string().nullable(),
  startedAt: IsoDateTimeSchema.nullable(),
  completedAt: IsoDateTimeSchema.nullable(),
});
export type OperationTimelineStep = z.infer<typeof OperationTimelineStepSchema>;

export const OperationDtoSchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  kind: OperationKindSchema,
  status: OperationStatusSchema,
  resourceType: OperationResourceTypeSchema,
  resourceId: z.string().min(1),
  requestedByUserId: z.string().min(1).nullable(),
  errorCode: ErrorCodeSchema.nullable(),
  errorMessage: z.string().nullable(),
  submittedAt: IsoDateTimeSchema,
  startedAt: IsoDateTimeSchema.nullable(),
  completedAt: IsoDateTimeSchema.nullable(),
  updatedAt: IsoDateTimeSchema,
  steps: z.array(OperationTimelineStepSchema),
});
export type OperationDto = z.infer<typeof OperationDtoSchema>;

export const AsyncAcceptedDataSchema = z.object({
  operationId: z.string().min(1),
  status: OperationStatusSchema,
  resourceId: z.string().min(1),
  submittedAt: IsoDateTimeSchema,
});
export type AsyncAcceptedData = z.infer<typeof AsyncAcceptedDataSchema>;

export const AsyncAcceptedLinksSchema = z.object({
  self: z.string().regex(/^(\/\S*|https?:\/\/\S+)$/),
});
export type AsyncAcceptedLinks = z.infer<typeof AsyncAcceptedLinksSchema>;

export const AsyncAcceptedEnvelopeSchema = z.object({
  data: AsyncAcceptedDataSchema,
  links: AsyncAcceptedLinksSchema,
});
export type AsyncAcceptedEnvelope = z.infer<typeof AsyncAcceptedEnvelopeSchema>;
