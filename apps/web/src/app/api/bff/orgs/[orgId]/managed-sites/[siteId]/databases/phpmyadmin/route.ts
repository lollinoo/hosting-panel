import { SiteDatabaseSignOnDtoSchema } from "@hosting-panel/contracts";
import { z } from "zod";
import { validateCsrfAndOrigin, validatePathSegments } from "@/lib/bff-guard";
import { readBoundedText } from "@/lib/bff-proxy";
import { bffErrorResponse, bffJsonResponse } from "@/lib/bff-response";
import {
  PMA_COOKIE_MAX_AGE_S,
  PMA_COOKIE_NAME,
  pmaPrefix,
  sealPmaCookie,
  sessionBindingId,
} from "@/lib/phpmyadmin-forwarder";
import { getSessionFromRequest } from "@/lib/server-session";
import { getSessionSecretKey } from "@/lib/session";
import { fetchUpstream } from "@/lib/upstream";

export const dynamic = "force-dynamic";

const SIGNON_TIMEOUT_MS = 130_000;
const MAX_SIGNON_BODY_BYTES = 4096;
const EmptyBodySchema = z.object({}).strict();
const UpstreamSignOnSchema = z.object({ data: SiteDatabaseSignOnDtoSchema }).strict();

type SiteCtx = { params: Promise<{ orgId: string; siteId: string }> };

export async function POST(req: Request, context: SiteCtx): Promise<Response> {
  const params = await context.params;
  const orgId = params.orgId ?? "";
  const siteId = params.siteId ?? "";
  const segmentError = validatePathSegments({ orgId, siteId });
  if (segmentError) return segmentError;

  const session = await getSessionFromRequest(req);
  const guardError = validateCsrfAndOrigin(req, session);
  if (guardError) return guardError;

  const contentLengthHeader = req.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > MAX_SIGNON_BODY_BYTES) {
      return bffErrorResponse("VALIDATION_ERROR", "Corpo della richiesta troppo grande", 413);
    }
  }

  const raw = await readBoundedText(req, MAX_SIGNON_BODY_BYTES);
  if (raw === null) {
    return bffErrorResponse("VALIDATION_ERROR", "Corpo della richiesta troppo grande", 413);
  }
  if (raw.trim().length > 0) {
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(raw);
    } catch {
      return bffErrorResponse("VALIDATION_ERROR", "Corpo della richiesta JSON non valido", 400);
    }
    if (!EmptyBodySchema.safeParse(parsedBody).success) {
      return bffErrorResponse("VALIDATION_ERROR", "Dati della richiesta non validi", 400);
    }
  }

  const upstreamPath = `v1/organizations/${orgId}/managed-sites/${siteId}/databases/phpmyadmin`;
  const upstreamRes = await fetchUpstream(upstreamPath, {
    method: "POST",
    accessToken: session!.accessToken,
    timeoutMs: SIGNON_TIMEOUT_MS,
  });

  if (!upstreamRes.ok) {
    return bffJsonResponse(upstreamRes.error, { status: upstreamRes.status });
  }

  const parsed = UpstreamSignOnSchema.safeParse(upstreamRes.data);
  if (!parsed.success) {
    return bffErrorResponse("INTERNAL_ERROR", "Risposta del server non valida", 502);
  }

  const url = pmaPrefix(siteId);
  const sealed = await sealPmaCookie(getSessionSecretKey(), {
    siteId,
    orgId,
    username: parsed.data.data.username,
    password: parsed.data.data.temporaryPassword,
    sid: sessionBindingId(session!),
  });

  const response = bffJsonResponse({ data: { url } });
  response.cookies.set({
    name: PMA_COOKIE_NAME,
    value: sealed,
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: url,
    maxAge: PMA_COOKIE_MAX_AGE_S,
  });
  return response;
}
