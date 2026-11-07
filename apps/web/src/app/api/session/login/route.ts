import { z } from "zod";
import { fetchMe, issueDevAccessToken } from "../../../../lib/bff-client";
import {
  bffErrorResponse,
  bffJsonResponse,
  generateCsrfToken,
  resolveBffRequestId,
  sealSession,
  serializeSessionCookie,
  verifyRequestOrigin,
} from "../../../../lib/session";

export const dynamic = "force-dynamic";

const LoginBodySchema = z
  .strictObject({
    userId: z.string().trim().min(1).max(128).optional(),
    email: z.email().optional(),
    preferredOrgSlug: z.string().trim().min(1).max(128).optional(),
  })
  .refine((val) => Boolean(val.userId || val.email), {
    message: "Specificare userId oppure email per effettuare l'accesso.",
  });

export async function POST(request: Request): Promise<Response> {
  const requestId = resolveBffRequestId(request);

  const originCheck = verifyRequestOrigin(request);
  if (!originCheck.ok) {
    return bffErrorResponse({
      code: "PERMISSION_DENIED",
      message: originCheck.reason ?? "Origine della richiesta non autorizzata.",
      requestId,
    });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return bffErrorResponse({
      code: "VALIDATION_ERROR",
      message: "Corpo JSON della richiesta di login non valido.",
      requestId,
    });
  }

  const parsedInput = LoginBodySchema.safeParse(rawBody);
  if (!parsedInput.success) {
    return bffErrorResponse({
      code: "VALIDATION_ERROR",
      message: "Parametri di accesso non validi.",
      requestId,
      details: parsedInput.error.issues.map((issue) => ({
        field: issue.path.join(".") || undefined,
        message: issue.message,
      })),
    });
  }

  const issued = await issueDevAccessToken({
    userId: parsedInput.data.userId,
    email: parsedInput.data.email,
    requestId,
  });
  if (!issued.ok) {
    return bffJsonResponse(issued.error, {
      status: issued.status,
      requestId: issued.requestId,
    });
  }

  const meRes = await fetchMe(issued.data.accessToken, issued.requestId);
  if (!meRes.ok) {
    return bffJsonResponse(meRes.error, {
      status: meRes.status,
      requestId: meRes.requestId,
    });
  }

  const me = meRes.data.data;
  const preferredSlug = parsedInput.data.preferredOrgSlug ?? null;
  const matchedPreferred = preferredSlug
    ? me.memberships.find((m) => m.organizationSlug === preferredSlug)
    : undefined;

  let activeOrgSlug: string | null = null;
  if (matchedPreferred) {
    activeOrgSlug = matchedPreferred.organizationSlug;
  } else if (me.memberships.length === 1 && me.memberships[0]) {
    activeOrgSlug = me.memberships[0].organizationSlug;
  }

  let redirectTo = "/choose-organization";
  if (me.user.isPlatformAdmin && me.memberships.length === 0) {
    redirectTo = "/admin/overview";
  } else if (activeOrgSlug !== null) {
    redirectTo = `/o/${activeOrgSlug}/overview`;
  }

  const csrfToken = generateCsrfToken();
  const sealed = await sealSession(
    {
      accessToken: issued.data.accessToken,
      csrfToken,
      activeOrgSlug,
      user: me.user,
    },
    issued.data.expiresIn,
  );

  return bffJsonResponse(
    {
      authenticated: true,
      user: me.user,
      activeOrgSlug,
      csrfToken,
      redirectTo,
    },
    {
      status: 200,
      requestId: meRes.requestId,
      allowCsrfTokenField: true,
      setCookie: serializeSessionCookie(sealed, issued.data.expiresIn),
    },
  );
}
