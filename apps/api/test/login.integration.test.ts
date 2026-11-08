import {
  auditEvents,
  createDatabaseClient,
  encryptSecretAesGcm,
  eq,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as password from "../src/auth/password.js";
import { generateTotpSecret, totpCodeAt } from "../src/auth/totp.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";

vi.mock("../src/auth/password.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/auth/password.js")>();
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) };
});

const MASTER_KEY = Buffer.alloc(32, 7);
const PASSWORD = "correct horse battery";
const BAD_MESSAGE = "Email o password non corretti.";

describe("POST /v1/auth/login", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let passwordHash: string;

  beforeAll(async () => {
    passwordHash = await password.hashPassword(PASSWORD);
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

  afterAll(() => {
    vi.restoreAllMocks();
  });

  async function seedUser(opts: {
    id?: string;
    email?: string;
    platformRole?: "infrastructure_admin" | null;
    totpSecret?: string;
    mustChangePassword?: boolean;
  } = {}): Promise<string> {
    const id = opts.id ?? "usr_mario";
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
      email: opts.email ?? "mario@hotel.it",
      name: "Mario",
      passwordHash,
      platformRole: opts.platformRole ?? null,
      mustChangePassword: opts.mustChangePassword ?? false,
      ...totp,
    });
    return id;
  }

  function login(body: unknown) {
    return fetch(`${app.baseUrl!}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  type Ok = { data: { status: string; accessToken?: string; expiresAt?: string; mustChangePassword?: boolean } };
  type Err = { error: { code: string; message: string } };

  async function getUser(id = "usr_mario") {
    const [row] = await dbClient.db.select().from(users).where(eq(users.id, id));
    return row!;
  }

  const currentCode = (secret: string) => totpCodeAt(secret, Math.floor(Date.now() / 30_000));

  it("logs in with correct password", async () => {
    await seedUser();
    const res = await login({ email: "mario@hotel.it", password: PASSWORD });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Ok;
    expect(json.data.status).toBe("ok");
    expect(json.data.mustChangePassword).toBe(false);
    const me = await fetch(`${app.baseUrl!}/v1/me`, {
      headers: { Authorization: `Bearer ${json.data.accessToken!}` },
    });
    expect(me.status).toBe(200);
    const audits = await dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, "auth.login.success"));
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toContain(PASSWORD);
  });

  it("unknown email and wrong password return identical errors", async () => {
    await seedUser();
    const a = await login({ email: "nobody@hotel.it", password: PASSWORD });
    const b = await login({ email: "mario@hotel.it", password: "wrong password" });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    const ja = (await a.json()) as Err;
    const jb = (await b.json()) as Err;
    expect(ja.error.code).toBe("INVALID_CREDENTIALS");
    expect(jb.error.code).toBe("INVALID_CREDENTIALS");
    expect(ja.error.message).toBe(BAD_MESSAGE);
    expect(jb.error.message).toBe(ja.error.message);
    const audits = await dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, "auth.login.failure"));
    expect(audits).toHaveLength(2);
    expect(JSON.stringify(audits)).not.toContain("wrong password");
  });

  it("login is case- and whitespace-insensitive on email", async () => {
    await seedUser();
    const res = await login({ email: "  Mario@Hotel.IT ", password: PASSWORD });
    expect(res.status).toBe(200);
  });

  it("locks after 5 failures for 15 minutes", async () => {
    await seedUser();
    for (let i = 0; i < 5; i++) {
      expect((await login({ email: "mario@hotel.it", password: "nope nope" })).status).toBe(401);
    }
    const locked = await login({ email: "mario@hotel.it", password: PASSWORD });
    expect(locked.status).toBe(423);
    expect(((await locked.json()) as Err).error.code).toBe("ACCOUNT_LOCKED");
    const row = await getUser();
    const minutes = (row.lockedUntil!.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15);
    await dbClient.db.update(users).set({ lockedUntil: new Date(Date.now() - 1_000) }).where(eq(users.id, "usr_mario"));
    expect((await login({ email: "mario@hotel.it", password: PASSWORD })).status).toBe(200);
  });

  it("requires TOTP when enabled", async () => {
    const secret = generateTotpSecret();
    await seedUser({ totpSecret: secret });
    const first = await login({ email: "mario@hotel.it", password: PASSWORD });
    expect(first.status).toBe(200);
    expect(((await first.json()) as Ok).data).toEqual({ status: "totp_required" });
    const code = currentCode(secret);
    const wrong = await login({
      email: "mario@hotel.it",
      password: PASSWORD,
      totpCode: code === "000000" ? "111111" : "000000",
    });
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as Err).error.code).toBe("TOTP_INVALID");
    const ok = await login({ email: "mario@hotel.it", password: PASSWORD, totpCode: code });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as Ok).data.status).toBe("ok");
  });

  it("rejects reused TOTP code", async () => {
    const secret = generateTotpSecret();
    await seedUser({ totpSecret: secret });
    const code = currentCode(secret);
    expect((await login({ email: "mario@hotel.it", password: PASSWORD, totpCode: code })).status).toBe(200);
    const again = await login({ email: "mario@hotel.it", password: PASSWORD, totpCode: code });
    expect(again.status).toBe(401);
    expect(((await again.json()) as Err).error.code).toBe("TOTP_INVALID");
  });

  it("server admin without TOTP cannot log in", async () => {
    await seedUser({ platformRole: "infrastructure_admin" });
    const res = await login({ email: "mario@hotel.it", password: PASSWORD });
    expect(res.status).toBe(403);
    expect(((await res.json()) as Err).error.code).toBe("ACCOUNT_SETUP_INCOMPLETE");
  });

  it("mustChangePassword is reported", async () => {
    await seedUser({ mustChangePassword: true });
    const res = await login({ email: "mario@hotel.it", password: PASSWORD });
    expect(((await res.json()) as Ok).data.mustChangePassword).toBe(true);
  });

  it("unknown email still costs a password check", async () => {
    const spy = vi.mocked(password.verifyPassword);
    spy.mockClear();
    const res = await login({ email: "ghost@hotel.it", password: PASSWORD });
    expect(res.status).toBe(401);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("parallel wrong passwords cannot exceed the lockout", async () => {
    await seedUser();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => login({ email: "mario@hotel.it", password: "nope nope" })),
    );
    for (const r of results) expect([401, 423]).toContain(r.status);
    const row = await getUser();
    expect(row.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(row.failedLoginCount).toBeLessThan(5);
    expect((await login({ email: "mario@hotel.it", password: PASSWORD })).status).toBe(423);
  });

  it("parallel reuse of one TOTP code succeeds at most once", async () => {
    const secret = generateTotpSecret();
    await seedUser({ totpSecret: secret });
    const code = currentCode(secret);
    const results = await Promise.all([
      login({ email: "mario@hotel.it", password: PASSWORD, totpCode: code }),
      login({ email: "mario@hotel.it", password: PASSWORD, totpCode: code }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it("correct password and valid TOTP bypass lockout", async () => {
    const secret = generateTotpSecret();
    await seedUser({ totpSecret: secret });
    for (let i = 0; i < 5; i++) {
      await login({ email: "mario@hotel.it", password: "nope nope" });
    }
    expect((await getUser()).lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    const noCode = await login({ email: "mario@hotel.it", password: PASSWORD });
    expect(noCode.status).toBe(423);
    expect(((await noCode.json()) as Err).error.code).toBe("ACCOUNT_LOCKED");
    const ok = await login({ email: "mario@hotel.it", password: PASSWORD, totpCode: currentCode(secret) });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as Ok).data.status).toBe("ok");
    const row = await getUser();
    expect(row.lockedUntil).toBeNull();
    expect(row.failedLoginCount).toBe(0);
  });

  it("5 wrong TOTP codes lock the account and refuse the bypass", async () => {
    const secret = generateTotpSecret();
    await seedUser({ totpSecret: secret });
    const code = currentCode(secret);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      await login({ email: "mario@hotel.it", password: PASSWORD, totpCode: wrong });
    }
    expect((await getUser()).totpFailedCount).toBe(5);
    const refused = await login({ email: "mario@hotel.it", password: PASSWORD, totpCode: code });
    expect(refused.status).toBe(423);
    expect(((await refused.json()) as Err).error.code).toBe("ACCOUNT_LOCKED");
    await dbClient.db.update(users).set({ lockedUntil: new Date(Date.now() - 1_000) }).where(eq(users.id, "usr_mario"));
    const ok = await login({ email: "mario@hotel.it", password: PASSWORD, totpCode: code });
    expect(ok.status).toBe(200);
    const row = await getUser();
    expect(row.totpFailedCount).toBe(0);
    expect(row.lockedUntil).toBeNull();
  });

  it("wrong TOTP codes while locked still count", async () => {
    const secret = generateTotpSecret();
    await seedUser({ totpSecret: secret });
    for (let i = 0; i < 5; i++) {
      await login({ email: "mario@hotel.it", password: "nope nope" });
    }
    expect((await getUser()).lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    const wrong = currentCode(secret) === "000000" ? "111111" : "000000";
    for (let i = 0; i < 2; i++) {
      const res = await login({ email: "mario@hotel.it", password: PASSWORD, totpCode: wrong });
      expect(res.status).toBe(423);
    }
    expect((await getUser()).totpFailedCount).toBe(2);
  });
});
