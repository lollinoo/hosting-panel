import { timingSafeEqual, createHash } from "node:crypto";
import { bffErrorResponse } from "./bff-response";
import type { SessionData } from "./session";
import type { NextResponse } from "next/server";

export const PATH_SEGMENT_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;

export function isValidPathSegment(segment: string): boolean {
  return PATH_SEGMENT_REGEX.test(segment);
}

export function validatePathSegments(
  segments: Record<string, string>
): NextResponse | null {
  for (const [key, value] of Object.entries(segments)) {
    if (!isValidPathSegment(value)) {
      return bffErrorResponse(
        "VALIDATION_ERROR",
        `Parametro di percorso '${key}' non valido`,
        400,
        [{ field: key, message: "Deve corrispondere a /^[a-zA-Z0-9_-]{1,128}$/" }]
      );
    }
  }
  return null;
}

export function timingSafeCompare(a: string, b: string): boolean {
  const hashA = createHash("sha256").update(a).digest();
  const hashB = createHash("sha256").update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

export function validateCsrfAndOrigin(
  req: Request,
  session: SessionData | null
): NextResponse | null {
  if (!session) {
    return bffErrorResponse(
      "UNAUTHENTICATED",
      "Sessione non autenticata o scaduta",
      401
    );
  }

  // 1. Validate Origin header
  const origin = req.headers.get("origin");
  if (origin) {
    let reqOrigin: string;
    try {
      reqOrigin = new URL(req.url).origin;
    } catch {
      // Invalid request URL
      return bffErrorResponse(
        "PERMISSION_DENIED",
        "URL richiesta non valido",
        403
      );
    }

    if (origin.toLowerCase() !== reqOrigin.toLowerCase()) {
      // Also allow forwarded host if behind proxy
      const forwardedHost = req.headers.get("x-forwarded-host");
      const host = req.headers.get("host");
      const originHost = new URL(origin).host;
      if (originHost !== host && originHost !== forwardedHost) {
        return bffErrorResponse(
          "PERMISSION_DENIED",
          "Origine della richiesta non consentita",
          403
        );
      }
    }
  }

  // 2. Validate X-CSRF-Token
  const csrfHeader = req.headers.get("x-csrf-token");
  if (!csrfHeader) {
    return bffErrorResponse(
      "PERMISSION_DENIED",
      "Intestazione X-CSRF-Token mancante",
      403
    );
  }

  if (!timingSafeCompare(csrfHeader, session.csrfToken)) {
    return bffErrorResponse(
      "PERMISSION_DENIED",
      "Token CSRF non valido o non corrispondente",
      403
    );
  }

  return null;
}
