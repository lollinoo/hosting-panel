import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { APP_STACK_STATUSES, type AdminAppStacksDto, type AdminSiteDto } from "@hosting-panel/contracts";
import { format, type Messages } from "@/i18n";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { I18nProvider } from "@/i18n/provider";

// QA-A2 (ux-admin §10): edge cases of the administrator's «Applicazioni» page that
// test/admin-applications.test.ts does not cover.

const fetchUpstream = vi.fn();
const getServerSession = vi.fn();
const getRequestLocale = vi.fn();

vi.mock("@/lib/upstream", async () => ({
  ...(await vi.importActual<object>("@/lib/upstream")),
  fetchUpstream: (...args: unknown[]) => fetchUpstream(...args),
}));
vi.mock("@/lib/server-session", () => ({ getServerSession: (...args: unknown[]) => getServerSession(...args) }));
vi.mock("@/i18n/server", () => ({ getRequestLocale: (...args: unknown[]) => getRequestLocale(...args) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/admin/sites",
}));

import AdminSitesPage from "@/app/admin/sites/page";
import { SitesTable } from "@/components/admin/sites-table";

type Stack = AdminAppStacksDto["stacks"][number];

const locales = [
  ["en", en],
  ["it", itMsgs],
] as const;

const html = (m: Messages, node: ReactElement) =>
  renderToStaticMarkup(createElement(I18nProvider, { locale: m === en ? "en" : "it", messages: m, children: node }));

const site = (id: string, over: Partial<AdminSiteDto> = {}) =>
  ({
    id,
    name: `wp-${id}`,
    status: "ready",
    siteType: "wordpress",
    primaryDomain: `${id}.example.test`,
    owner: { organizationId: "org_acme", name: "Acme" },
    phpVersion: "8.4",
    template: null,
    ...over,
  }) as unknown as AdminSiteDto;

const stack = (id: string, over: Partial<Stack> = {}): Stack => ({
  id,
  name: `notes-${id}`,
  organizationName: "Beta",
  templateId: "atpl_notes",
  templateName: "Notes",
  versionNumber: 3,
  status: "running",
  primaryHostname: `${id}.apps.example.test`,
  ...over,
});

const rows = (out: string) => out.split("<tr").slice(1);
const rowOf = (out: string, name: string) => rows(out).find((r) => r.includes(`>${name}<`)) ?? "";
const cells = (row: string) => [...row.matchAll(/<td[^>]*>([^]*?)<\/td>/g)].map((x) => (x[1] ?? "").replace(/<[^>]+>/g, ""));
const count = (s: string, needle: string) => s.split(needle).length - 1;

const table = (m: Messages, sites: AdminSiteDto[], stacks?: Stack[]) =>
  html(m, createElement(SitesTable, { sites, ...(stacks ? { stacks } : {}), customers: [], csrfToken: "csrf" }));

describe("every stack status has a label", () => {
  const labelsOf = (m: Messages) => m.admin.appTemplates.stackStatus as Record<string, string>;

  it("the contract lists 14 statuses", () => {
    expect(APP_STACK_STATUSES).toHaveLength(14);
  });

  it.each(APP_STACK_STATUSES.flatMap((s) => locales.map(([l, m]) => [s, l, m] as const)))("%s has a non-blank %s label that is shown in its row", (status, _l, m) => {
    const label = labelsOf(m)[status];
    expect(typeof label).toBe("string");
    expect((label ?? "").trim()).not.toBe("");
    const out = table(m, [], [stack("s1", { status })]);
    expect(cells(rowOf(out, "notes-s1"))[6]).toBe(label);
  });

  it.each(locales)("no label of the table is a raw status key (%s)", (_l, m) => {
    for (const status of APP_STACK_STATUSES) expect(labelsOf(m)[status]).not.toBe(status);
  });

  it.each(locales)("the labels of two statuses never collide (%s)", (_l, m) => {
    const all = APP_STACK_STATUSES.map((s) => labelsOf(m)[s]);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("hostile and odd values render as text", () => {
  const evil = `<script>alert("x")</script>`;
  const escaped = "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;";

  it.each([
    ["name", { name: evil }],
    ["organizationName", { organizationName: evil }],
    ["templateName", { templateName: evil }],
    ["primaryHostname", { primaryHostname: evil }],
  ] as const)("a script-like stack %s is escaped", (_field, over) => {
    const out = table(en, [site("a")], [stack("s1", over)]);
    expect(out).not.toContain("<script");
    expect(out).toContain(escaped);
  });

  it("a script-like WordPress name and customer name are escaped too", () => {
    const out = table(en, [site("a", { name: evil, owner: { organizationId: "o", name: evil } })], [stack("s1")]);
    expect(out).not.toContain("<script");
    expect(count(out, escaped)).toBeGreaterThanOrEqual(2);
  });

  it("a stack name holding markup characters or a quote does not break the row", () => {
    const out = table(en, [], [stack("s1", { name: `a"b'c&d`, organizationName: "R&D <Lab>" })]);
    expect(out).not.toContain("<Lab>");
    expect(out).toContain("R&amp;D &lt;Lab&gt;");
    expect(rows(out)).toHaveLength(2); // header + one row
  });

  it.each(locales)("a null primaryHostname shows a dash and never the word null (%s)", (_l, m) => {
    const out = table(m, [], [stack("s1", { primaryHostname: null })]);
    const row = cells(rowOf(out, "notes-s1"));
    expect(row[2]).toBe("-");
    expect(row.join("|")).not.toMatch(/null|undefined/);
  });

  it("every stack row has as many cells as the header has columns", () => {
    const out = table(en, [site("a")], [stack("s1"), stack("s2", { primaryHostname: null })]);
    const head = [...out.matchAll(/<th[ >]/g)].length;
    expect(head).toBe(8);
    expect(cells(rowOf(out, "notes-s1"))).toHaveLength(head);
    expect(cells(rowOf(out, "notes-s2"))).toHaveLength(head);
    expect(cells(rowOf(out, "wp-a"))).toHaveLength(head);
  });
});

describe("a WordPress row keeps every action", () => {
  const t = en.admin.sites;

  it.each([
    ["owner: null", { owner: null }],
    ["an owner", {}],
  ] as const)("a ready site with %s shows every action", (_label, over) => {
    const out = table(en, [site("a", over)], [stack("s1"), stack("s2")]);
    const row = rowOf(out, "wp-a");
    expect(row).toContain(t.changeOwner);
    expect(row).toContain(t.support.open);
    expect(row).toContain(t.domains);
    expect(row).toContain(en.admin.terminal.linkLabel);
    expect(row).toContain(t.delete);
    expect(row).toContain('href="/admin/sites/a/domains"');
    expect(row).toContain('href="/admin/sites/a/terminal"');
    expect(row).not.toContain(t.retry);
  });

  it("an unassigned site says so and has the same actions as an owned one", () => {
    const unowned = rowOf(table(en, [site("a", { owner: null })]), "wp-a");
    const owned = rowOf(table(en, [site("a")]), "wp-a");
    expect(cells(unowned)[3]).toBe(t.unassigned);
    expect(cells(owned)[3]).toBe("Acme");
    expect(unowned.replace(t.unassigned, "Acme")).toBe(owned);
  });

  it("a degraded site with owner: null also shows Retry", () => {
    const row = rowOf(table(en, [site("a", { owner: null, status: "degraded" })], [stack("s1")]), "wp-a");
    expect(row).toContain(t.retry);
    expect(row).toContain(t.changeOwner);
  });

  it.each(["deploying", "stopped", "maintenance"] as const)("a %s site has no terminal link, with or without stacks", (status) => {
    for (const stacks of [undefined, [stack("s1")]]) {
      const row = rowOf(table(en, [site("a", { status })], stacks), "wp-a");
      expect(row).not.toContain("/terminal");
      expect(row).toContain(t.delete);
    }
  });
});

describe("stack rows never add a control", () => {
  const controls = (m: Messages) => [m.admin.sites.support.open, m.admin.sites.changeOwner, m.admin.sites.domains, m.admin.terminal.linkLabel, m.admin.sites.delete, m.admin.sites.retry, m.admin.sites.upgrade];
  const many = (n: number) => Array.from({ length: n }, (_, i) => stack(`s${i}`, { status: APP_STACK_STATUSES[i % APP_STACK_STATUSES.length]! }));

  it.each([0, 1, 5, 40])("%i stacks leave the number of controls of the WordPress rows unchanged", (n) => {
    const sites = [site("a"), site("b", { owner: null, status: "degraded" })];
    const base = table(en, sites);
    const out = table(en, sites, many(n));
    for (const label of controls(en)) expect(count(out, `>${label}<`)).toBe(count(base, `>${label}<`));
    expect(count(out, "<button")).toBe(count(base, "<button"));
    expect(count(out, "<a ")).toBe(count(base, "<a "));
  });

  it.each(APP_STACK_STATUSES.map((s) => [s] as const))("a stack in %s has neither button nor link", (status) => {
    const row = rowOf(table(en, [site("a")], [stack("s1", { status })]), "notes-s1");
    expect(row).not.toContain("<button");
    expect(row).not.toContain("<a ");
    expect(row).not.toContain("href=");
    expect(cells(row)[7]).toBe("");
  });

  it("no address of any stack leaks into a link or an action", () => {
    const out = table(en, [site("a")], many(3));
    for (const id of ["s0", "s1", "s2"]) {
      expect(out).not.toContain(`/admin/sites/${id}`);
      expect(out).not.toContain(`/sites/${id}`);
      expect(out).not.toContain(`/apps/${id}`);
    }
  });

  it("stacks alone (no WordPress site) show no action at all", () => {
    const out = table(en, [], many(3));
    expect(count(out, "<button")).toBe(0);
    expect(count(out, "<a ")).toBe(0);
    for (const label of controls(en)) expect(out).not.toContain(`>${label}<`);
  });

  it.each(locales)("shows the template's name and version in the template column, not the stack id (%s)", (_l, m) => {
    const row = cells(rowOf(table(m, [], [stack("s1", { templateName: "Board", versionNumber: 12 })]), "notes-s1"));
    expect(row[1]).toBe("Board");
    expect(row[5]).toBe(format(m.admin.sites.templateVersion, { name: "Board", version: 12 }));
    expect(row[4]).toBe("-");
  });
});

describe("/admin/sites: sites read × stacks read", () => {
  const SITES = { sites: [site("a")], customers: [], certificateAlerts: [] };
  const ok = (data: unknown) => ({ ok: true, status: 200, data: { data } });
  const fail = (status: number, code?: string) => ({ ok: false, status, error: code ? { error: { code } } : null });
  const me = (flag: unknown) => ok({ user: { id: "u1" }, platformCapabilities: { applicationStacksAvailable: flag } });

  let answers: Record<string, unknown>;
  const paths = () => fetchUpstream.mock.calls.map((c) => c[0] as string).sort();
  const render = async (locale: "en" | "it" = "en") => {
    getRequestLocale.mockResolvedValue(locale);
    return html(locale === "en" ? en : itMsgs, (await AdminSitesPage({ searchParams: Promise.resolve({}) })) as ReactElement);
  };

  beforeEach(() => {
    fetchUpstream.mockReset();
    getServerSession.mockReset();
    getRequestLocale.mockReset();
    getServerSession.mockResolvedValue({ accessToken: "tok", csrfToken: "csrf", user: { isServerAdmin: true } });
    answers = {};
    fetchUpstream.mockImplementation(async (path: string) => answers[path] ?? fail(404));
  });

  type StacksCase = {
    name: string;
    flag: boolean;
    answer: unknown;
    stackRow: boolean;
    stacksLoadError: boolean;
    truncated: boolean;
  };
  const STACKS: StacksCase[] = [
    { name: "ok", flag: true, answer: ok({ stacks: [stack("s1")], truncated: false }), stackRow: true, stacksLoadError: false, truncated: false },
    { name: "ok but empty", flag: true, answer: ok({ stacks: [], truncated: false }), stackRow: false, stacksLoadError: false, truncated: false },
    { name: "500", flag: true, answer: fail(500), stackRow: false, stacksLoadError: true, truncated: false },
    { name: "403 FORBIDDEN", flag: true, answer: fail(403, "FORBIDDEN"), stackRow: false, stacksLoadError: true, truncated: false },
    { name: "422 NOT_SUPPORTED", flag: true, answer: fail(422, "NOT_SUPPORTED"), stackRow: false, stacksLoadError: false, truncated: false },
    { name: "422 other code", flag: true, answer: fail(422, "VALIDATION_ERROR"), stackRow: false, stacksLoadError: true, truncated: false },
    { name: "not read (flag off)", flag: false, answer: ok({ stacks: [stack("s1")], truncated: false }), stackRow: false, stacksLoadError: false, truncated: false },
    { name: "truncated", flag: true, answer: ok({ stacks: [stack("s1")], truncated: true }), stackRow: true, stacksLoadError: false, truncated: true },
  ];

  const matrix = [true, false].flatMap((sitesOk) => STACKS.map((c) => [sitesOk, c] as const));

  it.each(matrix)("sites ok=%s × stacks %o", async (sitesOk, c) => {
    answers["v1/me"] = me(c.flag);
    answers["v1/admin/sites"] = sitesOk ? ok(SITES) : fail(500);
    answers["v1/admin/app-stacks"] = c.answer;
    const out = await render();
    const t = en.admin.sites;

    // The stack read is made exactly when the flag is on, whatever the sites read says.
    expect(paths().includes("v1/admin/app-stacks")).toBe(c.flag);

    expect(out).toContain(`<h1 class="text-2xl font-bold tracking-tight">${t.title}</h1>`);
    expect(out.includes("<table")).toBe(sitesOk);
    expect(out.includes(">wp-a<")).toBe(sitesOk);
    expect(out.includes(t.loadError)).toBe(!sitesOk);
    // With the sites read failed only the load error shows: no stack row, no stack notice.
    expect(out.includes(">notes-s1<")).toBe(sitesOk && c.stackRow);
    expect(out.includes(t.stacksLoadError)).toBe(sitesOk && c.stacksLoadError);
    expect(out.includes(t.stacksTruncated)).toBe(sitesOk && c.truncated);
    // Exactly one alert at most: the sites error or the stacks error, never both.
    expect(count(out, 'role="alert"')).toBe(!sitesOk || c.stacksLoadError ? 1 : 0);
  });

  it.each(locales)("the truncated note comes after the table and the stacks error before it (%s)", async (locale, m) => {
    answers["v1/me"] = me(true);
    answers["v1/admin/sites"] = ok(SITES);
    answers["v1/admin/app-stacks"] = ok({ stacks: [stack("s1")], truncated: true });
    const out = await render(locale);
    expect(out.indexOf(m.admin.sites.stacksTruncated)).toBeGreaterThan(out.indexOf("</table>"));

    answers["v1/admin/app-stacks"] = fail(500);
    const failed = await render(locale);
    expect(failed.indexOf(m.admin.sites.stacksLoadError)).toBeGreaterThan(-1);
    expect(failed.indexOf(m.admin.sites.stacksLoadError)).toBeLessThan(failed.indexOf("<table"));
  });

  it("a network failure of the stacks read (no status, no body) is an error, not 'off'", async () => {
    answers["v1/me"] = me(true);
    answers["v1/admin/sites"] = ok(SITES);
    answers["v1/admin/app-stacks"] = { ok: false, status: 0, error: null };
    const out = await render();
    expect(out).toContain(en.admin.sites.stacksLoadError);
    expect(out).toContain(">wp-a<");
  });

  it("a stack row and a WordPress row with the same display name both render", async () => {
    answers["v1/me"] = me(true);
    answers["v1/admin/sites"] = ok({ ...SITES, sites: [site("a", { name: "shop" })] });
    answers["v1/admin/app-stacks"] = ok({ stacks: [stack("s1", { name: "shop" })], truncated: false });
    const out = await render();
    expect(count(out, ">shop<")).toBe(2);
  });

  it.each(locales)("a flag-on page with a stack names the status in words (%s)", async (locale, m) => {
    answers["v1/me"] = me(true);
    answers["v1/admin/sites"] = ok(SITES);
    answers["v1/admin/app-stacks"] = ok({ stacks: [stack("s1", { status: "delete_failed" })], truncated: false });
    const out = await render(locale);
    expect(out).toContain(`>${m.admin.appTemplates.stackStatus.delete_failed}<`);
    expect(out).not.toContain(">delete_failed<");
  });
});
