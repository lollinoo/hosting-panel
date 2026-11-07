import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  SESSION_COOKIE_NAME,
  decryptSession,
  encryptSession,
  type SessionData,
} from "./session";

export function parseCookieHeader(header: string | null): Record<string, string> {
  if (!header) return {};
  const result: Record<string, string> = {};
  for (const part of header.split(";")) {
    const [rawKey, ...valParts] = part.trim().split("=");
    if (rawKey) {
      result[rawKey] = decodeURIComponent(valParts.join("="));
    }
  }
  return result;
}

export async function getSessionFromRequest(req: Request): Promise<SessionData | null> {
  const cookieHeader = req.headers.get("cookie");
  const parsed = parseCookieHeader(cookieHeader);
  const token = parsed[SESSION_COOKIE_NAME];
  if (!token) return null;
  return await decryptSession(token);
}

export async function getServerSession(): Promise<SessionData | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  return await decryptSession(token);
}

export async function setSessionCookie(
  response: NextResponse,
  session: SessionData
): Promise<void> {
  const encrypted = await encryptSession(session);
  const isProduction = process.env.NODE_ENV === "production";
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: encrypted,
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction,
    path: "/",
    maxAge: 60 * 60 * 24, // 24 hours
  });
}

export function clearSessionCookie(response: NextResponse): void {
  const isProduction = process.env.NODE_ENV === "production";
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction,
    path: "/",
    maxAge: 0,
  });
}
