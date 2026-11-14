import { z } from "zod";

export const ERROR_CODES = [
  "UNAUTHENTICATED",
  "PERMISSION_DENIED",
  "HOST_POLICY_DENIED",
  "ORGANIZATION_SUSPENDED",
  "NOT_FOUND",
  "VALIDATION_ERROR",
  "IDEMPOTENCY_CONFLICT",
  "RESOURCE_LOCKED",
  "QUOTA_EXCEEDED",
  "DEDICATED_HOST_OCCUPIED",
  "SHARED_MODE_GATED",
  "DOMAIN_CONFLICT",
  "LAST_OWNER_PROTECTED",
  "NOT_SUPPORTED",
  "OPERATION_INTERRUPTED",
  "OPERATION_AMBIGUOUS",
  "DOCKER_ENGINE_UNAVAILABLE",
  "HOST_AGENT_UNAVAILABLE",
  "MAIL_RELAY_UNAVAILABLE",
  "INTERNAL_ERROR",
  "INVALID_CREDENTIALS",
  "ACCOUNT_LOCKED",
  "TOTP_INVALID",
  "ACCOUNT_SETUP_INCOMPLETE",
] as const;

export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ERROR_CODE_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = Object.freeze({
  UNAUTHENTICATED: 401,
  PERMISSION_DENIED: 403,
  HOST_POLICY_DENIED: 403,
  ORGANIZATION_SUSPENDED: 403,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  IDEMPOTENCY_CONFLICT: 409,
  RESOURCE_LOCKED: 409,
  QUOTA_EXCEEDED: 409,
  DEDICATED_HOST_OCCUPIED: 409,
  SHARED_MODE_GATED: 409,
  DOMAIN_CONFLICT: 409,
  LAST_OWNER_PROTECTED: 409,
  OPERATION_INTERRUPTED: 409,
  NOT_SUPPORTED: 422,
  OPERATION_AMBIGUOUS: 502,
  DOCKER_ENGINE_UNAVAILABLE: 503,
  HOST_AGENT_UNAVAILABLE: 503,
  MAIL_RELAY_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
  INVALID_CREDENTIALS: 401,
  ACCOUNT_LOCKED: 423,
  TOTP_INVALID: 401,
  ACCOUNT_SETUP_INCOMPLETE: 403,
});

export const DEFAULT_RETRYABLE_ERROR_CODES = [
  "RESOURCE_LOCKED",
  "DOCKER_ENGINE_UNAVAILABLE",
  "HOST_AGENT_UNAVAILABLE",
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
