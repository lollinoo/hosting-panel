import { randomUUID } from "node:crypto";
import {
  MAX_BFF_BODY_BYTES,
  type SiteCtx,
  forwardSiteCall,
  isPlainObject,
} from "@/lib/bff-files";
import { validateCsrfAndOrigin, validatePathSegments } from "@/lib/bff-guard";
import { bffUpstreamResponse, readBoundedText } from "@/lib/bff-proxy";
import { bffErrorResponse } from "@/lib/bff-response";
import { getSessionFromRequest } from "@/lib/server-session";
import { fetchUpstream } from "@/lib/upstream";

const BACKUP_ROUTE_TIMEOUT_MS = 20_000;

// Forward GET requests for a site's backups list with a 20s upstream timeout.
export async function GET(req: Request, context: SiteCtx): Promise<Response> {
  return forwardSiteCall(req, context, "backups", "GET", {
    timeoutMs: BACKUP_ROUTE_TIMEOUT_MS,
  });
}

// Trigger an on-demand site backup upstream with Idempotency-Key and an empty JSON object body.
export async function POST(req: Request, context: SiteCtx): Promise<Response> {
  const params = await context.params;
  const orgId = params.orgId ?? "";
  const siteId = params.siteId ?? "";
  const pathError = validatePathSegments({ orgId, siteId });
  if (pathError) return pathError;

  const session = await getSessionFromRequest(req);
  if (!session) {
    return bffErrorResponse("UNAUTHENTICATED", "Authentication required.", 401);
  }

  const guardError = validateCsrfAndOrigin(req, session);
  if (guardError) return guardError;

  const contentLengthHeader = req.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > MAX_BFF_BODY_BYTES) {
      return bffErrorResponse("VALIDATION_ERROR", "Request body too large.", 413);
    }
  }

  const raw = await readBoundedText(req, MAX_BFF_BODY_BYTES);
  if (raw === null) {
    return bffErrorResponse("VALIDATION_ERROR", "Request body too large.", 413);
  }

  if (raw.trim().length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return bffErrorResponse("VALIDATION_ERROR", "Malformed JSON body.", 400);
    }
    if (!isPlainObject(parsed) || Object.keys(parsed).length > 0) {
      return bffErrorResponse("VALIDATION_ERROR", "Request body must be an empty JSON object.", 400);
    }
  }

  const idempotencyKey = req.headers.get("idempotency-key")?.trim() || randomUUID();
  const upstreamRes = await fetchUpstream(
    `v1/organizations/${encodeURIComponent(orgId)}/managed-sites/${encodeURIComponent(siteId)}/backups`,
    {
      method: "POST",
      accessToken: session.accessToken,
      idempotencyKey,
      body: {},
      timeoutMs: BACKUP_ROUTE_TIMEOUT_MS,
    },
  );
  return bffUpstreamResponse(upstreamRes);
}
