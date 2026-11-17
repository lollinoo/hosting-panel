import {
  auditEvents,
  createDatabaseClient,
  encryptSecretAesGcm,
  eq,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import * as crypto from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as password from "../src/auth/password.js";
import * as totp from "../src/auth/totp.js";
import { generateTotpSecret, totpCodeAt } from "../src/auth/totp.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";

vi.mock("../src/auth/password.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/auth/password.js")>();
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) };
});

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, scrypt: vi.fn(actual.scrypt) };
});

vi.mock("../src/auth/totp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/auth/totp.js")>();
  return { ...actual, verifyTotp: vi.fn(actual.verifyTotp) };
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
    expect(audits).toHaveLength(1);
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

  it("parallel wrong TOTP codes get at most 5 real checks", async () => {
    const secret = generateTotpSecret();
    await seedUser({ totpSecret: secret });
    const wrong = currentCode(secret) === "000000" ? "111111" : "000000";
    const spy = vi.mocked(totp.verifyTotp);
    spy.mockClear();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => login({ email: "mario@hotel.it", password: PASSWORD, totpCode: wrong })),
    );
    for (const r of results) expect([401, 423]).toContain(r.status);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(5);
    const row = await getUser();
    expect(row.totpFailedCount).toBe(5);
    expect(row.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    const refused = await login({ email: "mario@hotel.it", password: PASSWORD, totpCode: currentCode(secret) });
    expect(refused.status).toBe(423);
  });

  it("parallel wrong passwords get at most 5 real checks", async () => {
    await seedUser();
    const spy = vi.mocked(password.verifyPassword);
    spy.mockClear();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => login({ email: "mario@hotel.it", password: "nope nope" })),
    );
    for (const r of results) expect([401, 423]).toContain(r.status);
    expect(spy.mock.calls.filter(([, stored]) => stored === passwordHash).length).toBeLessThanOrEqual(5);
    expect((await getUser()).lockedUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it("a wrong password during a TOTP lock does not reopen the bypass", async () => {
    const secret = generateTotpSecret();
    await seedUser({ totpSecret: secret });
    const code = currentCode(secret);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      await login({ email: "mario@hotel.it", password: PASSWORD, totpCode: wrong });
    }
    expect((await login({ email: "mario@hotel.it", password: "nope nope" })).status).toBe(423);
    expect((await login({ email: "mario@hotel.it", password: "nope nope", totpCode: wrong })).status).toBe(423);
    expect((await getUser()).totpFailedCount).toBe(5);
    const refused = await login({ email: "mario@hotel.it", password: PASSWORD, totpCode: code });
    expect(refused.status).toBe(423);
  });

  async function passwordLock(email = "mario@hotel.it") {
    for (let i = 0; i < 5; i++) await login({ email, password: "nope nope" });
  }

  it("parallel wrong passwords with a code during a password lock get at most 5 real checks", async () => {
    const secret = generateTotpSecret();
    await seedUser({ totpSecret: secret });
    await passwordLock();
    const spy = vi.mocked(password.verifyPassword);
    spy.mockClear();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => login({ email: "mario@hotel.it", password: "still wrong", totpCode: "123456" })),
    );
    for (const r of results) expect(r.status).toBe(423);
    expect(spy.mock.calls.filter(([, stored]) => stored === passwordHash).length).toBeLessThanOrEqual(5);
    expect((await getUser()).totpFailedCount).toBe(5);
  });

  it("bypass attempts leave the same state whether or not the password is right", async () => {
    const secret = generateTotpSecret();
    await seedUser({ totpSecret: secret });
    await seedUser({ id: "usr_luigi", email: "luigi@hotel.it", totpSecret: secret });
    await passwordLock("mario@hotel.it");
    await passwordLock("luigi@hotel.it");
    const wrong = currentCode(secret) === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      const a = await login({ email: "mario@hotel.it", password: PASSWORD, totpCode: wrong });
      const b = await login({ email: "luigi@hotel.it", password: "nope nope", totpCode: wrong });
      expect(a.status).toBe(423);
      expect(b.status).toBe(423);
    }
    const mario = await getUser("usr_mario");
    const luigi = await getUser("usr_luigi");
    expect(mario.failedLoginCount).toBe(luigi.failedLoginCount);
    expect(mario.totpFailedCount).toBe(luigi.totpFailedCount);
    expect(Math.abs(mario.lockedUntil!.getTime() - luigi.lockedUntil!.getTime())).toBeLessThan(5_000);
    // Afterwards both answer a wrong password without code identically.
    expect((await login({ email: "mario@hotel.it", password: "nope nope" })).status).toBe(423);
    expect((await login({ email: "luigi@hotel.it", password: "nope nope" })).status).toBe(423);
  });

  it("a stale TOTP count does not block the bypass of a later password lock", async () => {
    const secret = generateTotpSecret();
    await seedUser({ totpSecret: secret });
    const code = currentCode(secret);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      await login({ email: "mario@hotel.it", password: PASSWORD, totpCode: wrong });
    }
    expect((await getUser()).totpFailedCount).toBe(5);
    await dbClient.db.update(users).set({ lockedUntil: new Date(Date.now() - 1_000) }).where(eq(users.id, "usr_mario"));
    await passwordLock();
    expect((await getUser()).lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    const ok = await login({ email: "mario@hotel.it", password: PASSWORD, totpCode: code });
    expect(ok.status).toBe(200);
  });

  const failureRows = async () =>
    (await dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, "auth.login.failure"))).length;

  it("100 sign-ins on a locked account and 100 on an unknown address add no audit row", async () => {
    await seedUser();
    await passwordLock();
    // One row per wrong password, the fifth (the one that sets the lock) included.
    expect(await failureRows()).toBe(5);
    for (let i = 0; i < 100; i += 10) {
      const batch = await Promise.all(
        Array.from({ length: 10 }, (_, j) =>
          login(j % 2 === 0 ? { email: "mario@hotel.it", password: PASSWORD } : { email: "mario@hotel.it", password: "nope nope", totpCode: "123456" }),
        ),
      );
      for (const r of batch) expect(r.status).toBe(423);
    }
    for (let i = 0; i < 100; i += 10) {
      const batch = await Promise.all(Array.from({ length: 10 }, (_, j) => login({ email: `ghost${i + j}@hotel.it`, password: PASSWORD })));
      for (const r of batch) expect(r.status).toBe(401);
    }
    expect(await failureRows()).toBe(5);
  }, 60_000);

  it("a bypass try with the right password and a wrong code on a locked account keeps its bad_totp row", async () => {
    const secret = generateTotpSecret();
    await seedUser({ totpSecret: secret });
    await passwordLock();
    expect(await failureRows()).toBe(5);
    const wrong = currentCode(secret) === "000000" ? "111111" : "000000";
    expect((await login({ email: "mario@hotel.it", password: PASSWORD, totpCode: wrong })).status).toBe(423);
    const rows = (await dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, "auth.login.failure"))).slice(5);
    expect(rows.map((r) => (r.details as { reason: string }).reason)).toEqual(["bad_totp"]);
    expect(JSON.stringify(rows[0])).not.toContain(wrong);
    expect(JSON.stringify(rows[0])).not.toContain(PASSWORD);
    // Tries refused before any check still add none.
    for (let i = 0; i < 100; i += 10) {
      const batch = await Promise.all(Array.from({ length: 10 }, () => login({ email: "mario@hotel.it", password: PASSWORD })));
      for (const r of batch) expect(r.status).toBe(423);
    }
    expect(await failureRows()).toBe(6);
  }, 60_000);

  it("a sign-in refused by the full password gate answers 429 RATE_LIMITED, writes no row and counts no try", async () => {
    await seedUser();
    const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
    const held: Parameters<typeof actual.scrypt>[] = [];
    vi.mocked(crypto.scrypt).mockImplementation(((...args: Parameters<typeof actual.scrypt>) => {
      held.push(args);
    }) as typeof actual.scrypt);
    // 2 run (held inside scrypt) and 16 wait: the gate is full.
    const busy = Array.from({ length: 18 }, () => password.hashPassword("sentinel-busy-pass"));
    try {
      for (const body of [
        { email: "mario@hotel.it", password: "nope nope" },
        { email: "mario@hotel.it", password: PASSWORD },
      ]) {
        const res = await login(body);
        expect(res.status).toBe(429);
        expect(((await res.json()) as Err).error.code).toBe("RATE_LIMITED");
      }
      // An unknown address gets no check while its share of 4 is taken, and the usual answer at once.
      const ghost = await login({ email: "ghost@hotel.it", password: PASSWORD });
      expect(ghost.status).toBe(401);
      expect(((await ghost.json()) as Err).error.code).toBe("INVALID_CREDENTIALS");
      expect(held).toHaveLength(2);
    } finally {
      vi.mocked(crypto.scrypt).mockImplementation(actual.scrypt);
      for (const args of held) actual.scrypt(...args);
      await Promise.all(busy);
    }
    const row = await getUser();
    expect([row.failedLoginCount, row.totpFailedCount, row.lockedUntil]).toEqual([0, 0, null]);
    expect(await failureRows()).toBe(0);
    // Once the gate drains, the same sign-in is served again.
    expect((await login({ email: "mario@hotel.it", password: PASSWORD })).status).toBe(200);
  });

  /** Holds every scrypt call until release() runs; later calls run for real. */
  async function holdScrypt() {
    const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
    const held: Parameters<typeof actual.scrypt>[] = [];
    vi.mocked(crypto.scrypt).mockImplementation(((...args: Parameters<typeof actual.scrypt>) => {
      held.push(args);
    }) as typeof actual.scrypt);
    return {
      held,
      release: () => {
        vi.mocked(crypto.scrypt).mockImplementation(actual.scrypt);
        for (const args of held.splice(0)) actual.scrypt(...args);
      },
    };
  }

  /** Sends the sign-ins at once; resolves when each one has answered or reached its password check. */
  async function sendAll(bodies: { email: string; password: string }[]) {
    const spy = vi.mocked(password.verifyPassword);
    const real = spy.getMockImplementation()!;
    const checked = new Set<string>();
    const placed = new Set<string>();
    let ready!: () => void;
    const allPlaced = new Promise<void>((resolve) => (ready = resolve));
    const place = (key: string) => {
      placed.add(key);
      if (placed.size === bodies.length) ready();
    };
    spy.mockImplementation((plain, stored, admitted) => {
      const result = real(plain, stored, admitted);
      checked.add(plain);
      place(plain);
      return result;
    });
    const answers = bodies.map(async (body) => {
      const res = await login(body);
      place(body.password);
      const json = (await res.json()) as Partial<Err> & Partial<Ok>;
      return { key: body.password, status: res.status, code: json.error?.code, message: json.error?.message };
    });
    await allPlaced;
    spy.mockImplementation(real);
    return { answers: Promise.all(answers), checked };
  }

  const ghosts = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ email: `ghost${i}@example.test`, password: `sentinel-ghost-${i}` }));

  it("with the gate held by sign-ins of unknown addresses, a real account with the right password is served", async () => {
    await seedUser({ email: "admin@example.test" });
    // The dummy hash exists before scrypt is held.
    expect((await login({ email: "warm@example.test", password: PASSWORD })).status).toBe(401);
    const gate = await holdScrypt();
    try {
      const flood = await sendAll(ghosts(30));
      const own = await sendAll([{ email: "admin@example.test", password: PASSWORD }]);
      expect(gate.held).toHaveLength(2);
      gate.release();
      const [answer] = await own.answers;
      expect(answer!.status).toBe(200);
      for (const a of await flood.answers) expect(a.status).toBe(401);
    } finally {
      gate.release();
    }
  });

  it("of many sign-ins of unknown addresses started in one tick, at most 4 reach the gate and none writes a row", async () => {
    expect((await login({ email: "warm@example.test", password: PASSWORD })).status).toBe(401);
    const rowsBefore = (await dbClient.db.select().from(auditEvents)).length;
    const gate = await holdScrypt();
    try {
      const flood = await sendAll(ghosts(30));
      expect(flood.checked.size).toBe(4);
      expect(gate.held).toHaveLength(2);
      gate.release();
      for (const a of await flood.answers) {
        expect(a).toMatchObject({ status: 401, code: "INVALID_CREDENTIALS", message: BAD_MESSAGE });
      }
    } finally {
      gate.release();
    }
    expect((await dbClient.db.select().from(auditEvents)).length).toBe(rowsBefore);
  });

  it("an unknown address answered at once and one answered after a check get the same answer", async () => {
    expect((await login({ email: "warm@example.test", password: PASSWORD })).status).toBe(401);
    const gate = await holdScrypt();
    try {
      const flood = await sendAll(ghosts(8));
      gate.release();
      const answers = await flood.answers;
      const afterCheck = answers.filter((a) => flood.checked.has(a.key));
      const atOnce = answers.filter((a) => !flood.checked.has(a.key));
      expect([afterCheck.length, atOnce.length]).toEqual([4, 4]);
      for (const a of answers) {
        expect({ status: a.status, code: a.code, message: a.message }).toEqual({ status: 401, code: "INVALID_CREDENTIALS", message: BAD_MESSAGE });
      }
    } finally {
      gate.release();
    }
  });
});
