// ADR-0041: the server administrator's page of a customer's application, the logs of its components and the
// terminal in one component. The site terminal's own checks stay in admin-terminal.test.ts and m5c-web-qa.test.ts.
import * as React from "react";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TERMINAL_END_REASONS, TERMINAL_REFUSALS, type AdminAppStackDto } from "@hosting-panel/contracts";
import { format, type Messages } from "@/i18n";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { I18nProvider } from "@/i18n/provider";

const fetchUpstream = vi.fn();
const getSessionFromRequest = vi.fn();
const getServerSession = vi.fn();
const getRequestLocale = vi.fn();

vi.mock("@/lib/upstream", async () => ({
  ...(await vi.importActual<object>("@/lib/upstream")),
  fetchUpstream: (...a: unknown[]) => fetchUpstream(...a),
}));
vi.mock("@/lib/server-session", () => ({
  getSessionFromRequest: (...a: unknown[]) => getSessionFromRequest(...a),
  getServerSession: (...a: unknown[]) => getServerSession(...a),
}));
vi.mock("@/i18n/server", () => ({ getRequestLocale: (...a: unknown[]) => getRequestLocale(...a) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/admin/sites",
}));

import AdminAppStackPage from "@/app/admin/apps/[stackId]/page";
import AdminAppStackTerminalPage from "@/app/admin/apps/[stackId]/terminal/[componentKey]/page";
import * as logsRoute from "@/app/api/admin/app-stacks/[stackId]/components/[componentKey]/logs/route";
import * as terminalRoute from "@/app/api/admin/app-stacks/[stackId]/components/[componentKey]/terminal/route";
import { TerminalConsole } from "@/components/admin/terminal-console";
import { AppStackLogs } from "@/components/app-stacks/app-stack-logs";
import { Button } from "@/components/ui/button";
import { endText, terminalErrorText } from "@/lib/terminal-session";

const STACK = "stk_a1";
const SID = `term_${"0123456789abcdef".repeat(2)}`;
const locales = [
  ["en", en],
  ["it", itMsgs],
] as const;

const html = (m: Messages, child: ReactNode) =>
  renderToStaticMarkup(createElement(I18nProvider, { locale: m === en ? "en" : "it", messages: m, children: child }))
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"');

// Calls a client component once with a stand-in hook dispatcher, so its handlers can be run without a DOM.
const internals = (React as unknown as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE!;
function callHooks<P>(C: (p: P) => ReactNode, props: P, m: Messages, state: Record<number, unknown> = {}) {
  let s = 0;
  const sets: Array<[number, unknown]> = [];
  const ctx = { locale: m === en ? "en" : "it", messages: m };
  const prev = internals.H;
  internals.H = {
    useState: (v: unknown) => {
      const k = s++;
      return [k in state ? state[k] : typeof v === "function" ? (v as () => unknown)() : v, (x: unknown) => void sets.push([k, x])];
    },
    useRef: (v: unknown) => ({ current: v }),
    useCallback: (f: unknown) => f,
    useMemo: (f: () => unknown) => f(),
    useEffect: () => {},
    useLayoutEffect: () => {},
    useContext: () => ctx,
    use: () => ctx,
    useId: () => "id",
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
const ev = { preventDefault() {} };

const fetchMock = vi.fn();
const answer = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const err = (code: string, details: unknown[] = []) => ({ error: { code, message: "m", requestId: "r", retryable: false, details } });

const ok = (data: unknown) => ({ ok: true, status: 200, data: { data } });
const fail = (status: number, code?: string) => ({ ok: false, status, error: code ? { error: { code } } : null });

const stack = (over: Partial<AdminAppStackDto> = {}): AdminAppStackDto => ({
  id: STACK,
  name: "notes",
  organizationId: "org_beta",
  organizationName: "Beta",
  templateId: "atpl_notes",
  templateName: "Notes",
  versionNumber: 3,
  status: "running",
  primaryHostname: "notes.apps.example.test",
  components: [
    { key: "web", health: "healthy" },
    { key: "cache", health: "unhealthy" },
  ],
  ...over,
});

beforeEach(() => {
  fetchUpstream.mockReset();
  getSessionFromRequest.mockReset().mockResolvedValue({ accessToken: "tok", csrfToken: "csrf" });
  getServerSession.mockReset().mockResolvedValue({ accessToken: "tok", csrfToken: "csrf", user: { isServerAdmin: true } });
  getRequestLocale.mockReset().mockResolvedValue("en");
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------
describe("the page of one application", () => {
  const page = async (m: Messages = en, stackId = STACK) => {
    getRequestLocale.mockResolvedValue(m === en ? "en" : "it");
    return html(m, (await AdminAppStackPage({ params: Promise.resolve({ stackId }) })) as ReactElement);
  };

  it.each(locales)("shows whose it is, its template, its address and its state (%s)", async (_l, m) => {
    fetchUpstream.mockResolvedValue(ok(stack()));
    const out = await page(m);
    expect(fetchUpstream.mock.calls.map((c) => c[0])).toEqual([`v1/admin/app-stacks/${STACK}`]);
    expect(out).toContain(">notes</h1>");
    expect(out).toContain(`>${m.admin.appTemplates.stackStatus.running}<`);
    expect(out).toContain(`>${m.admin.appStack.customer}</dt><dd>Beta</dd>`);
    expect(out).toContain(`<dd>${format(m.admin.sites.templateVersion, { name: "Notes", version: 3 })}</dd>`);
    expect(out).toContain("<dd>notes.apps.example.test</dd>");
    expect(out).toContain('href="/admin/sites"');
    expect(out).toContain(m.admin.appStack.back);
  });

  it.each(locales)("lists each component with its health and one link to its terminal (%s)", async (_l, m) => {
    fetchUpstream.mockResolvedValue(ok(stack()));
    const out = await page(m);
    const rows = out.split("<tr").slice(2); // after the heading row
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain(">web<");
    expect(rows[0]).toContain(`>${m.apps.health.healthy}<`);
    expect(rows[0]).toContain(`href="/admin/apps/${STACK}/terminal/web"`);
    expect(rows[0]).toContain(`aria-label="${format(m.admin.appStack.terminalAria, { component: "web" })}"`);
    expect(rows[1]).toContain(">cache<");
    expect(rows[1]).toContain(`>${m.apps.health.unhealthy}<`);
    expect(rows[1]).toContain(`href="/admin/apps/${STACK}/terminal/cache"`);
    expect(out.split("/terminal/").length - 1).toBe(2);
    expect(out).not.toContain("<form");
  });

  it.each(locales)("offers the logs of its components and says the reads are recorded (%s)", async (_l, m) => {
    fetchUpstream.mockResolvedValue(ok(stack()));
    const out = await page(m);
    expect(out).toContain(m.admin.appStack.logsHint);
    expect(out).toContain(`>${m.apps.logs.load}<`);
    expect(out).toContain('<option value="web"');
    expect(out).toContain('<option value="cache"');
  });

  it("an application without an address says so", async () => {
    fetchUpstream.mockResolvedValue(ok(stack({ primaryHostname: null })));
    expect(await page()).toContain(`<dd>${en.admin.appStack.noAddress}</dd>`);
  });

  it("shows no parameter, private value, plan or id of the engine: only what the answer's fields carry", async () => {
    fetchUpstream.mockResolvedValue(ok({ ...stack(), parameters: [{ key: "k", value: "LEAK-1" }], plan: "LEAK-2", containerId: "LEAK-3" }));
    const out = await page();
    expect(out).not.toContain("LEAK-");
    expect(out).not.toContain("org_beta");
  });

  it("an unknown application is the not-found page; a stack id that is not one path segment never reaches the API", async () => {
    fetchUpstream.mockResolvedValue(fail(404, "NOT_FOUND"));
    await expect(page()).rejects.toThrow("NOT_FOUND");
    fetchUpstream.mockClear();
    for (const bad of ["a/b", "../x", "a.b", ""]) await expect(page(en, bad)).rejects.toThrow("NOT_FOUND");
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it.each(locales)("applications off on this server, and a failed read, each have their own sentence (%s)", async (_l, m) => {
    fetchUpstream.mockResolvedValue(fail(422, "NOT_SUPPORTED"));
    const off = await page(m);
    expect(off).toContain(m.admin.appStack.notAvailable);
    expect(off).not.toContain("<table");
    fetchUpstream.mockResolvedValue(fail(500, "INTERNAL_ERROR"));
    const failed = await page(m);
    expect(failed).toContain(m.shell.loadErrorTitle);
    expect(failed).not.toContain(m.admin.appStack.notAvailable);
  });

  it("without a sign-in it goes to the login page and reads nothing", async () => {
    getServerSession.mockResolvedValue(null);
    await expect(page()).rejects.toThrow("REDIRECT:/login");
    expect(fetchUpstream).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------
describe("the terminal page of one component", () => {
  const page = async (m: Messages, componentKey: string, stackId = STACK) => {
    getRequestLocale.mockResolvedValue(m === en ? "en" : "it");
    return html(m, (await AdminAppStackTerminalPage({ params: Promise.resolve({ stackId, componentKey }) })) as ReactElement);
  };

  it.each(locales)("names the component and the application, links back to the application and asks for a code (%s)", async (_l, m) => {
    fetchUpstream.mockResolvedValue(ok(stack()));
    const out = await page(m, "cache");
    expect(out).toContain(`>${format(m.admin.appStack.terminal.title, { component: "cache", name: "notes" })}</h1>`);
    expect(out).toContain(`href="/admin/apps/${STACK}"`);
    expect(out).toContain(format(m.admin.appStack.terminal.back, { name: "notes" }));
    expect(out).toContain(m.admin.appStack.terminal.intro);
    expect(out).toContain(m.admin.appStack.terminal.limits);
    expect(out).not.toContain(m.admin.terminal.intro);
    expect(out).toContain('id="terminal-code"');
    expect(out).toContain(m.admin.terminal.codeOnce);
  });

  it("a component the application does not have is the not-found page, also when it looks like another one's key", async () => {
    fetchUpstream.mockResolvedValue(ok(stack()));
    for (const key of ["db", "WEB", "web ", "web/../cache", ""]) await expect(page(en, key)).rejects.toThrow("NOT_FOUND");
  });

  it("an unknown application, applications off and no sign-in behave as on the application's page", async () => {
    fetchUpstream.mockResolvedValue(fail(404, "NOT_FOUND"));
    await expect(page(en, "web")).rejects.toThrow("NOT_FOUND");
    fetchUpstream.mockResolvedValue(fail(422, "NOT_SUPPORTED"));
    const off = await page(en, "web");
    expect(off).toContain(en.admin.appStack.notAvailable);
    expect(off).not.toContain('id="terminal-code"');
    getServerSession.mockResolvedValue(null);
    await expect(page(en, "web")).rejects.toThrow("REDIRECT:/login");
  });
});

// ---------------------------------------------------------------------------------------------
describe("the console in a component", () => {
  const component = { stackId: STACK, componentKey: "web" };
  const session = { sessionId: SID, stackId: STACK, componentKey: "web", containerName: `hp_app_${STACK}_web`, openedAt: "2026-11-23T10:00:00Z", expiresAt: "2026-11-23T10:30:00Z" };
  const ended = (reason: string) => ({ data: { output: "", cursor: 0, dropped: false, ended: { reason, at: "2026-11-23T10:01:00Z" } } });
  const submit = async (props: Parameters<typeof TerminalConsole>[0], m: Messages = en) => {
    const { tree, sets } = callHooks(TerminalConsole, props, m, { 1: "975310" });
    const form = els(tree).find((e) => e.type === "form")!;
    await (form.props.onSubmit as (e: unknown) => Promise<void>)(ev);
    return sets;
  };

  it("opens through the component's own address with the code in the body, then reads the session as a site's one is read", async () => {
    fetchMock.mockImplementation(async (url: string) => (url.endsWith("/read") ? answer(200, ended("shell_exited")) : answer(201, { data: session })));
    const sets = await submit({ component, csrfToken: "csrf" });
    const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
    expect(calls[0]![0]).toBe(`/api/admin/app-stacks/${STACK}/components/web/terminal`);
    expect(calls[0]![1].method).toBe("POST");
    expect(JSON.parse(calls[0]![1].body as string)).toEqual({ code: "975310" });
    expect(new Headers(calls[0]![1].headers).get("X-CSRF-Token")).toBe("csrf");
    expect(calls[1]![0]).toBe(`/api/admin/terminal/${SID}/read`);
    for (const [u] of calls) expect(u).not.toContain("975310");
    expect(sets).toContainEqual([1, ""]);
    expect(sets).toContainEqual([0, "open"]);
    expect(sets).toContainEqual([2, en.admin.terminal.ended.shell_exited]);
  });

  it("a site still opens through the site's address", async () => {
    fetchMock.mockImplementation(async () => answer(401, err("TOTP_INVALID")));
    await submit({ siteId: "s1", csrfToken: "csrf" });
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe("/api/admin/sites/s1/terminal");
  });

  it("an answer shaped like a site's session, or with a field too many, does not open a component's session", async () => {
    const { stackId: _s, componentKey: _c, ...rest } = session;
    for (const data of [{ ...rest, siteId: "s1" }, { ...session, containerId: "abc" }]) {
      fetchMock.mockReset();
      fetchMock.mockImplementation(async () => answer(201, { data }));
      const sets = await submit({ component, csrfToken: "csrf" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sets).not.toContainEqual([0, "open"]);
      expect(sets).toContainEqual([2, en.admin.terminal.errors.generic]);
    }
  });

  it.each(locales)("a refusal and an end speak of the component, not of a site (%s)", async (_l, m) => {
    fetchMock.mockImplementation(async () => answer(409, err("RESOURCE_LOCKED", [{ reason: "container_down" }])));
    expect(await submit({ component, csrfToken: "csrf" }, m)).toContainEqual([2, m.admin.appStack.terminal.errors.container_down]);
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) => (url.endsWith("/read") ? answer(200, ended("container_gone")) : answer(201, { data: session })));
    expect(await submit({ component, csrfToken: "csrf" }, m)).toContainEqual([2, m.admin.appStack.terminal.ended.container_gone]);
  });

  it.each(locales)("says where the shell runs and what a component's limits are (%s)", (_l, m) => {
    const inComponent = textOf(callHooks(TerminalConsole, { component, csrfToken: "csrf" }, m).tree);
    expect(inComponent).toContain(m.admin.appStack.terminal.intro);
    expect(inComponent).toContain(m.admin.appStack.terminal.limits);
    expect(inComponent).not.toContain(m.admin.terminal.intro);
    const inSite = textOf(callHooks(TerminalConsole, { siteId: "s1", csrfToken: "csrf" }, m).tree);
    expect(inSite).toContain(m.admin.terminal.intro);
    expect(inSite).toContain(m.admin.terminal.limits);
    expect(inSite).not.toContain(m.admin.appStack.terminal.intro);
  });
});

// ---------------------------------------------------------------------------------------------
describe("the sentences of a component's terminal", () => {
  const refusal = (reason: string) => err("RESOURCE_LOCKED", [{ reason }]);

  it.each(locales)("replace only the sentences that name the site; every other one is the site terminal's (%s)", (_l, m) => {
    const own = m.admin.appStack.terminal;
    for (const reason of TERMINAL_REFUSALS) {
      const text = terminalErrorText(m, 409, refusal(reason), "component");
      if (reason in own.errors) {
        expect(text).toBe((own.errors as Record<string, string>)[reason]);
        expect(text).not.toBe(m.admin.terminal.errors[reason]);
      } else expect(text).toBe(m.admin.terminal.errors[reason]);
      expect(terminalErrorText(m, 409, refusal(reason))).toBe(m.admin.terminal.errors[reason]);
    }
    expect(terminalErrorText(m, 503, err("DOCKER_ENGINE_UNAVAILABLE"), "component")).toBe(own.errors.DOCKER_ENGINE_UNAVAILABLE);
    expect(terminalErrorText(m, 404, err("NOT_FOUND"), "component")).toBe(own.errors.NOT_FOUND);
    expect(terminalErrorText(m, 401, err("TOTP_INVALID"), "component")).toBe(m.admin.terminal.errors.TOTP_INVALID);
    expect(terminalErrorText(m, 401, err("UNAUTHENTICATED"), "component")).toBe(m.admin.terminal.errors.signedOut);
    expect(terminalErrorText(m, 403, err("PERMISSION_DENIED"), "component")).toBe(m.errors.PERMISSION_DENIED);
    expect(terminalErrorText(m, 500, null, "component")).toBe(m.admin.terminal.errors.generic);
    for (const reason of [...TERMINAL_END_REASONS, "lost"] as const) {
      const text = endText(m, reason, "component");
      expect(text).toBe(reason === "container_gone" ? own.ended.container_gone : m.admin.terminal.ended[reason]);
      expect(endText(m, reason)).toBe(m.admin.terminal.ended[reason]);
    }
  });

  it.each(locales)("no sentence of a component speaks of a site, and each key replaces one that exists (%s)", (_l, m) => {
    const own = m.admin.appStack.terminal;
    for (const key of Object.keys(own.errors)) expect(Object.keys(m.admin.terminal.errors)).toContain(key);
    for (const key of Object.keys(own.ended)) expect(Object.keys(m.admin.terminal.ended)).toContain(key);
    for (const text of [own.intro, own.limits, ...Object.values(own.errors), ...Object.values(own.ended)]) expect(text).not.toMatch(/\b(site|sito|siti|sites)\b/i);
  });

  it("the refused answer's own text never reaches the page", () => {
    const text = terminalErrorText(en, 409, { error: { code: "RESOURCE_LOCKED", message: "LEAK-1", details: [{ reason: "site_busy", message: "LEAK-2" }] } }, "component");
    expect(text).toBe(en.admin.appStack.terminal.errors.site_busy);
  });
});

// ---------------------------------------------------------------------------------------------
describe("the logs card on the administrator's page", () => {
  const lines = [
    { at: "2026-11-23T10:00:00Z", stream: "stdout" as const, text: "older line" },
    { at: null, stream: "stderr" as const, text: "newer line" },
  ];
  const loadButton = (tree: ReactNode) => els(tree).find((e) => e.type === Button && textOf(e) === en.apps.logs.load)!;

  it("reads through the administrator's address when one is given, and through the customer's own when none is", async () => {
    fetchMock.mockImplementation(async () => answer(200, { data: { componentKey: "web", lines } }));
    const props = { orgId: "org_beta", stackId: STACK, componentKeys: ["web", "cache"] };
    const admin = callHooks(AppStackLogs, { ...props, basePath: `/api/admin/app-stacks/${STACK}` }, en);
    await (loadButton(admin.tree).props.onClick as () => Promise<void>)();
    expect(fetchMock).toHaveBeenLastCalledWith(`/api/admin/app-stacks/${STACK}/components/web/logs?tail=200`, { cache: "no-store" });
    expect(admin.sets).toContainEqual([1, [lines[1], lines[0]]]);
    const customer = callHooks(AppStackLogs, props, en);
    await (loadButton(customer.tree).props.onClick as () => Promise<void>)();
    expect(fetchMock).toHaveBeenLastCalledWith(`/api/bff/orgs/org_beta/app-stacks/${STACK}/components/web/logs?tail=200`, { cache: "no-store" });
    for (const [url] of fetchMock.mock.calls as Array<[string]>) expect(url.startsWith("/api/")).toBe(true);
  });

  it("the administrator's read never goes through the customer's route, whose organisation it is not signed into", async () => {
    fetchMock.mockImplementation(async () => answer(200, { data: { componentKey: "cache", lines: [] } }));
    const { tree } = callHooks(AppStackLogs, { orgId: "org_beta", stackId: STACK, componentKeys: ["web", "cache"], basePath: `/api/admin/app-stacks/${STACK}` }, en, { 0: "cache" });
    await (loadButton(tree).props.onClick as () => Promise<void>)();
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(`/api/admin/app-stacks/${STACK}/components/cache/logs?tail=200`);
    expect(url).not.toContain("org_beta");
    expect(url).not.toContain("/api/bff/");
  });
});

// ---------------------------------------------------------------------------------------------
describe("the two routes of the panel", () => {
  type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
  const params = { stackId: STACK, componentKey: "web" };
  const badSegments = ["a.b", "../x", "%2e%2e", "a/b", "x".repeat(129), "", "s 1", "<script>"];

  const getLogs = (query = "", over: Partial<typeof params> = {}) =>
    (logsRoute.GET as unknown as Handler)(new Request(`http://localhost:3000/api/x${query}`, { headers: { Host: "localhost:3000" } }), {
      params: Promise.resolve({ ...params, ...over }),
    });
  const openTerminal = (headers: Record<string, string> = {}, over: Partial<typeof params> = {}, body: unknown = { code: "975310" }) => {
    const all: Record<string, string> = { Host: "localhost:3000", Origin: "http://localhost:3000", "X-CSRF-Token": "csrf", "Content-Type": "application/json", ...headers };
    for (const [k, v] of Object.entries(all)) if (v === "") delete all[k];
    return (terminalRoute.POST as unknown as Handler)(new Request("http://localhost:3000/api/x", { method: "POST", headers: all, body: JSON.stringify(body) }), {
      params: Promise.resolve({ ...params, ...over }),
    });
  };
  const methods = (mod: object) => Object.keys(mod).filter((k) => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(k));

  it("logs: only GET, forwarded to the administrator's route of the API with a whole `tail` in its range and nothing else of the query", async () => {
    expect(methods(logsRoute)).toEqual(["GET"]);
    fetchUpstream.mockResolvedValue(ok({ componentKey: "web", lines: [] }));
    const sent = async (query: string) => {
      fetchUpstream.mockClear();
      const res = await getLogs(query);
      expect(res.status).toBe(200);
      const [path, opts] = fetchUpstream.mock.calls[0] as [string, { method: string; timeoutMs?: number; accessToken?: string }];
      expect(opts).toMatchObject({ method: "GET", timeoutMs: 10_000, accessToken: "tok" });
      return path;
    };
    const base = `v1/admin/app-stacks/${STACK}/components/web/logs`;
    expect(await sent("")).toBe(`${base}?tail=200`);
    expect(await sent("?tail=50")).toBe(`${base}?tail=50`);
    expect(await sent("?tail=9999")).toBe(`${base}?tail=500`);
    expect(await sent("?tail=0")).toBe(`${base}?tail=1`);
    expect(await sent("?tail=abc")).toBe(`${base}?tail=200`);
    expect(await sent("?tail=7.9&x=../y&organizationId=org_other")).toBe(`${base}?tail=7`);
  });

  it("terminal: only POST, forwarded to the administrator's route of the API with the code in the body and 40 seconds to answer", async () => {
    expect(methods(terminalRoute)).toEqual(["POST"]);
    fetchUpstream.mockResolvedValue({ ok: true, status: 201, data: { data: {} } });
    const res = await openTerminal();
    expect(res.status).toBe(201);
    expect(fetchUpstream).toHaveBeenCalledTimes(1);
    const [path, opts] = fetchUpstream.mock.calls[0] as [string, { method: string; timeoutMs?: number; accessToken?: string; body?: unknown }];
    expect(path).toBe(`v1/admin/app-stacks/${STACK}/components/web/terminal`);
    expect(opts).toMatchObject({ method: "POST", timeoutMs: 40000, accessToken: "tok" });
    expect(opts.body).toEqual({ code: "975310" });
    expect(path).not.toContain("975310");
  });

  it("a stack id or a component key of a wrong shape is 400 and nothing goes upstream", async () => {
    for (const bad of badSegments) {
      expect((await getLogs("", { stackId: bad })).status, `stackId=${bad}`).toBe(400);
      expect((await getLogs("", { componentKey: bad })).status, `componentKey=${bad}`).toBe(400);
      expect((await openTerminal({}, { stackId: bad })).status, `stackId=${bad}`).toBe(400);
      expect((await openTerminal({}, { componentKey: bad })).status, `componentKey=${bad}`).toBe(400);
    }
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("no session is 401; a terminal without the CSRF token or from another origin is 403; nothing goes upstream", async () => {
    const refused: ReadonlyArray<Record<string, string>> = [{ "X-CSRF-Token": "" }, { "X-CSRF-Token": "other" }, { Origin: "http://evil.example.test" }, { Origin: "null" }];
    for (const h of refused) expect((await openTerminal(h)).status, JSON.stringify(h)).toBe(403);
    getSessionFromRequest.mockResolvedValue(null);
    expect((await getLogs()).status).toBe(401);
    expect((await openTerminal()).status).toBe(401);
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("the API's refusal passes through with its status and code, and nothing is written to the console", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    fetchUpstream.mockResolvedValue({ ok: false, status: 409, error: err("RESOURCE_LOCKED", [{ reason: "site_busy" }]) });
    const refused = await openTerminal();
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string; details: Array<{ reason: string }> } }).error).toMatchObject({ code: "RESOURCE_LOCKED", details: [{ reason: "site_busy" }] });
    fetchUpstream.mockResolvedValue({ ok: false, status: 403, error: err("PERMISSION_DENIED") });
    expect((await getLogs()).status).toBe(403);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});
