import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TERMINAL_END_REASONS, TERMINAL_REFUSALS, type AdminSiteDto } from "@hosting-panel/contracts";
import type { Messages } from "@/i18n";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { I18nProvider } from "@/i18n/provider";

const fetchUpstream = vi.fn();
const getSessionFromRequest = vi.fn();
const getServerSession = vi.fn();
const fetchServerAdminSites = vi.fn();
const redirect = vi.fn();
const notFound = vi.fn();

vi.mock("@/lib/upstream", () => ({ fetchUpstream: (...a: unknown[]) => fetchUpstream(...a) }));
vi.mock("@/lib/server-session", () => ({
  getSessionFromRequest: (...a: unknown[]) => getSessionFromRequest(...a),
  getServerSession: (...a: unknown[]) => getServerSession(...a),
}));
vi.mock("@/lib/server-api", () => ({ fetchServerAdminSites: (...a: unknown[]) => fetchServerAdminSites(...a) }));
vi.mock("@/i18n/server", () => ({ getRequestLocale: async () => "en" }));
vi.mock("next/navigation", () => ({
  redirect: (...a: unknown[]) => redirect(...a),
  notFound: (...a: unknown[]) => notFound(...a),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/admin/sites",
}));

import { emptyText, feed, type TerminalText } from "@/lib/terminal-text";
import {
  TERMINAL_PAGE_LOST_MS,
  classifyRead,
  endText,
  inputFits,
  isLost,
  keyToInput,
  readRetryDelay,
  runReadLoop,
  terminalErrorText,
} from "@/lib/terminal-session";
import { POST as openRoute } from "@/app/api/admin/sites/[siteId]/terminal/route";
import { POST as writeRoute } from "@/app/api/admin/terminal/[sessionId]/write/route";
import { POST as readRoute } from "@/app/api/admin/terminal/[sessionId]/read/route";
import { POST as closeRoute } from "@/app/api/admin/terminal/[sessionId]/close/route";
import { TerminalConsole, TerminalOutput } from "@/components/admin/terminal-console";
import TerminalPage from "@/app/admin/sites/[siteId]/terminal/page";
import { SitesTable } from "@/components/admin/sites-table";

const SID = `term_${"ab".repeat(16)}`;
const all = (chunks: string[], serverDropped = false): TerminalText =>
  chunks.reduce((s, c) => feed(s, c, serverDropped), emptyText());
const wrap = (m: Messages, child: ReactElement) =>
  renderToStaticMarkup(createElement(I18nProvider, { locale: m === en ? "en" : "it", messages: m, children: child }));

// Calls a client component once with stand-in hooks: refs live in `refs` across calls, effects are kept to be run by hand.
const internals = (React as unknown as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE!;
function withHooks<P>(C: (p: P) => ReactNode, props: P, refs: Record<number, { current: unknown }> = {}) {
  let r = 0;
  const effects: Array<() => void | (() => void)> = [];
  const prev = internals.H;
  internals.H = {
    useState: (v: unknown) => [typeof v === "function" ? (v as () => unknown)() : v, () => {}],
    useRef: (v: unknown) => (refs[r++] ??= { current: v }),
    useCallback: (f: unknown) => f,
    useEffect: (f: () => void | (() => void)) => void effects.push(f),
    useContext: () => ({ locale: "en", messages: en }),
  };
  try {
    return { tree: C(props) as ReactElement<Record<string, unknown>>, effects };
  } finally {
    internals.H = prev;
  }
}

describe("terminal-text feed", () => {
  it("CR LF ends a line, LF alone too, and CR then LF split across reads", () => {
    expect(all(["a\r\nb"])).toMatchObject({ lines: ["a"], current: "b" });
    expect(all(["a\nb"])).toMatchObject({ lines: ["a"], current: "b" });
    expect(all(["a\r", "\nb"])).toMatchObject({ lines: ["a"], current: "b" });
  });

  it("a lone CR returns to the start and what follows overwrites (shorter overwrite keeps the old tail)", () => {
    expect(all(["one\rtwo\r\n"]).lines).toEqual(["two"]);
    expect(all(["Downloading\rDone\r\n"]).lines).toEqual(["Doneloading"]);
    expect(all(["abc\r", "X"]).current).toBe("Xbc");
  });

  it("backspace steps back one character and stops at the start", () => {
    expect(all(["ab\bc\r\n"]).lines).toEqual(["ac"]);
    expect(all(["\b\bx"]).current).toBe("x");
  });

  it("a tab goes to the next stop of eight", () => {
    expect(all(["tab\tx"]).current).toBe("tab     x");
    expect(all(["\tx"]).current).toBe(`${" ".repeat(8)}x`);
    expect(all(["abcdefgh\tx"]).current).toBe(`abcdefgh${" ".repeat(8)}x`);
  });

  it("drops the bell and every other control character", () => {
    expect(all(["bell\x07\r\n"]).lines).toEqual(["bell"]);
    expect(all(["a\x00\x01\x0e\x0f\x7fb"]).current).toBe("ab");
  });

  it("drops CSI, OSC, two-character escapes and the C1 set, also split across reads", () => {
    expect(all(["\x1b[31mred\x1b[0m"]).current).toBe("red");
    expect(all(["\x1b[3", "1mred"]).current).toBe("red");
    expect(all(["x\x1b", "[0mY"]).current).toBe("xY");
    expect(all(["\x1b[?2004h\x1b[2J\x1b[Hok"]).current).toBe("ok");
    expect(all(["\x1b]0;title\x07ok"]).current).toBe("ok");
    expect(all(["\x1b]0;t\x1b\\ok"]).current).toBe("ok");
    expect(all(["\x1b]0;ti", "tle\x1b", "\\ok"]).current).toBe("ok");
    expect(all(["\x1b(Bx\x1b7y\x1b8"]).current).toBe("xy");
    expect(all(["a\u0085b"]).current).toBe("ab");
    expect(all(["\u009b31mred"]).current).toBe("red");
    expect(all(["\u009d0;t\u0007ok"]).current).toBe("ok");
  });

  it("an OSC that does not end within 256 characters is dropped and the text after it shows", () => {
    const s = feed(emptyText(), `\x1b]0;${"x".repeat(300)}`);
    expect(s.pending.length).toBeLessThanOrEqual(256);
    expect(feed(s, "\r\nnext\r\n").lines.at(-1)).toBe("next");
    const split = all([`\x1b]0;${"x".repeat(200)}`, "x".repeat(200), "\r\nafter"]);
    expect(split.current).toBe("after");
    expect(split.pending).toBe("");
  });

  it("wraps a line at 1000 characters", () => {
    const s = all(["a".repeat(1001)]);
    expect(s.lines).toEqual(["a".repeat(1000)]);
    expect(s.current).toBe("a");
  });

  it("keeps the last 2000 lines, says so, and gives each line a stable key", () => {
    const s = all([Array.from({ length: 2005 }, (_, i) => `${i}\r\n`).join("")]);
    expect(s.lines).toHaveLength(2000);
    expect(s.lines[0]).toBe("5");
    expect(s.base).toBe(5);
    expect(s.dropped).toBe(true);
    const next = feed(s, "more\r\n");
    expect(next.base + next.lines.indexOf("6")).toBe(s.base + s.lines.indexOf("6"));
  });

  it("ORs the server's dropped flag and never clears it", () => {
    const s = feed(emptyText(), "", true);
    expect(s.dropped).toBe(true);
    expect(feed(s, "x", false).dropped).toBe(true);
    expect(feed(emptyText(), "x").dropped).toBe(false);
  });

  it("is pure: the state passed in is not changed", () => {
    const s = feed(emptyText(), "a\r\nb");
    const copy = structuredClone(s);
    feed(s, "c\r\nd\x1b[");
    expect(s).toEqual(copy);
  });

  it("drops the characters that change text direction, also at the edge of a read; Arabic and Hebrew stay", () => {
    expect(all(["a\u202Eb\u2066c\r\n"]).lines[0]).toBe("abc");
    for (const ch of Array.from("\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069\u200E\u200F\u061C")) {
      expect(all([`x${ch}y`]).current, ch).toBe("xy");
      expect(all([`x${ch}`, `${ch}y`]).current, ch).toBe("xy");
    }
    expect(all(["مرحبا שלום\r\n"]).lines).toEqual(["مرحبا שלום"]);
  });

  it("a read that adds nothing returns the same object", () => {
    const t = all(["a\r\nb"]);
    expect(feed(t, "")).toBe(t);
    expect(feed(t, "", true)).not.toBe(t);
  });

  it("keeps markup as text", () => {
    expect(all(["<script>alert(1)</script>\r\n"]).lines).toEqual(["<script>alert(1)</script>"]);
  });

  it("reads the shapes of the captured session", () => {
    expect(all(["/var/www/html $ "]).current).toBe("/var/www/html $ ");
    const id = all(["/var/www/html $ ", "id\r\nuid=33(www-data) gid=33(www-data) groups=33(www-data)\r\n/var/www/html $ "]);
    expect(id.lines).toEqual(["/var/www/html $ id", "uid=33(www-data) gid=33(www-data) groups=33(www-data)"]);
    expect(id.current).toBe("/var/www/html $ ");
    expect(all(["sleep 100\r\n", "^C\r\n/var/www/html $ "]).lines).toEqual(["sleep 100", "^C"]);
    expect(all(["\u001b[31mred\u001b[0m \u001b[1mbold\u001b[0m\r\n"]).lines).toEqual(["red bold"]);
    expect(all(["index.php\t wp-blog-header.php\r\n"]).lines).toEqual(["index.php        wp-blog-header.php"]);
    expect(all(["città €\r\n"]).lines).toEqual(["città €"]);
  });
});

describe("terminal-session", () => {
  const read = { output: "x", cursor: 3, dropped: false, ended: null };

  it("classifyRead sorts every answer of the read route", () => {
    expect(classifyRead(200, { data: read })).toEqual({ kind: "read", read });
    expect(classifyRead(200, { data: { output: 1 } })).toEqual({ kind: "retry" });
    expect(classifyRead(404, { error: { code: "NOT_FOUND" } })).toEqual({ kind: "ended", reason: "executor_gone" });
    expect(classifyRead(401, { error: { code: "UNAUTHENTICATED" } })).toMatchObject({ kind: "refused", status: 401 });
    expect(classifyRead(403, { error: { code: "PERMISSION_DENIED" } })).toMatchObject({ kind: "refused", status: 403 });
    for (const s of [0, 500, 502, 503, 504]) expect(classifyRead(s, null)).toEqual({ kind: "retry" });
  });

  it("readRetryDelay doubles from 1 s up to 8 s", () => {
    expect([1, 2, 3, 4, 5, 9].map(readRetryDelay)).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
  });

  it("isLost after 40 s without an answer", () => {
    expect(TERMINAL_PAGE_LOST_MS).toBe(40_000);
    expect(isLost(1000, 40_999)).toBe(false);
    expect(isLost(1000, 41_000)).toBe(true);
  });

  it("inputFits counts UTF-8 bytes up to 4096", () => {
    expect(inputFits("a".repeat(4096))).toBe(true);
    expect(inputFits("a".repeat(4097))).toBe(false);
    expect(inputFits("€".repeat(1365))).toBe(true);
    expect(inputFits("€".repeat(1366))).toBe(false);
  });

  it("keyToInput: Enter sends the line, Ctrl-C only without a selection, Ctrl-D", () => {
    const k = (key: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey: boolean }> = {}) =>
      ({ key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...mods });
    expect(keyToInput(k("Enter"), "ls -l", false)).toBe("ls -l\n");
    expect(keyToInput(k("Enter"), "", false)).toBe("\n");
    expect(keyToInput(k("c", { ctrlKey: true }), "x", false)).toBe("\x03");
    expect(keyToInput(k("C", { ctrlKey: true, shiftKey: true }), "x", false)).toBe("\x03");
    expect(keyToInput(k("c", { ctrlKey: true }), "x", true)).toBeNull();
    expect(keyToInput(k("d", { ctrlKey: true }), "", false)).toBe("\x04");
    expect(keyToInput(k("c"), "", false)).toBeNull();
    expect(keyToInput(k("c", { ctrlKey: true, altKey: true }), "", false)).toBeNull();
    expect(keyToInput(k("Enter", { ctrlKey: true }), "x", false)).toBeNull();
  });

  it("terminalErrorText has the catalog sentence for every refusal, in both languages", () => {
    for (const m of [en, itMsgs] as Messages[]) {
      const e = m.admin.terminal.errors;
      const err = (code: string, reason?: string) => ({ error: { code, details: reason ? [{ message: "x", reason }] : [] } });
      expect(terminalErrorText(m, 400, err("VALIDATION_ERROR"))).toBe(e.VALIDATION_ERROR);
      expect(terminalErrorText(m, 401, err("TOTP_INVALID"))).toBe(e.TOTP_INVALID);
      expect(terminalErrorText(m, 401, err("UNAUTHENTICATED"))).toBe(e.signedOut);
      expect(terminalErrorText(m, 403, err("ACCOUNT_SETUP_INCOMPLETE"))).toBe(e.ACCOUNT_SETUP_INCOMPLETE);
      expect(terminalErrorText(m, 403, err("PERMISSION_DENIED"))).toBe(m.errors.PERMISSION_DENIED);
      expect(terminalErrorText(m, 404, err("NOT_FOUND"))).toBe(e.NOT_FOUND);
      expect(terminalErrorText(m, 423, err("ACCOUNT_LOCKED"))).toBe(e.ACCOUNT_LOCKED);
      expect(terminalErrorText(m, 503, err("DOCKER_ENGINE_UNAVAILABLE"))).toBe(e.DOCKER_ENGINE_UNAVAILABLE);
      for (const reason of TERMINAL_REFUSALS) {
        const text = terminalErrorText(m, 409, err("RESOURCE_LOCKED", reason));
        expect(text).toBe(e[reason]);
        expect(text.length).toBeGreaterThan(10);
      }
      for (const [s, body] of [[502, err("OPERATION_AMBIGUOUS")], [504, err("INTERNAL_ERROR")], [0, null], [409, err("RESOURCE_LOCKED")]] as const)
        expect(terminalErrorText(m, s, body)).toBe(e.generic);
    }
  });

  it("endText has a sentence for every end reason and for a lost page", () => {
    for (const m of [en, itMsgs] as Messages[]) {
      for (const r of [...TERMINAL_END_REASONS, "lost"] as const) {
        expect(endText(m, r)).toBe(m.admin.terminal.ended[r]);
        expect(endText(m, r).length).toBeGreaterThan(10);
      }
    }
  });

  function fakeFetch(answers: Array<{ status: number; body?: unknown } | "network">) {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fn = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      const a = answers.shift();
      if (!a || a === "network") throw new TypeError("network");
      return new Response(a.body === undefined ? null : JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
    });
    return { fn, calls };
  }

  it("runReadLoop advances the cursor, feeds each read and stops on ended", async () => {
    const { fn, calls } = fakeFetch([
      { status: 200, body: { data: { output: "a", cursor: 1, dropped: false, ended: null } } },
      { status: 200, body: { data: { output: "b", cursor: 2, dropped: false, ended: { reason: "shell_exited", at: "2026-11-17T00:00:00Z" } } } },
    ]);
    const outputs: string[] = [];
    const end = await runReadLoop({
      sessionId: SID, csrfToken: "csrf-sentinel", signal: new AbortController().signal, fetch: fn as unknown as typeof fetch,
      sleep: async () => {}, now: () => 0, onRead: (r) => outputs.push(r.output), onRetry: () => {},
    });
    expect(end).toEqual({ reason: "shell_exited" });
    expect(outputs).toEqual(["a", "b"]);
    expect(calls.map((c) => c.body)).toEqual([{ cursor: 0 }, { cursor: 1 }]);
    expect(calls[0]!.url).toBe(`/api/admin/terminal/${SID}/read`);
    expect(fn.mock.calls[0]![1]).toMatchObject({ method: "POST", headers: { "X-CSRF-Token": "csrf-sentinel" } });
  });

  it("runReadLoop stops on 401, 403 and 404", async () => {
    for (const [status, expected] of [
      [401, { status: 401, body: { error: { code: "UNAUTHENTICATED" } } }],
      [403, { status: 403, body: { error: { code: "PERMISSION_DENIED" } } }],
      [404, { reason: "executor_gone" }],
    ] as const) {
      const { fn } = fakeFetch([{ status, body: { error: { code: status === 401 ? "UNAUTHENTICATED" : status === 403 ? "PERMISSION_DENIED" : "NOT_FOUND" } } }]);
      const end = await runReadLoop({
        sessionId: SID, csrfToken: "c", signal: new AbortController().signal, fetch: fn as unknown as typeof fetch,
        sleep: async () => {}, now: () => 0, onRead: () => {}, onRetry: () => {},
      });
      expect(end).toEqual(expected);
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });

  it("runReadLoop retries with growing delays, says it is reconnecting, then recovers", async () => {
    const { fn, calls } = fakeFetch([
      { status: 503, body: { error: { code: "DOCKER_ENGINE_UNAVAILABLE" } } },
      "network",
      { status: 200, body: { data: { output: "", cursor: 0, dropped: false, ended: { reason: "idle", at: "2026-11-17T00:00:00Z" } } } },
    ]);
    const sleeps: number[] = [];
    const retry: boolean[] = [];
    const end = await runReadLoop({
      sessionId: SID, csrfToken: "c", signal: new AbortController().signal, fetch: fn as unknown as typeof fetch,
      sleep: async (ms) => void sleeps.push(ms), now: () => 0, onRead: () => retry.push(false), onRetry: () => retry.push(true),
    });
    expect(end).toEqual({ reason: "idle" });
    expect(sleeps).toEqual([1000, 2000]);
    expect(retry).toEqual([true, true, false]);
    expect(calls.map((c) => c.body)).toEqual([{ cursor: 0 }, { cursor: 0 }, { cursor: 0 }]);
  });

  it("runReadLoop counts the session lost after 40 s without an answer", async () => {
    let t = 0;
    const { fn } = fakeFetch(Array.from({ length: 20 }, () => ({ status: 504 })));
    const end = await runReadLoop({
      sessionId: SID, csrfToken: "c", signal: new AbortController().signal, fetch: fn as unknown as typeof fetch,
      sleep: async (ms) => void (t += ms), now: () => t, onRead: () => {}, onRetry: () => {},
    });
    expect(end).toEqual({ reason: "lost" });
    expect(t).toBeGreaterThanOrEqual(TERMINAL_PAGE_LOST_MS);
  });

  it("runReadLoop returns null once aborted", async () => {
    const ctl = new AbortController();
    const { fn } = fakeFetch([{ status: 200, body: { data: { output: "a", cursor: 1, dropped: false, ended: null } } }]);
    const end = await runReadLoop({
      sessionId: SID, csrfToken: "c", signal: ctl.signal, fetch: fn as unknown as typeof fetch,
      sleep: async () => {}, now: () => 0, onRead: () => ctl.abort(), onRetry: () => {},
    });
    expect(end).toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  describe("each read's own 40 s limit", () => {
    const readOk = (ended: unknown = null) => new Response(JSON.stringify({ data: { output: "", cursor: 1, dropped: false, ended } }), { status: 200 });
    // A read that answers after `ms` with `answer`, or never (null), and rejects when its signal aborts.
    const reply = (ms: number | null, answer: () => Response, signals: AbortSignal[]) => (_u: unknown, init: RequestInit) =>
      new Promise<Response>((res, rej) => {
        signals.push(init.signal!);
        init.signal!.addEventListener("abort", () => rej(new Error("aborted")));
        if (ms !== null) setTimeout(() => res(answer()), ms);
      });
    afterEach(() => void vi.useRealTimers());

    it("the caller's abort during a hanging read ends with null at once and leaves no timer or listener", async () => {
      vi.useFakeTimers();
      const ctl = new AbortController();
      const add = vi.spyOn(ctl.signal, "addEventListener");
      const remove = vi.spyOn(ctl.signal, "removeEventListener");
      const signals: AbortSignal[] = [];
      let done: unknown = "pending";
      void runReadLoop({ sessionId: SID, csrfToken: "c", signal: ctl.signal, fetch: reply(null, readOk, signals) as unknown as typeof fetch, onRead: () => {}, onRetry: () => {} }).then((v) => (done = v));
      await vi.advanceTimersByTimeAsync(10_000);
      ctl.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toBeNull();
      expect(signals[0]!.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      expect(add.mock.calls.length).toBeGreaterThan(0);
      expect(remove.mock.calls.map((c) => c[1])).toEqual(add.mock.calls.map((c) => c[1]));
    });

    it("a read answered just before the limit is not cut", async () => {
      vi.useFakeTimers();
      const signals: AbortSignal[] = [];
      let done: unknown = "pending";
      const idle = () => readOk({ reason: "idle", at: "2026-11-17T00:00:00Z" });
      void runReadLoop({ sessionId: SID, csrfToken: "c", signal: new AbortController().signal, fetch: reply(TERMINAL_PAGE_LOST_MS - 1, idle, signals) as unknown as typeof fetch, onRead: () => {}, onRetry: () => {} }).then((v) => (done = v));
      await vi.advanceTimersByTimeAsync(TERMINAL_PAGE_LOST_MS - 1);
      expect(done).toEqual({ reason: "idle" });
      expect(signals[0]!.aborted).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("an answer at 30 s then a hanging read is lost 40 s after that answer (70 s), with no retry first", async () => {
      vi.useFakeTimers();
      const signals: AbortSignal[] = [];
      let n = 0;
      const fetchFn = (u: unknown, init: RequestInit) => reply(n++ === 0 ? 30_000 : null, readOk, signals)(u, init);
      let done: unknown = "pending";
      const retries = vi.fn();
      void runReadLoop({ sessionId: SID, csrfToken: "c", signal: new AbortController().signal, fetch: fetchFn as unknown as typeof fetch, onRead: () => {}, onRetry: retries }).then((v) => (done = v));
      await vi.advanceTimersByTimeAsync(30_000 + TERMINAL_PAGE_LOST_MS - 1);
      expect(done).toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toEqual({ reason: "lost" });
      expect(signals[1]!.aborted).toBe(true);
      expect(retries).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe("terminal BFF routes", () => {
  const req = (headers: Record<string, string> = {}, body: unknown = {}) =>
    new Request("http://localhost:3000/x", {
      method: "POST",
      headers: { Host: "localhost:3000", Origin: "http://localhost:3000", "X-CSRF-Token": "csrf", ...headers },
      body: JSON.stringify(body),
    });
  const site = (siteId = "s1") => ({ params: Promise.resolve({ siteId }) });
  const sess = (sessionId = SID) => ({ params: Promise.resolve({ sessionId }) });
  const routes = [
    ["write", writeRoute, 8000],
    ["read", readRoute, 40000],
    ["close", closeRoute, 8000],
  ] as const;

  beforeEach(() => {
    fetchUpstream.mockReset();
    getSessionFromRequest.mockReset().mockResolvedValue({ accessToken: "tok-sentinel", csrfToken: "csrf" });
  });

  it("open forwards the code with 40 s and passes 201 on", async () => {
    fetchUpstream.mockResolvedValue({ ok: true, status: 201, data: { data: { sessionId: SID } } });
    const res = await openRoute(req({}, { code: "123456" }), site());
    expect(res.status).toBe(201);
    expect(fetchUpstream).toHaveBeenCalledWith("v1/admin/sites/s1/terminal", expect.objectContaining({ method: "POST", body: { code: "123456" }, timeoutMs: 40000, accessToken: "tok-sentinel" }));
  });

  it.each(routes)("%s forwards to the session's route with its own time limit", async (name, route, timeoutMs) => {
    fetchUpstream.mockResolvedValue(name === "read" ? { ok: true, status: 200, data: { data: { output: "", cursor: 0, dropped: false, ended: null } } } : { ok: true, status: 204 });
    const body = name === "write" ? { input: "ls\n" } : name === "read" ? { cursor: 4 } : {};
    const res = await route(req({}, body), sess());
    expect(res.status).toBe(name === "read" ? 200 : 204);
    expect(fetchUpstream).toHaveBeenCalledWith(`v1/admin/terminal/${SID}/${name}`, expect.objectContaining({ method: "POST", timeoutMs }));
  });

  it("refuses a missing or wrong CSRF token, a foreign origin and no session before the upstream", async () => {
    const calls = [
      () => openRoute(req({ "X-CSRF-Token": "bad" }, { code: "123456" }), site()),
      () => openRoute(req({ Origin: "http://evil.example.test" }, { code: "123456" }), site()),
      ...routes.map(([, r]) => () => r(req({ "X-CSRF-Token": "bad" }), sess())),
      ...routes.map(([, r]) => () => r(req({ Origin: "http://evil.example.test" }), sess())),
    ];
    for (const call of calls) expect((await call()).status).toBe(403);
    getSessionFromRequest.mockResolvedValue(null);
    expect((await openRoute(req({}, { code: "123456" }), site())).status).toBe(401);
    for (const [, r] of routes) expect((await r(req(), sess())).status).toBe(401);
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("refuses a path segment of a wrong shape before the upstream", async () => {
    for (const bad of ["a.b", "a/b", "", "x".repeat(129)]) expect((await openRoute(req({}, { code: "123456" }), site(bad))).status).toBe(400);
    for (const bad of ["s1", "term_xyz", `term_${"AB".repeat(16)}`, `${SID}0`, "../x"])
      for (const [, r] of routes) expect((await r(req(), sess(bad))).status).toBe(400);
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("passes an upstream error on with its code and details", async () => {
    const error = { error: { code: "RESOURCE_LOCKED", message: "m", requestId: "r", retryable: false, details: [{ message: "m", reason: "site_busy" }] } };
    fetchUpstream.mockResolvedValue({ ok: false, status: 409, error });
    const res = await openRoute(req({}, { code: "123456" }), site());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(error);
    fetchUpstream.mockResolvedValue({ ok: false, status: 503, error: { error: { code: "DOCKER_ENGINE_UNAVAILABLE", message: "m", details: [] } } });
    const r2 = await readRoute(req({}, { cursor: 0 }), sess());
    expect(r2.status).toBe(503);
    expect((await r2.json()).error.code).toBe("DOCKER_ENGINE_UNAVAILABLE");
  });
});

describe("terminal page and console", () => {
  const sources = [
    "src/lib/terminal-text.ts",
    "src/lib/terminal-session.ts",
    "src/components/admin/terminal-console.tsx",
    "src/app/admin/sites/[siteId]/terminal/page.tsx",
    "src/app/api/admin/sites/[siteId]/terminal/route.ts",
    "src/app/api/admin/terminal/[sessionId]/write/route.ts",
    "src/app/api/admin/terminal/[sessionId]/read/route.ts",
    "src/app/api/admin/terminal/[sessionId]/close/route.ts",
  ].map((p) => [p, readFileSync(join(__dirname, "..", p), "utf8")] as const);

  it("no file writes output or input to markup, console, storage or a URL query", () => {
    for (const [p, src] of sources) {
      for (const bad of ["dangerouslySetInnerHTML", "innerHTML", "console.", "localStorage", "sessionStorage", "document.cookie", "?input=", "?output="])
        expect(src, `${p} contains ${bad}`).not.toContain(bad);
    }
  });

  it("the command input has autocomplete, spell check and capitals off; close uses keepalive on pagehide", () => {
    const src = sources.find(([p]) => p.endsWith("terminal-console.tsx"))![1];
    for (const s of ['autoComplete="off"', "spellCheck={false}", 'autoCapitalize="off"', "keepalive: true", '"pagehide"'])
      expect(src).toContain(s);
  });

  it("a page shown again from the back/forward cache reloads itself; the listener leaves with pagehide's", () => {
    const reload = vi.fn();
    const win = Object.assign(new EventTarget(), { location: { reload } });
    vi.stubGlobal("window", win);
    try {
      const cleanup = withHooks(TerminalConsole, { siteId: "s1", csrfToken: "csrf" }).effects[0]!();
      const show = (persisted: boolean) => win.dispatchEvent(Object.assign(new Event("pageshow"), { persisted }));
      show(false);
      expect(reload).not.toHaveBeenCalled();
      show(true);
      expect(reload).toHaveBeenCalledTimes(1);
      cleanup?.();
      show(true);
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("the output follows new text only when it was at the end; the box is named and reachable from the keyboard", () => {
    const box = { scrollTop: 0, scrollHeight: 500, clientHeight: 100 };
    const refs = { 0: { current: box } };
    const render = (output: string) => {
      const { tree, effects } = withHooks(TerminalOutput, { text: feed(emptyText(), output), label: "Output" }, refs);
      for (const e of effects) e();
      return tree;
    };
    const tree = render("a");
    expect(box.scrollTop).toBe(500);
    expect(tree.props).toMatchObject({ tabIndex: 0, role: "region", "aria-label": "Output" });
    box.scrollTop = 100;
    (tree.props.onScroll as (e: unknown) => void)({ currentTarget: box });
    box.scrollHeight = 600;
    render("b");
    expect(box.scrollTop).toBe(100);
    box.scrollTop = 485;
    (tree.props.onScroll as (e: unknown) => void)({ currentTarget: box });
    render("c");
    expect(box.scrollTop).toBe(600);
  });

  it("a lost session gets the same best-effort close as leaving, then the end shows", () => {
    const src = sources.find(([p]) => p.endsWith("terminal-console.tsx"))![1];
    const afterLoop = src.slice(src.indexOf("await runReadLoop("), src.indexOf("function send("));
    expect(afterLoop).toMatch(/ended\.reason === "lost"\) void leave\(\);[\s\S]*end\(/);
  });

  it("output renders only as text: finished lines in a polite log, the line in progress outside it", () => {
    const text = feed(emptyText(), "<script>alert(1)</script>\r\n<b>bold</b> $ ");
    const html = wrap(en, createElement(TerminalOutput, { text, label: en.admin.terminal.outputLabel }));
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    const log = html.match(/<div[^>]*role="log"[^>]*>([\s\S]*?)<\/div><\/div>/);
    expect(log?.[0]).toContain('aria-live="polite"');
    expect(log?.[0]).toContain('aria-relevant="additions"');
    expect(log?.[0]).toContain(`aria-label="${en.admin.terminal.outputLabel}"`);
    expect(log?.[0]).not.toContain("&lt;b&gt;bold");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt; $ ");
  });

  it("the console starts on the code field with every sentence of the page, in both languages", () => {
    for (const m of [en, itMsgs] as Messages[]) {
      const html = wrap(m, createElement(TerminalConsole, { siteId: "s1", csrfToken: "csrf" })).replaceAll("&#x27;", "'");
      for (const s of [m.admin.terminal.intro, m.admin.terminal.limits, m.admin.terminal.codeOnce, m.admin.terminal.open, m.login.totp])
        expect(html).toContain(s);
      expect(html).toContain('autoComplete="one-time-code"');
      expect(html).toContain('inputMode="numeric"');
      expect(html).not.toContain('role="log"');
    }
  });

  it("the page shows the console for an existing site, notFound for an unknown one, LoadError on failure", async () => {
    getServerSession.mockResolvedValue({ csrfToken: "csrf" });
    fetchServerAdminSites.mockResolvedValue({ sites: [{ id: "s1", name: "wp-a.example.test" }], customers: [], certificateAlerts: [] });
    const el = await TerminalPage({ params: Promise.resolve({ siteId: "s1" }) });
    expect(isValidElement(el)).toBe(true);
    const html = wrap(en, el as ReactElement);
    expect(html).toContain("Terminal: wp-a.example.test");
    expect(html).toContain('href="/admin/sites"');
    expect(html).toContain(en.admin.terminal.back);

    notFound.mockImplementation(() => { throw new Error("NEXT_NOT_FOUND"); });
    await expect(TerminalPage({ params: Promise.resolve({ siteId: "s2" }) })).rejects.toThrow("NEXT_NOT_FOUND");

    fetchServerAdminSites.mockResolvedValue(null);
    const err = await TerminalPage({ params: Promise.resolve({ siteId: "s1" }) });
    expect(wrap(en, err as ReactElement)).toContain('role="alert"');

    getServerSession.mockResolvedValue(null);
    redirect.mockImplementation(() => { throw new Error("NEXT_REDIRECT"); });
    await expect(TerminalPage({ params: Promise.resolve({ siteId: "s1" }) })).rejects.toThrow("NEXT_REDIRECT");
    expect(redirect).toHaveBeenCalledWith("/login");
  });

  it("the sites table links to the terminal only for ready and degraded sites", () => {
    const mk = (id: string, status: AdminSiteDto["status"]) =>
      ({ id, name: `wp-${id}.example.test`, status, primaryDomain: null, owner: null, phpVersion: "8.4" }) as unknown as AdminSiteDto;
    const sites = [mk("a", "ready"), mk("b", "degraded"), mk("c", "stopped"), mk("d", "deploying"), mk("e", "maintenance")];
    const html = wrap(en, createElement(SitesTable, { sites, customers: [], csrfToken: "csrf" }));
    expect(html).toContain('href="/admin/sites/a/terminal"');
    expect(html).toContain('href="/admin/sites/b/terminal"');
    for (const id of ["c", "d", "e"]) expect(html).not.toContain(`href="/admin/sites/${id}/terminal"`);
    expect(html).toContain('aria-label="Open the terminal of wp-a.example.test"');
  });
});
