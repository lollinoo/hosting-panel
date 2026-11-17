import { NextResponse } from "next/server";
import { bffUpstreamResponse, readBoundedJsonBody } from "@/lib/bff-proxy";
import { bffErrorResponse } from "@/lib/bff-response";
import { fetchUpstream } from "@/lib/upstream";

// Open like the login route: no session exists yet. Only the schema's field goes upstream.
export async function POST(req: Request) {
  const parsed = await readBoundedJsonBody(req, { requireJsonBody: true });
  if (!parsed.ok) return parsed.response;
  if (typeof parsed.body !== "object" || parsed.body === null || Array.isArray(parsed.body)) {
    return bffErrorResponse("VALIDATION_ERROR", "Corpo della richiesta JSON non valido", 400);
  }
  const { email } = parsed.body as { email?: unknown };
  const upstream = await fetchUpstream("v1/auth/password-reset/request", { method: "POST", body: { email } });
  // The same empty 202 for every address, so the answer never tells whether it exists.
  if (upstream.ok) return new NextResponse(null, { status: 202, headers: { "Cache-Control": "no-store, max-age=0" } });
  return bffUpstreamResponse(upstream);
}
