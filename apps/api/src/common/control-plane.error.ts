import { randomUUID } from "node:crypto";
import {
  redactSensitiveString,
  type CursorPage,
  type ErrorCode,
  type ErrorDetail,
} from "@hosting-panel/contracts";
import type { FastifyRequest } from "fastify";

const HOST_PATH_LEAK_PATTERN = /(?:\/run|\/var|\/etc|\/tmp)\/[^\s"'`)]+/g;

export function sanitizePublicErrorMessage(raw: string): string {
  return redactSensitiveString(raw).replace(HOST_PATH_LEAK_PATTERN, "[REDACTED_PATH]");
}

export interface ControlPlaneErrorOptions {
  readonly details?: readonly ErrorDetail[];
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
}

export class ControlPlaneError extends Error {
  public readonly code: ErrorCode;
  public readonly details: readonly ErrorDetail[];
  public readonly retryable?: boolean;
  public readonly retryAfterMs?: number;

  public constructor(code: ErrorCode, message: string, options?: ControlPlaneErrorOptions) {
    super(message);
    this.name = "ControlPlaneError";
    this.code = code;
    this.details = options?.details ? [...options.details] : [];
    this.retryable = options?.retryable;
    this.retryAfterMs = options?.retryAfterMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface RequestWithContext extends FastifyRequest {
  controlPlaneRequestId?: string;
}

const SAFE_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function resolveRequestId(req: FastifyRequest): string {
  const typedReq = req as RequestWithContext;
  if (typeof typedReq.controlPlaneRequestId === "string" && typedReq.controlPlaneRequestId.length > 0) {
    return typedReq.controlPlaneRequestId;
  }

  const rawHeader = req.headers["x-request-id"];
  const candidate = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (typeof candidate === "string") {
    const trimmed = candidate.trim();
    if (SAFE_REQUEST_ID_PATTERN.test(trimmed)) {
      typedReq.controlPlaneRequestId = trimmed;
      return trimmed;
    }
  }

  const generated = `req_${randomUUID().replace(/-/g, "")}`;
  typedReq.controlPlaneRequestId = generated;
  return generated;
}

export function extractClientIp(req: FastifyRequest): string | null {
  if (typeof req.ip === "string" && req.ip.trim().length > 0) {
    return req.ip.trim();
  }
  return null;
}

export function extractRawHeader(
  headers: Record<string, string | string[] | undefined>,
  headerNameLower: string,
): string | undefined {
  const direct = headers[headerNameLower];
  if (typeof direct === "string") {
    return direct;
  }
  if (Array.isArray(direct)) {
    return direct[0];
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === headerNameLower) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

const SAFE_IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{1,255}$/;

export function requireIdempotencyKey(
  headers: Record<string, string | string[] | undefined>,
): string {
  const raw = extractRawHeader(headers, "idempotency-key");
  const trimmed = raw?.trim() ?? "";

  if (trimmed.length === 0) {
    throw new ControlPlaneError(
      "VALIDATION_ERROR",
      "Idempotency-Key header is required for mutating operations.",
      {
        details: [
          {
            field: "Idempotency-Key",
            message: "Provide a unique non-empty Idempotency-Key header.",
            reason: "MISSING_IDEMPOTENCY_KEY",
          },
        ],
      },
    );
  }

  if (!SAFE_IDEMPOTENCY_KEY_PATTERN.test(trimmed)) {
    throw new ControlPlaneError(
      "VALIDATION_ERROR",
      "Idempotency-Key header contains invalid characters or exceeds maximum length.",
      {
        details: [
          {
            field: "Idempotency-Key",
            message: "Idempotency-Key must be 1..255 printable ASCII characters.",
            reason: "INVALID_IDEMPOTENCY_KEY",
          },
        ],
      },
    );
  }

  return trimmed;
}

export function resolveOptionalIdempotencyKey(
  headers: Record<string, string | string[] | undefined>,
  fallbackPrefix: string,
): string {
  const raw = extractRawHeader(headers, "idempotency-key");
  if (raw === undefined) {
    return `${fallbackPrefix}_${randomUUID().replace(/-/g, "")}`;
  }
  return requireIdempotencyKey(headers);
}

export interface PaginationParams {
  readonly cursor?: string;
  readonly limit: number;
}

export function parsePaginationQuery(query: Record<string, unknown> | undefined): PaginationParams {
  const rawLimit = query?.["limit"];
  let limit = 50;

  if (rawLimit !== undefined && rawLimit !== null && rawLimit !== "") {
    const parsed =
      typeof rawLimit === "number"
        ? rawLimit
        : typeof rawLimit === "string" && /^\d+$/.test(rawLimit.trim())
          ? Number.parseInt(rawLimit.trim(), 10)
          : Number.NaN;

    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
      throw new ControlPlaneError("VALIDATION_ERROR", "Query parameter 'limit' must be an integer between 1 and 100.", {
        details: [{ field: "limit", message: "Must be an integer between 1 and 100." }],
      });
    }
    limit = parsed;
  }

  const rawCursor = query?.["cursor"];
  const cursor =
    typeof rawCursor === "string" && rawCursor.trim().length > 0 ? rawCursor.trim() : undefined;

  return { cursor, limit };
}

export function paginateItems<T extends { readonly id: string }>(
  items: readonly T[],
  params: PaginationParams,
): { readonly data: T[]; readonly page: CursorPage } {
  return paginateByKey(items, (item) => item.id, params);
}

export function paginateByKey<T>(
  items: readonly T[],
  getKey: (item: T) => string,
  params: PaginationParams,
): { readonly data: T[]; readonly page: CursorPage } {
  let startIndex = 0;
  if (params.cursor) {
    const foundIndex = items.findIndex((item) => getKey(item) === params.cursor);
    if (foundIndex === -1) {
      return {
        data: [],
        page: { nextCursor: null, hasMore: false },
      };
    }
    startIndex = foundIndex + 1;
  }

  const sliced = items.slice(startIndex, startIndex + params.limit);
  const hasMore = startIndex + params.limit < items.length;
  const lastItem = sliced[sliced.length - 1];

  return {
    data: [...sliced],
    page: {
      nextCursor: hasMore && lastItem !== undefined ? getKey(lastItem) : null,
      hasMore,
    },
  };
}
