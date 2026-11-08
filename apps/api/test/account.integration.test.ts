import {
  auditEvents,
  createDatabaseClient,
  encryptSecretAesGcm,
  eq,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import { findForbiddenPublicDtoKeys } from "@hosting-panel/contracts";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../src/auth/password.js";
import { generateTotpSecret, totpCodeAt } from "../src/auth/totp.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";

const MASTER_KEY = Buffer.alloc(32, 7);
const PASSWORD = "correct horse battery";
const NEW_PASSWORD = "another long passphrase";
const codeNow = (secret: string, offset = 0) => totpCodeAt(secret, Math.floor(Date.now() / 30_000) + offset);

describe("self-service account API", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let passwordHash: string;

  beforeAll(async () => {
    passwordHash = await hashPassword(PASSWORD);
  });

  beforeEach(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    app = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      secretsMasterKey: MASTER_KEY,
    });
  });

  afterEach(async () => {
    await app.close();
    await dbClient.close();
  });

  async function seed(id: string, opts: { admin?: boolean; totpSecret?: string; mustChange?: boolean } = {}) {
    let totp = {};
    if (opts.totpSecret) {
      const env = encryptSecretAesGcm({
        plaintext: opts.totpSecret,
        masterKey: MASTER_KEY,
        organizationId: "platform",
        siteId: null,
        secretKey: `totp:${id}`,
      });
      totp = {
        totpCiphertextBase64: env.ciphertextBase64,
        totpIvBase64: env.ivBase64,
        totpAuthTagBase64: env.authTagBase64,
        totpEnabledAt: new Date(),
      };
    }
    await dbClient.db.insert(users).values({
      id,
      email: `${id}@hotel.it`,
      name: id,
      passwordHash,
      platformRole: opts.admin ? "infrastructure_admin" : null,
      mustChangePassword: opts.mustChange ?? false,
      ...totp,
    });
  }

  async function loginToken(id: string, password = PASSWORD, totpCode?: string): Promise<string> {
    const res = await fetch(`${app.baseUrl!}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `${id}@hotel.it`, password, totpCode }),
    });
    const json = (await res.json()) as { data: { accessToken: string } };
    return json.data.accessToken;
  }

  function call(token: string, method: string, path: string, body?: unknown) {
    return fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  const me = async (token: string) =>
    ((await (await call(token, "GET", "/v1/me")).json()) as { data: { user: Record<string, unknown> } }).data.user;

  it("change password revokes other sessions", async () => {
    await seed("usr_a", { mustChange: true });
    const a = await loginToken("usr_a");
    const b = await loginToken("usr_a");
    const res = await call(a, "POST", "/v1/me/password", { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(204);
    expect((await call(a, "GET", "/v1/me")).status).toBe(200);
    expect((await call(b, "GET", "/v1/me")).status).toBe(401);
    expect((await me(a)).mustChangePassword).toBe(false);
    expect(await loginToken("usr_a", NEW_PASSWORD)).toBeTruthy();
    const audits = await dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, "account.password.change"));
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toContain(NEW_PASSWORD);
    expect(JSON.stringify(audits)).not.toContain(PASSWORD);
  });

  it("wrong current password is rejected", async () => {
    await seed("usr_a");
    const a = await loginToken("usr_a");
    const res = await call(a, "POST", "/v1/me/password", { currentPassword: "nope nope nope", newPassword: NEW_PASSWORD });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("INVALID_CREDENTIALS");
  });

  it("new password under 12 chars is rejected", async () => {
    await seed("usr_a");
    const a = await loginToken("usr_a");
    const res = await call(a, "POST", "/v1/me/password", { currentPassword: PASSWORD, newPassword: "short" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR");
  });

  it("requires authentication", async () => {
    const res = await fetch(`${app.baseUrl!}/v1/me/totp/setup`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("totp setup then enable", async () => {
    await seed("usr_a");
    const a = await loginToken("usr_a");
    const setup = await call(a, "POST", "/v1/me/totp/setup");
    expect(setup.status).toBe(200);
    const { secretBase32, otpauthUri } = ((await setup.json()) as { data: { secretBase32: string; otpauthUri: string } }).data;
    expect(otpauthUri).toContain("Hosting%20Panel");
    expect((await me(a)).totpEnabled).toBe(false);
    expect((await call(a, "POST", "/v1/me/totp/enable", { code: "000000" })).status).toBe(401);
    const res = await call(a, "POST", "/v1/me/totp/enable", { code: codeNow(secretBase32) });
    expect(res.status).toBe(204);
    expect((await me(a)).totpEnabled).toBe(true);
    expect((await call(a, "POST", "/v1/me/totp/setup")).status).toBe(400);
    const audits = await dbClient.db.select().from(auditEvents);
    expect(JSON.stringify(audits)).not.toContain(secretBase32);
  });

  it("server admin cannot disable totp", async () => {
    const secret = generateTotpSecret();
    await seed("usr_admin", { admin: true, totpSecret: secret });
    const t = await loginToken("usr_admin", PASSWORD, codeNow(secret));
    const res = await call(t, "POST", "/v1/me/totp/disable", { password: PASSWORD, code: codeNow(secret, 1) });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("PERMISSION_DENIED");
  });

  it("customer can disable totp with password and code", async () => {
    const secret = generateTotpSecret();
    await seed("usr_a", { totpSecret: secret });
    const t = await loginToken("usr_a", PASSWORD, codeNow(secret));
    const bad = await call(t, "POST", "/v1/me/totp/disable", { password: "wrong wrong wrong", code: codeNow(secret, 1) });
    expect(bad.status).toBe(401);
    const res = await call(t, "POST", "/v1/me/totp/disable", { password: PASSWORD, code: codeNow(secret, 1) });
    expect(res.status).toBe(204);
    expect((await me(t)).totpEnabled).toBe(false);
    const [row] = await dbClient.db.select().from(users).where(eq(users.id, "usr_a"));
    expect(row!.totpCiphertextBase64).toBeNull();
    expect(row!.totpLastStep).toBeNull();
  });

  it("locale round-trip", async () => {
    await seed("usr_a");
    const a = await loginToken("usr_a");
    expect((await call(a, "PATCH", "/v1/me/locale", { locale: "en" })).status).toBe(204);
    expect((await me(a)).locale).toBe("en");
    const bad = await call(a, "PATCH", "/v1/me/locale", { locale: "fr" });
    expect(bad.status).toBe(400);
  });

  it("/v1/me exposes no secret material", async () => {
    const secret = generateTotpSecret();
    await seed("usr_a", { totpSecret: secret });
    const t = await loginToken("usr_a", PASSWORD, codeNow(secret));
    const res = await call(t, "GET", "/v1/me");
    const text = await res.text();
    expect(findForbiddenPublicDtoKeys(JSON.parse(text))).toEqual([]);
    expect(text).not.toContain(secret);
    expect(text).not.toContain("passwordHash");
    expect(((JSON.parse(text) as { data: { user: Record<string, unknown> } }).data.user).isServerAdmin).toBe(false);
  });
});
