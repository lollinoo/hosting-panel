import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AdminSiteDto, AdminSiteTemplateDetailDto, AdminSiteTemplateSummaryDto, CustomerSiteTypeDto } from "@hosting-panel/contracts";
import { errorMessage, type Messages } from "@/i18n";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { I18nProvider } from "@/i18n/provider";
import { encryptSession, SESSION_COOKIE_NAME } from "@/lib/session";
import { MAX_BFF_BODY_BYTES } from "@/lib/bff-proxy";

const keyedSend = vi.fn();
const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("@/lib/keyed-send", () => ({ keyedSend: (...a: unknown[]) => keyedSend(...a) }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/admin/sites" }));
// Radix renders its content through a portal, which static markup skips: a stand-in that honours `open`.
vi.mock("@/components/ui/dialog", async () => {
  const { createElement: h } = await import("react");
  const part = (tag: string) => ({ children }: { children?: React.ReactNode }) => h(tag, null, children);
  return {
    Dialog: ({ open, children }: { open?: boolean; children?: React.ReactNode }) => (open ? children : null),
    DialogContent: part("section"),
    DialogHeader: part("header"),
    DialogFooter: part("footer"),
    DialogTitle: part("h2"),
    DialogDescription: part("p"),
    DialogTrigger: part("span"),
  };
});

import * as templatesRoute from "@/app/api/admin/site-templates/route";
import * as validateRoute from "@/app/api/admin/site-templates/validate/route";
import * as templateRoute from "@/app/api/admin/site-templates/[templateId]/route";
import * as versionsRoute from "@/app/api/admin/site-templates/[templateId]/versions/route";
import * as upgradeRoute from "@/app/api/admin/sites/[siteId]/template-version/route";
import { SiteTemplateDetail } from "@/components/admin/site-template-detail";
import { SiteTemplateEditor, validationErrorText } from "@/components/admin/site-template-editor";
import { CodeEditor } from "@/components/admin/code-editor";
import { SitesTable } from "@/components/admin/sites-table";
import { UpgradeSiteTemplateDialog, upgradeTarget } from "@/components/admin/upgrade-site-template-dialog";
import { CreateSiteForCustomerDialog } from "@/components/admin/create-site-for-customer-dialog";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { NewSite } from "@/components/customer/new-site";
import { SiteForm, buildParameterValues, type SiteFormBody } from "@/components/customer/site-form";
import { SiteTypeChooser } from "@/components/customer/site-type-chooser";

const locales = [
  ["en", en],
  ["it", itMsgs],
] as const;
const XSS = "<script>alert(1)</script>";
const IMG = '"><img src=x onerror=alert(1)>';
const NOW = "2026-11-21T10:00:00.000Z";

// ---------------------------------------------------------------- BFF with the real session, guard and upstream client

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
const SOURCE = "services:\n  web:\n    image: ${HP_MODULE_IMAGE}\n";
const VERSION = "stv_aaaaaaaa";
const T = "stpl_custom1";
interface Route {
  name: string;
  handler: Handler;
  method: "POST" | "PATCH" | "DELETE";
  path: string;
  params: Record<string, string>;
  body?: unknown;
  idempotent: boolean;
}
const routes: Route[] = [
  { name: "template create", handler: templatesRoute.POST as unknown as Handler, method: "POST", path: "/api/admin/site-templates", params: {}, body: { module: "wordpress", name: "Shop", source: SOURCE }, idempotent: true },
  { name: "template validate", handler: validateRoute.POST as unknown as Handler, method: "POST", path: "/api/admin/site-templates/validate", params: {}, body: { module: "wordpress", source: SOURCE }, idempotent: false },
  { name: "template update", handler: templateRoute.PATCH as unknown as Handler, method: "PATCH", path: `/api/admin/site-templates/${T}`, params: { templateId: T }, body: { enabled: true }, idempotent: false },
  { name: "template archive", handler: templateRoute.DELETE as unknown as Handler, method: "DELETE", path: `/api/admin/site-templates/${T}`, params: { templateId: T }, idempotent: false },
  { name: "template version create", handler: versionsRoute.POST as unknown as Handler, method: "POST", path: `/api/admin/site-templates/${T}/versions`, params: { templateId: T }, body: { source: SOURCE }, idempotent: true },
  { name: "site template version change", handler: upgradeRoute.POST as unknown as Handler, method: "POST", path: "/api/admin/sites/site_1/template-version", params: { siteId: "site_1" }, body: { versionId: VERSION }, idempotent: true },
];
const bodyRoutes = routes.filter((r) => r.body !== undefined);
const paramRoutes = routes.filter((r) => Object.keys(r.params).length > 0);

const CHUNK = 64 * 1024;
function endlessBody() {
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (state.pulled >= 16 * MAX_BFF_BODY_BYTES) return controller.error(new Error("drained"));
        state.pulled += CHUNK;
        controller.enqueue(new Uint8Array(CHUNK).fill(0x20));
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, state };
}

describe("site template BFF routes against the real guard and upstream client", () => {
  const csrf = "csrf-sentinel-value";
  const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchSpy = vi.fn();
  const cookies: Record<string, string> = {};

  beforeAll(async () => {
    for (const isServerAdmin of [true, false]) {
      const token = await encryptSession({
        accessToken: "sentinel-access-token",
        csrfToken: csrf,
        activeConsole: isServerAdmin ? "admin" : "customer",
        activeOrgSlug: "org-a",
        user: { id: "user_1", email: "u@example.test", name: "U", globalRoles: [], hostingAdminOrgIds: [], locale: "en", isServerAdmin, mustChangePassword: false },
      });
      cookies[isServerAdmin ? "admin" : "customer"] = `${SESSION_COOKIE_NAME}=${token}`;
    }
  });
  beforeEach(() => {
    fetchSpy.mockReset();
    fetchSpy.mockImplementation(async () => jsonResponse(200, { data: {} }));
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  function request(r: Route, over: { who?: "admin" | "customer" | null; body?: BodyInit | ReadableStream<Uint8Array>; headers?: Record<string, string> } = {}) {
    const who = over.who === undefined ? "admin" : over.who;
    const body = over.body ?? (r.body === undefined ? undefined : JSON.stringify(r.body));
    return new Request(`http://localhost:3000${r.path}`, {
      method: r.method,
      headers: {
        Host: "localhost:3000",
        "Content-Type": "application/json",
        ...(who ? { Origin: "http://localhost:3000", Cookie: cookies[who]!, "X-CSRF-Token": csrf, "Idempotency-Key": "idem-1" } : {}),
        ...over.headers,
      },
      body,
      duplex: "half",
    } as RequestInit);
  }
  const call = (r: Route, req: Request, params = r.params) => r.handler(req, { params: Promise.resolve(params) });

  it.each(routes)("$name: without a session cookie it is a 401 and the API is not called", async (r) => {
    expect((await call(r, request(r, { who: null }))).status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(bodyRoutes)("$name: a body that never ends is a 413, the read stops near the limit and nothing reaches the API", async (r) => {
    const { stream, state } = endlessBody();
    const res = await call(r, request(r, { body: stream }));
    expect(res.status).toBe(413);
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThanOrEqual(MAX_BFF_BODY_BYTES + CHUNK);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(bodyRoutes)("$name: a declared Content-Length over the limit is a 413 before the body is read", async (r) => {
    const res = await call(r, request(r, { headers: { "Content-Length": String(MAX_BFF_BODY_BYTES + 1) } }));
    expect(res.status).toBe(413);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(bodyRoutes)("$name: a __proto__ key or a 100000-deep array is a 400, never a 500", async (r) => {
    const polluted = JSON.stringify(r.body).replace(/^\{/, '{"__proto__":{"admin":true},');
    expect((await call(r, request(r, { body: polluted }))).status).toBe(400);
    const deep = "[".repeat(100_000) + "]".repeat(100_000);
    expect((await call(r, request(r, { body: deep }))).status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(paramRoutes)("$name: a path segment that could redirect the API call is a 400 before the API", async (r) => {
    const key = Object.keys(r.params)[0]!;
    for (const bad of ["%2e%2e", "a/b", "a?x=1", "a#b", "..", ".", "stpl_é", "a\u0000b", "a\nb", " stpl_x", "a\\b"]) {
      const res = await call(r, request(r), { ...r.params, [key]: bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the 64 KiB source limit counts bytes: 32768 two-byte characters pass, 32769 are refused", async () => {
    const r = routes[1]!;
    const send = (n: number) => call(r, request(r, { body: JSON.stringify({ module: "wordpress", source: "é".repeat(n) }) }));
    expect((await send(32_768)).status).toBe(200);
    expect((await send(32_769)).status).toBe(400);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each(routes)("$name: only the bearer token goes to the API, never the cookie, CSRF token or Origin", async (r) => {
    expect((await call(r, request(r))).status).toBe(200);
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toContain(r.path.replace("/api/", "/v1/"));
    const sent = Object.fromEntries(Object.entries(init.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    expect(sent.authorization).toBe("Bearer sentinel-access-token");
    for (const leaked of ["cookie", "x-csrf-token", "origin", "host"]) expect(sent[leaked]).toBeUndefined();
  });

  it("a customer session is not filtered by the BFF: the API's 403 PERMISSION_DENIED reaches the browser as it is", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(403, { error: { code: "PERMISSION_DENIED", message: "no", details: [] } }));
    const r = routes[0]!;
    const res = await call(r, request(r, { who: "customer" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("PERMISSION_DENIED");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it.each(routes)("$name: an HTML error page from upstream is replaced by a fixed envelope that quotes nothing", async (r) => {
    fetchSpy.mockResolvedValue(new Response("<html>Error: connect ECONNREFUSED 10.9.9.9:5432 at Pool.query (/srv/api/dist/db.js:41)</html>", { status: 500, headers: { "content-type": "text/html" } }));
    const res = await call(r, request(r));
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(JSON.parse(text).error.code).toBe("INTERNAL_ERROR");
    for (const leaked of ["10.9.9.9", "ECONNREFUSED", "/srv/api", "Pool.query", "<html>"]) expect(text).not.toContain(leaked);
  });

  it.each(routes)("$name: an unreachable API is a 502 OPERATION_AMBIGUOUS without the socket error", async (r) => {
    fetchSpy.mockRejectedValue(new Error("connect ECONNREFUSED 10.1.2.3:4000"));
    const res = await call(r, request(r));
    const text = await res.text();
    expect(res.status).toBe(502);
    expect(JSON.parse(text).error.code).toBe("OPERATION_AMBIGUOUS");
    expect(text).not.toContain("10.1.2.3");
  });

  it("an upstream answer that carries a secret-named key is redacted on the way out", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { data: { valid: true, password: "hunter2", accessToken: "tok-x" } }));
    const r = routes[1]!;
    const text = await (await call(r, request(r))).text();
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("tok-x");
  });
});

// ---------------------------------------------------------------- rendering helpers

const wrap = (m: Messages, child: ReactElement) =>
  renderToStaticMarkup(createElement(I18nProvider, { locale: m === en ? "en" : "it", messages: m, children: child }));

// Calls a client component once with stand-in hooks; `over` forces the value of a state slot (by call order).
const internals = (React as unknown as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE!;
function callHooks<P>(C: (p: P) => ReactNode, props: P, m: Messages, over: Record<number, unknown> = {}) {
  let s = 0;
  const sets: Array<[number, unknown]> = [];
  const ctx = { locale: m === en ? "en" : "it", messages: m };
  const prev = internals.H;
  internals.H = {
    useState: (v: unknown) => {
      const k = s++;
      return [k in over ? over[k] : v, (x: unknown) => void sets.push([k, x])];
    },
    useRef: (v: unknown) => ({ current: v }),
    useEffect: () => {},
    useContext: () => ctx,
  };
  try {
    return { tree: C(props), sets };
  } finally {
    internals.H = prev;
  }
}
type El = ReactElement<Record<string, unknown>>;
const els = (node: unknown): El[] => {
  if (Array.isArray(node)) return node.flatMap(els);
  if (!isValidElement(node)) return [];
  return [node as El, ...els((node.props as Record<string, unknown>).children)];
};
const textOf = (node: unknown): string =>
  typeof node === "string" || typeof node === "number"
    ? String(node)
    : Array.isArray(node)
      ? node.map(textOf).join("")
      : isValidElement(node)
        ? textOf((node.props as Record<string, unknown>).children)
        : "";

const summary = (over: Partial<AdminSiteTemplateSummaryDto> & { id: string }) =>
  ({ module: "wordpress", name: "Custom", description: null, builtIn: false, enabled: true, archivedAt: null, defaultVersionId: "stv_c_2", defaultVersionNumber: 2, versionCount: 2, siteCount: 3, createdAt: NOW, updatedAt: NOW, ...over }) as AdminSiteTemplateSummaryDto;

const ref = (over: Record<string, unknown> = {}) => ({
  templateId: "stpl_wordpress",
  templateName: "WordPress",
  versionId: "stv_wordpress_1",
  versionNumber: 1,
  defaultVersionId: "stv_wordpress_2",
  defaultVersionNumber: 2,
  ...over,
});
const site = (id: string, status: AdminSiteDto["status"] = "ready", template: unknown = ref(), name = `wp-${id}.example.test`) =>
  ({ id, name, status, primaryDomain: null, owner: null, phpVersion: "8.4", template }) as unknown as AdminSiteDto;

// ---------------------------------------------------------------- escaping of administrator-written text

describe("administrator-written names and labels are escaped", () => {
  const expectEscaped = (out: string) => {
    expect(out).not.toContain("<script>");
    expect(out).not.toMatch(/<img[^>]*onerror/);
    expect(out).not.toContain('"><img');
  };

  it("the template detail escapes the name, the description and the version ids it links", () => {
    const detail = { ...summary({ id: "stpl_x", name: XSS, description: IMG }), versions: [{ id: "stv_a", versionNumber: 2, createdAt: NOW, siteCount: 1, isDefault: true }] } as AdminSiteTemplateDetailDto;
    expectEscaped(wrap(en, createElement(SiteTemplateDetail, { template: detail, csrfToken: "c" })));
  });

  it("the sites table escapes the site name and the template name", () => {
    const out = wrap(en, createElement(SitesTable, { sites: [site("a", "ready", ref({ templateName: IMG }), XSS)], customers: [], csrfToken: "c" }));
    expectEscaped(out);
    expect(out).toContain("&lt;script&gt;");
  });

  it("the upgrade dialog title escapes the site and template names", () => {
    const out = wrap(en, createElement(UpgradeSiteTemplateDialog, { site: site("a", "ready", ref({ templateName: IMG }), XSS), csrfToken: "c", onClose: vi.fn(), onDone: vi.fn() }));
    expectEscaped(out);
    expect(out).toContain("&lt;script&gt;");
  });

  it("the code editor escapes marker messages in the gutter title and the source in the text area", () => {
    const out = renderToStaticMarkup(createElement(CodeEditor, { id: "e", value: `a\n</textarea>${XSS}`, onChange: () => {}, markers: [{ line: 2, message: `${IMG}${XSS}` }], label: "Source" }));
    expectEscaped(out);
    expect(out).toContain("&lt;/textarea&gt;");
    expect(out.match(/<\/textarea>/g)).toHaveLength(1);
  });

  it("the customer chooser escapes name and description, and a quote in an id cannot open an attribute", () => {
    const type = { id: 'stpl_x" onfocus="alert(1)', name: XSS, description: IMG, module: "wordpress", phpVersions: [], defaultPhpVersion: null, parameters: [] } as CustomerSiteTypeDto;
    const out = wrap(en, createElement(SiteTypeChooser, { siteTypes: [type], value: null, onChange: () => {} }));
    expectEscaped(out);
    expect(out).not.toContain('onfocus="');
  });

  it("the customer form escapes option labels, choices and defaults", () => {
    const type: CustomerSiteTypeDto = {
      id: "stpl_x", name: "X", description: null, module: "wordpress", phpVersions: ["8.4"], defaultPhpVersion: "8.4",
      parameters: [
        { key: "title", label: XSS, type: "string", default: IMG },
        { key: "mode", label: "Mode", type: "enum", options: [XSS, "b"], default: XSS },
      ],
    };
    const out = wrap(en, createElement(SiteForm, { onSubmit: () => {}, submitting: false, siteType: type }));
    expectEscaped(out);
    expect(out).toContain('value="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"');
  });
});

describe("the editor shows validation issues without a position or path as plain text", () => {
  const editorProps = { csrfToken: "c", module: "wordpress" as const, initialSource: "a: 1\n", target: { kind: "create" as const, name: "", description: "" } };
  const lis = (result: unknown, m: Messages = en) => {
    const { tree } = callHooks(SiteTemplateEditor, editorProps, m, { 6: result });
    return els(tree).filter((e) => e.type === "li");
  };

  it("null line, column and path leave only the message, as a string child (React escapes it)", () => {
    const errors = [
      { line: null, column: null, path: null, code: "X", message: XSS },
      { line: null, column: 4, path: null, code: "X", message: "column without line" },
      { line: 2, column: null, path: "services.web", code: "X", message: IMG },
    ];
    const items = lis({ valid: false, errors, parameters: [], preview: null });
    expect(items.map((li) => li.props.children)).toEqual([XSS, "column without line", `${format2(en.admin.templates.editor.errorAt, 2, 1)} · services.web · ${IMG}`]);
    for (const li of items) expect(typeof li.props.children).toBe("string");
  });

  it("a message that looks like a placeholder or a replacement pattern stays literal", () => {
    const issue = { line: 1, column: 2, path: "p", code: "X", message: "{line} {column} $& $1" } as never;
    expect(validationErrorText(en.admin.templates.editor, issue)).toBe(`${format2(en.admin.templates.editor.errorAt, 1, 2)} · p · {line} {column} $& $1`);
  });

  it("a valid answer shows the preview as one string child, whatever it holds", () => {
    const { tree } = callHooks(SiteTemplateEditor, editorProps, en, { 6: { valid: true, errors: [], parameters: [], preview: { note: XSS } } });
    const pre = els(tree).find((e) => e.type === "pre")!;
    expect(pre.props.children).toBe(JSON.stringify({ note: XSS }, null, 2));
  });

  it("the page never injects markup: no editor, chooser or dialog file uses dangerouslySetInnerHTML or innerHTML", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = path.resolve(__dirname, "../src");
    const files = [
      "components/admin/site-template-editor.tsx", "components/admin/site-template-list.tsx", "components/admin/site-template-detail.tsx",
      "components/admin/code-editor.tsx", "components/admin/upgrade-site-template-dialog.tsx", "components/admin/sites-table.tsx",
      "components/customer/site-type-chooser.tsx", "components/customer/site-form.tsx", "components/customer/new-site.tsx",
      "app/admin/templates/page.tsx", "app/admin/templates/new/page.tsx", "app/admin/templates/[templateId]/page.tsx", "app/admin/templates/[templateId]/edit/page.tsx",
    ];
    for (const f of files) expect(fs.readFileSync(path.join(src, f), "utf8"), f).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML/);
  });
});
const format2 = (tpl: string, line: number, column: number) => tpl.replace("{line}", String(line)).replace("{column}", String(column));

// ---------------------------------------------------------------- upgrade dialog

describe("the upgrade offers only a newer default version", () => {
  it("upgradeTarget is null unless both default fields are set and the default number is greater", () => {
    expect(upgradeTarget(site("a"))).toEqual({ versionId: "stv_wordpress_2", versionNumber: 2, templateName: "WordPress" });
    for (const over of [
      { defaultVersionId: null },
      { defaultVersionNumber: null },
      { defaultVersionNumber: 1 },
      { defaultVersionNumber: 0 },
      { versionNumber: 3 },
    ]) {
      expect(upgradeTarget(site("a", "ready", ref(over))), JSON.stringify(over)).toBeNull();
    }
  });

  const props = (s: AdminSiteDto | null) => ({ site: s, csrfToken: "csrf", onClose: vi.fn(), onDone: vi.fn() });
  const submit = async (tree: ReactNode) => {
    const form = els(tree).find((e) => e.type === "form")!;
    await (form.props.onSubmit as (e: { preventDefault(): void }) => Promise<void>)({ preventDefault() {} });
  };
  const buttons = (tree: ReactNode) => els(tree).filter((e) => typeof e.type !== "string" && "type" in e.props && (e.props.type === "submit" || e.props.type === "button"));
  beforeEach(() => keyedSend.mockReset());

  it.each(locales)("while the request is pending both buttons are disabled and the confirm shows the working label (%s)", (_l, m) => {
    const { tree } = callHooks(UpgradeSiteTemplateDialog, props(site("a")), m, { 0: true });
    const [cancel, confirm] = buttons(tree);
    expect(cancel!.props.disabled).toBe(true);
    expect(confirm!.props.disabled).toBe(true);
    expect(textOf(confirm)).toBe(m.admin.sites.working);
  });

  it("when idle the buttons are enabled and the confirm names the action", () => {
    const [cancel, confirm] = buttons(callHooks(UpgradeSiteTemplateDialog, props(site("a")), en).tree);
    expect(cancel!.props.disabled).toBe(false);
    expect(confirm!.props.disabled).toBe(false);
    expect(textOf(confirm)).toBe(en.admin.sites.upgradeConfirm);
  });

  it("submitting a site with no newer version sends nothing", async () => {
    for (const s of [null, site("a", "ready", null), site("a", "ready", ref({ defaultVersionNumber: 1 }))]) {
      await submit(callHooks(UpgradeSiteTemplateDialog, props(s), en).tree);
    }
    expect(keyedSend).not.toHaveBeenCalled();
  });

  it("a newer default version later gets another idempotency key, so a moved target is not replayed", async () => {
    keyedSend.mockResolvedValue({ ok: true, data: {} });
    await submit(callHooks(UpgradeSiteTemplateDialog, props(site("a")), en).tree);
    await submit(callHooks(UpgradeSiteTemplateDialog, props(site("a", "ready", ref({ defaultVersionId: "stv_wordpress_3", defaultVersionNumber: 3 }))), en).tree);
    expect(keyedSend.mock.calls.map((c) => c[2])).toEqual(["upgrade:a:stv_wordpress_2", "upgrade:a:stv_wordpress_3"]);
  });

  it("an upstream refusal never leaks into the dialog beyond the localized sentence", async () => {
    keyedSend.mockResolvedValue({ ok: false, code: "SELECT * FROM sites; stack at /srv/api" });
    const { tree, sets } = callHooks(UpgradeSiteTemplateDialog, props(site("a")), en);
    await submit(tree);
    expect(sets.filter(([k]) => k === 1).at(-1)).toEqual([1, errorMessage(en, "")]);
  });
});

// ---------------------------------------------------------------- customer chooser and form

const type = (id: string, over: Partial<CustomerSiteTypeDto> = {}): CustomerSiteTypeDto => ({
  id, name: id, description: null, module: "wordpress", phpVersions: ["8.4"], defaultPhpVersion: "8.4", parameters: [], ...over,
});
const formBody = { name: "a", domain: "a.test", title: "t", adminUser: "u", adminEmail: "u@a.test", adminPassword: "p".repeat(12), includeWww: false } as SiteFormBody;

describe("the customer chooser and the creation body", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { siteId: "s1" } }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    router.push.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  const newSite = (siteTypes: CustomerSiteTypeDto[], over: Record<number, unknown> = {}) => {
    const { tree } = callHooks(NewSite, { orgId: "org_1", csrfToken: "csrf", siteTypes, limit: null }, en, over);
    return {
      chooser: els(tree).find((e) => e.type === SiteTypeChooser),
      form: els(tree).find((e) => e.type === SiteForm)!,
    };
  };
  const post = async (form: El) => {
    await (form.props.onSubmit as (b: SiteFormBody) => Promise<void>)(formBody);
    return JSON.parse(fetchMock.mock.calls.at(-1)![1].body as string) as Record<string, unknown>;
  };

  it("the chooser is hidden for zero or one site type and shown from two", () => {
    expect(newSite([]).chooser).toBeUndefined();
    expect(newSite([type("stpl_a")]).chooser).toBeUndefined();
    expect(newSite([type("stpl_a"), type("stpl_b")]).chooser).toBeDefined();
  });

  it("with exactly one site type the hidden chooser still sends its templateId; with none the body has no templateId", async () => {
    expect(await post(newSite([type("stpl_a")]).form)).toMatchObject({ templateId: "stpl_a" });
    expect(await post(newSite([]).form)).not.toHaveProperty("templateId");
  });

  it("a remembered choice that is no longer offered falls back to the first type in the chooser and in the body", async () => {
    const { chooser, form } = newSite([type("stpl_a"), type("stpl_b")], { 3: "stpl_gone" });
    expect(chooser!.props.value).toBe("stpl_a");
    expect(await post(form)).toMatchObject({ templateId: "stpl_a" });
  });

  it.each([["unknown"], ["not_customer"]])("an option the page shows but the server now refuses as %s: the options-changed sentence and a refresh, no field note", async (reason) => {
    const options = [{ key: "cache", label: "Cache", type: "enum" as const, options: ["a", "b"], default: "a" }];
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { code: "VALIDATION_ERROR", details: [{ field: "parameters.cache", reason }] } }), { status: 400 }));
    router.refresh.mockReset();
    const { tree, sets } = callHooks(NewSite, { orgId: "org_1", csrfToken: "csrf", siteTypes: [type("stpl_a", { parameters: options })], limit: null }, en);
    expect(els(tree).find((e) => e.type === SiteForm)!.props.siteType).toMatchObject({ parameters: [{ key: "cache" }] });
    await (els(tree).find((e) => e.type === SiteForm)!.props.onSubmit as (b: SiteFormBody) => Promise<void>)(formBody);
    expect(sets.filter(([k]) => k === 1).at(-1)).toEqual([1, en.site.create.optionsChanged]);
    expect(sets.filter(([k]) => k === 2).at(-1)).toEqual([2, {}]);
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("the second type's choice is the one posted", async () => {
    expect(await post(newSite([type("stpl_a"), type("stpl_b")], { 3: "stpl_b" }).form)).toMatchObject({ templateId: "stpl_b" });
  });

  it("the radios check only the chosen type; no value checks none, and picking reports the id", () => {
    const onChange = vi.fn();
    const render = (value: string | null) =>
      callHooks(SiteTypeChooser, { siteTypes: [type("stpl_a"), type("stpl_b")], value, onChange }, en).tree;
    const radios = (value: string | null) => els(render(value)).filter((e) => e.type === "input");
    expect(radios("stpl_b").map((r) => r.props.checked)).toEqual([false, true]);
    expect(radios(null).map((r) => r.props.checked)).toEqual([false, false]);
    (radios("stpl_a")[1]!.props.onChange as () => void)();
    expect(onChange).toHaveBeenCalledWith("stpl_b");
  });

  it("a PHP version parameter is never rendered as an option, and only the type's own options appear", () => {
    const t = type("stpl_a", {
      parameters: [
        { key: "php_version", label: "PHP", type: "enum", options: ["8.3", "8.4"], default: "8.4" },
        { key: "tagline", label: "Tagline", type: "string" },
      ],
    });
    const out = wrap(en, createElement(SiteForm, { onSubmit: () => {}, submitting: false, siteType: t }));
    expect(out).not.toContain("site-param-php_version");
    expect(out).toContain('id="site-param-tagline"');
    expect(wrap(en, createElement(SiteForm, { onSubmit: () => {}, submitting: false, siteType: type("stpl_b") }))).not.toContain("site-param-");
  });
});

describe("option defaults are prefilled", () => {
  const t = type("stpl_d", {
    parameters: [
      { key: "mode", label: "Mode", type: "enum", options: ["a", "b", "c"], default: "b" },
      { key: "zero", label: "Zero", type: "integer", min: 0, max: 9, default: 0 },
      { key: "flag", label: "Flag", type: "boolean", default: true },
      { key: "off", label: "Off", type: "boolean" },
      { key: "name", label: "Name", type: "string", default: "demo" },
    ],
  });
  const out = wrap(en, createElement(SiteForm, { onSubmit: () => {}, submitting: false, siteType: t }));
  const tag = (id: string) => new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(out)?.[0] ?? "";

  it("selects a default that is not the first choice, keeps a default of 0, ticks a true default and leaves the rest empty", () => {
    expect(out).toMatch(/<option value="b" selected="">/);
    expect(out).not.toMatch(/<option value="a" selected="">/);
    expect(tag("site-param-zero")).toContain('value="0"');
    expect(tag("site-param-flag")).toContain("checked");
    expect(tag("site-param-off")).not.toContain("checked");
    expect(tag("site-param-name")).toContain('value="demo"');
  });

  it("untouched options send their defaults, and a customer who unticks a true default sends false", () => {
    expect(buildParameterValues(t.parameters, {})).toEqual([
      { key: "mode", value: "b" }, { key: "zero", value: 0 }, { key: "flag", value: true }, { key: "off", value: false }, { key: "name", value: "demo" },
    ]);
    expect(buildParameterValues(t.parameters, { flag: false, zero: "  ", name: "" })).toContainEqual({ key: "flag", value: false });
    expect(buildParameterValues(t.parameters, { zero: "  ", name: "" })).toEqual(expect.arrayContaining([{ key: "zero", value: 0 }, { key: "name", value: "demo" }]));
  });

  it("an option named like an Object.prototype member ('constructor') is a normal option, not the inherited function", () => {
    const params: CustomerSiteTypeDto["parameters"] = [{ key: "constructor", label: "Builder", type: "string", default: "acme" }];
    expect(buildParameterValues(params, {})).toEqual([{ key: "constructor", value: "acme" }]);
    const form = wrap(en, createElement(SiteForm, { onSubmit: () => {}, submitting: false, siteType: type("stpl_c", { parameters: params }) }));
    expect(form).toContain('value="acme"');
    expect(form).not.toContain("native code");
  });

  it.each(["__proto__", "toString", "hasOwnProperty"])("an option named '%s' sends its default, and a value typed for it wins", (key) => {
    const params: CustomerSiteTypeDto["parameters"] = [{ key, label: "Odd", type: "string", default: "acme" }];
    expect(buildParameterValues(params, {})).toEqual([{ key, value: "acme" }]);
    const typed = Object.defineProperty({}, key, { value: "mine", enumerable: true });
    expect(buildParameterValues(params, typed)).toEqual([{ key, value: "mine" }]);
  });
});

// ---------------------------------------------------------------- stale option values after a change of site type

describe("a value typed for another site type's option is ignored", () => {
  const options: CustomerSiteTypeDto["parameters"] = [
    { key: "cache", label: "Cache", type: "enum", options: ["memcached", "redis"] },
    { key: "mode", label: "Mode", type: "enum", options: ["a", "b"], default: "b" },
    { key: "flag", label: "Flag", type: "boolean" },
  ];

  it("an enum value that is not one of the choices falls back to the default, else the first choice; a wrong kind of value to the default", () => {
    expect(buildParameterValues(options, { cache: "none", mode: "none" })).toEqual([
      { key: "cache", value: "memcached" }, { key: "mode", value: "b" }, { key: "flag", value: false },
    ]);
    expect(buildParameterValues(options, { cache: true, mode: false, flag: "yes" })).toEqual([
      { key: "cache", value: "memcached" }, { key: "mode", value: "b" }, { key: "flag", value: false },
    ]);
    expect(buildParameterValues(options, { cache: "redis", mode: "a", flag: true })).toEqual([
      { key: "cache", value: "redis" }, { key: "mode", value: "a" }, { key: "flag", value: true },
    ]);
  });

  it("a text option keeps what was typed, even when it is the text of another option's choice", () => {
    expect(buildParameterValues([{ key: "tagline", label: "T", type: "string" }], { tagline: "none" })).toEqual([{ key: "tagline", value: "none" }]);
  });

  it("a number option takes over text carried over from another type's option of the same key only if a number field can hold it", () => {
    const withDefault = [{ key: "x", label: "X", type: "integer" as const, default: 2 }];
    // Text a number field cannot hold (or shows blank) falls back to the default.
    for (const typed of ["abc", "-", "0x10", "12px", "1 2", " 5 ", "5 ", ".", "1e", "+5"]) {
      expect(buildParameterValues(withDefault, { x: typed }), typed).toEqual([{ key: "x", value: 2 }]);
      expect(buildParameterValues([{ key: "x", label: "X", type: "integer" }], { x: typed }), typed).toEqual([]);
    }
    // What the customer types into the number field itself is kept, decimals included: the browser blocks the submit (whole steps only), the form never swaps it for the default.
    for (const [typed, sent] of [["7", 7], ["-3", -3], ["0", 0], ["2.5", 2.5], ["1e3", 1000], ["1.0", 1], [".5", 0.5]] as const) {
      expect(buildParameterValues(withDefault, { x: typed }), typed).toEqual([{ key: "x", value: sent }]);
    }
    const kept = callHooks(SiteForm, { onSubmit: vi.fn(), submitting: false, siteType: type("stpl_b", { parameters: withDefault }) }, en, { 4: { x: "2.5" } });
    expect(els(kept.tree).find((e) => e.props.id === "site-param-x")!.props.value).toBe("2.5");
    // Cleared by the customer: still blank, so the default is sent.
    expect(buildParameterValues(withDefault, { x: "" })).toEqual([{ key: "x", value: 2 }]);
    // The control shows the default, not text it cannot hold.
    const { tree } = callHooks(SiteForm, { onSubmit: vi.fn(), submitting: false, siteType: type("stpl_b", { parameters: withDefault }) }, en, { 4: { x: "abc" } });
    expect(els(tree).find((e) => e.props.id === "site-param-x")!.props.value).toBe("2");
  });

  it("the controls show the value that is sent", () => {
    const { tree } = callHooks(SiteForm, { onSubmit: vi.fn(), submitting: false, siteType: type("stpl_b", { parameters: options }) }, en, { 4: { cache: "none", flag: "yes" } });
    const control = (id: string) => els(tree).find((e) => e.props.id === id)!;
    expect(control("site-param-cache").props.value).toBe("memcached");
    expect(control("site-param-mode").props.value).toBe("b");
    expect(control("site-param-flag").props.checked).toBe(false);
  });
});

// ---------------------------------------------------------------- permanent refusals and the retried save

const lostReply = (keys: Record<string, string>, _csrf: string, name: string) => {
  keys[name] ??= "key"; // as keyedSend does: after a lost reply the key is kept, so a retry replays
  return Promise.resolve({ ok: false as const, code: "" });
};

describe("an archived or invalid template is permanent on the template page", () => {
  const detail = { ...summary({ id: "stpl_x" }), versions: [] } as unknown as AdminSiteTemplateDetailDto;
  beforeEach(() => keyedSend.mockReset());

  it.each(locales)("an archived or invalid template is named as such, not 'try again' (%s)", async (_l, m) => {
    const noticeAfter = async (answer: Record<string, unknown>) => {
      keyedSend.mockResolvedValue({ ok: false, ...answer });
      const { tree, sets } = callHooks(SiteTemplateDetail, { template: detail, csrfToken: "c" }, m);
      (els(tree).find((e) => e.props.id === "template-enabled")!.props.onChange as (ev: unknown) => void)({ target: { checked: false } });
      await vi.waitFor(() => expect(sets.filter(([k]) => k === 1).length).toBeGreaterThan(1));
      return sets.filter(([k]) => k === 1).at(-1);
    };
    expect(await noticeAfter({ code: "RESOURCE_LOCKED", reason: "template_archived" })).toEqual([1, { ok: false, text: m.admin.templates.detail.archivedNotice }]);
    // What the enable / make-default PATCH really answers for a template that fails today's checks (keyedSend carries the first detail's reason).
    expect(await noticeAfter({ code: "VALIDATION_ERROR", reason: "template_invalid" })).toEqual([1, { ok: false, text: m.admin.templates.invalid }]);
    expect(await noticeAfter({ code: "VALIDATION_ERROR" })).toEqual([1, { ok: false, text: m.errors.VALIDATION_ERROR }]);
    expect(await noticeAfter({ code: "RESOURCE_LOCKED", reason: "built_in" })).toEqual([1, { ok: false, text: m.errors.RESOURCE_LOCKED }]);
    expect(await noticeAfter({ code: "NOT_FOUND", reason: "template_archived" })).toEqual([1, { ok: false, text: m.errors.NOT_FOUND }]);
  });
});

describe("the administrator's create dialog does not point at fields it never highlights", () => {
  beforeEach(() => keyedSend.mockReset());

  it.each(locales)("a validation refusal gets a sentence that names the fields (%s)", async (_l, m) => {
    keyedSend.mockResolvedValue({ ok: false, code: "VALIDATION_ERROR" });
    const { tree, sets } = callHooks(CreateSiteForCustomerDialog, { customers: [], csrfToken: "c" }, m, { 0: true });
    await (els(tree).find((e) => e.type === SiteForm)!.props.onSubmit as (b: SiteFormBody) => Promise<void>)(formBody);
    const shown = sets.filter(([k]) => k === 3).at(-1)![1];
    expect(shown).toBe(m.admin.sites.createInvalid);
    expect(shown).not.toBe(m.errors.VALIDATION_ERROR);
  });

  it("the other refusals keep their sentences", async () => {
    keyedSend.mockResolvedValue({ ok: false, code: "DOMAIN_CONFLICT" });
    const { tree, sets } = callHooks(CreateSiteForCustomerDialog, { customers: [], csrfToken: "c" }, en, { 0: true });
    await (els(tree).find((e) => e.type === SiteForm)!.props.onSubmit as (b: SiteFormBody) => Promise<void>)(formBody);
    expect(sets.filter(([k]) => k === 3).at(-1)).toEqual([3, en.site.create.domainConflict]);
  });
});

describe("a template save that is sent again after a lost reply", () => {
  const fetchMock = vi.fn();
  const e = en.admin.templates.editor;
  const CREATE = { kind: "create", name: "Shop", description: "" } as const;
  const VERSION = { kind: "version", templateId: "stpl_x", archived: false } as const;
  beforeEach(() => {
    keyedSend.mockReset();
    router.push.mockReset();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ data: { valid: true, errors: [], preview: {} } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const mount = (target: typeof CREATE | typeof VERSION, source = SOURCE) =>
    callHooks(SiteTemplateEditor, { csrfToken: "c", module: "wordpress", initialSource: source, target }, en);
  const save = async (tree: ReactNode, label = e.saveCreate) => {
    await (els(tree).find((x) => x.type === Button && textOf(x) === label)!.props.onClick as () => Promise<void>)();
  };
  const errorOf = (sets: Array<[number, unknown]>) => sets.filter(([k]) => k === 7).at(-1)?.[1];
  const taken = { ok: false, code: "ALREADY_EXISTS", reason: "name_taken" };

  it("a name_taken after a lost reply says the first save may have worked, instead of 'name in use'", async () => {
    keyedSend.mockImplementationOnce(lostReply).mockResolvedValueOnce(taken);
    const { tree, sets } = mount(CREATE);
    await save(tree);
    expect(errorOf(sets)).toBe(errorMessage(en, "")); // the lost reply: the generic sentence
    await save(tree);
    expect(errorOf(sets)).toBe(e.createRetried);
    expect(e.createRetried).not.toBe(en.errors.ALREADY_EXISTS);
    expect(router.push).not.toHaveBeenCalled();
  });

  it("the notice links to the template list", () => {
    const link = (error: string | null) => els(callHooks(SiteTemplateEditor, { csrfToken: "c", module: "wordpress", initialSource: SOURCE, target: CREATE }, en, { 7: error }).tree).find((x) => x.type === Link);
    expect(link(e.createRetried)!.props.href).toBe("/admin/templates");
    expect(textOf(link(e.createRetried))).toBe(en.admin.templates.back);
    expect(link(en.errors.ALREADY_EXISTS)).toBeUndefined();
    expect(link(null)).toBeUndefined();
  });

  it("a name that is taken on the first attempt, or for another reason, keeps the ordinary sentence", async () => {
    keyedSend.mockResolvedValueOnce(taken);
    const first = mount(CREATE);
    await save(first.tree);
    expect(errorOf(first.sets)).toBe(en.errors.ALREADY_EXISTS);

    keyedSend.mockImplementationOnce(lostReply).mockResolvedValueOnce({ ok: false, code: "ALREADY_EXISTS", reason: "other" });
    const other = mount(CREATE);
    await save(other.tree);
    await save(other.tree);
    expect(errorOf(other.sets)).toBe(en.errors.ALREADY_EXISTS);
  });

  it("a new version has no name to clash with: the retry is not given the template-list notice", async () => {
    keyedSend.mockImplementationOnce(lostReply).mockResolvedValueOnce(taken);
    const { tree, sets } = mount(VERSION, `${SOURCE}# changed\n`);
    await save(tree, e.save);
    await save(tree, e.save);
    expect(errorOf(sets)).toBe(en.errors.ALREADY_EXISTS);
  });
});

// ---------------------------------------------------------------- i18n

describe("the new copy exists in Italian and English, with the same placeholders", () => {
  const flat = (o: unknown, prefix = ""): Map<string, string> =>
    Object.entries(o as Record<string, unknown>).reduce((acc, [k, v]) => {
      if (typeof v === "string") acc.set(prefix + k, v);
      else if (v && typeof v === "object") flat(v, `${prefix}${k}.`).forEach((x, key) => acc.set(key, x));
      return acc;
    }, new Map<string, string>());
  const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort().join(",");
  const subtrees: [string, (m: Messages) => unknown][] = [
    ["admin.templates", (m) => m.admin.templates],
    ["admin.nav", (m) => m.admin.nav],
    ["admin.sites", (m) => m.admin.sites],
    ["site.create", (m) => m.site.create],
  ];

  it.each(subtrees)("%s: the same keys, no blank string, the same {placeholders} per key", (_name, pick) => {
    const [a, b] = [flat(pick(en)), flat(pick(itMsgs))];
    expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
    for (const [key, text] of a) {
      expect(text.trim(), `en ${key}`).not.toBe("");
      expect(b.get(key)!.trim(), `it ${key}`).not.toBe("");
      expect(placeholders(b.get(key)!), key).toBe(placeholders(text));
    }
  });

  it.each(locales)("the refusals of the template flows have their own sentence, not the generic one (%s)", (_l, m) => {
    for (const code of ["ALREADY_EXISTS", "RESOURCE_LOCKED", "PERMISSION_DENIED", "NOT_FOUND", "VALIDATION_ERROR"]) {
      expect(errorMessage(m, code), code).not.toBe(m.errors.generic);
    }
  });
});
