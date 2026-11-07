import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  createErrorEnvelope,
  ERROR_CODE_HTTP_STATUS,
  findForbiddenPublicDtoKeys,
  type ApiErrorEnvelope,
  type ErrorCode,
  type ErrorDetail,
} from "@hosting-panel/contracts";
import { EncryptJWT, jwtDecrypt } from "jose";
import { z } from "zod";

export const SESSION_COOKIE_NAME = "hp_session";
export const BFF_CACHE_CONTROL = "private, no-store, max-age=0";
export const DEFAULT_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

const DEV_FALLBACK_SESSION_SECRET =
  "hosting-panel-dev-bff-session-secret-a256gcm-v01";

export const BffSessionUserSchema = z.object({
  id: z.string().min(1).max(128),
  email: z.email(),
  displayName: z.string().min(1),
  isPlatformAdmin: z.boolean(),
});
export type BffSessionUser = z.infer<typeof BffSessionUserSchema>;

export const BffSessionPayloadSchema = z.object({
  accessToken: z.string().min(1),
  csrfToken: z.string().min(16),
  activeOrgSlug: z.string().min(1).max(128).nullable(),
  user: BffSessionUserSchema,
});
export type BffSessionPayload = z.infer<typeof BffSessionPayloadSchema>;

export interface PublicSessionView {
  readonly authenticated: boolean;
  readonly user: BffSessionUser | null;
  readonly activeOrgSlug: string | null;
  readonly csrfToken: string | null;
}

function getSessionSecretKey(): Uint8Array {
  const configured = process.env["BFF_SESSION_SECRET"]?.trim();
  const isProdRuntime =
    process.env["NODE_ENV"] === "production" &&
    process.env["NEXT_PHASE"] !== "phase-production-build";
  if (isProdRuntime && (!configured || configured.length < 16)) {
    throw new Error(
      "BFF_SESSION_SECRET (>= 16 chars) is mandatory in production runtime.",
    );
  }
  const rawSecret =
    configured && configured.length >= 16 ? configured : DEV_FALLBACK_SESSION_SECRET;
  const digest = createHash("sha256").update(rawSecret, "utf8").digest();
  return new Uint8Array(digest);
}

export function generateCsrfToken(): string {
  return randomBytes(24).toString("base64url");
}

export function resolveBffRequestId(request?: Request): string {
  const incoming = request?.headers.get("x-request-id")?.trim();
  if (incoming && /^[a-zA-Z0-9._:-]{1,128}$/.test(incoming)) {
    return incoming;
  }
  return `req_${randomUUID().replace(/-/g, "")}`;
}

export async function sealSession(
  payload: BffSessionPayload,
  maxAgeSeconds = DEFAULT_SESSION_MAX_AGE_SECONDS,
): Promise<string> {
  const validated = BffSessionPayloadSchema.parse(payload);
  const effectiveMaxAge = Math.max(60, Math.min(Math.floor(maxAgeSeconds), 86_400));

  return new EncryptJWT({
    accessToken: validated.accessToken,
    csrfToken: validated.csrfToken,
    activeOrgSlug: validated.activeOrgSlug,
    user: validated.user,
  })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime(`${String(effectiveMaxAge)}s`)
    .encrypt(getSessionSecretKey());
}

export async function unsealSession(
  encryptedCookieValue: string | undefined | null,
): Promise<BffSessionPayload | null> {
  if (!encryptedCookieValue || encryptedCookieValue.trim().length === 0) {
    return null;
  }

  try {
    const { payload } = await jwtDecrypt(encryptedCookieValue, getSessionSecretKey(), {
      keyManagementAlgorithms: ["dir"],
      contentEncryptionAlgorithms: ["A256GCM"],
    });
    const parsed = BffSessionPayloadSchema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function extractCookieFromHeader(
  cookieHeader: string | null,
  cookieName: string,
): string | null {
  if (!cookieHeader) {
    return null;
  }

  const segments = cookieHeader.split(";");
  for (const rawSegment of segments) {
    const trimmed = rawSegment.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eqIdx).trim();
    if (key !== cookieName) {
      continue;
    }
    const rawValue = trimmed.slice(eqIdx + 1).trim();
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return rawValue;
    }
  }

  return null;
}

export async function readSessionFromRequest(
  request: Request,
): Promise<BffSessionPayload | null> {
  const rawCookie = extractCookieFromHeader(
    request.headers.get("cookie"),
    SESSION_COOKIE_NAME,
  );
  return unsealSession(rawCookie);
}

export function serializeSessionCookie(
  sealedValue: string,
  maxAgeSeconds = DEFAULT_SESSION_MAX_AGE_SECONDS,
): string {
  const clampedMaxAge = Math.max(60, Math.min(Math.floor(maxAgeSeconds), 86_400));
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(sealedValue)}`,
    "Path=/",
    `Max-Age=${String(clampedMaxAge)}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (process.env["NODE_ENV"] === "production") {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function serializeClearSessionCookie(): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (process.env["NODE_ENV"] === "production") {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function safeEqualStrings(left: string, right: string): boolean {
  const leftBuf = Buffer.from(left, "utf8");
  const rightBuf = Buffer.from(right, "utf8");
  if (leftBuf.length === 0 || leftBuf.length !== rightBuf.length) {
    return false;
  }
  return timingSafeEqual(leftBuf, rightBuf);
}

export function verifyRequestOrigin(request: Request): {
  readonly ok: boolean;
  readonly reason?: string;
} {
  const originHeader = request.headers.get("origin");
  if (originHeader === null) {
    return { ok: true };
  }

  const trimmedOrigin = originHeader.trim();
  if (trimmedOrigin.length === 0 || trimmedOrigin === "null") {
    return {
      ok: false,
      reason: "Intestazione Origin nulla o non valida.",
    };
  }

  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(trimmedOrigin);
  } catch {
    return {
      ok: false,
      reason: "Formato intestazione Origin non valido.",
    };
  }

  const trustProxy = process.env["BFF_TRUST_PROXY"] === "true";
  const forwardedHost = trustProxy
    ? request.headers.get("x-forwarded-host")?.split(",")[0]?.trim()
    : undefined;
  const hostHeader = request.headers.get("host")?.trim();
  const fallbackHost = (() => {
    try {
      return new URL(request.url).host;
    } catch {
      return "";
    }
  })();

  const expectedHost = (forwardedHost || hostHeader || fallbackHost).toLowerCase();
  if (!expectedHost || parsedOrigin.host.toLowerCase() !== expectedHost) {
    return {
      ok: false,
      reason: "Richiesta cross-site bloccata: Origin non coincide con Host.",
    };
  }

  return { ok: true };
}

export function verifyCsrfAndOrigin(
  request: Request,
  session: BffSessionPayload,
): Response | null {
  const requestId = resolveBffRequestId(request);
  const originCheck = verifyRequestOrigin(request);
  if (!originCheck.ok) {
    return bffErrorResponse({
      code: "PERMISSION_DENIED",
      message: originCheck.reason ?? "Origine della richiesta non autorizzata.",
      requestId,
      details: [{ reason: "ORIGIN_MISMATCH", message: "Origin mismatch against Host." }],
    });
  }

  const candidateCsrf = request.headers.get("x-csrf-token")?.trim() ?? "";
  if (!safeEqualStrings(candidateCsrf, session.csrfToken)) {
    return bffErrorResponse({
      code: "PERMISSION_DENIED",
      message: "Token di sicurezza CSRF mancante o non valido.",
      requestId,
      details: [{ reason: "CSRF_INVALID", message: "Missing or invalid X-CSRF-Token." }],
    });
  }

  return null;
}

export function requireIdempotencyHeader(request: Request):
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false; readonly response: Response } {
  const requestId = resolveBffRequestId(request);
  const rawKey = request.headers.get("idempotency-key")?.trim() ?? "";
  if (rawKey.length < 8 || rawKey.length > 128 || !/^[a-zA-Z0-9._:-]+$/.test(rawKey)) {
    return {
      ok: false,
      response: bffErrorResponse({
        code: "VALIDATION_ERROR",
        message: "Intestazione Idempotency-Key obbligatoria (8-128 caratteri validi).",
        requestId,
        details: [
          {
            field: "Idempotency-Key",
            reason: "MISSING_IDEMPOTENCY_KEY",
            message: "Provide a valid Idempotency-Key header.",
          },
        ],
      }),
    };
  }

  return { ok: true, key: rawKey };
}

export interface BffJsonResponseOptions {
  readonly status?: number;
  readonly requestId?: string;
  readonly allowCsrfTokenField?: boolean;
  readonly setCookie?: string;
}

export function bffJsonResponse(
  payload: unknown,
  options?: BffJsonResponseOptions,
): Response {
  const requestId = options?.requestId ?? resolveBffRequestId();
  const forbiddenKeys = findForbiddenPublicDtoKeys(payload).filter((keyPath) =>
    options?.allowCsrfTokenField ? keyPath !== "csrfToken" : true,
  );

  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": BFF_CACHE_CONTROL,
    "X-Content-Type-Options": "nosniff",
    "X-Request-ID": requestId,
  });

  if (options?.setCookie) {
    headers.set("Set-Cookie", options.setCookie);
  }

  if (forbiddenKeys.length > 0) {
    const blocked = createErrorEnvelope({
      code: "INTERNAL_ERROR",
      message: "Risposta bloccata dal perimetro di sicurezza BFF.",
      requestId,
    });
    headers.delete("Set-Cookie");
    return new Response(JSON.stringify(blocked), {
      status: 500,
      headers,
    });
  }

  return new Response(JSON.stringify(payload), {
    status: options?.status ?? 200,
    headers,
  });
}

export function bffErrorResponse(input: {
  readonly code: ErrorCode;
  readonly message: string;
  readonly requestId?: string;
  readonly status?: number;
  readonly retryable?: boolean;
  readonly details?: readonly ErrorDetail[];
}): Response {
  const requestId = input.requestId ?? resolveBffRequestId();
  const envelope: ApiErrorEnvelope = createErrorEnvelope({
    code: input.code,
    message: input.message,
    requestId,
    retryable: input.retryable,
    details: input.details,
  });

  return bffJsonResponse(envelope, {
    status: input.status ?? ERROR_CODE_HTTP_STATUS[input.code],
    requestId,
  });
}
