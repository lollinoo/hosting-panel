// M5d web: the Updates page, ConfirmAction, the pure rules of lib/admin-updates and the seven BFF routes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  HOST_JOB_RESULTS,
  HOST_SERVICES,
  OsPackagesDtoSchema,
  PANEL_CHECK_STATES,
  PANEL_CONTAINERS,
  UpdatesDtoSchema,
  type OsPackagesDto,
  type UpdatesDto,
} from "@hosting-panel/contracts";
import type { Messages } from "@/i18n";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { I18nProvider } from "@/i18n/provider";

const fetchUpstream = vi.fn();
const getSessionFromRequest = vi.fn();
const getServerSession = vi.fn();
const router = vi.hoisted(() => ({ push: () => {}, refresh: () => {} }));

vi.mock("@/lib/upstream", async () => ({
  ...(await vi.importActual<object>("@/lib/upstream")),
  fetchUpstream: (...args: unknown[]) => fetchUpstream(...args),
}));
vi.mock("@/lib/server-session", () => ({
  getSessionFromRequest: (...args: unknown[]) => getSessionFromRequest(...args),
  getServerSession: (...args: unknown[]) => getServerSession(...args),
}));
vi.mock("@/i18n/server", () => ({ getRequestLocale: async () => "en" }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  useRouter: () => router,
  usePathname: () => "/admin/updates",
}));

import AdminUpdatesPage from "@/app/admin/updates/page";
import { ConfirmAction } from "@/components/admin/confirm-action";
import { Button } from "@/components/ui/button";
import { JOB_FOLLOW_MS, canUpdatePanel, packageGroups, updatesErrorText } from "@/lib/admin-updates";
import { POST as check } from "@/app/api/admin/updates/panel/check/route";
import { POST as applyPanel } from "@/app/api/admin/updates/panel/apply/route";
import { POST as applyComponent } from "@/app/api/admin/updates/components/[component]/apply/route";
import { POST as imageUpdate } from "@/app/api/admin/sites/[siteId]/image-update/route";
import { POST as refresh } from "@/app/api/admin/os-packages/refresh/route";
import { POST as upgrade } from "@/app/api/admin/os-packages/upgrade/route";
import { POST as restartService } from "@/app/api/admin/host-services/[service]/restart/route";

const T = "2026-11-14T10:00:00Z";
const html = (m: Messages, child: ReactElement) =>
  renderToStaticMarkup(createElement(I18nProvider, { locale: m === en ? "en" : "it", messages: m, children: child }))
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"');

const updates = (over: Partial<UpdatesDto["panel"]> = {}, rest: Partial<UpdatesDto> = {}): UpdatesDto =>
  UpdatesDtoSchema.parse({
    panel: {
      installedVersion: "1.4.0",
      check: { state: "newer", latestVersion: "1.5.0", checkedAt: T },
      running: null,
      last: null,
      ...over,
    },
    components: PANEL_CONTAINERS.map((component) => ({
      component,
      expected: component === "phpmyadmin" ? false : true,
      imageCurrent: component === "sftp" ? false : component === "mail_relay" ? null : true,
      runningOperationId: null,
    })),
    sites: [
      { siteId: "s1", siteName: "wp-a.example.test", organizationName: "Acme", phpVersion: "8.3", stopped: false },
      { siteId: "s2", siteName: "wp-b.example.test", organizationName: null, phpVersion: "8.4", stopped: true },
    ],
    sitesTotal: 2,
    ...rest,
  });
const pkgs = (over: Partial<OsPackagesDto> = {}): OsPackagesDto =>
  OsPackagesDtoSchema.parse({
    packages: [
      { name: "libexample1", installedVersion: "1.0-1", newVersion: "1.0-2", origin: "security" },
      { name: "toolexample", installedVersion: "2.0", newVersion: "2.1", origin: "distribution" },
      { name: "thirdexample", installedVersion: "3.0", newVersion: "3.1", origin: "other" },
    ],
    rebootRequired: false,
    canUpgrade: true,
    listsReadAt: T,
    running: null,
    ...over,
  });
const serve = (u: UpdatesDto | null, p: OsPackagesDto | null) =>
  fetchUpstream.mockImplementation(async (path: string) => {
    const data = path === "v1/admin/updates" ? u : path === "v1/admin/os-packages" ? p : null;
    return data ? { ok: true, status: 200, data: { data } } : { ok: false, status: 503, error: { error: { code: "HOST_AGENT_UNAVAILABLE" } } };
  });
const page = async (u: UpdatesDto | null, p: OsPackagesDto | null) => {
  serve(u, p);
  return html(en, await AdminUpdatesPage());
};

// Calls a client component once with stand-in hooks; state setters and effects are recorded.
const internals = (React as unknown as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE!;
function withHooks<P>(C: (p: P) => ReactNode, props: P) {
  let s = 0;
  const sets: Array<[number, unknown]> = [];
  const effects: Array<() => void> = [];
  const prev = internals.H;
  internals.H = {
    useState: (v: unknown) => {
      const k = s++;
      return [v, (x: unknown) => void sets.push([k, x])];
    },
    useRef: (v: unknown) => ({ current: v }),
    useEffect: (fn: () => void) => void effects.push(fn),
    useContext: () => ({ locale: "en", messages: en }),
  };
  try {
    return { tree: C(props), sets, effects };
  } finally {
    internals.H = prev;
  }
}
type El = ReactElement<Record<string, unknown>>;
const els = (n: unknown): El[] =>
  Array.isArray(n) ? n.flatMap(els) : isValidElement(n) ? [n as El, ...els((n.props as Record<string, unknown>).children)] : [];

beforeEach(() => {
  fetchUpstream.mockReset();
  getSessionFromRequest.mockReset().mockResolvedValue({ accessToken: "tok", csrfToken: "csrf" });
  getServerSession.mockReset().mockResolvedValue({ accessToken: "tok", csrfToken: "csrf" });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("pure rules", () => {
  it("canUpdatePanel only when a newer release was found and nothing runs", () => {
    for (const state of PANEL_CHECK_STATES) expect(canUpdatePanel(updates({ check: { state, latestVersion: "1.5.0", checkedAt: T } })), state).toBe(state === "newer");
    expect(canUpdatePanel(updates({ running: { operationId: "op1" } }))).toBe(false);
  });

  it("packageGroups: the panel's list, the ones left to SSH and the security ones", () => {
    const g = packageGroups(pkgs());
    expect(g.main.map((p) => p.name)).toEqual(["libexample1", "toolexample"]);
    expect(g.other.map((p) => p.name)).toEqual(["thirdexample"]);
    expect(g.security.map((p) => p.name)).toEqual(["libexample1"]);
  });

  it("updatesErrorText: each refusal of the page's routes has its admin sentence; an unforeseen code gets the admin fallback, never the code", () => {
    for (const m of [en, itMsgs]) {
      const e = m.admin.updates.errors;
      const table: Array<[string, string | undefined, string]> = [
        ["RESOURCE_LOCKED", "host_job_running", m.admin.updates.panel.locked],
        ["RESOURCE_LOCKED", "site_work_running", e.siteWork],
        ["RESOURCE_LOCKED", undefined, e.busy],
        ["VALIDATION_ERROR", "already_current", e.alreadyCurrent],
        ["VALIDATION_ERROR", "stopped", e.stopped],
        ["VALIDATION_ERROR", undefined, e.other],
        ["PANEL_CONTAINER_ABSENT", undefined, e.absent],
        ["NOT_SUPPORTED", undefined, e.notSupported],
        ["NOT_FOUND", undefined, e.notFound],
        ["HOST_AGENT_UNAVAILABLE", undefined, e.agentDown],
        ["UNAUTHENTICATED", undefined, e.session],
        ["PERMISSION_DENIED", undefined, e.other],
        ["IDEMPOTENCY_CONFLICT", undefined, e.other],
        ["INTERNAL_ERROR", undefined, e.noAnswer],
        ["OPERATION_AMBIGUOUS", undefined, e.noAnswer],
        ["", undefined, e.noAnswer],
        ["SOME_NEW_CODE", "x", e.other],
      ];
      for (const [code, reason, want] of table) {
        const got = updatesErrorText(m, code, reason);
        expect(got, `${code}/${reason}`).toBe(want);
        expect(got).toBeTruthy();
        expect(Object.values(m.errors)).not.toContain(got);
      }
      expect(updatesErrorText(m, "SOME_NEW_CODE")).not.toContain("SOME_NEW_CODE");
    }
    expect(JOB_FOLLOW_MS).toBe(30 * 60_000);
  });
});

describe("the Updates page", () => {
  const t = en.admin.updates;
  const fill = (s: string, v: Record<string, string | number>) => Object.entries(v).reduce((a, [k, x]) => a.replaceAll(`{${k}}`, String(x)), s);
  const updateButton = `>${t.panel.update}</button>`;

  it("the cards in their order, the installed version, pins and the updater's lines", async () => {
    const h = await page(updates(), pkgs());
    const order = [t.pins, t.panel.title, t.components.title, t.sites.title, t.packages.title].map((s) => h.indexOf(s));
    expect(order.every((v) => v >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(h).toContain(fill(t.panel.installed, { version: "1.4.0" }));
    expect(h).toContain(t.panel.linesTitle);
    expect(h).not.toMatch(/sha256|ghcr\.io|:\d+\.\d+-/);
  });

  it("each of the five check states says its sentence; Update only when newer", async () => {
    for (const state of PANEL_CHECK_STATES) {
      const h = await page(updates({ check: { state, latestVersion: state === "never_checked" ? null : "1.5.0", checkedAt: state === "never_checked" ? null : T } }, { sites: [], sitesTotal: 0 }), pkgs());
      const sentence = t.panel.states[state].split("{")[0]!;
      expect(h, state).toContain(sentence);
      expect(h.includes(updateButton), state).toBe(state === "newer");
      expect(h).not.toMatch(/\{(latest|time)\}/);
    }
  });

  it("each of the six ends of the last update says its sentence", async () => {
    for (const result of HOST_JOB_RESULTS.filter((r) => r !== "succeeded")) {
      const h = await page(updates({ last: { operationId: "op0", result, endedAt: T } }), pkgs());
      expect(h, result).toContain(t.panel.results[result].split("{")[0]!);
      expect(h).not.toContain("{time}");
    }
  });

  it("a running update is followed again: its sentence, no second Update", async () => {
    const h = await page(updates({ running: { operationId: "op7" } }, { sites: [], sitesTotal: 0 }), pkgs());
    expect(h).toContain(t.panel.running);
    expect(h).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*>${t.panel.update}</button>`));
  });

  it("panel parts: badge from imageCurrent, Apply only when behind, not in use without Apply, no image name", async () => {
    const h = await page(updates(), pkgs());
    const name = (c: (typeof PANEL_CONTAINERS)[number]) => en.admin.health.components[c];
    expect(h).toContain(`aria-label="${fill(t.components.applyLabel, { name: name("sftp") })}"`);
    for (const c of PANEL_CONTAINERS.filter((c) => c !== "sftp")) expect(h).not.toContain(`aria-label="${fill(t.components.applyLabel, { name: name(c) })}"`);
    expect(h).toContain(`>${t.components.behind}<`);
    expect(h).toContain(`>${t.components.unknown}<`);
    expect(h).toContain(`>${t.components.current}<`);
    expect(h).toContain(`>${en.admin.health.states.not_in_use}<`);
    expect(h).not.toContain("<code");
  });

  it("sites behind: Update for a running one, the stopped sentence and no button for a stopped one, and more", async () => {
    const h = await page(updates({}, { sitesTotal: 9 }), pkgs());
    expect(h).toContain(`aria-label="${fill(t.sites.updateLabel, { name: "wp-a.example.test" })}"`);
    expect(h).not.toContain(`aria-label="${fill(t.sites.updateLabel, { name: "wp-b.example.test" })}"`);
    expect(h).toContain(t.sites.stopped);
    expect(h).toContain(fill(t.sites.more, { count: 7 }));
    expect(h).toContain(en.admin.health.unassigned);
    const none = await page(updates({}, { sites: [], sitesTotal: 0 }), pkgs());
    expect(none).toContain(t.sites.none);
    expect(none).not.toContain(fill(t.sites.more, { count: 0 }));
  });

  it("packages: count, lists, Install only with canUpgrade and a security package, the other card, reboot and the log link", async () => {
    const h = await page(updates(), pkgs({ rebootRequired: true }));
    expect(h).toContain(fill(t.packages.count, { count: 3, security: 1 }));
    expect(h).toContain(t.packages.listsAt.split("{")[0]!);
    expect(h).toContain(`>${t.packages.install}</button>`);
    expect(h).toContain(`>${t.packages.security}<`);
    expect(h).toContain(t.packages.otherTitle);
    expect(h).toContain(t.packages.otherIntro);
    expect(h.indexOf("thirdexample")).toBeGreaterThan(h.indexOf(t.packages.otherTitle));
    expect(h).toContain(t.packages.reboot);
    expect(h).toContain('href="/admin/logs?source=hp-os-upgrade"');
    expect(h).not.toContain(t.packages.cannotUpgrade);

    const cannot = await page(updates(), pkgs({ canUpgrade: false }));
    expect(cannot).toContain(t.packages.cannotUpgrade);
    expect(cannot).not.toContain(`>${t.packages.install}</button>`);
    const noSecurity = await page(updates(), pkgs({ packages: [], listsReadAt: null }));
    expect(noSecurity).not.toContain(`>${t.packages.install}</button>`);
    expect(noSecurity).toContain(t.packages.none);
    expect(noSecurity).toContain(t.packages.listsNever);
    expect(noSecurity).not.toContain(t.packages.reboot);
  });

  it("a read that failed shows its sentence, not an empty card", async () => {
    const h = await page(null, null);
    expect(h).not.toContain(t.sites.title);
    expect(h).toContain(t.loadFailed);
    expect(h).toContain(t.packages.unreadable);
    expect(h).not.toContain(updateButton);
    expect(h).not.toContain(`>${t.packages.install}</button>`);
  });
});

describe("ConfirmAction", () => {
  const follow = { ms: JOB_FOLLOW_MS, running: "R", done: "D", failed: "F", unknown: "U" };
  const base = { csrfToken: "csrf", name: "n", url: "/api/admin/os-packages/refresh", label: "Go", errors: "updates" as const };

  it("a running operation is shown at once and followed again when the page opens", async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ data: { status: "succeeded" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchFn);
    const refreshSpy = vi.spyOn(router, "refresh");
    const { tree, sets, effects } = withHooks(ConfirmAction, { ...base, follow, runningOperationId: "op9" });
    expect(els(tree).find((e) => e.type === Button)!.props.disabled).toBe(true);
    expect(els(tree).find((e) => e.props.role === "status")!.props.children).toBe("R");
    effects.forEach((f) => f());
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchFn).toHaveBeenCalledWith("/api/admin/operations/op9", { cache: "no-store" });
    await vi.advanceTimersByTimeAsync(0);
    expect(sets.map(([, v]) => v)).toContain("succeeded");
    expect(refreshSpy).toHaveBeenCalled();
  });

  it("without a running operation nothing is followed", () => {
    const { effects } = withHooks(ConfirmAction, { ...base, follow, runningOperationId: null });
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);
    effects.forEach((f) => f());
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("a refusal becomes the catalog's sentence; an accepted job is followed", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: "RESOURCE_LOCKED", message: "raw server text", details: [{ reason: "host_job_running" }] } }), { status: 409 }));
    vi.stubGlobal("fetch", fetchFn);
    const { tree, sets } = withHooks(ConfirmAction, { ...base, follow });
    (els(tree).find((e) => e.type === Button)!.props.onClick as () => void)();
    await vi.waitFor(() => expect(sets.map(([, v]) => v)).toContain(en.admin.updates.panel.locked));
    expect(sets.map(([, v]) => v)).not.toContain("raw server text");
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/admin/os-packages/refresh");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-CSRF-Token"]).toBe("csrf");

    vi.useFakeTimers();
    const ok = vi.fn(async (u: string) =>
      new Response(JSON.stringify({ data: u.startsWith("/api/admin/operations/") ? { status: "failed" } : { operationId: "op3" } }), { status: u.startsWith("/api/admin/operations/") ? 200 : 202 }));
    vi.stubGlobal("fetch", ok);
    const second = withHooks(ConfirmAction, { ...base, follow });
    (els(second.tree).find((e) => e.type === Button)!.props.onClick as () => void)();
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(0);
    expect(ok).toHaveBeenCalledWith("/api/admin/operations/op3", { cache: "no-store" });
    expect(second.sets.map(([, v]) => v)).toContain("failed");
  });
});

describe("the seven BFF routes", () => {
  const req = (headers: Record<string, string> = { "Idempotency-Key": "k1" }) =>
    new Request("http://localhost:3000/x", {
      method: "POST",
      headers: { Host: "localhost:3000", Origin: "http://localhost:3000", "X-CSRF-Token": "csrf", "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ reason: "SENTINEL reason" }),
    });
  const p = <K extends string>(k: K, v: string) => ({ params: Promise.resolve({ [k]: v } as Record<K, string>) });

  it("each forwards to its own path, with the key and the body, and to no other", async () => {
    fetchUpstream.mockResolvedValue({ ok: true, status: 202, data: { data: { operationId: "op1" } } });
    const cases: Array<[() => Promise<Response>, string]> = [
      [() => check(req()), "v1/admin/updates/panel/check"],
      [() => applyPanel(req()), "v1/admin/updates/panel/apply"],
      [() => applyComponent(req(), p("component", "sftp")), "v1/admin/updates/components/sftp/apply"],
      [() => imageUpdate(req(), p("siteId", "s1")), "v1/admin/sites/s1/image-update"],
      [() => refresh(req()), "v1/admin/os-packages/refresh"],
      [() => upgrade(req()), "v1/admin/os-packages/upgrade"],
      [() => restartService(req(), p("service", "executor")), "v1/admin/host-services/executor/restart"],
    ];
    for (const [call, path] of cases) {
      fetchUpstream.mockClear();
      expect((await call()).status, path).toBe(202);
      expect(fetchUpstream).toHaveBeenCalledTimes(1);
      expect(fetchUpstream).toHaveBeenCalledWith(path, expect.objectContaining({ method: "POST", idempotencyKey: "k1", accessToken: "tok", body: { reason: "SENTINEL reason" } }));
    }
  });

  it("the check waits 20 s for the release source", async () => {
    fetchUpstream.mockResolvedValue({ ok: true, status: 200, data: { data: {} } });
    await check(req());
    expect(fetchUpstream).toHaveBeenCalledWith("v1/admin/updates/panel/check", expect.objectContaining({ timeoutMs: 20000 }));
  });

  it("a closed name outside its list, a bad segment, no key or a wrong token forward nothing", async () => {
    for (const c of ["api", "docker_engine", "nope", "SFTP", "../x"]) expect((await applyComponent(req(), p("component", c))).status, c).toBe(400);
    for (const s of ["database", "hp-api", "API", "host-agent", "../x"]) expect((await restartService(req(), p("service", s))).status, s).toBe(400);
    expect((await imageUpdate(req(), p("siteId", "../s1"))).status).toBe(400);
    expect((await applyPanel(req({}))).status).toBe(400);
    expect((await upgrade(req({ "Idempotency-Key": "k", "X-CSRF-Token": "bad" }))).status).toBe(403);
    getSessionFromRequest.mockResolvedValue(null);
    expect((await refresh(req())).status).toBe(401);
    expect(fetchUpstream).not.toHaveBeenCalled();
    expect(HOST_SERVICES).toHaveLength(4);
  });

  it("a refusal passes through with its code", async () => {
    fetchUpstream.mockResolvedValue({ ok: false, status: 409, error: { error: { code: "RESOURCE_LOCKED", details: [{ reason: "site_work_running" }] } } });
    const res = await restartService(req(), p("service", "executor"));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("RESOURCE_LOCKED");
  });
});
