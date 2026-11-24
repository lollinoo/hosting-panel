import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, type ReactElement } from "react";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";

const fetchUpstream = vi.fn();
vi.mock("@/lib/upstream", () => ({ fetchUpstream: (...a: unknown[]) => fetchUpstream(...a) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/login" }));
// Lets one test render the login form at its second step: useState(false) starts true.
const force = vi.hoisted(() => ({ falseIsTrue: false }));
vi.mock("react", async (orig) => {
  const actual = await orig<typeof import("react")>();
  const useState = ((init: unknown) =>
    actual.useState(force.falseIsTrue && init === false ? true : init)) as typeof actual.useState;
  return { ...actual, useState, default: { ...actual, useState } };
});

import { POST as requestRoute } from "@/app/api/session/password-reset/request/route";
import { POST as confirmRoute } from "@/app/api/session/password-reset/confirm/route";
import { ForgotPasswordForm, ForgotPasswordView, requestResetLink } from "@/components/auth/forgot-password-form";
import {
  ResetPasswordForm,
  ResetPasswordView,
  confirmReset,
  takeFragmentToken,
} from "@/components/auth/reset-password-form";
import { LoginForm } from "@/components/auth/login-form";
import { I18nProvider } from "@/i18n/provider";

const LOCALES = [["en", en], ["it", itMsgs]] as const;
const TOKEN = "SENTINEL-reset-token-0123456789";
const esc = (s: string) => s.replace(/'/g, "&#x27;");
// The opening tag of the status box: it takes the focus when it replaces the form.
const statusTag = (html: string) => html.match(/<[^>]*role="status"[^>]*>/)?.[0] ?? "";
const render = (el: ReactElement, locale: "en" | "it" = "en") =>
  renderToStaticMarkup(createElement(I18nProvider, { locale, messages: locale === "en" ? en : itMsgs, children: el }));
const post = (body: string, headers: Record<string, string> = {}) =>
  new Request("http://localhost:3000/x", {
    method: "POST",
    headers: { Host: "localhost:3000", Origin: "http://localhost:3000", "Content-Type": "application/json", ...headers },
    body,
  });

describe("password-reset BFF routes", () => {
  beforeEach(() => fetchUpstream.mockReset());

  it("request forwards only {email}, with no session token, and passes the 202 through", async () => {
    fetchUpstream.mockResolvedValue({ ok: true, status: 202, data: null });
    const res = await requestRoute(
      post(JSON.stringify({ email: "someone@example.test", accessToken: "x", role: "server_admin" }), { Cookie: "hp_session=abc" }),
    );
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
    expect(res.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(fetchUpstream).toHaveBeenCalledTimes(1);
    const [path, opts] = fetchUpstream.mock.calls[0]!;
    expect(path).toBe("v1/auth/password-reset/request");
    expect(opts).toEqual({ method: "POST", body: { email: "someone@example.test" } });
  });

  it("confirm forwards only {token, newPassword} and passes 204 and 400 through", async () => {
    fetchUpstream.mockResolvedValue({ ok: true, status: 204 });
    const ok = await confirmRoute(post(JSON.stringify({ token: TOKEN, newPassword: "SENTINEL-new-pass", extra: 1 }), { Cookie: "hp_session=abc" }));
    expect(ok.status).toBe(204);
    expect(fetchUpstream).toHaveBeenCalledWith("v1/auth/password-reset/confirm", {
      method: "POST",
      body: { token: TOKEN, newPassword: "SENTINEL-new-pass" },
    });
    fetchUpstream.mockResolvedValue({ ok: false, status: 400, error: { error: { code: "PASSWORD_RESET_INVALID", message: "x" } } });
    const bad = await confirmRoute(post(JSON.stringify({ token: TOKEN, newPassword: "SENTINEL-new-pass" })));
    expect(bad.status).toBe(400);
    const text = await bad.text();
    expect(JSON.parse(text).error.code).toBe("PASSWORD_RESET_INVALID");
    expect(text).not.toContain(TOKEN);
  });

  for (const [name, route] of [["request", requestRoute], ["confirm", confirmRoute]] as const) {
    it(`${name}: a body that is not JSON, empty or over the bound is refused before the upstream`, async () => {
      expect((await route(post("{not json"))).status).toBe(400);
      expect((await route(post(""))).status).toBe(400);
      expect((await route(post(JSON.stringify({ email: "a".repeat(1_100_000) })))).status).toBe(413);
      expect(fetchUpstream).not.toHaveBeenCalled();
    });

    it(`${name}: a foreign Origin, a missing Origin and a body not sent as JSON are refused before the upstream (L46)`, async () => {
      const body = JSON.stringify({ email: "someone@example.test", token: TOKEN, newPassword: "SENTINEL-new-pass" });
      const foreign = await route(post(body, { Origin: "https://evil.example.test" }));
      expect(foreign.status).toBe(403);
      expect((await foreign.json()).error.code).toBe("PERMISSION_DENIED");
      const missing = await route(
        new Request("http://localhost:3000/x", { method: "POST", headers: { Host: "localhost:3000", "Content-Type": "application/json" }, body }),
      );
      expect(missing.status).toBe(403);
      // What a cross-site form can send without a preflight.
      for (const type of ["text/plain", "application/x-www-form-urlencoded"]) {
        const res = await route(post(body, { "Content-Type": type }));
        expect(res.status, type).toBe(415);
        expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
      }
      expect(fetchUpstream).not.toHaveBeenCalled();
    });

    it(`${name}: a JSON body that is no object (null, a string, a number, an array) is refused before the upstream`, async () => {
      for (const body of ["null", '"someone@example.test"', "42", "[]"]) {
        const res = await route(post(body));
        expect(res.status).toBe(400);
        expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
      }
      expect(fetchUpstream).not.toHaveBeenCalled();
    });
  }

  it("request passes an upstream failure through with its status and code", async () => {
    fetchUpstream.mockResolvedValue({ ok: false, status: 429, error: { error: { code: "RATE_LIMITED", message: "x" } } });
    const res = await requestRoute(post(JSON.stringify({ email: "someone@example.test" })));
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe("RATE_LIMITED");
  });
});

describe("forgot-password form", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("posts only {email} to the BFF", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
    await requestResetLink(en, "someone@example.test");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/session/password-reset/request");
    expect(JSON.parse(init.body)).toEqual({ email: "someone@example.test" });
  });

  for (const [locale, m] of LOCALES) {
    it(`${locale}: after a 202 the markup is the same for any address and never names it`, async () => {
      const views: string[] = [];
      for (const email of ["known@example.test", "nobody@example.test"]) {
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 202 }));
        const state = await requestResetLink(m, email);
        views.push(render(createElement(ForgotPasswordView, { ...state, email, busy: false, onEmail: () => {}, onSubmit: () => {} }), locale));
      }
      expect(views[0]).toBe(views[1]);
      expect(views[0]).not.toContain("example.test");
      expect(views[0]).toContain(esc(m.login.forgot.sent));
      expect(views[0]).toContain(esc(m.login.forgot.noMail));
      expect(views[0]).toContain('href="/login"');
      expect(views[0]).not.toContain("<input");
    });

    it(`${locale}: the status box that replaces the form (and its focused button) can take the focus`, async () => {
      const before = render(createElement(ForgotPasswordView, { sent: false, error: null, email: "", busy: false, onEmail: () => {}, onSubmit: () => {} }), locale);
      expect(before).toContain('type="submit"');
      expect(statusTag(before)).toBe("");
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 202 }));
      const state = await requestResetLink(m, "someone@example.test");
      const after = render(createElement(ForgotPasswordView, { ...state, email: "", busy: false, onEmail: () => {}, onSubmit: () => {} }), locale);
      expect(after).not.toContain('type="submit"');
      expect(statusTag(after)).toContain('tabindex="-1"');
    });

    it(`${locale}: an address the API refuses gets a sentence of its own, the same for every address`, async () => {
      const states = [];
      for (const email of ["known@example", "nobody@example"]) {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "VALIDATION_ERROR" } }), { status: 400 }));
        states.push(await requestResetLink(m, email));
      }
      expect(states[0]).toEqual({ sent: false, error: m.login.forgot.badEmail });
      expect(states[1]).toEqual(states[0]);
      expect(m.login.forgot.badEmail).not.toBe(m.errors.VALIDATION_ERROR);
    });

    it(`${locale}: another status shows the error text and keeps the form`, async () => {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "RATE_LIMITED" } }), { status: 429 }));
      const state = await requestResetLink(m, "someone@example.test");
      expect(state).toEqual({ sent: false, error: m.errors.RATE_LIMITED });
      fetchMock.mockRejectedValueOnce(new Error("offline"));
      expect(await requestResetLink(m, "someone@example.test")).toEqual({ sent: false, error: m.errors.generic });
      const html = render(createElement(ForgotPasswordView, { ...state, email: "someone@example.test", busy: false, onEmail: () => {}, onSubmit: () => {} }), locale);
      expect(html).toContain("<input");
      expect(html).toContain(esc(m.errors.RATE_LIMITED));
      expect(html).not.toContain(esc(m.login.forgot.sent));
    });

    it(`${locale}: the form renders its title, intro and field`, () => {
      const html = render(createElement(ForgotPasswordForm), locale);
      for (const s of [m.login.forgot.title, m.login.forgot.intro, m.login.forgot.email, m.login.forgot.submit]) expect(html).toContain(esc(s));
    });
  }
});

describe("reset-password form", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reads the token from the fragment once and takes the fragment out of the address bar", () => {
    const replaceState = vi.fn();
    vi.stubGlobal("window", { location: { hash: `#${TOKEN}`, pathname: "/reset-password" }, history: { replaceState } });
    expect(takeFragmentToken()).toBe(TOKEN);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/reset-password");
    expect(JSON.stringify(replaceState.mock.calls)).not.toContain(TOKEN);
    vi.stubGlobal("window", { location: { hash: "", pathname: "/reset-password" }, history: { replaceState } });
    expect(takeFragmentToken()).toBe("");
  });

  it("sends the token only in the body of the confirm call", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    expect(await confirmReset(en, TOKEN, "SENTINEL-new-pass")).toEqual({ token: TOKEN, done: true, error: null });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/session/password-reset/confirm");
    expect(JSON.stringify(init.headers ?? {})).not.toContain(TOKEN);
    expect(JSON.parse(init.body)).toEqual({ token: TOKEN, newPassword: "SENTINEL-new-pass" });
  });

  it("a token longer than the confirm schema allows is an invalid link, taken out of the address bar and never sent", () => {
    const replaceState = vi.fn();
    const long = "a".repeat(129);
    vi.stubGlobal("window", { location: { hash: `#${long}`, pathname: "/reset-password" }, history: { replaceState } });
    expect(takeFragmentToken()).toBe("");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/reset-password");
    const html = render(createElement(ResetPasswordView, { token: "", done: false, error: null, busy: false, onSubmit: () => {} }));
    expect(html).toContain(esc(en.errors.PASSWORD_RESET_INVALID));
    expect(html).not.toContain("<form");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a token of exactly 128 characters is read and sent as before", async () => {
    const edge = "a".repeat(128);
    vi.stubGlobal("window", { location: { hash: `#${edge}`, pathname: "/reset-password" }, history: { replaceState: vi.fn() } });
    expect(takeFragmentToken()).toBe(edge);
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    expect(await confirmReset(en, edge, "SENTINEL-new-pass")).toEqual({ token: edge, done: true, error: null });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).token).toBe(edge);
  });

  for (const [locale, m] of LOCALES) {
    const view = (state: { token: string | null; done: boolean; error: string | null }) =>
      render(createElement(ResetPasswordView, { ...state, busy: false, onSubmit: () => {} }), locale);

    it(`${locale}: a refused token shows the error and the way to a new link`, async () => {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "PASSWORD_RESET_INVALID" } }), { status: 400 }));
      const state = await confirmReset(m, TOKEN, "SENTINEL-new-pass");
      expect(state.token).toBe("");
      const html = view(state);
      expect(html).toContain(esc(m.errors.PASSWORD_RESET_INVALID));
      expect(html).toContain('href="/forgot-password"');
      expect(html).toContain(esc(m.login.reset.requestNew));
      expect(html).not.toContain('type="password"');
      expect(view({ token: "", done: false, error: null })).toBe(html);
    });

    it(`${locale}: a password that breaks the rule shows the rule and keeps the token`, async () => {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "VALIDATION_ERROR" } }), { status: 400 }));
      const state = await confirmReset(m, TOKEN, "short");
      expect(state).toEqual({ token: TOKEN, done: false, error: m.account.passwordRule });
      const html = view(state);
      expect(html).toContain('type="password"');
      expect(html).toContain('role="alert"');
      expect(html).not.toContain(esc(m.errors.PASSWORD_RESET_INVALID));
      expect(html).not.toContain(TOKEN);
    });

    it(`${locale}: done shows the sign-in link; before the fragment is read nothing is claimed`, () => {
      const done = view({ token: TOKEN, done: true, error: null });
      expect(done).toContain(esc(m.login.reset.done));
      expect(done).toContain('href="/login"');
      expect(done).not.toContain(TOKEN);
      // The form and its focused button are gone: the done text takes the focus.
      expect(done).not.toContain('type="submit"');
      expect(statusTag(done)).toContain('tabindex="-1"');
      expect(statusTag(view({ token: TOKEN, done: false, error: null }))).toBe("");
      const loading = render(createElement(ResetPasswordForm), locale);
      expect(loading).toContain(esc(m.login.reset.title));
      expect(loading).not.toContain(esc(m.errors.PASSWORD_RESET_INVALID));
      expect(loading).not.toContain('type="password"');
    });
  }
});

describe("login form link", () => {
  afterEach(() => (force.falseIsTrue = false));

  for (const [locale, m] of LOCALES) {
    it(`${locale}: the link to the forgot page shows only before the second step`, () => {
      const first = render(createElement(LoginForm), locale);
      expect(first).toContain('href="/forgot-password"');
      expect(first).toContain(esc(m.login.forgotLink));
      force.falseIsTrue = true;
      const second = render(createElement(LoginForm), locale);
      expect(second).toContain(m.login.totpHint);
      expect(second).not.toContain('href="/forgot-password"');
    });
  }
});
