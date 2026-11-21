import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BUILT_IN_WORDPRESS_SOURCE,
  type AdminSiteTemplateDetailDto,
  type AdminSiteTemplateVersionDto,
  type SiteTemplateValidationDto,
} from "@hosting-panel/contracts";
import { format, type Messages } from "@/i18n";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { I18nProvider } from "@/i18n/provider";

const fetchUpstream = vi.fn();
const getServerSession = vi.fn();
const getRequestLocale = vi.fn();
const notFound = vi.fn();

vi.mock("@/lib/upstream", async () => ({
  ...(await vi.importActual<object>("@/lib/upstream")),
  fetchUpstream: (...args: unknown[]) => fetchUpstream(...args),
}));
vi.mock("@/lib/server-session", () => ({
  getServerSession: (...args: unknown[]) => getServerSession(...args),
}));
vi.mock("@/i18n/server", () => ({ getRequestLocale: (...args: unknown[]) => getRequestLocale(...args) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  notFound: () => {
    notFound();
    throw new Error("NOT_FOUND");
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/admin/templates/new",
}));

import NewSiteTemplatePage from "@/app/admin/templates/new/page";
import EditSiteTemplatePage from "@/app/admin/templates/[templateId]/edit/page";
import {
  SiteTemplateEditor,
  canSave,
  syntaxMarkers,
  validationErrorText,
  validationMarkers,
  type EditorTarget,
} from "@/components/admin/site-template-editor";

const NOW = "2026-11-21T10:00:00.000Z";
const BROKEN = "services:\n  app:\n image: x\n  bad";

const wrap = (m: Messages, node: ReactElement, locale: "en" | "it" = "en") =>
  createElement(I18nProvider, { locale, messages: m, children: node });
const html = (m: Messages, node: ReactElement, locale: "en" | "it" = "en") =>
  renderToStaticMarkup(wrap(m, node, locale)).replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

// The attribute, not the `disabled:` utility classes every button carries.
const disabledButton = (label: string) => new RegExp(`<button[^>]*\\sdisabled=""[^>]*>[^<]*${label}`);

const CREATE: EditorTarget = { kind: "create", name: "", description: "" };
const VERSION: EditorTarget = { kind: "version", templateId: "stpl_custom", archived: false };
const ARCHIVED: EditorTarget = { kind: "version", templateId: "stpl_custom", archived: true };

type Issue = SiteTemplateValidationDto["errors"][number];
const issue = (over: Partial<Issue> = {}): Issue => ({ line: null, column: null, path: null, code: "X", message: "bad", ...over });

describe("syntaxMarkers", () => {
  it("is empty for the built-in source", () => {
    expect(syntaxMarkers(BUILT_IN_WORDPRESS_SOURCE)).toEqual([]);
  });

  it("is empty for an empty source (nothing to complain about yet)", () => {
    expect(syntaxMarkers("")).toEqual([]);
  });

  it("marks the line of a syntax error with the parser's message", () => {
    const markers = syntaxMarkers(BROKEN);
    expect(markers).toHaveLength(1);
    expect(markers[0]!.line).toBeGreaterThanOrEqual(1);
    expect(markers[0]!.message).not.toBe("");
  });

  it("marks a tab used as indentation", () => {
    expect(syntaxMarkers("services:\n\tapp: 1")).toHaveLength(1);
  });
});

describe("validationMarkers", () => {
  it("keeps the errors that have a line and skips the others", () => {
    expect(
      validationMarkers([
        issue({ line: 3, column: 5, message: "a" }),
        issue({ line: null, message: "no position" }),
        issue({ line: 7, message: "b" }),
      ]),
    ).toEqual([
      { line: 3, message: "a" },
      { line: 7, message: "b" },
    ]);
  });

  it("is empty without errors", () => {
    expect(validationMarkers([])).toEqual([]);
  });
});

describe("validationErrorText", () => {
  const t = en.admin.templates.editor;

  it("joins position, path and message", () => {
    expect(validationErrorText(t, issue({ line: 3, column: 5, path: "services.app.ports", message: "not allowed" }))).toBe(
      "Line 3, column 5 · services.app.ports · not allowed",
    );
  });

  it("skips the position without a line and the path without one", () => {
    expect(validationErrorText(t, issue({ path: "services.app", message: "m" }))).toBe("services.app · m");
    expect(validationErrorText(t, issue({ message: "only message" }))).toBe("only message");
  });

  it("assumes column 1 when the server gave a line only, and reads Italian", () => {
    expect(validationErrorText(t, issue({ line: 2, message: "m" }))).toBe("Line 2, column 1 · m");
    expect(validationErrorText(itMsgs.admin.templates.editor, issue({ line: 4, column: 2, message: "m" }))).toBe(
      "Riga 4, colonna 2 · m",
    );
  });
});

describe("canSave", () => {
  const ok = { source: "a: 1", initialSource: "a: 0", syntaxOk: true, target: VERSION, name: "", busy: false };

  it("allows a changed source on a live template", () => {
    expect(canSave(ok)).toBe(true);
  });

  it("refuses while busy, on a syntax error and on an empty or blank source", () => {
    expect(canSave({ ...ok, busy: true })).toBe(false);
    expect(canSave({ ...ok, syntaxOk: false })).toBe(false);
    expect(canSave({ ...ok, source: "" })).toBe(false);
    expect(canSave({ ...ok, source: " \n  " })).toBe(false);
  });

  it("refuses a new version that is unchanged or whose template is archived", () => {
    expect(canSave({ ...ok, source: ok.initialSource })).toBe(false);
    expect(canSave({ ...ok, target: ARCHIVED })).toBe(false);
  });

  it("creating needs a name, but not a changed source", () => {
    const create = { ...ok, target: CREATE, source: ok.initialSource };
    expect(canSave({ ...create, name: "" })).toBe(false);
    expect(canSave({ ...create, name: "   " })).toBe(false);
    expect(canSave({ ...create, name: "Blog" })).toBe(true);
  });
});

describe("SiteTemplateEditor", () => {
  const render = (props: Partial<Parameters<typeof SiteTemplateEditor>[0]> = {}, m: Messages = en) =>
    html(
      m,
      createElement(SiteTemplateEditor, {
        csrfToken: "csrf",
        module: "wordpress",
        initialSource: BUILT_IN_WORDPRESS_SOURCE,
        target: CREATE,
        ...props,
      }),
      m === en ? "en" : "it",
    );

  it("create: shows name, description and module, the code editor with its hint, and no 'make default'", () => {
    const out = render();
    const e = en.admin.templates.editor;
    expect(out).toContain('id="template-name"');
    expect(out).toMatch(/id="template-name"[^>]*maxLength="80"/);
    expect(out).toContain('id="template-description"');
    expect(out).toContain('id="template-module"');
    expect(out).toContain(`>${en.admin.templates.modules.wordpress}</option>`);
    expect(out).toMatch(/<label[^>]*for="template-source"/);
    expect(out).toContain(e.keyboardHint);
    expect(out).toContain('id="template-source"');
    expect(out).toContain('aria-describedby="template-source-hint template-source-status"');
    expect(out).not.toContain(e.makeDefault);
    expect(out).toContain(e.saveCreate);
    expect(out).toContain(e.validate);
  });

  it("create: pre-fills the name and description it was given", () => {
    const out = render({ target: { kind: "create", name: "Blog (copy)", description: "A tuned blog" } });
    expect(out).toContain('value="Blog (copy)"');
    expect(out).toContain("A tuned blog");
  });

  it("version: no name fields, 'make default' ticked, and the save button says new version", () => {
    const out = render({ target: VERSION });
    const e = en.admin.templates.editor;
    expect(out).not.toContain('id="template-name"');
    expect(out).not.toContain('id="template-module"');
    expect(out).toMatch(/<input type="checkbox" checked=""/);
    expect(out).toContain(e.makeDefault);
    expect(out).toContain(e.save);
    expect(out).not.toContain(e.saveCreate);
  });

  it("archived: shows the notice instead of 'make default', and the editor is read-only", () => {
    const out = render({ target: ARCHIVED });
    expect(out).toContain(en.admin.templates.detail.archivedNotice);
    expect(out).not.toContain(en.admin.templates.editor.makeDefault);
    expect(out).toMatch(/<textarea[^>]*readOnly=""/);
    expect(out).toMatch(disabledButton("Save as new version"));
  });

  it("starts with the save button disabled until the source changes (version) or a name is typed (create)", () => {
    expect(render({ target: VERSION })).toMatch(disabledButton("Save as new version"));
    expect(render({ target: CREATE })).toMatch(disabledButton("Create template"));
    expect(render({ target: { kind: "create", name: "Blog", description: "" } })).not.toMatch(
      disabledButton("Create template"),
    );
  });

  it("status line: syntax OK for the built-in source, and no error marker in the gutter", () => {
    const out = render();
    expect(out).toMatch(/id="template-source-status" role="status"[^>]*>Syntax is correct\./);
    expect(out).not.toContain("data-error-line");
    expect(out).not.toContain('aria-invalid="true"');
  });

  it("status line: the first syntax error with its position, a marked gutter line and a disabled Validate", () => {
    const out = render({ initialSource: BROKEN });
    expect(out).not.toContain(en.admin.templates.editor.syntaxOk);
    expect(out).toMatch(/id="template-source-status" role="status"[^>]*>Line \d+, column \d+: /);
    expect(out).toContain("data-error-line");
    expect(out).toContain('aria-invalid="true"');
    expect(out).toMatch(disabledButton("Validate"));
  });

  it("an empty source parses (a blank editor is not a syntax error), but cannot be saved", () => {
    const out = render({ initialSource: "", target: { kind: "create", name: "Blog", description: "" } });
    expect(out).toContain(en.admin.templates.editor.syntaxOk);
    expect(out).toMatch(disabledButton("Create template"));
  });

  it("speaks Italian", () => {
    const out = render({}, itMsgs);
    expect(out).toContain(itMsgs.admin.templates.editor.saveCreate);
    expect(out).toContain(itMsgs.admin.templates.editor.syntaxOk);
    expect(out).toContain(itMsgs.admin.templates.editor.keyboardHint);
  });
});

describe("template editor pages", () => {
  const VERSIONS: Record<string, AdminSiteTemplateVersionDto> = {
    stv_custom_2: { id: "stv_custom_2", templateId: "stpl_custom", versionNumber: 2, createdAt: NOW, source: "# default v2\nservices: {}\n" },
    stv_custom_1: { id: "stv_custom_1", templateId: "stpl_custom", versionNumber: 1, createdAt: NOW, source: "# old v1\nservices: {}\n" },
  };
  const detail = (over: Partial<AdminSiteTemplateDetailDto> = {}): AdminSiteTemplateDetailDto =>
    ({
      id: "stpl_custom",
      module: "wordpress",
      name: "Blog",
      description: "A tuned blog",
      builtIn: false,
      enabled: true,
      archivedAt: null,
      defaultVersionId: "stv_custom_2",
      defaultVersionNumber: 2,
      versionCount: 2,
      siteCount: 3,
      createdAt: NOW,
      updatedAt: NOW,
      versions: [],
      ...over,
    }) as AdminSiteTemplateDetailDto;
  const envelope = (data: unknown) => ({ ok: true, status: 200, data: { data } });
  const route = (over: Record<string, unknown> = {}) => {
    const table: Record<string, unknown> = {
      "v1/admin/site-templates/stpl_custom": envelope(detail()),
      "v1/admin/site-templates/stpl_custom/versions/stv_custom_2": envelope(VERSIONS.stv_custom_2),
      "v1/admin/site-templates/stpl_custom/versions/stv_custom_1": envelope(VERSIONS.stv_custom_1),
      ...over,
    };
    fetchUpstream.mockImplementation(async (path: string) => table[path] ?? { ok: false, status: 404, data: null, error: null });
  };
  const paths = () => fetchUpstream.mock.calls.map((c) => c[0]);
  const render = async (node: Promise<ReactElement>, m: Messages = en) => html(m, await node, m === en ? "en" : "it");
  const newPage = (query: { from?: string; version?: string } = {}) =>
    NewSiteTemplatePage({ searchParams: Promise.resolve(query) });
  const editPage = (query: { version?: string } = {}, templateId = "stpl_custom") =>
    EditSiteTemplatePage({ params: Promise.resolve({ templateId }), searchParams: Promise.resolve(query) });

  beforeEach(() => {
    fetchUpstream.mockReset();
    getServerSession.mockReset();
    getRequestLocale.mockReset();
    notFound.mockReset();
    getServerSession.mockResolvedValue({ accessToken: "tok", csrfToken: "csrf" });
    getRequestLocale.mockResolvedValue("en");
    route();
  });

  it("redirect to /login without a session, before any upstream call", async () => {
    getServerSession.mockResolvedValue(null);
    await expect(newPage()).rejects.toThrow("REDIRECT:/login");
    await expect(editPage()).rejects.toThrow("REDIRECT:/login");
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("new: starts from the built-in WordPress source without any upstream call", async () => {
    const out = await render(newPage());
    expect(fetchUpstream).not.toHaveBeenCalled();
    expect(out).toMatch(/<h1[^>]*>New template<\/h1>/);
    expect(out).toContain('href="/admin/templates"');
    expect(out).toContain(en.admin.templates.back);
    expect(out).toContain('id="template-name"');
    expect(out).toContain(en.admin.templates.editor.syntaxOk);
    // The first line of the built-in definition is in the editor.
    expect(out).toContain(BUILT_IN_WORDPRESS_SOURCE.split("\n").find((l) => l.trim() !== "")!.trim());
  });

  it("new?from=: loads the template and its default version, prefilling the copy name, description and source", async () => {
    const out = await render(newPage({ from: "stpl_custom" }));
    expect(paths()).toEqual(["v1/admin/site-templates/stpl_custom", "v1/admin/site-templates/stpl_custom/versions/stv_custom_2"]);
    expect(out).toContain(`value="${format(en.admin.templates.editor.duplicateName, { name: "Blog" })}"`);
    expect(out).toContain("A tuned blog");
    expect(out).toContain("# default v2");
    expect(out).not.toContain("# old v1");
  });

  it("new?from=&version=: copies that version", async () => {
    const out = await render(newPage({ from: "stpl_custom", version: "stv_custom_1" }));
    expect(paths()).toEqual(["v1/admin/site-templates/stpl_custom", "v1/admin/site-templates/stpl_custom/versions/stv_custom_1"]);
    expect(out).toContain("# old v1");
  });

  it("new?from=: cuts a long copy name to the 80 characters the name field accepts", async () => {
    route({ "v1/admin/site-templates/stpl_custom": envelope(detail({ name: "N".repeat(80) })) });
    const out = await render(newPage({ from: "stpl_custom" }));
    expect(out).toContain(`value="${format(en.admin.templates.editor.duplicateName, { name: "N".repeat(80) }).slice(0, 80)}"`);
    expect(out).not.toContain("(copy)");
  });

  it("new?from=: a failed load shows the load error, not an empty editor", async () => {
    route({ "v1/admin/site-templates/stpl_custom": { ok: false, status: 500, data: null, error: null } });
    const out = await render(newPage({ from: "stpl_custom" }));
    expect(out).toContain(en.shell.loadErrorTitle);
    expect(out).not.toContain('id="template-source"');
    route({ "v1/admin/site-templates/stpl_custom/versions/stv_custom_2": { ok: false, status: 500, data: null, error: null } });
    expect(await render(newPage({ from: "stpl_custom" }))).toContain(en.shell.loadErrorTitle);
  });

  it("edit: loads the template and its default version, titles the page and shows the base version", async () => {
    const out = await render(editPage());
    expect(paths()).toEqual(["v1/admin/site-templates/stpl_custom", "v1/admin/site-templates/stpl_custom/versions/stv_custom_2"]);
    expect(out).toContain(format(en.admin.templates.editor.versionTitle, { name: "Blog" }));
    expect(out).toContain(format(en.admin.templates.editor.baseVersion, { version: 2 }));
    expect(out).toContain('href="/admin/templates/stpl_custom"');
    expect(out).toContain("# default v2");
    expect(out).toContain(en.admin.templates.editor.makeDefault);
    expect(out).not.toContain('id="template-name"');
  });

  it("edit?version=: starts from that version", async () => {
    const out = await render(editPage({ version: "stv_custom_1" }));
    expect(paths()).toEqual(["v1/admin/site-templates/stpl_custom", "v1/admin/site-templates/stpl_custom/versions/stv_custom_1"]);
    expect(out).toContain(format(en.admin.templates.editor.baseVersion, { version: 1 }));
    expect(out).toContain("# old v1");
  });

  it("edit: an archived template opens read-only", async () => {
    route({ "v1/admin/site-templates/stpl_custom": envelope(detail({ archivedAt: NOW, enabled: false })) });
    const out = await render(editPage());
    expect(out).toContain(en.admin.templates.detail.archivedNotice);
    expect(out).toMatch(/<textarea[^>]*readOnly=""/);
  });

  it("edit: a missing template is notFound(), a failed load is the load error", async () => {
    await expect(editPage({}, "stpl_missing")).rejects.toThrow("NOT_FOUND");
    expect(notFound).toHaveBeenCalledTimes(1);

    notFound.mockReset();
    route({ "v1/admin/site-templates/stpl_custom": { ok: false, status: 500, data: null, error: null } });
    expect(await render(editPage())).toContain(en.shell.loadErrorTitle);
    expect(notFound).not.toHaveBeenCalled();

    route({ "v1/admin/site-templates/stpl_custom/versions/stv_custom_2": { ok: false, status: 500, data: null, error: null } });
    expect(await render(editPage())).toContain(en.shell.loadErrorTitle);
  });

  it("edit: encodes the template id it sends upstream", async () => {
    await expect(editPage({}, "a/b")).rejects.toThrow("NOT_FOUND");
    expect(paths()).toEqual(["v1/admin/site-templates/a%2Fb"]);
  });

  it("both pages speak Italian when the locale is Italian", async () => {
    getRequestLocale.mockResolvedValue("it");
    expect(await render(newPage(), itMsgs)).toContain(itMsgs.admin.templates.editor.newTitle);
    expect(await render(editPage(), itMsgs)).toContain(format(itMsgs.admin.templates.editor.versionTitle, { name: "Blog" }));
  });
});
