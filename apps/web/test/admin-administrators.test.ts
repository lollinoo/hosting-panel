import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, type ReactElement } from "react";
import type { AdminUserDto } from "@hosting-panel/contracts";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";

const fetchUpstream = vi.fn();
vi.mock("@/lib/upstream", () => ({ fetchUpstream: (...a: unknown[]) => fetchUpstream(...a) }));
vi.mock("@/lib/server-session", () => ({
  getSessionFromRequest: async () => ({ accessToken: "tok", csrfToken: "csrf" }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/admin/users" }));

import { POST as createAdministrator } from "@/app/api/admin/administrators/route";
import { UsersTable } from "@/components/admin/users-table";
import { CreateAdministratorDialog, AdministratorCreatedBody } from "@/components/admin/create-administrator-dialog";
import { TotpKey } from "@/components/account/totp-card";
import { I18nProvider } from "@/i18n/provider";

const req = (headers: Record<string, string> = {}, body: unknown = {}) =>
  new Request("http://localhost:3000/x", {
    method: "POST",
    headers: { Host: "localhost:3000", Origin: "http://localhost:3000", "X-CSRF-Token": "csrf", "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const render = (el: ReactElement, locale: "en" | "it" = "en") =>
  renderToStaticMarkup(createElement(I18nProvider, { locale, messages: locale === "en" ? en : itMsgs, children: el }));

// Sentinels: never a real password or key.
const RESULT = {
  userId: "usr_new",
  email: "second-admin@example.test",
  temporaryPassword: "SENTINEL-temp-pass-0001",
  totpSecretBase32: "SENTINELKEYABCDEFGHIJ",
  otpauthUri: "otpauth://totp/Panel:second-admin%40example.test?secret=SENTINELKEYABCDEFGHIJ",
};

describe("administrators BFF", () => {
  beforeEach(() => fetchUpstream.mockReset());

  it("forwards {email, name} to v1/admin/administrators with the session token", async () => {
    fetchUpstream.mockResolvedValue({ ok: true, status: 201, data: { data: RESULT } });
    const res = await createAdministrator(req({}, { email: "second-admin@example.test", name: "Second Admin" }));
    expect(res.status).toBe(201);
    expect(fetchUpstream).toHaveBeenCalledWith(
      "v1/admin/administrators",
      expect.objectContaining({ method: "POST", accessToken: "tok", body: { email: "second-admin@example.test", name: "Second Admin" } }),
    );
  });

  it("keeps the secrets shown once readable for the dialog", async () => {
    fetchUpstream.mockResolvedValue({ ok: true, status: 201, data: { data: RESULT } });
    const body = await (await createAdministrator(req({}, { email: RESULT.email, name: "Second Admin" }))).json();
    expect(body.data.temporaryPassword).toBe(RESULT.temporaryPassword);
    expect(body.data.totpSecretBase32).toBe(RESULT.totpSecretBase32);
    expect(body.data.otpauthUri).toBe(RESULT.otpauthUri);
  });

  it("refuses a bad CSRF token before the upstream", async () => {
    expect((await createAdministrator(req({ "X-CSRF-Token": "bad" }, { email: RESULT.email, name: "x" }))).status).toBe(403);
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("passes LAST_ADMINISTRATOR_PROTECTED and a duplicate through with their status", async () => {
    fetchUpstream.mockResolvedValue({ ok: false, status: 400, error: { error: { code: "VALIDATION_ERROR", message: "x" } } });
    const res = await createAdministrator(req({}, { email: RESULT.email, name: "x" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });
});

const user = (over: Partial<AdminUserDto>): AdminUserDto => ({
  id: "usr_x",
  email: "x@example.test",
  name: "X",
  role: "customer",
  status: "active",
  totpEnabled: true,
  mustChangePassword: false,
  lockedUntil: null,
  createdAt: "2026-11-01T10:00:00.000Z",
  ...over,
});

const groups = (html: string) =>
  [...html.matchAll(/role="group" aria-label="([^"]+)"[^>]*>(.*?)<\/div>/g)].map((x) => ({ who: x[1], html: x[2]! }));

describe("users table rows", () => {
  for (const [locale, m] of [["en", en], ["it", itMsgs]] as const) {
    const t = m.admin.users;
    const users = [
      user({ id: "usr_cust", name: "Customer One", email: "owner@example.test" }),
      user({ id: "usr_other", name: "Other Admin", email: "other@example.test", role: "server_admin" }),
      user({ id: "usr_me", name: "Me Admin", email: "admin@example.test", role: "server_admin" }),
    ];
    const html = render(createElement(UsersTable, { users, csrfToken: "csrf", currentUserId: "usr_me" }), locale);
    const rows = html.split("<tr").slice(2);

    it(`${locale}: a customer row keeps its three actions`, () => {
      const [cust] = rows;
      for (const s of [t.resetPassword, t.resetTotp, t.disable]) expect(cust).toContain(`>${s}</button>`);
      expect(cust).not.toContain(t.administrators.sshRepair);
    });

    it(`${locale}: another administrator's row has only disable and the command-line note`, () => {
      const other = rows[1]!;
      expect(other).toContain(`>${t.disable}</button>`);
      expect(other.match(/<button/g)).toHaveLength(1);
      expect(other).toContain(t.administrators.sshRepair);
      const disabled = render(
        createElement(UsersTable, { users: [user({ id: "usr_d", role: "server_admin", status: "disabled" })], csrfToken: "c", currentUserId: "usr_me" }),
        locale,
      );
      expect(disabled).toContain(`>${t.enable}</button>`);
      expect(disabled.match(/<button/g)).toHaveLength(1);
    });

    it(`${locale}: the own row has no action`, () => {
      const me = rows[2]!;
      expect(me).toContain("admin@example.test");
      expect(me).not.toContain("<button");
      expect(me).not.toContain(t.administrators.sshRepair);
      expect(groups(html).map((g) => g.who)).toEqual([
        t.actionsFor.replace("{name}", "Customer One"),
        t.actionsFor.replace("{name}", "Other Admin"),
      ]);
    });
  }
});

describe("administrator dialog", () => {
  it("TotpKey shows the open link and the key grouped by 4", () => {
    const html = render(createElement(TotpKey, { secretBase32: "ABCDEFGHIJ", otpauthUri: "otpauth://totp/x?secret=ABCDEFGHIJ" }));
    expect(html).toContain('href="otpauth://totp/x?secret=ABCDEFGHIJ"');
    expect(html).toContain(en.account.totpOpenLink);
    expect(html).toContain(en.account.totpManual);
    expect(html).toContain("ABCD EFGH IJ");
  });

  for (const [locale, m] of [["en", en], ["it", itMsgs]] as const) {
    it(`${locale}: the created body shows the password, the key and the administrator's notes`, () => {
      const t = m.admin.users;
      const html = render(createElement(AdministratorCreatedBody, { result: RESULT, name: "Second Admin" }), locale);
      expect(html).toContain(RESULT.temporaryPassword);
      expect(html).toContain("SENT INEL KEYA BCDE FGHI J");
      expect(html).toContain(t.administrators.tempNote.replace(/'/g, "&#x27;"));
      expect(html).not.toContain(t.tempNote.replace(/'/g, "&#x27;"));
      expect(html).toContain(t.administrators.totpTitle);
      expect(html).toContain(t.administrators.totpNote.replace(/'/g, "&#x27;"));
      expect(html).toContain(t.tempFor.replace("{name}", "Second Admin"));
    });

    it(`${locale}: the closed dialog shows only its trigger`, () => {
      const html = render(createElement(CreateAdministratorDialog, { csrfToken: "csrf" }), locale);
      expect(html).toContain(m.admin.users.administrators.create);
      expect(html).not.toContain(m.admin.users.administrators.submit);
    });
  }

  it("a hostile name is escaped, not rendered as markup", () => {
    const html = render(createElement(AdministratorCreatedBody, { result: RESULT, name: "<img src=x onerror=alert(1)>" }));
    expect(html).not.toContain("<img");
  });
});
