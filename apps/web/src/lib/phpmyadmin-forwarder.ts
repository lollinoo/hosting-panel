import { EncryptJWT, jwtDecrypt } from "jose";
import { createHash } from "node:crypto";
import type { SessionData } from "./session";

export const PMA_COOKIE_NAME = "hp_pma";
export const PMA_COOKIE_MAX_AGE_S = 4 * 60 * 60;
export const PMA_COOKIE_RE = /^(?:__Secure-)?(?:phpMyAdmin|pma_[A-Za-z0-9_]+)(?:_https)?$/;

const PMA_JWT_AUDIENCE = "hp-phpmyadmin";
const SITE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const RIGHTS_CACHE_TTL_MS = 30_000;
const RIGHTS_CACHE_MAX_ENTRIES = 1000;
const API_RIGHTS_TIMEOUT_MS = 10_000;
const UPSTREAM_HEADERS_TIMEOUT_MS = 310_000;
const SITE_MAX_IN_FLIGHT = 2;
const SITE_QUEUE_WAIT_MS = 30_000;
const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST"]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const FORWARDED_CLIENT_HEADERS = [
  "accept",
  "accept-language",
  "content-type",
  "content-length",
  "if-modified-since",
  "if-none-match",
  "if-range",
  "range",
  "user-agent",
  "x-requested-with",
] as const;

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

export interface PmaCookiePayload {
  siteId: string;
  orgId: string;
  username: string;
  password: string;
  sid: string;
}

export interface PmaPageTexts {
  downTitle: string;
  downBody: string;
  backToDatabases: string;
}

export interface ForwarderDeps {
  readSession(req: Request): Promise<SessionData | null>;
  cookieKey: Uint8Array;
  apiBaseUrl: string;
  upstreamOrigin: string;
  secureCookies: boolean;
  locale(req: Request, s: SessionData | null): "it" | "en";
  fetch?: typeof fetch;
  upstreamFetch?: typeof fetch;
  now?: () => number;
  texts?: (locale: "it" | "en") => PmaPageTexts;
}

const DEFAULT_DOWN_TEXTS: Record<"it" | "en", PmaPageTexts> = {
  en: {
    downTitle: "phpMyAdmin isn't available right now",
    downBody: "Wait a minute and try again. If it keeps happening, contact your hosting provider.",
    backToDatabases: "Back to the site's databases",
  },
  it: {
    downTitle: "phpMyAdmin non è disponibile in questo momento",
    downBody: "Attendi un minuto e riprova. Se il problema continua, contatta il tuo fornitore di hosting.",
    backToDatabases: "Torna ai database del sito",
  },
};

const ENDED_TEXTS: Record<"it" | "en", { title: string; body: string }> = {
  en: {
    title: "phpMyAdmin",
    body: "Your phpMyAdmin session has ended. Someone else may have opened phpMyAdmin for this site. Open it again from the site's databases.",
  },
  it: {
    title: "phpMyAdmin",
    body: "La sessione di phpMyAdmin è terminata. Qualcun altro potrebbe aver aperto phpMyAdmin per questo sito. Riaprilo dai database del sito.",
  },
};

const NO_ACCESS_TEXTS: Record<"it" | "en", { title: string; body: string }> = {
  en: {
    title: "phpMyAdmin",
    body: "You no longer have access to this site's databases.",
  },
  it: {
    title: "phpMyAdmin",
    body: "Non hai più accesso ai database di questo sito.",
  },
};

const BUSY_TEXTS: Record<"it" | "en", { title: string; body: string }> = {
  en: {
    title: "phpMyAdmin is busy",
    body: "phpMyAdmin is still busy with earlier work for this site. Wait a minute, or open phpMyAdmin again from the Database tab to stop that work.",
  },
  it: {
    title: "phpMyAdmin è occupato",
    body: "phpMyAdmin è ancora occupato con operazioni precedenti per questo sito. Attendi un minuto oppure riapri phpMyAdmin dalla scheda Database per interromperle.",
  },
};

const STILL_WORKING_TEXTS: Record<"it" | "en", { title: string; body: string }> = {
  en: {
    title: "phpMyAdmin is still working",
    body: "Your last request is taking more than 5 minutes and is still running. Don't send it again. Wait for it to finish, or open phpMyAdmin again from the Database tab to stop it.",
  },
  it: {
    title: "phpMyAdmin sta ancora lavorando",
    body: "La tua ultima richiesta richiede più di 5 minuti ed è ancora in corso. Non inviarla di nuovo. Attendi che finisca oppure riapri phpMyAdmin dalla scheda Database per interromperla.",
  },
};

export function pmaPrefix(siteId: string): string {
  return `/phpmyadmin/${siteId}/`;
}

export function sessionBindingId(session: SessionData): string {
  return createHash("sha256").update(session.csrfToken).digest("hex").slice(0, 32);
}

export async function sealPmaCookie(
  key: Uint8Array,
  p: PmaCookiePayload,
  nowMs?: number,
): Promise<string> {
  const issuedAtSec = Math.floor((nowMs ?? Date.now()) / 1000);
  return await new EncryptJWT({
    siteId: p.siteId,
    orgId: p.orgId,
    username: p.username,
    password: p.password,
    sid: p.sid,
  })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setAudience(PMA_JWT_AUDIENCE)
    .setIssuedAt(issuedAtSec)
    .setExpirationTime(issuedAtSec + PMA_COOKIE_MAX_AGE_S)
    .encrypt(key);
}

export async function openPmaCookie(
  key: Uint8Array,
  jwe: string,
  currentDate?: Date,
): Promise<PmaCookiePayload | null> {
  try {
    const { payload } = await jwtDecrypt(jwe, key, {
      audience: PMA_JWT_AUDIENCE,
      contentEncryptionAlgorithms: ["A256GCM"],
      keyManagementAlgorithms: ["dir"],
      ...(currentDate ? { currentDate } : {}),
    });

    if (
      typeof payload.siteId !== "string" ||
      payload.siteId.length === 0 ||
      typeof payload.orgId !== "string" ||
      payload.orgId.length === 0 ||
      typeof payload.username !== "string" ||
      payload.username.length === 0 ||
      typeof payload.password !== "string" ||
      payload.password.length === 0 ||
      typeof payload.sid !== "string" ||
      payload.sid.length === 0
    ) {
      return null;
    }

    return {
      siteId: payload.siteId,
      orgId: payload.orgId,
      username: payload.username,
      password: payload.password,
      sid: payload.sid,
    };
  } catch {
    return null;
  }
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderPanelHtmlPage(
  locale: "it" | "en",
  title: string,
  body: string,
  backLabel: string,
  siteId: string,
): string {
  const href = `/sites/${encodeURIComponent(siteId)}/database`;
  return [
    "<!doctype html>",
    `<html lang="${locale}">`,
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    "<style>body{font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1.25rem;color:#111;line-height:1.5}h1{font-size:1.25rem;margin:0 0 .75rem}p{margin:0 0 1.25rem;color:#444}a{color:#0b57d0}</style>",
    "</head>",
    "<body>",
    `<h1>${escapeHtml(title)}</h1>`,
    `<p>${escapeHtml(body)}</p>`,
    `<p><a href="${escapeHtml(href)}">${escapeHtml(backLabel)}</a></p>`,
    "</body>",
    "</html>",
  ].join("");
}

function htmlResponse(
  status: number,
  method: string,
  html: string,
  extraHeaders: Record<string, string> = {},
): Response {
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "X-Frame-Options": "DENY",
    ...extraHeaders,
  });
  return new Response(method === "HEAD" ? null : html, { status, headers });
}

function noStoreResponse(status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(null, {
    status,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      ...extraHeaders,
    },
  });
}

function clearPmaCookieHeader(siteId: string, secure: boolean): string {
  const parts = [
    `${PMA_COOKIE_NAME}=`,
    `Path=${pmaPrefix(siteId)}`,
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function isPageLoad(req: Request): boolean {
  const method = req.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;
  if (req.headers.get("x-requested-with")?.toLowerCase() === "xmlhttprequest") return false;
  const secFetchMode = req.headers.get("sec-fetch-mode")?.trim().toLowerCase() ?? null;
  if (secFetchMode === "navigate") return true;
  if (secFetchMode !== null) return false;
  const accept = req.headers.get("accept")?.toLowerCase() ?? "";
  return accept.includes("text/html");
}

function decodeAndCheckSegment(rawSegment: string): string | null {
  if (rawSegment === "" || rawSegment === "." || rawSegment === "..") return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawSegment);
  } catch {
    return null;
  }
  if (
    decoded === "" ||
    decoded === "." ||
    decoded === ".." ||
    decoded.includes("/") ||
    decoded.includes("\\") ||
    decoded.includes("\0")
  ) {
    return null;
  }
  return decoded;
}

function validateAndBuildRestPath(
  url: URL,
  siteId: string,
  path: string[],
): string | null {
  const prefix = pmaPrefix(siteId);
  if (url.pathname.startsWith(prefix)) {
    const rawTail = url.pathname.slice(prefix.length);
    if (rawTail.startsWith("/")) return null;
    if (rawTail.length > 0) {
      if (rawTail.includes("//")) return null;
      const trimmed = rawTail.endsWith("/") ? rawTail.slice(0, -1) : rawTail;
      if (trimmed.length > 0) {
        for (const seg of trimmed.split("/")) {
          if (decodeAndCheckSegment(seg) === null) return null;
        }
      }
    }
  }

  if (path.length === 0) return "/";

  const encodedSegments: string[] = [];
  for (const seg of path) {
    const decoded = decodeAndCheckSegment(seg);
    if (decoded === null) return null;
    encodedSegments.push(encodeURIComponent(decoded));
  }
  const trailingSlash = url.pathname.endsWith("/") ? "/" : "";
  return `/${encodedSegments.join("/")}${trailingSlash}`;
}

function isSameOrigin(req: Request, reqUrl: URL): boolean {
  const secFetchSite = req.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (secFetchSite !== undefined) {
    if (secFetchSite !== "same-origin") return false;
  }

  const origin = req.headers.get("origin");
  if (origin === null) {
    return secFetchSite === "same-origin";
  }

  let originHost: string;
  try {
    const parsedOrigin = new URL(origin);
    if (parsedOrigin.origin === "null") return false;
    originHost = parsedOrigin.host.toLowerCase();
  } catch {
    return false;
  }

  const forwardedHost = req.headers
    .get("x-forwarded-host")
    ?.split(",")[0]
    ?.trim()
    .toLowerCase();
  const host = req.headers.get("host")?.trim().toLowerCase();

  if (forwardedHost || host) {
    return originHost === forwardedHost || originHost === host;
  }
  return originHost === reqUrl.host.toLowerCase();
}

function parseInboundCookies(header: string | null): {
  rawPmaToken: string | null;
  upstreamCookieHeader: string | null;
} {
  if (!header) return { rawPmaToken: null, upstreamCookieHeader: null };
  let rawPmaToken: string | null = null;
  const forwarded: string[] = [];

  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const rawVal = part.slice(eq + 1).trim();
    if (!name) continue;
    if (name === PMA_COOKIE_NAME && rawPmaToken === null) {
      rawPmaToken = rawVal;
      continue;
    }
    if (PMA_COOKIE_RE.test(name)) {
      forwarded.push(`${name}=${rawVal}`);
    }
  }

  return {
    rawPmaToken,
    upstreamCookieHeader: forwarded.length > 0 ? forwarded.join("; ") : null,
  };
}

function rewriteSetCookie(raw: string, prefix: string): string | null {
  const parts = raw.split(";");
  const nameValue = parts[0]?.trim() ?? "";
  const eq = nameValue.indexOf("=");
  if (eq <= 0) return null;
  const name = nameValue.slice(0, eq).trim();
  if (!PMA_COOKIE_RE.test(name)) return null;

  const attrs: string[] = [nameValue];
  for (const part of parts.slice(1)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf("=");
    const attrName = (eqIdx === -1 ? trimmed : trimmed.slice(0, eqIdx)).trim().toLowerCase();
    if (attrName === "path" || attrName === "domain") continue;
    attrs.push(trimmed);
  }
  attrs.push(`Path=${prefix}`);
  return attrs.join("; ");
}

function sanitizeLocation(rawLocation: string, prefix: string, restPath: string): string {
  if (/[\r\n]/.test(rawLocation) || rawLocation.includes("\\")) {
    return prefix;
  }
  const baseUrl = `http://panel.local${prefix}${restPath.slice(1)}`;
  try {
    const resolved = new URL(rawLocation, baseUrl);
    if (resolved.origin !== "http://panel.local") return prefix;
    if (!resolved.pathname.startsWith(prefix)) return prefix;
    return rawLocation;
  } catch {
    return prefix;
  }
}

function collectConnectionHeaders(headers: Headers): Set<string> {
  const extra = new Set<string>();
  const conn = headers.get("connection");
  if (!conn) return extra;
  for (const token of conn.split(",")) {
    const name = token.trim().toLowerCase();
    if (name) extra.add(name);
  }
  return extra;
}

function getRawSetCookies(headers: Headers): string[] {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

interface SiteWaiter {
  resolve: (result: SiteSlotResult) => void;
}

interface SiteConcurrencyState {
  inFlight: number;
  waiters: SiteWaiter[];
}

type SiteSlotResult =
  | { status: "acquired"; release: () => void }
  | { status: "timeout" }
  | { status: "aborted" };

// Reports whether an upstream response completes immediately without holding a stream body.
function isImmediateReleaseResponse(res: Response, method: string): boolean {
  return (
    res.status === 401 ||
    res.status === 204 ||
    res.status === 205 ||
    res.status === 304 ||
    method === "HEAD" ||
    REDIRECT_STATUSES.has(res.status) ||
    res.body === null
  );
}

// Reads a stream reader to EOF or error in the background and then runs release once.
function drainReaderToEnd(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  release: () => void,
): void {
  void (async () => {
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      // Upstream body failed while draining; release in finally still frees the slot.
    } finally {
      release();
    }
  })();
}

// Wraps an upstream response body so client cancel drains to EOF and closed bodies release without waiting.
function createMonitoredUpstreamBody(
  upstreamBody: ReadableStream<Uint8Array>,
  release: () => void,
): ReadableStream<Uint8Array> {
  const reader = upstreamBody.getReader();
  let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  let bufferedResult: ReadableStreamReadResult<Uint8Array> | null = null;
  let pullIsAwaiting = false;
  let draining = false;
  let drainStarted = false;
  let ended = false;

  const markEnded = () => {
    ended = true;
    release();
  };

  const launchPrefetch = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (ended || draining || pendingRead || bufferedResult !== null) return;
    const p = reader.read();
    pendingRead = p;
    p.then(
      (res) => {
        if (pendingRead === p) pendingRead = null;
        if (pullIsAwaiting || draining) return;
        if (res.done) {
          markEnded();
          try {
            controller.close();
          } catch {
            // Stream may already be canceled or closed concurrently.
          }
          return;
        }
        bufferedResult = res;
      },
      (err) => {
        if (pendingRead === p) pendingRead = null;
        if (pullIsAwaiting || draining) return;
        markEnded();
        try {
          controller.error(err);
        } catch {
          // Stream may already be canceled or closed concurrently.
        }
      },
    );
  };

  const startBackgroundDrain = () => {
    if (ended || drainStarted) {
      release();
      return;
    }
    drainStarted = true;
    void (async () => {
      try {
        if (pendingRead) {
          const p = pendingRead;
          const res = await p;
          if (pendingRead === p) pendingRead = null;
          if (res.done) {
            markEnded();
            return;
          }
        }
        drainReaderToEnd(reader, markEnded);
      } catch {
        markEnded();
      }
    })();
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (ended || draining) return;
      try {
        let result: ReadableStreamReadResult<Uint8Array>;
        if (bufferedResult !== null) {
          result = bufferedResult;
          bufferedResult = null;
        } else if (pendingRead !== null) {
          pullIsAwaiting = true;
          result = await pendingRead;
          pullIsAwaiting = false;
          pendingRead = null;
        } else {
          const p = reader.read();
          pendingRead = p;
          pullIsAwaiting = true;
          result = await p;
          pullIsAwaiting = false;
          pendingRead = null;
        }
        if (draining) {
          if (result.done) {
            markEnded();
          } else {
            startBackgroundDrain();
          }
          return;
        }
        if (result.done) {
          markEnded();
          controller.close();
          return;
        }
        controller.enqueue(result.value);
        // Peek at most one read ahead so finite 1-chunk responses release immediately even if unread.
        if (controller.desiredSize !== null && controller.desiredSize <= 0) {
          launchPrefetch(controller);
        }
      } catch (err) {
        pullIsAwaiting = false;
        pendingRead = null;
        markEnded();
        if (!draining) {
          controller.error(err);
        }
      }
    },
    cancel() {
      draining = true;
      bufferedResult = null;
      if (!pullIsAwaiting) {
        startBackgroundDrain();
      }
    },
  });
}

// Waits for upstream response headers without aborting upstream on timeout or client disconnect.
function waitForUpstreamHeaders(
  fetchPromise: Promise<Response>,
  reqSignal: AbortSignal | undefined,
  onDetachedSettle: (res: Response | null) => void,
): Promise<{ status: "ok"; response: Response } | { status: "rejected" } | { status: "detached" }> {
  return new Promise((resolve) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(headerTimer);
      reqSignal?.removeEventListener("abort", onAbort);
    };

    const detach = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ status: "detached" });
    };

    const headerTimer = setTimeout(detach, UPSTREAM_HEADERS_TIMEOUT_MS);
    const onAbort = () => detach();

    if (reqSignal?.aborted) {
      detach();
    } else {
      reqSignal?.addEventListener("abort", onAbort, { once: true });
    }

    fetchPromise.then(
      (response) => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve({ status: "ok", response });
          return;
        }
        onDetachedSettle(response);
      },
      () => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve({ status: "rejected" });
          return;
        }
        onDetachedSettle(null);
      },
    );
  });
}

export function createPhpMyAdminForwarder(
  deps: ForwarderDeps,
): (req: Request, siteId: string, path: string[]) => Promise<Response> {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const upstreamFetchFn = deps.upstreamFetch ?? fetchFn;
  const nowFn = deps.now ?? Date.now;
  const rightsCache = new Map<string, number>();
  const siteConcurrency = new Map<string, SiteConcurrencyState>();
  const apiBase = deps.apiBaseUrl.replace(/\/+$/, "");
  const upstreamBase = deps.upstreamOrigin.replace(/\/+$/, "");

  const getDownTexts = (locale: "it" | "en"): PmaPageTexts =>
    deps.texts ? deps.texts(locale) : DEFAULT_DOWN_TEXTS[locale];

  const renderDownPage = (req: Request, session: SessionData | null, siteId: string): Response => {
    const locale = deps.locale(req, session);
    const t = getDownTexts(locale);
    return htmlResponse(
      503,
      req.method.toUpperCase(),
      renderPanelHtmlPage(locale, t.downTitle, t.downBody, t.backToDatabases, siteId),
    );
  };

  // Renders a localized panel status page for page loads or an empty no-store status otherwise.
  const renderStatusPage = (
    status: number,
    texts: Record<"it" | "en", { title: string; body: string }>,
    req: Request,
    session: SessionData | null,
    siteId: string,
  ): Response => {
    if (!isPageLoad(req)) {
      return noStoreResponse(status);
    }
    const locale = deps.locale(req, session);
    const t = getDownTexts(locale);
    const copy = texts[locale];
    return htmlResponse(
      status,
      req.method.toUpperCase(),
      renderPanelHtmlPage(locale, copy.title, copy.body, t.backToDatabases, siteId),
    );
  };

  // Creates an idempotent slot release handle that hands off queued waiters in FIFO order.
  const makeSlotRelease = (siteId: string): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const state = siteConcurrency.get(siteId);
      if (!state) return;
      const nextWaiter = state.waiters.shift();
      if (nextWaiter) {
        nextWaiter.resolve({ status: "acquired", release: makeSlotRelease(siteId) });
        return;
      }
      state.inFlight -= 1;
      if (state.inFlight <= 0 && state.waiters.length === 0) {
        siteConcurrency.delete(siteId);
      }
    };
  };

  // Acquires one of a site's 2 upstream slots or waits up to 30s in FIFO order.
  const acquireSiteSlot = (siteId: string, signal?: AbortSignal): Promise<SiteSlotResult> => {
    if (signal?.aborted) {
      return Promise.resolve({ status: "aborted" });
    }
    let state = siteConcurrency.get(siteId);
    if (!state) {
      state = { inFlight: 0, waiters: [] };
      siteConcurrency.set(siteId, state);
    }
    if (state.inFlight < SITE_MAX_IN_FLIGHT && state.waiters.length === 0) {
      state.inFlight += 1;
      return Promise.resolve({ status: "acquired", release: makeSlotRelease(siteId) });
    }

    return new Promise<SiteSlotResult>((resolve) => {
      let settled = false;

      const finishWaiter = (result: SiteSlotResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(waitTimer);
        signal?.removeEventListener("abort", onAbort);
        const current = siteConcurrency.get(siteId);
        if (current) {
          const idx = current.waiters.indexOf(waiter);
          if (idx !== -1) {
            current.waiters.splice(idx, 1);
          }
          if (current.inFlight <= 0 && current.waiters.length === 0) {
            siteConcurrency.delete(siteId);
          }
        }
        resolve(result);
      };

      const waiter: SiteWaiter = {
        resolve: (result) => finishWaiter(result),
      };
      const onAbort = () => finishWaiter({ status: "aborted" });
      const waitTimer = setTimeout(() => finishWaiter({ status: "timeout" }), SITE_QUEUE_WAIT_MS);

      state.waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  };

  const refuseSession = (req: Request): Response => {
    if (isPageLoad(req)) {
      return noStoreResponse(303, { Location: "/login" });
    }
    return noStoreResponse(401);
  };

  const refusePmaCookie = (req: Request, siteId: string, clearCookie: boolean): Response => {
    const headers: Record<string, string> = {};
    if (clearCookie) {
      headers["Set-Cookie"] = clearPmaCookieHeader(siteId, deps.secureCookies);
    }
    if (isPageLoad(req)) {
      headers["Location"] = `/sites/${encodeURIComponent(siteId)}/database`;
      return noStoreResponse(303, headers);
    }
    return noStoreResponse(401, headers);
  };

  return async (req: Request, siteId: string, path: string[]): Promise<Response> => {
    // 1. Validate siteId shape
    if (!SITE_ID_RE.test(siteId)) {
      return noStoreResponse(404);
    }

    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return noStoreResponse(404);
    }

    const prefix = pmaPrefix(siteId);
    const method = req.method.toUpperCase();

    // 2. Empty rest path without trailing slash redirects to /phpmyadmin/<siteId>/
    if (path.length === 0 && !url.pathname.endsWith("/")) {
      return noStoreResponse(308, { Location: `${prefix}${url.search}` });
    }

    // 3. Validate and decode path segments
    const restPath = validateAndBuildRestPath(url, siteId, path);
    if (restPath === null) {
      return noStoreResponse(404);
    }

    // 4. Panel session required
    const session = await deps.readSession(req);
    if (!session) {
      return refuseSession(req);
    }

    // 5. Same-origin check on any method other than GET/HEAD
    if (method !== "GET" && method !== "HEAD") {
      if (!isSameOrigin(req, url)) {
        return noStoreResponse(403);
      }
    }

    if (!ALLOWED_METHODS.has(method)) {
      return noStoreResponse(405, { Allow: "GET, HEAD, POST" });
    }

    // 6. Open and bind hp_pma cookie
    const { rawPmaToken, upstreamCookieHeader } = parseInboundCookies(req.headers.get("cookie"));
    if (rawPmaToken === null) {
      return refusePmaCookie(req, siteId, false);
    }

    let decodedPmaToken: string;
    try {
      decodedPmaToken = decodeURIComponent(rawPmaToken);
    } catch {
      return refusePmaCookie(req, siteId, true);
    }

    const pmaPayload = await openPmaCookie(deps.cookieKey, decodedPmaToken, new Date(nowFn()));
    if (!pmaPayload) {
      return refusePmaCookie(req, siteId, true);
    }

    if (pmaPayload.siteId !== siteId) {
      return noStoreResponse(404);
    }

    if (!SITE_ID_RE.test(pmaPayload.orgId)) {
      return refusePmaCookie(req, siteId, true);
    }

    const expectedSid = sessionBindingId(session);
    if (pmaPayload.sid !== expectedSid) {
      return refusePmaCookie(req, siteId, true);
    }

    // 7. Verify site access right against the API (cached 30 s per session+site on 204 only)
    const tokenHash = createHash("sha256").update(session.accessToken).digest("hex");
    const cacheKey = `${tokenHash}:${expectedSid}:${pmaPayload.orgId}:${siteId}`;
    const nowMs = nowFn();
    const cachedUntil = rightsCache.get(cacheKey);
    const hasCachedAccess = cachedUntil !== undefined && nowMs < cachedUntil;

    if (!hasCachedAccess) {
      if (cachedUntil !== undefined) {
        rightsCache.delete(cacheKey);
      }
      const apiUrl = `${apiBase}/v1/organizations/${encodeURIComponent(pmaPayload.orgId)}/managed-sites/${encodeURIComponent(siteId)}/databases/phpmyadmin`;
      const apiController = new AbortController();
      const apiTimer = setTimeout(() => apiController.abort(new Error("API check timeout")), API_RIGHTS_TIMEOUT_MS);
      const apiSignal = req.signal
        ? AbortSignal.any([req.signal, apiController.signal])
        : apiController.signal;

      let apiRes: Response;
      try {
        apiRes = await fetchFn(apiUrl, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${session.accessToken}`,
            Accept: "application/json",
          },
          cache: "no-store",
          redirect: "error",
          signal: apiSignal,
        });
      } catch {
        return renderDownPage(req, session, siteId);
      } finally {
        clearTimeout(apiTimer);
      }

      if (apiRes.status === 204) {
        if (rightsCache.size >= RIGHTS_CACHE_MAX_ENTRIES) {
          const oldestKey = rightsCache.keys().next().value;
          if (oldestKey !== undefined) {
            rightsCache.delete(oldestKey);
          }
        }
        rightsCache.set(cacheKey, nowFn() + RIGHTS_CACHE_TTL_MS);
      } else if (apiRes.status === 401) {
        return refuseSession(req);
      } else if (apiRes.status === 403 || apiRes.status === 404) {
        return renderStatusPage(404, NO_ACCESS_TEXTS, req, session, siteId);
      } else {
        return renderDownPage(req, session, siteId);
      }
    }

    // 8. Reserve one of the site's 2 worker slots, then forward to phpMyAdmin
    const slot = await acquireSiteSlot(siteId, req.signal);
    if (slot.status === "timeout") {
      return renderStatusPage(503, BUSY_TEXTS, req, session, siteId);
    }
    if (slot.status === "aborted") {
      return noStoreResponse(503);
    }

    const upstreamHeaders = new Headers();
    for (const headerName of FORWARDED_CLIENT_HEADERS) {
      const value = req.headers.get(headerName);
      if (value !== null) {
        upstreamHeaders.set(headerName, value);
      }
    }
    const basicToken = Buffer.from(
      `${pmaPayload.username}:${pmaPayload.password}`,
      "utf8",
    ).toString("base64");
    upstreamHeaders.set("authorization", `Basic ${basicToken}`);
    upstreamHeaders.set("accept-encoding", "identity");
    upstreamHeaders.set("x-forwarded-prefix", prefix);
    upstreamHeaders.set("x-forwarded-proto", deps.secureCookies ? "https" : "http");
    if (upstreamCookieHeader !== null) {
      upstreamHeaders.set("cookie", upstreamCookieHeader);
    }

    const hasBody = method !== "GET" && method !== "HEAD" && req.body !== null;
    const fetchInit: RequestInit & { duplex?: "half" } = {
      method,
      headers: upstreamHeaders,
      redirect: "manual",
      cache: "no-store",
      ...(hasBody ? { body: req.body, duplex: "half" as const } : {}),
    };

    let fetchPromise: Promise<Response>;
    try {
      fetchPromise = Promise.resolve(upstreamFetchFn(`${upstreamBase}${restPath}${url.search}`, fetchInit));
    } catch (err) {
      fetchPromise = Promise.reject(err);
    }

    const headerOutcome = await waitForUpstreamHeaders(fetchPromise, req.signal, (lateRes) => {
      if (!lateRes || isImmediateReleaseResponse(lateRes, method)) {
        void lateRes?.body?.cancel().catch(() => {});
        slot.release();
        return;
      }
      drainReaderToEnd(lateRes.body!.getReader(), slot.release);
    });

    if (headerOutcome.status === "rejected") {
      slot.release();
      return renderDownPage(req, session, siteId);
    }
    if (headerOutcome.status === "detached") {
      // Request to phpMyAdmin stays running and retains its slot until it finishes or fails.
      return renderStatusPage(503, STILL_WORKING_TEXTS, req, session, siteId);
    }

    const upstreamRes = headerOutcome.response;

    // 9. Shape the response
    if (upstreamRes.status === 401) {
      void upstreamRes.body?.cancel().catch(() => {});
      slot.release();
      const locale = deps.locale(req, session);
      const t = getDownTexts(locale);
      const ended = ENDED_TEXTS[locale];
      return htmlResponse(
        401,
        method,
        renderPanelHtmlPage(locale, ended.title, ended.body, t.backToDatabases, siteId),
        { "Set-Cookie": clearPmaCookieHeader(siteId, deps.secureCookies) },
      );
    }

    const dynamicHopHeaders = collectConnectionHeaders(upstreamRes.headers);
    const outHeaders = new Headers();

    upstreamRes.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (
        lower === "set-cookie" ||
        lower === "www-authenticate" ||
        lower === "content-encoding" ||
        lower === "content-length" ||
        HOP_BY_HOP_HEADERS.has(lower) ||
        dynamicHopHeaders.has(lower)
      ) {
        return;
      }
      if (lower === "location") {
        outHeaders.set("location", sanitizeLocation(value, prefix, restPath));
        return;
      }
      outHeaders.append(key, value);
    });

    for (const rawSetCookie of getRawSetCookies(upstreamRes.headers)) {
      const rewritten = rewriteSetCookie(rawSetCookie, prefix);
      if (rewritten !== null) {
        outHeaders.append("set-cookie", rewritten);
      }
    }

    if (!outHeaders.get("x-frame-options")?.trim()) {
      outHeaders.set("X-Frame-Options", "SAMEORIGIN");
    }

    const isNullBodyStatus =
      upstreamRes.status === 204 ||
      upstreamRes.status === 205 ||
      upstreamRes.status === 304 ||
      method === "HEAD";

    if (isNullBodyStatus) {
      void upstreamRes.body?.cancel().catch(() => {});
      slot.release();
      return new Response(null, {
        status: upstreamRes.status,
        headers: outHeaders,
      });
    }

    if (upstreamRes.body === null || REDIRECT_STATUSES.has(upstreamRes.status)) {
      slot.release();
      return new Response(upstreamRes.body, {
        status: upstreamRes.status,
        headers: outHeaders,
      });
    }

    return new Response(createMonitoredUpstreamBody(upstreamRes.body, slot.release), {
      status: upstreamRes.status,
      headers: outHeaders,
    });
  };
}
