import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The hook stand-in of the other page tests, with useMemo: while a slot is active a component is a plain
// function whose state and refs live on the slot, so its handlers can be driven without a DOM.
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
  const useMemo = <T,>(fn: () => T, deps: unknown[]) => (hooks.active ? fn() : real.useMemo(fn, deps));
  const useContext = (c: never) => (hooks.active ? hooks.active.ctx : real.useContext(c));
  const patched = { useState, useRef, useEffect, useCallback, useMemo, useContext };
  return { ...real, ...patched, default: { ...real, ...patched } };
});

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/sites/site_k1/files",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));

import { format } from "@/i18n";
import { en } from "@/i18n/en";
import { postJson } from "@/components/customer/site-wordpress";
import { FilesPanel } from "@/components/customer/files-panel";
import { NameDialog } from "@/components/customer/file-dialogs";

const WP = "/api/bff/orgs/org_k1/managed-sites/site_k1/wordpress";
const FILES_PROPS = { apiBase: "/api/bff/orgs/org_k1/managed-sites/site_k1", orgId: "org_k1", siteId: "site_k1", csrfToken: "csrf-k" };

function walk(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) node.forEach((n) => walk(n as ReactNode, out));
  else if (isValidElement(node)) {
    out.push(node);
    walk((node.props as { children?: ReactNode }).children, out);
  }
  return out;
}

/** Stubs fetch with one answer per call: a status, or no answer at all. Returns the key and body each call carried. */
function answering(answers: Array<number | "lost">) {
  const sent: { key: string | null; body: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      sent.push({ key: new Headers(init?.headers).get("idempotency-key"), body: String(init?.body) });
      const a = answers.shift() ?? "lost";
      if (a === "lost") throw new TypeError("fetch failed");
      const body = a < 300 ? { data: {} } : { error: { code: a < 500 ? "VALIDATION_ERROR" : "INTERNAL_ERROR", message: "refused" } };
      return new Response(JSON.stringify(body), { status: a, headers: { "content-type": "application/json" } });
    }),
  );
  return sent;
}

/**
 * The four cases of one keyed action, where send(p) runs it with payload p: a retry after no answer (or a 5xx)
 * sends the same key; after a 2xx and after a 4xx the next send has a new key; a changed payload never goes
 * out with the kept key.
 */
async function expectKeptUntilAnswered(send: (payload: "a" | "b") => Promise<unknown>) {
  const sent = answering(["lost", 503, 202, 409, 503, 202, 202]);
  for (const p of ["a", "a", "a", "a", "a", "b", "a"] as const) await send(p);
  const keys = sent.map((s) => s.key);
  expect(sent).toHaveLength(7);
  for (const k of keys) expect(k).toMatch(/\S{8,}/);
  expect(keys[1]).toBe(keys[0]); // no answer: the retry replays
  expect(keys[2]).toBe(keys[0]); // a 5xx: the retry replays
  expect(keys[3]).not.toBe(keys[2]); // after the 2xx: a new key
  expect(keys[4]).not.toBe(keys[3]); // after the 4xx: a new key
  expect(sent[5]!.body).not.toBe(sent[4]!.body);
  expect(keys[5]).not.toBe(keys[4]); // kept after the 5xx, but the payload changed: a new key
  expect(keys[6]).not.toBe(keys[4]); // back to the first payload: the replaced key does not come back
  expect(new Set(keys.slice(2)).size).toBe(5);
  return sent;
}

/** Calls FilesPanel as a function on one slot; each call is a new render with the same state and refs. */
function filesPanel() {
  const h = { state: [] as unknown[], refs: [] as { current: unknown }[], i: 0, r: 0, ctx: { locale: "en", messages: en } };
  const render = (): ReactElement[] => {
    hooks.active = h;
    h.i = 0;
    h.r = 0;
    try {
      return walk(FilesPanel(FILES_PROPS));
    } finally {
      hooks.active = null;
    }
  };
  return { h, render };
}
const nameDialog = (tree: ReactElement[], title: string) => {
  const e = tree.find((x) => x.type === NameDialog && (x.props as { title?: string }).title === title);
  if (!e) throw new Error(`dialog not found: ${title}`);
  return e.props as { onSubmit: (value: string) => Promise<string | null> };
};

afterEach(() => vi.unstubAllGlobals());

describe("a site action keeps its Idempotency-Key until an answer comes (issue #146)", () => {
  it("WordPress postJson (check, update, import start) keeps one key per action and payload", async () => {
    const keys = {};
    await expectKeptUntilAnswered((p) => postJson(`${WP}/updates`, "csrf-k", { scope: "plugin", name: p === "a" ? "akismet" : "hello" }, keys));
  });

  it("WordPress postJson without a key store sends no key (password reset, import pick)", async () => {
    const sent = answering([200, 200]);
    await postJson(`${WP}/administrators/7/password-reset`, "csrf-k", {});
    await postJson(`${WP}/import/files/dump/pick`, "csrf-k", { path: "imports/export.sql" });
    expect(sent.map((s) => s.key)).toEqual([null, null]);
  });

  it("files: compress keeps its key until it is answered", async () => {
    const panel = filesPanel();
    const sent = await expectKeptUntilAnswered((p) =>
      nameDialog(panel.render(), en.site.files.compress.title).onSubmit(p === "a" ? "backup" : "other"),
    );
    expect(JSON.parse(sent[0]!.body)).toEqual({ paths: [], to: "backup.zip" });
    expect(JSON.parse(sent[5]!.body)).toEqual({ paths: [], to: "other.zip" });
  });

  it("files: extract keeps its key until it is answered", async () => {
    const panel = filesPanel();
    panel.render();
    // One selected zip, as after a listing (effects do not run on the stand-in).
    const zip = { name: "site.zip", kind: "file", size: 10, modifiedAt: "2026-11-20T10:00:00.000Z", writable: true };
    panel.h.state[panel.h.state.findIndex((v) => Array.isArray(v))] = [zip];
    panel.h.state[panel.h.state.findIndex((v) => v instanceof Set)] = new Set([zip.name]);
    const open = panel.render().find((e) => (e.props as { children?: unknown }).children === en.site.files.actions.extract);
    (open!.props as { onClick: () => void }).onClick();
    const title = format(en.site.files.extract.title, { name: zip.name });
    const sent = await expectKeptUntilAnswered((p) => nameDialog(panel.render(), title).onSubmit(p === "a" ? "" : "unpacked"));
    expect(JSON.parse(sent[0]!.body)).toEqual({ path: "site.zip", to: "" });
    expect(JSON.parse(sent[5]!.body)).toEqual({ path: "site.zip", to: "unpacked" });
  });
});
