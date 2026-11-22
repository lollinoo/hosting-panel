import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AdminAppStacksDto, AdminSiteDto } from "@hosting-panel/contracts";
import { format, type Messages } from "@/i18n";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { I18nProvider } from "@/i18n/provider";

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

const heads = (out: string) => [...out.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((x) => x[1]);
const rows = (out: string) => out.split("<tr").slice(1);
const rowOf = (out: string, name: string) => rows(out).find((r) => r.includes(`>${name}<`)) ?? "";
const cells = (row: string) => [...row.matchAll(/<td[^>]*>([^]*?)<\/td>/g)].map((x) => (x[1] ?? "").replace(/<[^>]+>/g, ""));
const count = (s: string, needle: string) => s.split(needle).length - 1;

const table = (m: Messages, sites: AdminSiteDto[], stacks?: Stack[]) =>
  html(m, createElement(SitesTable, { sites, ...(stacks ? { stacks } : {}), customers: [], csrfToken: "csrf" }));

describe("SitesTable with application stacks", () => {
  it.each(locales)("puts the kind right after the name (%s)", (_l, m) => {
    const t = m.admin.sites;
    expect(heads(table(m, [site("a")]))).toEqual([t.colName, t.colKind, t.colDomain, t.colOwner, t.colPhp, t.colTemplate, t.colStatus, t.colActions]);
  });

  it("shows the site type's name as the kind of a WordPress row, a dash for a site without one", () => {
    const out = table(en, [site("a"), site("b", { siteType: null })]);
    expect(cells(rowOf(out, "wp-a"))[1]).toBe("WordPress");
    expect(cells(rowOf(out, "wp-b"))[1]).toBe("-");
  });

  it.each(locales)("appends read-only stack rows after the WordPress rows (%s)", (_l, m) => {
    const out = table(m, [site("a")], [stack("s1"), stack("s2", { primaryHostname: null, status: "degraded", templateName: "Board", versionNumber: 1 })]);
    expect(out.indexOf(">wp-a<")).toBeLessThan(out.indexOf(">notes-s1<"));
    expect(out.indexOf(">notes-s1<")).toBeLessThan(out.indexOf(">notes-s2<"));
    expect(cells(rowOf(out, "notes-s1"))).toEqual([
      "notes-s1",
      "Notes",
      "s1.apps.example.test",
      "Beta",
      "-",
      format(m.admin.sites.templateVersion, { name: "Notes", version: 3 }),
      m.admin.appTemplates.stackStatus.running,
      "",
    ]);
    expect(cells(rowOf(out, "notes-s2"))).toEqual([
      "notes-s2",
      "Board",
      "-",
      "Beta",
      "-",
      format(m.admin.sites.templateVersion, { name: "Board", version: 1 }),
      m.admin.appTemplates.stackStatus.degraded,
      "",
    ]);
  });

  it("a stack row has no button and no link, and adds no support action", () => {
    const out = table(en, [site("a"), site("b", { owner: null })], [stack("s1"), stack("s2")]);
    for (const name of ["notes-s1", "notes-s2"]) {
      const row = rowOf(out, name);
      expect(row).not.toBe("");
      expect(row).not.toContain("<button");
      expect(row).not.toContain("<a");
    }
    expect(count(out, en.admin.sites.support.open)).toBe(2);
  });

  it.each(locales)("is empty only when both lists are (%s)", (_l, m) => {
    const t = m.admin.sites;
    const empty = table(m, [], []);
    expect(empty).toContain(t.empty);
    expect(empty).not.toContain("<table");
    expect(table(m, [])).toContain(t.empty);
    const onlyStacks = table(m, [], [stack("s1")]);
    expect(onlyStacks).toContain("<table");
    expect(onlyStacks).toContain(">notes-s1<");
    expect(onlyStacks).not.toContain(t.empty);
  });
});

describe("/admin/sites page", () => {
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
    answers = { "v1/admin/sites": ok(SITES), "v1/me": me(true), "v1/admin/app-stacks": ok({ stacks: [stack("s1")], truncated: false }) };
    fetchUpstream.mockImplementation(async (path: string) => answers[path] ?? fail(404));
  });

  it.each([false, undefined, "true", 1])("with the flag %s reads only the sites and the capability, and shows no stack", async (flag) => {
    answers["v1/me"] = me(flag);
    const out = await render();
    expect(paths()).toEqual(["v1/admin/sites", "v1/me"]);
    expect(out).toContain(">wp-a<");
    expect(out).not.toContain("notes-s1");
    expect(out).not.toContain('role="alert"');
  });

  it("without the capability (a failed /v1/me) reads no stack", async () => {
    answers["v1/me"] = fail(500);
    const out = await render();
    expect(paths()).toEqual(["v1/admin/sites", "v1/me"]);
    expect(out).not.toContain(en.admin.sites.stacksLoadError);
  });

  it("with the flag on also lists the stacks after the WordPress rows", async () => {
    const out = await render();
    expect(paths()).toEqual(["v1/admin/app-stacks", "v1/admin/sites", "v1/me"]);
    expect(out.indexOf(">wp-a<")).toBeLessThan(out.indexOf(">notes-s1<"));
    expect(out).not.toContain(en.admin.sites.stacksTruncated);
    expect(out).not.toContain('role="alert"');
  });

  it("treats a 422 from the stacks read as the flag off", async () => {
    answers["v1/admin/app-stacks"] = fail(422, "NOT_SUPPORTED");
    const out = await render();
    expect(out).toContain(">wp-a<");
    expect(out).not.toContain("notes-s1");
    expect(out).not.toContain(en.admin.sites.stacksLoadError);
  });

  it("a failed stacks read keeps the WordPress rows and says so", async () => {
    answers["v1/admin/app-stacks"] = fail(500);
    const out = await render();
    expect(out).toContain(en.admin.sites.stacksLoadError);
    expect(out).toContain(">wp-a<");
    expect(out).not.toContain("notes-s1");
  });

  it("says when only the first stacks are shown", async () => {
    answers["v1/admin/app-stacks"] = ok({ stacks: [stack("s1")], truncated: true });
    const out = await render();
    expect(out).toContain(">notes-s1<");
    expect(out).toContain(en.admin.sites.stacksTruncated);
  });

  it("a failed sites read shows the load error and no table, even with stacks", async () => {
    answers["v1/admin/sites"] = fail(500);
    const out = await render();
    expect(out).toContain(en.admin.sites.loadError);
    expect(out).not.toContain("<table");
  });

  it.each(locales)("titles the page with the section's name (%s)", async (locale, m) => {
    const out = await render(locale);
    expect(out).toContain(`<h1 class="text-2xl font-bold tracking-tight">${m.admin.sites.title}</h1>`);
    expect(out).toContain(m.admin.sites.colKind);
  });
});
