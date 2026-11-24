import fs from "node:fs";
import path from "node:path";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WORDPRESS_ITEM_NAME_PATTERN,
  type OperationDto,
  type SiteBackupsDto,
  type SiteDetailDto,
  type SiteWordpressDto,
  type SiteWordpressStateDto,
} from "@hosting-panel/contracts";

// A tiny hook stand-in: while a slot is active, useState/useRef/useEffect/useCallback/useContext run on it,
// so a component function can be called directly and its state read and driven without a DOM.
const hooks = vi.hoisted(() => ({
  active: null as null | { state: unknown[]; refs: { current: unknown }[]; i: number; r: number; ctx: unknown },
}));

vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<typeof import("react")>();
  const useState = (init: unknown) => {
    const h = hooks.active;
    if (!h) return real.useState(init);
    const i = h.i++;
    if (!(i in h.state)) h.state[i] = typeof init === "function" ? (init as () => unknown)() : init;
    return [h.state[i], (v: unknown) => (h.state[i] = typeof v === "function" ? (v as (p: unknown) => unknown)(h.state[i]) : v)];
  };
  const useRef = (init: unknown) => {
    const h = hooks.active;
    if (!h) return real.useRef(init);
    const i = h.r++;
    h.refs[i] ??= { current: init };
    return h.refs[i];
  };
  const useEffect = (fn: () => void, deps?: unknown[]) => (hooks.active ? undefined : real.useEffect(fn, deps));
  const useCallback = <T,>(fn: T, deps: unknown[]) => (hooks.active ? fn : real.useCallback(fn as never, deps));
  const useContext = (c: never) => (hooks.active ? hooks.active.ctx : real.useContext(c));
  const patched = { useState, useRef, useEffect, useCallback, useContext };
  return { ...real, ...patched, default: { ...real, ...patched } };
});

const mockUpstream = vi.hoisted(() => ({ fetchUpstream: vi.fn() }));
const mockSession = vi.hoisted(() => ({ getSessionFromRequest: vi.fn(), getServerSession: vi.fn() }));
const mockData = vi.hoisted(() => ({ getCustomerContext: vi.fn(), getSite: vi.fn() }));
const mockApi = vi.hoisted(() => ({ serverGet: vi.fn(), fetchServerSiteDomains: vi.fn(), fetchServerOrgOperations: vi.fn() }));

vi.mock("@/lib/upstream", () => ({ fetchUpstream: mockUpstream.fetchUpstream }));
vi.mock("@/lib/server-session", () => mockSession);
vi.mock("@/app/sites/data", () => mockData);
vi.mock("@/lib/server-api", () => mockApi);
vi.mock("@/i18n/server", () => ({ getRequestLocale: vi.fn(async () => "en") }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/sites/site_qa1",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));

import { format, type Messages } from "@/i18n";
import { en } from "@/i18n/en";
import { it as itCatalog } from "@/i18n/it";
import { I18nProvider } from "@/i18n/provider";
import { SiteTabs } from "@/components/customer/site-tabs";
import { SiteBackups } from "@/components/customer/site-backups";
import { SiteWordpress, WordpressLastUpdate, wordpressErrorText } from "@/components/customer/site-wordpress";
import { ResetConfirmView, UpdateConfirmView, WordpressResetDialog, WordpressUpdateDialog } from "@/components/customer/wordpress-dialogs";
import SiteLayout from "@/app/sites/[siteId]/layout";
import SiteOverviewPage from "@/app/sites/[siteId]/page";
import SiteWordpressPage from "@/app/sites/[siteId]/wordpress/page";
import { GET as getWordpress } from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/wordpress/route";
import { POST as postRefresh } from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/wordpress/refresh/route";
import { POST as postUpdates } from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/wordpress/updates/route";
import { POST as postReset } from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/wordpress/administrators/[userId]/password-reset/route";

const SRC = path.resolve(__dirname, "../src");
const BASE = "/api/bff/orgs/org_qa1/managed-sites/site_qa1/wordpress";
// Test-only value shaped like the contract; not a real password.
const FAKE_PASSWORD = "QaOnlyNotARealPassword24x";
const JARGON = /\b(docker|container|image|network|volume|service|template|job|organization|revision|drift)s?\b/i;

const STATE: SiteWordpressStateDto = {
  checkedAt: "2026-11-15T10:00:00.000Z",
  problem: null,
  coreVersion: "6.6.1",
  coreUpdate: "6.7.0",
  updatesKnown: true,
  plugins: [
    { name: "akismet", title: "<img src=x onerror=alert(1)>", status: "active", version: '1.0"onmouseover="x', updateVersion: "5.4" },
    { name: "classic-editor", title: "Classic Editor", status: "inactive", version: "1.6.0", updateVersion: "1.7.0" },
  ],
  themes: [{ name: '"><script>x</script>', title: "", status: "active", version: "1.0", updateVersion: "2.0" }],
  administrators: [{ id: 7, login: "<b>boss</b>" }],
};
const dto = (over: Partial<SiteWordpressDto> = {}): SiteWordpressDto => ({
  backupsConfigured: true,
  state: STATE,
  runningOperation: null,
  lastUpdate: null,
  ...over,
});

const render = (element: ReactElement, locale: "en" | "it" = "en") =>
  renderToStaticMarkup(createElement(I18nProvider, { locale, messages: locale === "it" ? itCatalog : en, children: element }));
const textOf = (html: string) => html.replace(/<[^>]*>/g, " ").replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&");

/** Every leaf of a catalog subtree as [path, text]. */
function leaves(node: unknown, at = ""): [string, string][] {
  if (typeof node === "string") return [[at, node]];
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => leaves(v, at ? `${at}.${k}` : k));
}
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort();
const get = (root: unknown, dotted: string) => dotted.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], root);

/** Walks a React element tree without rendering components. */
function walk(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) node.forEach((n) => walk(n as ReactNode, out));
  else if (isValidElement(node)) {
    out.push(node);
    walk((node.props as { children?: ReactNode }).children, out);
  }
  return out;
}
/** Calls a component as a plain function on its own hook slot. */
function slot(messages: Messages = en) {
  const h = { state: [] as unknown[], refs: [] as { current: unknown }[], i: 0, r: 0, ctx: { locale: "en", messages } };
  return {
    h,
    run<P>(component: (p: P) => ReactNode, props: P): ReactElement[] {
      hooks.active = h;
      h.i = 0;
      h.r = 0;
      try {
        return walk(component(props));
      } finally {
        hooks.active = null;
      }
    },
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("B1. the catalogs", () => {
  const sections = (c: Messages) => ({
    wordpress: c.site.wordpress,
    overview: Object.fromEntries(Object.entries(c.site.overview).filter(([k]) => k.startsWith("wordpress"))),
    activity: { wordpressUpdate: c.site.activity.wordpressUpdate },
    backupKind: { pre_update: c.site.backups.kind.pre_update },
  });

  it("every key of the tab, its dialogs and the Overview card is in both catalogs, filled, with the same placeholders", () => {
    const enLeaves = leaves(sections(en));
    const itLeaves = new Map(leaves(sections(itCatalog)));
    expect(enLeaves.length).toBeGreaterThan(100);
    expect([...itLeaves.keys()].sort()).toEqual(enLeaves.map(([k]) => k).sort());
    for (const [key, text] of enLeaves) {
      const other = itLeaves.get(key)!;
      expect([key, text.trim().length > 0, other.trim().length > 0]).toEqual([key, true, true]);
      expect([key, placeholders(other)]).toEqual([key, placeholders(text)]);
    }
  });

  it("every key the sources name exists in both catalogs", () => {
    const refs: [string, string][] = [];
    const scan = (file: string, re: RegExp, prefix: string) => {
      const src = fs.readFileSync(path.join(SRC, file), "utf-8");
      for (const m of src.matchAll(re)) refs.push([file, `${prefix}${m[1]}`]);
    };
    scan("components/customer/site-wordpress.tsx", /\bt\.([a-zA-Z]+(?:\.[a-zA-Z]+)*)/g, "site.wordpress.");
    scan("app/sites/[siteId]/wordpress/page.tsx", /\bt\.([a-zA-Z]+(?:\.[a-zA-Z]+)*)/g, "site.wordpress.");
    scan("site-types/wordpress-overview-card.tsx", /m\.site\.overview\.(wordpress[a-zA-Z]*)/g, "site.overview.");
    scan("components/customer/wordpress-dialogs.tsx", /useMessages\(\)\.site\.wordpress\.(update|reset)\b/g, "site.wordpress.");
    const dialogs = fs.readFileSync(path.join(SRC, "components/customer/wordpress-dialogs.tsx"), "utf-8");
    for (const m of dialogs.matchAll(/\bt\.(update|tables|reset|failed|once|title|body|doneTitle|done|created|cancel|confirm|confirmAll|starting|resetting)\b(?:\.([a-zA-Z]+))?/g)) {
      // Inside the dialogs `t` is site.wordpress, .update or .reset; each name must resolve in one of them.
      const candidates = ["site.wordpress", "site.wordpress.update", "site.wordpress.reset"].map((p) => `${p}.${m[1]}${m[2] ? `.${m[2]}` : ""}`);
      const hit = candidates.find((c) => get(en, c) !== undefined);
      expect([m[0], hit]).toEqual([m[0], expect.any(String)]);
      refs.push(["components/customer/wordpress-dialogs.tsx", hit!]);
    }
    expect(refs.length).toBeGreaterThan(60);
    for (const [file, key] of refs) {
      for (const [name, catalog] of [["en", en], ["it", itCatalog]] as const) {
        const value = get(catalog, key);
        expect([file, name, key, value !== undefined && value !== ""]).toEqual([file, name, key, true]);
      }
    }
  });

  it("R128: itemUnknown and interrupted are there word for word", () => {
    expect(en.site.wordpress.outcome.itemUnknown).toBe(
      'This plugin or theme is no longer on the site. Nothing was changed. Press "Check now" to see the current list.',
    );
    expect(en.site.wordpress.outcome.interrupted).toBe("The update was stopped before anything was changed. Try again.");
    expect(itCatalog.site.wordpress.outcome.itemUnknown).toBe(
      "Questo plugin o tema non è più presente sul sito. Non è stato modificato nulla. Premi «Controlla ora» per vedere l'elenco aggiornato.",
    );
    expect(itCatalog.site.wordpress.outcome.interrupted).toBe("L'aggiornamento è stato interrotto prima di qualsiasi modifica. Riprova.");
  });

  it("no infrastructure jargon in the copy or in what the tab renders", () => {
    for (const c of [en, itCatalog]) {
      for (const [key, text] of leaves(sections(c))) expect([key, text]).not.toEqual([key, expect.stringMatching(JARGON)]);
    }
    expect("the job failed").toMatch(JARGON); // the scan can match
    const running = { id: "o", kind: "site.wordpress.update" as const, status: "processing" as const, steps: [{ key: "backup" as const, status: "running" as const }] };
    const lastUpdate = { operationId: "op", target: { scope: "all" as const }, status: "failed" as const, finishedAt: STATE.checkedAt, problem: "outcome_unknown" as const, backup: "taken" as const, items: [] };
    for (const locale of ["en", "it"] as const) {
      for (const d of [dto(), dto({ state: null }), dto({ runningOperation: running }), dto({ lastUpdate }), dto({ state: { ...STATE, problem: "config_broken", coreVersion: null } })]) {
        const text = textOf(render(createElement(SiteWordpress, { basePath: BASE, initial: d, csrfToken: "c" }), locale))
          .replace(STATE.themes[0]!.name, "");
        expect(text).not.toMatch(JARGON);
      }
    }
  });
});

describe("B2. untrusted text renders escaped", () => {
  const html = render(createElement(SiteWordpress, { basePath: BASE, initial: dto(), csrfToken: "c" }));

  it("title, theme name, login and version come out as text, also inside attributes", () => {
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b>");
    expect(html).not.toMatch(/\sonmouseover=/);
    expect(html).not.toContain('"onmouseover="');
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&quot;&gt;&lt;script&gt;x&lt;/script&gt;");
    expect(html).toContain("&lt;b&gt;boss&lt;/b&gt;");
    expect(html).toContain("1.0&quot;onmouseover=&quot;x");
    // The admin's reset button names the hostile login inside aria-label, escaped.
    expect(html).toContain(`aria-label="${format(en.site.wordpress.admins.resetLabel, { login: "&lt;b&gt;boss&lt;/b&gt;" })}"`);
  });

  it("dialog views and the last update keep hostile text as text", () => {
    const views = [
      render(createElement(UpdateConfirmView, { target: { scope: "plugin", name: "akismet" }, state: STATE, backupsConfigured: true })),
      render(createElement(ResetConfirmView, { login: "<b>boss</b>" })),
      render(
        createElement(WordpressLastUpdate, {
          last: {
            operationId: "op",
            target: { scope: "all" },
            status: "succeeded",
            finishedAt: STATE.checkedAt,
            problem: null,
            backup: "taken",
            items: [{ type: "plugin", name: "<img src=x onerror=alert(1)>", oldVersion: '1.0"onmouseover="x', newVersion: "2", status: "updated" }],
          },
        }),
      ),
    ].join("\n");
    expect(views).not.toMatch(/<img|<script|<b>|\sonmouseover=/);
    expect(views).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(views).toContain("&lt;b&gt;boss&lt;/b&gt;");
  });

  it("a name that does not fit the pattern gets no Update button", () => {
    expect(WORDPRESS_ITEM_NAME_PATTERN.test(STATE.themes[0]!.name)).toBe(false);
    const labels = [...html.matchAll(/aria-label="Update ([^"]*)"/g)].map((m) => m[1]);
    // Core, akismet and classic-editor; the theme with the hostile name has an update but no button.
    expect(labels).toHaveLength(3);
    expect(labels.join("|")).not.toContain("script");
    expect(html).toContain(format(en.site.wordpress.tables.updateAll, { count: 4 }));
  });

  it("no source file of the tab writes raw HTML", () => {
    const files = [
      "components/customer/site-wordpress.tsx",
      "components/customer/wordpress-dialogs.tsx",
      "components/admin/create-customer-dialog.tsx",
      "lib/site-wordpress.ts",
      "app/sites/[siteId]/wordpress/page.tsx",
      "app/sites/[siteId]/page.tsx",
      "site-types/wordpress-overview-card.tsx",
      "app/sites/[siteId]/layout.tsx",
      "components/customer/site-tabs.tsx",
    ];
    for (const f of files) expect([f, fs.readFileSync(path.join(SRC, f), "utf-8").includes("dangerouslySetInnerHTML")]).toEqual([f, false]);
  });
});

const SITE = {
  id: "site_qa1",
  organizationId: "org_qa1",
  hostAllocationId: "alloc_qa1",
  name: "QA Site",
  slug: "qa-site",
  status: "ready",
  phpVersion: "8.4",
  siteType: "wordpress",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  services: [],
  domains: [],
  driftSummary: { totalServices: 0, inSyncCount: 0, driftedCount: 0, unknownCount: 0, overallDriftStatus: "in_sync" },
} as unknown as SiteDetailDto;
const SESSION = { csrfToken: "csrf-qa", accessToken: "qa-only-token" };
const params = Promise.resolve({ siteId: "site_qa1" });
const context = (flag: boolean) => ({ orgId: "org_qa1", session: SESSION, loadError: false, capabilities: { wordpressToolsAvailable: flag } });

describe("B3. the tab is there only for a WordPress site on a server with the tools", () => {
  beforeEach(() => {
    mockApi.fetchServerSiteDomains.mockResolvedValue(null);
    mockApi.fetchServerOrgOperations.mockResolvedValue([]);
  });
  afterEach(() => vi.clearAllMocks());

  const tabsOf = async (site: SiteDetailDto, flag: boolean) => {
    mockData.getCustomerContext.mockResolvedValue(context(flag));
    mockData.getSite.mockResolvedValue({ ok: true, data: site });
    const html = render((await SiteLayout({ children: null, params })) as ReactElement);
    return [...html.matchAll(/href="(\/sites\/[^"]+)"/g)].map((m) => m[1]);
  };

  it("second tab for a WordPress site with the flag; absent without the flag or for a site that is not WordPress", async () => {
    const on = await tabsOf(SITE, true);
    expect(on[0]).toBe("/sites/site_qa1");
    expect(on[1]).toBe("/sites/site_qa1/wordpress");
    expect(await tabsOf(SITE, false)).not.toContain("/sites/site_qa1/wordpress");
    expect(await tabsOf({ ...SITE, phpVersion: null, siteType: null }, true)).not.toContain("/sites/site_qa1/wordpress");
    const tabs = render(createElement(SiteTabs, { siteId: "site_qa1" }));
    expect(tabs).not.toContain("/wordpress");
  });

  it("the page without the tools shows the not-available view; for a site that is not WordPress it is not found", async () => {
    mockData.getCustomerContext.mockResolvedValue(context(false));
    mockData.getSite.mockResolvedValue({ ok: true, data: SITE });
    // R144: the read route answers 200 with an empty state when the tools are off (R138.2); the page must not call it.
    mockApi.serverGet.mockResolvedValue({ ok: true, data: { backupsConfigured: false, state: null, runningOperation: null, lastUpdate: null } });
    const html = textOf(render((await SiteWordpressPage({ params })) as ReactElement));
    expect(html).toContain(en.site.wordpress.notAvailable);
    expect(html).not.toContain(en.site.wordpress.header.checkNow);
    expect(mockApi.serverGet).not.toHaveBeenCalled();

    mockData.getCustomerContext.mockResolvedValue(context(true));
    const loaded = textOf(render((await SiteWordpressPage({ params })) as ReactElement));
    // R169.4: the tab loads its own state and the import state for the card.
    expect(mockApi.serverGet.mock.calls.map((c) => c[0])).toEqual([
      "v1/organizations/org_qa1/managed-sites/site_qa1/wordpress",
      "v1/organizations/org_qa1/managed-sites/site_qa1/wordpress/import",
    ]);
    expect(loaded).toContain(en.site.wordpress.header.checkNow);
    expect(loaded).not.toContain(en.site.wordpress.notAvailable);

    mockData.getSite.mockResolvedValue({ ok: true, data: { ...SITE, phpVersion: null, siteType: null } });
    mockApi.serverGet.mockClear();
    await expect(SiteWordpressPage({ params })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockApi.serverGet).not.toHaveBeenCalled();
  });
});

describe("B4. Backups and Overview name the WordPress work", () => {
  afterEach(() => vi.clearAllMocks());

  it("a pre_update copy reads 'Before an update' / 'Prima di un aggiornamento'", () => {
    const initial: SiteBackupsDto = {
      available: true,
      configured: true,
      retentionDays: 14,
      manualKept: 3,
      runningOperationId: null,
      lastRestore: null,
      backups: [
        { id: "bkp_qa1", kind: "pre_update", status: "succeeded", startedAt: "2026-11-15T04:00:00.000Z", finishedAt: "2026-11-15T04:02:00.000Z", sizeBytes: 2048, problem: null, archive: null },
      ],
    } as unknown as SiteBackupsDto;
    const props = { basePath: "/api/bff/orgs/org_qa1/managed-sites/site_qa1/backups", initial, csrfToken: "c", siteName: "QA Site" };
    expect(textOf(render(createElement(SiteBackups, props)))).toContain("Before an update");
    expect(textOf(render(createElement(SiteBackups, props), "it"))).toContain("Prima di un aggiornamento");
  });

  it("the Overview activity names a WordPress update and never a check", async () => {
    const op = (id: string, kind: string, status: string, at: string) =>
      ({ id, organizationId: "org_qa1", kind, status, resourceType: "site", resourceId: "site_qa1", requestedByUserId: null, errorCode: null, errorMessage: null, submittedAt: at, startedAt: null, completedAt: null, updatedAt: at, steps: [] }) as unknown as OperationDto;
    mockData.getCustomerContext.mockResolvedValue(context(true));
    mockData.getSite.mockResolvedValue({ ok: true, data: SITE });
    mockApi.fetchServerOrgOperations.mockResolvedValue([
      op("op_u", "site.wordpress.update", "succeeded", "2026-11-15T10:00:00.000Z"),
      op("op_i", "site.wordpress.inspect", "failed", "2026-11-15T11:00:00.000Z"),
    ]);
    mockApi.serverGet.mockResolvedValue({ ok: true, data: dto() });
    const html = render((await SiteOverviewPage({ params })) as ReactElement);
    const text = textOf(html);
    // One activity row with its time: the update; the later check is not listed.
    const rows = [...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => textOf(m[1]!)).filter((r) => /2026/.test(r));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain(format(en.site.activity.done, { action: en.site.activity.wordpressUpdate }));
    expect(html.match(/<time /g)).toHaveLength(1);
    expect(text).not.toContain(format(en.site.activity.failed, { action: en.site.activity.wordpressUpdate }));
    expect(text).toContain(format(en.site.overview.wordpressCount, { count: 4 }));
  });
});

describe("B5. the password is shown once; an unseen end says the outcome is unknown", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("the reset dialog shows the password, and after closing it is gone from the output and the state", async () => {
    const d = slot();
    const closed: boolean[] = [];
    const props = {
      open: true,
      onOpenChange: (o: boolean) => closed.push(o),
      login: "admin",
      onConfirm: async () => ({ ok: true as const, temporaryPassword: FAKE_PASSWORD }),
    };
    const confirmRow = d.run(WordpressResetDialog, props).find((e) => (e.props as { confirm?: string }).confirm === en.site.wordpress.reset.confirm)!;
    (confirmRow.props as { onConfirm: () => void }).onConfirm();
    await tick();
    const shown = d.run(WordpressResetDialog, props);
    const body = shown.find((e) => (e.props as { password?: string }).password !== undefined)!;
    expect((body.props as { password: string }).password).toBe(FAKE_PASSWORD);
    expect(render(body)).toContain(FAKE_PASSWORD);
    expect(d.h.state).toContain(FAKE_PASSWORD);

    const done = shown.find((e) => (e.props as { children?: unknown }).children === en.site.wordpress.reset.done)!;
    (done.props as { onClick: () => void }).onClick();
    expect(closed).toEqual([false]);
    const after = d.run(WordpressResetDialog, props);
    expect(JSON.stringify(d.h.state)).not.toContain(FAKE_PASSWORD);
    expect(after.some((e) => JSON.stringify(e.props, (_k, v: unknown) => (isValidElement(v) ? undefined : v)).includes(FAKE_PASSWORD))).toBe(false);
  });

  it("the tab hands the password to the dialog and keeps none; 503 unavailable, 504 and no answer say the outcome is unknown", async () => {
    const answers: (() => Promise<Response>)[] = [
      async () => new Response(JSON.stringify({ data: { temporaryPassword: FAKE_PASSWORD } }), { status: 200 }),
      async () => new Response(JSON.stringify({ error: { code: "DOCKER_ENGINE_UNAVAILABLE", message: "x", details: [{ reason: "unavailable" }] } }), { status: 503 }),
      async () => new Response("gateway timeout", { status: 504 }),
      async () => {
        throw new TypeError("network down");
      },
    ];
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        return answers.shift()!();
      }),
    );
    const tab = slot();
    const props = { basePath: BASE, initial: dto(), csrfToken: "c" };
    const reset = tab.run(SiteWordpress, props).find((e) => (e.props as { "aria-label"?: string })["aria-label"]?.startsWith("Reset the password"))!;
    (reset.props as { onClick: () => void }).onClick();
    const dialog = tab.run(SiteWordpress, props).find((e) => e.type === WordpressResetDialog)!;
    const onConfirm = (dialog.props as { onConfirm: () => Promise<unknown> }).onConfirm;

    expect(await onConfirm()).toEqual({ ok: true, temporaryPassword: FAKE_PASSWORD });
    expect(JSON.stringify(tab.h.state)).not.toContain(FAKE_PASSWORD);
    const unknown = { ok: false, error: en.site.wordpress.reset.failed.unknown };
    expect(await onConfirm()).toEqual(unknown);
    expect(await onConfirm()).toEqual(unknown);
    expect(await onConfirm()).toEqual(unknown);
    expect(urls).toEqual(Array(4).fill(`${BASE}/administrators/7/password-reset`));
    expect(wordpressErrorText(itCatalog, "reset", 504, null)).toBe(itCatalog.site.wordpress.reset.failed.unknown);
  });
});

describe("B6. the BFF refuses before any upstream call", () => {
  const ctx = (userId?: string) => ({ params: Promise.resolve({ orgId: "org_qa1", siteId: "site_qa1", ...(userId ? { userId } : {}) }) });
  const req = (sub: string, o: { method?: string; csrf?: string | null; origin?: string; body?: string } = {}) =>
    new Request(`http://localhost:3000${BASE}${sub}`, {
      method: o.method ?? "POST",
      headers: {
        Host: "localhost:3000",
        Origin: o.origin ?? "http://localhost:3000",
        "Content-Type": "application/json",
        ...(o.csrf === null ? {} : { "X-CSRF-Token": o.csrf ?? SESSION.csrfToken }),
      },
      ...(o.method === "GET" ? {} : { body: o.body ?? "{}" }),
    });

  beforeEach(() => {
    mockSession.getSessionFromRequest.mockResolvedValue(SESSION);
    mockUpstream.fetchUpstream.mockResolvedValue({ ok: true, status: 202, data: { data: { siteId: "site_qa1", operationId: "op_qa" } } });
  });
  afterEach(() => vi.clearAllMocks());

  it("a bad userId, a bad update body, no CSRF token, a foreign Origin and no session", async () => {
    for (const userId of ["0", "07", "-1", "1;id", "1/../2", "abc", "12345678901", "1 ", "%31"]) {
      expect([userId, (await postReset(req(`/administrators/x/password-reset`), ctx(userId))).status]).toEqual([userId, 400]);
    }
    const bodies = [
      { scope: "plugin" },
      { scope: "plugin", name: "plugin; id" },
      { scope: "plugin", name: "$(id)" },
      { scope: "theme", name: "-x" },
      { scope: "plugin", name: "a".repeat(101) },
      { scope: "all", name: "x" },
      { scope: "core", extra: true },
      { scope: "everything" },
      { scope: "plugin", name: "../x" },
      [],
      null,
    ];
    for (const body of bodies) {
      expect([body, (await postUpdates(req("/updates", { body: JSON.stringify(body) }), ctx())).status]).toEqual([body, 400]);
    }
    expect((await postRefresh(req("/refresh", { body: JSON.stringify({ force: true }) }), ctx())).status).toBe(400);
    expect((await postReset(req("/administrators/7/password-reset", { body: JSON.stringify({ password: "x" }) }), ctx("7"))).status).toBe(400);

    const posts = (o: Parameters<typeof req>[1]) => [
      postRefresh(req("/refresh", o), ctx()),
      postUpdates(req("/updates", { ...o, body: JSON.stringify({ scope: "all" }) }), ctx()),
      postReset(req("/administrators/7/password-reset", o), ctx("7")),
    ];
    for (const o of [{ csrf: null }, { csrf: "wrong-token" }, { origin: "https://evil.example" }]) {
      expect([o, ...(await Promise.all(posts(o))).map((r) => r.status)]).toEqual([o, 403, 403, 403]);
    }
    mockSession.getSessionFromRequest.mockResolvedValue(null);
    expect((await Promise.all(posts({}))).map((r) => r.status)).toEqual([401, 401, 401]);
    expect((await getWordpress(req("", { method: "GET" }), ctx())).status).toBe(401);
    expect(mockUpstream.fetchUpstream).not.toHaveBeenCalled();

    // The same requests pass once well-formed, so the refusals above are the checks.
    mockSession.getSessionFromRequest.mockResolvedValue(SESSION);
    expect((await Promise.all(posts({}))).map((r) => r.status)).toEqual([202, 202, 202]);
    expect(mockUpstream.fetchUpstream).toHaveBeenCalledTimes(3);
  });

  it("the reset answer is no-store and keeps temporaryPassword; it never carries an Idempotency-Key", async () => {
    mockUpstream.fetchUpstream.mockResolvedValue({ ok: true, status: 200, data: { data: { temporaryPassword: FAKE_PASSWORD } } });
    const res = await postReset(req("/administrators/7/password-reset"), ctx("7"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    expect(await res.json()).toEqual({ data: { temporaryPassword: FAKE_PASSWORD } });
    const [upstreamPath, options] = mockUpstream.fetchUpstream.mock.calls[0]! as [string, { idempotencyKey?: string; method: string; timeoutMs: number }];
    expect(upstreamPath).toBe("v1/organizations/org_qa1/managed-sites/site_qa1/wordpress/administrators/7/password-reset");
    expect(options.method).toBe("POST");
    expect(options.idempotencyKey).toBeUndefined();
    expect(options.timeoutMs).toBeGreaterThan(75_000);
  });
});

describe("B7. a check or an update keeps its Idempotency-Key until an answer comes (issue #146)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const answering = (answers: Array<number | "lost">) => {
    const sent: Array<[string, string | null]> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        sent.push([url, new Headers(init?.headers).get("idempotency-key")]);
        const a = answers.shift() ?? "lost";
        if (a === "lost") throw new TypeError("network down");
        const body = a < 300 ? { data: { siteId: "site_qa1", operationId: `op_${"c".repeat(32)}` } } : { error: { code: "INTERNAL_ERROR", message: "x" } };
        return new Response(JSON.stringify(body), { status: a });
      }),
    );
    return sent;
  };
  const settle = async () => {
    for (let i = 0; i < 10; i++) await tick();
  };
  const props = { basePath: BASE, initial: dto(), csrfToken: "c" };
  const sameThenNew = (sent: Array<[string, string | null]>, url: string) => {
    expect(sent.map(([u]) => u)).toEqual(Array(4).fill(url));
    const keys = sent.map(([, key]) => key);
    expect(keys[0]).toMatch(/\S{8,}/);
    expect(keys.slice(0, 3)).toEqual([keys[0], keys[0], keys[0]]);
    expect(keys[3]).toMatch(/\S{8,}/);
    expect(keys[3]).not.toBe(keys[0]);
  };

  it("Check now: no answer, then a 503, then the 202 all carry one key; the next check has a new one", async () => {
    const sent = answering(["lost", 503, 202, 202]);
    const tab = slot();
    const labels: unknown[] = [en.site.wordpress.header.checkNow, en.site.wordpress.header.checking];
    for (let i = 0; i < 4; i++) {
      const button = tab.run(SiteWordpress, props).find((e) => labels.includes((e.props as { children?: unknown }).children))!;
      (button.props as { onClick: () => void }).onClick();
      await settle();
    }
    sameThenNew(sent, `${BASE}/refresh`);
  });

  it("an update: no answer, then a 503, then the 202 all carry one key; the next update has a new one", async () => {
    const sent = answering(["lost", 503, 202, 202]);
    const tab = slot();
    const core = format(en.site.wordpress.tables.updateLabel, { name: en.site.wordpress.tables.core, version: STATE.coreUpdate! });
    const dialog = () => tab.run(SiteWordpress, props).find((e) => e.type === WordpressUpdateDialog);
    for (let i = 0; i < 4; i++) {
      if (!dialog()) {
        const open = tab.run(SiteWordpress, props).find((e) => (e.props as { "aria-label"?: string })["aria-label"] === core)!;
        (open.props as { onClick: () => void }).onClick();
      }
      await (dialog()!.props as { onConfirm: () => Promise<unknown> }).onConfirm();
    }
    sameThenNew(sent, `${BASE}/updates`);
  });

  it("a check whose answer was lost does not come back after an update was accepted: the next check has a new key", async () => {
    const sent = answering(["lost", 202, 202]);
    const tab = slot();
    const labels: unknown[] = [en.site.wordpress.header.checkNow, en.site.wordpress.header.checking];
    const checkNow = async () => {
      const button = tab.run(SiteWordpress, props).find((e) => labels.includes((e.props as { children?: unknown }).children))!;
      (button.props as { onClick: () => void }).onClick();
      await settle();
    };
    await checkNow();
    const core = format(en.site.wordpress.tables.updateLabel, { name: en.site.wordpress.tables.core, version: STATE.coreUpdate! });
    const open = tab.run(SiteWordpress, props).find((e) => (e.props as { "aria-label"?: string })["aria-label"] === core)!;
    (open.props as { onClick: () => void }).onClick();
    await (tab.run(SiteWordpress, props).find((e) => e.type === WordpressUpdateDialog)!.props as { onConfirm: () => Promise<unknown> }).onConfirm();
    // The accepted update ran under the site's lock, so the lost check has ended; the next check is a new one.
    await checkNow();
    expect(sent.map(([u]) => u)).toEqual([`${BASE}/refresh`, `${BASE}/updates`, `${BASE}/refresh`]);
    const keys = sent.map(([, key]) => key);
    for (const k of keys) expect(k).toMatch(/\S{8,}/);
    expect(new Set(keys).size).toBe(3);
  });
});
