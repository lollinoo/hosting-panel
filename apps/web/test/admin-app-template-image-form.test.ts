import { beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { APP_IMAGE_ALLOWLIST, parseTemplateYaml } from "@hosting-panel/contracts";
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
vi.mock("@/lib/server-session", () => ({ getServerSession: (...args: unknown[]) => getServerSession(...args) }));
vi.mock("@/i18n/server", () => ({ getRequestLocale: (...args: unknown[]) => getRequestLocale(...args) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  useRouter: () => router,
  usePathname: () => "/admin/templates/apps/new/image",
}));

import NewAppTemplateFromImagePage from "@/app/admin/templates/apps/new/image/page";
import { AppTemplateEditor } from "@/components/admin/app-template-editor";
import {
  AppTemplateImageForm,
  appImageFormInput,
  emptyAppImageForm,
  type AppImageFormFields,
} from "@/components/admin/app-template-image-form";

// ADR-0043: the one-image form of the administrator. It writes a template source and opens it in the usual editor; it
// saves nothing and calls nothing.

const DIGEST = `sha256:${"c".repeat(64)}`;
const REPOSITORIES = ["valkey/valkey", "memcached"];
const CATEGORIES = ["web", "jobs"];
const t = en.admin.appTemplates.imageForm;
const props = { csrfToken: "csrf", repositories: REPOSITORIES, categories: CATEGORIES };

const html = (m: Messages, node: ReactNode) =>
  renderToStaticMarkup(createElement(I18nProvider, { locale: m === en ? "en" : "it", messages: m, children: node }))
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

const internals = (React as unknown as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE!;
/** Calls a client component once with stand-in hooks; `over` forces the value of a state slot (by call order). */
function callHooks<P>(C: (p: P) => ReactNode, p: P, m: Messages = en, over: Record<number, unknown> = {}) {
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
    return { tree: C(p), sets };
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
const byId = (tree: unknown, id: string) => {
  const found = els(tree).find((e) => e.props.id === id);
  if (!found) throw new Error(`no element ${id}`);
  return found;
};
const click = (tree: unknown, label: string) => {
  const button = els(tree).find((e) => typeof e.props.onClick === "function" && textOf(e) === label);
  if (!button) throw new Error(`no button ${label}`);
  (button.props.onClick as () => void)();
};
const submit = (tree: unknown) => (els(tree).find((e) => e.type === "form")!.props.onSubmit as (e: unknown) => void)({ preventDefault() {} });

const FILLED: AppImageFormFields = {
  ...emptyAppImageForm("valkey/valkey", "jobs"),
  name: "  Key-value store ",
  description: " A small store. ",
  tag: " 9.2.0 ",
  digest: ` ${DIGEST} `,
  port: " 6379 ",
  health: "tcp",
  settings: [
    { kind: "fixed", name: " APP_MODE ", value: " keep spaces ", label: "", required: true },
    { kind: "customer", name: "SITE_TITLE", value: "My store", label: " Title ", required: true },
    { kind: "private", name: "ADMIN_KEY_FILE", value: "ignored", label: "Key", required: false },
  ],
  dataPath: " /data ",
  cpus: " 0.25 ",
  memoryMb: " 128 ",
};

beforeEach(() => {
  vi.clearAllMocks();
  getRequestLocale.mockResolvedValue("en");
  getServerSession.mockResolvedValue({ accessToken: "tok", csrfToken: "csrf" });
  fetchUpstream.mockResolvedValue({ ok: true, status: 200, data: { data: { platformCapabilities: { applicationTemplatesAvailable: true } } } });
});

describe("appImageFormInput", () => {
  it("reads the typed fields: trimmed names, an empty box as none, numbers as numbers", () => {
    expect(appImageFormInput(FILLED)).toEqual({
      name: "Key-value store",
      category: "jobs",
      description: "A small store.",
      componentKey: "app",
      repository: "valkey/valkey",
      tag: "9.2.0",
      digest: DIGEST,
      port: 6379,
      webAddress: false,
      health: { kind: "tcp" },
      settings: [
        { kind: "fixed", name: "APP_MODE", value: " keep spaces " },
        { kind: "customer", name: "SITE_TITLE", label: "Title", default: "My store" },
        { kind: "private", name: "ADMIN_KEY_FILE", label: "Key", required: false },
      ],
      dataPath: "/data",
      cpuMilli: 250,
      memoryMb: 128,
    });
    const empty = appImageFormInput(emptyAppImageForm("memcached", "web"));
    expect(empty).toMatchObject({ tag: null, port: null, dataPath: null, health: { kind: "none" }, settings: [], cpuMilli: 500, memoryMb: 256 });
    expect(appImageFormInput({ ...FILLED, health: "http", healthPath: " /healthz " }).health).toEqual({ kind: "http", path: "/healthz" });
  });

  it("turns what is not a number into something the writer refuses, never into another number", () => {
    for (const port of ["80a", "-1", "8 0", "1e3", "0x50", "80.0"]) expect(appImageFormInput({ ...FILLED, port }).port, port).toBeNaN();
    for (const cpus of ["", "half", "0,5", "1e1", ".5", "0.2500", "-1"]) expect(appImageFormInput({ ...FILLED, cpus }).cpuMilli, cpus).toBeNaN();
    for (const memoryMb of ["", "64.5", "1G", "-64"]) expect(appImageFormInput({ ...FILLED, memoryMb }).memoryMb, memoryMb).toBeNaN();
    expect(appImageFormInput({ ...FILLED, cpus: "16" }).cpuMilli).toBe(16_000);
    expect(appImageFormInput({ ...FILLED, cpus: "0.125" }).cpuMilli).toBe(125);
  });
});

describe("AppTemplateImageForm", () => {
  it("has a labelled control for every field, offers only the given images and categories, and no save button", () => {
    const h = html(en, callHooks(AppTemplateImageForm, props).tree);
    for (const id of ["name", "category", "description", "repository", "tag", "digest", "port", "web", "health", "data", "cpus", "memory"]) {
      expect(h, id).toMatch(new RegExp(`<label[^>]*for="image-form-${id}"`));
      expect(h, id).toMatch(new RegExp(`id="image-form-${id}"`));
    }
    expect([...h.matchAll(/<option value="([^"]*)"/g)].map((x) => x[1])).toEqual([...CATEGORIES, ...REPOSITORIES, "none", "tcp", "http"]);
    expect(h).toContain(t.intro);
    expect(h).toContain(t.write);
    expect(h).toContain(t.setting.add);
    // The editor's buttons (validate, save) are not here: the form only writes.
    expect([...h.matchAll(/<button[^>]*>([^<]*)</g)].map((x) => x[1])).toEqual([t.setting.add, t.write]);
    expect(h).toMatch(/aria-describedby="image-form-digest-hint"/);
    // The Italian page has every label too.
    const it = html(itMsgs, callHooks(AppTemplateImageForm, props, itMsgs).tree);
    for (const text of [itMsgs.admin.appTemplates.imageForm.write, itMsgs.admin.appTemplates.imageForm.digest]) expect(it).toContain(text);
  });

  it("shows the rows of the settings by kind: a label for the customer's ones, no value box for a private one", () => {
    const h = html(en, callHooks(AppTemplateImageForm, props, en, { 0: FILLED }).tree);
    for (const i of [0, 1, 2]) {
      expect(h).toMatch(new RegExp(`<label[^>]*for="image-form-setting-${String(i)}-name"`));
      expect(h).toContain(format(t.setting.remove, { n: i + 1 }));
    }
    expect(h).not.toMatch(/id="image-form-setting-0-label"/);
    expect(h).toMatch(/id="image-form-setting-0-value"/);
    expect(h).toMatch(/id="image-form-setting-1-label"/);
    expect(h).toMatch(/id="image-form-setting-1-value"/);
    expect(h).toMatch(/id="image-form-setting-2-label"/);
    expect(h).not.toMatch(/id="image-form-setting-2-value"/);
    expect(h).toMatch(/id="image-form-setting-2-required"/);
    expect(h).toContain(t.setting.privateHint);
    // The value typed for a private setting is never rendered: the form does not take one.
    expect(h).not.toContain("ignored");
  });

  it("edits one field at a time; ticking the web address proposes a page check", () => {
    const { tree, sets } = callHooks(AppTemplateImageForm, props, en, { 0: FILLED });
    (byId(tree, "image-form-name").props.onChange as (e: unknown) => void)({ target: { value: "Other" } });
    expect(sets.at(-1)).toEqual([0, { ...FILLED, name: "Other" }]);
    (byId(tree, "image-form-setting-1-name").props.onChange as (e: unknown) => void)({ target: { value: "TITLE" } });
    expect((sets.at(-1)![1] as AppImageFormFields).settings[1]).toMatchObject({ kind: "customer", name: "TITLE", label: " Title " });
    click(tree, format(t.setting.remove, { n: 1 }));
    expect((sets.at(-1)![1] as AppImageFormFields).settings.map((s) => s.kind)).toEqual(["customer", "private"]);
    click(tree, t.setting.add);
    expect((sets.at(-1)![1] as AppImageFormFields).settings).toHaveLength(4);

    const none = callHooks(AppTemplateImageForm, props, en, { 0: { ...FILLED, health: "none" } });
    (byId(none.tree, "image-form-web").props.onChange as (e: unknown) => void)({ target: { checked: true } });
    expect(none.sets.at(-1)![1]).toMatchObject({ webAddress: true, health: "http" });
  });

  it("names the wrong fields in words and writes nothing", () => {
    const wrong = { ...FILLED, name: "", digest: "sha256:abc", port: "70000", webAddress: true, health: "none" as const };
    const { tree, sets } = callHooks(AppTemplateImageForm, props, en, { 0: wrong });
    submit(tree);
    expect(sets).toEqual([
      [
        1,
        [
          { field: "name", code: "name" },
          { field: "digest", code: "digest" },
          { field: "port", code: "port" },
          { field: "health", code: "web_needs_health" },
        ],
      ],
    ]);
    const h = html(en, callHooks(AppTemplateImageForm, props, en, { 0: wrong, 1: sets[0]![1] }).tree);
    for (const code of ["name", "digest", "port", "web_needs_health"] as const) expect(h).toContain(t.problem[code]);
    expect(h).toContain(t.fix);
    expect(h).toMatch(/id="image-form-digest"[^>]*aria-invalid="true"|aria-invalid="true"[^>]*id="image-form-digest"/);
    expect(h.match(/role="alert"/g)!.length).toBeGreaterThanOrEqual(5);
  });

  it("writes the source and hands it to the usual editor; going back keeps the fields", () => {
    const { tree, sets } = callHooks(AppTemplateImageForm, props, en, { 0: FILLED });
    submit(tree);
    expect(sets[0]).toEqual([1, []]);
    const [slot, source] = sets[1] as [number, string];
    expect(slot).toBe(2);
    expect(parseTemplateYaml(source).ok).toBe(true);
    expect(source).toContain(`image: valkey/valkey:9.2.0@${DIGEST}`);
    expect(source).toContain("- 6379");
    expect(source).toContain('value: " keep spaces "');
    expect(source).not.toContain("ignored");

    const written = callHooks(AppTemplateImageForm, props, en, { 0: FILLED, 2: source });
    const editor = els(written.tree).find((e) => e.type === AppTemplateEditor);
    expect(editor?.props).toEqual({ csrfToken: "csrf", target: { kind: "create" }, initialSource: source });
    expect(els(written.tree).some((e) => e.type === "form")).toBe(false);
    click(written.tree, t.backToForm);
    expect(written.sets).toEqual([[2, null]]);
  });

  it("with no allowed image it says so and shows no form", () => {
    const h = html(en, callHooks(AppTemplateImageForm, { ...props, repositories: [] }).tree);
    expect(h).toContain(t.noSoftware);
    expect(h).not.toContain("<form");
  });

  it("the form itself calls nothing: no fetch, no navigation", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { tree } = callHooks(AppTemplateImageForm, props, en, { 0: FILLED });
    submit(tree);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("the page of a new template from an image", () => {
  const page = async () => html(en, await NewAppTemplateFromImagePage());

  it("offers the panel's own allowlist and the known categories, and reads only the capability", async () => {
    const tree = await NewAppTemplateFromImagePage();
    const form = els(tree).find((e) => e.type === AppTemplateImageForm);
    expect(form?.props).toEqual({
      csrfToken: "csrf",
      repositories: APP_IMAGE_ALLOWLIST.map((row) => row.repository),
      categories: Object.keys(en.admin.appTemplates.category),
    });
    expect(fetchUpstream.mock.calls.map((c) => c[0])).toEqual(["v1/me"]);
    expect(await page()).toContain(t.title);
  });

  it("without a session it goes to the login; with the capability off it shows the notice and no form", async () => {
    getServerSession.mockResolvedValueOnce(null);
    await expect(NewAppTemplateFromImagePage()).rejects.toThrow("REDIRECT:/login");
    fetchUpstream.mockResolvedValue({ ok: true, status: 200, data: { data: { platformCapabilities: { applicationTemplatesAvailable: false } } } });
    const off = await page();
    expect(off).toContain(en.admin.appTemplates.notAvailable);
    expect(off).not.toContain(t.write);
  });
});

describe("the files of the form", () => {
  it("inject no markup, keep nothing in the browser, call no route and mint no key", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = path.resolve(__dirname, "../src");
    for (const f of ["components/admin/app-template-image-form.tsx", "app/admin/templates/apps/new/image/page.tsx"]) {
      const text = fs.readFileSync(path.join(src, f), "utf8");
      expect(text, f).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML/);
      expect(text, f).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
      expect(text, f).not.toMatch(/\bfetch\s*\(|keyedSend|randomUUID|\/api\//);
    }
    // The menu entry sits with the other "new application template" entry, shown only where templates are offered.
    const menu = fs.readFileSync(path.join(src, "app/admin/templates/page.tsx"), "utf8");
    const offered = menu.slice(menu.indexOf("{appsOffer ? ("), menu.indexOf(") : ("));
    expect(offered).toContain('href="/admin/templates/apps/new/image"');
    expect(menu.split('href="/admin/templates/apps/new/image"')).toHaveLength(2);
  });
});
