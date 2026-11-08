import { LOCALE_COOKIE, resolveLocale, type Locale } from "./index";

// Server-only: kept apart from index.ts so client components can import index.
export async function getRequestLocale(): Promise<Locale> {
  const [{ cookies }, { getServerSession }] = await Promise.all([
    import("next/headers"),
    import("@/lib/server-session"),
  ]);
  const session = await getServerSession();
  return resolveLocale(session, (await cookies()).get(LOCALE_COOKIE)?.value);
}
