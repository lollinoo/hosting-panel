// QA slice Q3 (ux-customer §10): one name for what the customer owns. The 33 changed values (§7) never say
// «sito/siti/site/sites», the website wording that must stay still says it, and the rendered list, chooser,
// switcher and support banner use the same words in Italian and English, with no infrastructure jargon.
import fs from "node:fs";
import path from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PLATFORM_OPS_ORG_ID } from "@hosting-panel/contracts";
import type { AppStackSummaryDto, CustomerAppTemplateSummaryDto, CustomerSiteTypeDto, ManagedSiteDto, SiteSummaryDto } from "@hosting-panel/contracts";

const lang = vi.hoisted(() => ({ current: "en" as "en" | "it" }));
const mockData = vi.hoisted(() => ({ getCustomerContext: vi.fn(), getSites: vi.fn() }));
const fetchUpstream = vi.hoisted(() => vi.fn());

vi.mock("@/app/sites/data", () => mockData);
vi.mock("@/lib/server-session", () => ({ getServerSession: async () => ({ accessToken: "tok", csrfToken: "csrf" }) }));
vi.mock("@/lib/upstream", () => ({ fetchUpstream: (...a: unknown[]) => fetchUpstream(...a) }));
vi.mock("@/i18n/server", () => ({ getRequestLocale: async () => lang.current }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useParams: () => ({}),
  usePathname: () => "/apps",
}));
// The menu's items render only when it is open: render them inline to read the switcher.
vi.mock("@/components/ui/dropdown-menu", async () => {
  const { createElement: h, Fragment } = await import("react");
  const pass = ({ children }: { children?: ReactNode }) => h(Fragment, null, children);
  return {
    DropdownMenu: pass,
    DropdownMenuTrigger: pass,
    DropdownMenuContent: ({ children }: { children?: ReactNode }) => h("div", { "data-menu": "" }, children),
    DropdownMenuItem: pass,
    DropdownMenuLabel: pass,
    DropdownMenuSeparator: () => null,
  };
});

import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { format, type Messages } from "@/i18n";
import { I18nProvider } from "@/i18n/provider";
import AppsPage from "@/app/apps/page";
import NewAppPage from "@/app/apps/new/page";
import { CustomerLayout } from "@/app/sites/customer-layout";

const DICT = { en, it: itMsgs } as const;
const LOCALES = ["it", "en"] as const;

const NOW = "2026-11-22T10:00:00.000Z";
const ORG = "org_a1";
const STACKS = `v1/organizations/${ORG}/app-stacks`;
const ADDRESSES = `v1/organizations/${ORG}/managed-sites`;
const TYPES = `v1/organizations/${ORG}/site-types`;
const CATALOG = `v1/organizations/${ORG}/app-templates`;
const ORG_PATH = `v1/organizations/${ORG}`;

const context = (over: Record<string, unknown> = {}) => ({
  session: { csrfToken: "csrf", user: { name: "Someone" } },
  orgId: ORG,
  loadError: false,
  capabilities: { applicationStacksAvailable: true },
  support: null,
  ...over,
});
const site = (id: string, name: string): SiteSummaryDto => ({
  id, organizationId: ORG, hostAllocationId: "al_1", name, slug: id, status: "ready", phpVersion: "8.3", siteType: "wordpress", createdAt: NOW, updatedAt: NOW,
});
const stack = (id: string, name: string): AppStackSummaryDto => ({
  id, name, status: "running", templateId: "atpl_notes", templateName: "Notes", templateVersionNumber: 2, componentCount: 2, unhealthyCount: 0, primaryHostname: "notes.example.test", updatedAt: NOW,
});
const wpType = (id: string): CustomerSiteTypeDto => ({
  id, name: id, description: null, module: "wordpress", phpVersions: ["8.4"], defaultPhpVersion: "8.4", parameters: [],
});
const NOTES = {
  id: "atpl_notes", name: "Notes", description: null, category: "content", versionId: "atv_notes_1", versionNumber: 1,
  componentCount: 1, cpuMilli: 500, memoryBytes: String(2 ** 28), volumeCount: 0, hasIngress: true,
} satisfies CustomerAppTemplateSummaryDto;
const BLOG = site("s1", "Blog");
const BOARD = stack("k1", "Notes board");

const html = (node: ReactNode) =>
  renderToStaticMarkup(createElement(I18nProvider, { locale: lang.current, messages: DICT[lang.current], children: node }))
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
const ok = (data: unknown) => ({ ok: true, status: 200, data: { data } });
const fail = (status: number, code: string) => ({ ok: false, status, error: { error: { code } } });
const answer = (byPath: Record<string, unknown>) =>
  fetchUpstream.mockImplementation(async (p: string) => byPath[p] ?? fail(404, "NOT_FOUND"));
/** What a reader sees: text nodes plus the labels read out by a screen reader; never an address or a class. */
const visible = (h: string) =>
  [
    h.replace(/<[^>]*>/g, " "),
    ...[...h.matchAll(/\b(?:aria-label|title|alt|placeholder)="([^"]*)"/g)].map((x) => x[1]!),
  ].join(" ").replace(/\s+/g, " ");

const SITE_WORD = /\bsit[oi]\b|\bsites?\b/i;
const jargon = /\b(container|docker|image|volume|network|service|template|mariadb|job|organization|revision|drift|allocation|outbox|relay|smtp|postfix|spf|dkim|schema|contenitore|contenitori|immagine|immagini|volumi|servizio|servizi|rete|reti|revisione|revisioni|organizzazione|organizzazioni)\b|HCP-SPEC|AC-F|ADR-/i;

const leaf = (m: Messages, p: string): string => {
  const v = p.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], m);
  if (typeof v !== "string") throw new Error(`no string at ${p}`);
  return v;
};
const placeholders = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1]!))].sort();

beforeEach(() => {
  vi.clearAllMocks();
  lang.current = "en";
  mockData.getCustomerContext.mockResolvedValue(context());
  mockData.getSites.mockResolvedValue([BLOG]);
  answer({});
});

// ---- 1. the 33 changed values (§7) -------------------------------------------------------------------------------
const CHANGED: ReadonlyArray<readonly [path: string, vars: readonly string[]]> = [
  ["shell.emptyTitle", []],
  ["shell.emptyBody", []],
  ["shell.emptyCta", []],
  ["shell.newSite", []],
  ["shell.switchSite", []],
  ["shell.yourSites", []],
  ["shell.support.mark", ["name", "time"]],
  ["shell.support.markUnassigned", ["time"]],
  ["site.title", []],
  ["site.tabsLabel", []],
  ["site.create.title", []],
  ["site.create.name", []],
  ["site.create.submit", []],
  ["site.create.usage", ["max", "used"]],
  ["site.create.limitReached", ["max"]],
  ["site.create.limitReachedSubmit", []],
  ["site.create.siteTypeLabel", []],
  ["site.create.siteTypeHint", []],
  ["site.create.options", []],
  ["site.create.siteTypeUnavailable", []],
  ["site.create.optionsChanged", []],
  ["site.create.invalid", []],
  ["site.create.noSiteTypes", []],
  ["site.manage.dangerHint", []],
  ["site.manage.delete", []],
  ["site.delete.title", []],
  ["site.delete.confirm", []],
  ["apps.unavailable.title", []],
  ["apps.unavailable.off", []],
  ["apps.unavailable.support", []],
  ["apps.unavailable.back", []],
  ["apps.list.empty", []],
  ["apps.list.col.version", []],
];

describe("the changed values (§7)", () => {
  it("the table lists exactly the 33 keys of the design, once each", () => {
    expect(CHANGED).toHaveLength(33);
    expect(new Set(CHANGED.map(([p]) => p)).size).toBe(33);
  });

  const cells = CHANGED.flatMap(([p, vars]) => LOCALES.map((l) => [p, l, vars] as const));

  it.each(cells)("%s (%s) never says site/sites/sito/siti, is not empty and keeps its placeholders", (p, l, vars) => {
    const v = leaf(DICT[l], p);
    expect(v.trim(), "not empty").not.toBe("");
    expect(v).not.toMatch(SITE_WORD);
    expect(v).not.toMatch(jargon);
    expect(placeholders(v)).toEqual([...vars]);
  });

  // Italian: «applicazione» is feminine, the wording that came from «sito» (masculine) must not survive in the agreement.
  const FEMININE = ["shell.emptyBody", "site.create.limitReached", "site.create.limitReachedSubmit", "site.manage.dangerHint", "site.delete.title", "apps.list.empty", "apps.unavailable.support"];
  it.each(FEMININE)("%s agrees with a feminine noun in Italian", (p) => {
    expect(leaf(itMsgs, p)).not.toMatch(/\b(un altro|uno|crearlo|eliminato|nuovo|questo)\b/i);
  });

  it.each([
    ["shell.newSite", "Nuova applicazione", "New application"],
    ["shell.yourSites", "Le tue applicazioni", "Your applications"],
    ["shell.switchSite", "Cambia applicazione", "Switch application"],
    ["shell.emptyCta", "Crea un'applicazione", "Create an application"],
    ["site.create.title", "Nuova applicazione WordPress", "New WordPress application"],
    ["site.create.submit", "Crea l'applicazione", "Create application"],
    ["site.delete.confirm", "Elimina l'applicazione", "Delete application"],
    ["apps.nav", "Applicazioni", "Applications"],
    ["apps.list.col.version", "Tipo", "Type"],
    ["apps.list.empty", "Non hai ancora nessuna applicazione.", "You do not have any applications yet."],
    ["apps.unavailable.back", "Torna alle applicazioni", "Back to applications"],
  ])("%s says what the owner asked for", (p, it, en_) => {
    expect(leaf(itMsgs, p)).toBe(it);
    expect(leaf(en, p)).toBe(en_);
  });

  it("the Italian and English leaves of the changed keys differ (no key was left in the other language)", () => {
    for (const [p] of CHANGED) expect(leaf(itMsgs, p), p).not.toBe(leaf(en, p));
  });
});

// ---- 2. the website wording that stays ---------------------------------------------------------------------------
describe("the wording kept on purpose", () => {
  // They mean the public website or a WordPress detail, not the customer's application.
  it.each([
    ["site.visit", /\bsito\b/i, /\bsite\b/i],
    ["site.create.siteTitle", /\bsito\b/i, /\bsite\b/i],
    ["site.create.intro", /\bsito\b/i, /\bsite\b/i],
  ])("%s still talks about the website", (p, reIt, reEn) => {
    expect(leaf(itMsgs, p)).toMatch(reIt);
    expect(leaf(en, p)).toMatch(reEn);
  });

  it("the stack category «web» keeps naming websites", () => {
    expect(leaf(itMsgs, "apps.category.web")).toBe("Siti web");
    expect(leaf(en, "apps.category.web")).toBe("Websites");
  });
});

// ---- 3. the two new keys -----------------------------------------------------------------------------------------
describe("the new keys", () => {
  it.each(LOCALES)("apps.list.wordpress and apps.list.partial exist in %s", (l) => {
    const list = DICT[l].apps.list as Record<string, unknown>;
    expect(list.wordpress).toBe("WordPress");
    expect(typeof list.partial).toBe("string");
    expect((list.partial as string).trim()).not.toBe("");
  });

  it.each(LOCALES)("apps.list.partial (%s) tells what to do, in the same name, without jargon or site words", (l) => {
    const v = leaf(DICT[l], "apps.list.partial");
    expect(v).not.toMatch(SITE_WORD);
    expect(v).not.toMatch(jargon);
    expect(v).toMatch(l === "it" ? /applicazioni/ : /applications/);
    expect(v).toMatch(l === "it" ? /Ricarica/ : /[Rr]eload/);
    expect(v).toMatch(l === "it" ? /amministratore/ : /administrator/);
    expect(placeholders(v)).toEqual([]);
  });

  it("the two languages carry the same set of keys under apps.list", () => {
    expect(Object.keys(itMsgs.apps.list).sort()).toEqual(Object.keys(en.apps.list).sort());
  });
});

// ---- 4. what a customer reads: the rendered screens, in Italian and in English ------------------------------------
const wpTypes = (n: number) => ok({ siteTypes: Array.from({ length: n }, (_, i) => wpType(`stpl_${"ab"[i]}`)) });
const limit = (used: number, max: number | null) => ok({ maxSites: max, siteCount: used });
const supportOf = (organizationId: string) => ({ organizationId, organizationName: "Customer A", expiresAt: NOW });

type Screen = { name: string; render: () => Promise<string>; mustSay: (m: Messages) => string[] };
const SCREENS: Screen[] = [
  {
    name: "the list with both kinds",
    render: async () => {
      answer({ [STACKS]: ok([BOARD]), [ADDRESSES]: ok([{ ...BLOG, primaryDomain: "blog.example.test" } satisfies ManagedSiteDto]) });
      return html(await AppsPage());
    },
    mustSay: (m) => [m.apps.list.title, m.apps.list.create, m.apps.list.col.version, m.apps.list.col.address, m.apps.list.wordpress, "Notes"],
  },
  {
    name: "the empty list",
    render: async () => {
      mockData.getSites.mockResolvedValue([]);
      answer({ [STACKS]: ok([]) });
      return html(await AppsPage());
    },
    mustSay: (m) => [m.apps.list.title, m.apps.list.empty, m.shell.emptyBody],
  },
  {
    name: "the list when one read failed",
    render: async () => {
      answer({ [STACKS]: fail(500, "INTERNAL_ERROR") });
      return html(await AppsPage());
    },
    mustSay: (m) => [m.apps.list.partial, m.apps.list.wordpress],
  },
  {
    name: "the chooser with a usage line",
    render: async () => {
      answer({ [TYPES]: wpTypes(2), [CATALOG]: ok({ templates: [NOTES], categories: ["content"] }), [ORG_PATH]: limit(1, 3) });
      return html(await NewAppPage());
    },
    mustSay: (m) => [m.apps.catalog.title, m.apps.list.wordpress, m.apps.catalog.choose, format(m.site.create.usage, { used: 1, max: 3 }), "Notes"],
  },
  {
    name: "the chooser with the limit reached",
    render: async () => {
      answer({ [TYPES]: wpTypes(2), [CATALOG]: ok({ templates: [NOTES], categories: ["content"] }), [ORG_PATH]: limit(3, 3) });
      return html(await NewAppPage());
    },
    mustSay: (m) => [m.apps.catalog.title, format(m.site.create.usage, { used: 3, max: 3 }), format(m.site.create.limitReached, { max: 3 }), "Notes"],
  },
  {
    name: "the chooser when the catalog failed",
    render: async () => {
      answer({ [TYPES]: wpTypes(1), [CATALOG]: fail(500, "INTERNAL_ERROR"), [ORG_PATH]: limit(0, null) });
      return html(await NewAppPage());
    },
    mustSay: (m) => [m.apps.catalog.title, m.apps.list.partial, m.apps.list.wordpress],
  },
  {
    name: "the shell with the switcher",
    render: async () => {
      answer({ [STACKS]: ok([BOARD]) });
      return html(await CustomerLayout({ children: createElement("p", null, "child") }));
    },
    mustSay: (m) => [m.apps.nav, m.shell.yourSites, `${m.shell.switchSite}: ${m.shell.yourSites}`, m.shell.newSite, m.apps.list.wordpress, "Notes board", "Blog"],
  },
  {
    name: "the shell of a support visit",
    render: async () => {
      mockData.getCustomerContext.mockResolvedValue(context({ support: supportOf(ORG) }));
      return html(await CustomerLayout({ children: createElement("p", null, "child") }));
    },
    mustSay: (m) => [m.apps.nav, m.shell.yourSites, m.shell.newSite, m.shell.support.leave],
  },
];

describe("rendered screens use one name, in both languages", () => {
  const cells = LOCALES.flatMap((l) => SCREENS.map((s) => [l, s.name, s] as const));

  it.each(cells)("[%s] %s", async (l, _name, screen) => {
    lang.current = l;
    const h = await screen.render();
    const text = visible(h);

    for (const s of screen.mustSay(DICT[l])) expect(text, s).toContain(s);
    // the website words stay out of every screen: the data in these fixtures never uses them
    expect(text).not.toMatch(SITE_WORD);
    expect(text).not.toMatch(jargon);
    expect(h).not.toContain(DICT[l].shell.loadErrorTitle);
    // nothing of the other language leaks through a hard-coded string
    const other = DICT[l === "it" ? "en" : "it"];
    for (const p of ["shell.newSite", "shell.yourSites", "apps.nav", "apps.list.title", "apps.list.create", "apps.list.partial", "apps.catalog.title"]) {
      if (leaf(other, p) !== leaf(DICT[l], p)) expect(text, p).not.toContain(leaf(other, p));
    }
  });

  it("in Italian the headline words are exactly «Applicazioni», «Nuova applicazione», «Le tue applicazioni», «Tipo»", async () => {
    lang.current = "it";
    answer({ [STACKS]: ok([BOARD]) });
    const shell = html(await CustomerLayout({ children: null }));
    expect(shell).toMatch(/<a [^>]*href="\/apps"[^>]*>Applicazioni<\/a>/);
    expect(shell).toContain("Le tue applicazioni");
    expect(shell).toContain("Nuova applicazione");
    expect(shell).toContain('aria-label="Cambia applicazione: Le tue applicazioni"');

    const list = html(await AppsPage());
    expect(list).toMatch(/<h1[^>]*>Le tue applicazioni<\/h1>/);
    expect(list).toMatch(/<a [^>]*href="\/apps\/new"[^>]*>Nuova applicazione<\/a>/);
    expect(list).toMatch(/<th[^>]*>Tipo<\/th>/);
    expect(list).not.toMatch(/<th[^>]*>Versione<\/th>/);
  });

  it("in English the same four are «Applications», «New application», «Your applications», «Type»", async () => {
    answer({ [STACKS]: ok([BOARD]) });
    const shell = html(await CustomerLayout({ children: null }));
    expect(shell).toMatch(/<a [^>]*href="\/apps"[^>]*>Applications<\/a>/);
    expect(shell).toContain("Your applications");
    expect(shell).toContain("New application");
    const list = html(await AppsPage());
    expect(list).toMatch(/<h1[^>]*>Your applications<\/h1>/);
    expect(list).toMatch(/<th[^>]*>Type<\/th>/);
  });

  it("the empty list no longer offers the old «create your first site» heading or button", async () => {
    mockData.getSites.mockResolvedValue([]);
    for (const l of LOCALES) {
      lang.current = l;
      answer({ [STACKS]: ok([]) });
      const h = html(await AppsPage());
      expect(h).not.toContain(DICT[l].shell.emptyTitle);
      expect(h).not.toContain(DICT[l].shell.emptyCta);
    }
  });

  // The support banner names the customer's applications, for a named customer and for the platform's own unassigned pool.
  it.each([
    ["it", ORG, /Vista di assistenza: stai vedendo le applicazioni di Customer A fino alle /],
    ["it", PLATFORM_OPS_ORG_ID, /Vista di assistenza: stai vedendo le applicazioni non assegnate a nessun cliente, fino alle /],
    ["en", ORG, /Support view: you are seeing the applications of Customer A until /],
    ["en", PLATFORM_OPS_ORG_ID, /Support view: you are seeing the applications not assigned to any customer, until /],
  ] as const)("[%s] support banner for %s", async (l, orgId, re) => {
    lang.current = l;
    mockData.getCustomerContext.mockResolvedValue(context({ support: supportOf(orgId) }));
    const h = html(await CustomerLayout({ children: null }));
    expect(h).toMatch(re);
    expect(h).toContain('role="status"');
    expect(visible(h)).not.toMatch(SITE_WORD);
  });

  it("a site named by the customer is shown as given, the kind next to it says «WordPress»", async () => {
    mockData.getSites.mockResolvedValue([site("s9", "Sito di Anna")]);
    lang.current = "it";
    answer({ [STACKS]: ok([]) });
    const shell = html(await CustomerLayout({ children: null }));
    const list = html(await AppsPage());
    for (const h of [shell, list]) {
      expect(h).toContain("Sito di Anna");
      expect(h).toContain("WordPress");
    }
  });
});

// ---- 5. no jargon in the new and rewritten files ------------------------------------------------------------------
describe("no jargon in the source of the new files", () => {
  const src = path.resolve(__dirname, "../src");
  const FILES = [
    "app/sites/customer-layout.tsx",
    "app/sites/layout.tsx",
    "app/apps/layout.tsx",
    "app/apps/page.tsx",
    "app/apps/new/page.tsx",
    "app/sites/new/page.tsx",
    "app/sites/page.tsx",
    "components/customer/site-type-cards.tsx",
    "components/customer/top-bar.tsx",
    "components/app-stacks/app-stack-list.tsx",
    "components/app-stacks/app-stack-view.ts",
    "components/app-stacks/app-catalog.tsx",
    "lib/customer-reads.ts",
  ];
  // Comments and imports are code, not copy (same cleaning as test/ui-copy.test.ts).
  const strip = (t: string) =>
    t
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
      .replace(/^\s*import[^;]*;?$/gm, "");

  it.each(FILES)("%s exists and says none of the banned words in its code", (f) => {
    const file = path.join(src, f);
    expect(fs.existsSync(file), `${f} must exist`).toBe(true);
    expect(strip(fs.readFileSync(file, "utf-8")), f).not.toMatch(jargon);
  });

  it("the cleaning keeps the check able to fail: a planted word is found, a comment is not", () => {
    expect(strip("const x = 'a template';")).toMatch(jargon);
    expect(strip("// template\nconst x = 1;")).not.toMatch(jargon);
  });

  it("the removed files are gone", () => {
    for (const f of ["app/sites/landing.ts", "components/customer/empty-sites.tsx"]) {
      expect(fs.existsSync(path.join(src, f)), f).toBe(false);
    }
  });
});
