// M5b web: the admin Logs page, the two log BFF routes, SiteLogs' address prop and the Audit page's paging.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, type ReactElement } from "react";
import { HOST_JOURNAL_SOURCES, HOST_SERVICES, HOST_SERVICE_UNIT, PANEL_CONTAINERS } from "@hosting-panel/contracts";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";

const fetchUpstream = vi.fn();
const session = vi.hoisted(() => ({ value: { accessToken: "SENTINEL-token", csrfToken: "SENTINEL-csrf" } as unknown }));
const fetchServerAudit = vi.fn();
const fetchServerAdminSites = vi.fn();
const customer = vi.hoisted(() => ({ getCustomerContext: vi.fn(), getSite: vi.fn() }));
vi.mock("@/lib/upstream", () => ({ fetchUpstream: (...a: unknown[]) => fetchUpstream(...a) }));
vi.mock("@/lib/server-session", () => ({ getSessionFromRequest: async () => session.value }));
vi.mock("@/lib/server-api", () => ({
  fetchServerAudit: (...a: unknown[]) => fetchServerAudit(...a),
  fetchServerAdminSites: () => fetchServerAdminSites(),
}));
vi.mock("@/i18n/server", () => ({ getRequestLocale: async () => "en" }));
vi.mock("@/app/sites/data", () => customer);
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/x" }));
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

import { GET as panelLogs } from "@/app/api/admin/logs/[component]/route";
import { GET as siteLogs } from "@/app/api/admin/sites/[siteId]/logs/route";
import AdminLogsPage from "@/app/admin/logs/page";
import AdminAuditPage from "@/app/admin/audit/page";
import SiteLogsPage from "@/app/sites/[siteId]/logs/page";
import { SiteLogs } from "@/components/customer/site-logs";
import { AuditFilters } from "@/components/admin/audit-filters";
import { I18nProvider } from "@/i18n/provider";
import { AUDIT_TRAIL_MAX, auditHref, isoToLocalInput, logUrl, parseLogSource, parseTail, parseTrail } from "@/lib/admin-address";

const render = (el: ReactElement, locale: "en" | "it" = "en") =>
  renderToStaticMarkup(createElement(I18nProvider, { locale, messages: locale === "en" ? en : itMsgs, children: el }));
const decode = (html: string) => html.replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
const req = (url: string) => new Request(`http://localhost:3000${url}`, { headers: { Host: "localhost:3000" } });
const comp = (component: string) => ({ params: Promise.resolve({ component }) });
const site = (siteId: string) => ({ params: Promise.resolve({ siteId }) });
const BAD = ["docker", "site:../x", "hp_mariadb", "", "..%2F", "../", "site:"];
const NEAR = ["hp-api2", "hp_api", "HP-API", "hp-api.service", "hp-panel-update ", "hp-os"];
const sp = (q: Record<string, string>) => ({ searchParams: Promise.resolve(q) });

beforeEach(() => {
  fetchUpstream.mockReset().mockResolvedValue({ ok: true, status: 200, data: { data: [] } });
  fetchServerAudit.mockReset();
  fetchServerAdminSites.mockReset().mockResolvedValue({
    sites: [
      { id: "site_a1", name: "Hotel A", owner: { organizationId: "org_1", name: "Acme" } },
      { id: "site_b2", name: "Shop B", owner: null },
    ],
    customers: [],
    certificateAlerts: [],
  });
  session.value = { accessToken: "SENTINEL-token", csrfToken: "SENTINEL-csrf" };
});

describe("(a)(b) source and tail in the address", () => {
  it("parseLogSource takes only the five names or site:<id>", () => {
    for (const c of PANEL_CONTAINERS) expect(parseLogSource(c)).toEqual({ kind: "panel", component: c });
    expect(parseLogSource("site:abc")).toEqual({ kind: "site", siteId: "abc" });
    for (const v of [...BAD, undefined, `site:${"a".repeat(129)}`]) expect(parseLogSource(v)).toBeNull();
  });

  it("parseLogSource takes the seven journals and nothing near them; logUrl sends them to the logs route", () => {
    for (const unit of HOST_JOURNAL_SOURCES) {
      expect(parseLogSource(unit)).toEqual({ kind: "journal", unit });
      expect(logUrl({ kind: "journal", unit }, 500)).toBe(`/api/admin/logs/${unit}?tail=500`);
    }
    for (const v of NEAR) expect(parseLogSource(v)).toBeNull();
  });

  it("parseTail keeps 100, 200, 500 and gives 200 otherwise", () => {
    expect([100, 200, 500].map((n) => parseTail(String(n)))).toEqual([100, 200, 500]);
    for (const v of ["7", "abc", "", "1e9", undefined]) expect(parseTail(v)).toBe(200);
  });
});

describe("(c) log BFF routes", () => {
  it("clamp tail to 1..500 and forward only to their own path with a 40 s timeout", async () => {
    const cases: [string, number][] = [["", 200], ["?tail=", 1], ["?tail=0", 1], ["?tail=9999", 500], ["?tail=abc", 200], ["?tail=1e9", 500], ["?tail=42", 42]];
    for (const [q, n] of cases) {
      await panelLogs(req(`/api/admin/logs/sftp${q}`), comp("sftp"));
      expect(fetchUpstream).toHaveBeenLastCalledWith(`v1/admin/logs/sftp?tail=${n}`, expect.objectContaining({ method: "GET", accessToken: "SENTINEL-token", timeoutMs: 40000 }));
      await siteLogs(req(`/api/admin/sites/site_a1/logs${q}`), site("site_a1"));
      expect(fetchUpstream).toHaveBeenLastCalledWith(`v1/admin/sites/site_a1/logs?tail=${n}`, expect.objectContaining({ method: "GET", timeoutMs: 40000 }));
    }
  });

  it("refuse a component or site id outside the closed forms and forward nothing", async () => {
    for (const v of BAD) {
      expect((await panelLogs(req("/x"), comp(v))).status).toBe(400);
      expect((await siteLogs(req("/x"), site(v === "docker" || v === "hp_mariadb" ? "../x" : v))).status).toBe(400);
    }
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("the logs route takes the five parts and the seven journals, and no name near them", async () => {
    for (const c of [...PANEL_CONTAINERS, ...HOST_JOURNAL_SOURCES]) {
      await panelLogs(req(`/api/admin/logs/${c}?tail=500`), comp(c));
      expect(fetchUpstream).toHaveBeenLastCalledWith(`v1/admin/logs/${c}?tail=500`, expect.objectContaining({ method: "GET", timeoutMs: 40000 }));
    }
    expect(fetchUpstream).toHaveBeenCalledTimes(12);
    fetchUpstream.mockClear();
    for (const v of NEAR) expect((await panelLogs(req("/x"), comp(v))).status, v).toBe(400);
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("answer 401 without a session and forward nothing", async () => {
    session.value = null;
    expect((await panelLogs(req("/x"), comp("phpmyadmin"))).status).toBe(401);
    expect((await siteLogs(req("/x"), site("site_a1"))).status).toBe(401);
    expect(fetchUpstream).not.toHaveBeenCalled();
  });
});

describe("(d) Logs page", () => {
  it("offers the five parts and the sites, says where the services' logs are, links to Audit", async () => {
    const html = decode(render(await AdminLogsPage(sp({ source: "sftp", tail: "500" }))));
    expect(html).toContain(`label="${en.admin.logs.panelGroup}"`);
    expect(html).toContain(`label="${en.admin.logs.sitesGroup}"`);
    for (const c of PANEL_CONTAINERS) expect(html).toContain(`<option value="${c}"`);
    expect(html).toContain(`>${en.admin.health.components.sftp}</option>`);
    expect(html).toContain(`<option value="site:site_a1">Hotel A (Acme)</option>`);
    expect(html).toContain(`<option value="site:site_b2">Shop B (${en.admin.health.unassigned})</option>`);
    expect(html).toContain(en.admin.logs.services);
    expect(html).toContain('href="/admin/audit"');
    expect(html).toMatch(/<label[^>]*for="log-source"/);
    expect(html).toMatch(/<label[^>]*for="log-tail"/);
    expect(html).toContain(en.admin.logs.viewer.visits);
    expect(html).not.toContain(en.admin.logs.choose);
  });

  it("a third group between the parts and the sites lists the seven journals in words, and opens one in the one-panel viewer", async () => {
    for (const [locale, m] of [["en", en]] as const) {
      const html = decode(render(await AdminLogsPage(sp({ source: "hp-os-upgrade" })), locale)).replace(' selected=""', "");
      const t = m.admin.logs;
      const at = (s: string) => html.indexOf(s);
      expect(at(`label="${t.panelGroup}"`)).toBeLessThan(at(`label="${t.hostGroup}"`));
      expect(at(`label="${t.hostGroup}"`)).toBeLessThan(at(`label="${t.sitesGroup}"`));
      for (const s of HOST_SERVICES) expect(html).toContain(`<option value="${HOST_SERVICE_UNIT[s]}">${m.admin.health.components[s]}</option>`);
      for (const u of ["hp-panel-update", "hp-os-refresh", "hp-os-upgrade"] as const) expect(html).toContain(`<option value="${u}">${t.units[u]}</option>`);
      expect(html.match(/<option value="hp-/g)).toHaveLength(HOST_JOURNAL_SOURCES.length);
      expect(html).toContain(t.viewer.journal);
      expect(html).not.toContain(t.viewer.visits);
      expect(html).not.toContain(t.viewer.errors);
    }
  });

  it("a source outside the closed forms shows choose and loads nothing", async () => {
    for (const source of [...BAD, ...NEAR, "site:a/b"]) {
      hooks.on = true;
      hooks.slots = [];
      hooks.i = 0;
      hooks.effects = [];
      const html = render(await AdminLogsPage(sp({ source })));
      hooks.on = false;
      expect(html).toContain(en.admin.logs.choose);
      expect(html).not.toContain(en.admin.logs.viewer.visits);
      expect(hooks.effects).toHaveLength(0);
    }
  });

  it("shows sitesFailed and only the panel group when the sites cannot be read", async () => {
    fetchServerAdminSites.mockResolvedValue(null);
    const html = decode(render(await AdminLogsPage(sp({}))));
    expect(html).toContain(en.admin.logs.sitesFailed);
    expect(html).not.toContain(`label="${en.admin.logs.sitesGroup}"`);
    expect(html).toContain(en.admin.logs.panelGroup);
  });
});

describe("(e) SiteLogs", () => {
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", (...a: unknown[]) => fetchSpy(...a));
  // Renders, runs the load effect, waits for it, renders again.
  const run = async (el: ReactElement) => {
    hooks.on = true;
    hooks.slots = [];
    hooks.effects = [];
    hooks.i = 0;
    render(el);
    hooks.effects.forEach((f) => f());
    for (let n = 0; n < 5; n++) await new Promise((r) => setTimeout(r, 0));
    hooks.i = 0;
    const html = render(el);
    hooks.on = false;
    return html;
  };
  const answer = (status: number, body: unknown) => fetchSpy.mockResolvedValue({ ok: status < 400, status, json: async () => body });

  it("the customer page sends the same request as before", async () => {
    customer.getCustomerContext.mockResolvedValue({ orgId: "org-1" });
    customer.getSite.mockResolvedValue({ ok: true, data: { id: "s1" } });
    answer(200, { data: [{ at: null, stream: "stdout", text: "GET /" }] });
    const html = await run((await SiteLogsPage({ params: Promise.resolve({ siteId: "s1" }) }))!);
    expect(fetchSpy).toHaveBeenCalledWith("/api/bff/orgs/org-1/managed-sites/s1/logs?tail=200", { cache: "no-store" });
    expect(html).toContain(en.site.logs.visits);
    expect(html).toContain("GET /");
  });

  it("customer texts by default, admin texts when asked", async () => {
    answer(503, null);
    expect(await run(createElement(SiteLogs, { url: "/u" }))).toContain(en.site.logs.unavailable);
    const admin = await run(createElement(SiteLogs, { url: "/api/admin/logs/sftp?tail=100", admin: true }));
    expect(fetchSpy).toHaveBeenLastCalledWith("/api/admin/logs/sftp?tail=100", { cache: "no-store" });
    expect(decode(admin)).toContain(en.admin.logs.viewer.unavailable);
    expect(admin).toContain('role="alert"');
    answer(404, { error: { code: "NOT_FOUND" } });
    expect(decode(await run(createElement(SiteLogs, { url: "/u", admin: true })))).toContain(en.admin.logs.viewer.notFound);
    expect(decode(await run(createElement(SiteLogs, { url: "/u" })))).not.toContain(en.admin.logs.viewer.notFound);
    answer(200, { data: [{ at: null, stream: "stderr", text: "boom" }] });
    const ok = await run(createElement(SiteLogs, { url: "/u", admin: true }));
    expect(ok).toContain(en.admin.logs.viewer.errors);
    expect(ok).toContain("boom");
    expect(ok).toContain('role="status"');
  });

  it("journal mode draws one panel with every line, and a 503 says the journal cannot be read", async () => {
    answer(200, { data: [{ at: null, stream: "stdout", text: "Started job" }] });
    const one = decode(await run(createElement(SiteLogs, { url: "/api/admin/logs/hp-api?tail=200", admin: true, journal: true })));
    expect(one).toContain(en.admin.logs.viewer.journal);
    expect(one).toContain("Started job");
    expect(one).not.toContain(en.admin.logs.viewer.visits);
    expect(one).not.toContain(en.admin.logs.viewer.errors);
    expect(one.match(/<pre/g)).toHaveLength(1);
    answer(503, null);
    const down = decode(await run(createElement(SiteLogs, { url: "/u", admin: true, journal: true })));
    expect(down).toContain(en.admin.logs.viewer.journalUnavailable);
    expect(down).not.toContain(en.admin.logs.viewer.unavailable);
    expect(down).toContain('role="alert"');
  });

  it("R186 2.3: the status line says the load ended, in both languages and both text groups; not after a failure", async () => {
    const status = (html: string) => html.match(/<p role="status"[^>]*>([^<]*)<\/p>/)?.[1];
    const runIn = async (el: ReactElement, locale: "en" | "it") => {
      hooks.on = true;
      hooks.slots = [];
      hooks.effects = [];
      hooks.i = 0;
      render(el, locale);
      hooks.effects.forEach((f) => f());
      for (let n = 0; n < 5; n++) await new Promise((r) => setTimeout(r, 0));
      hooks.i = 0;
      const html = render(el, locale);
      hooks.on = false;
      return html;
    };
    for (const [locale, m] of [["en", en], ["it", itMsgs]] as const) {
      answer(200, { data: [{ at: null, stream: "stdout", text: "GET /" }] });
      expect(status(await runIn(createElement(SiteLogs, { url: "/u" }), locale))).toBe(m.site.logs.loaded);
      expect(status(await runIn(createElement(SiteLogs, { url: "/u", admin: true }), locale))).toBe(m.admin.logs.viewer.loaded);
      answer(503, null);
      expect(status(await runIn(createElement(SiteLogs, { url: "/u" }), locale))).toBe("");
      expect(status(await runIn(createElement(SiteLogs, { url: "/u", admin: true }), locale))).toBe("");
    }
    expect(en.site.logs.loaded).not.toBe(itMsgs.site.logs.loaded);
    expect(en.admin.logs.viewer.loaded).not.toBe(itMsgs.admin.logs.viewer.loaded);
  });
});

describe("(f)(g) audit address", () => {
  it("parseTrail keeps a list of ids and drops anything else", () => {
    expect(parseTrail("aud_1,aud_2")).toEqual(["aud_1", "aud_2"]);
    for (const v of ["aud_1,,aud_2", ",,,", "", "aud_1,../x", undefined, Array(AUDIT_TRAIL_MAX).fill("a").join(","), Array(101).fill("a").join(",")])
      expect(parseTrail(v)).toEqual([]);
    expect(parseTrail(Array(AUDIT_TRAIL_MAX - 1).fill("a").join(","))).toHaveLength(AUDIT_TRAIL_MAX - 1);
  });

  it("auditHref writes filters and trail; isoToLocalInput round-trips", () => {
    expect(auditHref({}, [])).toBe("/admin/audit");
    expect(auditHref({ action: "site.create", from: "2026-01-01T00:00:00.000Z", organizationId: "" }, ["a", "b"])).toBe(
      "/admin/audit?action=site.create&from=2026-01-01T00%3A00%3A00.000Z&trail=a%2Cb",
    );
    const iso = "2026-03-04T05:06:00.000Z";
    expect(new Date(isoToLocalInput(iso)).toISOString()).toBe(iso);
    expect(isoToLocalInput("nope")).toBe("");
    expect(isoToLocalInput(undefined)).toBe("");
  });
});

describe("(h) Audit page", () => {
  const row = { id: "aud_9", timestamp: "2026-01-01T00:00:00.000Z", actorType: "user", actorId: "u1", action: "site.create", organizationId: null, targetType: "site", targetId: "s1", details: {} };
  const page = (hasMore: boolean, nextCursor: string | null = hasMore ? "aud_next" : null) =>
    fetchServerAudit.mockResolvedValue({ ok: true, data: [row], page: { nextCursor, hasMore } });

  it("asks for the page after the last cursor of the trail, with the filters", async () => {
    page(true);
    const html = decode(render(await AdminAuditPage(sp({ action: "site.create", from: "2026-01-01T00:00:00.000Z", trail: "aud_1,aud_2" }))));
    expect(fetchServerAudit).toHaveBeenCalledWith({ action: "site.create", from: "2026-01-01T00:00:00.000Z", cursor: "aud_2" });
    expect(html).toContain('href="/admin/audit?action=site.create&from=2026-01-01T00%3A00%3A00.000Z&trail=aud_1%2Caud_2%2Caud_next"');
    expect(html).toContain('href="/admin/audit?action=site.create&from=2026-01-01T00%3A00%3A00.000Z&trail=aud_1"');
    expect(html).toContain(en.admin.audit.next);
    expect(html).toContain(en.admin.audit.previous);
    expect(html).toContain("Page 3");
    expect(html).toContain("site.create");
  });

  it("R189 1.5: the filters are keyed by the address, so Clear, Back and Forward empty the boxes", async () => {
    page(false);
    // React keeps a mounted client component when only the query changes; a new key mounts it afresh.
    const filters = (el: unknown): ReactElement | undefined => {
      if (!el || typeof el !== "object") return undefined;
      if (Array.isArray(el)) return el.map(filters).find(Boolean);
      const e = el as ReactElement<{ children?: unknown }>;
      return e.type === AuditFilters ? e : filters(e.props?.children);
    };
    const withOrg = await AdminAuditPage(sp({ organizationId: "org_x", action: "site.create" }));
    const none = await AdminAuditPage(sp({}));
    expect(decode(render(withOrg))).toContain('value="org_x"');
    const box = decode(render(none)).match(new RegExp(`<input[^>]*aria-label="${en.admin.audit.filterOrg}"[^>]*>`))?.[0];
    expect(box).toBeDefined();
    expect(box).not.toMatch(/value="[^"]/);
    const [a, b] = [filters(withOrg), filters(none)];
    expect(a && b).toBeTruthy();
    expect(a!.key).not.toBeNull();
    expect(b!.key).not.toBeNull();
    expect(a!.key).not.toBe(b!.key);
    expect(filters(await AdminAuditPage(sp({ organizationId: "org_x", action: "site.create", trail: "aud_1" })))!.key).toBe(a!.key);
  });

  it("first page: no cursor, no Previous; no Next when hasMore is false, even with a cursor", async () => {
    page(false, "aud_next");
    const html = render(await AdminAuditPage(sp({})));
    expect(fetchServerAudit).toHaveBeenCalledWith({});
    expect(html).not.toContain(en.admin.audit.next);
    expect(html).not.toContain(en.admin.audit.previous);
  });

  it("Previous from page 2 goes back to the first page", async () => {
    page(false);
    const html = render(await AdminAuditPage(sp({ trail: "aud_1" })));
    expect(html).toContain('href="/admin/audit"');
    expect(html).toContain(en.admin.audit.previous);
  });

  it("a bad trail is dropped, not sent", async () => {
    page(false);
    await AdminAuditPage(sp({ trail: "aud_1,,x" }));
    await AdminAuditPage(sp({ trail: Array(150).fill("a").join(",") }));
    for (const call of fetchServerAudit.mock.calls) expect(call[0]).toEqual({});
  });

  it("stops at page 100 with the narrow sentence", async () => {
    page(true);
    const trail = Array(AUDIT_TRAIL_MAX - 1).fill("a").join(",");
    const html = decode(render(await AdminAuditPage(sp({ trail }))));
    expect(html).toContain("Page 100");
    expect(html).not.toContain(en.admin.audit.next);
    expect(html).toContain(en.admin.audit.narrow);
  });

  it("a 400 says filtersInvalid, any other failure loadFailed, both as alerts", async () => {
    fetchServerAudit.mockResolvedValue({ ok: false, outcome: "error", status: 400, code: "VALIDATION_ERROR" });
    const bad = decode(render(await AdminAuditPage(sp({ from: "nope" }))));
    expect(bad).toContain(en.admin.audit.filtersInvalid);
    expect(bad).toContain('role="alert"');
    expect(bad).toContain(en.admin.audit.apply); // the filters still render
    fetchServerAudit.mockResolvedValue({ ok: false, outcome: "error", status: 500 });
    const failed = decode(render(await AdminAuditPage(sp({}))));
    expect(failed).toContain(en.admin.audit.loadFailed);
    expect(failed).toContain('role="alert"');
  });

  it("the range fields and the other filters have labels", async () => {
    page(false);
    const html = render(await AdminAuditPage(sp({ from: "2026-01-01T00:00:00.000Z" })));
    for (const id of ["audit-from", "audit-to"]) expect(html).toMatch(new RegExp(`<label[^>]*for="${id}"`));
    expect(html).toContain('type="datetime-local"');
    expect(html).toContain(`aria-label="${en.admin.audit.filterOrg}"`);
    expect(html).toContain(`aria-label="${en.admin.audit.filterAction}"`);
  });
});
