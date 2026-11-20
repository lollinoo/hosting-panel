import { createDatabaseClient, users, type DatabaseClient } from "@hosting-panel/database";
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
const LOCK_MS = 15 * 60_000;
// Not exported by the service: the cap of the in-memory map of unknown addresses.
const UNKNOWN_ADDRESSES_MAX = 10_000;

type Tries = Map<string, { count: number; lockedUntil: number }>;
type Internals = { unknownTries: Tries };

// Oracle QA of the sign-in: an unknown address must look like an account (#9) and one address holds one gate place (LR-M1).
describe("login oracle (#9, LR-M1)", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let service: LoginService;
  let internals: Internals;
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
    service = app.nestApp.get(LoginService);
    internals = service as unknown as Internals;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await app.close();
    await dbClient.close();
  });

  async function seedUser(email: string): Promise<void> {
    await dbClient.db.insert(users).values({
      id: `usr_${email.split("@")[0]}`,
      email,
      name: "Test",
      passwordHash,
    });
  }

  async function signIn(email: string, plain: string, totpCode?: string) {
    const res = await fetch(`${app.baseUrl!}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: plain, ...(totpCode ? { totpCode } : {}) }),
    });
    const json = (await res.json()) as { error?: { code: string; message: string } };
    return {
      status: res.status,
      code: json.error?.code,
      message: json.error?.message,
      keys: Object.keys(json).sort(),
      errorKeys: Object.keys(json.error ?? {}).sort(),
    };
  }

  const wrong = (email: string) => signIn(email, "nope nope");
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

  it("8 wrong sign-ins give identical status, code and body keys for an account, an unknown address and its other spellings", async () => {
    await seedUser("mario@hotel.it");
    await seedUser("luigi@hotel.it");
    const spellings = ["  Ghost2@Hotel.IT ", "GHOST2@hotel.it", "ghost2@hotel.it", " ghost2@HOTEL.it"];
    const runs: Record<string, ReturnType<typeof wrong> extends Promise<infer R> ? R[] : never> = {
      account: [],
      paddedAccount: [],
      ghost: [],
      mixedGhost: [],
    };
    for (let i = 0; i < 8; i++) {
      runs.account!.push(await wrong("mario@hotel.it"));
      runs.paddedAccount!.push(await wrong("  LUIGI@Hotel.it "));
      runs.ghost!.push(await wrong("ghost@hotel.it"));
      runs.mixedGhost!.push(await wrong(spellings[i % spellings.length]!));
    }
    const shape = (rows: typeof runs.account) => rows!.map((r) => [r.status, r.code, r.keys, r.errorKeys, r.message]);
    const expected = shape(runs.account);
    expect(expected.map((r) => r[0])).toEqual([401, 401, 401, 401, 401, 423, 423, 423]);
    expect(expected.map((r) => r[1])).toEqual([
      ...Array(5).fill("INVALID_CREDENTIALS"),
      ...Array(3).fill("ACCOUNT_LOCKED"),
    ]);
    expect(expected[0]![2]).toEqual(["error"]);
    for (const name of ["paddedAccount", "ghost", "mixedGhost"]) expect(shape(runs[name]), name).toEqual(expected);
  });

  it("a locked account and a locked unknown address answer 423 to any password and run no scrypt", async () => {
    await seedUser("mario@hotel.it");
    for (let i = 0; i < 5; i++) {
      await wrong("mario@hotel.it");
      await wrong("ghost@hotel.it");
    }
    const verify = vi.mocked(password.verifyPassword);
    verify.mockClear();
    vi.mocked(crypto.scrypt).mockClear();
    for (const email of ["mario@hotel.it", "ghost@hotel.it"]) {
      for (const attempt of [
        signIn(email, PASSWORD),
        signIn(email, "nope nope"),
        signIn(email, PASSWORD, "123456"),
        signIn(email.toUpperCase(), PASSWORD),
      ]) {
        expect(await attempt).toMatchObject({ status: 423, code: "ACCOUNT_LOCKED" });
      }
    }
    expect(verify).not.toHaveBeenCalled();
    expect(crypto.scrypt).not.toHaveBeenCalled();
    expect(password.passwordGateLoad()).toBe(0);
  });

  it("a lock that is not over yet still answers 423 and the unknown address counts again from zero when it is over", async () => {
    await seedUser("mario@hotel.it");
    for (let i = 0; i < 5; i++) {
      await wrong("mario@hotel.it");
      await wrong("ghost@hotel.it");
    }
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    vi.setSystemTime(start + LOCK_MS - 5_000);
    for (const email of ["mario@hotel.it", "ghost@hotel.it"]) expect((await wrong(email)).status).toBe(423);
    vi.setSystemTime(start + LOCK_MS + 1_000);
    const sequences: number[][] = [];
    for (const email of ["mario@hotel.it", "ghost@hotel.it"]) {
      const statuses: number[] = [];
      for (let i = 0; i < 7; i++) statuses.push((await wrong(email)).status);
      sequences.push(statuses);
    }
    // Zero tries are kept: 5 more 401, the fifth one locks again.
    expect(sequences[0]).toEqual([401, 401, 401, 401, 401, 423, 423]);
    expect(sequences[1]).toEqual(sequences[0]);
  });

  it("the map of unknown addresses stays at its cap and drops the oldest address first", async () => {
    for (let i = 0; i < UNKNOWN_ADDRESSES_MAX; i++) internals.unknownTries.set(`k${i}@x.it`, { count: 1, lockedUntil: 0 });
    expect((await wrong("fresh@x.it")).status).toBe(401);
    expect(internals.unknownTries.size).toBe(UNKNOWN_ADDRESSES_MAX);
    expect(internals.unknownTries.has("k0@x.it")).toBe(false);
    expect(internals.unknownTries.has("k1@x.it")).toBe(true);
    expect(internals.unknownTries.get("fresh@x.it")).toMatchObject({ count: 1 });
    // A try on an address already in the map is counted without evicting anyone.
    expect((await wrong("k1@x.it")).status).toBe(401);
    expect(internals.unknownTries.size).toBe(UNKNOWN_ADDRESSES_MAX);
    expect(internals.unknownTries.has("k1@x.it")).toBe(true);
    expect(internals.unknownTries.get("k1@x.it")).toMatchObject({ count: 2 });
  });

  it("10 parallel wrong sign-ins of one address hold one gate place and another address is served meanwhile", async () => {
    await seedUser("mario@hotel.it");
    await seedUser("other@hotel.it");
    const gate = await holdScrypt();
    let peak = 0;
    const sampler = setInterval(() => (peak = Math.max(peak, password.passwordGateLoad())), 1);
    try {
      const burst = Array.from({ length: 10 }, () => wrong("mario@hotel.it"));
      await vi.waitFor(() => expect(gate.held).toHaveLength(1));
      // The nine queued sign-ins hold no place, however long we look.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(password.passwordGateLoad()).toBe(1);
      expect(gate.held).toHaveLength(1);
      expect(password.passwordCheckLines.size).toBe(1);

      const other = signIn("other@hotel.it", PASSWORD);
      await vi.waitFor(() => expect(gate.held).toHaveLength(2));
      expect(password.passwordGateLoad()).toBe(2);
      gate.release();
      expect((await other).status).toBe(200);

      const statuses = (await Promise.all(burst)).map((r) => r.status).sort();
      expect(statuses).toEqual([401, 401, 401, 401, 401, 423, 423, 423, 423, 423]);
    } finally {
      clearInterval(sampler);
      gate.release();
    }
    expect(peak).toBeLessThanOrEqual(2);
  }, 30_000);

  it("the per-address chains are all gone after the requests end, thrown ones included", async () => {
    await seedUser("mario@hotel.it");
    const addresses = ["mario@hotel.it", "ghost@hotel.it", "bad@hotel.it"];
    const calls = addresses.flatMap((email) =>
      Array.from({ length: 4 }, () => service.login({ email, password: "nope nope" }, null)),
    );
    // One chain per address in flight, not one per request.
    expect(password.passwordCheckLines.size).toBe(addresses.length);
    const results = await Promise.allSettled(calls);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    await settle();
    expect(password.passwordCheckLines.size).toBe(0);

    // A request that fails with something else than a ControlPlaneError neither leaks nor blocks the address.
    vi.spyOn(dbClient.db, "select").mockImplementationOnce(() => {
      throw new Error("db down");
    });
    await expect(service.login({ email: "bad@hotel.it", password: PASSWORD }, null)).rejects.toThrow("db down");
    await settle();
    expect(password.passwordCheckLines.size).toBe(0);
    vi.mocked(dbClient.db.select).mockRestore();
    await seedUser("bad@hotel.it");
    await expect(service.login({ email: "bad@hotel.it", password: PASSWORD }, null)).resolves.toMatchObject({
      status: "ok",
    });
    await settle();
    expect(password.passwordCheckLines.size).toBe(0);
  });
});
