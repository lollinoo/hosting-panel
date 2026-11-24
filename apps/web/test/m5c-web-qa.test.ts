// M5c QA (qa-web): black-box checks of Restart, the terminal page and their seven BFF routes.
import fs from "node:fs";
import path from "node:path";
import * as React from "react";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AdminHealthDtoSchema,
  AppTerminalSessionDtoSchema,
  OperationDtoSchema,
  PANEL_COMPONENTS,
  PANEL_CONTAINERS,
  TerminalReadDtoSchema,
  TerminalSessionDtoSchema,
  type AdminHealthDto,
} from "@hosting-panel/contracts";
import type { Messages } from "@/i18n";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { I18nProvider } from "@/i18n/provider";

const fetchUpstream = vi.fn();
const getSessionFromRequest = vi.fn();
const getServerSession = vi.fn();
const router = { push: vi.fn(), refresh: vi.fn() };

vi.mock("@/lib/upstream", async () => ({
  ...(await vi.importActual<object>("@/lib/upstream")),
  fetchUpstream: (...a: unknown[]) => fetchUpstream(...a),
}));
vi.mock("@/lib/server-session", () => ({
  getSessionFromRequest: (...a: unknown[]) => getSessionFromRequest(...a),
  getServerSession: (...a: unknown[]) => getServerSession(...a),
}));
vi.mock("@/i18n/server", () => ({ getRequestLocale: async () => "en" }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  useRouter: () => router,
  usePathname: () => "/admin/health",
}));

import AdminHealthPage from "@/app/admin/health/page";
import * as openMod from "@/app/api/admin/sites/[siteId]/terminal/route";
import * as writeMod from "@/app/api/admin/terminal/[sessionId]/write/route";
import * as readMod from "@/app/api/admin/terminal/[sessionId]/read/route";
import * as closeMod from "@/app/api/admin/terminal/[sessionId]/close/route";
import * as siteRestartMod from "@/app/api/admin/sites/[siteId]/restart/route";
import * as partRestartMod from "@/app/api/admin/panel-containers/[component]/restart/route";
import * as operationMod from "@/app/api/admin/operations/[operationId]/route";
import { RestartButton, RestartForm } from "@/components/admin/restart-dialog";
import { TerminalConsole, TerminalOutput } from "@/components/admin/terminal-console";
import { SiteActions } from "@/components/customer/site-actions";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { emptyText, feed, TERMINAL_LINE_MAX, TERMINAL_LINES_KEPT, type TerminalText } from "@/lib/terminal-text";
import { runReadLoop, terminalErrorText } from "@/lib/terminal-session";

const ROOT = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const SID = `term_${"0123456789abcdef".repeat(2)}`;
const SENTINEL = "SENTINEL-qa-7f3a";
// eslint-disable-next-line no-control-regex -- the test looks for control characters
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

const html = (m: Messages, child: ReactNode) =>
  renderToStaticMarkup(createElement(I18nProvider, { locale: m === en ? "en" : "it", messages: m, children: child }))
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"');

// Calls a client component once with a stand-in hook dispatcher, so its handlers can be run without a DOM.
const internals = (React as unknown as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE!;
function callHooks<P>(C: (p: P) => ReactNode, props: P, m: Messages, state: Record<number, unknown> = {}, refs: Record<number, unknown> = {}) {
  let s = 0;
  let r = 0;
  const sets: Array<[number, unknown]> = [];
  const ctx = { locale: m === en ? "en" : "it", messages: m };
  const prev = internals.H;
  internals.H = {
    useState: (v: unknown) => {
      const k = s++;
      return [k in state ? state[k] : typeof v === "function" ? (v as () => unknown)() : v, (x: unknown) => void sets.push([k, x])];
    },
    useRef: (v: unknown) => {
      const k = r++;
      return k in refs ? refs[k] : { current: v };
    },
    useCallback: (f: unknown) => f,
    useMemo: (f: () => unknown) => f(),
    useEffect: () => {},
    useLayoutEffect: () => {},
    useContext: () => ctx,
    use: () => ctx,
    useId: () => "qa-id",
  };
  try {
    return { tree: C(props), sets };
  } finally {
    internals.H = prev;
  }
}
type El = ReactElement<Record<string, unknown>>;
const els = (node: unknown): El[] => {
  if (Array.isArray(node)) return node.flatMap(els);
  if (!isValidElement(node)) return [];
  return [node as El, ...els((node.props as Record<string, unknown>).children)];
};
const textOf = (node: unknown): string =>
  typeof node === "string" || typeof node === "number" ? String(node)
    : Array.isArray(node) ? node.map(textOf).join("")
    : isValidElement(node) ? textOf((node.props as Record<string, unknown>).children) : "";
const button = (tree: ReactNode, name: string) => els(tree).find((e) => e.type === Button && (e.props["aria-label"] === name || textOf(e) === name));
const ev = { preventDefault() {} };

const fetchMock = vi.fn();
type Answer = { status: number; body?: unknown } | Error;
const answer = (a: Answer) => {
  if (a instanceof Error) throw a;
  return new Response(a.body === undefined ? null : JSON.stringify(a.body), { status: a.status, headers: { "Content-Type": "application/json" } });
};
const err = (code: string, details: unknown[] = []) => ({ error: { code, message: "m", requestId: "r", retryable: false, details } });

beforeEach(() => {
  fetchUpstream.mockReset();
  getSessionFromRequest.mockReset().mockResolvedValue({ accessToken: "tok-sentinel", csrfToken: "csrf" });
  getServerSession.mockReset().mockResolvedValue({ accessToken: "tok-sentinel", csrfToken: "csrf" });
  fetchMock.mockReset();
  router.refresh.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------
describe("1. the text rule on what a real shell printed", () => {
  const capture = JSON.parse(read("test/fixtures/m5c-terminal-capture.json")) as { image: string; blocks: Array<{ in: string; out: string }> };
  const outs = capture.blocks.map((b) => new TextDecoder().decode(Buffer.from(b.out, "base64")));
  const whole = outs.join("");
  const final = (s: TerminalText) => ({ lines: s.lines, current: s.current, col: s.col, pending: s.pending, base: s.base });

  it("the fixture is the capture of the pinned image, blocks only", () => {
    expect(Object.keys(capture)).toEqual(["image", "blocks"]);
    expect(capture.image).toMatch(/^wordpress:[\w.-]+$/);
    expect(capture.blocks).toHaveLength(12);
    for (const b of capture.blocks) expect(Object.keys(b)).toEqual(["in", "out"]);
  });

  it("whole, block by block and cut in two at every position give the same lines", () => {
    const one = final(feed(emptyText(), whole));
    expect(final(outs.reduce((s, o) => feed(s, o), emptyText()))).toEqual(one);
    for (let i = 0; i <= whole.length; i++) expect(final(feed(feed(emptyText(), whole.slice(0, i)), whole.slice(i))), `cut at ${i}`).toEqual(one);
  });

  it("the lines are what the administrator saw, with no control character", () => {
    const s = feed(emptyText(), whole);
    const L = s.lines;
    expect(feed(emptyText(), outs[0]!).current).toBe("/var/www/html $ ");
    expect(L).toContain("uid=33(www-data) gid=33(www-data) groups=33(www-data)");
    expect(L).toContain("/bin/sh: 2: nosuchcmd_xyz: not found");
    expect(L).toContain("a".repeat(120));
    expect(L).toContain("/tmp  wp-admin");
    expect(L).toContain("red bold");
    expect(L).toContain("tab     x");
    expect(L).toContain("ac");
    expect(L).toContain("two");
    expect(L).toContain("bell");
    expect(L).toContain("città €");
    expect(L).toContain("^C");
    expect(L.at(-1)).toBe("/var/www/html $ ");
    expect(s.current).toBe("");
    for (const l of L) expect(l, JSON.stringify(l)).not.toMatch(CONTROL);
    // ls columns: every row's second and third names start at the same column once tabs are spaces.
    const rows = L.slice(L.indexOf("/var/www/html $ ls") + 1, L.indexOf("/var/www/html $ ls --color=auto -d /tmp wp-admin"));
    expect(rows).toHaveLength(5);
    const col2 = rows.map((r) => r.search(/ wp-[a-z-]+\.php| wp-content| wp-includes/) + 1);
    const col3 = rows.map((r) => r.lastIndexOf(" ", r.trimEnd().lastIndexOf("  ") + 2) + 1);
    expect(new Set(col2).size).toBe(1);
    expect(new Set(col3).size).toBe(1);
    expect(rows[0]).toMatch(/^index\.php {8}wp-blog-header\.php {4}wp-cron\.php {8}wp-mail\.php$/);
  });
});

// ---------------------------------------------------------------------------------------------
describe("2. hostile output is text", () => {
  it("markup, attributes and entities in output are rendered as text", () => {
    const text = feed(emptyText(), `<img src=x onerror=alert(1)>\r\n"><script>alert(2)</script>\r\n&amp; &lt;b&gt;\r\n<svg onload=alert(3)>`);
    const h = renderToStaticMarkup(createElement(TerminalOutput, { text, label: "out" }));
    expect(h).not.toMatch(/<img|<script|<svg/);
    expect(h).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(h).toContain("&quot;&gt;&lt;script&gt;");
    expect(h).toContain("&amp;amp; &amp;lt;b&amp;gt;");
    expect(h).toContain("&lt;svg onload=alert(3)&gt;");
  });

  it("no M5c file of apps/web/src builds markup from strings", () => {
    for (const f of M5C_SOURCES) expect(read(f), f).not.toMatch(/dangerouslySetInnerHTML|innerHTML|__html|outerHTML|insertAdjacentHTML/);
  });

  it("a line of 100 000 characters and 5000 lines keep the rule, and the page says older lines were dropped", () => {
    const big = `${"x".repeat(100_000)}\r\n${Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\r\n")}\r\n`;
    for (const s of [feed(emptyText(), big), Array.from({ length: 50 }, (_, i) => big.slice(i * Math.ceil(big.length / 50), (i + 1) * Math.ceil(big.length / 50))).reduce((t, c) => feed(t, c), emptyText())]) {
      expect(s.lines.length).toBe(TERMINAL_LINES_KEPT);
      expect(s.lines.every((l) => l.length <= TERMINAL_LINE_MAX)).toBe(true);
      expect(s.lines.at(-1)).toBe("line 4999");
      expect(s.base + s.lines.length).toBe(100 + 5000);
      expect(s.dropped).toBe(true);
    }
    for (const m of [en, itMsgs]) {
      const { tree } = callHooks(TerminalConsole, { siteId: "s1", csrfToken: "csrf" }, m, { 0: "open", 4: feed(emptyText(), big) });
      expect(html(m, tree)).toContain(m.admin.terminal.dropped);
    }
  });
});

// ---------------------------------------------------------------------------------------------
const M5C_SOURCES = [
  "src/lib/terminal-text.ts",
  "src/lib/terminal-session.ts",
  "src/lib/admin-restart.ts",
  "src/lib/keyed-send.ts",
  "src/components/admin/terminal-console.tsx",
  "src/components/admin/restart-dialog.tsx",
  "src/app/admin/health/page.tsx",
  "src/app/admin/sites/[siteId]/terminal/page.tsx",
  "src/app/admin/apps/[stackId]/terminal/[componentKey]/page.tsx",
  "src/app/api/admin/sites/[siteId]/terminal/route.ts",
  "src/app/api/admin/app-stacks/[stackId]/components/[componentKey]/terminal/route.ts",
  "src/app/api/admin/terminal/[sessionId]/write/route.ts",
  "src/app/api/admin/terminal/[sessionId]/read/route.ts",
  "src/app/api/admin/terminal/[sessionId]/close/route.ts",
  "src/app/api/admin/sites/[siteId]/restart/route.ts",
  "src/app/api/admin/panel-containers/[component]/restart/route.ts",
  "src/app/api/admin/operations/[operationId]/route.ts",
];

describe("3. what is typed and printed stays on the page", () => {
  it("no M5c file logs, stores, or puts anything in a query string", () => {
    for (const f of M5C_SOURCES) {
      const src = read(f);
      for (const bad of ["console.", "localStorage", "sessionStorage", "document.cookie", "indexedDB", "caches.", "navigator.sendBeacon", "URLSearchParams", "searchParams"])
        expect(src, `${f} has ${bad}`).not.toContain(bad);
      for (const url of src.match(/`\/api\/[^`]*`/g) ?? []) expect(url, f).not.toContain("?");
    }
  });

  it("the code travels in the body of a POST, never in the address, and the field is cleared after it is sent", async () => {
    for (const status of [401, 201]) {
      fetchMock.mockReset();
      fetchMock.mockImplementation(async (url: string) =>
        url.endsWith("/read")
          ? answer({ status: 200, body: { data: { output: "", cursor: 0, dropped: false, ended: { reason: "shell_exited", at: "2026-11-17T10:00:00Z" } } } })
          : answer(status === 201
            ? { status, body: { data: { sessionId: SID, siteId: "s1", containerName: "hp_site_s1", openedAt: "2026-11-17T10:00:00Z", expiresAt: "2026-11-17T10:30:00Z" } } }
            : { status, body: err("TOTP_INVALID") }));
      const { tree, sets } = callHooks(TerminalConsole, { siteId: "s1", csrfToken: "csrf" }, en, { 1: "975310" });
      const form = els(tree).find((e) => e.type === "form")!;
      await (form.props.onSubmit as (e: unknown) => Promise<void>)(ev);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("/api/admin/sites/s1/terminal");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({ code: "975310" });
      for (const [u] of fetchMock.mock.calls as Array<[string]>) expect(u).not.toContain("975310");
      expect(sets).toContainEqual([1, ""]);
      if (status === 401) expect(sets).toContainEqual([2, en.admin.terminal.errors.TOTP_INVALID]);
      else expect(sets).toContainEqual([2, en.admin.terminal.ended.shell_exited]);
    }
    const codeField = els(callHooks(TerminalConsole, { siteId: "s1", csrfToken: "csrf" }, en).tree).find((e) => e.props.id === "terminal-code")!;
    expect(codeField.props.type ?? "text").not.toBe("password");
    expect(codeField.props.autoComplete).toBe("one-time-code");
  });

  it("each input travels in the body of a POST to the session's write route, in order", async () => {
    fetchMock.mockImplementation(async () => answer({ status: 204 }));
    const live = { current: { id: SID, abort: new AbortController() } };
    const { tree } = callHooks(TerminalConsole, { siteId: "s1", csrfToken: "csrf" }, en, { 0: "open", 5: `echo ${SENTINEL}` }, { 2: live });
    const forms = els(tree).filter((e) => e.type === "form");
    (forms.at(-1)!.props.onSubmit as (e: unknown) => void)(ev);
    (button(tree, en.admin.terminal.ctrlCLabel)!.props.onClick as () => void)();
    (button(tree, en.admin.terminal.ctrlDLabel)!.props.onClick as () => void)();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
    expect(calls.map(([u]) => u)).toEqual(Array(3).fill(`/api/admin/terminal/${SID}/write`));
    expect(calls.map(([, i]) => JSON.parse(i.body as string))).toEqual([{ input: `echo ${SENTINEL}\n` }, { input: "\u0003" }, { input: "\u0004" }]);
    for (const [, i] of calls) expect(i.method).toBe("POST");
  });

  it("the BFF routes write nothing of a body or an answer to the console", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    fetchUpstream.mockResolvedValue({ ok: false, status: 500, error: err("INTERNAL_ERROR", [{ message: SENTINEL }]) });
    for (const r of ROUTES) await call(r, { body: { input: SENTINEL, code: "975310", reason: SENTINEL, cursor: 0 } });
    fetchUpstream.mockResolvedValue({ ok: true, status: 200, data: { data: { output: SENTINEL, cursor: 1, dropped: false, ended: null } } });
    await call(ROUTES[2]!, { body: { cursor: 0 } });
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------
type Route = { name: string; mod: Record<string, unknown>; method: "GET" | "POST"; param: string; good: string; upstream: string; timeoutMs: number; keyed: boolean };
const ROUTES: Route[] = [
  { name: "open", mod: openMod, method: "POST", param: "siteId", good: "site_a1", upstream: "v1/admin/sites/site_a1/terminal", timeoutMs: 40000, keyed: false },
  { name: "write", mod: writeMod, method: "POST", param: "sessionId", good: SID, upstream: `v1/admin/terminal/${SID}/write`, timeoutMs: 8000, keyed: false },
  { name: "read", mod: readMod, method: "POST", param: "sessionId", good: SID, upstream: `v1/admin/terminal/${SID}/read`, timeoutMs: 40000, keyed: false },
  { name: "close", mod: closeMod, method: "POST", param: "sessionId", good: SID, upstream: `v1/admin/terminal/${SID}/close`, timeoutMs: 8000, keyed: false },
  { name: "site restart", mod: siteRestartMod, method: "POST", param: "siteId", good: "site_a1", upstream: "v1/admin/sites/site_a1/restart", timeoutMs: 8000, keyed: true },
  { name: "panel restart", mod: partRestartMod, method: "POST", param: "component", good: "sftp", upstream: "v1/admin/panel-containers/sftp/restart", timeoutMs: 8000, keyed: true },
  { name: "operation", mod: operationMod, method: "GET", param: "operationId", good: "op_1", upstream: "v1/admin/operations/op_1", timeoutMs: 8000, keyed: false },
];
async function call(r: Route, o: { value?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  const headers: Record<string, string> = { Host: "localhost:3000", Origin: "http://localhost:3000", "X-CSRF-Token": "csrf", "Content-Type": "application/json", ...(r.keyed ? { "Idempotency-Key": "key-1" } : {}), ...o.headers };
  for (const [k, v] of Object.entries(headers)) if (v === "") delete headers[k];
  const req = new Request("http://localhost:3000/api/x", { method: r.method, headers, body: r.method === "GET" ? undefined : JSON.stringify(o.body ?? { reason: "r", cursor: 0 }) });
  const handler = r.mod[r.method] as (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
  return handler(req, { params: Promise.resolve({ [r.param]: o.value ?? r.good }) });
}

describe("4. nothing from the address reaches upstream unchecked", () => {
  const bad: Record<string, string[]> = {
    sessionId: [`${SID}0`, `term_${"0123456789ABCDEF".repeat(2)}`, "../x", "%2e%2e", `term_${"0".repeat(31)}`, `TERM_${"0".repeat(32)}`, `term_${"0".repeat(32)}/../x`, "", "term_"],
    component: ["api", "web", "database", "executor", "host_agent", "docker_engine", "SFTP", "sftp ", "../sftp", "%2e%2e", "__proto__", "constructor", ""],
    siteId: ["a.b", "../x", "%2e%2e", "a/b", "x".repeat(129), "", "s 1", "<script>"],
    operationId: ["a.b", "../x", "%2e%2e", "a/b", "x".repeat(129), "", "op?x=1"],
  };

  it.each(ROUTES.map((r) => [r.name, r] as const))("%s: a parameter of a wrong shape is 400 and no upstream call is made", async (_n, r) => {
    for (const v of bad[r.param]!) expect((await call(r, { value: v })).status, `${r.param}=${v}`).toBe(400);
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it.each(ROUTES.map((r) => [r.name, r] as const))("%s: no session 401; no CSRF token or another origin 403; nothing upstream", async (_n, r) => {
    if (r.method === "POST") {
      for (const h of <Array<Record<string, string>>>[{ "X-CSRF-Token": "" }, { "X-CSRF-Token": "other" }, { Origin: "http://evil.example.test" }, { Origin: "null" }])
        expect((await call(r, { headers: h })).status, JSON.stringify(h)).toBe(403);
    }
    getSessionFromRequest.mockResolvedValue(null);
    expect((await call(r)).status).toBe(401);
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it.each(ROUTES.map((r) => [r.name, r] as const))("%s: serves only its own method and forwards only to its own path, with its time limit", async (_n, r) => {
    expect(Object.keys(r.mod).filter((k) => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(k))).toEqual([r.method]);
    fetchUpstream.mockResolvedValue({ ok: true, status: 200, data: { data: {} } });
    await call(r);
    expect(fetchUpstream).toHaveBeenCalledTimes(1);
    const [p, opts] = fetchUpstream.mock.calls[0] as [string, { method: string; timeoutMs?: number; idempotencyKey?: string; accessToken?: string }];
    expect(p).toBe(r.upstream);
    expect(opts.method).toBe(r.method);
    expect(opts.timeoutMs ?? 8000).toBe(r.timeoutMs);
    expect(opts.accessToken).toBe("tok-sentinel");
    if (r.keyed) expect(opts.idempotencyKey).toBe("key-1");
  });

  it.each(ROUTES.map((r) => [r.name, r] as const))("%s: an upstream error keeps its status, code and details", async (_n, r) => {
    const e = err("RESOURCE_LOCKED", [{ message: "m", reason: "site_busy" }]);
    fetchUpstream.mockResolvedValue({ ok: false, status: 409, error: e });
    const res = await call(r);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(e);
  });

  it("the upstream default limit the restart routes rely on is 8 s", () => {
    expect(read("src/lib/upstream.ts")).toContain("AbortSignal.timeout(options.timeoutMs ?? 8000)");
  });
});

// ---------------------------------------------------------------------------------------------
describe("5. the time limits of the read loop", () => {
  it("a read that hits the BFF limit after 40 s ends as lost at once, with the sentence that says what to do", async () => {
    let t = 0;
    const retries: number[] = [];
    const end = await runReadLoop({
      sessionId: SID, csrfToken: "c", signal: new AbortController().signal,
      fetch: (async () => { t += 40_000; return answer({ status: 504, body: err("INTERNAL_ERROR") }); }) as unknown as typeof fetch,
      sleep: async (ms) => void (t += ms), now: () => t, onRead: () => {}, onRetry: () => retries.push(t),
    });
    expect(end).toEqual({ reason: "lost" });
    expect(retries).toEqual([]);
    expect(en.admin.terminal.ended.lost).toMatch(/enter a new code/);
  });

  it("a read the browser never gets an answer to counts as lost after 40 s", async () => {
    vi.useFakeTimers();
    const ctl = new AbortController();
    const hang = (_u: unknown, init: RequestInit) => new Promise<Response>((_r, rej) => init.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
    let done: unknown = "pending";
    void runReadLoop({ sessionId: SID, csrfToken: "c", signal: ctl.signal, fetch: hang as unknown as typeof fetch, onRead: () => {}, onRetry: () => {} }).then((v) => (done = v));
    await vi.advanceTimersByTimeAsync(45_000);
    const seen = done;
    ctl.abort();
    expect(seen).toEqual({ reason: "lost" });
  });

  it("the console shows reconnecting as a status while it retries", () => {
    for (const m of [en, itMsgs]) {
      const { tree } = callHooks(TerminalConsole, { siteId: "s1", csrfToken: "csrf" }, m, { 0: "open", 7: true });
      expect(html(m, tree)).toContain(`<p role="status" class="text-sm">${m.admin.terminal.reconnecting}</p>`);
    }
  });
});

// ---------------------------------------------------------------------------------------------
const enNext = /\b(try|enter|check|use|wait|close|go back|reload|sign in|set it up|send|start)\b/i;
const itNext = /(riprova|inserisci|controlla|usa|aspetta|chiud|torna|ricarica|accedi|configura|manda|invia|avvia)/i;
const site = (desired: "running" | "stopped") => ({ kind: "site" as const, siteId: "s1", siteName: "wp-a.example.test", desired });

describe("6. Restart asks before it acts", () => {
  it("the dialog is not sent with an empty reason or one of spaces; the reason is sent trimmed", async () => {
    for (const m of [en, itMsgs]) {
      for (const reason of ["", "   ", "\n\t  "]) {
        const onConfirm = vi.fn(async () => null);
        const { tree, sets } = callHooks(RestartForm, { target: site("running"), onConfirm, onCancel: () => {} }, m, { 0: reason });
        await (els(tree).find((e) => e.type === "form")!.props.onSubmit as (e: unknown) => Promise<void>)(ev);
        expect(onConfirm).not.toHaveBeenCalled();
        expect(sets).toContainEqual([2, m.admin.health.restart.reasonRequired]);
      }
      const onConfirm = vi.fn(async () => null);
      const { tree } = callHooks(RestartForm, { target: site("running"), onConfirm, onCancel: () => {} }, m, { 0: "  disk full  " });
      await (els(tree).find((e) => e.type === "form")!.props.onSubmit as (e: unknown) => Promise<void>)(ev);
      expect(onConfirm).toHaveBeenCalledWith("disk full");
    }
  });

  it("each of the six warnings says in both languages what stops and for whom; a stopped site adds R192 2.3", () => {
    const who: Record<string, [RegExp, RegExp]> = {
      site: [/stops answering.*(page|upload)/, /smette di rispondere.*(pagina|upload)/],
      ingress_proxy: [/every site.*panel stop/i, /tutti i siti.*pannello smettono/i],
      shared_database: [/every site's database stops.*sites show/i, /database di ogni sito si ferma.*siti mostrano/i],
      phpmyadmin: [/phpmyadmin stops.*anyone using it/i, /phpmyadmin si ferma.*chi lo sta usando/i],
      sftp: [/sftp stops.*connections are cut/i, /sftp si ferma.*connessioni sftp aperte/i],
      mail_relay: [/outgoing mail stops.*mail a site sends/i, /posta in uscita si ferma.*posta che un sito invia/i],
    };
    for (const [i, m] of [en, itMsgs].entries()) {
      const w = m.admin.health.restart.warn;
      expect(w.site).toMatch(who.site![i]!);
      for (const c of PANEL_CONTAINERS) expect(w[c], `${c}`).toMatch(who[c]![i]!);
      const r = (desired: "running" | "stopped") =>
        html(m, createElement(Dialog, { open: true }, createElement(RestartForm, { target: site(desired), onConfirm: async () => null, onCancel: () => {} })));
      const stopped = w.siteStopped.replace("{name}", "wp-a.example.test");
      expect(r("stopped")).toContain(stopped);
      expect(r("running")).not.toContain(stopped);
    }
    expect(en.admin.health.restart.warn.siteStopped).toBe("{name} was stopped on purpose: restarting it starts it again, and it stays running until someone stops it.");
    expect(itMsgs.admin.health.restart.warn.siteStopped).toBe("{name} è stato fermato di proposito: riavviarlo lo fa ripartire, e resta attivo finché qualcuno non lo ferma.");
  });

  it("the Health page gives every site row its wanted state, so a stopped site's dialog warns that it starts again", async () => {
    const T = "2026-11-17T10:00:00Z";
    const h: AdminHealthDto = AdminHealthDtoSchema.parse({
      generatedAt: T,
      components: PANEL_COMPONENTS.map((component) => ({ component, state: component === "sftp" ? "not_in_use" : "ok", reason: null, observedAt: T })),
      siteContainers: (["stopped", "running"] as const).map((desired, i) => ({
        siteId: `s${i}`, siteName: `wp-${i}.example.test`, organizationName: null, desired, observed: "stopped",
        driftReason: null, restartCount: 0, observedAt: T, stale: false,
      })),
      disks: [],
      hostServices: null,
    });
    fetchUpstream.mockImplementation(async (p: string) => ({ ok: true, status: 200, data: { data: p === "v1/admin/health" ? h : [] } }));
    const targets = els(await AdminHealthPage()).filter((e) => e.type === RestartButton).map((e) => e.props.target);
    expect(targets).toContainEqual({ kind: "site", siteId: "s0", siteName: "wp-0.example.test", desired: "stopped" });
    expect(targets).toContainEqual({ kind: "site", siteId: "s1", siteName: "wp-1.example.test", desired: "running" });
    expect(targets).not.toContainEqual({ kind: "part", component: "sftp" });
    expect(targets.filter((t) => (t as { kind: string }).kind === "part")).toHaveLength(4);
  });

  const part = { kind: "part" as const, component: "sftp" as const };
  const refusals: Array<[string, Answer, (m: Messages) => string]> = [
    ["VALIDATION_ERROR", { status: 400, body: err("VALIDATION_ERROR") }, (m) => m.admin.health.restart.reasonRequired],
    ["NOT_FOUND", { status: 404, body: err("NOT_FOUND") }, (m) => m.admin.health.restart.notFound.replace("{name}", m.admin.health.components.sftp)],
    ["RESOURCE_LOCKED", { status: 409, body: err("RESOURCE_LOCKED") }, (m) => m.admin.health.restart.locked.replace("{name}", m.admin.health.components.sftp)],
    ["PANEL_CONTAINER_ABSENT", { status: 409, body: err("PANEL_CONTAINER_ABSENT") }, (m) => m.admin.health.restart.absent.replace("{name}", m.admin.health.components.sftp)],
    ["RATE_LIMITED", { status: 429, body: err("RATE_LIMITED") }, (m) => m.errors.RATE_LIMITED],
    ["500", { status: 500, body: err("INTERNAL_ERROR") }, (m) => m.errors.INTERNAL_ERROR],
    ["500 without a body", { status: 500 }, (m) => m.errors.generic],
    ["broken connection", new TypeError("fetch failed"), (m) => m.errors.generic],
  ];

  it.each(refusals)("a refusal (%s) ends in a sentence with a next step and the dialog stays open", async (_n, a, want) => {
    for (const [m, re] of [[en, enNext], [itMsgs, itNext]] as const) {
      fetchMock.mockReset().mockImplementation(async () => answer(a));
      const { tree, sets } = callHooks(RestartButton, { target: part, csrfToken: "csrf" }, m);
      const form = els(tree).find((e) => e.type === RestartForm)!;
      const said = await (form.props.onConfirm as (r: string) => Promise<string | null>)("disk full");
      expect(said).toBe(want(m));
      expect(said).toMatch(re);
      expect(sets).toEqual([]);
    }
  });

  it("the request carries the reason in its body, the CSRF token and an Idempotency-Key", async () => {
    fetchMock.mockImplementation(async () => answer({ status: 409, body: err("RESOURCE_LOCKED") }));
    const { tree } = callHooks(RestartButton, { target: site("stopped"), csrfToken: "csrf" }, en);
    await (els(tree).find((e) => e.type === RestartForm)!.props.onConfirm as (r: string) => Promise<string | null>)("disk full");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/admin/sites/s1/restart");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ reason: "disk full" });
    const h = init.headers as Record<string, string>;
    expect(h["X-CSRF-Token"]).toBe("csrf");
    expect(h["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it.each([
    ["succeeded", ["running", "succeeded"], 10_000, "done"],
    ["failed", ["running", "failed"], 10_000, "failed"],
    ["unknown", ["running"], 181_000, "unknown"],
  ] as const)("after 202 the row follows the operation to %s, with its own sentence as a status", async (want, statuses, ms, key) => {
    vi.useFakeTimers();
    let n = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return answer({ status: 202, body: { data: { component: "sftp", operationId: "op_1" } } });
      expect(url).toBe("/api/admin/operations/op_1");
      return answer({ status: 200, body: { data: { status: statuses[Math.min(n++, statuses.length - 1)] } } });
    });
    const { tree, sets } = callHooks(RestartButton, { target: part, csrfToken: "csrf" }, en);
    expect(await (els(tree).find((e) => e.type === RestartForm)!.props.onConfirm as (r: string) => Promise<string | null>)("disk full")).toBeNull();
    expect(sets).toEqual([[0, false], [1, "accepted"]]);
    await vi.advanceTimersByTimeAsync(ms);
    expect(sets.at(-1)).toEqual([1, want]);
    expect(router.refresh).toHaveBeenCalled();
    vi.useRealTimers();
    for (const m of [en, itMsgs]) {
      for (const [phase, sentence] of [["accepted", m.admin.health.restart.accepted], [want, m.admin.health.restart[key].replace("{name}", m.admin.health.components.sftp)]] as const) {
        const h = html(m, callHooks(RestartButton, { target: part, csrfToken: "csrf" }, m, { 1: phase }).tree);
        expect(h).toContain(`role="status" class="text-xs text-muted-foreground">${sentence}</p>`);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
type Leaf = [string, string];
const leaves = (o: unknown, p: string): Leaf[] =>
  typeof o === "string" ? [[p, o]] : Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => leaves(v, `${p}.${k}`));
const m5cTexts = (m: Messages): Leaf[] => [
  ...leaves(m.admin.health.restart, "admin.health.restart"),
  ...leaves(m.admin.terminal, "admin.terminal"),
  ["admin.health.colActions", m.admin.health.colActions],
  ["admin.health.siteContainerMissing", m.admin.health.siteContainerMissing],
  ["admin.health.alerts.site_container_down", m.admin.health.alerts.site_container_down],
  ["site.manage.phpStopped", m.site.manage.phpStopped],
];
const fill = (s: string) => s.replace(/\{(\w+)\}/g, (_x, k: string) => ({ name: "wp-a.example.test", site: "wp-a.example.test", time: "10:30", observed: "exited" })[k] ?? `{${k}}`);
const nextStep = [
  "admin.terminal.errors.", "admin.terminal.ended.", "admin.terminal.tooLong", "admin.terminal.writeFailed",
  "admin.health.restart.failed", "admin.health.restart.unknown", "admin.health.restart.reasonRequired", "admin.health.restart.absent",
  "admin.health.restart.locked", "admin.health.restart.notFound", "admin.health.siteContainerMissing", "admin.health.alerts.site_container_down", "site.manage.phpStopped",
];

describe("7. every sentence is understood by somebody who has never seen a server", () => {
  it("after filling placeholders: no brace, no key name, no undefined, in both languages", () => {
    const keyNames = m5cTexts(en).map(([k]) => k.split(".").at(-1)!).filter((k) => /_|[a-z][A-Z]/.test(k) && k !== "phpmyadmin");
    for (const m of [en, itMsgs]) {
      for (const [k, v] of m5cTexts(m)) {
        const f = fill(v);
        expect(f, k).not.toMatch(/[{}]|undefined|null|NaN|\[object/);
        expect(f.trim(), k).not.toBe("");
        for (const name of keyNames) expect(f, `${k} names ${name}`).not.toContain(name);
      }
    }
    expect(m5cTexts(en).map(([k]) => k)).toEqual(m5cTexts(itMsgs).map(([k]) => k));
  });

  it("the Italian text differs from the English one except for the key names Ctrl-C and Ctrl-D", () => {
    const itMap = new Map(m5cTexts(itMsgs));
    const same = m5cTexts(en).filter(([k, v]) => itMap.get(k) === v).map(([k]) => k);
    expect(same).toEqual(["admin.terminal.ctrlC", "admin.terminal.ctrlD"]);
  });

  it("every refusal and every way a session ends names what to do next", () => {
    for (const [m, re] of [[en, enNext], [itMsgs, itNext]] as const)
      for (const [k, v] of m5cTexts(m).filter(([k]) => nextStep.some((p) => k.startsWith(p)))) expect(v, k).toMatch(re);
  });

  it("the sentences name only buttons and pages the panel has", () => {
    for (const m of [en, itMsgs]) {
      const h = m.admin.health;
      // container_down, siteContainerMissing and site_container_down send the reader to Restart on a Health row.
      for (const s of [m.admin.terminal.errors.container_down, h.siteContainerMissing, h.alerts.site_container_down]) expect(s).toContain(h.restart.button);
      expect(m.admin.terminal.errors.container_down).toContain(m.admin.nav.health);
      expect(h.siteContainerMissing).toContain(h.sitesTitle);
      expect(h.alerts.site_container_down).toContain(h.sitesTitle);
      expect(h.siteContainerMissing).toContain(m.admin.nav.logs);
      expect(m.site.manage.phpStopped).toContain(m.site.manage.start);
    }
  });

  it("the customer's sentence holds no forbidden word and no admin text of M5c is in a customer section", () => {
    for (const m of [en, itMsgs]) expect(m.site.manage.phpStopped).not.toMatch(/docker|container|image|immagine|network|rete|volume|revision|revisione/i);
    const customer = [...walk("src/components/customer"), ...walk("src/app/sites"), ...walk("src/app/account")];
    expect(customer.length).toBeGreaterThan(5);
    for (const f of customer) expect(read(f), f).not.toMatch(/admin\.terminal|health\.restart|\/api\/admin\/(terminal|panel-containers|operations)|\/api\/admin\/sites\/[^`"]*\/(terminal|restart)|RestartButton|RestartForm|TerminalConsole/);
  });
});

const walk = (dir: string): string[] =>
  fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(`${dir}/${d.name}`) : /\.tsx?$/.test(d.name) ? [`${dir}/${d.name}`] : []));

// ---------------------------------------------------------------------------------------------
describe("8. accessibility in the markup", () => {
  const sess = { sessionId: SID, siteId: "s1", containerName: "hp_site_s1", openedAt: "2026-11-17T10:00:00Z", expiresAt: "2026-11-17T10:30:00Z" };

  it("the code field and the command line have a label and their hint tied; errors are alerts; every button has a name", () => {
    for (const m of [en, itMsgs]) {
      const t = m.admin.terminal;
      const code = html(m, callHooks(TerminalConsole, { siteId: "s1", csrfToken: "csrf" }, m, { 2: t.errors.TOTP_INVALID }).tree);
      expect(code).toContain(`<label data-slot="label" class=`.slice(0, 6));
      expect(code).toMatch(/<label[^>]*for="terminal-code"/);
      expect(code).toMatch(/<input[^>]*id="terminal-code"[^>]*aria-describedby="terminal-code-hint"|<input[^>]*aria-describedby="terminal-code-hint"[^>]*id="terminal-code"/);
      expect(code).toContain('id="terminal-code-hint"');
      expect(code).toMatch(new RegExp(`role="alert"[\\s\\S]*${t.errors.TOTP_INVALID.slice(0, 20)}`));
      expect(code).toMatch(new RegExp(`<button[^>]*type="submit"[^>]*>${t.open}</button>`));

      const open = html(m, callHooks(TerminalConsole, { siteId: "s1", csrfToken: "csrf" }, m, { 0: "open", 3: sess, 6: t.writeFailed }).tree);
      expect(open).toMatch(/<label[^>]*for="terminal-input"/);
      expect(open).toMatch(/<input[^>]*aria-describedby="terminal-input-hint"/);
      expect(open).toContain(`id="terminal-input-hint" class="text-sm text-muted-foreground">${t.inputHint}</p>`);
      expect(open).toMatch(new RegExp(`role="alert"[\\s\\S]*${t.writeFailed}`));
      expect(open).toMatch(/<div role="log" aria-live="polite" aria-relevant="additions"/);
      expect(open).toMatch(new RegExp(`<button[^>]*>${t.send}</button>`));
      expect(open).toMatch(new RegExp(`<button[^>]*aria-label="${t.ctrlCLabel}"[^>]*>${t.ctrlC}</button>`));
      expect(open).toMatch(new RegExp(`<button[^>]*aria-label="${t.ctrlDLabel}"[^>]*>${t.ctrlD}</button>`));
      expect(open).toMatch(new RegExp(`<button[^>]*>${t.close}</button>`));
    }
  });

  it("Restart and Cancel are named buttons; the follow-up is a status", () => {
    for (const m of [en, itMsgs]) {
      const r = m.admin.health.restart;
      const b = html(m, callHooks(RestartButton, { target: site("running"), csrfToken: "csrf" }, m).tree);
      expect(b).toMatch(new RegExp(`<button[^>]*aria-label="${r.buttonLabel.replace("{name}", "wp-a.example.test")}"[^>]*>${r.button}</button>`));
      expect(b).toContain('role="status"');
      const f = callHooks(RestartForm, { target: site("running"), onConfirm: async () => null, onCancel: () => {} }, m, { 2: r.reasonRequired }).tree;
      expect(textOf(button(f, m.common.cancel))).toBe(m.common.cancel);
      expect(textOf(button(f, r.confirm))).toBe(r.confirm);
      expect(els(f).some((e) => e.props.role === "alert" && textOf(e) === r.reasonRequired)).toBe(true);
    }
  });

  it("a disabled Change version has its reason on screen as text", () => {
    for (const m of [en, itMsgs]) {
      const props = { orgId: "o1", siteId: "s1", siteName: "wp-a.example.test", phpVersion: "8.3", csrfToken: "csrf" };
      const change = (status: "stopped" | "ready") => {
        const { tree } = callHooks(SiteActions, { ...props, status }, m, { 2: "8.4" });
        return { b: button(tree, m.site.manage.phpApply)!, text: textOf(tree) };
      };
      const stopped = change("stopped");
      expect(stopped.b.props.disabled).toBe(true);
      expect(stopped.text).toContain(m.site.manage.phpStopped);
      const ready = change("ready");
      expect(ready.b.props.disabled).toBe(false);
      expect(ready.text).not.toContain(m.site.manage.phpStopped);
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe("9. the screen and the routes fit together", () => {
  const CLIENT = [
    ["POST", "`/api/admin/sites/${siteId}/terminal`", "src/app/api/admin/sites/[siteId]/terminal/route.ts"],
    // ADR-0041: the same page opens a session in one component of an application.
    [
      "POST",
      "`/api/admin/app-stacks/${component.stackId}/components/${component.componentKey}/terminal`",
      "src/app/api/admin/app-stacks/[stackId]/components/[componentKey]/terminal/route.ts",
    ],
    ["POST", "`/api/admin/terminal/${s.id}/write`", "src/app/api/admin/terminal/[sessionId]/write/route.ts"],
    ["POST", "`/api/admin/terminal/${s.id}/close`", "src/app/api/admin/terminal/[sessionId]/close/route.ts"],
    ["POST", "`/api/admin/terminal/${o.sessionId}/read`", "src/app/api/admin/terminal/[sessionId]/read/route.ts"],
    ["POST", "`/api/admin/panel-containers/${target.component}/restart`", "src/app/api/admin/panel-containers/[component]/restart/route.ts"],
    ["POST", "`/api/admin/sites/${target.siteId}/restart`", "src/app/api/admin/sites/[siteId]/restart/route.ts"],
    ["POST", "`/api/admin/host-services/${target.service}/restart`", "src/app/api/admin/host-services/[service]/restart/route.ts"],
    ["GET", "`/api/admin/operations/${operationId}`", "src/app/api/admin/operations/[operationId]/route.ts"],
  ] as const;

  it("every address the pages request has a route file exporting that method, and no other address is requested", () => {
    const found = M5C_SOURCES.filter((f) => !f.includes("/api/")).flatMap((f) => read(f).match(/`\/api\/admin\/[^`]*`/g) ?? []);
    expect(new Set(found)).toEqual(new Set(CLIENT.map(([, u]) => u)));
    for (const [method, , file] of CLIENT) expect(read(file), file).toMatch(new RegExp(`export async function ${method}\\(`));
    expect(read("src/app/admin/health/page.tsx")).toContain("href={`/admin/sites/${s.siteId}/terminal`}");
    expect(fs.existsSync(path.join(ROOT, "src/app/admin/sites/[siteId]/terminal/page.tsx"))).toBe(true);
    expect(read("src/app/admin/apps/[stackId]/page.tsx")).toContain("href={`/admin/apps/${stack.id}/terminal/${c.key}`}");
    expect(fs.existsSync(path.join(ROOT, "src/app/admin/apps/[stackId]/terminal/[componentKey]/page.tsx"))).toBe(true);
  });

  it("every BFF route forwards to a path and method an API controller serves", () => {
    const api = (f: string) => fs.readFileSync(path.join(ROOT, "../api/src/controllers", f), "utf8");
    const term = api("admin-terminal.controller.ts");
    const sites = api("admin-sites.controller.ts");
    const health = api("admin-health.controller.ts");
    expect(term).toContain('@Controller("v1/admin")');
    for (const [verb, p] of [["Post", "sites/:siteId/terminal"], ["Post", "terminal/:sessionId/write"], ["Post", "terminal/:sessionId/read"], ["Post", "terminal/:sessionId/close"]])
      expect(term).toContain(`@${verb}("${p}")`);
    expect(sites).toContain('@Controller("v1/admin/sites")');
    expect(sites).toContain('@Post(":siteId/restart")');
    expect(health).toContain('@Controller("v1/admin")');
    expect(health).toContain('@Post("panel-containers/:component/restart")');
    expect(health).toContain('@Get("operations/:operationId")');
    const apps = api("admin-app-stacks.controller.ts");
    expect(apps).toContain('@Controller("v1/admin/app-stacks")');
    expect(apps).toContain('@Post(":stackId/components/:componentKey/terminal")');
    expect(read("src/app/api/admin/app-stacks/[stackId]/components/[componentKey]/terminal/route.ts")).toContain(
      "`v1/admin/app-stacks/${stackId}/components/${componentKey}/terminal`",
    );
  });

  it("the fields the pages read exist in the contract", () => {
    expect(Object.keys(TerminalSessionDtoSchema.shape)).toEqual(expect.arrayContaining(["sessionId", "expiresAt"]));
    expect(Object.keys(AppTerminalSessionDtoSchema.shape)).toEqual(expect.arrayContaining(["sessionId", "expiresAt"]));
    expect(Object.keys(TerminalReadDtoSchema.shape)).toEqual(expect.arrayContaining(["output", "cursor", "dropped", "ended"]));
    expect(Object.keys(OperationDtoSchema.shape)).toContain("status");
    const row = AdminHealthDtoSchema.shape.siteContainers.element.shape;
    for (const k of ["siteId", "siteName", "desired", "observed"]) expect(Object.keys(row)).toContain(k);
    expect(fs.readFileSync(path.join(ROOT, "../api/src/controllers/admin-health.controller.ts"), "utf8")).toContain("data: { component: PanelContainer; operationId: string }");
  });
});

// ---------------------------------------------------------------------------------------------
describe("10. the customer's side did not change, except Change version", () => {
  it("the customer's Start, Stop and Restart send the requests they sent before", async () => {
    fetchMock.mockImplementation(async () => answer({ status: 409, body: err("RESOURCE_LOCKED") }));
    const props = { orgId: "o1", siteId: "s1", siteName: "wp-a.example.test", phpVersion: "8.3", csrfToken: "csrf" };
    for (const [status, action] of [["stopped", "start"], ["ready", "stop"], ["ready", "restart"]] as const) {
      fetchMock.mockClear();
      const { tree } = callHooks(SiteActions, { ...props, status }, en);
      const b = button(tree, en.site.manage[action])!;
      expect(b.props.disabled).toBe(false);
      await (b.props.onClick as () => Promise<void>)();
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("/api/bff/orgs/o1/managed-sites/s1/actions");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({ action });
      expect(Object.keys(init.headers as object).sort()).toEqual(["Content-Type", "Idempotency-Key", "X-CSRF-Token"]);
    }
    const stopped = callHooks(SiteActions, { ...props, status: "stopped" }, en).tree;
    expect(button(stopped, en.site.manage.stop)!.props.disabled).toBe(true);
    expect(button(stopped, en.site.manage.restart)!.props.disabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
describe("term-api's answers (posted 02:15) each meet their own sentence on the page", () => {
  const locked = (reason: string) => err("RESOURCE_LOCKED", [{ message: "m", reason }]);
  const table: Array<[string, number, unknown, (m: Messages) => string]> = [
    ["open 404", 404, err("NOT_FOUND"), (m) => m.admin.terminal.errors.NOT_FOUND],
    ["open 503", 503, err("DOCKER_ENGINE_UNAVAILABLE"), (m) => m.admin.terminal.errors.DOCKER_ENGINE_UNAVAILABLE],
    ["open 409 site_changing", 409, locked("site_changing"), (m) => m.admin.terminal.errors.site_changing],
    ["open 409 container_down", 409, locked("container_down"), (m) => m.admin.terminal.errors.container_down],
    ["open 409 site_busy", 409, locked("site_busy"), (m) => m.admin.terminal.errors.site_busy],
    ["open 409 server_full", 409, locked("server_full"), (m) => m.admin.terminal.errors.server_full],
    ["open 400", 400, err("VALIDATION_ERROR"), (m) => m.admin.terminal.errors.VALIDATION_ERROR],
    ["open 403 setup", 403, err("ACCOUNT_SETUP_INCOMPLETE"), (m) => m.admin.terminal.errors.ACCOUNT_SETUP_INCOMPLETE],
    ["open 423", 423, err("ACCOUNT_LOCKED"), (m) => m.admin.terminal.errors.ACCOUNT_LOCKED],
    ["open 401 code", 401, err("TOTP_INVALID"), (m) => m.admin.terminal.errors.TOTP_INVALID],
    ["any 401 sign-in", 401, err("UNAUTHENTICATED"), (m) => m.admin.terminal.errors.signedOut],
    ["write 404", 404, err("NOT_FOUND"), (m) => m.admin.terminal.errors.NOT_FOUND],
    ["write 409 session_ended", 409, locked("session_ended"), (m) => m.admin.terminal.errors.session_ended],
  ];
  it.each(table)("%s", (_n, status, body, want) => {
    for (const [m, re] of [[en, enNext], [itMsgs, itNext]] as const) {
      const said = terminalErrorText(m, status, body);
      expect(said).toBe(want(m));
      expect(said).not.toBe(m.admin.terminal.errors.generic);
      expect(said).toMatch(re);
    }
  });
});
