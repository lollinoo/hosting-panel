import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  AdminAppTemplateDetailDto,
  AdminAppTemplateVersionDto,
  AppStackPreview,
  AppTemplateIssue,
  AppTemplateValidationDto,
} from "@hosting-panel/contracts";
import { format, type Messages } from "@/i18n";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { I18nProvider } from "@/i18n/provider";

const fetchUpstream = vi.fn();
const getServerSession = vi.fn();
const getRequestLocale = vi.fn();
const notFound = vi.fn();
const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

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
  useRouter: () => router,
  usePathname: () => "/admin/templates/apps/new",
}));

import NewAppTemplatePage from "@/app/admin/templates/apps/new/page";
import EditAppTemplatePage from "@/app/admin/templates/apps/[templateId]/edit/page";
import {
  AppTemplateEditor,
  appIssueMarkers,
  appIssueText,
  appParameterDefaultText,
  canSaveAppTemplate,
  type AppEditorTarget,
} from "@/components/admin/app-template-editor";

const NOW = "2026-11-22T10:00:00.000Z";
const SOURCE = "# HCP-STACK/v1\nservices:\n  web:\n    expose:\n      - 8080\n";
const BROKEN = "services:\n  web:\n image: x\n  bad";
const CREATE: AppEditorTarget = { kind: "create" };
const VERSION: AppEditorTarget = { kind: "version", templateId: "atpl_notes", archived: false };
const ARCHIVED: AppEditorTarget = { kind: "version", templateId: "atpl_notes", archived: true };
const t = en.admin.appTemplates;

const wrap = (m: Messages, node: ReactNode) =>
  createElement(I18nProvider, { locale: m === en ? "en" : "it", messages: m, children: node });
const html = (m: Messages, node: ReactNode) =>
  renderToStaticMarkup(wrap(m, node)).replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
// The attribute, not the `disabled:` utility classes every button carries.
const disabledButton = (label: string) => new RegExp(`<button[^>]*\\sdisabled=""[^>]*>[^<]*${label}`);

const issue = (over: Partial<AppTemplateIssue> = {}): AppTemplateIssue =>
  ({ path: "", code: "IMAGE_DIGEST_REQUIRED", reason: "STACK_IMAGE_NOT_ALLOWED", message: "msg", ...over }) as AppTemplateIssue;
const PREVIEW = {
  components: [{ key: "web", secretFiles: [{ envName: "DB_PASSWORD_FILE", parameterKey: "db_password" }] }],
  volumes: [],
  ingress: [{ componentKey: "web", port: 8080 }],
} as unknown as AppStackPreview;
const VALID: AppTemplateValidationDto = {
  valid: true,
  issues: [],
  parameters: [
    { key: "title", label: "Title", type: "string", default: "Notes", customer: true },
    { key: "db_password", label: "Database password", type: "secret", required: true, customer: true },
  ],
  preview: PREVIEW,
};
const INVALID: AppTemplateValidationDto = {
  valid: false,
  issues: [issue({ line: 3, column: 5, path: "services.web" }), issue({ code: "SPEC_INTERNAL", message: "no position" })],
  parameters: [],
  preview: null,
};

// ---------------------------------------------------------------- pure helpers

describe("appIssueText", () => {
  it("joins position, path, code and message", () => {
    expect(appIssueText(itMsgs.admin.appTemplates.editor, issue({ line: 3, column: 5, path: "services.web" }))).toBe(
      "Riga 3, colonna 5 · services.web · IMAGE_DIGEST_REQUIRED · msg",
    );
    expect(appIssueText(t.editor, issue({ line: 3, column: 5, path: "services.web" }))).toBe(
      "Line 3, column 5 · services.web · IMAGE_DIGEST_REQUIRED · msg",
    );
  });

  it("omits what is absent: the column without a line, the empty path, the position", () => {
    expect(appIssueText(t.editor, issue({ line: 2 }))).toBe("Line 2 · IMAGE_DIGEST_REQUIRED · msg");
    expect(appIssueText(t.editor, issue({ column: 4, path: "services" }))).toBe("services · IMAGE_DIGEST_REQUIRED · msg");
    expect(appIssueText(t.editor, issue())).toBe("IMAGE_DIGEST_REQUIRED · msg");
  });

  it("keeps a message that looks like a placeholder literal", () => {
    expect(appIssueText(t.editor, issue({ line: 1, message: "{line} $& $1" }))).toBe("Line 1 · IMAGE_DIGEST_REQUIRED · {line} $& $1");
  });
});

describe("appIssueMarkers", () => {
  it("marks the issues that have a line, with code and message, and drops the others", () => {
    expect(appIssueMarkers([issue({ line: 3, column: 5 }), issue({ path: "services" }), issue({ line: 7, message: "b" })])).toEqual([
      { line: 3, message: "IMAGE_DIGEST_REQUIRED: msg" },
      { line: 7, message: "IMAGE_DIGEST_REQUIRED: b" },
    ]);
    expect(appIssueMarkers([])).toEqual([]);
  });
});

describe("appParameterDefaultText", () => {
  type Parameter = AppTemplateValidationDto["parameters"][number];
  const secret = (over: object = {}) => ({ key: "db_password", label: "Database password", type: "secret", required: true, customer: true, ...over }) as Parameter;

  it.each([
    ["en", en],
    ["it", itMsgs],
  ] as const)("a value parameter shows its default as text (%s)", (_l, m) => {
    const e = m.admin.appTemplates.editor;
    expect(appParameterDefaultText(e, { key: "title", label: "Title", type: "string", default: "Notes", customer: true })).toBe("Notes");
    expect(appParameterDefaultText(e, { key: "debug", label: "Debug", type: "boolean", default: false, customer: false })).toBe("false");
    expect(appParameterDefaultText(e, { key: "workers", label: "Workers", type: "integer", default: 4, customer: true } as Parameter)).toBe("4");
  });

  it.each([
    ["en", en],
    ["it", itMsgs],
  ] as const)("a secret never shows a value: it says who sets it, and how the platform makes a generated one (%s)", (_l, m) => {
    const e = m.admin.appTemplates.editor;
    // HCP-STACK/v1 has no `generate`; in v2 null means the customer sets it.
    expect(appParameterDefaultText(e, secret())).toBe(e.secretNoDefault);
    expect(appParameterDefaultText(e, secret({ generate: null }))).toBe(e.secretNoDefault);
    const generated = appParameterDefaultText(e, secret({ customer: false, generate: { kind: "hex", length: 64 } }));
    expect(generated).toBe(format(e.secretGenerated, { kind: "hex", length: 64 }));
    expect(generated).toContain("hex");
    expect(generated).toContain("64");
    expect(generated).not.toMatch(/[{}]/);
  });
});

describe("canSaveAppTemplate", () => {
  const ok = { source: SOURCE, syntaxOk: true, busy: false, archived: false, slug: null };

  it("allows a version save of a non-blank, parsing source while idle", () => {
    expect(canSaveAppTemplate(ok)).toBe(true);
  });

  it("refuses a blank source, a syntax error, a busy editor and an archived template", () => {
    expect(canSaveAppTemplate({ ...ok, source: "" })).toBe(false);
    expect(canSaveAppTemplate({ ...ok, source: " \n  " })).toBe(false);
    expect(canSaveAppTemplate({ ...ok, syntaxOk: false })).toBe(false);
    expect(canSaveAppTemplate({ ...ok, busy: true })).toBe(false);
    expect(canSaveAppTemplate({ ...ok, archived: true })).toBe(false);
  });

  it("create needs a valid slug", () => {
    for (const slug of ["", "A", "-x", "a", "a b", "n".repeat(49)]) expect(canSaveAppTemplate({ ...ok, slug }), slug).toBe(false);
    for (const slug of ["ab", "notes", "my-app-2", "n".repeat(48)]) expect(canSaveAppTemplate({ ...ok, slug }), slug).toBe(true);
  });
});

// ---------------------------------------------------------------- the editor, with stand-in hooks

// Calls a client component once with stand-in hooks; `over` forces the value of a state slot (by call order).
const internals = (React as unknown as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE!;
function callHooks<P>(C: (p: P) => ReactNode, props: P, m: Messages = en, over: Record<number, unknown> = {}) {
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
const click = (tree: ReactNode, label: string) => {
  const button = els(tree).find((e) => typeof e.props.onClick === "function" && textOf(e) === label);
  if (!button) throw new Error(`no button ${label}`);
  return (button.props.onClick as () => Promise<void>)();
};

const editor = (target: AppEditorTarget = VERSION, over: Record<number, unknown> = {}, m: Messages = en) =>
  callHooks(AppTemplateEditor, { csrfToken: "csrf", initialSource: SOURCE, target }, m, over);

type Answer = { status: number; body: unknown };
const fetchMock = vi.fn();
/** Answers the validate route with `validation` and the save route with the next of `saves`. */
function answer(validation: AppTemplateValidationDto, saves: Answer[] = []) {
  fetchMock.mockImplementation(async (url: string) => {
    const a = url === "/api/admin/app-templates/validate" ? { status: 200, body: { data: validation } } : saves.shift()!;
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "Content-Type": "application/json" } });
  });
}
const sent = (url: string) =>
  fetchMock.mock.calls
    .filter((c) => c[0] === url)
    .map((c) => {
      const init = c[1] as RequestInit;
      return { method: init.method, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) };
    });
const VERSIONS_URL = "/api/admin/app-templates/atpl_notes/versions";
const created = (isNew: boolean) => ({
  status: 201,
  body: { data: { template: { id: "atpl_notes" }, versionId: "atv_notes_3", versionNumber: 3, created: isNew } },
});
const refusal = (status: number, code: string, reason?: string) => ({
  status,
  body: { error: { code, message: "x", details: reason ? [{ field: "slug", reason }] : [] } },
});

describe("AppTemplateEditor", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    router.push.mockReset();
    router.refresh.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("create: slug field with its hint and limit, the code editor with its hint and status, no 'make default'", () => {
    const out = html(en, editor(CREATE).tree);
    expect(out).toMatch(/<label[^>]*for="app-template-slug"/);
    expect(out).toMatch(/id="app-template-slug"[^>]*maxLength="48"/);
    expect(out).toContain(t.editor.slugHint);
    expect(out).toMatch(/<label[^>]*for="app-template-source"/);
    expect(out).toContain('id="app-template-source"');
    expect(out).toContain('aria-describedby="app-template-source-hint app-template-source-status"');
    expect(out).toContain(t.editor.sourceHint);
    expect(out).toMatch(/id="app-template-source-status" role="status"[^>]*>Syntax OK\./);
    expect(out).not.toContain(t.editor.makeDefault);
    expect(out).toMatch(disabledButton(t.editor.saveCreate));
  });

  it("create: a malformed slug is aria-invalid, a valid one enables the save", () => {
    expect(html(en, editor(CREATE, { 5: "A" }).tree)).toMatch(/id="app-template-slug"[^>]*aria-invalid="true"/);
    const out = html(en, editor(CREATE, { 5: "notes" }).tree);
    expect(out).not.toContain('aria-invalid="true"');
    expect(out).not.toMatch(disabledButton(t.editor.saveCreate));
  });

  it("version: no slug, 'make default' ticked, the save says new version", () => {
    const out = html(en, editor().tree);
    expect(out).not.toContain('id="app-template-slug"');
    expect(out).toMatch(/<input type="checkbox"[^>]*id="app-template-make-default"[^>]*checked=""/);
    expect(out).toMatch(/<label[^>]*for="app-template-make-default"/);
    expect(out).not.toMatch(disabledButton(t.editor.save));
  });

  it("archived: the notice instead of 'make default', a read-only editor and a disabled save", () => {
    const out = html(en, editor(ARCHIVED).tree);
    expect(out).toContain(t.editor.archived);
    expect(out).not.toContain(t.editor.makeDefault);
    expect(out).toMatch(/<textarea[^>]*readOnly=""/);
    expect(out).toMatch(disabledButton(t.editor.save));
  });

  it("a syntax error shows its position, marks the gutter and disables Validate", () => {
    const out = html(en, editor(VERSION, { 0: BROKEN }).tree);
    expect(out).toMatch(/id="app-template-source-status" role="status"[^>]*>Line \d+, column \d+: /);
    expect(out).toContain("data-error-line");
    expect(out).toMatch(disabledButton(t.editor.validate));
    expect(out).toMatch(disabledButton(t.editor.save));
  });

  it("the starter source of both locales parses", () => {
    for (const m of [en, itMsgs]) {
      const out = html(m, callHooks(AppTemplateEditor, { csrfToken: "c", initialSource: m.admin.appTemplates.editor.starter, target: CREATE }, m).tree);
      expect(out).toContain(m.admin.appTemplates.editor.syntaxOk);
    }
  });

  it("Validate posts {source} with the CSRF token and keeps the answer", async () => {
    answer(INVALID);
    const { tree, sets } = editor();
    await click(tree, t.editor.validate);
    expect(sent("/api/admin/app-templates/validate")).toEqual([
      { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": "csrf" }, body: { source: SOURCE } },
    ]);
    expect(sets).toContainEqual([1, INVALID]);
  });

  it("Validate: a refusal or a network failure is a sentence, not a result", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { code: "NOT_SUPPORTED" } }), { status: 422 }));
    let run = editor();
    await click(run.tree, t.editor.validate);
    expect(run.sets).toContainEqual([2, t.notAvailable]);
    fetchMock.mockRejectedValue(new Error("offline"));
    run = editor();
    await click(run.tree, t.editor.validate);
    expect(run.sets).toContainEqual([2, en.errors.generic]);
    expect(run.sets.some(([k, v]) => k === 1 && v !== null)).toBe(false);
  });

  it("an invalid answer lists every issue in a role=alert, and marks the located ones in the gutter", () => {
    const out = html(en, editor(VERSION, { 1: INVALID }).tree);
    expect(out).toMatch(/role="alert"[^>]*>[\s\S]*The template has errors:/);
    expect(out).toContain("<li>Line 3, column 5 · services.web · IMAGE_DIGEST_REQUIRED · msg</li>");
    expect(out).toContain("<li>SPEC_INTERNAL · no position</li>");
    expect(out).toContain('data-error-line="3"');
    expect(out).not.toContain("<pre");
  });

  it("a valid answer shows the parameters (no secret value) and the preview as one string child", () => {
    const { tree } = editor(VERSION, { 1: VALID });
    const pres = els(tree).filter((e) => e.type === "pre");
    expect(pres).toHaveLength(1);
    expect(pres[0]!.props.children).toBe(JSON.stringify(PREVIEW, null, 2));
    const out = html(en, tree);
    expect(out).toMatch(/role="status"[^>]*>[\s\S]*The template is valid\./);
    expect(out).toContain(t.editor.previewHint);
    expect(out).toContain(">title<");
    expect(out).toContain(">Notes<");
    expect(out).toContain(t.editor.secretNoDefault);
    expect(out).toContain(t.editor.customerYes);
  });

  it("a generated secret says how the platform makes it and that the customer does not set it", () => {
    const generated: AppTemplateValidationDto = {
      ...VALID,
      parameters: [{ key: "db_password", label: "Database password", type: "secret", required: true, customer: false, generate: { kind: "password", length: 32 } }],
    };
    const out = html(en, editor(VERSION, { 1: generated }).tree);
    expect(out).toContain(format(t.editor.secretGenerated, { kind: "password", length: 32 }));
    expect(out).toContain(t.editor.customerNo);
    expect(out).not.toContain(t.editor.secretNoDefault);
  });

  it("initialResult is the verdict the page opens with: no Validate click, no request", () => {
    const seeded = callHooks(AppTemplateEditor, { csrfToken: "csrf", initialSource: SOURCE, target: CREATE, initialResult: VALID });
    expect(seeded.sets).toEqual([]);
    const out = html(en, seeded.tree);
    expect(out).toMatch(/role="status"[^>]*>[\s\S]*The template is valid\./);
    expect(out).toContain(">title<");
    expect(fetchMock).not.toHaveBeenCalled();
    // An invalid verdict opens on its issues; without the prop, or with null, the editor opens with no verdict.
    const refused = html(en, callHooks(AppTemplateEditor, { csrfToken: "csrf", initialSource: SOURCE, target: CREATE, initialResult: INVALID }).tree);
    expect(refused).toContain(appIssueText(t.editor, INVALID.issues[0]!));
    for (const props of [{}, { initialResult: null }]) {
      const blank = html(en, callHooks(AppTemplateEditor, { csrfToken: "csrf", initialSource: SOURCE, target: CREATE, ...props }).tree);
      expect(blank).not.toContain("The template is valid.");
      expect(blank).not.toContain('role="alert"');
    }
  });

  it("an edit drops the result and the error", () => {
    const { tree, sets } = editor(VERSION, { 1: VALID });
    const code = els(tree).find((e) => e.props.id === "app-template-source")!;
    (code.props.onChange as (v: string) => void)("services: {}\n");
    expect(sets).toEqual(expect.arrayContaining([[0, "services: {}\n"], [1, null], [2, null]]));
  });

  it("create: validates, sends {slug, source} with a key and opens the new template", async () => {
    answer(VALID, [{ status: 201, body: { data: { id: "atpl_x" } } }]);
    await click(editor(CREATE, { 5: "notes" }).tree, t.editor.saveCreate);
    const [post] = sent("/api/admin/app-templates");
    expect(post!.body).toEqual({ slug: "notes", source: SOURCE });
    expect(post!.headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(post!.headers["X-CSRF-Token"]).toBe("csrf");
    expect(router.push).toHaveBeenCalledWith("/admin/templates/apps/atpl_x");
  });

  it("create: an invalid source is not sent", async () => {
    answer(INVALID);
    const { tree, sets } = editor(CREATE, { 5: "notes" });
    await click(tree, t.editor.saveCreate);
    expect(sent("/api/admin/app-templates")).toEqual([]);
    expect(sets).toContainEqual([1, INVALID]);
  });

  it("create: slug_taken is an error on the slug field; after a lost reply it says the save may have succeeded", async () => {
    answer(VALID, [refusal(409, "ALREADY_EXISTS", "slug_taken")]);
    let run = editor(CREATE, { 5: "notes" });
    await click(run.tree, t.editor.saveCreate);
    expect(run.sets).toContainEqual([2, t.reasons.slug_taken]);
    expect(router.push).not.toHaveBeenCalled();
    const out = html(en, editor(CREATE, { 2: t.reasons.slug_taken, 5: "notes" }).tree);
    expect(out).toMatch(/id="app-template-slug"[^>]*aria-invalid="true"/);
    expect(out).toMatch(/id="app-template-slug"[^>]*aria-describedby="app-template-slug-hint app-template-slug-error"/);
    expect(out).toMatch(new RegExp(`id="app-template-slug-error"[^>]*>${t.reasons.slug_taken}<`));
    expect(out.split(t.reasons.slug_taken)).toHaveLength(2);

    answer(VALID, [refusal(503, "SERVICE_UNAVAILABLE"), refusal(409, "ALREADY_EXISTS", "slug_taken")]);
    run = editor(CREATE, { 5: "notes" });
    await click(run.tree, t.editor.saveCreate);
    await click(run.tree, t.editor.saveCreate);
    expect(run.sets).toContainEqual([2, t.editor.createRetried]);
  });

  it("version: sends {source, makeDefault}, then opens the template and refreshes", async () => {
    answer(VALID, [created(true)]);
    await click(editor(VERSION, { 4: false }).tree, t.editor.save);
    expect(sent(VERSIONS_URL).map((s) => s.body)).toEqual([{ source: SOURCE, makeDefault: false }]);
    expect(router.push).toHaveBeenCalledWith("/admin/templates/apps/atpl_notes");
    expect(router.refresh).toHaveBeenCalled();
  });

  it("version: created:false is the 'unchanged' notice and the page stays", async () => {
    answer(VALID, [created(false)]);
    const { tree, sets } = editor();
    await click(tree, t.editor.save);
    expect(sets).toContainEqual([6, true]);
    expect(router.push).not.toHaveBeenCalled();
    expect(html(en, editor(VERSION, { 6: true }).tree)).toMatch(new RegExp(`role="status"[^>]*>[\\s\\S]*${t.editor.unchanged}`));
  });

  it("version: the same key on a retry after a 5xx, a new key after a 4xx", async () => {
    answer(VALID, [refusal(503, "SERVICE_UNAVAILABLE"), refusal(409, "CONFLICT", "template_archived"), created(true)]);
    const { tree, sets } = editor();
    for (let i = 0; i < 3; i++) await click(tree, t.editor.save);
    const keys = sent(VERSIONS_URL).map((s) => s.headers["Idempotency-Key"]);
    expect(keys).toHaveLength(3);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
    expect(sets).toContainEqual([2, t.reasons.template_archived]);
  });

  it("version: a VALIDATION_ERROR asks the server again, so the located issues show", async () => {
    answer(VALID, [refusal(400, "VALIDATION_ERROR")]);
    const { tree } = editor();
    await click(tree, t.editor.save);
    expect(sent("/api/admin/app-templates/validate")).toHaveLength(2);
  });

  it("speaks Italian", () => {
    const out = html(itMsgs, editor(CREATE, {}, itMsgs).tree);
    expect(out).toContain(itMsgs.admin.appTemplates.editor.saveCreate);
    expect(out).toContain(itMsgs.admin.appTemplates.editor.syntaxOk);
    expect(out).toContain(itMsgs.admin.appTemplates.editor.slugHint);
  });

  it("the editor files inject no markup and keep nothing in browser storage", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = path.resolve(__dirname, "../src");
    for (const f of [
      "components/admin/app-template-editor.tsx",
      "app/admin/templates/apps/new/page.tsx",
      "app/admin/templates/apps/[templateId]/edit/page.tsx",
    ]) {
      const text = fs.readFileSync(path.join(src, f), "utf8");
      expect(text, f).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML/);
      expect(text, f).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
    }
  });
});

// ---------------------------------------------------------------- pages

describe("application template editor pages", () => {
  const version = (id: string, n: number, over: Partial<AdminAppTemplateVersionDto> = {}): AdminAppTemplateVersionDto =>
    ({
      id,
      templateId: "atpl_notes",
      versionNumber: n,
      specHash: "a".repeat(64),
      createdAt: NOW,
      source: `# notes v${n}\nservices: {}\n`,
      valid: true,
      issues: [],
      parameters: [],
      preview: null,
      ...over,
    }) as AdminAppTemplateVersionDto;
  const detail = (over: Partial<AdminAppTemplateDetailDto> = {}): AdminAppTemplateDetailDto =>
    ({
      id: "atpl_notes",
      slug: "notes",
      name: "Notes",
      category: "productivity",
      description: null,
      builtIn: false,
      enabled: true,
      archivedAt: null,
      state: "published",
      defaultVersionId: "atv_notes_2",
      defaultVersionNumber: 2,
      installations: 1,
      componentCount: 1,
      hasIngress: true,
      hasVolumes: false,
      updatedAt: NOW,
      createdAt: NOW,
      versions: [
        { id: "atv_notes_2", versionNumber: 2, specHash: "a".repeat(64), createdAt: NOW, installations: 1 },
        { id: "atv_notes_1", versionNumber: 1, specHash: "b".repeat(64), createdAt: NOW, installations: 0 },
      ],
      ...over,
    }) as AdminAppTemplateDetailDto;
  const envelope = (data: unknown) => ({ ok: true, status: 200, data: { data } });
  const failed = (status: number, code?: string) => ({ ok: false, status, data: null, error: code ? { error: { code } } : null });
  const route = (over: Record<string, unknown> = {}) => {
    const table: Record<string, unknown> = {
      "v1/me": envelope({ platformCapabilities: { applicationTemplatesAvailable: true } }),
      "v1/admin/app-templates/atpl_notes": envelope(detail()),
      "v1/admin/app-templates/atpl_notes/versions/atv_notes_2": envelope(version("atv_notes_2", 2)),
      "v1/admin/app-templates/atpl_notes/versions/atv_notes_1": envelope(version("atv_notes_1", 1)),
      ...over,
    };
    fetchUpstream.mockImplementation(async (path: string) => table[path] ?? failed(404));
  };
  const paths = () => fetchUpstream.mock.calls.map((c) => c[0]);
  const render = async (node: Promise<ReactElement>, m: Messages = en) => html(m, await node);
  const editPage = (query: { version?: string | string[] } = {}, templateId = "atpl_notes") =>
    EditAppTemplatePage({ params: Promise.resolve({ templateId }), searchParams: Promise.resolve(query) });

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
    await expect(NewAppTemplatePage()).rejects.toThrow("REDIRECT:/login");
    await expect(editPage()).rejects.toThrow("REDIRECT:/login");
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("new: the create editor seeded with the starter, after the capability read alone", async () => {
    const out = await render(NewAppTemplatePage());
    expect(paths()).toEqual(["v1/me"]);
    expect(out).toMatch(new RegExp(`<h1[^>]*>${t.create}</h1>`));
    expect(out).toContain('href="/admin/templates"');
    expect(out).toContain(t.back);
    expect(out).toContain('id="app-template-slug"');
    expect(out).toContain("# HCP-STACK/v1");
    expect(out).toContain(t.editor.syntaxOk);
  });

  it("edit: loads the template and its default version, and seeds that source", async () => {
    const out = await render(editPage());
    expect(paths()).toEqual(["v1/me", "v1/admin/app-templates/atpl_notes", "v1/admin/app-templates/atpl_notes/versions/atv_notes_2"]);
    expect(out).toMatch(/<h1[^>]*>Notes<\/h1>/);
    expect(out).toContain(format(t.versionLabel, { n: 2 }));
    expect(out).toContain(">notes<");
    expect(out).toContain('href="/admin/templates"');
    expect(out).toContain(t.back);
    expect(out).toContain("# notes v2");
    expect(out).toContain(t.editor.makeDefault);
    expect(out).not.toContain('id="app-template-slug"');
    expect(out).not.toContain(t.editor.storedInvalid);
  });

  it("edit?version=: seeds the source of that version", async () => {
    const out = await render(editPage({ version: "atv_notes_1" }));
    expect(paths()).toEqual(["v1/me", "v1/admin/app-templates/atpl_notes", "v1/admin/app-templates/atpl_notes/versions/atv_notes_1"]);
    expect(out).toContain("# notes v1");
    expect(out).not.toContain("# notes v2");
  });

  it("edit: without a default version it starts from the newest one", async () => {
    route({ "v1/admin/app-templates/atpl_notes": envelope(detail({ defaultVersionId: null, defaultVersionNumber: null })) });
    await render(editPage({ version: ["x", "y"] }));
    expect(paths()).toEqual(["v1/me", "v1/admin/app-templates/atpl_notes", "v1/admin/app-templates/atpl_notes/versions/atv_notes_2"]);
  });

  it("edit: a stored version that no longer passes shows the warning and its issues above the editor", async () => {
    route({
      "v1/admin/app-templates/atpl_notes/versions/atv_notes_2": envelope(
        version("atv_notes_2", 2, { valid: false, issues: [issue({ line: 3, column: 5, path: "services.web" })] }),
      ),
    });
    const out = await render(editPage());
    expect(out).toContain(t.editor.storedInvalid);
    expect(out).toContain("<li>Line 3, column 5 · services.web · IMAGE_DIGEST_REQUIRED · msg</li>");
    expect(out.indexOf(t.editor.storedInvalid)).toBeLessThan(out.indexOf('id="app-template-source"'));
  });

  it("edit: an archived template opens read-only", async () => {
    route({ "v1/admin/app-templates/atpl_notes": envelope(detail({ archivedAt: NOW, enabled: false, state: "archived" })) });
    const out = await render(editPage());
    expect(out).toContain(t.editor.archived);
    expect(out).toMatch(/<textarea[^>]*readOnly=""/);
  });

  it("edit: a missing template is notFound(); a failed load is the load error; the flag off is the notice", async () => {
    await expect(editPage({}, "atpl_missing")).rejects.toThrow("NOT_FOUND");
    expect(notFound).toHaveBeenCalledTimes(1);
    notFound.mockReset();

    route({ "v1/admin/app-templates/atpl_notes": failed(500) });
    expect(await render(editPage())).toContain(en.shell.loadErrorTitle);
    route({ "v1/admin/app-templates/atpl_notes/versions/atv_notes_2": failed(404) });
    expect(await render(editPage())).toContain(en.shell.loadErrorTitle);
    expect(notFound).not.toHaveBeenCalled();

    route({ "v1/admin/app-templates/atpl_notes": failed(422, "NOT_SUPPORTED") });
    const out = await render(editPage());
    expect(out).toContain(t.notAvailable);
    expect(out).not.toContain('id="app-template-source"');
  });

  it("edit: an id that is not one path segment is notFound() without a template read", async () => {
    await expect(editPage({}, "a/b")).rejects.toThrow("NOT_FOUND");
    expect(paths()).toEqual(["v1/me"]);
  });

  it.each([
    ["flag off", envelope({ platformCapabilities: { applicationTemplatesAvailable: false } })],
    ["flag absent", envelope({ platformCapabilities: {} })],
    ["/v1/me failure", failed(500)],
  ])("%s: both pages show the notice instead of the editor, after the capability read alone", async (_name, me) => {
    for (const page of [() => NewAppTemplatePage(), () => editPage()]) {
      fetchUpstream.mockClear();
      route({ "v1/me": me });
      const out = await render(page());
      expect(paths()).toEqual(["v1/me"]);
      expect(out).toContain(t.notAvailable);
      expect(out).toContain('role="status"');
      expect(out).not.toContain('id="app-template-source"');
      expect(out).not.toContain("<button");
    }
  });

  it("both pages speak Italian", async () => {
    getRequestLocale.mockResolvedValue("it");
    expect(await render(NewAppTemplatePage(), itMsgs)).toContain(itMsgs.admin.appTemplates.create);
    const out = await render(editPage(), itMsgs);
    expect(out).toContain(itMsgs.admin.appTemplates.back);
    expect(out).toContain(itMsgs.admin.appTemplates.editor.save);
  });
});
