import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AdminHealthDtoSchema,
  HEALTH_REASONS,
  HEALTH_STATES,
  PANEL_COMPONENTS,
  PANEL_CONTAINERS,
  SITE_CONTAINER_STATES,
  type AdminHealthDto,
} from "@hosting-panel/contracts";
import type { Messages } from "@/i18n";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { I18nProvider } from "@/i18n/provider";

const fetchUpstream = vi.fn();
const getSessionFromRequest = vi.fn();
const getServerSession = vi.fn();
const getRequestLocale = vi.fn();

vi.mock("@/lib/upstream", async () => ({
  ...(await vi.importActual<object>("@/lib/upstream")),
  fetchUpstream: (...args: unknown[]) => fetchUpstream(...args),
}));
vi.mock("@/lib/server-session", () => ({
  getSessionFromRequest: (...args: unknown[]) => getSessionFromRequest(...args),
  getServerSession: (...args: unknown[]) => getServerSession(...args),
}));
vi.mock("@/i18n/server", () => ({ getRequestLocale: (...args: unknown[]) => getRequestLocale(...args) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/admin/health",
}));

import AdminHealthPage from "@/app/admin/health/page";
import { POST as restartSite } from "@/app/api/admin/sites/[siteId]/restart/route";
import { POST as restartPart } from "@/app/api/admin/panel-containers/[component]/restart/route";
import { GET as readOperation } from "@/app/api/admin/operations/[operationId]/route";
import { RestartButton, RestartForm } from "@/components/admin/restart-dialog";
import { Button } from "@/components/ui/button";
import { SiteActions } from "@/components/customer/site-actions";
import { Dialog } from "@/components/ui/dialog";
import {
  RESTART_FOLLOW_MS,
  RESTART_POLL_MS,
  canOpenTerminal,
  canRestartPart,
  followRestart,
  restartErrorText,
  restartUrl,
  restartWarning,
  type RestartTarget,
} from "@/lib/admin-restart";
import { keyedSend } from "@/lib/keyed-send";

const enNext = /check|fix|use|put|free|try|give|create|reload|save|enter|set up|contact/i;
const itNext = /controlla|correggi|usa|rimetti|libera|riprova|dai|crea|ricarica|salva|inserisci|configura|contatta/i;
const T = "2026-11-14T10:00:00Z";
const html = (m: Messages, child: ReactElement) =>
  renderToStaticMarkup(createElement(I18nProvider, { locale: m === en ? "en" : "it", messages: m, children: child }))
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"');

// Calls a client component once with stand-in hooks; refs live in `refs` across calls, state setters are recorded.
const internals = (React as unknown as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE!;
function withHooks<P>(C: (p: P) => ReactNode, props: P, state: Record<number, unknown> = {}, refs: Record<number, { current: unknown }> = {}) {
  let s = 0;
  let r = 0;
  const sets: Array<[number, unknown]> = [];
  const prev = internals.H;
  internals.H = {
    useState: (v: unknown) => {
      const k = s++;
      return [k in state ? state[k] : v, (x: unknown) => void sets.push([k, x])];
    },
    useRef: (v: unknown) => (refs[r++] ??= { current: v }),
    useContext: () => ({ locale: "en", messages: en }),
  };
  try {
    return { tree: C(props), sets };
  } finally {
    internals.H = prev;
  }
}
type El = ReactElement<Record<string, unknown>>;
const els = (n: unknown): El[] =>
  Array.isArray(n) ? n.flatMap(els) : isValidElement(n) ? [n as El, ...els((n.props as Record<string, unknown>).children)] : [];

const site = (desired: "running" | "stopped"): RestartTarget => ({ kind: "site", siteId: "s1", siteName: "wp-a.example.test", desired });
const part = (component: (typeof PANEL_CONTAINERS)[number]): RestartTarget => ({ kind: "part", component });

beforeEach(() => {
  fetchUpstream.mockReset();
  getSessionFromRequest.mockReset();
  getSessionFromRequest.mockResolvedValue({ accessToken: "tok", csrfToken: "csrf" });
  getServerSession.mockReset();
  getServerSession.mockResolvedValue({ accessToken: "tok", csrfToken: "csrf" });
  getRequestLocale.mockReset();
  getRequestLocale.mockResolvedValue("en");
});
afterEach(() => vi.unstubAllGlobals());

describe("keyedSend", () => {
  it("returns the answer's body on 202 and drops the key", async () => {
    const body = { data: { siteId: "s1", operationId: "op1" } };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 202 })));
    const keys: Record<string, string> = {};
    expect(await keyedSend(keys, "csrf", "n", "POST", "/x", {})).toEqual({ ok: true, data: body });
    expect(keys).toEqual({});
  });
});

describe("restart rules and texts", () => {
  it("canRestartPart: a panel container in use and present, nothing else", () => {
    for (const component of PANEL_COMPONENTS)
      for (const state of HEALTH_STATES)
        for (const reason of [null, ...HEALTH_REASONS]) {
          const want = (PANEL_CONTAINERS as readonly string[]).includes(component)
            && state !== "not_in_use" && reason !== "missing" && reason !== "runtime_disabled";
          expect(canRestartPart({ component, state, reason, observedAt: null }), `${component} ${state} ${reason}`).toBe(want);
        }
  });

  it("canOpenTerminal only on running or degraded", () => {
    expect(SITE_CONTAINER_STATES.filter(canOpenTerminal)).toEqual(["running", "degraded"]);
  });

  it("restartUrl names the BFF route of each target", () => {
    expect(restartUrl(site("running"))).toBe("/api/admin/sites/s1/restart");
    expect(restartUrl(part("sftp"))).toBe("/api/admin/panel-containers/sftp/restart");
  });

  it("restartWarning: the target's own warning, plus the stopped sentence for a site wanted stopped", () => {
    for (const m of [en, itMsgs]) {
      const w = m.admin.health.restart.warn;
      expect(restartWarning(m, site("running"))).toBe(w.site.replace("{name}", "wp-a.example.test"));
      expect(restartWarning(m, site("stopped"))).toBe(
        `${w.site.replace("{name}", "wp-a.example.test")} ${w.siteStopped.replace("{name}", "wp-a.example.test")}`,
      );
      for (const c of PANEL_CONTAINERS) expect(restartWarning(m, part(c))).toBe(w[c]);
    }
  });

  it("restartErrorText: a sentence with a next step for every refusal, in en and it", () => {
    for (const [m, re] of [[en, enNext], [itMsgs, itNext]] as const) {
      const r = m.admin.health.restart;
      const f = (s: string) => s.replace("{name}", "SFTP");
      expect(restartErrorText(m, "SFTP", "VALIDATION_ERROR")).toBe(r.reasonRequired);
      expect(restartErrorText(m, "SFTP", "NOT_FOUND")).toBe(f(r.notFound));
      expect(restartErrorText(m, "SFTP", "RESOURCE_LOCKED")).toBe(f(r.locked));
      expect(restartErrorText(m, "SFTP", "PANEL_CONTAINER_ABSENT")).toBe(f(r.absent));
      expect(restartErrorText(m, "SFTP", "")).toBe(m.errors.generic);
      for (const code of ["VALIDATION_ERROR", "NOT_FOUND", "RESOURCE_LOCKED", "PANEL_CONTAINER_ABSENT", "INTERNAL_ERROR", ""])
        expect(restartErrorText(m, "SFTP", code)).toMatch(re);
    }
  });
});

describe("followRestart", () => {
  const clock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  };
  const answers = (...items: (string | Error)[]) => {
    const fetchFn = vi.fn(async () => {
      const next = items.length > 1 ? items.shift()! : items[0]!;
      if (next instanceof Error) throw next;
      return new Response(JSON.stringify({ data: { status: next } }), { status: 200 });
    });
    return fetchFn as unknown as typeof fetch & typeof fetchFn;
  };

  it("succeeds after a failed read and a running one, polling the operation every 2 s", async () => {
    const c = clock();
    const f = answers(new Error("offline"), "processing", "succeeded");
    expect(await followRestart("op1", { fetch: f, ...c })).toBe("succeeded");
    expect(f).toHaveBeenCalledTimes(3);
    expect((f.mock.calls[0] as unknown[])[0]).toBe("/api/admin/operations/op1");
    expect(c.now()).toBe(3 * RESTART_POLL_MS);
  });

  it("failed and cancelled count as failed", async () => {
    expect(await followRestart("op1", { fetch: answers("failed"), ...clock() })).toBe("failed");
    expect(await followRestart("op1", { fetch: answers("cancelled"), ...clock() })).toBe("failed");
  });

  it("unknown after 180 s without an end, even when reads fail", async () => {
    const c = clock();
    expect(await followRestart("op1", { fetch: answers("processing"), ...c })).toBe("unknown");
    expect(c.now()).toBe(RESTART_FOLLOW_MS);
    const d = clock();
    const notOk = vi.fn(async () => new Response("{}", { status: 502 })) as unknown as typeof fetch;
    expect(await followRestart("op1", { fetch: notOk, ...d })).toBe("unknown");
  });
});

describe("restart BFF routes", () => {
  const req = (url: string, method: string, headers: Record<string, string> = {}, body?: string) =>
    new Request(`http://localhost:3000${url}`, {
      method,
      headers: { Host: "localhost:3000", Origin: "http://localhost:3000", "X-CSRF-Token": "csrf", "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body }),
    });
  const siteParams = (siteId: string) => ({ params: Promise.resolve({ siteId }) });
  const partParams = (component: string) => ({ params: Promise.resolve({ component }) });
  const opParams = (operationId: string) => ({ params: Promise.resolve({ operationId }) });
  const reason = JSON.stringify({ reason: "  Upload stuck <b>è</b>  " });

  it("site restart forwards the key and the body as they are", async () => {
    fetchUpstream.mockResolvedValue({ ok: true, status: 202, data: { data: { siteId: "s1", operationId: "op1" } } });
    const res = await restartSite(req("/x", "POST", { "Idempotency-Key": "k1" }, reason), siteParams("s1"));
    expect(res.status).toBe(202);
    expect(fetchUpstream).toHaveBeenCalledWith(
      "v1/admin/sites/s1/restart",
      expect.objectContaining({ method: "POST", idempotencyKey: "k1", body: JSON.parse(reason), accessToken: "tok" }),
    );
  });

  it("site restart refuses no key, a wrong CSRF token, another origin, no session and a bad segment, without calling upstream", async () => {
    expect((await restartSite(req("/x", "POST", {}, reason), siteParams("s1"))).status).toBe(400);
    expect((await restartSite(req("/x", "POST", { "Idempotency-Key": "k", "X-CSRF-Token": "bad" }, reason), siteParams("s1"))).status).toBe(403);
    expect((await restartSite(req("/x", "POST", { "Idempotency-Key": "k", Origin: "http://evil.example.test" }, reason), siteParams("s1"))).status).toBe(403);
    expect((await restartSite(req("/x", "POST", { "Idempotency-Key": "k" }, reason), siteParams("../s1"))).status).toBe(400);
    getSessionFromRequest.mockResolvedValue(null);
    expect((await restartSite(req("/x", "POST", { "Idempotency-Key": "k" }, reason), siteParams("s1"))).status).toBe(401);
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("panel restart accepts only a panel container; anything else is 400 with no upstream call", async () => {
    for (const c of ["api", "web", "docker_engine", "nope", "SFTP"])
      expect((await restartPart(req("/x", "POST", { "Idempotency-Key": "k" }, reason), partParams(c))).status, c).toBe(400);
    expect((await restartPart(req("/x", "POST", { "Idempotency-Key": "k", "X-CSRF-Token": "bad" }, reason), partParams("sftp"))).status).toBe(403);
    expect((await restartPart(req("/x", "POST", {}, reason), partParams("sftp"))).status).toBe(400);
    expect(fetchUpstream).not.toHaveBeenCalled();

    fetchUpstream.mockResolvedValue({ ok: false, status: 409, error: { error: { code: "PANEL_CONTAINER_ABSENT" } } });
    const res = await restartPart(req("/x", "POST", { "Idempotency-Key": "k2" }, reason), partParams("sftp"));
    expect(res.status).toBe(409);
    expect(fetchUpstream).toHaveBeenCalledWith(
      "v1/admin/panel-containers/sftp/restart",
      expect.objectContaining({ method: "POST", idempotencyKey: "k2", body: JSON.parse(reason) }),
    );
  });

  it("operation read waits 8 s, needs a session and checks its segment", async () => {
    fetchUpstream.mockResolvedValue({ ok: true, status: 200, data: { data: { status: "succeeded" } } });
    expect((await readOperation(req("/x", "GET"), opParams("op1"))).status).toBe(200);
    expect(fetchUpstream).toHaveBeenCalledWith("v1/admin/operations/op1", expect.objectContaining({ method: "GET", timeoutMs: 8000 }));
    fetchUpstream.mockClear();
    expect((await readOperation(req("/x", "GET"), opParams("a/b"))).status).toBe(400);
    getSessionFromRequest.mockResolvedValue(null);
    expect((await readOperation(req("/x", "GET"), opParams("op1"))).status).toBe(401);
    expect(fetchUpstream).not.toHaveBeenCalled();
  });
});

describe("Health page actions and the dialog", () => {
  const health = (): AdminHealthDto =>
    AdminHealthDtoSchema.parse({
      generatedAt: T,
      components: PANEL_COMPONENTS.map((component) => ({
        component,
        state: component === "phpmyadmin" ? "not_in_use" : component === "mail_relay" ? "down" : "ok",
        reason: component === "mail_relay" ? "missing" : null,
        observedAt: T,
      })),
      siteContainers: (["running", "stopped", "degraded", "missing", "unknown"] as const).map((observed, i) => ({
        siteId: `s${i}`, siteName: `wp-${i}.example.test`, organizationName: null, desired: i === 1 ? "stopped" : "running",
        observed, driftReason: null, restartCount: 0, observedAt: T, stale: false,
      })),
      disks: [],
    });
  const upstream = (h: AdminHealthDto) =>
    fetchUpstream.mockImplementation(async (path: string) => ({ ok: true, status: 200, data: { data: path === "v1/admin/health" ? h : [] } }));

  it("Restart on panel rows that can restart and on every site row; Terminal only on running or degraded", async () => {
    upstream(health());
    const h = html(en, await AdminHealthPage());
    const t = en.admin.health;
    expect(h.match(new RegExp(`>${t.colActions}<`, "g"))).toHaveLength(2);
    for (const c of ["ingress_proxy", "shared_database", "sftp"] as const)
      expect(h).toContain(`aria-label="Restart ${t.components[c]}"`);
    for (const c of ["phpmyadmin", "mail_relay", "api", "web", "database", "executor", "host_agent", "docker_engine"] as const)
      expect(h).not.toContain(`aria-label="Restart ${t.components[c]}"`);
    for (let i = 0; i < 5; i++) expect(h).toContain(`aria-label="Restart wp-${i}.example.test"`);
    expect(h).toContain('href="/admin/sites/s0/terminal"');
    expect(h).toContain('href="/admin/sites/s2/terminal"');
    for (const i of [1, 3, 4]) expect(h).not.toContain(`href="/admin/sites/s${i}/terminal"`);
    expect(h).toContain('aria-label="Open the terminal of wp-0.example.test"');
  });

  it("after 202 the trigger keeps focus but opens nothing; idle it opens the dialog", () => {
    const trigger = (phase: string | null) => els(withHooks(RestartButton, { target: part("sftp"), csrfToken: "csrf" }, { 1: phase }).tree).find((e) => e.type === Button)!;
    const accepted = trigger("accepted");
    expect(accepted.props.disabled).toBeUndefined();
    expect(accepted.props["aria-disabled"]).toBe(true);
    const click = { preventDefault: vi.fn() };
    (accepted.props.onClick as (e: unknown) => void)(click);
    expect(click.preventDefault).toHaveBeenCalled();
    for (const phase of [null, "succeeded", "failed", "unknown"]) {
      const idle = trigger(phase);
      const c = { preventDefault: vi.fn() };
      (idle.props.onClick as (e: unknown) => void)(c);
      expect(c.preventDefault, String(phase)).not.toHaveBeenCalled();
      expect(idle.props["aria-disabled"]).toBe(false);
    }
  });

  it("the dialog cannot be closed while the restart is being sent, and can after a refusal", async () => {
    let answer!: (r: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((res) => (answer = res))));
    const refs = {};
    const { tree, sets } = withHooks(RestartButton, { target: part("sftp"), csrfToken: "csrf" }, {}, refs);
    const dialog = els(tree).find((e) => e.type === Dialog)!;
    const onOpenChange = dialog.props.onOpenChange as (o: boolean) => void;
    const sent = (els(tree).find((e) => e.type === RestartForm)!.props.onConfirm as (r: string) => Promise<string | null>)("disk full");
    onOpenChange(false);
    expect(sets).toEqual([]);
    answer(new Response(JSON.stringify({ error: { code: "RESOURCE_LOCKED", message: "m", requestId: "r", retryable: false, details: [] } }), { status: 409 }));
    expect(await sent).toContain(en.admin.health.components.sftp);
    onOpenChange(false);
    expect(sets).toEqual([[0, false]]);
  });

  it("the form: title, warning as description, a required reason of at most 500 with its hint tied", () => {
    for (const m of [en, itMsgs]) {
      const r = m.admin.health.restart;
      const h = html(m, createElement(Dialog, { open: true }, createElement(RestartForm, { target: site("stopped"), onConfirm: async () => null, onCancel: () => {} })));
      expect(h).toContain(r.title.replace("{name}", "wp-a.example.test"));
      expect(h).toContain(restartWarning(m, site("stopped")));
      expect(h).toMatch(/<textarea[^>]*required=""/);
      expect(h).toMatch(/<textarea[^>]*maxLength="500"/);
      const hintId = /<textarea[^>]*aria-describedby="([^"]+)"/.exec(h)![1]!;
      expect(h).toContain(`id="${hintId}"`);
      expect(h).toContain(r.reasonHint);
      expect(h).toContain(r.reasonLabel);
      expect(h).toContain(r.confirm);
      expect(h).toContain(m.common.cancel);
    }
  });
});

describe("site actions while stopped", () => {
  const render = (status: "stopped" | "ready") =>
    html(en, createElement(SiteActions, { orgId: "o1", siteId: "s1", siteName: "wp-a.example.test", status, phpVersion: "8.3", csrfToken: "csrf" }));
  // Without a DOM the button starts disabled in both cases (same version picked); the reason on screen is what differs.
  it("Change version shows why it is disabled while the site is stopped", () => {
    const h = render("stopped");
    expect(h).toContain(en.site.manage.phpStopped);
    expect(h).not.toContain(en.site.manage.phpHint);
    const r = render("ready");
    expect(r).toContain(en.site.manage.phpHint);
    expect(r).not.toContain(en.site.manage.phpStopped);
  });
});
