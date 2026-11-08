import { NextResponse } from "next/server";
import { clearSessionCookie } from "@/lib/server-session";

// Pages land here when the API rejects the session (revoked or expired): drop the stale cookie, then log in again.
// Relative Location so the redirect stays on whatever host the reverse proxy exposes.
export async function GET() {
  const response = new NextResponse(null, { status: 307, headers: { Location: "/login" } });
  clearSessionCookie(response);
  return response;
}
