import { auditEvents, createDatabaseClient, eq, hosts, userSessions, users, type DatabaseClient } from "@hosting-panel/database";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  runCli,
  createServerAdmin,
  resetUserPassword,
  resetUserTotp,
  setupInstallation,
  unlockUser,
} from "../src/cli/accounts.js";
import { totpCodeAt } from "../src/auth/totp.js";
import { verifyPassword } from "../src/auth/password.js";
import { createControlPlaneApp } from "../src/index.js";

const KEY = Buffer.alloc(32, 9);
const PW = "correct horse battery";
const SETUP = { installationName: "Test", hostHostname: "host.test", hostIpv4: "10.0.0.1" };

describe("accounts CLI", () => {
  let dbClient: DatabaseClient;
  beforeEach(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
  });
  afterEach(async () => {
    await dbClient.close();
  });
  const db = () => dbClient.db;
  const getUser = async (email: string) => (await db().select().from(users).where(eq(users.email, email)))[0]!;

  it("setupInstallation is idempotent", async () => {
    const a = await setupInstallation(db(), SETUP);
    const b = await setupInstallation(db(), SETUP);
    expect(b).toEqual(a);
    expect(await db().select().from(hosts)).toHaveLength(1);
    expect((await db().select().from(hosts))[0]!.hostingMode).toBe("dedicated");
  });

  it("a second setup with a new --ipv4 updates the host row", async () => {
    const count = async () =>
      (await db().select().from(auditEvents).where(eq(auditEvents.action, "host.address.change"))).length;
    await setupInstallation(db(), { ...SETUP, hostIpv4: "203.0.113.10" });
    await setupInstallation(db(), { ...SETUP, hostIpv4: "203.0.113.20" });
    const rows = await db().select().from(hosts);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ipv4Address).toBe("203.0.113.20");
    expect(await count()).toBe(1);
    await setupInstallation(db(), { ...SETUP, hostIpv4: "203.0.113.20" });
    expect(await count()).toBe(1);
  });

  it("createServerAdmin enrols TOTP and can log in", async () => {
    const out = await createServerAdmin(db(), KEY, { email: " Admin@Example.COM ", name: "Admin", password: PW });
    expect((await getUser("admin@example.com")).platformRole).toBe("infrastructure_admin");
    expect(out.otpauthUri).toContain("Hosting%20Panel");
    const app = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
    });
    try {
      const res = await fetch(`${app.baseUrl!}/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "admin@example.com",
          password: PW,
          totpCode: totpCodeAt(out.totpSecretBase32, Math.floor(Date.now() / 30_000)),
        }),
      });
      const json = (await res.json()) as { data: { status: string } };
      expect(json.data.status).toBe("ok");
    } finally {
      await app.close();
    }
  });

  it("createServerAdmin rejects weak password and duplicate email", async () => {
    await expect(createServerAdmin(db(), KEY, { email: "a@x.it", name: "A", password: "short" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await createServerAdmin(db(), KEY, { email: "a@x.it", name: "A", password: PW });
    await expect(createServerAdmin(db(), KEY, { email: "A@X.it", name: "A", password: PW })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("resetUserPassword sets mustChangePassword, unlocks, revokes sessions", async () => {
    await createServerAdmin(db(), KEY, { email: "a@x.it", name: "A", password: PW });
    const u = await getUser("a@x.it");
    await db().update(users).set({ lockedUntil: new Date(Date.now() + 1e6), failedLoginCount: 5, totpFailedCount: 3 }).where(eq(users.id, u.id));
    await db().insert(userSessions).values({ id: "s1", userId: u.id, expiresAt: new Date(Date.now() + 1e6) });
    const { temporaryPassword } = await resetUserPassword(db(), { email: " A@x.it" });
    const after = await getUser("a@x.it");
    expect(after.mustChangePassword).toBe(true);
    expect(after.lockedUntil).toBeNull();
    expect(after.failedLoginCount).toBe(0);
    expect(after.totpFailedCount).toBe(0);
    expect(await verifyPassword(temporaryPassword, after.passwordHash!)).toBe(true);
    expect((await db().select().from(userSessions))[0]!.revokedAt).not.toBeNull();
    const audits = await db().select().from(auditEvents);
    expect(JSON.stringify(audits)).not.toContain(temporaryPassword);
    await expect(resetUserPassword(db(), { email: "nobody@x.it" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("resetUserTotp re-enrols admins and clears customers", async () => {
    const first = await createServerAdmin(db(), KEY, { email: "a@x.it", name: "A", password: PW });
    const re = await resetUserTotp(db(), KEY, { email: "a@x.it" });
    expect(re!.totpSecretBase32).not.toBe(first.totpSecretBase32);
    expect((await getUser("a@x.it")).totpEnabledAt).not.toBeNull();
    await db().insert(users).values({ id: "usr_c", email: "c@x.it", name: "C", passwordHash: "x", totpEnabledAt: new Date(), totpCiphertextBase64: "a", totpIvBase64: "b", totpAuthTagBase64: "c" });
    expect(await resetUserTotp(db(), KEY, { email: "C@x.it" })).toBeNull();
    const c = await getUser("c@x.it");
    expect(c.totpEnabledAt).toBeNull();
    expect(c.totpCiphertextBase64).toBeNull();
  });

  it("unlockUser clears lockout counters and 404s on unknown email", async () => {
    await createServerAdmin(db(), KEY, { email: "a@x.it", name: "A", password: PW });
    await db().update(users).set({ lockedUntil: new Date(Date.now() + 1e6), failedLoginCount: 5, totpFailedCount: 3 }).where(eq(users.email, "a@x.it"));
    await unlockUser(db(), { email: " A@X.it " });
    const u = await getUser("a@x.it");
    expect([u.lockedUntil, u.failedLoginCount, u.totpFailedCount]).toEqual([null, 0, 0]);
    expect(await db().select().from(auditEvents).where(eq(auditEvents.action, "accounts.unlock"))).toHaveLength(1);
    await expect(unlockUser(db(), { email: "no@x.it" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("runCli migrates a fresh, unmigrated database before running the command", async () => {
    const fresh = createDatabaseClient({ mode: "pglite" });
    const lines: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => (lines.push(chunk), true)) as typeof process.stdout.write;
    try {
      await runCli(["setup", "--name", "Test", "--hostname", "host.test", "--ipv4", "10.0.0.1"], fresh);
    } finally {
      process.stdout.write = write;
    }
    expect(JSON.parse(lines[0]!)).toMatchObject({ hostId: expect.any(String) });
  });
});
