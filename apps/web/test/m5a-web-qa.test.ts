// Independent QA of the web side of M5a: public reset pages, administrator dialog, support view,
// texts, and the fit between the screens, the BFF routes, openapi.yaml and the API controllers.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, type ReactElement } from "react";
import {
  CreateAdministratorInputSchema,
  CreateAdministratorResultDtoSchema,
  PasswordResetConfirmInputSchema,
  PasswordResetRequestInputSchema,
  SupportAccessDtoSchema,
  type AdminUserDto,
  type MeDto,
} from "@hosting-panel/contracts";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";

const sessionFor = vi.fn();
const getServerSession = vi.fn();
const fetchServerMe = vi.fn();
const refresh = vi.fn();
vi.mock("@/lib/server-session", () => ({
  getSessionFromRequest: (req: Request) => sessionFor(req),
  getServerSession: () => getServerSession(),
}));
vi.mock("@/lib/server-api", () => ({
  fetchServerMe: () => fetchServerMe(),
  fetchServerOrgSites: vi.fn(async () => []),
  fetchServerOrgSite: vi.fn(async () => ({ ok: false, outcome: "notFound" })),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  useRouter: () => ({ push: vi.fn(), refresh }),
  usePathname: () => "/x",
  useParams: () => ({}),
}));
// The dialog's open state is driven by hand: the mock keeps the latest onOpenChange.
const dialog = vi.hoisted(() => ({ onOpenChange: null as null | ((open: boolean) => void) }));
vi.mock("@/components/ui/dialog", () => {
  const pass = ({ children }: { children?: unknown }) => children ?? null;
  return {
    Dialog: ({ open, onOpenChange, children }: { open: boolean; onOpenChange: (o: boolean) => void; children?: unknown }) => {
      dialog.onOpenChange = onOpenChange;
      return open ? (children ?? null) : null;
    },
    DialogContent: pass,
    DialogDescription: pass,
    DialogFooter: pass,
    DialogHeader: pass,
    DialogTitle: pass,
    DialogTrigger: pass,
  };
});
// A tiny hook store for the source components, so state survives between server renders.
const hooks = vi.hoisted(() => ({ on: false, slots: [] as unknown[], i: 0 }));
vi.mock("react", async (orig) => {
  const actual = await orig<typeof import("react")>();
  const useState = ((init: unknown) => {
    if (!hooks.on) return actual.useState(init);
    const k = hooks.i++;
    if (!(k in hooks.slots)) hooks.slots[k] = typeof init === "function" ? (init as () => unknown)() : init;
    const set = (v: unknown) => {
      hooks.slots[k] = typeof v === "function" ? (v as (p: unknown) => unknown)(hooks.slots[k]) : v;
    };
    return [hooks.slots[k], set];
  }) as typeof actual.useState;
  return { ...actual, useState, default: { ...actual, useState } };
});

import { POST as requestRoute } from "@/app/api/session/password-reset/request/route";
import { POST as confirmRoute } from "@/app/api/session/password-reset/confirm/route";
import { POST as createAdministrator } from "@/app/api/admin/administrators/route";
import { POST as openSupport } from "@/app/api/admin/sites/[siteId]/support-access/route";
import { DELETE as leaveSupport } from "@/app/api/admin/support-access/route";
import * as requestModule from "@/app/api/session/password-reset/request/route";
import * as confirmModule from "@/app/api/session/password-reset/confirm/route";
import { ForgotPasswordView, requestResetLink } from "@/components/auth/forgot-password-form";
import { ResetPasswordView, confirmReset } from "@/components/auth/reset-password-form";
import { CreateAdministratorDialog, AdministratorCreatedBody } from "@/components/admin/create-administrator-dialog";
import { UsersTable } from "@/components/admin/users-table";
import { SupportBanner } from "@/components/customer/support-banner";
import { getCustomerContext } from "@/app/sites/data";
import { I18nProvider } from "@/i18n/provider";

const root = path.resolve(__dirname, "../../..");
const web = path.join(root, "apps/web/src");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf-8");
const LOCALES = [["en", en], ["it", itMsgs]] as const;
const render = (el: ReactElement, locale: "en" | "it" = "en") =>
  renderToStaticMarkup(createElement(I18nProvider, { locale, messages: locale === "en" ? en : itMsgs, children: el }));

// Sentinels only.
const TOKEN = "SENTINEL-qa-reset-token-abcdef0123456789";
const PASSWORD = "SENTINEL-qa-new-password";
const EMAIL = "nobody-qa@example.test";
const API_MESSAGE = "SENTINEL-API-MESSAGE the account nobody-qa@example.test does not exist";
const HOSTILE = ['<img src=x onerror=alert(1)>', '"><script>alert(1)</script>'];
const ADMIN = { accessToken: "SENTINEL-admin-access", csrfToken: "csrf-ok", activeConsole: "admin", user: { id: "usr_me", isServerAdmin: true } };
const CUSTOMER = { accessToken: "SENTINEL-customer-access", csrfToken: "csrf-ok", activeConsole: "customer", user: { id: "usr_c", isServerAdmin: false } };
const RESULT = {
  userId: "usr_new",
  email: "second-admin@example.test",
  temporaryPassword: "SENTINEL-qa-temp-pass-77",
  totpSecretBase32: "QAKEYQAKEYQAKEYQAKEY",
  otpauthUri: "otpauth://totp/Panel:second-admin%40example.test?secret=QAKEYQAKEYQAKEYQAKEY",
};

// A real local upstream: records what the BFF really sends.
type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };
const seen: Seen[] = [];
let reply: (s: Seen) => { status: number; body?: unknown } = () => ({ status: 202 });
let server: http.Server;
let upstream = "";
let deadUpstream = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const s = { method: req.method!, url: req.url!, headers: req.headers, body };
      seen.push(s);
      const r = reply(s);
      if (r.body === undefined) res.writeHead(r.status).end();
      else res.writeHead(r.status, { "content-type": "application/json" }).end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  upstream = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dead = http.createServer();
  await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
  deadUpstream = `http://127.0.0.1:${(dead.address() as AddressInfo).port}`;
  await new Promise((r) => dead.close(r));
});
afterAll(() => new Promise((r) => server.close(r)));
beforeEach(() => {
  seen.length = 0;
  reply = () => ({ status: 202 });
  process.env.API_INTERNAL_URL = upstream;
  sessionFor.mockReset();
  getServerSession.mockReset();
  fetchServerMe.mockReset();
  hooks.on = false;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// The browser adds the panel's Origin to every POST of its pages.
const bff = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
  new Request(`http://localhost:3000${url}`, {
    method: init.method ?? "POST",
    headers: { Origin: "http://localhost:3000", ...init.headers },
    body: init.body,
  });
const json = { "Content-Type": "application/json" };
const loggedIn = { ...json, Cookie: "hp_session=SENTINEL-cookie; hp_locale=en", Authorization: "Bearer SENTINEL-browser", "X-CSRF-Token": "csrf-ok" };
const admin = { Host: "localhost:3000", Origin: "http://localhost:3000", "X-CSRF-Token": "csrf-ok", ...json };
const params = (siteId: string) => ({ params: Promise.resolve({ siteId }) });

// Sends the browser's relative fetch calls to the real route handlers; everything else really goes out.
function routeBrowserFetch() {
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u === "/api/session/password-reset/request") return requestRoute(bff(u, init as never));
    if (u === "/api/session/password-reset/confirm") return confirmRoute(bff(u, init as never));
    return realFetch(url, init);
  });
}
const allErrorTexts = (m: typeof en) => Object.values(m.errors) as string[];

describe("1. the forgot page never tells", () => {
  it("the request BFF passes the 202 on with an empty body, the same for every address", async () => {
    const answers: string[] = [];
    for (const email of ["known-qa@example.test", EMAIL]) {
      const res = await requestRoute(bff("/api/session/password-reset/request", { headers: json, body: JSON.stringify({ email }) }));
      expect(res.status).toBe(202);
      answers.push(await res.text());
    }
    expect(answers[0]).toBe(answers[1]);
    expect(answers[0]).toBe("");
  });

  for (const [locale, m] of LOCALES) {
    it(`${locale}: a 429, a 500, a 404 or a broken connection shows a catalog text, never the API's message or the address`, async () => {
      routeBrowserFetch();
      const shown: string[] = [];
      for (const [status, code] of [[429, "RATE_LIMITED"], [500, "INTERNAL_ERROR"], [404, "NOT_FOUND"], [400, HOSTILE[0]]] as const) {
        reply = () => ({ status, body: { error: { code, message: API_MESSAGE, details: [{ field: "email", message: API_MESSAGE }] } } });
        const state = await requestResetLink(m, EMAIL);
        expect(state.sent).toBe(false);
        shown.push(state.error!);
      }
      process.env.API_INTERNAL_URL = deadUpstream;
      const broken = await requestResetLink(m, EMAIL);
      shown.push(broken.error!);
      for (const text of shown) {
        expect(allErrorTexts(m)).toContain(text);
        expect(text).not.toContain("SENTINEL");
        expect(text).not.toContain("example.test");
        const html = render(createElement(ForgotPasswordView, { sent: false, error: text, email: "", busy: false, onEmail: () => {}, onSubmit: () => {} }), locale);
        expect(html).not.toContain("SENTINEL");
        expect(html).not.toContain("<img");
        expect(html).not.toContain(esc(m.login.forgot.sent));
      }
    });
  }
});

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const codeOf = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("2. the token stays out of sight", () => {
  const files = [
    "apps/web/src/components/auth/reset-password-form.tsx",
    "apps/web/src/app/reset-password/page.tsx",
    "apps/web/src/app/api/session/password-reset/confirm/route.ts",
    "apps/web/src/app/api/session/password-reset/request/route.ts",
    "apps/web/src/components/auth/forgot-password-form.tsx",
  ];

  it("the reset page and form keep the token out of the query, cookies, storage, console and error texts", () => {
    for (const f of files) {
      const code = codeOf(f);
      expect(code, f).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|cookies\(|console\.|searchParams|URLSearchParams|\?token|new Error\(|throw /);
      // Every fetch goes to a constant BFF path: nothing is built into the address.
      for (const call of code.matchAll(/fetch\(([^,]+),/g)) expect(call[1], f).toMatch(/^"\/api\/session\/password-reset\/(request|confirm)"$/);
    }
    const form = codeOf(files[0]!);
    expect(form).toMatch(/window\.location\.hash\.slice\(1\)/);
    // The fragment is replaced by the bare path: no query, no fragment survives.
    expect([...form.matchAll(/replaceState\(([^)]*)\)/g)].map((x) => x[1])).toEqual(['null, "", window.location.pathname']);
  });

  it("the confirm call reaches the API with the token in the body only, and no BFF answer or log line holds it", async () => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    reply = () => ({ status: 204 });
    const ok = await confirmRoute(bff("/api/session/password-reset/confirm", { headers: loggedIn, body: JSON.stringify({ token: TOKEN, newPassword: PASSWORD }) }));
    expect(ok.status).toBe(204);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("/v1/auth/password-reset/confirm");
    expect(JSON.stringify(seen[0]!.headers)).not.toContain(TOKEN);
    expect(JSON.parse(seen[0]!.body)).toEqual({ token: TOKEN, newPassword: PASSWORD });

    const answers = [await ok.text()];
    reply = () => ({ status: 400, body: { error: { code: "PASSWORD_RESET_INVALID", message: "Invalid or expired link." } } });
    answers.push(await (await confirmRoute(bff("/x", { headers: json, body: JSON.stringify({ token: TOKEN, newPassword: PASSWORD }) }))).text());
    answers.push(await (await confirmRoute(bff("/x", { headers: json, body: `{"token":"${TOKEN}",` }))).text());
    answers.push(await (await requestRoute(bff("/x", { headers: json, body: `{"email":"${EMAIL}",` }))).text());
    process.env.API_INTERNAL_URL = deadUpstream;
    answers.push(await (await confirmRoute(bff("/x", { headers: json, body: JSON.stringify({ token: TOKEN, newPassword: PASSWORD }) }))).text());
    answers.push(await (await requestRoute(bff("/x", { headers: json, body: JSON.stringify({ email: EMAIL }) }))).text());
    for (const a of answers) {
      expect(a).not.toContain(TOKEN);
      expect(a).not.toContain(EMAIL);
      expect(a).not.toContain(PASSWORD);
    }
    for (const spy of logs) expect(spy).not.toHaveBeenCalled();
  });

  it("a refused confirm, seen through the form, shows a catalog text and never the token", async () => {
    routeBrowserFetch();
    for (const [locale, m] of LOCALES) {
      for (const code of ["PASSWORD_RESET_INVALID", "VALIDATION_ERROR", "INTERNAL_ERROR", HOSTILE[1]]) {
        reply = () => ({ status: 400, body: { error: { code, message: `${API_MESSAGE} ${TOKEN}` } } });
        const state = await confirmReset(m, TOKEN, PASSWORD);
        const html = render(createElement(ResetPasswordView, { ...state, busy: false, onSubmit: () => {} }), locale);
        expect(html).not.toContain(TOKEN);
        expect(html).not.toContain("SENTINEL-API-MESSAGE");
        expect(html).not.toContain("<script>");
        if (state.error) expect([...allErrorTexts(m), m.account.passwordRule]).toContain(state.error);
      }
    }
  });
});

describe("3. the two open BFF routes forward nothing they should not", () => {
  const cases = [
    { name: "request", route: requestRoute, url: "/v1/auth/password-reset/request", body: { email: EMAIL }, schema: PasswordResetRequestInputSchema },
    { name: "confirm", route: confirmRoute, url: "/v1/auth/password-reset/confirm", body: { token: TOKEN, newPassword: PASSWORD }, schema: PasswordResetConfirmInputSchema },
  ] as const;

  for (const c of cases) {
    it(`${c.name}: with a logged-in person's cookies the upstream call carries no token, no cookie and only the schema's fields`, async () => {
      sessionFor.mockResolvedValue(ADMIN);
      const extra = { ...c.body, accessToken: "SENTINEL-x", role: "server_admin", userId: "usr_me", isServerAdmin: true };
      await c.route(bff("/x", { headers: loggedIn, body: JSON.stringify(extra) }));
      expect(seen).toHaveLength(1);
      const h = seen[0]!.headers;
      expect(seen[0]!.method).toBe("POST");
      expect(seen[0]!.url).toBe(c.url);
      expect(h.authorization).toBeUndefined();
      expect(h.cookie).toBeUndefined();
      expect(h["x-csrf-token"]).toBeUndefined();
      expect(JSON.stringify(h)).not.toContain("SENTINEL");
      expect(Object.keys(JSON.parse(seen[0]!.body)).sort()).toEqual(Object.keys(c.schema.shape).sort());
      expect(sessionFor).not.toHaveBeenCalled();
    });

    it(`${c.name}: over the bound, not JSON, or an array is refused before the upstream`, async () => {
      const big = JSON.stringify({ ...c.body, pad: "a".repeat(1_048_577) });
      const refused = [
        await c.route(bff("/x", { headers: json, body: big })),
        await c.route(bff("/x", { headers: { ...json, "Content-Length": "5000000" }, body: "{}" })),
        await c.route(bff("/x", { headers: json, body: "email=a" })),
        await c.route(bff("/x", { headers: json, body: JSON.stringify([c.body]) })),
      ];
      expect(refused.map((r) => r.status)).toEqual([413, 413, 400, 400]);
      expect(seen).toHaveLength(0);
    });

    it(`${c.name}: no method other than POST is served`, () => {
      const mod = c.name === "request" ? requestModule : confirmModule;
      const methods = Object.keys(mod).filter((k) => /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(k));
      expect(methods).toEqual(["POST"]);
    });
  }
});

describe("4. the administrator dialog", () => {
  it("the temporary password and the TOTP key are shown once as text and are gone after close and reopen", () => {
    hooks.on = true;
    // Slots of CreateAdministratorDialog in order: open, name, email, error, busy, result.
    hooks.slots = [true, "Second Admin", RESULT.email, null, false, RESULT];
    const draw = () => {
      hooks.i = 0;
      return render(createElement(CreateAdministratorDialog, { csrfToken: "csrf-ok" }));
    };
    const shown = draw();
    expect(shown).toContain(`>${RESULT.temporaryPassword}</code>`);
    expect(shown).toContain("QAKE YQAK EYQA KEYQ AKEY");
    expect(shown).not.toMatch(/value="SENTINEL/);
    dialog.onOpenChange!(false);
    expect(draw()).not.toContain("SENTINEL");
    dialog.onOpenChange!(true);
    const reopened = draw();
    expect(reopened).toContain(esc(en.admin.users.administrators.submit));
    for (const secret of [RESULT.temporaryPassword, "QAKE", RESULT.totpSecretBase32, "otpauth://"]) expect(reopened).not.toContain(secret);
    expect(hooks.slots.slice(0, 6)).toEqual([true, "", "", null, false, null]);
    expect(refresh).toHaveBeenCalled();
  });

  it("no place outlives the dialog: no storage, no console, no module-level variable", () => {
    for (const f of [
      "apps/web/src/components/admin/create-administrator-dialog.tsx",
      "apps/web/src/components/admin/create-customer-dialog.tsx",
      "apps/web/src/components/account/totp-card.tsx",
      "apps/web/src/components/admin/users-table.tsx",
    ]) {
      const code = codeOf(f);
      expect(code, f).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|console\.|globalThis|window\.\w+\s*=/);
      expect(code, f).not.toMatch(/^(let|var)\s/m);
      expect(code, f).not.toMatch(/^(export\s+)?const\s+\w+\s*(:[^=]+)?=\s*(new\s|\[|\{)/m);
    }
  });

  it("the create route refuses a foreign Origin and a missing session before the upstream", async () => {
    sessionFor.mockResolvedValue(ADMIN);
    const body = JSON.stringify({ email: RESULT.email, name: "Second Admin" });
    expect((await createAdministrator(bff("/x", { headers: { ...admin, Origin: "http://evil.example.test" }, body }))).status).toBe(403);
    expect((await createAdministrator(bff("/x", { headers: { ...admin, "X-CSRF-Token": "csrf-bad" }, body }))).status).toBe(403);
    sessionFor.mockResolvedValue(null);
    expect((await createAdministrator(bff("/x", { headers: admin, body }))).status).toBe(401);
    expect(seen).toHaveLength(0);
    sessionFor.mockResolvedValue(ADMIN);
    reply = () => ({ status: 201, body: { data: RESULT } });
    expect((await createAdministrator(bff("/x", { headers: admin, body }))).status).toBe(201);
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${ADMIN.accessToken}`);
  });
});

const me = (over: Partial<MeDto> = {}) =>
  ({ user: { id: "u1", isServerAdmin: false }, globalRoles: [], hostingAdminOrgIds: [], memberships: [], platformCapabilities: {}, ...over }) as MeDto;
const member = (organizationId: string) => ({ organizationId, organizationSlug: organizationId }) as MeDto["memberships"][number];
const visitA = { organizationId: "org-a", organizationName: "Customer A", expiresAt: "2026-11-16T11:30:00.000Z" };

describe("5. the support view cannot be reached sideways", () => {
  it("getCustomerContext takes the organisation only from who-am-I, whatever the session claims", async () => {
    const claims = { activeOrgSlug: "org-a", user: { id: "u1", mustChangePassword: false, isServerAdmin: false } };
    // A customer with no membership; a customer of org-b; an administrator without a visit.
    getServerSession.mockResolvedValue({ ...claims, activeConsole: "customer" });
    fetchServerMe.mockResolvedValue(me({ supportAccess: visitA }));
    expect(await getCustomerContext()).toMatchObject({ orgId: null, support: null });
    fetchServerMe.mockResolvedValue(me({ memberships: [member("org-b")], supportAccess: visitA }));
    expect(await getCustomerContext()).toMatchObject({ orgId: "org-b", support: null });
    for (const s of [{ ...claims, activeConsole: "admin" }, { ...claims, activeConsole: "customer", user: { ...claims.user, isServerAdmin: true } }]) {
      getServerSession.mockResolvedValue(s);
      fetchServerMe.mockResolvedValue(me({ memberships: [member("org-a")] }));
      await expect(getCustomerContext()).rejects.toThrow("REDIRECT /admin/sites?support=ended");
    }
    expect(getCustomerContext.length).toBe(0);
  });

  it("no customer page takes an organisation from the URL, a query parameter or a cookie", () => {
    const files = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    const pages = files(path.join(web, "app/sites")).filter((f) => /\.tsx?$/.test(f));
    expect(pages.length).toBeGreaterThan(10);
    for (const f of pages) {
      const code = fs.readFileSync(f, "utf-8");
      const rel = path.relative(web, f);
      expect(code, rel).not.toMatch(/params\b[^\n;]*\b(orgId|organizationId|orgSlug)\b|\b(orgId|organizationId|orgSlug)\b[^\n;]*=\s*await\s+(params|searchParams)/i);
      expect(rel.includes("[org")).toBe(false);
      if (/\borgId\b/.test(code) && !rel.endsWith("data.ts")) expect(code, rel).toMatch(/getCustomerContext\(\)/);
      expect(code, rel).not.toMatch(/cookies\(\)/);
    }
  });

  it("both support routes refuse a site id of a wrong shape, a missing session, a bad CSRF token and a foreign Origin before the upstream", async () => {
    sessionFor.mockResolvedValue(ADMIN);
    for (const id of ["../x", "..", "a%2Fb", "a/b", "%2e%2e", "", "a".repeat(129), "s1?x=1", "s1#x"])
      expect((await openSupport(bff("/x", { headers: admin }), params(id))).status, id).toBe(400);
    sessionFor.mockResolvedValue(null);
    expect((await openSupport(bff("/x", { headers: admin }), params("s1"))).status).toBe(401);
    expect((await leaveSupport(bff("/x", { method: "DELETE", headers: admin }))).status).toBe(401);
    sessionFor.mockResolvedValue(ADMIN);
    expect((await openSupport(bff("/x", { headers: { ...admin, "X-CSRF-Token": "csrf-bad" } }), params("s1"))).status).toBe(403);
    expect((await leaveSupport(bff("/x", { method: "DELETE", headers: { ...admin, Origin: "http://evil.example.test" } }))).status).toBe(403);
    const noCsrf: Record<string, string> = { ...admin };
    delete noCsrf["X-CSRF-Token"];
    expect((await leaveSupport(bff("/x", { method: "DELETE", headers: noCsrf }))).status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it("a customer's session gets no visit from the BFF: its own token goes up and the API's refusal comes back", async () => {
    sessionFor.mockResolvedValue(CUSTOMER);
    reply = () => ({ status: 403, body: { error: { code: "PERMISSION_DENIED", message: "x" } } });
    const res = await openSupport(bff("/x", { headers: admin }), params("s1"));
    expect(res.status).toBe(403);
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${CUSTOMER.accessToken}`);
    expect(seen[0]!.url).toBe("/v1/admin/sites/s1/support-access");
  });
});

describe("6. hostile values are text", () => {
  const users = (bad: string): AdminUserDto[] => [
    { id: "usr_c", email: `${bad}@example.test`, name: bad, role: "customer", status: "active", totpEnabled: true, mustChangePassword: false, lockedUntil: null, createdAt: "2026-11-01T10:00:00.000Z" },
    { id: "usr_o", email: `o${bad}@example.test`, name: bad, role: "server_admin", status: "active", totpEnabled: true, mustChangePassword: false, lockedUntil: null, createdAt: "2026-11-01T10:00:00.000Z" },
  ] as AdminUserDto[];

  for (const bad of HOSTILE) {
    it(`banner, users table and dialog show ${JSON.stringify(bad)} as text`, () => {
      for (const [locale] of LOCALES) {
        const htmls = [
          render(createElement(SupportBanner, { support: { ...visitA, organizationName: bad }, csrfToken: "csrf-ok" }), locale),
          render(createElement(UsersTable, { users: users(bad), csrfToken: "csrf-ok", currentUserId: "usr_me" }), locale),
          render(createElement(AdministratorCreatedBody, { result: RESULT, name: bad }), locale),
        ];
        for (const html of htmls) {
          expect(html).not.toContain("<img");
          expect(html).not.toContain("<script");
          expect(html).toContain(esc(bad).replace(/&quot;/g, "&quot;"));
        }
      }
    });
  }

  it("no file of M5a uses dangerouslySetInnerHTML or builds HTML from a string", () => {
    for (const f of [...M5A_WEB_FILES, ...M5A_ROUTE_FILES]) expect(read(f), f).not.toMatch(/dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|document\.write/);
  });

  it("every error a M5a component shows comes from the catalog, never from the API's message", () => {
    for (const f of M5A_WEB_FILES) {
      const code = codeOf(f);
      expect(code, f).not.toMatch(/error\?*\.message|\.message\b(?!s)/);
    }
  });
});

const M5A_WEB_FILES = [
  "apps/web/src/components/auth/forgot-password-form.tsx",
  "apps/web/src/components/auth/reset-password-form.tsx",
  "apps/web/src/components/auth/login-form.tsx",
  "apps/web/src/components/admin/create-administrator-dialog.tsx",
  "apps/web/src/components/admin/users-table.tsx",
  "apps/web/src/components/admin/sites-table.tsx",
  "apps/web/src/components/customer/support-banner.tsx",
  "apps/web/src/components/account/totp-card.tsx",
  "apps/web/src/app/forgot-password/page.tsx",
  "apps/web/src/app/reset-password/page.tsx",
  "apps/web/src/app/admin/users/page.tsx",
  "apps/web/src/app/admin/sites/page.tsx",
  "apps/web/src/app/sites/layout.tsx",
];
const M5A_ROUTE_FILES = [
  "apps/web/src/app/api/admin/administrators/route.ts",
  "apps/web/src/app/api/session/password-reset/request/route.ts",
  "apps/web/src/app/api/session/password-reset/confirm/route.ts",
  "apps/web/src/app/api/admin/sites/[siteId]/support-access/route.ts",
  "apps/web/src/app/api/admin/support-access/route.ts",
];

const M5A_KEYS = [
  "login.forgotLink",
  ...["title", "intro", "email", "submit", "sent", "noMail", "back"].map((k) => `login.forgot.${k}`),
  ...["title", "submit", "done", "signIn", "requestNew"].map((k) => `login.reset.${k}`),
  "admin.users.subtitle",
  ...["create", "title", "hint", "name", "email", "submit", "invalid", "tempNote", "totpTitle", "totpNote", "sshRepair"].map((k) => `admin.users.administrators.${k}`),
  "admin.sites.support.open",
  "admin.sites.support.ended",
  "shell.support.mark",
  "shell.support.markUnassigned",
  "shell.support.leave",
  "errors.LAST_ADMINISTRATOR_PROTECTED",
  "errors.PASSWORD_RESET_INVALID",
];
// The same word in both languages, as the shipped `login.email` ("Email" in both catalogs).
const SAME_IN_BOTH = ["login.forgot.email", "admin.users.administrators.email"];
const at = (o: unknown, key: string) => key.split(".").reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], o);
const FORBIDDEN = /\b(docker|containers?|contenitor[ei]|images?|immagin[ei]|networks?|ret[ei]|volumes?|volumi|revisions?|revision[ei])\b/i;

describe("7. the texts", () => {
  it("every M5a key is in both catalogs, not empty, not a key name, and the Italian is not the English", () => {
    expect(en.login.email).toBe(itMsgs.login.email);
    for (const key of M5A_KEYS) {
      const e = at(en, key);
      const i = at(itMsgs, key);
      for (const v of [e, i]) {
        expect(typeof v, key).toBe("string");
        expect((v as string).trim().length, key).toBeGreaterThan(1);
        expect(v, key).not.toBe(key);
        expect(v, key).not.toBe(key.split(".").pop());
        expect(v, key).not.toMatch(/^[a-z]+(\.[A-Za-z_]+)+$/);
      }
      if (!SAME_IN_BOTH.includes(key)) expect(i, key).not.toBe(e);
    }
    for (const m of [en, itMsgs]) {
      expect(m.shell.support.mark).toMatch(/\{name\}[\s\S]*\{time\}/);
      expect(m.shell.support.markUnassigned).toContain("{time}");
      expect(m.shell.support.markUnassigned).not.toContain("{name}");
    }
  });

  it("no text a customer can see (both public pages, the banner, the reset mail) holds a forbidden word, in either language", () => {
    const customerKeys = M5A_KEYS.filter((k) => /^(login\.|shell\.)/.test(k) || k === "errors.PASSWORD_RESET_INVALID");
    const reused = ["account.newPassword", "account.confirmPassword", "account.passwordRule", "account.passwordMismatch", "errors.generic"];
    for (const m of [en, itMsgs]) for (const k of [...customerKeys, ...reused]) expect(at(m, k), k).not.toMatch(FORBIDDEN);
    const mail = read("apps/docker-executor/src/panel-mail.ts");
    const texts = mail.slice(mail.indexOf("PANEL_MAIL_TEXTS"), mail.indexOf("} as const"));
    expect(texts).toMatch(/subject:[\s\S]*body:[\s\S]*subject:[\s\S]*body:/);
    expect(texts).not.toMatch(FORBIDDEN);
    // The mail and the page agree on what the link is: once, 30 minutes.
    expect(texts).toMatch(/30 minuti/);
    expect(texts).toMatch(/30 minutes/);
    // The fixture proves the word list itself bites, in both languages.
    for (const s of ["Your container is ready", "La rete del sito", "Il volume è pieno", "Nuova revisione"]) expect(s).toMatch(FORBIDDEN);
  });

  it("the shipped scan of ui-copy.test.ts reads the new folders and sections, and its own regex catches a planted word", () => {
    const scan = read("apps/web/test/ui-copy.test.ts");
    const dirs = [...scan.slice(scan.indexOf("const dirs = ["), scan.indexOf("].map")).matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
    for (const d of ["app/forgot-password", "app/reset-password", "components/auth", "components/customer"]) {
      expect(dirs).toContain(d);
      expect(fs.readdirSync(path.join(web, d)).length, d).toBeGreaterThan(0);
    }
    for (const f of M5A_WEB_FILES.filter((x) => /auth\/|customer\/|forgot-password|reset-password|app\/sites/.test(x)))
      expect(dirs.some((d) => f.startsWith(`apps/web/src/${d}/`)), f).toBe(true);
    const sections = scan.match(/const sections = \[([^\]]+)\]/)![1]!;
    for (const s of ['"login"', '"shell"']) expect(sections).toContain(s);
    const literal = scan.match(/const jargon = \/(.+)\/i;/)![1]!;
    const jargon = new RegExp(literal, "i");
    // Fixture sentences of this file, handed to the scan's own regex.
    for (const s of ["Il container del sito è fermo", "The docker image was pulled", "A network volume is full", "The revision changed"]) expect(s).toMatch(jargon);
    for (const m of [en, itMsgs]) expect(JSON.stringify([m.login, m.shell])).not.toMatch(jargon);
  });
});

// ---------- 8. the screen, the BFF routes, openapi.yaml and the controllers fit together ----------

const openapi = read("docs/api/openapi.yaml");
/** The block of one path in openapi.yaml, split by method. */
function pathBlock(p: string): Record<string, string> {
  const start = openapi.indexOf(`\n  ${p}:\n`);
  if (start < 0) return {};
  const rest = openapi.slice(start + 1);
  const end = rest.slice(1).search(/\n {2}\S|\n\S/);
  const block = end < 0 ? rest : rest.slice(0, end + 1);
  const out: Record<string, string> = {};
  const parts = block.split(/\n {4}(get|post|put|patch|delete):\n/);
  for (let i = 1; i < parts.length; i += 2) out[parts[i]!.toUpperCase()] = parts[i + 1]!;
  return out;
}
const yamlList = (text: string) => (text.match(/required: \[([^\]]*)\]/)?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean).sort();
const props = (text: string, indent: number) => [...text.matchAll(new RegExp(`^ {${indent}}(\\w+):$`, "gm"))].map((x) => x[1]!).sort();
const HTTP: Record<string, number> = { OK: 200, CREATED: 201, ACCEPTED: 202, NO_CONTENT: 204 };

/** Every (method, path, status) a controller file declares, from its source text. */
function controllerRoutes(rel: string) {
  const code = read(rel);
  const prefix = code.match(/@Controller\(\s*(?:"([^"]*)")?\s*\)/)![1] ?? "";
  return [...code.matchAll(/@(Get|Post|Patch|Delete|Put)\("([^"]*)"\)\s*(?:@HttpCode\(HttpStatus\.(\w+)\))?/g)].map((x) => ({
    method: x[1]!.toUpperCase(),
    path: `/${[prefix, x[2]].filter(Boolean).join("/")}`.replace(/:(\w+)/g, "{$1}"),
    status: x[3] ? HTTP[x[3]]! : x[1] === "Post" ? 201 : 200,
  }));
}

describe("8. the screen and the routes fit together", () => {
  // Client calls of the M5a screens: method and BFF path, from the source text.
  const clientCalls = () => {
    const calls: { file: string; method: string; url: string }[] = [];
    for (const f of M5A_WEB_FILES) {
      const code = codeOf(f);
      for (const x of code.matchAll(/fetch\(\s*([`"])([^`"]+)\1\s*,\s*\{\s*method:\s*"([A-Z]+)"/g)) calls.push({ file: f, method: x[3]!, url: x[2]! });
    }
    // A built segment becomes its route folder: site.id → [siteId]; totp-card's call(path) → setup, enable, disable.
    return calls.flatMap((c) =>
      c.url.includes("${path}")
        ? ["setup", "enable", "disable"].map((p) => ({ ...c, url: c.url.replace("${path}", p) }))
        : [{ ...c, url: c.url.replace(/\$\{[^}]*\}/g, "[siteId]") }],
    );
  };

  it("every address the new screens request has a BFF route file that exports that method", () => {
    const calls = clientCalls();
    expect(calls.map((c) => `${c.method} ${c.url}`).sort()).toEqual([
      "DELETE /api/admin/support-access",
      "POST /api/account/totp/disable",
      "POST /api/account/totp/enable",
      "POST /api/account/totp/setup",
      "POST /api/admin/administrators",
      "POST /api/admin/sites/[siteId]/support-access",
      "POST /api/session/login",
      "POST /api/session/password-reset/confirm",
      "POST /api/session/password-reset/request",
    ]);
    expect(codeOf("apps/web/src/components/account/totp-card.tsx").match(/call\("(\w+)"/g)).toEqual(['call("setup"', 'call("enable"', 'call("disable"']);
    // users-table builds its URL first; its PATCH goes to the shipped [userId] route.
    calls.push({ file: "users-table", method: "PATCH", url: "/api/admin/users/[userId]" });
    expect(codeOf("apps/web/src/components/admin/users-table.tsx")).toMatch(/\[base, "PATCH", JSON\.stringify\(\{ status:/);
    for (const c of calls) {
      const file = path.join(web, "app", c.url, "route.ts");
      expect(fs.existsSync(file), `${c.method} ${c.url}`).toBe(true);
      expect(fs.readFileSync(file, "utf-8"), `${c.method} ${c.url}`).toMatch(new RegExp(`export async function ${c.method}\\(`));
    }
  });

  it("every new BFF route forwards to a path and method that openapi.yaml holds", () => {
    const forwards: string[] = [];
    for (const f of M5A_ROUTE_FILES) {
      const code = read(f);
      for (const x of code.matchAll(/forwardToUpstream\(req,\s*[`"]([^`"]+)[`"],\s*"([A-Z]+)"/g)) forwards.push(`${x[2]} /${x[1]}`);
      for (const x of code.matchAll(/fetchUpstream\(\s*"([^"]+)",\s*\{\s*method:\s*"([A-Z]+)"/g)) forwards.push(`${x[2]} /${x[1]}`);
    }
    const normalized = forwards.map((f) => f.replace(/\$\{(\w+)\}/g, "{$1}")).sort();
    expect(normalized).toEqual([
      "DELETE /v1/admin/support-access",
      "POST /v1/admin/administrators",
      "POST /v1/admin/sites/{siteId}/support-access",
      "POST /v1/auth/password-reset/confirm",
      "POST /v1/auth/password-reset/request",
    ]);
    for (const f of normalized) {
      const [method, p] = f.split(" ");
      expect(Object.keys(pathBlock(p!)), f).toContain(method);
    }
  });

  const M5A_API = [
    { method: "POST", path: "/v1/admin/administrators", file: "apps/api/src/controllers/admin-users.controller.ts", input: CreateAdministratorInputSchema, output: CreateAdministratorResultDtoSchema },
    { method: "PATCH", path: "/v1/admin/users/{userId}", file: "apps/api/src/controllers/admin-users.controller.ts", inputKeys: ["status"] },
    { method: "POST", path: "/v1/auth/password-reset/request", file: "apps/api/src/controllers/password-reset.controller.ts", input: PasswordResetRequestInputSchema },
    { method: "POST", path: "/v1/auth/password-reset/confirm", file: "apps/api/src/controllers/password-reset.controller.ts", input: PasswordResetConfirmInputSchema },
    { method: "POST", path: "/v1/admin/sites/{siteId}/support-access", file: "apps/api/src/controllers/support-access.controller.ts", output: SupportAccessDtoSchema },
    { method: "DELETE", path: "/v1/admin/support-access", file: "apps/api/src/controllers/support-access.controller.ts" },
  ] as const;

  for (const r of M5A_API) {
    it(`${r.method} ${r.path}: openapi.yaml and the controller agree on method, success status and field names`, () => {
      const route = controllerRoutes(r.file).find((x) => x.method === r.method && x.path === r.path);
      expect(route, `${r.method} ${r.path} in ${r.file}`).toBeDefined();
      const doc = pathBlock(r.path)[r.method];
      expect(doc, `${r.method} ${r.path} in openapi.yaml`).toBeDefined();
      const codes = [...doc!.matchAll(/^ {8}"(\d{3})":/gm)].map((x) => Number(x[1]));
      expect(codes, "success status").toContain(route!.status);
      expect(codes.filter((c) => c < 300)).toEqual([route!.status]);
      const reqText = doc!.includes("requestBody:") ? doc!.slice(doc!.indexOf("requestBody:"), doc!.indexOf("responses:")) : "";
      const inputKeys = "input" in r ? Object.keys(r.input.shape).sort() : "inputKeys" in r ? [...r.inputKeys] : [];
      expect(yamlList(reqText), "required request fields").toEqual(inputKeys);
      expect(props(reqText, 16), "request properties").toEqual(inputKeys);
      if ("output" in r) {
        const outKeys = Object.keys(r.output.shape).sort();
        const ref = doc!.match(/\$ref: "#\/components\/schemas\/(\w+)"/)?.[1];
        const schemaText = ref ? openapi.slice(openapi.indexOf(`\n    ${ref}:\n`), openapi.indexOf("\n\n", openapi.indexOf(`\n    ${ref}:\n`))) : doc!;
        const fieldIndent = ref ? 8 : 22;
        expect(yamlList(ref ? schemaText : schemaText.slice(schemaText.indexOf("data:"))), "required answer fields").toEqual(outKeys);
        expect(props(schemaText, fieldIndent), "answer properties").toEqual(outKeys);
      }
    });
  }

  it("who-am-I in openapi.yaml carries the optional supportAccess the web reads", () => {
    const meDto = openapi.slice(openapi.indexOf("\n    MeDto:\n"), openapi.indexOf("\n\n", openapi.indexOf("\n    MeDto:\n")));
    expect(meDto).toMatch(/supportAccess:\n\s+\$ref: "#\/components\/schemas\/SupportAccessDto"/);
    expect(yamlList(meDto)).not.toContain("supportAccess");
    for (const code of ["LAST_ADMINISTRATOR_PROTECTED", "PASSWORD_RESET_INVALID"]) expect(openapi).toMatch(new RegExp(`- ${code}\\b`));
  });
});
