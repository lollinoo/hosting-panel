import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ALERT_KINDS,
  AdminAlertDtoSchema,
  AdminHealthDtoSchema,
  PANEL_COMPONENTS,
  PANEL_CONTAINERS,
  type AdminAlertDto,
  type AdminHealthDto,
  type AlertKind,
} from "@hosting-panel/contracts";
import type { Messages } from "@/i18n";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { I18nProvider } from "@/i18n/provider";

const fetchUpstream = vi.fn();
const getSessionFromRequest = vi.fn();
const getServerSession = vi.fn();
const getRequestLocale = vi.fn();
const redirect = vi.fn();

vi.mock("@/lib/upstream", async () => ({
  ...(await vi.importActual<object>("@/lib/upstream")),
  fetchUpstream: (...args: unknown[]) => fetchUpstream(...args),
}));
vi.mock("@/lib/server-session", () => ({
  getSessionFromRequest: (...args: unknown[]) => getSessionFromRequest(...args),
  getServerSession: (...args: unknown[]) => getServerSession(...args),
}));
vi.mock("@/i18n/server", () => ({
  getRequestLocale: (...args: unknown[]) => getRequestLocale(...args),
}));
vi.mock("next/navigation", () => ({
  redirect: (...args: unknown[]) => redirect(...args),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/admin/health",
}));

import AdminHealthPage from "@/app/admin/health/page";
import AdminLayout from "@/app/admin/layout";
import { GET as getAlerts } from "@/app/api/admin/alerts/route";
import { AlertLine, AlertLineView, loadAlerts } from "@/components/admin/alert-line";
import { SidebarNav } from "@/components/layout/sidebar-nav";
import { alertLink, alertText, worstSeverity } from "@/lib/admin-alerts";
import { formatSize } from "@/lib/file-browser";
import { Progress } from "@/components/ui/progress";

const wrap = (m: Messages, child: ReactElement) =>
  createElement(I18nProvider, { locale: m === en ? "en" : "it", messages: m, children: child });
const html = (m: Messages, child: ReactElement) =>
  renderToStaticMarkup(wrap(m, child)).replaceAll("&#x27;", "'").replaceAll("&quot;", '"');

const XSS = "<img src=x onerror=alert(1)>";
const T = "2026-11-14T10:00:00Z";
const site = { siteId: "s1", siteName: "wp-a.example.test" };
const op = { operationId: "op1", kind: "site.backups.restore", siteId: "s1", siteName: "wp-a.example.test" } as const;

// One contract-valid alert per kind: a sixteenth kind without a fixture fails the type check and (a).
const raw: Record<AlertKind, unknown> = {
  disk_high: { severity: "critical", subject: "docker_data", since: T, kind: "disk_high", details: { paths: ["docker_data", "root"], usedPercent: 93 } },
  certificate_expiring: { severity: "warning", subject: "wp-a.example.test", since: null, kind: "certificate_expiring", details: { ...site, hostname: "wp-a.example.test", expiresAt: T, problem: "port_80_blocked" } },
  certificate_not_issued: { severity: "warning", subject: "wp-a.example.test", since: null, kind: "certificate_not_issued", details: { ...site, hostname: "wp-a.example.test", problem: null } },
  panel_certificate_expiring: { severity: "warning", subject: "panel.example.test", since: null, kind: "panel_certificate_expiring", details: { hostname: "panel.example.test", expiresAt: T } },
  manual_certificate_expiring: { severity: "warning", subject: "v1", since: null, kind: "manual_certificate_expiring", details: { ...site, certificateId: "c1", certificateName: "hotel-cert", notAfter: T, tier: "warning" } },
  backup_failed: { severity: "warning", subject: "s1", since: T, kind: "backup_failed", details: { ...site, failedAt: T } },
  panel_backup_failed: { severity: "warning", subject: "panel", since: T, kind: "panel_backup_failed", details: { failedAt: T } },
  backup_storage_test_failed: { severity: "warning", subject: "storage", since: T, kind: "backup_storage_test_failed", details: { testedAt: T, targetId: "bkt_" + "a".repeat(32), targetKind: "s3", problem: null } },
  backup_target_space_low: { severity: "warning", subject: "bkt_" + "b".repeat(32), since: T, kind: "backup_target_space_low", details: { targetId: "bkt_" + "b".repeat(32), targetKind: "local", availableBytes: 2_000_000_000, totalBytes: 100_000_000_000, testedAt: T } },
  backup_site_without_target: { severity: "warning", subject: "site_1", since: null, kind: "backup_site_without_target", details: { siteId: "site_1", siteName: "Shop" } },
  component_down: { severity: "critical", subject: "sftp", since: T, kind: "component_down", details: { component: "sftp", state: "down", reason: "stopped" } },
  site_container_down: { severity: "critical", subject: "s1", since: T, kind: "site_container_down", details: { ...site, observed: "stopped" } },
  restore_undo_incomplete: { severity: "critical", subject: "b1", since: T, kind: "restore_undo_incomplete", details: { ...site, backupId: "b1", failedAt: null } },
  restore_stuck: { severity: "warning", subject: "op1", since: T, kind: "restore_stuck", details: { operationId: "op1", siteId: "s1", siteName: "wp-a.example.test", startedAt: T } },
  operation_unknown: { severity: "warning", subject: "op1", since: T, kind: "operation_unknown", details: op },
  operation_stuck: { severity: "warning", subject: "op1", since: null, kind: "operation_stuck", details: { ...op, siteId: null, siteName: null } },
};
const A = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, AdminAlertDtoSchema.parse(v)])) as Record<AlertKind, AdminAlertDto>;

const enNext = /check|fix|use|put|free|try|give|create|reload|save|enter|set up|contact/i;
const itNext = /controlla|correggi|usa|rimetti|libera|riprova|dai|crea|ricarica|salva|inserisci|configura|contatta/i;

const makeHealth = (over: Partial<AdminHealthDto> = {}): AdminHealthDto =>
  AdminHealthDtoSchema.parse({
    generatedAt: T,
    components: PANEL_COMPONENTS.map((component, i) => ({
      component,
      state: (["ok", "degraded", "down", "not_in_use", "unknown"] as const)[i % 5],
      reason: i % 5 === 2 ? "stopped" : null,
      observedAt: i % 5 === 4 ? null : T,
    })),
    siteContainers: [
      { siteId: "s1", siteName: XSS, organizationName: null, desired: "running", observed: "stopped", driftReason: "status_mismatch", restartCount: 3, observedAt: T, stale: true },
      { siteId: "s2", siteName: "wp-b.example.test", organizationName: "Example Org", desired: "running", observed: "running", driftReason: null, restartCount: null, observedAt: null, stale: false },
    ],
    disks: [{ paths: ["docker_data", "root"], usedBytes: "5368709120", totalBytes: "10737418240", usedPercent: 50, observedAt: T }],
    hostServices: null,
    ...over,
  });

const req = (headers: Record<string, string> = {}) =>
  new Request("http://localhost:3000/api/admin/alerts", { method: "GET", headers: { Host: "localhost:3000", ...headers } });

// Upstream answers by path; a missing path is a 500.
const upstream = (byPath: Record<string, unknown>) =>
  fetchUpstream.mockImplementation(async (path: string) =>
    path in byPath && byPath[path] !== null
      ? { ok: true, status: 200, data: { data: byPath[path] } }
      : { ok: false, status: 500, error: { error: { code: "INTERNAL_ERROR" } } });

beforeEach(() => {
  fetchUpstream.mockReset();
  getSessionFromRequest.mockReset();
  getServerSession.mockReset();
  getRequestLocale.mockReset();
  redirect.mockReset();
  redirect.mockImplementation((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  });
  getServerSession.mockResolvedValue({
    accessToken: "tok",
    csrfToken: "csrf",
    user: { id: "u1", email: "admin@example.test", name: "Admin", isServerAdmin: true, mustChangePassword: false, locale: "en" },
  });
  getRequestLocale.mockResolvedValue("en");
});
afterEach(() => vi.unstubAllGlobals());

describe("alert sentences and links (a, b, c)", () => {
  it("(a) every ALERT_KIND gives a full sentence with a next step in en and it", () => {
    for (const [m, re] of [[en, enNext], [itMsgs, itNext]] as const) {
      for (const kind of ALERT_KINDS) {
        const text = alertText(m, A[kind]);
        expect(text, `${kind}`).not.toMatch(/[{}]|undefined|\bnull\b/);
        expect(text, `${kind}`).not.toBe(m.admin.health.unknownAlert);
        expect(text, `${kind}`).toMatch(re);
      }
      // component_down for every part, and every disk name, resolve to words
      for (const component of PANEL_COMPONENTS) {
        const a = AdminAlertDtoSchema.parse({ ...A.component_down, details: { component, state: "degraded", reason: null } });
        expect(alertText(m, a)).not.toMatch(/[{}]|undefined/);
        expect(alertText(m, a)).toContain(m.admin.health.fix[component]);
      }
    }
    expect(alertText(en, A.disk_high)).toContain(`${en.admin.health.disks.docker_data}, ${en.admin.health.disks.root}`);
    expect(alertText(en, A.certificate_expiring)).toContain(en.admin.sites.alertsProblem.port_80_blocked);
    expect(alertText(en, A.certificate_not_issued)).toContain(en.admin.sites.alertsProblem.other);
    expect(alertText(en, A.restore_undo_incomplete)).toContain(en.admin.health.unknownDate);
    expect(alertText(en, A.manual_certificate_expiring)).toContain("hotel-cert");
    expect(itMsgs.admin.health.alerts.manual_certificate_expiring).not.toBe(en.admin.health.alerts.manual_certificate_expiring);
    expect(itMsgs.admin.health.openCertificates).not.toBe(en.admin.health.openCertificates);
    expect(alertText(en, A.operation_unknown)).toContain('--operation-id op1 --reason "<why>"');
    // R184 2.5(b), as built by health: an hp-api restart does not end a stuck restore; an executor restart does
    for (const m of [en, itMsgs]) expect(alertText(m, A.restore_stuck)).toContain("sudo systemctl restart hp-docker-executor:");
  });

  it("(a) R186 2.1: restore_stuck promises no outcome: after the switch the executor completes the restore", () => {
    expect(alertText(en, A.restore_stuck)).toMatch(/at start it brings the restore to an end, and the panel shows the result within a minute\.$/);
    expect(alertText(itMsgs, A.restore_stuck)).toMatch(/all'avvio porta a termine il ripristino, e il pannello ne mostra l'esito entro un minuto\.$/);
    expect(alertText(en, A.restore_stuck)).not.toMatch(/puts the site back|as it was/);
    expect(alertText(itMsgs, A.restore_stuck)).not.toMatch(/rimette il sito|com'era/);
  });

  it("(a) an unknown kind or problem falls back to a neutral sentence, never a raw key or a throw", () => {
    for (const m of [en, itMsgs]) {
      const unknownKind = { ...A.disk_high, kind: "fan_too_loud" } as unknown as AdminAlertDto;
      expect(alertText(m, unknownKind)).toBe(m.admin.health.unknownAlert);
      expect(m.admin.health.unknownAlert).toMatch(m === en ? enNext : itNext);
      const unknownProblem = { ...A.certificate_not_issued, details: { ...A.certificate_not_issued.details, problem: "solar_flare" } } as unknown as AdminAlertDto;
      expect(alertText(m, unknownProblem)).toContain(m.admin.sites.alertsProblem.other);
      expect(alertText(m, unknownProblem)).not.toContain("solar_flare");
    }
    expect(alertLink({ ...A.disk_high, kind: "fan_too_loud" } as unknown as AdminAlertDto)).toBeNull();
  });

  it("(b) alertLink gives the next page per kind", () => {
    const links = Object.fromEntries(ALERT_KINDS.map((k) => [k, alertLink(A[k])]));
    expect(links).toEqual({
      disk_high: null,
      certificate_expiring: { href: "/admin/sites/s1/domains", label: "openDomains" },
      certificate_not_issued: { href: "/admin/sites/s1/domains", label: "openDomains" },
      panel_certificate_expiring: { href: "/admin/logs?source=ingress_proxy", label: "openLog" },
      manual_certificate_expiring: { href: "/admin/certificates?filter=expiring", label: "openCertificates" },
      backup_failed: { href: "/admin/backups", label: "openBackups" },
      panel_backup_failed: { href: "/admin/backups", label: "openBackups" },
      backup_storage_test_failed: { href: "/admin/backups", label: "openBackups" },
      backup_target_space_low: { href: "/admin/backups", label: "openBackups" },
      backup_site_without_target: { href: "/admin/backups", label: "openBackups" },
      component_down: { href: "/admin/logs?source=sftp", label: "openLog" },
      site_container_down: { href: "/admin/logs?source=site:s1", label: "openLog" },
      restore_undo_incomplete: { href: "/admin/backups", label: "openBackups" },
      restore_stuck: { href: "/admin/backups", label: "openBackups" },
      operation_unknown: null,
      operation_stuck: null,
    });
    const apiDown = AdminAlertDtoSchema.parse({ ...A.component_down, details: { component: "api", state: "down", reason: "not_reporting" } });
    expect(alertLink(apiDown)).toBeNull();
  });

  it("(c) worstSeverity: none, warning only, mixed", () => {
    expect(worstSeverity([])).toBeNull();
    expect(worstSeverity([A.backup_failed, A.operation_stuck])).toBe("warning");
    expect(worstSeverity([A.backup_failed, A.disk_high])).toBe("critical");
  });
});

describe("alert line (d, h)", () => {
  it("(d) loading, none, some and failed are different outputs; failed is a loud alert", () => {
    const loading = html(en, createElement(AlertLineView, { alerts: undefined }));
    const none = html(en, createElement(AlertLineView, { alerts: [] }));
    const some = html(en, createElement(AlertLineView, { alerts: [A.backup_failed, A.disk_high] }));
    const warn = html(en, createElement(AlertLineView, { alerts: [A.backup_failed] }));
    const failed = html(en, createElement(AlertLineView, { alerts: null }));

    for (const h of [loading, none]) {
      expect(h).toMatch(/^<div role="status"[^>]*><\/div>$/);
    }
    expect(some).toContain('role="status"');
    expect(some).not.toContain('role="alert"');
    expect(some).toContain("Open alerts: 2. Highest level: critical.");
    expect(some).toContain('href="/admin/health"');
    expect(some).toContain(en.admin.alertLine.link);
    expect(warn).toContain("Highest level: warning.");
    expect(warn).not.toBe(some);

    expect(failed).toContain('role="alert"');
    expect(failed).not.toContain('role="status"');
    expect(failed).toContain(en.admin.alertLine.failed);
    expect(new Set([none, some, failed]).size).toBe(3);

    expect(html(itMsgs, createElement(AlertLineView, { alerts: [A.backup_failed] }))).toContain("Avvisi aperti: 1. Livello più alto: attenzione.");
  });

  it("(d) loadAlerts: data on 2xx with an array, null on non-2xx, bad body or network failure", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = (status: number, body: string) => new Response(body, { status, headers: { "content-type": "application/json" } });

    fetchMock.mockResolvedValueOnce(res(200, JSON.stringify({ data: [raw.disk_high] })));
    expect(await loadAlerts()).toEqual([raw.disk_high]);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/admin/alerts", { cache: "no-store" });
    fetchMock.mockResolvedValueOnce(res(200, JSON.stringify({ data: [] })));
    expect(await loadAlerts()).toEqual([]);
    fetchMock.mockResolvedValueOnce(res(500, JSON.stringify({ data: [] })));
    expect(await loadAlerts()).toBeNull();
    fetchMock.mockResolvedValueOnce(res(200, JSON.stringify({ data: "nope" })));
    expect(await loadAlerts()).toBeNull();
    fetchMock.mockResolvedValueOnce(res(200, "<html>"));
    expect(await loadAlerts()).toBeNull();
    fetchMock.mockRejectedValueOnce(new TypeError("network"));
    expect(await loadAlerts()).toBeNull();
  });

  it("(h) the admin layout mounts AlertLine inside main, before the page", async () => {
    upstream({ "v1/me": { id: "u1" } });
    const tree = await AdminLayout({ children: createElement("p", { id: "page" }) });
    const find = (n: ReactNode, pred: (e: ReactElement) => boolean): ReactElement | null => {
      if (Array.isArray(n)) {
        for (const c of n) {
          const hit = find(c, pred);
          if (hit) return hit;
        }
        return null;
      }
      if (!isValidElement(n)) return null;
      if (pred(n)) return n;
      return find((n.props as { children?: ReactNode }).children, pred);
    };
    const main = find(tree, (e) => e.type === "main");
    const kids = ([] as ReactNode[]).concat((main!.props as { children: ReactNode }).children);
    expect(isValidElement(kids[0]) && kids[0].type).toBe(AlertLine);
    expect(isValidElement(kids[1]) && (kids[1].props as { id?: string }).id).toBe("page");
  });
});

describe("Health page (e)", () => {
  it("(e) alerts first, then 11 parts with worded badges, site containers and disks; markup is text", async () => {
    upstream({ "v1/admin/health": makeHealth(), "v1/admin/alerts": [A.site_container_down, { ...A.backup_failed, details: { ...site, siteName: XSS, failedAt: T } }] });
    const h = html(en, await AdminHealthPage());
    const t = en.admin.health;

    expect(fetchUpstream.mock.calls.map(([p]) => p).sort()).toEqual(["v1/admin/alerts", "v1/admin/health"]);
    expect(h).toContain(t.title);
    // The headings themselves: an alert sentence may name a section ("Sites' containers").
    const at = (title: string) => h.indexOf(`>${title}<`);
    expect(at(t.alertsTitle)).toBeGreaterThan(-1);
    expect(at(t.alertsTitle)).toBeLessThan(at(t.partsTitle));
    expect(at(t.partsTitle)).toBeLessThan(at(t.sitesTitle));
    expect(at(t.sitesTitle)).toBeLessThan(at(t.disksTitle));
    expect(h).toContain(alertText(en, A.site_container_down));
    expect(h).toContain('href="/admin/logs?source=site:s1"');
    expect(h).toContain('href="/admin/backups"');

    for (const c of PANEL_COMPONENTS) expect(h).toContain(t.components[c]);
    for (const s of Object.values(t.states)) expect(h).toContain(`>${s}<`);
    for (const c of PANEL_CONTAINERS) expect(h).toContain(`href="/admin/logs?source=${c}"`);
    expect(h).toContain(t.reasons.stopped);
    expect(h).toContain(t.never);
    expect((h.match(/<th[ >]/g) ?? []).length).toBeGreaterThanOrEqual(4 + 8 + 2);

    expect(h).toContain(t.unassigned);
    expect(h).toContain("Example Org");
    expect(h).toContain(t.stale);
    expect(h).toContain(t.drift.status_mismatch);
    expect(h).toContain(t.noDrift);
    expect(h).toContain(`aria-label="${"Open the log of wp-b.example.test"}"`);

    expect(h).toContain(`${t.disks.docker_data}, ${t.disks.root}`);
    expect(h).toContain(`${formatSize(5368709120, "en-GB")} used of ${formatSize(10737418240, "en-GB")}`);
    expect(h).toContain(`aria-label="${t.disks.docker_data}, ${t.disks.root}: 50% used"`);
    // R186 2.2: the disk bar carries its row's value for a screen reader
    const bar = h.match(/<div[^>]*: 50% used"[^>]*>/)?.[0] ?? "";
    expect(bar).toContain('role="progressbar"');
    expect(bar).toContain('aria-valuenow="50"');

    expect(h).not.toContain("<img");
    expect(h).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("R189 1.5: every date on Health and in the alert sentences carries its time zone", async () => {
    const before = process.env.TZ;
    const zones = new Set<string>();
    try {
      for (const zone of ["UTC", "Europe/Rome"]) {
        process.env.TZ = zone;
        for (const m of [en, itMsgs]) {
          const L = m.common.dateLocale;
          const tz = new Intl.DateTimeFormat(L, { timeZoneName: "short" }).formatToParts(new Date(T)).find((p) => p.type === "timeZoneName")!.value;
          zones.add(tz);
          upstream({ "v1/admin/health": makeHealth(), "v1/admin/alerts": [A.backup_failed] });
          const text = html(m, await AdminHealthPage()).replace(/<[^>]+>/g, " ");
          const times = text.match(/\b\d{1,2}:\d{2}\b[^\s,.]*\s*\S+/g) ?? [];
          expect(times.length, `${zone} ${L}`).toBeGreaterThanOrEqual(4); // checked at, a part, a site, the alert (disks show no date)
          for (const x of times) expect(x, `${zone} ${L}`).toContain(tz);
          expect(alertText(m, A.backup_failed), `${zone} ${L}`).toContain(tz);
        }
      }
      expect(zones.size).toBe(2); // the zone really changed between the two passes
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });

  it("(e) empty lists, health failure and alerts failure", async () => {
    const t = en.admin.health;
    upstream({ "v1/admin/health": makeHealth({ siteContainers: [], disks: [] }), "v1/admin/alerts": [] });
    const empty = html(en, await AdminHealthPage());
    for (const s of [t.noAlerts, t.noSites, t.noDisks]) expect(empty).toContain(s);
    expect(empty).not.toContain('role="alert"');

    upstream({ "v1/admin/health": null, "v1/admin/alerts": [A.disk_high] });
    const noHealth = html(en, await AdminHealthPage());
    expect(noHealth).toContain(t.loadFailed);
    expect(noHealth).toContain('role="alert"');
    for (const s of [t.alertsTitle, t.partsTitle, t.components.api, alertText(en, A.disk_high)]) expect(noHealth).not.toContain(s);

    upstream({ "v1/admin/health": makeHealth(), "v1/admin/alerts": null });
    const noAlerts = html(en, await AdminHealthPage());
    expect(noAlerts).toContain(t.alertsFailed);
    expect(noAlerts).toContain('role="alert"');
    expect(noAlerts).not.toContain(t.noAlerts);
    expect(noAlerts).toContain(t.components.api);
    expect(noAlerts).toContain(t.partsTitle);

    getRequestLocale.mockResolvedValue("it");
    upstream({ "v1/admin/health": makeHealth(), "v1/admin/alerts": [A.disk_high] });
    const itHtml = html(itMsgs, await AdminHealthPage());
    expect(itHtml).toContain(itMsgs.admin.health.partsTitle);
    expect(itHtml).toContain(alertText(itMsgs, A.disk_high));
  });
});

describe("Progress (R186 2.2)", () => {
  it("hands its value to the root: aria-valuenow, not an indeterminate bar", () => {
    const h = renderToStaticMarkup(createElement(Progress, { value: 42, "aria-label": "x" }));
    expect(h).toContain('aria-valuenow="42"');
    expect(h).toContain('data-state="loading"');
    expect(renderToStaticMarkup(createElement(Progress, { value: 100 }))).toContain('data-state="complete"');
  });
});

describe("alerts BFF route (f)", () => {
  it("(f) 401 without a session, no upstream call", async () => {
    getSessionFromRequest.mockResolvedValue(null);
    const res = await getAlerts(req());
    expect(res.status).toBe(401);
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("(f) forwards a GET to v1/admin/alerts and nowhere else, passing the answer through", async () => {
    getSessionFromRequest.mockResolvedValue({ accessToken: "tok", csrfToken: "csrf" });
    fetchUpstream.mockResolvedValue({ ok: true, status: 200, data: { data: [raw.disk_high] } });
    const res = await getAlerts(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [raw.disk_high] });
    expect(fetchUpstream.mock.calls.map(([p, o]) => [p, o.method, o.accessToken])).toEqual([["v1/admin/alerts", "GET", "tok"]]);

    fetchUpstream.mockResolvedValue({ ok: false, status: 403, error: { error: { code: "FORBIDDEN" } } });
    expect((await getAlerts(req())).status).toBe(403);
  });
});

describe("navigation (g)", () => {
  it("(g) Health is first, Firewall follows Backups, and Logs, Updates and the activity log come in a row, in both languages", () => {
    for (const m of [en, itMsgs]) {
      const h = html(m, createElement(SidebarNav));
      const hrefs = [...h.matchAll(/href="([^"]+)"/g)].map((x) => x[1]);
      expect(hrefs[0]).toBe("/admin/health");
      expect(hrefs.indexOf("/admin/firewall")).toBe(hrefs.indexOf("/admin/backups") + 1);
      expect(hrefs.indexOf("/admin/updates")).toBe(hrefs.indexOf("/admin/logs") + 1);
      expect(hrefs.indexOf("/admin/audit")).toBe(hrefs.indexOf("/admin/updates") + 1);
      for (const label of [m.admin.nav.health, m.admin.nav.firewall, m.admin.nav.logs, m.admin.nav.updates, m.admin.nav.audit]) expect(h).toContain(`>${label}<`);
    }
    expect(en.admin.nav.health).not.toBe(itMsgs.admin.nav.health);
  });
});
