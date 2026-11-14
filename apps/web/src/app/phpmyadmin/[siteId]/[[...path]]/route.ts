import { DEFAULT_PHPMYADMIN_PORT } from "@hosting-panel/contracts";
import { LOCALE_COOKIE, getMessages, resolveLocale } from "@/i18n";
import { createPhpMyAdminForwarder } from "@/lib/phpmyadmin-forwarder";
import { fetchPhpMyAdminUpstream } from "@/lib/phpmyadmin-upstream";
import { getSessionFromRequest, parseCookieHeader } from "@/lib/server-session";
import { getSessionSecretKey } from "@/lib/session";
import { getApiInternalUrl } from "@/lib/upstream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const REFUSED_PHPMYADMIN_PORTS = new Set([22, 80, 443, 2222, 3000, 4000, 5432]);

function resolvePhpMyAdminPort(): number {
  const raw = process.env.HP_PHPMYADMIN_PORT?.trim();
  if (!raw) return DEFAULT_PHPMYADMIN_PORT;
  if (!/^\d+$/.test(raw)) {
    throw new Error("HP_PHPMYADMIN_PORT must be an integer between 1 and 65535");
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || REFUSED_PHPMYADMIN_PORTS.has(port)) {
    throw new Error("HP_PHPMYADMIN_PORT is invalid or uses a reserved port");
  }
  return port;
}

type ForwarderHandler = ReturnType<typeof createPhpMyAdminForwarder>;
let cachedForwarder: ForwarderHandler | null = null;

function getForwarder(): ForwarderHandler {
  if (!cachedForwarder) {
    cachedForwarder = createPhpMyAdminForwarder({
      readSession: getSessionFromRequest,
      cookieKey: getSessionSecretKey(),
      apiBaseUrl: getApiInternalUrl(),
      upstreamOrigin: `http://127.0.0.1:${resolvePhpMyAdminPort()}`,
      upstreamFetch: fetchPhpMyAdminUpstream,
      secureCookies: process.env.NODE_ENV === "production",
      locale: (req, session) =>
        resolveLocale(session, parseCookieHeader(req.headers.get("cookie"))[LOCALE_COOKIE]),
      texts: (loc) => getMessages(loc).site.database.phpmyadmin,
    });
  }
  return cachedForwarder;
}

type RouteContext = { params: Promise<{ siteId: string; path?: string[] }> };

async function handle(req: Request, context: RouteContext): Promise<Response> {
  const { siteId, path } = await context.params;
  return getForwarder()(req, siteId, path ?? []);
}

function methodNotAllowed(): Response {
  return new Response(null, {
    status: 405,
    headers: {
      Allow: "GET, HEAD, POST",
      "Cache-Control": "no-store, max-age=0",
    },
  });
}

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const OPTIONS = methodNotAllowed;
