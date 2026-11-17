import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AdminHealthDtoSchema,
  HEALTH_REASONS,
  HEALTH_STATES,
  HOST_SERVICES,
  HOST_SERVICE_UNIT,
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
  restartName,
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
const service = (s: (typeof HOST_SERVICES)[number]): RestartTarget => ({ kind: "service", service: s });

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

  it("a 200 and a 201 succeed and drop the key", async () => {
    for (const status of [200, 201]) {
      const body = { data: { baseRules: "current" } };
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
      const keys: Record<string, string> = {};
      expect(await keyedSend(keys, "csrf", "n", "POST", "/x", {})).toEqual({ ok: true, data: body });
      expect(keys).toEqual({});
    }
  });

  it("a refusal gives back the reason of its first detail, and none without details", async () => {
    const refusal = { error: { code: "VALIDATION_ERROR", details: [{ field: "address", reason: "overlaps" }, { field: "note", reason: "note_invalid" }] } };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(refusal), { status: 400 })));
    expect(await keyedSend({}, "csrf", "n", "POST", "/x", {})).toEqual({ ok: false, code: "VALIDATION_ERROR", reason: "overlaps" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "RESOURCE_LOCKED" } }), { status: 409 })));
    const bare = await keyedSend({}, "csrf", "n", "POST", "/x", {});
    expect(bare).toEqual({ ok: false, code: "RESOURCE_LOCKED" });
    expect(bare.ok === false && bare.reason).toBeUndefined();
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

  it("the four services: their BFF route, their name and their own warning", () => {
    for (const s of HOST_SERVICES) {
      expect(restartUrl(service(s))).toBe(`/api/admin/host-services/${s}/restart`);
      for (const m of [en, itMsgs]) {
        expect(restartName(m, service(s))).toBe(m.admin.health.components[s]);
        expect(restartWarning(m, service(s))).toBe(m.admin.health.restart.warn[s]);
      }
    }
  });

  it("restartErrorText: a lock gets its own sentence for site work and for another server job", () => {
    for (const m of [en, itMsgs]) {
      const r = m.admin.health.restart;
      expect(restartErrorText(m, "X", "RESOURCE_LOCKED", "site_work_running")).toBe(r.siteWork);
      expect(restartErrorText(m, "X", "RESOURCE_LOCKED", "host_job_running")).toBe(r.hostJob);
      expect(restartErrorText(m, "X", "RESOURCE_LOCKED", "other")).toBe(r.locked.replace("{name}", "X"));
      expect(restartErrorText(m, "X", "NOT_FOUND", "host_job_running")).toBe(r.notFound.replace("{name}", "X"));
      expect(new Set([r.siteWork, r.hostJob, r.locked]).size).toBe(3);
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

describe("followRestart with a follow time", () => {
  const LONG = 30 * 60_000;
  const timed = (fail: (t: number) => Response | Error | null, end: string) => {
    let t = 0;
    const fetchFn = vi.fn(async () => {
      const r = fail(t);
      if (r instanceof Error) throw r;
      return r ?? new Response(JSON.stringify({ data: { status: end } }), { status: 200 });
    }) as unknown as typeof fetch;
    return { fetch: fetchFn, now: () => t, sleep: async (ms: number) => void (t += ms) };
  };

  it("reads that fail for minutes, then an end, still give succeeded", async () => {
    const away = (t: number) => (t < 5 * 60_000 ? (t % 3 ? new Response("{}", { status: 502 }) : new Error("offline")) : null);
    expect(await followRestart("op1", timed(away, "succeeded"), LONG)).toBe("succeeded");
    expect(await followRestart("op1", timed((t) => (t < 5 * 60_000 ? new Response("{}", { status: 504 }) : null), "failed"), LONG)).toBe("failed");
  });

  it("the deadline is the given time, and without a terminal status the end is unknown, never failed", async () => {
    for (const fail of [() => new Response("{}", { status: 502 }), () => new Error("x"), () => new Response("not json", { status: 200 }), () => null]) {
      const d = timed(fail, "processing");
      expect(await followRestart("op1", d, LONG)).toBe("unknown");
      expect(d.now()).toBe(LONG);
    }
    const shipped = timed(() => null, "processing");
    expect(await followRestart("op1", shipped)).toBe("unknown");
    expect(shipped.now()).toBe(RESTART_FOLLOW_MS);
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
      hostServices: null,
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

  it("the services card: one sentence when they cannot be read; otherwise state, since, restarts, journal and Restart", async () => {
    for (const m of [en, itMsgs]) {
      getRequestLocale.mockResolvedValue(m === en ? "en" : "it");
      const t = m.admin.health;
      upstream(health());
      const none = html(m, await AdminHealthPage());
      expect(none).toContain(t.services.title);
      expect(none).toContain(t.services.unreadable);
      for (const s of HOST_SERVICES) expect(none).not.toContain(`source=${HOST_SERVICE_UNIT[s]}`);

      const filled = { ...health(), hostServices: HOST_SERVICES.map((s, i) => ({
        service: s, active: s !== "executor", activeState: s === "executor" ? "failed" : "active", since: i ? T : null, restarts: i + 7,
      })) };
      upstream(filled);
      const page = html(m, await AdminHealthPage());
      const h = page.slice(page.indexOf(t.services.title), page.indexOf(t.sitesTitle));
      expect(page.indexOf(t.partsTitle)).toBeLessThan(page.indexOf(t.services.title));
      expect(h).not.toContain(t.services.unreadable);
      expect(h.split(`>${t.services.running}<`)).toHaveLength(4);
      expect(h).toContain(`>${t.services.stopped.replace("{state}", "failed")}<`);
      expect(h).toContain(`>${t.services.colSince}<`);
      for (const [i, s] of HOST_SERVICES.entries()) {
        expect(h).toContain(`href="/admin/logs?source=${HOST_SERVICE_UNIT[s]}"`);
        expect(h).toContain(`aria-label="${t.restart.buttonLabel.replace("{name}", t.components[s])}"`);
        expect(h).toContain(`>${i + 7}<`);
      }
    }
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
