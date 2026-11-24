import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppStackPreview, AppTemplateValidationDto, ComposeImportDto, ComposeImportNoteDto } from "@hosting-panel/contracts";
import { format, type Messages } from "@/i18n";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { I18nProvider } from "@/i18n/provider";

const fetchUpstream = vi.fn();
const getServerSession = vi.fn();
const getRequestLocale = vi.fn();
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
  useRouter: () => router,
  usePathname: () => "/admin/templates/apps/import",
}));

import ImportAppTemplatePage from "@/app/admin/templates/apps/import/page";
import {
  AppTemplateComposeImport,
  canImportCompose,
  composeImportBody,
  composeImportRefusalText,
  composeNoteText,
  composeReportGroups,
  composeTooLarge,
} from "@/components/admin/app-template-compose-import";
import { AppTemplateEditor } from "@/components/admin/app-template-editor";

const IMPORT_URL = "/api/admin/app-templates/import-compose";
const COMPOSE = "services:\n  web:\n    image: nginx:1.27\n";
const DRAFT = "# HCP-STACK/v2\nx-hp-stack:\n  schemaVersion: 2\n  name: Notes\nservices:\n  web:\n    expose:\n      - 8080\n";
const t = en.admin.appTemplates;
const i = t.importer;

const note = (level: ComposeImportNoteDto["level"], code: string, path = "", message = "msg"): ComposeImportNoteDto => ({ level, code, path, message });
const REPORT: ComposeImportNoteDto[] = [
  note("info", "IMAGE_DIGEST_KEPT", "services.db.image", "kept"),
  note("changed", "IMAGE_PINNED", "services.web.image", "pinned"),
  note("dropped", "KEY_DROPPED", "services.web.restart", "left out"),
  note("changed", "SECRET_GENERATED", "services.db.environment.DB_PASSWORD", "generated"),
];
const PREVIEW = { components: [{ key: "web", profile: "standard" }], volumes: [], ingress: [] } as unknown as AppStackPreview;
const VALID: AppTemplateValidationDto = {
  valid: true,
  issues: [],
  parameters: [
    { key: "db_password", label: "Database password", type: "secret", required: true, customer: false, generate: { kind: "password", length: 32 } },
  ],
  preview: PREVIEW,
};
const INVALID: AppTemplateValidationDto = {
  valid: false,
  issues: [{ path: "services.web.image", code: "IMAGE_DIGEST_REQUIRED", reason: "STACK_IMAGE_NOT_ALLOWED", message: "no digest" }],
  parameters: [],
  preview: null,
};
const DRAFTED: ComposeImportDto = { source: DRAFT, report: REPORT, validation: VALID };
const REFUSED: ComposeImportDto = {
  source: null,
  report: [note("changed", "IMAGE_PINNED", "services.db.image", "pinned"), note("refused", "IMAGE_UNRESOLVED", "services.web.image", "The registry does not know this image.")],
  validation: null,
};

const wrap = (m: Messages, node: ReactNode) => createElement(I18nProvider, { locale: m === en ? "en" : "it", messages: m, children: node });
const html = (m: Messages, node: ReactNode) =>
  renderToStaticMarkup(wrap(m, node)).replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const disabledButton = (label: string) => new RegExp(`<button[^>]*\\sdisabled=""[^>]*>[^<]*${label}`);

// Calls the client component once with stand-in hooks; `over` forces the value of a state slot (by call order):
// 0 compose, 1 name, 2 category, 3 busy, 4 error, 5 answer.
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
  return (button.props.onClick as () => Promise<void> | void)();
};
const importer = (over: Record<number, unknown> = {}, m: Messages = en) => callHooks(AppTemplateComposeImport, { csrfToken: "csrf" }, m, over);

const fetchMock = vi.fn();
const answer = (status: number, body: unknown) =>
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
const refusal = (code: string, reason?: string) => ({ error: { code, message: "x", details: reason ? [{ message: "x", reason }] : [] } });

// ---------------------------------------------------------------- pure helpers

describe("the report of an import", () => {
  it("a note reads path, code and message; a note about the whole file has no path", () => {
    expect(composeNoteText(note("changed", "IMAGE_PINNED", "services.web.image", "pinned"))).toBe("services.web.image · IMAGE_PINNED · pinned");
    expect(composeNoteText(note("info", "REPORT_TRUNCATED", "", "12 more"))).toBe("REPORT_TRUNCATED · 12 more");
  });

  it("groups by level, most serious first, each level in the importer's order, and leaves an empty level out", () => {
    const groups = composeReportGroups([...REPORT, note("refused", "IMAGE_UNRESOLVED", "services.x.image")]);
    expect(groups.map((g) => [g.level, g.notes.map((n) => n.code)])).toEqual([
      ["refused", ["IMAGE_UNRESOLVED"]],
      ["dropped", ["KEY_DROPPED"]],
      ["changed", ["IMAGE_PINNED", "SECRET_GENERATED"]],
      ["info", ["IMAGE_DIGEST_KEPT"]],
    ]);
    expect(composeReportGroups(REPORT).map((g) => g.level)).toEqual(["dropped", "changed", "info"]);
    expect(composeReportGroups([])).toEqual([]);
  });
});

describe("what can be imported", () => {
  it("the file is bounded at 64 KiB of UTF-8, like the API's contract", () => {
    expect(composeTooLarge("x".repeat(65_536))).toBe(false);
    expect(composeTooLarge("x".repeat(65_537))).toBe(true);
    expect(composeTooLarge("è".repeat(32_768))).toBe(false);
    expect(composeTooLarge("è".repeat(32_769))).toBe(true);
  });

  it("needs a non-blank file within the bound, and no request out", () => {
    expect(canImportCompose({ compose: COMPOSE, busy: false })).toBe(true);
    expect(canImportCompose({ compose: COMPOSE, busy: true })).toBe(false);
    expect(canImportCompose({ compose: "", busy: false })).toBe(false);
    expect(canImportCompose({ compose: " \n\t ", busy: false })).toBe(false);
    expect(canImportCompose({ compose: "x".repeat(65_537), busy: false })).toBe(false);
  });

  it("sends the file as pasted; a blank name and the «from the file» category are not sent", () => {
    expect(composeImportBody({ compose: COMPOSE, name: "", category: "" })).toEqual({ compose: COMPOSE });
    expect(composeImportBody({ compose: COMPOSE, name: "  \t ", category: "" })).toEqual({ compose: COMPOSE });
    expect(composeImportBody({ compose: COMPOSE, name: "  My\nnotes ", category: "productivity" })).toEqual({
      compose: COMPOSE,
      name: "My notes",
      category: "productivity",
    });
    expect(Object.keys(composeImportBody({ compose: COMPOSE, name: "", category: "" }))).toEqual(["compose"]);
  });
});

describe("why an import gave no report", () => {
  it.each([
    ["en", en],
    ["it", itMsgs],
  ] as const)("says the lookup failed, that no answer came, or the application reason (%s)", (_l, m) => {
    const texts = m.admin.appTemplates;
    expect(composeImportRefusalText(m, 503, "DOCKER_ENGINE_UNAVAILABLE")).toBe(texts.importer.lookupFailed);
    expect(composeImportRefusalText(m, 504, "INTERNAL_ERROR")).toBe(texts.importer.noAnswer);
    expect(composeImportRefusalText(m, 502, "OPERATION_AMBIGUOUS")).toBe(texts.importer.noAnswer);
    expect(composeImportRefusalText(m, 422, "NOT_SUPPORTED")).toBe(texts.notAvailable);
    expect(composeImportRefusalText(m, 500, "INTERNAL_ERROR")).toBe(m.errors.INTERNAL_ERROR);
    expect(composeImportRefusalText(m, 400, "VALIDATION_ERROR")).toBe(m.errors.VALIDATION_ERROR);
    expect(composeImportRefusalText(m, 403, "")).toBe(m.errors.generic);
  });

  it("the texts that say nothing was saved say so in both languages", () => {
    for (const key of ["lookupFailed", "noAnswer"] as const) {
      expect(en.admin.appTemplates.importer[key]).toMatch(/Nothing was saved/);
      expect(itMsgs.admin.appTemplates.importer[key]).toMatch(/Non è stato salvato nulla/);
    }
  });
});

// ---------------------------------------------------------------- the component

describe("AppTemplateComposeImport", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    router.push.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("first shows the file field with its hint, the optional name and category, and a disabled Import", () => {
    const { tree } = importer();
    const out = html(en, tree);
    expect(out).toMatch(/<label[^>]*for="compose-import-file"/);
    expect(out).toContain(i.composeHint);
    expect(out).toMatch(/id="compose-import-name"[^>]*maxLength="80"/);
    expect(out).toContain(i.nameHint);
    expect(out).toMatch(disabledButton(i.run));
    expect(out).not.toContain(i.runningHint);
    expect(out).not.toContain('role="alert"');
    expect(out).not.toContain('id="app-template-source"');
    const file = els(tree).find((e) => e.props.id === "compose-import-file")!;
    expect(file.props).toMatchObject({ value: "", label: i.compose, describedBy: "compose-import-file-hint", readOnly: false });
  });

  it("the category is «from the file» unless the administrator picks one of the known ones", () => {
    const select = els(importer().tree).find((e) => e.props.id === "compose-import-category")!;
    expect(select.type).toBe("select");
    expect(select.props.value).toBe("");
    const options = els(select.props.children).filter((e) => e.type === "option");
    expect(options.map((o) => [o.props.value, textOf(o)])).toEqual([["", i.categoryFromFile], ...Object.entries(t.category)]);
  });

  it("a file over the bound says so and cannot be imported", () => {
    const { tree } = importer({ 0: "x".repeat(65_537) });
    const out = html(en, tree);
    expect(out).toMatch(new RegExp(`id="compose-import-file-error"[^>]*role="alert"[^>]*>${i.tooLarge}`));
    expect(out).toMatch(disabledButton(i.run));
    expect(els(tree).find((e) => e.props.id === "compose-import-file")!.props.describedBy).toBe("compose-import-file-hint compose-import-file-error");
  });

  it("while the request is out the fields are locked and the page says why it takes time", () => {
    const { tree } = importer({ 0: COMPOSE, 3: true });
    const out = html(en, tree);
    expect(out).toMatch(disabledButton(i.running));
    expect(out).toMatch(new RegExp(`role="status"[^>]*>${i.runningHint}`));
    const all = els(tree);
    expect(all.find((e) => e.props.id === "compose-import-file")!.props.readOnly).toBe(true);
    expect(all.find((e) => e.props.id === "compose-import-name")!.props.disabled).toBe(true);
    expect(all.find((e) => e.props.id === "compose-import-category")!.props.disabled).toBe(true);
  });

  it("Import posts the file with the CSRF token and no Idempotency-Key, and keeps the answer", async () => {
    answer(200, { data: DRAFTED });
    const { tree, sets } = importer({ 0: COMPOSE, 1: " Notes ", 2: "productivity" });
    await click(tree, i.run);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(IMPORT_URL);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json", "X-CSRF-Token": "csrf" });
    expect(JSON.parse(init.body as string)).toEqual({ compose: COMPOSE, name: "Notes", category: "productivity" });
    expect(sets).toEqual([[3, true], [4, null], [5, null], [5, DRAFTED], [3, false]]);
  });

  it.each([
    [503, refusal("DOCKER_ENGINE_UNAVAILABLE"), i.lookupFailed],
    [504, refusal("INTERNAL_ERROR"), i.noAnswer],
    [502, refusal("OPERATION_AMBIGUOUS"), i.noAnswer],
    [422, refusal("NOT_SUPPORTED", "STACK_UNSUPPORTED_FEATURE"), t.reasons.STACK_UNSUPPORTED_FEATURE],
    [403, refusal("PERMISSION_DENIED"), en.errors.PERMISSION_DENIED],
    [500, "not json", en.errors.generic],
    [200, { data: null }, en.errors.generic],
  ])("a %i answer keeps no report and says why", async (status, body, text) => {
    fetchMock.mockImplementation(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
    const { tree, sets } = importer({ 0: COMPOSE });
    await click(tree, i.run);
    expect(sets).toContainEqual([4, text]);
    expect(sets.some(([k, v]) => k === 5 && v !== null)).toBe(false);
    expect(sets.at(-1)).toEqual([3, false]);
  });

  it("a request that never reaches the server says the generic error and unlocks the form", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const { tree, sets } = importer({ 0: COMPOSE });
    await click(tree, i.run);
    expect(sets).toContainEqual([4, en.errors.generic]);
    expect(sets.at(-1)).toEqual([3, false]);
  });

  it("an error is shown in a role=alert under the form", () => {
    const out = html(en, importer({ 0: COMPOSE, 4: i.lookupFailed }).tree);
    expect(out).toMatch(new RegExp(`role="alert"[^>]*>[\\s\\S]*${i.lookupFailed}`));
    expect(out).not.toContain(i.refused);
  });

  it("a refused file keeps the form, lists the report with the refusals first and says what to do", () => {
    const { tree } = importer({ 0: COMPOSE, 5: REFUSED });
    const out = html(en, tree);
    expect(out).toMatch(new RegExp(`role="alert"[^>]*>[\\s\\S]*${i.refused}`));
    expect(out).toContain("<li>services.web.image · IMAGE_UNRESOLVED · The registry does not know this image.</li>");
    expect(out).toContain("<li>services.db.image · IMAGE_PINNED · pinned</li>");
    expect(out.indexOf(format(i.level.refused, { n: 1 }))).toBeGreaterThan(-1);
    expect(out.indexOf(format(i.level.refused, { n: 1 }))).toBeLessThan(out.indexOf(format(i.level.changed, { n: 1 })));
    expect(out).toContain(i.refusedHint);
    expect(out).toContain('id="compose-import-file"');
    expect(out).not.toContain('id="app-template-source"');
    expect(out).not.toContain(i.again);
  });

  it("an edit of the file drops the report and the error", () => {
    const { tree, sets } = importer({ 0: COMPOSE, 4: "old", 5: REFUSED });
    const file = els(tree).find((e) => e.props.id === "compose-import-file")!;
    (file.props.onChange as (v: string) => void)("services: {}\n");
    expect(sets).toEqual([[0, "services: {}\n"], [5, null], [4, null]]);
  });

  it("a draft continues in the template editor, seeded with the source and the server's verdict on it", () => {
    const { tree } = importer({ 0: COMPOSE, 5: DRAFTED });
    const editor = els(tree).find((e) => e.type === AppTemplateEditor)!;
    expect(editor.props).toEqual({ csrfToken: "csrf", target: { kind: "create" }, initialSource: DRAFT, initialResult: VALID });
    const out = html(en, tree);
    expect(out).toMatch(new RegExp(`role="status"[^>]*>[\\s\\S]*${i.draftReady}`));
    expect(out).not.toContain(i.draftInvalid);
    expect(out).toMatch(new RegExp(`<h2[^>]*id="compose-import-report"[^>]*>${i.report}</h2>`));
    expect(out).toMatch(new RegExp(`<h2[^>]*id="compose-import-draft"[^>]*>${i.draft}</h2>`));
    // The report, most serious first.
    const order = [format(i.level.dropped, { n: 1 }), format(i.level.changed, { n: 2 }), format(i.level.info, { n: 1 })].map((text) => out.indexOf(text));
    expect(order.every((at) => at > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(out).toContain("<li>services.db.environment.DB_PASSWORD · SECRET_GENERATED · generated</li>");
    expect(out).not.toContain(format(i.level.refused, { n: 0 }));
    // The editor: the draft, its verdict without a click, the slug and the create button.
    expect(out).toContain("# HCP-STACK/v2");
    expect(out).toContain(t.editor.valid);
    expect(out).toContain(format(t.editor.secretGenerated, { kind: "password", length: 32 }));
    expect(out).toContain('id="app-template-slug"');
    expect(out).toContain(t.editor.saveCreate);
    // The import form is gone, and nothing was sent.
    expect(out).not.toContain('id="compose-import-file"');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a draft that does not pass the checks says so and shows the issues in the editor", () => {
    const out = html(en, importer({ 0: COMPOSE, 5: { ...DRAFTED, validation: INVALID } }).tree);
    expect(out).toContain(i.draftInvalid);
    expect(out).not.toContain(i.draftReady);
    expect(out).toContain("<li>services.web.image · IMAGE_DIGEST_REQUIRED · no digest</li>");
    expect(out).not.toContain(t.editor.valid);
  });

  it("a draft with an empty report shows no report section", () => {
    const out = html(en, importer({ 5: { ...DRAFTED, report: [] } }).tree);
    expect(out).not.toContain('id="compose-import-report"');
    expect(out).toContain('id="compose-import-draft"');
  });

  it("«Import another file» drops the draft and goes back to the form, which kept the pasted file", () => {
    const { tree, sets } = importer({ 0: COMPOSE, 5: DRAFTED });
    void click(tree, i.again);
    expect(sets).toEqual([[5, null]]);
    const back = importer({ 0: COMPOSE });
    expect(els(back.tree).find((e) => e.props.id === "compose-import-file")!.props.value).toBe(COMPOSE);
  });

  it("speaks Italian", () => {
    const it_ = itMsgs.admin.appTemplates.importer;
    const form = html(itMsgs, importer({}, itMsgs).tree);
    for (const text of [it_.compose, it_.composeHint, it_.name, it_.categoryFromFile, it_.run]) expect(form).toContain(text);
    const draft = html(itMsgs, importer({ 5: DRAFTED }, itMsgs).tree);
    for (const text of [it_.draftReady, it_.report, it_.again, it_.draft, format(it_.level.changed, { n: 2 })]) expect(draft).toContain(text);
  });

  it("both languages have the same importer texts, each level with its count", () => {
    const keys = (o: object): string[] => Object.entries(o).flatMap(([k, v]) => (typeof v === "string" ? [k] : keys(v as object).map((x) => `${k}.${x}`)));
    expect(keys(en.admin.appTemplates.importer)).toEqual(keys(itMsgs.admin.appTemplates.importer));
    for (const m of [en, itMsgs]) {
      expect(Object.keys(m.admin.appTemplates.importer.level).sort()).toEqual(["changed", "dropped", "info", "refused"]);
      for (const text of Object.values(m.admin.appTemplates.importer.level)) expect(text).toContain("{n}");
    }
  });
});

// ---------------------------------------------------------------- the page

describe("the Compose import page", () => {
  const me = (on: boolean) => ({ ok: true, status: 200, data: { data: { platformCapabilities: { applicationTemplatesAvailable: on } } } });
  const render = async (m: Messages = en) => html(m, await ImportAppTemplatePage());

  beforeEach(() => {
    fetchUpstream.mockReset();
    getServerSession.mockReset();
    getRequestLocale.mockReset();
    getServerSession.mockResolvedValue({ accessToken: "tok", csrfToken: "csrf" });
    getRequestLocale.mockResolvedValue("en");
    fetchUpstream.mockImplementation(async () => me(true));
  });

  it("redirects to /login without a session, before any upstream call", async () => {
    getServerSession.mockResolvedValue(null);
    await expect(ImportAppTemplatePage()).rejects.toThrow("REDIRECT:/login");
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("shows the title, what the import does, the way back and the form, after the capability read alone", async () => {
    const out = await render();
    expect(fetchUpstream.mock.calls.map((c) => c[0])).toEqual(["v1/me"]);
    expect(out).toMatch(new RegExp(`<h1[^>]*>${i.title}</h1>`));
    expect(out).toContain(i.subtitle);
    expect(out).toContain('href="/admin/templates"');
    expect(out).toContain(t.back);
    expect(out).toContain('id="compose-import-file"');
    expect(out).toMatch(disabledButton(i.run));
  });

  it.each([
    ["the flag is off", () => fetchUpstream.mockImplementation(async () => me(false))],
    ["the capability read fails", () => fetchUpstream.mockImplementation(async () => ({ ok: false, status: 500, data: null, error: null }))],
  ])("says the feature is not active and shows no form when %s", async (_name, arrange) => {
    arrange();
    const out = await render();
    expect(out).toMatch(new RegExp(`role="status"[^>]*>[\\s\\S]*${t.notAvailable.replace(/[()]/g, "\\$&")}`));
    expect(out).not.toContain("<textarea");
    expect(out).not.toContain(i.run);
  });

  it("speaks Italian", async () => {
    getRequestLocale.mockResolvedValue("it");
    const out = await render(itMsgs);
    expect(out).toContain(itMsgs.admin.appTemplates.importer.title);
    expect(out).toContain(itMsgs.admin.appTemplates.importer.subtitle);
  });
});
