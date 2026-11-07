import { z } from "zod";

export const ERROR_CODES = [
  "UNAUTHENTICATED",
  "PERMISSION_DENIED",
  "NOT_FOUND",
  "VALIDATION_ERROR",
  "IDEMPOTENCY_CONFLICT",
  "PLAN_LIMIT",
  "RESOURCE_LOCKED",
  "COOLIFY_UNAVAILABLE",
  "PROVIDER_RATE_LIMIT",
  "OPERATION_AMBIGUOUS",
  "DOMAIN_CONFLICT",
  "NOT_SUPPORTED",
  "BACKUP_UNAVAILABLE",
  "LAST_OWNER_PROTECTED",
  "INTERNAL_ERROR",
] as const;

export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ERROR_CODE_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = Object.freeze({
  UNAUTHENTICATED: 401,
  PERMISSION_DENIED: 403,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  IDEMPOTENCY_CONFLICT: 409,
  PLAN_LIMIT: 403,
  RESOURCE_LOCKED: 409,
  COOLIFY_UNAVAILABLE: 503,
  PROVIDER_RATE_LIMIT: 429,
  OPERATION_AMBIGUOUS: 502,
  DOMAIN_CONFLICT: 409,
  NOT_SUPPORTED: 422,
  BACKUP_UNAVAILABLE: 503,
  LAST_OWNER_PROTECTED: 409,
  INTERNAL_ERROR: 500,
});

export const DEFAULT_RETRYABLE_ERROR_CODES = [
  "RESOURCE_LOCKED",
  "COOLIFY_UNAVAILABLE",
  "PROVIDER_RATE_LIMIT",
  "BACKUP_UNAVAILABLE",
] as const satisfies readonly ErrorCode[];

const DEFAULT_RETRYABLE_SET: ReadonlySet<ErrorCode> = new Set(DEFAULT_RETRYABLE_ERROR_CODES);

export function isDefaultRetryableErrorCode(code: ErrorCode): boolean {
  return DEFAULT_RETRYABLE_SET.has(code);
}

export const ErrorDetailSchema = z.object({
  field: z.string().min(1).optional(),
  message: z.string().min(1),
  reason: z.string().min(1).optional(),
});
export type ErrorDetail = z.infer<typeof ErrorDetailSchema>;

export const ApiErrorBodySchema = z.object({
  code: ErrorCodeSchema,
  message: z.string().min(1),
  requestId: z.string().min(1),
  retryable: z.boolean(),
  details: z.array(ErrorDetailSchema),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;

export const ApiErrorEnvelopeSchema = z.object({
  error: ApiErrorBodySchema,
});
export type ApiErrorEnvelope = z.infer<typeof ApiErrorEnvelopeSchema>;

export interface CreateErrorEnvelopeInput {
  readonly code: ErrorCode;
  readonly message: string;
  readonly requestId: string;
  readonly retryable?: boolean;
  readonly details?: readonly ErrorDetail[];
}

export function createErrorEnvelope(input: CreateErrorEnvelopeInput): ApiErrorEnvelope {
  return ApiErrorEnvelopeSchema.parse({
    error: {
      code: input.code,
      message: input.message,
      requestId: input.requestId,
      retryable: input.retryable ?? isDefaultRetryableErrorCode(input.code),
      details: input.details ? [...input.details] : [],
    },
  });
}
