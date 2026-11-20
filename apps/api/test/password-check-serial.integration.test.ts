import { createDatabaseClient, eq, users, type DatabaseClient } from "@hosting-panel/database";
import * as crypto from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginService } from "../src/auth/login.service.js";
import * as password from "../src/auth/password.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";

vi.mock("../src/auth/password.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/auth/password.js")>();
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) };
});

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, scrypt: vi.fn(actual.scrypt) };
});

const MASTER_KEY = Buffer.alloc(32, 7);
const PASSWORD = "correct horse battery";
const NEW_PASSWORD = "another long passphrase";

// LR-M1: every password check of one account (sign-in, password change, 2FA off) runs in one line, so the account holds one gate place.
describe("password checks run one at a time per account (LR-M1)", () => {
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

  async function seed(id: string): Promise<void> {
    await dbClient.db.insert(users).values({ id, email: `${id}@hotel.it`, name: id, passwordHash, mustChangePassword: false });
  }

  async function signIn(email: string, plain: string) {
    const res = await fetch(`${app.baseUrl!}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: plain }),
    });
    const json = (await res.json()) as { data?: { accessToken: string }; error?: { code: string } };
    return { status: res.status, code: json.error?.code, token: json.data?.accessToken };
  }

  async function send(token: string, path: string, body: unknown) {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = res.status === 204 ? {} : ((await res.json()) as { error?: { code: string } });
    return { status: res.status, code: json.error?.code };
  }

  const post = async (token: string, path: string, body: unknown) => (await send(token, path, body)).status;

  const wrongChange = (token: string) => post(token, "/v1/me/password", { currentPassword: "nope nope", newPassword: NEW_PASSWORD });
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

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

  it("a sign-in address over 254 characters answers 400 VALIDATION_ERROR before any count or check", async () => {
    const service = app.nestApp.get(LoginService) as unknown as { unknownTries: Map<string, unknown> };
    const verify = vi.mocked(password.verifyPassword);
    verify.mockClear();
    const res = await signIn(`${"a".repeat(246)}@hotel.it`, "nope nope");
    expect(res).toMatchObject({ status: 400, code: "VALIDATION_ERROR" });
    expect(service.unknownTries.size).toBe(0);
    expect(verify).not.toHaveBeenCalled();
  });

  it("wrong password changes, 2FA off and a sign-in of one account hold one gate place; another account is served meanwhile", async () => {
    await seed("usr_a");
    await seed("usr_b");
    const a = (await signIn("usr_a@hotel.it", PASSWORD)).token!;
    const b = (await signIn("usr_b@hotel.it", PASSWORD)).token!;
    const verify = vi.mocked(password.verifyPassword);
    verify.mockClear();
    const gate = await holdScrypt();
    let peak = 0;
    const sampler = setInterval(() => (peak = Math.max(peak, password.passwordGateLoad())), 1);
    try {
      const burst = [
        wrongChange(a),
        wrongChange(a),
        post(a, "/v1/me/totp/disable", { password: "nope nope", code: "000000" }),
        signIn(" USR_A@hotel.it", "nope nope").then((r) => r.status),
      ];
      await vi.waitFor(() => expect(gate.held).toHaveLength(1));
      // The queued checks hold no place, however long we look.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(password.passwordGateLoad()).toBe(1);
      expect(verify).toHaveBeenCalledTimes(1);
      expect(password.passwordCheckLines.size).toBe(1);

      const other = post(b, "/v1/me/password", { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
      await vi.waitFor(() => expect(gate.held).toHaveLength(2));
      expect(password.passwordCheckLines.size).toBe(2);
      gate.release();
      expect(await other).toBe(204);
      expect(await Promise.all(burst)).toEqual([401, 401, 401, 401]);
    } finally {
      clearInterval(sampler);
      gate.release();
    }
    expect(peak).toBeLessThanOrEqual(2);
    await settle();
    expect(password.passwordCheckLines.size).toBe(0);
  }, 30_000);

  it("a sign-in and a password change of the same account run one after the other", async () => {
    await seed("usr_a");
    const a = (await signIn("usr_a@hotel.it", PASSWORD)).token!;
    const verify = vi.mocked(password.verifyPassword);
    verify.mockClear();
    const gate = await holdScrypt();
    try {
      const login = signIn("usr_a@hotel.it", PASSWORD);
      await vi.waitFor(() => expect(gate.held).toHaveLength(1));
      const change = post(a, "/v1/me/password", { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
      await new Promise((resolve) => setTimeout(resolve, 100));
      // The change waits for the sign-in: no second check started.
      expect(verify).toHaveBeenCalledTimes(1);
      gate.release();
      expect((await login).status).toBe(200);
      expect(await change).toBe(204);
      expect(verify).toHaveBeenCalledTimes(2);
    } finally {
      gate.release();
    }
    await settle();
    expect(password.passwordCheckLines.size).toBe(0);
  }, 30_000);

  it("two changes with the same current password: the second checks the hash left by the first and is refused", async () => {
    await seed("usr_a");
    const a = (await signIn("usr_a@hotel.it", PASSWORD)).token!;
    const OTHER_PASSWORD = "yet another long passphrase";
    const gate = await holdScrypt();
    let statuses: number[];
    try {
      const first = post(a, "/v1/me/password", { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
      await vi.waitFor(() => expect(gate.held).toHaveLength(1));
      const second = post(a, "/v1/me/password", { currentPassword: PASSWORD, newPassword: OTHER_PASSWORD });
      // The second request is authenticated and waits in the line.
      await new Promise((resolve) => setTimeout(resolve, 100));
      gate.release();
      statuses = await Promise.all([first, second]);
    } finally {
      gate.release();
    }
    expect(statuses).toEqual([204, 401]);
    const [row] = await dbClient.db.select().from(users);
    expect(await password.verifyPassword(NEW_PASSWORD, row!.passwordHash!)).toBe(true);
    await settle();
    expect(password.passwordCheckLines.size).toBe(0);
  }, 30_000);

  it("2FA off after a password change: it checks the hash left by the change and is refused", async () => {
    await seed("usr_a");
    const a = (await signIn("usr_a@hotel.it", PASSWORD)).token!;
    const gate = await holdScrypt();
    let results: { status: number; code?: string }[];
    try {
      const change = send(a, "/v1/me/password", { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
      await vi.waitFor(() => expect(gate.held).toHaveLength(1));
      const off = send(a, "/v1/me/totp/disable", { password: PASSWORD, code: "000000" });
      await new Promise((resolve) => setTimeout(resolve, 100));
      gate.release();
      results = await Promise.all([change, off]);
    } finally {
      gate.release();
    }
    // TOTP_INVALID is also 401: only the code tells that the password check failed.
    expect(results).toEqual([{ status: 204 }, { status: 401, code: "INVALID_CREDENTIALS" }]);
    await settle();
    expect(password.passwordCheckLines.size).toBe(0);
  }, 30_000);

  it("a change queued before the account is disabled is refused like any request of a disabled account", async () => {
    await seed("usr_a");
    const a = (await signIn("usr_a@hotel.it", PASSWORD)).token!;
    const gate = await holdScrypt();
    let results: { status: number; code?: string }[];
    try {
      const first = send(a, "/v1/me/password", { currentPassword: "nope nope", newPassword: NEW_PASSWORD });
      await vi.waitFor(() => expect(gate.held).toHaveLength(1));
      const queued = send(a, "/v1/me/password", { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
      // The queued request is authenticated and waits in the line; then an admin disables the account.
      await new Promise((resolve) => setTimeout(resolve, 100));
      await dbClient.db.update(users).set({ userStatus: "disabled" }).where(eq(users.id, "usr_a"));
      gate.release();
      results = await Promise.all([first, queued]);
    } finally {
      gate.release();
    }
    expect(results).toEqual([
      { status: 401, code: "INVALID_CREDENTIALS" },
      { status: 401, code: "UNAUTHENTICATED" },
    ]);
    const [row] = await dbClient.db.select().from(users);
    expect(row!.passwordHash).toBe(passwordHash);
    await settle();
    expect(password.passwordCheckLines.size).toBe(0);
  }, 30_000);

  it("a reset that lands while a change checks the password is kept, and the change is refused", async () => {
    await seed("usr_a");
    const a = (await signIn("usr_a@hotel.it", PASSWORD)).token!;
    const resetHash = await password.hashPassword("a password set by the admin");
    const gate = await holdScrypt();
    let result: { status: number; code?: string };
    try {
      const change = send(a, "/v1/me/password", { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
      // The change has read the hash and is checking it; the reset runs outside the line.
      await vi.waitFor(() => expect(gate.held).toHaveLength(1));
      await dbClient.db.update(users).set({ passwordHash: resetHash, mustChangePassword: true }).where(eq(users.id, "usr_a"));
      gate.release();
      result = await change;
    } finally {
      gate.release();
    }
    expect(result).toEqual({ status: 401, code: "INVALID_CREDENTIALS" });
    const [row] = await dbClient.db.select().from(users);
    expect(row).toMatchObject({ passwordHash: resetHash, mustChangePassword: true });
    await settle();
    expect(password.passwordCheckLines.size).toBe(0);
  }, 30_000);
});
