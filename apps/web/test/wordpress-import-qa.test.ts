import fs from "node:fs";
import path from "node:path";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OPERATION_STATUSES,
  SiteWordpressImportDtoSchema,
  WORDPRESS_IMPORT_LEFT_OUT,
  WORDPRESS_IMPORT_OUTCOMES,
  WORDPRESS_IMPORT_REASONS,
  WORDPRESS_IMPORT_REFUSALS,
  WORDPRESS_IMPORT_STEP_KEYS,
  type SiteWordpressImportDto,
} from "@hosting-panel/contracts";

// Hook stand-in (as in site-wordpress-qa): while a slot is active a component runs as a plain function.
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

vi.mock("next/navigation", () => ({
  usePathname: () => "/sites/s1/wordpress/import",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));

import { format, type Messages } from "@/i18n";
import { en } from "@/i18n/en";
import { it as itCatalog } from "@/i18n/it";
import { I18nProvider } from "@/i18n/provider";
import { fileErrorText, formatDate, uploadFile, type ChunkSender } from "@/lib/file-browser";
import { prepareQueuedUploads, UploadList, useUploadQueue, type UploadItem } from "@/components/customer/file-uploads";
import { ImportConfirmView, WordpressImport, importErrorText } from "@/components/customer/wordpress-import";
import { WordpressImportCard } from "@/components/customer/wordpress-import-card";
import { encryptSession, SESSION_COOKIE_NAME, type SessionData } from "../src/lib/session";
import { GET as getImport, POST as postImport } from "../src/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/wordpress/import/route";
import { DELETE as deleteFiles } from "../src/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/wordpress/import/files/route";
import { PUT as putChunk } from "../src/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/wordpress/import/files/[slot]/route";
import { POST as postPick } from "../src/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/wordpress/import/files/[slot]/pick/route";

type Locale = "en" | "it";
type Op = NonNullable<SiteWordpressImportDto["runningOperation"]>;
type Last = NonNullable<SiteWordpressImportDto["lastImport"]>;
const CATALOG: Record<Locale, Messages> = { en, it: itCatalog };
const LOCALES: Locale[] = ["en", "it"];
const BASE = "/api/bff/orgs/o1/managed-sites/s1/wordpress/import";
const SITE_NAME = "Neutral Shop";
const BACKUPS = "/sites/s1/backups";
const HOSTILE = ["<img src=x onerror=alert(1)>", '"><script>alert(1)</script>', "javascript:alert(1)", "x".repeat(5000)];

const slotState = (state: "empty" | "partial" | "complete") =>
  state === "empty"
    ? { state, size: 0, uploadId: null }
    : state === "partial"
      ? { state, size: 4, uploadId: "upload-0123456789abcdef" }
      : { state, size: 2_048, uploadId: null };

/** A state the API could send: every fixture goes through the contract schema. */
const dto = (over: Record<string, unknown> = {}): SiteWordpressImportDto =>
  SiteWordpressImportDtoSchema.parse({
    available: true,
    backupsConfigured: true,
    slots: { archive: slotState("empty"), dump: slotState("empty") },
    earlierImportUnfinished: false,
    runningOperation: null,
    lastImport: null,
    ...over,
  });

const last = (over: Partial<Last> = {}): Last => ({
  operationId: `op_${"c".repeat(32)}`,
  finishedAt: "2026-11-15T11:00:00.000Z",
  outcome: "imported",
  reason: null,
  backup: "taken",
  oldAddress: null,
  leftOut: [],
  tables: null,
  line: null,
  errorNumber: null,
  ...over,
});

const op = (current: number, over: Partial<Op> = {}): Op => ({
  id: `op_${"d".repeat(32)}`,
  kind: "site.wordpress.import",
  status: "processing",
  steps: WORDPRESS_IMPORT_STEP_KEYS.slice(0, current + 1).map((key, i) => ({ key, status: i < current ? "succeeded" : "running" })),
  ...over,
});

const decode = (s: string) =>
  s.replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
const textOf = (html: string) => decode(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");
const textNodes = (html: string) => [...html.matchAll(/>([^<]+)</g)].map((x) => decode(x[1]!).trim()).filter(Boolean);

const render = (el: ReactElement, locale: Locale) =>
  renderToStaticMarkup(createElement(I18nProvider, { locale, messages: CATALOG[locale], children: el }));
const wizard = (initial: unknown, locale: Locale, siteName = SITE_NAME) =>
  render(createElement(WordpressImport, { basePath: BASE, siteName, initial, csrfToken: "csrf-sentinel", backupsHref: BACKUPS }), locale);
const card = (initial: SiteWordpressImportDto, locale: Locale) =>
  render(createElement(WordpressImportCard, { basePath: BASE, importHref: "/sites/s1/wordpress/import", initial }), locale);

// W4 plus the names the contract uses internally.
const W4 = /\b(docker|container|image|network|volume|service|template|job|organization|revision|drift|schema|staging|dump|slot|executor)\b/i;
const RAW_NAMES = [...WORDPRESS_IMPORT_REASONS, ...WORDPRESS_IMPORT_REFUSALS, ...WORDPRESS_IMPORT_OUTCOMES];
const UNDERSCORED = RAW_NAMES.filter((n) => n.includes("_"));
const BARE = [...RAW_NAMES.filter((n) => !n.includes("_")), ...WORDPRESS_IMPORT_STEP_KEYS];

/** The common checks every rendered state must pass; returns the problems found. */
function problems(html: string): string[] {
  const out: string[] = [];
  const text = textOf(html);
  for (const n of UNDERSCORED) if (new RegExp(`\\b${n}\\b`).test(html)) out.push(`raw name ${n}`);
  for (const node of textNodes(html)) if ((BARE as readonly string[]).includes(node)) out.push(`raw name ${node}`);
  const filler = text.match(/\{[A-Za-z]+\}|\bundefined\b|\bnull\b|\bNaN\b|\[object Object\]/);
  if (filler) out.push(`unfilled ${filler[0]}`);
  const jargon = text.match(W4);
  if (jargon) out.push(`jargon ${jargon[0]}`);
  if (/op_[0-9a-f]{32}/.test(text)) out.push("operation id");
  if (html.includes(".htpanel-")) out.push(".htpanel-");
  return out;
}

/** Every state of the wizard that changes the screen, each parsed by the contract. */
function allStates(): [string, SiteWordpressImportDto][] {
  const out: [string, SiteWordpressImportDto][] = [];
  const kinds = ["empty", "partial", "complete"] as const;
  for (const a of kinds)
    for (const d of kinds)
      for (const backupsConfigured of [true, false])
        for (const earlierImportUnfinished of [false, true])
          out.push([
            `slots ${a}/${d} backups:${backupsConfigured} earlier:${earlierImportUnfinished}`,
            dto({ slots: { archive: slotState(a), dump: slotState(d) }, backupsConfigured, earlierImportUnfinished }),
          ]);
  out.push(["available:false", dto({ available: false })]);
  out.push(["slots:null", dto({ slots: null })]);
  out.push(["slots:null earlier", dto({ slots: null, earlierImportUnfinished: true })]);
  for (let i = 0; i < WORDPRESS_IMPORT_STEP_KEYS.length; i++) out.push([`running step ${i}`, dto({ runningOperation: op(i) })]);
  out.push(["running, no steps yet", dto({ runningOperation: op(0, { status: "queued", steps: [] }) })]);
  out.push([
    "running, copy skipped",
    dto({ backupsConfigured: false, runningOperation: op(2, { steps: [{ key: "check", status: "succeeded" }, { key: "backup", status: "skipped" }, { key: "unpack", status: "running" }] }) }),
  ]);
  for (const status of OPERATION_STATUSES)
    out.push([
      `running status ${status}`,
      dto({ runningOperation: op(5, { status, steps: WORDPRESS_IMPORT_STEP_KEYS.map((key, i) => ({ key, status: i < 4 ? "succeeded" : i === 4 ? "failed" : "unknown" })) }) }),
    ]);
  for (const outcome of WORDPRESS_IMPORT_OUTCOMES)
    for (const reason of [null, ...WORDPRESS_IMPORT_REASONS])
      for (const backup of ["taken", "skipped", "failed"] as const)
        for (const full of [false, true])
          out.push([
            `outcome ${outcome} ${reason} ${backup} full:${full}`,
            dto({
              slots: { archive: slotState("complete"), dump: slotState("complete") },
              lastImport: last({
                outcome,
                reason,
                backup,
                ...(full
                  ? { oldAddress: "http://old.example.test", tables: 12, leftOut: [...WORDPRESS_IMPORT_LEFT_OUT], line: 42, errorNumber: 1064 }
                  : {}),
              }),
            }),
          ]);
  return out;
}

// ---- driving components as functions -------------------------------------------------------------

function walk(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) node.forEach((n) => walk(n as ReactNode, out));
  else if (isValidElement(node)) {
    out.push(node);
    walk((node.props as { children?: ReactNode }).children, out);
  }
  return out;
}
function slot(locale: Locale = "en") {
  const h = { state: [] as unknown[], refs: [] as { current: unknown }[], i: 0, r: 0, ctx: { locale, messages: CATALOG[locale] } };
  return {
    run<P>(component: (p: P) => unknown, props: P): { value: unknown; tree: ReactElement[] } {
      hooks.active = h;
      h.i = 0;
      h.r = 0;
      try {
        const value = component(props);
        return { value, tree: walk(value as ReactNode) };
      } finally {
        hooks.active = null;
      }
    },
  };
}
const byName = (tree: ReactElement[], name: string) => tree.find((e) => typeof e.type === "function" && e.type.name === name);
const propsOf = <P,>(e: ReactElement | undefined) => {
  if (!e) throw new Error("element not found");
  return e.props as P;
};

type Call = { url: string; method: string; headers: Headers; body: string | undefined };
function stubFetch(answer: (c: Call) => { status: number; body?: unknown; headers?: Record<string, string> }) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const c: Call = {
        url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : undefined,
      };
      calls.push(c);
      const a = answer(c);
      if (a.status === 204) return new Response(null, { status: 204 });
      return new Response(JSON.stringify(a.body ?? {}), { status: a.status, headers: { "content-type": "application/json", ...a.headers } });
    }),
  );
  return calls;
}
const memoryStorage = () => {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), map };
};

/** Mounts the wizard as functions: returns a re-render that gives the Wizard's element tree. */
function driveWizard(initial: SiteWordpressImportDto, locale: Locale = "en", siteName = SITE_NAME) {
  const outer = slot(locale);
  const wizardEl = byName(
    outer.run(WordpressImport as (p: unknown) => unknown, { basePath: BASE, siteName, initial, csrfToken: "csrf-sentinel", backupsHref: BACKUPS })
      .tree,
    "Wizard",
  )!;
  const inner = slot(locale);
  return () => inner.run(wizardEl.type as (p: unknown) => unknown, wizardEl.props).tree;
}

// ===================================================================================================

describe("1. the catalogs follow the contract's lists", () => {
  const t = (l: Locale) => CATALOG[l].site.wordpress.import;
  const sane = (en_: string, it_: string, key: string) => {
    for (const s of [en_, it_]) {
      expect(typeof s, key).toBe("string");
      expect(s.trim().length, key).toBeGreaterThan(0);
      if (key.includes("_")) expect(s, key).not.toContain(key);
      expect(s, key).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
    }
    expect(it_, key).not.toBe(en_);
  };

  it("every reason, step, outcome and refusal has its own sentence in both languages", () => {
    for (const r of WORDPRESS_IMPORT_REASONS) sane(t("en").reasons[r], t("it").reasons[r], r);
    for (const k of WORDPRESS_IMPORT_STEP_KEYS) sane(t("en").progress[k], t("it").progress[k], k);
    for (const o of WORDPRESS_IMPORT_OUTCOMES) sane(t("en").card.result[o], t("it").card.result[o], o);
    // Each refusal of the routes reads its own sentence, not the generic fallback.
    for (const r of WORDPRESS_IMPORT_REFUSALS) {
      const body = { error: { code: "RESOURCE_LOCKED", message: "raw api text", details: [{ reason: r }] } };
      const [a, b] = [importErrorText(en, 409, body), importErrorText(itCatalog, 409, body)];
      sane(a, b, r);
      expect(a).not.toBe(importErrorText(en, 409, { error: { code: "RESOURCE_LOCKED", details: [] } }));
    }
  });

  it("the outcome headline differs for each outcome, in both languages", () => {
    for (const l of LOCALES) {
      const heads = WORDPRESS_IMPORT_OUTCOMES.map((outcome) => textOf(wizard(dto({ lastImport: last({ outcome }) }), l)));
      expect(new Set(heads).size).toBe(WORDPRESS_IMPORT_OUTCOMES.length);
    }
  });

  it("every left-out name is shown in step 4 and in an outcome, in both languages", () => {
    for (const l of LOCALES) {
      const confirm = textOf(
        render(
          createElement(ImportConfirmView, { backupsConfigured: true, siteName: SITE_NAME, typed: "", busy: false, error: null, onTyped: () => {}, onConfirm: () => {} }),
          l,
        ),
      );
      const outcome = textOf(wizard(dto({ lastImport: last({ leftOut: [...WORDPRESS_IMPORT_LEFT_OUT] }) }), l));
      for (const name of WORDPRESS_IMPORT_LEFT_OUT) {
        expect(confirm, name).toContain(name);
        expect(outcome, name).toContain(name);
      }
    }
  });
});

describe("2. every state, rendered in both languages", () => {
  const states = allStates();

  it(`the wizard renders ${states.length} states × 2 languages without raw names, holes, jargon or .htpanel-`, () => {
    const found: string[] = [];
    for (const [name, state] of states)
      for (const l of LOCALES) {
        let html: string;
        try {
          html = wizard(state, l);
        } catch (e) {
          found.push(`${l} ${name}: threw ${(e as Error).message}`);
          continue;
        }
        for (const p of problems(html)) found.push(`${l} ${name}: ${p}`);
      }
    expect(found).toEqual([]);
  });

  it("the card renders every available state in both languages with the same checks", () => {
    const found: string[] = [];
    for (const [name, state] of states.filter(([, s]) => s.available))
      for (const l of LOCALES) for (const p of problems(card(state, l))) found.push(`${l} ${name}: ${p}`);
    expect(found).toEqual([]);
  });

  it("an answer that does not pass the schema is 'could not load', never a partial screen", () => {
    const ok = dto();
    const bad: unknown[] = [
      null,
      "nope",
      { ...ok, extra: 1 },
      { ...ok, slots: { archive: slotState("empty") } },
      { ...ok, runningOperation: { ...op(0), kind: "site.wordpress.update" } },
      { ...ok, runningOperation: { ...op(0), steps: [{ key: "migrate", status: "running" }] } },
      { ...ok, lastImport: { ...last(), reason: "brand_new_reason" } },
      { ...ok, lastImport: { ...last(), leftOut: [...WORDPRESS_IMPORT_LEFT_OUT, ...WORDPRESS_IMPORT_LEFT_OUT, ...WORDPRESS_IMPORT_LEFT_OUT].slice(0, 17) } },
      { ...ok, lastImport: { ...last(), line: -1 } },
      { ...ok, lastImport: { ...last(), errorNumber: 0 } },
      { ...ok, lastImport: { ...last(), finishedAt: "yesterday" } },
    ];
    for (const l of LOCALES)
      for (const b of bad) {
        const html = wizard(b, l);
        expect(textOf(html), JSON.stringify(b)?.slice(0, 80)).toContain(CATALOG[l].site.wordpress.import.loadFailed);
        expect(html).not.toContain('aria-current="step"');
      }
  });
});

describe("3. the sentences of W3", () => {
  it("undo_incomplete: dated, names the copy taken before the import, or says none was taken (W3.1, W3.2)", () => {
    for (const l of LOCALES) {
      const t = CATALOG[l].site.wordpress.import;
      const date = formatDate("2026-11-15T11:00:00.000Z", CATALOG[l].common.dateLocale);
      const taken = textOf(wizard(dto({ lastImport: last({ outcome: "undo_incomplete", reason: "other", backup: "taken" }) }), l));
      expect(taken).toContain(format(t.outcome.undoTaken, { date }));
      expect(taken).toContain(t.backupsLink);
      for (const backup of ["skipped", "failed"] as const) {
        const none = textOf(wizard(dto({ lastImport: last({ outcome: "undo_incomplete", reason: "other", backup }) }), l));
        expect(none, backup).toContain(format(t.outcome.undoNoCopy, { date }));
        expect(none, backup).not.toContain(format(t.outcome.undoTaken, { date }));
        expect(none, backup).toContain(t.backupsLink);
      }
    }
    expect(en.site.wordpress.import.outcome.undoTaken).toMatch(/before that import/);
    expect(en.site.wordpress.import.outcome.undoNoCopy).toMatch(/no copy/);
  });

  it("earlierImportUnfinished: the way out to Backups, no start control even with both files, uploads still possible", () => {
    for (const l of LOCALES) {
      const t = CATALOG[l].site.wordpress.import;
      const html = wizard(
        dto({ earlierImportUnfinished: true, slots: { archive: slotState("complete"), dump: slotState("complete") } }),
        l,
      );
      expect(textOf(html)).toContain(t.reasons.earlier_import_unfinished);
      expect(html).toContain(`href="${BACKUPS}"`);
      expect(textOf(html)).not.toContain(t.confirm.go);
      expect(html).not.toContain('id="import-site-name"');
      const fileInput = html.match(/<input[^>]*type="file"[^>]*>/g) ?? [];
      expect(fileInput).toHaveLength(2);
      for (const i of fileInput) expect(i).not.toMatch(/\sdisabled(=|\s|\/?>)/);
    }
  });

  it("a running import whose end is not known says neither failed nor imported (W3.6)", () => {
    for (const l of LOCALES) {
      const m = CATALOG[l];
      const t = m.site.wordpress.import;
      const unknownOp = op(5, {
        status: "unknown",
        steps: WORDPRESS_IMPORT_STEP_KEYS.map((key, i) => ({ key, status: i < 4 ? "succeeded" : i === 4 ? "failed" : "unknown" })),
      });
      for (const html of [wizard(dto({ runningOperation: unknownOp }), l), card(dto({ runningOperation: unknownOp }), l)]) {
        const text = textOf(html);
        expect(text).toContain(t.progress.unsettled);
        expect(text).not.toContain(`(${m.site.wordpress.step.failed})`);
        expect(text).not.toContain(t.outcome.imported);
        expect(text).not.toContain(t.card.result.imported);
        expect(text).not.toMatch(l === "en" ? /\bfailed\b|\bimported\b/i : /non è riuscit|importato\b/i);
      }
    }
  });

  it("is_a_directory, staging_unsafe and the line reasons read well, with and without a line", () => {
    for (const l of LOCALES) {
      const m = CATALOG[l];
      const t = m.site.wordpress.import;
      const dir = importErrorText(m, 400, { error: { code: "VALIDATION_ERROR", message: "raw", details: [{ reason: "is_a_directory" }] } });
      expect(dir).toBe(t.pick.notAFile);
      expect(textOf(wizard(dto({ lastImport: last({ outcome: "nothing_changed", reason: "staging_unsafe" }) }), l))).toContain(
        t.reasons.staging_unsafe,
      );
      for (const reason of ["dump_load_failed", "dump_statement_unsupported"] as const) {
        const at = textOf(wizard(dto({ lastImport: last({ outcome: "site_restored", reason, line: 42, errorNumber: 1064 }) }), l));
        expect(at).toContain(format(t.reasonsAtLine[reason], { line: "42" }));
        expect(at).toContain("1064");
        const plain = textOf(wizard(dto({ lastImport: last({ outcome: "site_restored", reason }) }), l));
        expect(plain).toContain(t.reasons[reason]);
        expect(plain).not.toMatch(/\{line\}|\b(line|riga)\b\s*[^a-zà-ú\s]/i);
      }
    }
  });

  it("W3.7: both line reasons name a cut-off load as a possible cause, with and without a line", () => {
    const missing: string[] = [];
    for (const l of LOCALES) {
      const t = CATALOG[l].site.wordpress.import;
      for (const reason of ["dump_load_failed", "dump_statement_unsupported"] as const)
        for (const [form, s] of [["no line", t.reasons[reason]], ["at line", t.reasonsAtLine[reason]]] as const)
          if (!(l === "en" ? /cut off/ : /interrott/).test(s)) missing.push(`${l} ${reason} (${form})`);
    }
    expect(missing).toEqual([]);
  });

  it("an import that was undone never says the old address was replaced (the API keeps it after a failed switch)", () => {
    const wrong: string[] = [];
    for (const l of LOCALES) {
      const t = CATALOG[l].site.wordpress.import;
      const replaced = format(t.outcome.oldAddress, { address: "http://old.example.test" });
      for (const outcome of ["nothing_changed", "site_restored", "undo_incomplete"] as const) {
        const state = dto({ lastImport: last({ outcome, reason: "address_rewrite_failed", oldAddress: "http://old.example.test", tables: 12 }) });
        if (textOf(wizard(state, l)).includes(replaced)) wrong.push(`${l} ${outcome}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("an outcome after a recovery leaves out the lines it has no value for (W3.6)", () => {
    for (const l of LOCALES) {
      const t = CATALOG[l].site.wordpress.import;
      const text = textOf(wizard(dto({ lastImport: last({ outcome: "site_restored", reason: "interrupted" }) }), l));
      for (const s of [t.outcome.oldAddress, t.outcome.tables, t.outcome.leftOut, t.outcome.errorNumber])
        expect(text).not.toContain(s.split("{")[0]!.trim());
    }
  });
});

describe("3/4. the confirmation and the start, driven", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  const both = () => dto({ slots: { archive: slotState("complete"), dump: slotState("complete") } });

  it("with a file missing there is no start control at all", () => {
    for (const l of LOCALES)
      for (const [a, d] of [["complete", "partial"], ["complete", "empty"], ["partial", "complete"], ["empty", "complete"]] as const) {
        const html = wizard(dto({ slots: { archive: slotState(a), dump: slotState(d) } }), l);
        expect(textOf(html)).not.toContain(CATALOG[l].site.wordpress.import.confirm.go);
        expect(html).not.toContain('id="import-site-name"');
      }
  });

  it("start is refused unless the typed name equals the site name exactly; then one POST {confirm:true} with an Idempotency-Key", async () => {
    const calls = stubFetch(() => ({ status: 202, body: { data: { operationId: `op_${"e".repeat(32)}` } } }));
    const rerender = driveWizard(both());
    for (const typed of ["", "neutral shop", "Neutral Shop ", " Neutral Shop", "Neutral  Shop"]) {
      propsOf<{ onTyped: (v: string) => void }>(byName(rerender(), "ImportConfirmView")).onTyped(typed);
      const view = propsOf<{ onConfirm: () => void; typed: string }>(byName(rerender(), "ImportConfirmView"));
      expect(view.typed).toBe(typed);
      expect(render(createElement(ImportConfirmView, { ...(view as unknown as Parameters<typeof ImportConfirmView>[0]), busy: false, error: null }), "en")).toMatch(/<button[^>]*disabled/);
      view.onConfirm();
      await new Promise((r) => setTimeout(r, 0));
      expect(calls, JSON.stringify(typed)).toHaveLength(0);
    }
    propsOf<{ onTyped: (v: string) => void }>(byName(rerender(), "ImportConfirmView")).onTyped(SITE_NAME);
    propsOf<{ onConfirm: () => void }>(byName(rerender(), "ImportConfirmView")).onConfirm();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toBe(BASE);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toBe('{"confirm":true}');
    expect(calls[0]!.headers.get("idempotency-key")).toMatch(/\S{8,}/);
    expect(calls[0]!.headers.get("x-csrf-token")).toBe("csrf-sentinel");
    // After the 202 the wizard follows the import: only step 5.
    await vi.waitFor(() => expect(byName(rerender(), "ImportProgress")).toBeDefined());
    expect(byName(rerender(), "ImportConfirmView")).toBeUndefined();
  });

  it("start keeps its Idempotency-Key after no answer and a 503 (the retry replays); after a 409 the next start has a new one (issue #146)", async () => {
    const answers: Array<number | "lost"> = ["lost", 503, 409, 202];
    const calls = stubFetch(() => {
      const a = answers.shift() ?? "lost";
      if (a === "lost") throw new TypeError("network down");
      return a === 202
        ? { status: 202, body: { data: { operationId: `op_${"e".repeat(32)}` } } }
        : { status: a, body: { error: { code: a === 409 ? "RESOURCE_LOCKED" : "INTERNAL_ERROR", message: "raw" } } };
    });
    const rerender = driveWizard(both());
    propsOf<{ onTyped: (v: string) => void }>(byName(rerender(), "ImportConfirmView")).onTyped(SITE_NAME);
    for (let n = 1; n <= 4; n++) {
      propsOf<{ onConfirm: () => void }>(byName(rerender(), "ImportConfirmView")).onConfirm();
      await vi.waitFor(() => expect(calls).toHaveLength(n));
      if (n < 4) await vi.waitFor(() => expect(propsOf<{ error: string | null }>(byName(rerender(), "ImportConfirmView")).error).not.toBeNull());
    }
    const keys = calls.map((c) => c.headers.get("idempotency-key"));
    expect(keys[0]).toMatch(/\S{8,}/);
    expect(keys.slice(0, 3)).toEqual([keys[0], keys[0], keys[0]]);
    expect(keys[3]).toMatch(/\S{8,}/);
    expect(keys[3]).not.toBe(keys[0]);
    expect(calls.map((c) => c.body)).toEqual(Array(4).fill('{"confirm":true}'));
  });

  it("QUOTA_EXCEEDED on start gives the wizard's sentence with the time of retryAt, never the API's message (W3.5)", async () => {
    const retryAt = "2031-01-02T03:04:00.000Z";
    stubFetch(() => ({
      status: 409,
      body: {
        error: {
          code: "QUOTA_EXCEEDED",
          message: "Too many heavy backup actions for this site.",
          details: [{ field: "retryAt", reason: "too_many_requests", message: retryAt }],
        },
      },
    }));
    for (const l of LOCALES) {
      const m = CATALOG[l];
      const rerender = driveWizard(both(), l);
      propsOf<{ onTyped: (v: string) => void }>(byName(rerender(), "ImportConfirmView")).onTyped(SITE_NAME);
      propsOf<{ onConfirm: () => void }>(byName(rerender(), "ImportConfirmView")).onConfirm();
      await vi.waitFor(() => expect(propsOf<{ error: string | null }>(byName(rerender(), "ImportConfirmView")).error).not.toBeNull());
      const error = propsOf<{ error: string }>(byName(rerender(), "ImportConfirmView")).error;
      expect(error).toBe(format(m.site.wordpress.import.errors.tooMany, { time: formatDate(retryAt, m.common.dateLocale) }));
      expect(error).not.toMatch(/backup actions/);
    }
  });

  it("pick: is_a_directory reads the not-a-file sentence; the request is POST {path} to the slot's pick route", async () => {
    const calls = stubFetch(() => ({ status: 400, body: { error: { code: "VALIDATION_ERROR", message: "raw", details: [{ reason: "is_a_directory" }] } } }));
    for (const l of LOCALES) {
      const rerender = driveWizard(dto(), l);
      const slotEl = rerender().find((e) => typeof e.type === "function" && e.type.name === "ImportSlot" && (e.props as { slot: string }).slot === "dump")!;
      const s = slot(l);
      const tree = () => s.run(slotEl.type as (p: unknown) => unknown, slotEl.props).tree;
      const pickInput = () => tree().find((e) => (e.props as { id?: string }).id === "import-pick-dump")!;
      propsOf<{ onChange: (e: unknown) => void }>(pickInput()).onChange({ target: { value: "imports/export.sql" } });
      const useBtn = tree().find((e) => (e.props as { children?: unknown }).children === CATALOG[l].site.wordpress.import.pick.use)!;
      propsOf<{ onClick: () => void }>(useBtn).onClick();
      await vi.waitFor(() => expect(tree().some((e) => (e.props as { role?: string }).role === "alert")).toBe(true));
      const alert = tree().find((e) => (e.props as { role?: string }).role === "alert")!;
      expect((alert.props as { children: string }).children).toBe(CATALOG[l].site.wordpress.import.pick.notAFile);
    }
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ["POST", `${BASE}/files/dump/pick`, '{"path":"imports/export.sql"}'],
      ["POST", `${BASE}/files/dump/pick`, '{"path":"imports/export.sql"}'],
    ]);
  });

  it("discard: DELETE …/files with the CSRF header, then the state is read again", async () => {
    const calls = stubFetch((c) => (c.method === "DELETE" ? { status: 204 } : { status: 200, body: { data: dto() } }));
    const rerender = driveWizard(dto({ slots: { archive: slotState("complete"), dump: slotState("empty") } }));
    propsOf<{ onDiscard: () => void }>(byName(rerender(), "ImportDiscardView")).onDiscard();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["DELETE", `${BASE}/files`],
      ["GET", BASE],
    ]);
    expect(calls[0]!.headers.get("x-csrf-token")).toBe("csrf-sentinel");
  });
});

describe("5. hostile values are text", () => {
  it("a long origin is text and never a link; non-origin addresses and foreign left-out names do not pass the schema", () => {
    const long = `http://${Array.from({ length: 4 }, () => "a".repeat(63)).join(".")}.test`.slice(0, 300).replace(/[.-]+$/, "");
    const state = dto({ lastImport: last({ oldAddress: long }) });
    for (const l of LOCALES) {
      const html = wizard(state, l);
      expect(textOf(html)).toContain(long);
      expect(html).not.toContain(`href="${long}`);
    }
    for (const v of HOSTILE) {
      expect(SiteWordpressImportDtoSchema.safeParse({ ...dto(), lastImport: { ...last(), oldAddress: v } }).success).toBe(false);
      expect(SiteWordpressImportDtoSchema.safeParse({ ...dto(), lastImport: { ...last(), leftOut: [v] } }).success).toBe(false);
      for (const l of LOCALES) {
        const html = wizard({ ...dto(), lastImport: { ...last(), oldAddress: v } }, l);
        expect(textOf(html)).toContain(CATALOG[l].site.wordpress.import.loadFailed);
        expect(html).not.toMatch(/<img|<script|href="javascript:/i);
      }
    }
  });

  it("a hostile running operation id, site name and uploaded file name are rendered as text", () => {
    for (const v of HOSTILE.slice(0, 3)) {
      const running = dto({ runningOperation: op(1, { id: v }) });
      for (const l of LOCALES) {
        for (const html of [wizard(running, l), card(running, l), wizard(dto({ slots: { archive: slotState("complete"), dump: slotState("complete") } }), l, v)])
          expect(html).not.toMatch(/<img|<script|href="javascript:/i);
        const items: UploadItem[] = (["waiting", "uploading", "failed", "done"] as const).map((status, i) => ({
          id: `u${i}`,
          file: new File(["x"], v),
          path: v,
          overwrite: true,
          sent: 0,
          status,
          error: status === "failed" ? v : null,
        }));
        const list = render(createElement(UploadList, { items, onCancel() {}, onRetry() {}, onCancelAll() {}, onDismiss() {} }), l);
        expect(list).not.toMatch(/<img|<script/i);
        if (v.includes("<")) expect(list).toContain(v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"));
      }
    }
  });
});

describe("6. the jargon scan sees the new screen", () => {
  it("the new files and catalog group are under the scanned folders and section, and a jargon word in a copy of a sentence is caught", () => {
    const src = path.resolve(__dirname, "../src");
    const scanned = ["app/sites", "components/customer"];
    for (const f of [
      "app/sites/[siteId]/wordpress/import/page.tsx",
      "components/customer/wordpress-import.tsx",
      "components/customer/wordpress-import-card.tsx",
    ]) {
      expect(fs.existsSync(path.join(src, f)), f).toBe(true);
      expect(scanned.some((d) => f.startsWith(`${d}/`)), f).toBe(true);
    }
    const scan = fs.readFileSync(path.resolve(__dirname, "ui-copy.test.ts"), "utf-8");
    for (const d of scanned) expect(scan).toContain(`"${d}"`);
    expect(scan).toMatch(/sections = \[[^\]]*"site"/);
    expect(scan).toMatch(/\bschema\b/);
    // The scan's own regex refuses a copy of an import sentence with a forbidden word put in.
    const jargon = new RegExp(scan.match(/const jargon = \/(.+)\/i;/)![1]!, "i");
    expect(JSON.stringify(en.site.wordpress.import)).not.toMatch(jargon);
    expect(JSON.stringify(itCatalog.site.wordpress.import)).not.toMatch(jargon);
    for (const word of ["schema", "container", "organization"]) {
      expect(en.site.wordpress.import.reasons.dump_unsafe.replace("database export", `database ${word}`)).toMatch(jargon);
    }
  });
});

describe("7. the upload additions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Mounts one ImportSlot of the wizard as a function. */
  function driveSlot(state: SiteWordpressImportDto, name: "archive" | "dump", l: Locale = "en") {
    const rerender = driveWizard(state, l);
    const el = rerender().find((e) => typeof e.type === "function" && e.type.name === "ImportSlot" && (e.props as { slot: string }).slot === name)!;
    const s = slot(l);
    const tree = () => s.run(el.type as (p: unknown) => unknown, el.props).tree;
    const choose = (file: File) =>
      propsOf<{ onChange: (e: unknown) => void }>(tree().find((e) => (e.props as { id?: string }).id === `import-file-${name}`)).onChange({
        target: { files: [file], value: "" },
      });
    const items = () => propsOf<{ items: UploadItem[] }>(byName(tree(), "UploadList")).items;
    return { choose, items };
  }

  it("a chunk goes to …/files/<slot> with only uploadId, offset, dataBase64 and final", async () => {
    vi.stubGlobal("sessionStorage", memoryStorage());
    const calls = stubFetch((c) => (c.method === "PUT" ? { status: 200, body: { data: { received: 4 } } } : { status: 200, body: { data: dto() } }));
    const { choose, items } = driveSlot(dto(), "archive");
    choose(new File(["PK\x03\x04"], "site.zip"));
    await vi.waitFor(() => expect(items()[0]?.status).toBe("done"));
    const put = calls.filter((c) => c.method === "PUT");
    expect(put).toHaveLength(1);
    expect(put[0]!.url).toBe(`${BASE}/files/archive`);
    expect(Object.keys(JSON.parse(put[0]!.body!) as object)).toEqual(["uploadId", "offset", "dataBase64", "final"]);
    expect(put[0]!.headers.get("x-csrf-token")).toBe("csrf-sentinel");
  });

  it("a resumed upload starts at the received size with the same uploadId", async () => {
    const store = memoryStorage();
    vi.stubGlobal("sessionStorage", store);
    const file = new File(["0123456789"], "export.sql", { lastModified: 1_700_000_000_000 });
    store.setItem(
      `hp-wp-import:${BASE}:dump`,
      JSON.stringify({ uploadId: "upload-0123456789abcdef", name: file.name, size: file.size, lastModified: file.lastModified }),
    );
    const calls = stubFetch((c) => (c.method === "PUT" ? { status: 200, body: { data: { received: 10 } } } : { status: 200, body: { data: dto() } }));
    const { choose, items } = driveSlot(dto({ slots: { archive: slotState("complete"), dump: slotState("partial") } }), "dump");
    choose(file);
    await vi.waitFor(() => expect(items()[0]?.status).toBe("done"));
    const body = JSON.parse(calls.find((c) => c.method === "PUT")!.body!) as { uploadId: string; offset: number; dataBase64: string };
    expect(body.uploadId).toBe("upload-0123456789abcdef");
    expect(body.offset).toBe(4);
    expect(Buffer.from(body.dataBase64, "base64").toString()).toBe("456789");
  });

  it("a chunk the import refuses reads the import's sentence in both languages", async () => {
    vi.stubGlobal("sessionStorage", memoryStorage());
    const refusals = [
      { status: 400, code: "VALIDATION_ERROR", reason: "not_a_zip", key: "archive_not_zip" },
      { status: 400, code: "VALIDATION_ERROR", reason: "dump_not_sql", key: "dump_not_sql" },
      { status: 409, code: "QUOTA_EXCEEDED", reason: "disk_full", key: "disk_full" },
    ] as const;
    for (const l of LOCALES)
      for (const r of refusals) {
        stubFetch(() => ({ status: r.status, body: { error: { code: r.code, message: "raw api text", details: [{ reason: r.reason }] } } }));
        const { choose, items } = driveSlot(dto(), r.reason === "dump_not_sql" ? "dump" : "archive", l);
        choose(new File(["data"], r.reason === "dump_not_sql" ? "export.sql" : "site.zip"));
        await vi.waitFor(() => expect(items()[0]?.status).toBe("failed"));
        expect(items()[0]!.error, `${l} ${r.reason}`).toBe(CATALOG[l].site.wordpress.import.reasons[r.key]);
        vi.unstubAllGlobals();
        vi.stubGlobal("sessionStorage", memoryStorage());
      }
  });

  /** Mounts the shipped queue without the import options, as the file manager does. */
  function driveQueue(l: Locale, extra: Record<string, unknown> = {}) {
    const s = slot(l);
    const opts = { apiBase: "/api/bff/orgs/o1/managed-sites/s1", csrfToken: "csrf-sentinel", onCsrfToken() {}, onFileDone() {}, ...extra };
    const q = () => s.run(useUploadQueue as (p: unknown) => unknown, opts).value as ReturnType<typeof useUploadQueue>;
    return q;
  }

  it("without chunkUrl the file manager's chunk is sent byte for byte as uploadFile builds it, to …/files/content", async () => {
    const built: string[] = [];
    const capture: ChunkSender = async (chunk) => {
      built.push(JSON.stringify(chunk));
      return { status: 200, received: 5 };
    };
    await uploadFile(new File(["hello"], "a.txt"), "dir/a.txt", false, capture, () => {}, new AbortController().signal, {
      uploadId: "upload-fixed-000000000001",
      offset: 0,
    });
    const calls = stubFetch(() => ({ status: 200, body: { data: { received: 5 } } }));
    const q = driveQueue("en");
    q().enqueue([{ file: new File(["hello"], "a.txt"), path: "dir/a.txt", overwrite: false, resume: { uploadId: "upload-fixed-000000000001", offset: 0 } }]);
    await vi.waitFor(() => expect(q().items[0]?.status).toBe("done"));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/bff/orgs/o1/managed-sites/s1/files/content");
    expect(calls[0]!.body).toBe(built[0]);
    expect(Object.keys(JSON.parse(calls[0]!.body!) as object)).toEqual(expect.arrayContaining(["path", "overwrite"]));
  });

  it("without the import's options a refused chunk keeps the file manager's text in both languages", async () => {
    for (const l of LOCALES)
      for (const [status, code, reason] of [
        [409, "QUOTA_EXCEEDED", "disk_full"],
        [400, "VALIDATION_ERROR", "not_a_zip"],
        [404, "NOT_FOUND", undefined],
      ] as const) {
        stubFetch(() => ({ status, body: { error: { code, message: "raw", details: reason ? [{ reason }] : [] } } }));
        const q = driveQueue(l);
        q().enqueue([{ file: new File(["x"], "a.txt"), path: "a.txt", overwrite: true }]);
        await vi.waitFor(() => expect(q().items[0]?.status).toBe("failed"));
        expect(q().items[0]!.error).toBe(fileErrorText(CATALOG[l], code, "upload", reason ? [{ reason }] : undefined));
        vi.unstubAllGlobals();
      }
  });

  it("prepareQueuedUploads copies resume and starts the item at its offset", () => {
    const { items } = prepareQueuedUploads(
      [{ file: new File(["0123456789"], "x.sql"), path: "x.sql", overwrite: true, resume: { uploadId: "upload-0123456789abcdef", offset: 6 } }],
      en,
    );
    expect(items[0]!.resume).toEqual({ uploadId: "upload-0123456789abcdef", offset: 6 });
    expect(items[0]!.sent).toBe(6);
  });
});

describe("8. the screen and the routes fit together", () => {
  const bffRoot = path.resolve(__dirname, "../src/app/api/bff/orgs/[orgId]/managed-sites/[siteId]");
  const openapi = fs.readFileSync(path.resolve(__dirname, "../../../docs/api/openapi.yaml"), "utf-8");
  /** Methods that docs/api/openapi.yaml lists under one path. */
  const apiMethods = (p: string) => {
    const start = openapi.indexOf(`\n  ${p}:\n`);
    if (start < 0) return [];
    const rest = openapi.slice(start + p.length + 4);
    const block = rest.slice(0, rest.search(/\n {2}\/|\n[a-z]/));
    return [...block.matchAll(/^ {4}(get|post|put|delete|patch):/gm)].map((x) => x[1]!.toUpperCase());
  };

  // Every (method, URL) the wizard and the card request, as the driven tests above saw them.
  const SCREEN = [
    ["GET", BASE],
    ["POST", BASE],
    ["DELETE", `${BASE}/files`],
    ["PUT", `${BASE}/files/archive`],
    ["PUT", `${BASE}/files/dump`],
    ["POST", `${BASE}/files/dump/pick`],
    ["POST", `${BASE}/files/archive/pick`],
  ] as const;

  it("every request of the screen has a BFF route file exporting that method, which forwards to an OpenAPI route with that method", () => {
    for (const [method, url] of SCREEN) {
      const rel = url.replace(`/api/bff/orgs/o1/managed-sites/s1/`, "").replace(/files\/(archive|dump)/, "files/[slot]");
      const file = path.join(bffRoot, rel, "route.ts");
      expect(fs.existsSync(file), file).toBe(true);
      const code = fs.readFileSync(file, "utf-8");
      expect(code, `${method} ${rel}`).toMatch(new RegExp(`export async function ${method}\\(`));
      const fwd = code.match(new RegExp(`forwardSiteCall\\(req, context, [\`"]([^\`"]+)[\`"], "${method}"`));
      expect(fwd, `${method} ${rel}`).not.toBeNull();
      const upstream = `/v1/organizations/{orgId}/managed-sites/{siteId}/${fwd![1]!.replace("${slot.data}", "{slot}")}`;
      expect(apiMethods(upstream), upstream).toContain(method);
    }
  });

  it("the screen's source builds only these URLs", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../src/components/customer/wordpress-import.tsx"), "utf-8");
    const urls = [...src.matchAll(/`\$\{(basePath|chunkUrl)\}([^`]*)`/g)].map((x) => `${x[1]}${x[2]}`).sort();
    expect([...new Set(urls)]).toEqual(["basePath/files", "basePath/files/${slot}", "chunkUrl/pick"].sort());
  });
});

describe("9. BFF holes left by wordpress-import-bff.test.ts", () => {
  const CSRF = "csrf-import-qa-sentinel";
  let cookie = "";
  beforeEach(async () => {
    const session: SessionData = {
      accessToken: "upstream-token-sentinel",
      csrfToken: CSRF,
      activeConsole: "customer",
      activeOrgSlug: null,
      user: {
        id: "usr-1",
        email: "admin@example.test",
        name: "Owner",
        locale: "en",
        mustChangePassword: false,
        isServerAdmin: false,
        globalRoles: [],
        hostingAdminOrgIds: [],
      },
    };
    cookie = `${SESSION_COOKIE_NAME}=${await encryptSession(session)}`;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  const req = (method: string, body?: string, h: Record<string, string> = {}) =>
    new Request("http://localhost:3000/api/bff/x", {
      method,
      headers: { Host: "localhost:3000", Origin: "http://localhost:3000", Cookie: cookie, "X-CSRF-Token": CSRF, "Content-Type": "application/json", ...h },
      ...(body !== undefined ? { body } : {}),
    });
  const ctx = (p: Record<string, string>) => ({ params: Promise.resolve({ orgId: "org-1", siteId: "site-1", ...p }) });

  it("a bad org or site segment is refused on all five handlers before any upstream call", async () => {
    const calls = stubFetch(() => ({ status: 200, body: { data: {} } }));
    const bads: Record<string, string>[] = [{ orgId: ".." }, { siteId: "a/b" }, { siteId: "..%2F" }, { orgId: "" }, { siteId: "s\u0000" }];
    for (const bad of bads) {
      const results = await Promise.all([
        getImport(req("GET"), ctx(bad)),
        postImport(req("POST", '{"confirm":true}', { "Idempotency-Key": "k-1" }), ctx(bad)),
        deleteFiles(req("DELETE"), ctx(bad)),
        putChunk(req("PUT", JSON.stringify({ uploadId: "upload-0123456789abcdef", offset: 0, dataBase64: "AAAA", final: true })), ctx({ ...bad, slot: "dump" })),
        postPick(req("POST", '{"path":"imports/site.zip"}'), ctx({ ...bad, slot: "archive" })),
      ]);
      for (const r of results) expect(r.status, JSON.stringify(bad)).toBeGreaterThanOrEqual(400);
    }
    expect(calls).toHaveLength(0);
  });

  it("a decoded traversal or separator in the slot is refused, even without a CSRF token", async () => {
    const calls = stubFetch(() => ({ status: 200, body: { data: {} } }));
    for (const s of ["archive/dump", "../archive", "dump/..", "archive\u0000", "%2e%2e", "dump/pick", " archive"]) {
      const put = await putChunk(req("PUT", "{}", { "X-CSRF-Token": "" }), ctx({ slot: s }));
      const pick = await postPick(req("POST", "{}", { "X-CSRF-Token": "" }), ctx({ slot: s }));
      expect([put.status, pick.status], JSON.stringify(s)).toEqual([400, 400]);
    }
    expect(calls).toHaveLength(0);
  });

  it("start and pick refuse a body over 1 MiB with 413, and pick refuses a .htpanel- segment however the path is written", async () => {
    const calls = stubFetch(() => ({ status: 200, body: { data: {} } }));
    const big = JSON.stringify({ confirm: true, pad: "x".repeat(1_100_000) });
    expect((await postImport(req("POST", big, { "Idempotency-Key": "k-1" }), ctx({}))).status).toBe(413);
    expect((await postPick(req("POST", JSON.stringify({ path: "x".repeat(1_100_000) })), ctx({ slot: "dump" }))).status).toBe(413);
    for (const p of ["imports/.htpanel-x", "imports//.htpanel-x/a.sql", ".htpanel-import/", "a/./.htpanel-b/c.sql", "imports\\..\\..\\x.sql/.."]) {
      const r = await postPick(req("POST", JSON.stringify({ path: p })), ctx({ slot: "dump" }));
      expect(r.status, p).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it("the upstream path holds only the checked slot and no client text", async () => {
    const calls = stubFetch(() => ({ status: 200, body: { data: {} } }));
    await putChunk(req("PUT", JSON.stringify({ uploadId: "upload-0123456789abcdef", offset: 0, dataBase64: "AAAA", final: true })), ctx({ slot: "dump" }));
    await postPick(req("POST", '{"path":"imports/site.zip"}'), ctx({ slot: "archive" }));
    expect(calls.map((c) => [c.method, new URL(c.url).pathname])).toEqual([
      ["PUT", "/v1/organizations/org-1/managed-sites/site-1/wordpress/import/files/dump"],
      ["POST", "/v1/organizations/org-1/managed-sites/site-1/wordpress/import/files/archive/pick"],
    ]);
  });
});
