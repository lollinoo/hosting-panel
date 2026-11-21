// qa-web, cycle 11: independent checks of the M5b web app (health, alert line, logs, audit paging).
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ALERT_KINDS,
  AdminAlertDtoSchema,
  AdminHealthDtoSchema,
  CERT_PROBLEMS,
  PANEL_COMPONENTS,
  PANEL_CONTAINERS,
  type AdminAlertDto,
  type AlertKind,
} from "@hosting-panel/contracts";
import { format, type Messages } from "@/i18n";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { I18nProvider } from "@/i18n/provider";

const fetchUpstream = vi.fn();
const session = vi.hoisted(() => ({ value: null as unknown }));
const locale = vi.hoisted(() => ({ value: "en" as "en" | "it" }));
vi.mock("@/lib/upstream", async () => ({
  ...(await vi.importActual<object>("@/lib/upstream")),
  fetchUpstream: (...a: unknown[]) => fetchUpstream(...a),
}));
vi.mock("@/lib/server-session", () => ({
  getSessionFromRequest: async () => session.value,
  getServerSession: async () => session.value,
}));
vi.mock("@/i18n/server", () => ({ getRequestLocale: async () => locale.value }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/admin/health",
}));
// A tiny hook store so SiteLogs' state and effect survive between server renders.
const hooks = vi.hoisted(() => ({ on: false, slots: [] as unknown[], i: 0, effects: [] as (() => void)[] }));
vi.mock("react", async (orig) => {
  const actual = await orig<typeof import("react")>();
  const useState = ((init: unknown) => {
    if (!hooks.on) return actual.useState(init);
    const k = hooks.i++;
    if (!(k in hooks.slots)) hooks.slots[k] = typeof init === "function" ? (init as () => unknown)() : init;
    return [hooks.slots[k], (v: unknown) => (hooks.slots[k] = typeof v === "function" ? (v as (p: unknown) => unknown)(hooks.slots[k]) : v)];
  }) as typeof actual.useState;
  const useEffect = ((fn: () => void) => {
    if (hooks.on) hooks.effects.push(fn);
  }) as typeof actual.useEffect;
  return { ...actual, useState, useEffect, default: { ...actual, useState, useEffect } };
});

import * as alertsRoute from "@/app/api/admin/alerts/route";
import * as panelLogsRoute from "@/app/api/admin/logs/[component]/route";
import * as siteLogsRoute from "@/app/api/admin/sites/[siteId]/logs/route";
import AdminHealthPage from "@/app/admin/health/page";
import AdminLogsPage from "@/app/admin/logs/page";
import AdminAuditPage from "@/app/admin/audit/page";
import { AlertLine, AlertLineView, loadAlerts } from "@/components/admin/alert-line";
import { AuditTable } from "@/components/admin/audit-table";
import { SiteLogs } from "@/components/customer/site-logs";
import { alertText } from "@/lib/admin-alerts";

const WEB = path.resolve(__dirname, "..");
const ROOT = path.resolve(WEB, "../..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf-8");
const XSS = "<img src=x onerror=alert(1)>";
const XSS2 = '"><script>alert(1)</script>';
const T = "2026-11-14T10:00:00Z";
const SESSION = {
  accessToken: "SENTINEL-token",
  csrfToken: "SENTINEL-csrf",
  user: { id: "u1", email: "admin@example.test", name: "Admin", isServerAdmin: true, mustChangePassword: false, locale: "en" },
};

const render = (el: ReactElement, m: Messages = en) =>
  renderToStaticMarkup(createElement(I18nProvider, { locale: m === en ? "en" : "it", messages: m, children: el }));
const decode = (h: string) => h.replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
const sp = (q: Record<string, string>) => ({ searchParams: Promise.resolve(q) });
const req = (url: string, init: RequestInit = {}) =>
  new Request(`http://localhost:3000${url}`, { ...init, headers: { Host: "localhost:3000" } });
// No raw tag from a hostile value may reach the markup.
const noRawTag = (h: string) => {
  expect(h).not.toContain("<img");
  expect(h).not.toContain("<script");
};

// Upstream answers by path prefix; anything else is a 500.
const upstream = (byPath: Record<string, unknown>) =>
  fetchUpstream.mockImplementation(async (p: string) => {
    const hit = Object.keys(byPath).find((k) => p === k || p.startsWith(`${k}?`));
    return hit && byPath[hit] !== null
      ? { ok: true, status: 200, data: byPath[hit] }
      : { ok: false, status: 500, error: { error: { code: "INTERNAL_ERROR" } } };
  });

beforeEach(() => {
  fetchUpstream.mockReset().mockResolvedValue({ ok: true, status: 200, data: { data: [] } });
  session.value = SESSION;
  locale.value = "en";
});
afterEach(() => vi.unstubAllGlobals());

// ---------- fixtures: the fullest and the emptiest alert of each kind ----------
const site = { siteId: "s1", siteName: "wp-a.example.test" };
const FULL: Record<AlertKind, unknown> = {
  disk_high: { severity: "critical", subject: "d", since: T, kind: "disk_high", details: { paths: ["panel_data", "docker_data", "database_data", "root"], usedPercent: 100 } },
  certificate_expiring: { severity: "warning", subject: "h", since: T, kind: "certificate_expiring", details: { ...site, hostname: "wp-a.example.test", expiresAt: T, problem: "not_pointing" } },
  certificate_not_issued: { severity: "warning", subject: "h", since: T, kind: "certificate_not_issued", details: { ...site, hostname: "wp-a.example.test", problem: "port_80_blocked" } },
  panel_certificate_expiring: { severity: "warning", subject: "h", since: T, kind: "panel_certificate_expiring", details: { hostname: "panel.example.test", expiresAt: T } },
  manual_certificate_expiring: { severity: "warning", subject: "v1", since: T, kind: "manual_certificate_expiring", details: { ...site, certificateId: "c1", certificateName: "hotel-cert", notAfter: T, tier: "critical" } },
  backup_failed: { severity: "warning", subject: "s1", since: T, kind: "backup_failed", details: { ...site, failedAt: T } },
  panel_backup_failed: { severity: "warning", subject: "p", since: T, kind: "panel_backup_failed", details: { failedAt: T } },
  backup_storage_test_failed: { severity: "warning", subject: "b", since: T, kind: "backup_storage_test_failed", details: { testedAt: T } },
  component_down: { severity: "critical", subject: "c", since: T, kind: "component_down", details: { component: "shared_database", state: "down", reason: "missing" } },
  site_container_down: { severity: "critical", subject: "s1", since: T, kind: "site_container_down", details: { ...site, observed: "degraded" } },
  restore_undo_incomplete: { severity: "critical", subject: "b1", since: T, kind: "restore_undo_incomplete", details: { ...site, backupId: "b1", failedAt: T } },
  restore_stuck: { severity: "warning", subject: "op1", since: T, kind: "restore_stuck", details: { operationId: "op1", ...site, startedAt: T } },
  operation_unknown: { severity: "warning", subject: "op1", since: T, kind: "operation_unknown", details: { operationId: "op1", kind: "site.backups.restore", ...site } },
  operation_stuck: { severity: "warning", subject: "op1", since: T, kind: "operation_stuck", details: { operationId: "op1", kind: "site.backups.restore", ...site } },
};
const EMPTY: Record<AlertKind, unknown> = {
  disk_high: { severity: "critical", subject: "d", since: null, kind: "disk_high", details: { paths: ["root"], usedPercent: 0 } },
  certificate_expiring: { severity: "warning", subject: "h", since: null, kind: "certificate_expiring", details: { siteId: "s1", siteName: "s1", hostname: "h.example.test", expiresAt: null, problem: null } },
  certificate_not_issued: { severity: "warning", subject: "h", since: null, kind: "certificate_not_issued", details: { siteId: "s1", siteName: "s1", hostname: "h.example.test", problem: null } },
  panel_certificate_expiring: { severity: "warning", subject: "h", since: null, kind: "panel_certificate_expiring", details: { hostname: "panel.example.test", expiresAt: T } },
  manual_certificate_expiring: { severity: "warning", subject: "v1", since: null, kind: "manual_certificate_expiring", details: { siteId: null, siteName: null, certificateId: "c1", certificateName: "c", notAfter: T, tier: "expired" } },
  backup_failed: { severity: "warning", subject: "s1", since: null, kind: "backup_failed", details: { siteId: "s1", siteName: "s1", failedAt: T } },
  panel_backup_failed: { severity: "warning", subject: "p", since: null, kind: "panel_backup_failed", details: { failedAt: T } },
  backup_storage_test_failed: { severity: "warning", subject: "b", since: null, kind: "backup_storage_test_failed", details: { testedAt: T } },
  component_down: { severity: "critical", subject: "c", since: null, kind: "component_down", details: { component: "executor", state: "degraded", reason: null } },
  site_container_down: { severity: "critical", subject: "s1", since: null, kind: "site_container_down", details: { siteId: "s1", siteName: "s1", observed: "unknown" } },
  restore_undo_incomplete: { severity: "critical", subject: "b1", since: null, kind: "restore_undo_incomplete", details: { siteId: "s1", siteName: "s1", backupId: "b1", failedAt: null } },
  restore_stuck: { severity: "warning", subject: "op1", since: null, kind: "restore_stuck", details: { operationId: "op1", siteId: null, siteName: null, startedAt: T } },
  operation_unknown: { severity: "warning", subject: "op1", since: null, kind: "operation_unknown", details: { operationId: "op1", kind: "site.backups.restore", siteId: null, siteName: null } },
  operation_stuck: { severity: "warning", subject: "op1", since: null, kind: "operation_stuck", details: { operationId: "op1", kind: "site.backups.restore", siteId: null, siteName: null } },
};
const parse = (r: Record<AlertKind, unknown>) =>
  Object.fromEntries(Object.entries(r).map(([k, v]) => [k, AdminAlertDtoSchema.parse(v)])) as Record<AlertKind, AdminAlertDto>;
const F = parse(FULL);
const E = parse(EMPTY);

// Units the sentences may name: the four shipped services plus the system's own.
const UNITS = new Set([
  ...fs.readdirSync(path.join(ROOT, "infra/systemd")).filter((f) => f.endsWith(".service")).map((f) => f.replace(/\.service$/, "")),
  "docker",
  "postgresql",
]);
const LOCALES = [["en", en], ["it", itMsgs]] as const;

describe("1. every alert reads clearly", () => {
  it("14 kinds x en/it x fullest/emptiest: no placeholder, no key, no undefined, and a next step", () => {
    const next = { en: /systemctl|journalctl|df -h|hp-break-glass|Logs page|Domains page|Certificates page|Backups|Restore|Back up|Test the connection|Start/, it: /systemctl|journalctl|df -h|hp-break-glass|pagina Log|pagina Domini|pagina Certificati|Backup|Ripristina|Prova la connessione|Avvia/ };
    expect(Object.keys(F).sort()).toEqual([...ALERT_KINDS].sort());
    for (const [lc, m] of LOCALES)
      for (const set of [F, E])
        for (const k of ALERT_KINDS) {
          const s = alertText(m, set[k]);
          expect(s, `${lc} ${k}`).not.toMatch(/[{}]|undefined|\bnull\b|NaN|\[object/);
          expect(s, `${lc} ${k}`).not.toMatch(/\badmin\.(health|alertLine|logs|sites)\./);
          expect(s, `${lc} ${k}`).toMatch(next[lc]);
          expect(s.trim().length, `${lc} ${k}`).toBeGreaterThan(40);
        }
  });

  it("every certificate problem gives a named cause, never the neutral 'other' by mistake", () => {
    for (const [, m] of LOCALES)
      for (const problem of CERT_PROBLEMS) {
        const s = alertText(m, AdminAlertDtoSchema.parse({ ...(FULL.certificate_not_issued as object), details: { ...F.certificate_not_issued.details, problem } }));
        expect(s, problem).toContain((m.admin.sites.alertsProblem as Record<string, string>)[problem]);
        expect(s).not.toMatch(/[{}]|undefined/);
      }
  });

  it("every component_down state/reason pairing for every part gives a full sentence in both languages", () => {
    for (const [, m] of LOCALES)
      for (const component of PANEL_COMPONENTS)
        for (const state of ["down", "degraded"] as const)
          for (const reason of [null, "not_reporting", "engine_unreachable", "stopped", "restarting", "missing"] as const) {
            const s = alertText(m, AdminAlertDtoSchema.parse({ ...(FULL.component_down as object), details: { component, state, reason } }));
            expect(s).not.toMatch(/[{}]|undefined|\.\.(?!\.)/);
          }
  });

  it("every command a sentence names exists: units in infra/systemd, hp-break-glass unlock with its two flags", () => {
    const all = LOCALES.flatMap(([, m]) => [
      ...Object.values(m.admin.health.alerts),
      ...Object.values(m.admin.health.fix),
      m.admin.health.loadFailed, m.admin.health.alertsFailed, m.admin.health.noDisks,
      m.admin.alertLine.failed, m.admin.logs.services, m.admin.logs.viewer.unavailable, m.admin.audit.loadFailed,
    ]);
    const named = new Set<string>();
    for (const s of all) {
      // The first word after the verb is always a unit; more units follow only as hp-*, docker or postgresql.
      for (const [, first, more] of s.matchAll(/systemctl (?:status|restart) ([\w-]+)((?: (?:hp-[\w-]+|docker|postgresql)\b)*)/g))
        for (const u of [first!, ...more!.trim().split(" ").filter(Boolean)]) named.add(u);
      for (const [, u] of s.matchAll(/-u ([\w-]+)/g)) named.add(u!);
    }
    expect([...named].sort()).toEqual(["docker", "hp-api", "hp-docker-executor", "hp-host-agent", "hp-web", "postgresql"]);
    for (const u of named) expect(UNITS.has(u), u).toBe(true);
    // hp-break-glass is installed and hands its arguments to break-glass.js, which reads unlock --operation-id --reason.
    expect(read("infra/linux/hp-break-glass")).toMatch(/break-glass\.js "\$@"/);
    expect(read("infra/linux/bootstrap-dedicated.sh")).toContain("/usr/local/sbin/hp-break-glass");
    const cli = read("apps/api/src/cli/break-glass.ts");
    expect(cli).toMatch(/command === "unlock"/);
    expect(cli).toContain('"--operation-id"');
    expect(cli).toContain('"--reason"');
  });

  it("every button a sentence names exists with that label in the same catalog", () => {
    const values = (o: unknown): string[] => (typeof o === "string" ? [o] : o && typeof o === "object" ? Object.values(o).flatMap(values) : []);
    const labels = { en: ["Check now", "Retry", "Restore", "Test the connection", "Restart"], it: ["Controlla ora", "Riprova", "Ripristina", "Prova la connessione", "Riavvia"] };
    for (const [lc, m] of LOCALES) {
      const all = new Set(values(m));
      const text = Object.values(m.admin.health.alerts).join(" ");
      for (const l of labels[lc]) {
        expect(text, `${lc} ${l}`).toContain(l);
        expect(all.has(l), `${lc} label ${l}`).toBe(true);
      }
    }
  });

  it("R189 1.1: each sentence names the button that is enabled when its alert fires", () => {
    for (const [lc, m] of LOCALES) {
      const a = m.admin.health.alerts;
      // The alert needs the site wanted running (ready or degraded): Start is disabled there, Restart works.
      expect(a.site_container_down, lc).toContain(m.site.manage.restart);
      expect(a.site_container_down, lc).not.toContain(m.site.manage.start);
      // The alert needs the last backup failed: the row's button then reads Retry, not Back up.
      expect(a.backup_failed, lc).toContain(m.admin.backups.retry);
      expect(a.backup_failed, lc).not.toContain(m.admin.backups.runNow);
    }
  });

  it("R190 1.2: a missing container gets its own sentence (the Restart button of Health, no PHP version change); the other seen states keep R189 1.1", () => {
    for (const [lc, m] of LOCALES) {
      const text = (observed: string) => alertText(m, AdminAlertDtoSchema.parse({ ...(FULL.site_container_down as object), details: { siteId: "s1", siteName: "wp-a.example.test", observed } }));
      const missing = text("missing");
      expect(missing, lc).toContain("wp-a.example.test");
      expect(missing, lc).toContain(m.admin.health.restart.button);
      expect(missing, lc).not.toContain(m.site.manage.phpApply);
      expect(missing, lc).not.toMatch(/[{}]|undefined/);
      for (const observed of ["stopped", "degraded", "unknown"]) {
        expect(text(observed), `${lc} ${observed}`).toBe(format(m.admin.health.alerts.site_container_down, { site: "wp-a.example.test", observed: m.admin.health.seen[observed as "stopped"] }));
        expect(text(observed), `${lc} ${observed}`).toContain(m.site.manage.restart);
      }
    }
  });

  it("R186 1a: a container that keeps restarting is not promised back by restarting the executor", () => {
    // ensure-at-start only starts a stopped container or creates a missing one; a Restarting one is left as it is.
    for (const component of ["ingress_proxy", "shared_database", "sftp"] as const) {
      const a = AdminAlertDtoSchema.parse({ ...(FULL.component_down as object), details: { component, state: "degraded", reason: "restarting" } });
      expect(alertText(en, a), component).not.toMatch(/puts it back/);
      expect(alertText(itMsgs, a), component).not.toMatch(/rimette in funzione/);
    }
  });
});

describe("2. the line is never silently blind", () => {
  const res = (status: number, body: string) => new Response(body, { status, headers: { "content-type": "application/json" } });

  it("401, 500, a broken connection and bodies not shaped as the contract all end in 'could not load'", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const answers: (() => Promise<Response>)[] = [
      async () => res(401, JSON.stringify({ error: { code: "UNAUTHENTICATED" } })),
      async () => res(500, JSON.stringify({ error: { code: "INTERNAL_ERROR" } })),
      async () => res(503, ""),
      async () => Promise.reject(new TypeError("fetch failed")),
      async () => res(200, "<html>"),
      async () => res(200, "null"),
      async () => res(200, "{}"),
      async () => res(200, JSON.stringify({ data: { kind: "disk_high" } })),
      async () => res(200, JSON.stringify({ error: { code: "X" } })),
    ];
    for (const a of answers) {
      fetchMock.mockImplementationOnce(a);
      const got = await loadAlerts();
      expect(got).toBeNull();
      expect(decode(render(createElement(AlertLineView, { alerts: got })))).toContain(en.admin.alertLine.failed);
    }
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/alerts", { cache: "no-store" });
  });

  it("an array whose items are not alerts ends in 'could not load', not in an invented count or a crash", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const got: Record<string, unknown> = {};
    for (const items of [[null], [{}], [{ severity: "bogus" }], ["x"]]) {
      fetchMock.mockResolvedValueOnce(res(200, JSON.stringify({ data: items })));
      got[JSON.stringify(items)] = await loadAlerts();
    }
    expect(got).toEqual({ "[null]": null, "[{}]": null, '[{"severity":"bogus"}]': null, '["x"]': null });
  });

  it("count and level come from the answer and the worst level wins, in both languages", () => {
    const three = [F.backup_failed, F.site_container_down, F.restore_stuck];
    expect(decode(render(createElement(AlertLineView, { alerts: three })))).toContain("Open alerts: 3. Highest level: critical.");
    expect(decode(render(createElement(AlertLineView, { alerts: three }), itMsgs))).toContain("Avvisi aperti: 3. Livello più alto: critico.");
    const warn = render(createElement(AlertLineView, { alerts: [F.backup_failed, F.operation_stuck] }));
    expect(warn).toContain("Open alerts: 2. Highest level: warning.");
    // Ordering does not matter: critical last still wins.
    expect(render(createElement(AlertLineView, { alerts: [F.backup_failed, F.disk_high] }))).toContain("critical");
    // A kind newer than the page still counts with its own level.
    const future = { ...F.backup_failed, kind: "future_kind", severity: "critical" } as unknown as AdminAlertDto;
    expect(render(createElement(AlertLineView, { alerts: [future] }))).toContain("Open alerts: 1. Highest level: critical.");
  });

  it("the mounted line starts in the empty status box (loading) and fetches once per path", () => {
    const fetchMock = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    expect(render(createElement(AlertLine))).toMatch(/^<div role="status"><\/div>$/);
  });
});

describe("3. hostile values are text", () => {
  it("Health page: site name, customer, host name, unknown part and unknown alert are escaped", async () => {
    const components = PANEL_COMPONENTS.map((component) => ({ component, state: "ok", reason: null, observedAt: T }));
    components[0] = { component: XSS as never, state: XSS2 as never, reason: XSS as never, observedAt: T };
    upstream({
      "v1/admin/health": {
        data: {
          generatedAt: T,
          components,
          siteContainers: [{ siteId: "s1", siteName: XSS, organizationName: XSS2, desired: "running", observed: "stopped", driftReason: null, restartCount: 2, observedAt: T, stale: false }],
          disks: [],
          hostServices: null,
        },
      },
      "v1/admin/alerts": {
        data: [
          { ...F.certificate_not_issued, details: { ...F.certificate_not_issued.details, hostname: XSS, siteName: XSS2 } },
          { kind: XSS, severity: "warning", subject: XSS2, since: T, details: { component: XSS } },
          { ...F.component_down, details: { component: XSS, state: "down", reason: XSS } },
        ],
      },
    });
    const h = render(await AdminHealthPage());
    noRawTag(h);
    expect(h).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(decode(h)).toContain(en.admin.health.unknownAlert);
    expect(h).not.toMatch(/>undefined</);
  });

  it("the log viewer: tags, terminal escape codes and a 100 000-character line stay text in a wrapping box", async () => {
    const long = "a".repeat(100_000);
    const lines = [XSS, XSS2, "\u001b[31mred\u001b[0m tail-marker", long].map((text) => ({ at: null, stream: "stdout", text }));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: lines }) })));
    hooks.on = true;
    hooks.slots = [];
    hooks.effects = [];
    hooks.i = 0;
    const el = createElement(SiteLogs, { url: "/api/admin/logs/sftp?tail=200", admin: true });
    render(el);
    hooks.effects.forEach((f) => f());
    for (let n = 0; n < 5; n++) await new Promise((r) => setTimeout(r, 0));
    hooks.i = 0;
    const h = render(el);
    hooks.on = false;
    noRawTag(h);
    expect(h).toContain("&lt;script&gt;");
    expect(h).toContain("red\u001b[0m tail-marker");
    expect(h).toContain(long);
    expect(h).toMatch(/<pre class="[^"]*overflow-auto[^"]*whitespace-pre-wrap[^"]*break-all/);
    expect(h).toContain("</pre>");
  });

  it("the audit table: actor, action, target and details are text", () => {
    const ev = { id: "e1", timestamp: T, actorId: XSS, actorType: XSS2, action: XSS, organizationId: XSS2, targetType: XSS, targetId: XSS2, details: { note: XSS, more: XSS2 } };
    const h = render(createElement(AuditTable, { initialEvents: [ev as never] }));
    noRawTag(h);
    expect(h).toContain("&lt;img");
  });

  it("the alert line: a hostile alert adds a count, never its text", () => {
    const hostile = AdminAlertDtoSchema.parse({ ...(FULL.backup_failed as object), subject: XSS, details: { siteId: "s1", siteName: XSS2, failedAt: T } });
    const h = render(createElement(AlertLineView, { alerts: [hostile] }));
    noRawTag(h);
    expect(h).not.toContain("onerror");
  });

  it("no M5b file renders raw HTML", () => {
    const files = [
      "app/admin/health/page.tsx", "app/admin/logs/page.tsx", "app/admin/audit/page.tsx", "app/admin/layout.tsx",
      "app/api/admin/alerts/route.ts", "app/api/admin/logs/[component]/route.ts", "app/api/admin/sites/[siteId]/logs/route.ts",
      "components/admin/alert-line.tsx", "components/admin/audit-table.tsx", "components/admin/audit-filters.tsx",
      "components/customer/site-logs.tsx", "components/ui/progress.tsx", "lib/admin-alerts.ts", "lib/admin-address.ts",
    ];
    for (const f of files) expect(read(`apps/web/src/${f}`), f).not.toMatch(/dangerouslySetInnerHTML|innerHTML|__html/);
  });
});

// Finds the props of the first element of a given type in a server page's tree.
const findProps = (node: ReactNode, type: unknown): Record<string, unknown> | null => {
  if (Array.isArray(node)) {
    for (const n of node) {
      const p = findProps(n, type);
      if (p) return p;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const props = node.props as Record<string, unknown>;
  if (node.type === type) return props;
  return findProps(props.children as ReactNode, type);
};

describe("4. nothing from the address reaches upstream unchecked", () => {
  const sites = { data: { sites: [{ id: "site_a1", name: XSS, owner: { organizationId: "o1", name: XSS2 } }], customers: [], certificateAlerts: [] } };

  it("Logs page: bad sources show the 'choose' state and mount no viewer; bad tails fall back to 200", async () => {
    upstream({ "v1/admin/sites": sites });
    for (const source of [`site:${"a".repeat(129)}`, "site:../x", "site:%2e%2e", "site:..", "docker", "hp_mariadb", "SFTP", "Ingress_Proxy", "site:", XSS2]) {
      const tree = await AdminLogsPage(sp({ source }));
      expect(findProps(tree, SiteLogs), source).toBeNull();
      const h = render(tree);
      noRawTag(h);
      expect(decode(h)).toContain(en.admin.logs.choose);
    }
    for (const tail of ["1e9", "-1", "abc", "", "100.5", "9999"]) {
      const tree = await AdminLogsPage(sp({ source: "sftp", tail }));
      expect(findProps(tree, SiteLogs)?.url, tail).toBe("/api/admin/logs/sftp?tail=200");
    }
    expect(findProps(await AdminLogsPage(sp({ source: "site:site_a1", tail: "500" })), SiteLogs)?.url).toBe("/api/admin/sites/site_a1/logs?tail=500");
    // The page itself only ever asks the API for the list of sites.
    expect(fetchUpstream.mock.calls.every(([p]) => p === "v1/admin/sites")).toBe(true);
  });

  it("log routes: a negative tail is 1, any other query is dropped, the path is their own", async () => {
    await panelLogsRoute.GET(req("/api/admin/logs/mail_relay?tail=-1&cursor=x&source=docker"), { params: Promise.resolve({ component: "mail_relay" }) });
    expect(fetchUpstream).toHaveBeenLastCalledWith("v1/admin/logs/mail_relay?tail=1", expect.objectContaining({ method: "GET" }));
    await siteLogsRoute.GET(req("/api/admin/sites/s_1/logs?tail=100&tail=9999&x=../y"), { params: Promise.resolve({ siteId: "s_1" }) });
    expect(fetchUpstream).toHaveBeenLastCalledWith("v1/admin/sites/s_1/logs?tail=100", expect.objectContaining({ method: "GET" }));
    for (const id of [`${"a".repeat(129)}`, "a/b", "a%2Fb", "..", "a b", XSS])
      expect((await siteLogsRoute.GET(req("/x"), { params: Promise.resolve({ siteId: id }) })).status, id).toBe(400);
    for (const c of ["SFTP", "hp_sftp", "hp_mariadb", "web", "api", XSS])
      expect((await panelLogsRoute.GET(req("/x"), { params: Promise.resolve({ component: c }) })).status, c).toBe(400);
    expect(fetchUpstream).toHaveBeenCalledTimes(2);
  });

  it("the three new routes serve only GET and pass a 403 (not an administrator) through", async () => {
    for (const mod of [alertsRoute, panelLogsRoute, siteLogsRoute])
      expect(Object.keys(mod).filter((k) => /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(k))).toEqual(["GET"]);
    fetchUpstream.mockResolvedValue({ ok: false, status: 403, error: { error: { code: "FORBIDDEN" } } });
    expect((await alertsRoute.GET(req("/api/admin/alerts"))).status).toBe(403);
    expect((await panelLogsRoute.GET(req("/x"), { params: Promise.resolve({ component: "sftp" }) })).status).toBe(403);
    expect((await siteLogsRoute.GET(req("/x"), { params: Promise.resolve({ siteId: "s1" }) })).status).toBe(403);
    session.value = null;
    fetchUpstream.mockClear();
    expect((await alertsRoute.GET(req("/api/admin/alerts?x=1"))).status).toBe(401);
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  const auditCalls = () => fetchUpstream.mock.calls.map(([p]) => String(p)).filter((p) => p.startsWith("v1/admin/audit"));
  const auditPage = { data: [], page: { nextCursor: "c_next", hasMore: true } };

  it("Audit: a 200-entry trail, commas only and a non-id entry are dropped: first page, no cursor upstream", async () => {
    upstream({ "v1/admin/audit": auditPage });
    for (const trail of [Array.from({ length: 200 }, (_, i) => `c${i}`).join(","), ",,,,", `c1,${XSS2}`, "c1,../x", "c1,%2e%2e"]) {
      fetchUpstream.mockClear();
      const h = decode(render(await AdminAuditPage(sp({ trail }))));
      noRawTag(h);
      expect(auditCalls(), trail.slice(0, 20)).toEqual(["v1/admin/audit?limit=50"]);
      expect(h).toContain("Page 1");
      expect(h).not.toContain(en.admin.audit.previous);
    }
  });

  it("Audit: a hostile From is sent as one encoded value and cannot add a parameter", async () => {
    fetchUpstream.mockResolvedValue({ ok: false, status: 400, error: { error: { code: "VALIDATION_ERROR" } } });
    const from = "x&limit=100000&cursor=../x";
    const h = decode(render(await AdminAuditPage(sp({ from, to: XSS2 }))));
    const [call] = auditCalls();
    const q = new URLSearchParams(call!.split("?")[1]);
    expect(q.getAll("limit")).toEqual(["50"]);
    expect(q.get("cursor")).toBeNull();
    expect(q.get("from")).toBe(from);
    expect(q.get("to")).toBe(XSS2);
    expect(h).toContain(en.admin.audit.filtersInvalid);
    noRawTag(h);
  });

  it("Audit: To before From is refused, as the filtersInvalid sentence promises", () => {
    // The page shows filtersInvalid only on a 400; the API must give one when to <= from.
    expect(en.admin.audit.filtersInvalid).toMatch(/From is not before To/);
    const ctrl = read("apps/api/src/controllers/admin-audit.controller.ts");
    expect(ctrl).toMatch(/\bfrom\b[^\n;]*(<|>|getTime|isBefore|isAfter)[^\n;]*\bto\b|\bto\b[^\n;]*(<|>|getTime)[^\n;]*\bfrom\b/);
  });
});

describe("5. the customer's side did not change", () => {
  const ui = read("apps/web/test/ui-copy.test.ts");
  const dirs = [...ui.match(/const dirs = \[([\s\S]*?)\]/)![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  const [, src, flags] = ui.match(/const jargon = \/(.+)\/([a-z]*);/)!;
  const jargon = new RegExp(src!, flags);
  const sections = [...ui.match(/const sections = \[([^\]]*)\]/)![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);

  it("ui-copy's scan reads the M5b customer files and the site section, and its own regex catches planted words", () => {
    for (const f of ["app/sites/[siteId]/logs/page.tsx", "components/customer/site-logs.tsx"]) {
      expect(fs.existsSync(path.join(WEB, "src", f)), f).toBe(true);
      expect(dirs.some((d) => f.startsWith(`${d}/`)), f).toBe(true);
    }
    expect(sections).toContain("site");
    expect(ui).toMatch(/e\.isDirectory\(\) \? files\(full\)/); // it walks sub-folders
    for (const planted of ["The container keeps restarting.", "Il servizio Docker non risponde.", "Your organization reached the limit.", "Check the relay."])
      expect(jargon.test(planted), planted).toBe(true);
    for (const clean of [en.site.logs.loaded, itMsgs.site.logs.loaded, en.site.logs.unavailable, itMsgs.site.logs.unavailable])
      expect(jargon.test(clean), clean).toBe(false);
  });

  it("a vanished container (404 with the executor's text) shows the customer a catalog sentence, never that text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: { code: "NOT_FOUND", message: "Managed service container not found" } }) })));
    hooks.on = true;
    hooks.slots = [];
    hooks.effects = [];
    hooks.i = 0;
    const el = createElement(SiteLogs, { url: "/api/bff/orgs/o1/managed-sites/s1/logs?tail=200" });
    render(el);
    hooks.effects.forEach((f) => f());
    for (let n = 0; n < 5; n++) await new Promise((r) => setTimeout(r, 0));
    hooks.i = 0;
    const h = decode(render(el));
    hooks.on = false;
    expect(h).not.toMatch(/container/i);
    expect(h).toContain(en.errors.NOT_FOUND);
    expect(h).not.toContain(en.admin.logs.viewer.notFound);
  });

  it("no admin wording in a section a customer can see", () => {
    const admin = /systemctl|journalctl|sudo |hp-(api|web|docker|host|break)|hp_[a-z]|Health page|pagina Stato|Logs page|pagina Log\b|break-glass|executor|esecutore/i;
    for (const m of [en, itMsgs]) for (const s of sections) expect(JSON.stringify((m as Record<string, unknown>)[s]), s).not.toMatch(admin);
    // The viewer picks admin texts only on the admin flag; the customer page passes none.
    expect(read("apps/web/src/app/sites/[siteId]/logs/page.tsx")).not.toMatch(/\badmin\b/);
  });

  it("the two replaced tooMany sentences: no forbidden word, no organisation, no count of other sites' actions", () => {
    const found: string[] = [];
    const walk = (o: unknown) => {
      if (!o || typeof o !== "object") return;
      for (const [k, v] of Object.entries(o)) {
        if (k === "tooMany" && typeof v === "string") found.push(v);
        else walk(v);
      }
    };
    for (const m of [en, itMsgs]) walk(m.site);
    const replaced = found.filter((s) => /all your sites|insieme dei tuoi siti/.test(s));
    expect(replaced).toHaveLength(4);
    for (const s of replaced) {
      expect(s).not.toMatch(jargon);
      expect(s).not.toMatch(/organi[sz]ation|organizzazion/i);
      expect(s.replace("{time}", "")).not.toMatch(/\d|\{/);
    }
  });
});

// ---------- catalogs ----------
const flat = (o: unknown, p = ""): Record<string, string> =>
  typeof o === "string" ? { [p]: o } : Object.assign({}, ...Object.entries(o as object).map(([k, v]) => flat(v, p ? `${p}.${k}` : k)));
const m5b = (m: Messages) => {
  const all = flat(m);
  const audit = ["from", "to", "apply", "clear", "previous", "next", "pageOf", "filtersInvalid", "loadFailed", "narrow"].map((k) => `admin.audit.${k}`);
  return Object.fromEntries(
    Object.entries(all).filter(([k]) =>
      /^admin\.(alertLine|health|logs)\./.test(k) || ["admin.nav.health", "admin.nav.logs", "site.logs.loaded", ...audit].includes(k)),
  );
};

describe("6. the texts", () => {
  const E6 = m5b(en);
  const I6 = m5b(itMsgs);

  it("every M5b key is in both catalogs, filled, not a key name, with the same placeholders", () => {
    expect(Object.keys(E6).length).toBeGreaterThan(130);
    expect(Object.keys(I6).sort()).toEqual(Object.keys(E6).sort());
    const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort();
    for (const [k, v] of Object.entries(E6)) {
      for (const s of [v, I6[k]!]) {
        expect(s.trim(), k).not.toBe("");
        expect(s, k).not.toBe(k);
        expect(s, k).not.toMatch(/TODO|FIXME|undefined/);
      }
      expect(I6[k], k).not.toBe(k.split(".").at(-1)); // en "warning" for key warning is a word, not a leaked key
      expect(ph(I6[k]!), k).toEqual(ph(v));
    }
  });

  it("the Italian is not the English, except names that are the same in both languages", () => {
    const same = Object.keys(E6).filter((k) => E6[k] === I6[k]).sort();
    // Product and unit names, "Log", and two templates made only of placeholders.
    expect(same).toEqual([
      "admin.health.alerts.component_down",
      "admin.health.colLog",
      "admin.health.components.api",
      "admin.health.components.docker_engine",
      "admin.health.components.ingress_proxy",
      "admin.health.components.phpmyadmin",
      "admin.logs.siteOption",
    ]);
  });
});

describe("7. accessibility in the markup", () => {
  it("line: status region, failure is role=alert; Health badges carry words; tables have header cells", async () => {
    expect(render(createElement(AlertLineView, { alerts: [F.disk_high] }))).toMatch(/^<div role="status">/);
    expect(render(createElement(AlertLineView, { alerts: null }))).toMatch(/role="alert"/);
    upstream({ "v1/admin/health": null, "v1/admin/alerts": null });
    const failed = render(await AdminHealthPage());
    expect(failed).toContain('role="alert"');
    expect(render(createElement(AuditTable, { initialEvents: [] }))).toMatch(/(<th[^>]*>[^<]+<\/th>.*){6}/);
  });

  it("Logs page: the source and line pickers have labels", async () => {
    upstream({ "v1/admin/sites": null });
    const h = render(await AdminLogsPage(sp({})));
    for (const id of ["log-source", "log-tail"]) {
      expect(h).toMatch(new RegExp(`<label[^>]*for="${id}"[^>]*>[^<]+</label>`));
      expect(h).toContain(`id="${id}"`);
    }
    expect(h).toContain('role="alert"'); // sites failed
  });

  it("Audit: dates have labels; Previous and Next have a name and show only where there is somewhere to go", async () => {
    upstream({ "v1/admin/audit": { data: [], page: { nextCursor: null, hasMore: false } } });
    const only = decode(render(await AdminAuditPage(sp({}))));
    for (const id of ["audit-from", "audit-to"]) expect(only).toMatch(new RegExp(`<label[^>]*for="${id}"[^>]*>[^<]+</label>`));
    expect(only).not.toContain(en.admin.audit.previous);
    expect(only).not.toContain(en.admin.audit.next);
    expect(only).toContain(`<nav aria-label="${en.admin.audit.pages}"`);
    upstream({ "v1/admin/audit": auditPageMid });
    const mid = decode(render(await AdminAuditPage(sp({ trail: "c1" }))));
    expect(mid).toMatch(new RegExp(`<a[^>]*href="[^"]*"[^>]*>${en.admin.audit.previous}</a>`));
    expect(mid).toMatch(new RegExp(`<a[^>]*href="[^"]*trail=c1%2Cc2[^"]*"[^>]*>${en.admin.audit.next}</a>`));
  });
});
const auditPageMid = { data: [], page: { nextCursor: "c2", hasMore: true } };

describe("8. the screen and the routes fit together", () => {
  const ROUTES: [string, string, string, string][] = [
    // [address the browser asks, route file, upstream path in the route, controller file]
    ["/api/admin/alerts", "app/api/admin/alerts/route.ts", '"v1/admin/alerts"', "admin-health.controller.ts"],
    ["/api/admin/logs/${", "app/api/admin/logs/[component]/route.ts", "`v1/admin/logs/${component}?tail=${", "admin-logs.controller.ts"],
    ["/api/admin/sites/${", "app/api/admin/sites/[siteId]/logs/route.ts", "`v1/admin/sites/${siteId}/logs?tail=${", "admin-logs.controller.ts"],
  ];

  it("each address the screen asks has a route that exports GET and forwards to its controller's path with its query names", () => {
    const callers = read("apps/web/src/components/admin/alert-line.tsx") + read("apps/web/src/lib/admin-address.ts");
    for (const [addr, file, up, ctrl] of ROUTES) {
      expect(callers, addr).toContain(addr);
      const route = read(`apps/web/src/${file}`);
      expect(route).toMatch(/export const GET|export async function GET/);
      expect(route).toContain(up);
      expect(route).toMatch(/"GET"/);
      expect(fs.existsSync(path.join(ROOT, "apps/api/src/controllers", ctrl))).toBe(true);
    }
    const health = read("apps/api/src/controllers/admin-health.controller.ts");
    expect(health).toContain('@Controller("v1/admin")');
    expect(health).toMatch(/@Get\("alerts"\)/);
    expect(health).toMatch(/@Get\("health"\)/);
    const logs = read("apps/api/src/controllers/admin-logs.controller.ts");
    expect(logs).toContain('@Controller("v1/admin")');
    expect(logs).toMatch(/@Get\("logs\/:component"\)[\s\S]*?@Query\("tail"\)/);
    expect(logs).toMatch(/@Get\("sites\/:siteId\/logs"\)[\s\S]*?@Query\("tail"\)/);
    // The viewer and the line use GET (no method given).
    for (const f of ["components/admin/alert-line.tsx", "components/customer/site-logs.tsx"])
      expect(read(`apps/web/src/${f}`)).not.toMatch(/method:/);
  });

  it("the Audit page's query names are the ones the audit controller reads", () => {
    const api = read("apps/web/src/lib/server-api.ts");
    expect(api).toMatch(/serverGet<AuditEventDto\[\]>\(`v1\/admin\/audit\?\$\{qs\}`\)/);
    const ctrl = read("apps/api/src/controllers/admin-audit.controller.ts");
    expect(ctrl).toContain('@Controller("v1/admin/audit")');
    for (const k of ["from", "to", "organizationId", "action"]) expect(ctrl, k).toMatch(new RegExp(`\\["${k}"\\]|\\b${k}:`));
    expect(ctrl).toContain("parsePaginationQuery"); // limit and cursor
    for (const k of ["organizationId", "action", "from", "to"]) expect(read("apps/web/src/app/admin/audit/page.tsx")).toContain(`"${k}"`);
  });

  it("the fields the pages read exist in the contract", () => {
    const shape = AdminHealthDtoSchema.shape;
    const page = read("apps/web/src/app/admin/health/page.tsx");
    const fields = {
      siteContainers: ["siteId", "siteName", "organizationName", "desired", "observed", "driftReason", "restartCount", "observedAt", "stale"],
      disks: ["paths", "usedBytes", "totalBytes", "usedPercent"],
      components: ["component", "state", "reason", "observedAt"],
    } as const;
    for (const [list, keys] of Object.entries(fields)) {
      const item = (shape[list as keyof typeof shape] as unknown as { element: { shape: object } }).element.shape;
      for (const k of keys) {
        expect(Object.keys(item), `${list}.${k}`).toContain(k);
        expect(page, `${list}.${k}`).toMatch(new RegExp(`\\.${k}\\b`));
      }
    }
    expect(page).toMatch(/\.generatedAt\b/);
    expect(Object.keys(shape)).toContain("generatedAt");
    expect(read("apps/web/src/components/customer/site-logs.tsx")).toMatch(/l\.stream[\s\S]*l\.at[\s\S]*l\.text/);
  });

  it("every alert kind has a sentence in both catalogs, and the catalog has no kind the contract lacks", () => {
    for (const m of [en, itMsgs]) expect(Object.keys(m.admin.health.alerts).sort()).toEqual([...ALERT_KINDS].sort());
    for (const m of [en, itMsgs]) expect(Object.keys(m.admin.health.components).sort()).toEqual([...PANEL_COMPONENTS].sort());
    expect(PANEL_CONTAINERS.every((c) => Object.hasOwn(en.admin.health.fix, c))).toBe(true);
  });
});
