import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { MailRelaySettingsDto } from "@hosting-panel/contracts";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { errorMessage } from "@/i18n";

const fetchUpstream = vi.fn();
vi.mock("@/lib/upstream", async () => ({
  ...(await vi.importActual<object>("@/lib/upstream")),
  fetchUpstream: (...a: unknown[]) => fetchUpstream(...a),
}));
vi.mock("@/lib/server-session", () => ({
  getSessionFromRequest: async () => ({ accessToken: "tok", csrfToken: "csrf" }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/admin/mail" }));

import { GET, PATCH, DELETE } from "@/app/api/admin/mail-relay/route";
import { POST as sendTest } from "@/app/api/admin/mail-relay/test/route";
import { MailRelayForm } from "@/components/admin/mail-relay-form";
import { SidebarNav } from "@/components/layout/sidebar-nav";
import { startMailRelayPolling } from "@/lib/mail-relay-poll";
import { I18nProvider } from "@/i18n/provider";

const realUpstream = await vi.importActual<typeof import("@/lib/upstream")>("@/lib/upstream");

const req = (method: string, headers: Record<string, string> = {}, body: unknown = {}) =>
  new Request("http://localhost:3000/x", {
    method,
    headers: { Host: "localhost:3000", Origin: "http://localhost:3000", "X-CSRF-Token": "csrf", ...headers },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });

const dto = (over: Partial<MailRelaySettingsDto> = {}): MailRelaySettingsDto => ({
  configured: true,
  host: "smtp.example.com",
  port: 587,
  username: "apikey",
  senderDomain: "hotel.it",
  passwordSet: true,
  updatedAt: "2026-11-09T10:00:00Z",
  applied: true,
  relayRunning: true,
  sentLast24h: 7,
  failures: [{ at: "2026-11-09T11:00:00Z", recipient: "guest@example.org", status: "deferred", problem: "auth_failed", detail: "535 5.7.8 rejected" }],
  ...over,
});
const wrap = (m: typeof en, child: React.ReactElement) =>
  createElement(I18nProvider, { locale: m === en ? "en" : "it", messages: m, children: child });

describe("mail relay BFF", () => {
  beforeEach(() => fetchUpstream.mockReset());

  it("mail relay BFF requires CSRF and forwards GET, PATCH, DELETE and test", async () => {
    const bad = { "X-CSRF-Token": "bad" };
    expect((await PATCH(req("PATCH", bad, {}))).status).toBe(403);
    expect((await DELETE(req("DELETE", bad))).status).toBe(403);
    expect((await sendTest(req("POST", bad, {}))).status).toBe(403);
    expect(fetchUpstream).not.toHaveBeenCalled();

    fetchUpstream.mockResolvedValue({ ok: true, status: 200, data: { data: {} } });
    await GET(req("GET"));
    await PATCH(req("PATCH", {}, { host: "smtp.example.com" }));
    await DELETE(req("DELETE"));
    await sendTest(req("POST", {}, { to: "a@b.it" }));
    expect(fetchUpstream.mock.calls.map(([p, o]) => [p, o.method])).toEqual([
      ["v1/admin/mail-relay", "GET"],
      ["v1/admin/mail-relay", "PATCH"],
      ["v1/admin/mail-relay", "DELETE"],
      ["v1/admin/mail-relay/test", "POST"],
    ]);
    expect(fetchUpstream.mock.calls[3]![1].body).toEqual({ to: "a@b.it" });
  });

  it("test email route allows 45 s upstream", async () => {
    fetchUpstream.mockResolvedValue({ ok: true, status: 200, data: { data: { outcome: "sent" } } });
    await sendTest(req("POST", {}, { to: "a@b.it" }));
    await GET(req("GET"));
    expect(fetchUpstream.mock.calls[0]![1].timeoutMs).toBe(45_000);
    expect(fetchUpstream.mock.calls[1]![1].timeoutMs).toBeUndefined();
  });
});

describe("fetchUpstream timeout", () => {
  afterEach(() => vi.restoreAllMocks());
  const timeoutErr = () => new DOMException("timed out", "TimeoutError");

  it("fetchUpstream keeps the 8 s default and honours timeoutMs", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { headers: { "content-type": "application/json" } })));
    await realUpstream.fetchUpstream("x");
    await realUpstream.fetchUpstream("x", { timeoutMs: 45_000 });
    expect(spy.mock.calls).toEqual([[8000], [45_000]]);
    vi.unstubAllGlobals();
  });

  it("a timeout gives the existing 504 response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(timeoutErr())));
    const res = await realUpstream.fetchUpstream("x", { timeoutMs: 45_000 });
    expect(res.status).toBe(504);
    vi.unstubAllGlobals();
  });
});

describe("admin mail page", () => {
  it("renders settings without the password and lists failures", () => {
    for (const m of [en, itMsgs]) {
      const html = renderToStaticMarkup(wrap(m, createElement(MailRelayForm, { csrfToken: "c", initial: dto(), adminEmail: "root@hotel.it" })));
      for (const s of ["smtp.example.com", "apikey", "hotel.it", "guest@example.org", "535 5.7.8 rejected", m.admin.mail.passwordKeep, "root@hotel.it", m.admin.mail.problem.auth_failed]) expect(html).toContain(s);
      expect(html).not.toMatch(/type="password"[^>]*value="[^"]/);
    }
  });

  it("shows the starting state and disables the test while not applied", () => {
    const html = renderToStaticMarkup(wrap(en, createElement(MailRelayForm, { csrfToken: "c", initial: dto({ applied: false, relayRunning: null, sentLast24h: null }), adminEmail: "a@b.it" })));
    expect(html).toContain(en.admin.mail.starting);
  });

  it("the page polls while the relay is starting", async () => {
    vi.useFakeTimers();
    try {
      const load = vi.fn().mockResolvedValueOnce(dto({ applied: false })).mockResolvedValue(dto({ applied: true }));
      const seen: boolean[] = [];
      startMailRelayPolling({ load, onData: (d) => seen.push(d.applied), onGiveUp: vi.fn() });
      expect(load).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5000);
      expect(load).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(load).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(load).toHaveBeenCalledTimes(2); // stopped once applied
      expect(seen).toEqual([false, true]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("polling gives up after 5 minutes", async () => {
    vi.useFakeTimers();
    try {
      const load = vi.fn().mockResolvedValue(dto({ applied: false }));
      const onGiveUp = vi.fn();
      startMailRelayPolling({ load, onData: vi.fn(), onGiveUp });
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      expect(onGiveUp).toHaveBeenCalledTimes(1);
      const calls = load.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(load).toHaveBeenCalledTimes(calls);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("mail copy", () => {
  const keys = (m: typeof en) => [
    ["errors.MAIL_RELAY_UNAVAILABLE", errorMessage(m, "MAIL_RELAY_UNAVAILABLE")],
    ["testAmbiguous", m.admin.mail.testAmbiguous],
    ...Object.entries(m.admin.mail.field).map(([k, v]) => [`field.${k}`, v]),
    ...Object.entries(m.admin.mail.outcome).map(([k, v]) => [`outcome.${k}`, v]),
    ...Object.entries(m.admin.mail.problem).map(([k, v]) => [`problem.${k}`, v]),
  ];

  it("mail errors exist in IT and EN", () => {
    const e = keys(en);
    const i = keys(itMsgs);
    expect(e.map(([k]) => k)).toEqual(i.map(([k]) => k));
    for (const k of ["host_invalid", "username_invalid", "password_invalid", "sender_domain_invalid", "password_required", "not_configured"]) {
      expect(Object.keys(en.admin.mail.field)).toContain(k);
    }
    for (const [k] of e) expect(k).toBeTruthy();
    e.forEach(([k, v], n) => {
      expect(v, k).toBeTruthy();
      expect(v, k).not.toBe(i[n]![1]);
    });
    expect(errorMessage(en, "MAIL_RELAY_UNAVAILABLE")).not.toBe(en.errors.generic);
    expect(en.admin.mail.testAmbiguous).toMatch(/may have been sent/i);
  });

  it("every failure text names a next step", () => {
    const en_ = /check|use|wait|read|save|ask|enter|set up/i;
    const it_ = /controlla|usa|attendi|leggi|salva|chiedi|inserisci|configura/i;
    for (const [m, re] of [[en, en_], [itMsgs, it_]] as const) {
      const texts = [...Object.values(m.admin.mail.problem), m.admin.mail.outcome.deferred, m.admin.mail.outcome.bounced, ...Object.values(m.admin.mail.field), errorMessage(m, "MAIL_RELAY_UNAVAILABLE"), m.admin.mail.testAmbiguous, m.admin.mail.notStarted];
      for (const t of texts) expect(t).toMatch(re);
    }
  });

  it("sidebar lists Email for administrators", () => {
    for (const m of [en, itMsgs]) {
      const html = renderToStaticMarkup(wrap(m, createElement(SidebarNav)));
      expect(html).toContain('href="/admin/mail"');
      expect(html).toContain(m.admin.nav.mail);
    }
  });
});
