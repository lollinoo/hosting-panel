import { cookies } from "next/headers";
import {
  SESSION_COOKIE_NAME,
  unsealSession,
  type BffSessionPayload,
} from "./session";

export async function readServerSession(): Promise<BffSessionPayload | null> {
  const cookieStore = await cookies();
  const rawCookie = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  return unsealSession(rawCookie);
}
