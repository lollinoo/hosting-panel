import { TriggerOperationInputSchema } from "@hosting-panel/contracts";
import {
  isValidPathSegment,
  triggerApplicationRestartUpstream,
} from "../../../../../../../../lib/bff-client";
import {
  bffErrorResponse,
  bffJsonResponse,
  readSessionFromRequest,
  requireIdempotencyHeader,
  resolveBffRequestId,
  verifyCsrfAndOrigin,
} from "../../../../../../../../lib/session";

export const dynamic = "force-dynamic";

export interface AppRouteContext {
  readonly params: Promise<{
    readonly orgId: string;
    readonly appId: string;
  }>;
}

export async function POST(
  request: Request,
  context: AppRouteContext,
): Promise<Response> {
  const requestId = resolveBffRequestId(request);
  const session = await readSessionFromRequest(request);

  if (!session) {
    return bffErrorResponse({
      code: "UNAUTHENTICATED",
      message: "Sessione non autenticata.",
      requestId,
    });
  }

  const csrfRejected = verifyCsrfAndOrigin(request, session);
  if (csrfRejected) {
    return csrfRejected;
  }

  const idemCheck = requireIdempotencyHeader(request);
  if (!idemCheck.ok) {
    return idemCheck.response;
  }

  const { orgId, appId } = await context.params;
  if (!isValidPathSegment(orgId) || !isValidPathSegment(appId)) {
    return bffErrorResponse({
      code: "NOT_FOUND",
      message: "Applicazione o organizzazione non trovata.",
      requestId,
    });
  }

  let parsedBody: unknown = {};
  try {
    const rawText = await request.text();
    if (rawText.trim().length > 0) {
      parsedBody = JSON.parse(rawText) as unknown;
    }
  } catch {
    return bffErrorResponse({
      code: "VALIDATION_ERROR",
      message: "Corpo JSON della richiesta non valido.",
      requestId,
    });
  }

  const validatedInput = TriggerOperationInputSchema.safeParse(parsedBody);
  if (!validatedInput.success) {
    return bffErrorResponse({
      code: "VALIDATION_ERROR",
      message: "Parametri per il riavvio non validi.",
      requestId,
    });
  }

  const upstream = await triggerApplicationRestartUpstream({
    accessToken: session.accessToken,
    orgId,
    appId,
    idempotencyKey: idemCheck.key,
    input: validatedInput.data,
    requestId,
  });

  if (!upstream.ok) {
    return bffJsonResponse(upstream.error, {
      status: upstream.status,
      requestId: upstream.requestId,
    });
  }

  return bffJsonResponse(upstream.data, {
    status: 202,
    requestId: upstream.requestId,
  });
}
