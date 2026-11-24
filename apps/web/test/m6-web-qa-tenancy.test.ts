import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MeDto } from "@hosting-panel/contracts";

// QA-W2: tenancy and gating of the application pages. The real customer context (`getCustomerContext`) and the
// real server reads run; only the session, the upstream HTTP call and next/navigation are replaced, so what is
// asserted is the path every page really asks the API for.

const session = vi.hoisted(() => ({ current: null as unknown }));
const fetchUpstream = vi.hoisted(() => vi.fn());

vi.mock("@/lib/server-session", () => ({
  getServerSession: async () => session.current,
  getSessionFromRequest: async () => session.current,
}));
vi.mock("@/lib/upstream", async () => ({
  ...(await vi.importActual<object>("@/lib/upstream")),
  fetchUpstream: (...a: unknown[]) => fetchUpstream(...a),
}));
vi.mock("@/i18n/server", () => ({ getRequestLocale: async () => "en" }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useParams: () => ({}),
  usePathname: () => "/apps",
}));

import { en } from "@/i18n/en";
import { I18nProvider } from "@/i18n/provider";
import AdminLayout from "@/app/admin/layout";
import AdminAppTemplatesPage from "@/app/admin/templates/apps/page";
import AdminAppTemplatePage from "@/app/admin/templates/apps/[templateId]/page";
import EditAppTemplatePage from "@/app/admin/templates/apps/[templateId]/edit/page";
import NewAppTemplatePage from "@/app/admin/templates/apps/new/page";
import AdminTemplatesPage from "@/app/admin/templates/page";
import AppsNotFound from "@/app/apps/not-found";
import AppsPage from "@/app/apps/page";
import NewAppPage from "@/app/apps/new/page";
import AppWizardPage from "@/app/apps/new/[templateId]/page";
import AppStackPage from "@/app/apps/[stackId]/page";
import * as stacksRoute from "@/app/api/bff/orgs/[orgId]/app-stacks/route";
import * as stackRoute from "@/app/api/bff/orgs/[orgId]/app-stacks/[stackId]/route";
import * as actionRoute from "@/app/api/bff/orgs/[orgId]/app-stacks/[stackId]/[action]/route";
import * as planRoute from "@/app/api/bff/orgs/[orgId]/app-stacks/[stackId]/plan/route";
import * as secretsRoute from "@/app/api/bff/orgs/[orgId]/app-stacks/[stackId]/secrets/route";
import * as domainsRoute from "@/app/api/bff/orgs/[orgId]/app-stacks/[stackId]/domains/route";
import * as domainRoute from "@/app/api/bff/orgs/[orgId]/app-stacks/[stackId]/domains/[domainId]/route";
import * as logsRoute from "@/app/api/bff/orgs/[orgId]/app-stacks/[stackId]/components/[componentKey]/logs/route";
import * as backupsRoute from "@/app/api/bff/orgs/[orgId]/app-stacks/[stackId]/backups/route";
import * as restoreRoute from "@/app/api/bff/orgs/[orgId]/app-stacks/[stackId]/backups/[backupId]/restore/route";
import * as adminTemplatesRoute from "@/app/api/admin/app-templates/route";
import * as adminValidateRoute from "@/app/api/admin/app-templates/validate/route";
import * as adminImportRoute from "@/app/api/admin/app-templates/import-compose/route";
import * as adminTemplateRoute from "@/app/api/admin/app-templates/[templateId]/route";
import * as adminVersionsRoute from "@/app/api/admin/app-templates/[templateId]/versions/route";
import * as adminArchiveRoute from "@/app/api/admin/app-templates/[templateId]/archive/route";

const NOW = "2026-11-22T10:00:00.000Z";
const ORG_A = "org_a1";
const ORG_B = "org_b2";
const STACK = "stk_a1";

type Console = "customer" | "admin";
const sessionOf = (over: { isServerAdmin?: boolean; activeConsole?: Console; mustChangePassword?: boolean } = {}) => ({
  accessToken: "tok",
  csrfToken: "csrf",
  activeConsole: over.activeConsole ?? "customer",
  user: {
    id: "u1",
    name: "Someone",
    email: "someone@example.test",
    mustChangePassword: over.mustChangePassword ?? false,
    isServerAdmin: over.isServerAdmin ?? false,
  },
});
const visit = { organizationId: ORG_A, organizationName: "Customer A", expiresAt: NOW };
const meOf = (over: Record<string, unknown> = {}) =>
  ({
    user: { id: "u1", email: "someone@example.test", name: "Someone", locale: "en", totpEnabled: false, mustChangePassword: false, isServerAdmin: false },
    globalRoles: [],
    hostingAdminOrgIds: [],
    memberships: [{ organizationId: ORG_A }, { organizationId: ORG_B }],
    platformCapabilities: { applicationStacksAvailable: true, applicationTemplatesAvailable: true },
    ...over,
  }) as unknown as MeDto;

const ok = (data: unknown) => ({ ok: true, status: 200, data: { data } });
const fail = (status: number, code: string) => ({ ok: false, status, error: { error: { code } } });
/** `v1/me` answers with `me`; every other path answers from `byPath` or 404s like a foreign resource does. */
const upstream = (me: MeDto, byPath: Record<string, unknown> = {}) =>
  fetchUpstream.mockImplementation(async (path: string) => {
    if (path === "v1/me") return ok(me);
    return byPath[path] ?? fail(404, "NOT_FOUND");
  });
const paths = () => fetchUpstream.mock.calls.map(([p]) => String(p));
const nonMe = () => paths().filter((p) => p !== "v1/me");
const appReads = () => paths().filter((p) => p.includes("app-"));

const html = (node: ReactNode) =>
  renderToStaticMarkup(createElement(I18nProvider, { locale: "en", messages: en, children: node }))
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
const find = (node: unknown, pred: (e: ReactElement<Record<string, unknown>>) => boolean): ReactElement<Record<string, unknown>> | null => {
  if (Array.isArray(node)) {
    for (const c of node) {
      const hit = find(c, pred);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const el = node as ReactElement<Record<string, unknown>>;
  return pred(el) ? el : find(el.props.children, pred);
};

const ID = Promise.resolve({ stackId: STACK });
interface Page {
  name: string;
  run: () => Promise<ReactNode>;
  /** the one upstream path the page reads first when it is allowed to */
  first: string;
}
const customerPages: Page[] = [
  {
    name: "/apps/new/[templateId]",
    run: () => AppWizardPage({ params: Promise.resolve({ templateId: "atpl_notes" }) }),
    first: `v1/organizations/${ORG_A}/app-templates/atpl_notes`,
  },
  { name: "/apps/[stackId]", run: () => AppStackPage({ params: ID }), first: `v1/organizations/${ORG_A}/app-stacks/${STACK}` },
];

beforeEach(() => {
  vi.clearAllMocks();
  session.current = sessionOf();
  upstream(meOf());
});

describe("every application page × {flag off, support visit, flag on}", () => {
  describe.each(customerPages)("$name", ({ run, first }) => {
    it.each([
      ["flag absent", { applicationStacksAvailable: undefined }],
      ["flag false", { applicationStacksAvailable: false }],
      ["flag a truthy string", { applicationStacksAvailable: "true" }],
      ["flag 1", { applicationStacksAvailable: 1 }],
      ["no capabilities at all", {}],
    ])("customer, %s → the «off» notice and no application is read", async (_label, caps) => {
      upstream(meOf({ platformCapabilities: caps }));
      const h = html(await run());
      expect(h).toContain(en.apps.unavailable.title);
      expect(h).toContain(en.apps.unavailable.off);
      expect(h).not.toContain(en.apps.unavailable.support);
      expect(h).toContain('role="status"');
      expect(h).toContain('href="/apps"');
      expect(appReads()).toEqual([]);
      expect(nonMe()).toEqual([]);
    });

    it("customer, /v1/me fails → nothing is shown that could be an application, nothing but /v1/me is read", async () => {
      fetchUpstream.mockImplementation(async () => fail(500, "INTERNAL_ERROR"));
      const h = html(await run());
      // without capabilities the gate closes first: the page is a notice or a load error, never application data
      expect(h.includes(en.apps.unavailable.title) || h.includes(en.shell.loadErrorTitle)).toBe(true);
      expect(h).not.toContain(en.apps.unavailable.support);
      expect(nonMe()).toEqual([]);
    });

    it("a support visit (flag ON) → the «support» notice and no application is read", async () => {
      session.current = sessionOf({ isServerAdmin: true, activeConsole: "admin" });
      upstream(meOf({ memberships: [], supportAccess: visit }));
      const h = html(await run());
      expect(h).toContain(en.apps.unavailable.title);
      expect(h).toContain(en.apps.unavailable.support);
      expect(h).not.toContain(en.apps.unavailable.off);
      expect(appReads()).toEqual([]);
      expect(nonMe()).toEqual([]);
    });

    it("a server administrator whose cookie says «customer» is still gated by the visit", async () => {
      session.current = sessionOf({ isServerAdmin: true, activeConsole: "customer" });
      upstream(meOf({ memberships: [{ organizationId: ORG_B }], supportAccess: visit }));
      expect(html(await run())).toContain(en.apps.unavailable.support);
      expect(appReads()).toEqual([]);
    });

    it("an administrator outside a support visit is sent back to the admin sites before any read", async () => {
      session.current = sessionOf({ isServerAdmin: true, activeConsole: "admin" });
      upstream(meOf({ memberships: [{ organizationId: ORG_B }] }));
      await expect(run()).rejects.toThrow("REDIRECT /admin/sites?support=ended");
      expect(nonMe()).toEqual([]);
    });

    it("no session → login, nothing is read", async () => {
      session.current = null;
      await expect(run()).rejects.toThrow("REDIRECT /login");
      expect(fetchUpstream).not.toHaveBeenCalled();
    });

    it("flag on → reads only under the first membership's organisation, never the second", async () => {
      upstream(meOf(), { [first]: ok({ templates: [], categories: [] }) });
      await run().catch(() => undefined); // a 404 of a stub may end in notFound(); the paths are what is asserted
      const reads = nonMe();
      expect(reads.length).toBeGreaterThan(0);
      expect(reads[0]).toBe(first);
      for (const p of reads) expect(p.startsWith(`v1/organizations/${ORG_A}/`), p).toBe(true);
      expect(paths().join("\n")).not.toContain(ORG_B);
    });

    it("flag on but no membership → load error and no application read", async () => {
      upstream(meOf({ memberships: [] }));
      const h = html(await run());
      expect(h).toContain(en.shell.loadErrorTitle);
      expect(appReads()).toEqual([]);
      expect(nonMe()).toEqual([]);
    });
  });
});

const FLAG_OFF = [
  ["flag absent", { applicationStacksAvailable: undefined }],
  ["flag false", { applicationStacksAvailable: false }],
  ["flag a truthy string", { applicationStacksAvailable: "true" }],
  ["flag 1", { applicationStacksAvailable: 1 }],
  ["no capabilities at all", {}],
] as const;
const SITES = `v1/organizations/${ORG_A}/sites`;
const ADDRESSES = `v1/organizations/${ORG_A}/managed-sites`;
const underA = (p: string) => p === `v1/organizations/${ORG_A}` || p.startsWith(`v1/organizations/${ORG_A}/`);
const adminVisits = ["admin", "customer"] as const;

describe.each([
  { name: "/apps", run: () => AppsPage() },
  { name: "/apps/new", run: () => NewAppPage() },
])("$name: the guards run before any read", ({ run }) => {
  it("customer, /v1/me fails → the load error, nothing but /v1/me is read", async () => {
    fetchUpstream.mockImplementation(async () => fail(500, "INTERNAL_ERROR"));
    expect(html(await run())).toContain(en.shell.loadErrorTitle);
    expect(nonMe()).toEqual([]);
  });

  it("an administrator outside a support visit is sent back to the admin sites before any read", async () => {
    session.current = sessionOf({ isServerAdmin: true, activeConsole: "admin" });
    upstream(meOf({ memberships: [{ organizationId: ORG_B }] }));
    await expect(run()).rejects.toThrow("REDIRECT /admin/sites?support=ended");
    expect(nonMe()).toEqual([]);
  });

  it("no session → login, nothing is read", async () => {
    session.current = null;
    await expect(run()).rejects.toThrow("REDIRECT /login");
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("flag on but no membership → load error and nothing read", async () => {
    upstream(meOf({ memberships: [] }));
    expect(html(await run())).toContain(en.shell.loadErrorTitle);
    expect(nonMe()).toEqual([]);
  });
});

describe("/apps: the one list is never gated; stacks are read only with the flag on outside a visit", () => {
  it.each(FLAG_OFF)("customer, %s → the list without a notice, only the member's site reads", async (_label, caps) => {
    upstream(meOf({ platformCapabilities: caps }), { [SITES]: ok([]) });
    const h = html(await AppsPage());
    expect(h).not.toContain(en.apps.unavailable.title);
    expect(h).toContain(en.apps.list.title);
    expect(appReads()).toEqual([]);
    expect(nonMe().sort()).toEqual([ADDRESSES, SITES]);
  });

  it.each(adminVisits)("a support visit (flag ON, console cookie «%s») → the visited organisation's sites only", async (activeConsole) => {
    session.current = sessionOf({ isServerAdmin: true, activeConsole });
    upstream(meOf({ memberships: [{ organizationId: ORG_B }], supportAccess: visit }), { [SITES]: ok([]) });
    const h = html(await AppsPage());
    expect(h).not.toContain(en.apps.unavailable.title);
    expect(appReads()).toEqual([]);
    expect(nonMe().sort()).toEqual([ADDRESSES, SITES]);
  });

  it("flag on → reads only under the first membership's organisation, never the second", async () => {
    upstream(meOf(), { [SITES]: ok([]), [`v1/organizations/${ORG_A}/app-stacks`]: ok([]) });
    await AppsPage();
    expect(nonMe().sort()).toEqual([`v1/organizations/${ORG_A}/app-stacks`, ADDRESSES, SITES]);
    expect(paths().join("\n")).not.toContain(ORG_B);
  });
});

describe("/apps/new: one chooser, WordPress only with the flag off or in a visit", () => {
  it.each(FLAG_OFF)("customer, %s → the WordPress form, no application read, only the member's organisation", async (_label, caps) => {
    upstream(meOf({ platformCapabilities: caps }));
    await expect(NewAppPage()).rejects.toThrow("REDIRECT /sites/new");
    expect(appReads()).toEqual([]);
    for (const p of nonMe()) expect(underA(p), p).toBe(true);
  });

  it.each(adminVisits)("a support visit (flag ON, console cookie «%s») → the WordPress form before any read", async (activeConsole) => {
    session.current = sessionOf({ isServerAdmin: true, activeConsole });
    upstream(meOf({ memberships: [{ organizationId: ORG_B }], supportAccess: visit }));
    await expect(NewAppPage()).rejects.toThrow("REDIRECT /sites/new");
    expect(nonMe()).toEqual([]);
  });

  it("flag on → reads only under the first membership's organisation, never the second", async () => {
    upstream(meOf(), { [`v1/organizations/${ORG_A}/app-templates`]: ok({ templates: [], categories: [] }) });
    await NewAppPage().catch(() => undefined); // one choice ends in a redirect; the paths are what is asserted
    expect(appReads()).toEqual([`v1/organizations/${ORG_A}/app-templates`]);
    for (const p of nonMe()) expect(underA(p), p).toBe(true);
    expect(paths().join("\n")).not.toContain(ORG_B);
  });
});

describe("the organisation of a page never comes from the URL", () => {
  it("a hostile stack id that is not one path segment is notFound() with no application read", async () => {
    const evil = `${STACK}/../../${ORG_B}/app-stacks/stk_b1`;
    upstream(meOf());
    await expect(AppStackPage({ params: Promise.resolve({ stackId: evil }) })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(nonMe()).toEqual([]);
  });

  it("a hostile template id likewise", async () => {
    const evil = `../${ORG_B}/app-templates/atpl_x`;
    await expect(AppWizardPage({ params: Promise.resolve({ templateId: evil }) })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(nonMe()).toEqual([]);
  });

  it("the wizard element carries the member's organisation, not another membership", async () => {
    const entry = { id: "atpl_notes", name: "Notes" };
    upstream(meOf(), { [`v1/organizations/${ORG_A}/app-templates/atpl_notes`]: ok(entry) });
    const tree = await AppWizardPage({ params: Promise.resolve({ templateId: "atpl_notes" }) });
    expect(isValidElement(tree)).toBe(true);
    const props = (tree as ReactElement<Record<string, unknown>>).props;
    expect(props.orgId).toBe(ORG_A);
    expect(props.entry).toEqual(entry);
  });
});

describe("foreign or missing resources", () => {
  it("a stack of another organisation (404) is notFound(), and no further stack read is made", async () => {
    upstream(meOf()); // the API answers 404 for anything that is not the member's own
    await expect(AppStackPage({ params: Promise.resolve({ stackId: "stk_of_org_b" }) })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(nonMe()).toEqual([`v1/organizations/${ORG_A}/app-stacks/stk_of_org_b`]);
  });

  it.each([
    [403, "FORBIDDEN"],
    [500, "INTERNAL_ERROR"],
    [503, "UNAVAILABLE"],
  ])("a stack read answered %i is a load error, not «not found», and not the notice", async (status, code) => {
    upstream(meOf(), { [`v1/organizations/${ORG_A}/app-stacks/${STACK}`]: fail(status, code) });
    const h = html(await AppStackPage({ params: ID }));
    expect(h).toContain(en.shell.loadErrorTitle);
    expect(h).not.toContain(en.apps.unavailable.title);
  });

  it("422 NOT_SUPPORTED on a stack or wizard read turns into the «off» notice", async () => {
    upstream(meOf(), {
      [`v1/organizations/${ORG_A}/app-stacks/${STACK}`]: fail(422, "NOT_SUPPORTED"),
      [`v1/organizations/${ORG_A}/app-templates/atpl_notes`]: fail(422, "NOT_SUPPORTED"),
    });
    expect(html(await AppStackPage({ params: ID }))).toContain(en.apps.unavailable.off);
    const wizard = html(await AppWizardPage({ params: Promise.resolve({ templateId: "atpl_notes" }) }));
    expect(wizard).toContain(en.apps.unavailable.off);
  });

  it("a catalog entry that is not published (404) is notFound() on the wizard page", async () => {
    upstream(meOf());
    await expect(AppWizardPage({ params: Promise.resolve({ templateId: "atpl_hidden" }) })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(appReads()).toEqual([`v1/organizations/${ORG_A}/app-templates/atpl_hidden`]);
  });

  it("the apps not-found page offers the way back to /apps only", async () => {
    const h = html(await AppsNotFound());
    const links = [...h.matchAll(/<a[^>]*href="([^"]*)"/g)].map((m) => m[1]);
    expect(links).toEqual(["/apps"]);
    expect(h).not.toContain("/sites");
  });
});

describe("BFF routes pass the API's 403 and 404 through unchanged", () => {
  type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
  interface Route {
    name: string;
    handler: Handler;
    method: "GET" | "POST" | "DELETE" | "PATCH";
    params: Record<string, string>;
    body?: unknown;
    key: boolean;
    path: string;
  }
  const H = "a".repeat(64);
  const S = `v1/organizations/${ORG_B}/app-stacks`;
  const routes: Route[] = [
    { name: "create", handler: stacksRoute.POST as unknown as Handler, method: "POST", params: { orgId: ORG_B }, body: { templateVersionId: "atv_notes_2", name: "Notes", deploy: false }, key: true, path: S },
    { name: "delete", handler: stackRoute.DELETE as unknown as Handler, method: "DELETE", params: { orgId: ORG_B, stackId: STACK }, body: { confirmName: "Notes", destroyData: false }, key: true, path: `${S}/${STACK}` },
    { name: "deploy", handler: actionRoute.POST as unknown as Handler, method: "POST", params: { orgId: ORG_B, stackId: STACK, action: "deploy" }, body: {}, key: true, path: `${S}/${STACK}/deploy` },
    { name: "stop", handler: actionRoute.POST as unknown as Handler, method: "POST", params: { orgId: ORG_B, stackId: STACK, action: "stop" }, body: {}, key: true, path: `${S}/${STACK}/stop` },
    { name: "upgrade", handler: actionRoute.POST as unknown as Handler, method: "POST", params: { orgId: ORG_B, stackId: STACK, action: "upgrade" }, body: { templateVersionId: "atv_notes_3", planHash: H }, key: true, path: `${S}/${STACK}/upgrade` },
    { name: "rollback", handler: actionRoute.POST as unknown as Handler, method: "POST", params: { orgId: ORG_B, stackId: STACK, action: "rollback" }, body: { revisionId: "srev_a1", planHash: H }, key: true, path: `${S}/${STACK}/rollback` },
    { name: "plan", handler: planRoute.POST as unknown as Handler, method: "POST", params: { orgId: ORG_B, stackId: STACK }, body: { templateVersionId: "atv_notes_3" }, key: false, path: `${S}/${STACK}/plan` },
    { name: "secret", handler: secretsRoute.POST as unknown as Handler, method: "POST", params: { orgId: ORG_B, stackId: STACK }, body: { parameterKey: "admin_password", value: "S3cr3t-planted" }, key: false, path: `${S}/${STACK}/secrets` },
    { name: "domain add", handler: domainsRoute.POST as unknown as Handler, method: "POST", params: { orgId: ORG_B, stackId: STACK }, body: { hostname: "notes.example.com", componentKey: "web", port: 8080 }, key: false, path: `${S}/${STACK}/domains` },
    { name: "domain remove", handler: domainRoute.DELETE as unknown as Handler, method: "DELETE", params: { orgId: ORG_B, stackId: STACK, domainId: "sdom_1" }, key: false, path: `${S}/${STACK}/domains/sdom_1` },
    { name: "domain options", handler: domainRoute.PATCH as unknown as Handler, method: "PATCH", params: { orgId: ORG_B, stackId: STACK, domainId: "sdom_1" }, body: { redirectToDomainId: null, compression: true, protection: null, pathRoutes: [] }, key: false, path: `${S}/${STACK}/domains/sdom_1` },
    { name: "logs", handler: logsRoute.GET as unknown as Handler, method: "GET", params: { orgId: ORG_B, stackId: STACK, componentKey: "web" }, key: false, path: `${S}/${STACK}/components/web/logs?tail=200` },
    { name: "backup create", handler: backupsRoute.POST as unknown as Handler, method: "POST", params: { orgId: ORG_B, stackId: STACK }, body: {}, key: true, path: `${S}/${STACK}/backups` },
    { name: "backup restore", handler: restoreRoute.POST as unknown as Handler, method: "POST", params: { orgId: ORG_B, stackId: STACK, backupId: "sbak_1" }, body: { confirmName: "Notes" }, key: true, path: `${S}/${STACK}/backups/sbak_1/restore` },
    // admin routes: the browser of a customer reaching them is refused by the API, and the BFF says so unchanged
    { name: "admin create", handler: adminTemplatesRoute.POST as unknown as Handler, method: "POST", params: {}, body: { slug: "notes", source: "x" }, key: true, path: "v1/admin/app-templates" },
    { name: "admin validate", handler: adminValidateRoute.POST as unknown as Handler, method: "POST", params: {}, body: { source: "x" }, key: false, path: "v1/admin/app-templates/validate" },
    { name: "admin import", handler: adminImportRoute.POST as unknown as Handler, method: "POST", params: {}, body: { compose: "services: {}" }, key: false, path: "v1/admin/app-templates/import-compose" },
    { name: "admin update", handler: adminTemplateRoute.PATCH as unknown as Handler, method: "PATCH", params: { templateId: "atpl_x" }, body: { enabled: true }, key: false, path: "v1/admin/app-templates/atpl_x" },
    { name: "admin version", handler: adminVersionsRoute.POST as unknown as Handler, method: "POST", params: { templateId: "atpl_x" }, body: { source: "x", makeDefault: false }, key: true, path: "v1/admin/app-templates/atpl_x/versions" },
    { name: "admin archive", handler: adminArchiveRoute.POST as unknown as Handler, method: "POST", params: { templateId: "atpl_x" }, body: {}, key: false, path: "v1/admin/app-templates/atpl_x/archive" },
  ];
  const req = (r: Route) =>
    new Request("http://localhost:3000/x", {
      method: r.method,
      headers: {
        Host: "localhost:3000",
        Origin: "http://localhost:3000",
        "X-CSRF-Token": "csrf",
        "Content-Type": "application/json",
        ...(r.key ? { "Idempotency-Key": "k-1" } : {}),
      },
      body: r.body === undefined ? undefined : JSON.stringify(r.body),
    });
  const envelope = (code: string, message: string) => ({ error: { code, message, details: [], requestId: "req_1", retryable: false } });

  it.each(routes)("$name: 403 and 404 envelopes come back with their status, code and message", async (r) => {
    for (const [status, code, message] of [
      [403, "FORBIDDEN", "You cannot do this."],
      [404, "NOT_FOUND", "Not found."],
    ] as const) {
      fetchUpstream.mockReset();
      const body = envelope(code, message);
      fetchUpstream.mockResolvedValue({ ok: false, status, error: body });
      const res = await r.handler(req(r), { params: Promise.resolve(r.params) });
      expect(res.status, `${r.name} ${status}`).toBe(status);
      expect(await res.json(), `${r.name} ${status}`).toEqual(body);
      expect(res.headers.get("cache-control")).toContain("no-store");
      expect(fetchUpstream).toHaveBeenCalledTimes(1);
      expect(fetchUpstream.mock.calls[0]![0]).toBe(r.path);
    }
  });

  it("the organisation of a customer route is the URL's, forwarded verbatim: the API alone decides tenancy", async () => {
    fetchUpstream.mockResolvedValue({ ok: false, status: 404, error: envelope("NOT_FOUND", "Not found.") });
    const r = routes.find((x) => x.name === "plan")!;
    await r.handler(req(r), { params: Promise.resolve(r.params) });
    expect(fetchUpstream.mock.calls[0]![0]).toBe(`v1/organizations/${ORG_B}/app-stacks/${STACK}/plan`);
    expect(fetchUpstream.mock.calls[0]![1]).toMatchObject({ accessToken: "tok" });
  });

  it("a 4xx never turns into a 2xx or a 5xx on the way", async () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      fetchUpstream.mockReset();
      fetchUpstream.mockResolvedValue({ ok: false, status, error: envelope("X", "x") });
      const r = routes.find((x) => x.name === "logs")!;
      expect((await r.handler(req(r), { params: Promise.resolve(r.params) })).status).toBe(status);
    }
  });
});

describe("the admin layout keeps customers out before any application-template read", () => {
  const child = createElement("p", { id: "child" }, "secret");

  it("a customer session redirects to / and nothing is read", async () => {
    session.current = sessionOf({ isServerAdmin: false });
    await expect(AdminLayout({ children: child })).rejects.toThrow("REDIRECT /");
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("the console cookie «admin» does not make a customer an administrator", async () => {
    session.current = sessionOf({ isServerAdmin: false, activeConsole: "admin" });
    await expect(AdminLayout({ children: child })).rejects.toThrow("REDIRECT /");
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("no session → login; a temporary password → change it; neither reads anything", async () => {
    session.current = null;
    await expect(AdminLayout({ children: child })).rejects.toThrow("REDIRECT /login");
    session.current = sessionOf({ isServerAdmin: true, mustChangePassword: true });
    await expect(AdminLayout({ children: child })).rejects.toThrow("REDIRECT /account/change-password");
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("a server administrator gets the shell and the children", async () => {
    session.current = sessionOf({ isServerAdmin: true, activeConsole: "admin" });
    const tree = await AdminLayout({ children: child });
    expect(find(tree, (e) => e.props.id === "child")).not.toBeNull();
    expect(paths()).toEqual(["v1/me"]);
  });

  it("the layout's redirect happens before the children are produced: no application-template path is ever asked", async () => {
    session.current = sessionOf({ isServerAdmin: false });
    await AdminLayout({ children: child }).catch(() => undefined);
    expect(paths().filter((p) => p.includes("app-templates"))).toEqual([]);
  });
});

describe("admin application pages when the API answers 422 NOT_SUPPORTED", () => {
  const T = en.admin.appTemplates;
  const off = fail(422, "NOT_SUPPORTED");
  const SITE_TEMPLATES = ok({
    templates: [{ id: "stpl_wordpress", module: "wordpress", name: "WordPress", builtIn: true, enabled: true, archivedAt: null, defaultVersionNumber: 1, siteCount: 2 }],
  });
  const adminSession = () => {
    session.current = sessionOf({ isServerAdmin: true, activeConsole: "admin" });
  };
  const controls = (h: string) => ({
    create: h.includes('href="/admin/templates/apps/new"'),
    edit: /href="\/admin\/templates\/apps\/[^"]*\/edit/.test(h),
    switchRole: h.includes('role="switch"'),
    textarea: h.includes("<textarea"),
    form: h.includes("<form"),
  });

  beforeEach(() => {
    adminSession();
    upstream(meOf({ memberships: [] }), {
      "v1/admin/app-templates": off,
      "v1/admin/app-templates/atpl_x": off,
      "v1/admin/app-templates/atpl_x/usage": off,
    });
  });

  it("the one list shows the WordPress templates only, no notice, and a plain «new» link", async () => {
    upstream(meOf({ memberships: [] }), { "v1/admin/site-templates": SITE_TEMPLATES, "v1/admin/app-templates": off });
    const h = html(await AdminTemplatesPage());
    expect(h).toContain('href="/admin/templates/stpl_wordpress"');
    expect(h).toContain('href="/admin/templates/new"');
    expect(h).not.toContain(T.notAvailable);
    expect(h).not.toContain(T.loadError);
    expect(controls(h)).toEqual({ create: false, edit: false, switchRole: false, textarea: false, form: false });
  });

  it("the detail page shows the notice and no enable switch, archive or edit control", async () => {
    const h = html(await AdminAppTemplatePage({ params: Promise.resolve({ templateId: "atpl_x" }) }));
    expect(h).toContain(T.notAvailable);
    expect(h).toContain('role="status"');
    expect(controls(h)).toEqual({ create: false, edit: false, switchRole: false, textarea: false, form: false });
  });

  it("the edit page shows the notice and no editor", async () => {
    const h = html(await EditAppTemplatePage({ params: Promise.resolve({ templateId: "atpl_x" }) }));
    expect(h).toContain(T.notAvailable);
    expect(controls(h)).toEqual({ create: false, edit: false, switchRole: false, textarea: false, form: false });
    expect(paths().filter((p) => p.includes("/versions/"))).toEqual([]);
  });

  it("an unknown template is notFound() on the detail and edit pages", async () => {
    upstream(meOf({ memberships: [] }));
    await expect(AdminAppTemplatePage({ params: Promise.resolve({ templateId: "atpl_zz" }) })).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(EditAppTemplatePage({ params: Promise.resolve({ templateId: "atpl_zz" }) })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("an API failure other than 422 is the load error, not the notice, and the WordPress templates stay", async () => {
    upstream(meOf({ memberships: [] }), { "v1/admin/site-templates": SITE_TEMPLATES, "v1/admin/app-templates": fail(500, "INTERNAL_ERROR") });
    const h = html(await AdminTemplatesPage());
    expect(h).toMatch(new RegExp(`role="alert"[^]*${T.loadError}`));
    expect(h).not.toContain(T.notAvailable);
    expect(h).toContain('href="/admin/templates/stpl_wordpress"');
  });

  it("without a session every admin application page goes to login before any read", async () => {
    session.current = null;
    for (const run of [
      () => AdminTemplatesPage(),
      () => AdminAppTemplatePage({ params: Promise.resolve({ templateId: "atpl_x" }) }),
      () => EditAppTemplatePage({ params: Promise.resolve({ templateId: "atpl_x" }) }),
      () => NewAppTemplatePage(),
    ]) {
      await expect(run()).rejects.toThrow("REDIRECT /login");
    }
    expect(() => AdminAppTemplatesPage()).toThrow("REDIRECT /admin/templates");
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("the «new template» page reads only the capability from the API", async () => {
    await NewAppTemplatePage();
    expect(paths()).toEqual(["v1/me"]);
  });

  it("the one list reads the multi-service templates only while the capability is strictly true", async () => {
    for (const [value, read] of [
      [true, true],
      [false, false],
      [undefined, false],
      ["true", false],
      [1, false],
    ] as const) {
      fetchUpstream.mockClear();
      upstream(meOf({ memberships: [], platformCapabilities: { applicationTemplatesAvailable: value } }));
      await AdminTemplatesPage();
      expect(paths().includes("v1/admin/app-templates"), String(value)).toBe(read);
    }
    fetchUpstream.mockClear();
    fetchUpstream.mockImplementation(async () => fail(500, "INTERNAL_ERROR"));
    await AdminTemplatesPage();
    expect(paths()).not.toContain("v1/admin/app-templates");
  });
});
