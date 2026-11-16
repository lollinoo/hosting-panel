import { createHash } from "node:crypto";
import {
  auditEvents,
  createDatabaseClient,
  encryptSecretAesGcm,
  eq,
  outboxEvents,
  passwordResetTokens,
  sql,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import type { PanelMailRequest, PanelMailResult } from "@hosting-panel/executor-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// index.js first: the service sits in the import cycle cli/accounts -> create-app -> app.module.
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { PasswordResetService } from "../src/auth/password-reset.service.js";
import { hashPassword } from "../src/auth/password.js";
import { generateTotpSecret, totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";

const KEY = Buffer.alloc(32, 7);
const PW = "sentinel-admin-pass";
const NEW_PW = "sentinel-new-pass-1";
const SETUP = { installationName: "Test", hostHostname: "panel.example.test", hostIpv4: "10.0.0.1" };
const RELAY = { host: "smtp.example.test", port: 587, username: "relay", password: "sentinel-relay-pass", senderDomain: "mail.example.test" };
const CUSTOMER = "customer@example.test";
const EN = "english@example.test";
const DISABLED = "disabled@example.test";
const ADMIN = "admin@example.test";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("password reset by mail", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let sim: InMemoryDockerSimulatorAdapter;
  let service: PasswordResetService;
  let adminToken: string;
  let customerPassword: string;
  let customerId: string;

  async function post(path: string, body: unknown, auth?: string) {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, raw, body: raw ? (JSON.parse(raw) as Json) : {}, headers: res.headers };
  }

  async function login(email: string, password: string, totpSecret?: string) {
    return post("/v1/auth/login", {
      email,
      password,
      ...(totpSecret ? { totpCode: totpCodeAt(totpSecret, Math.floor(Date.now() / 30_000)) } : {}),
    });
  }

  const request = (email: string) => post("/v1/auth/password-reset/request", { email });
  const confirm = (token: string, newPassword = NEW_PW) => post("/v1/auth/password-reset/confirm", { token, newPassword });
  const tokenOf = (mail: PanelMailRequest) => mail.link.split("#")[1]!;
  const userId = async (email: string) => (await dbClient.db.select().from(users).where(eq(users.email, email)))[0]!.id;
  const tokens = (id: string) => dbClient.db.select().from(passwordResetTokens).where(eq(passwordResetTokens.userId, id));
  const audits = (action: string) => dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, action));

  async function requestMail(email = CUSTOMER): Promise<PanelMailRequest> {
    const before = sim.panelMails.length;
    expect((await request(email)).status).toBe(202);
    await service.idle();
    expect(sim.panelMails).toHaveLength(before + 1);
    return sim.panelMails.at(-1)!;
  }

  /** Holds every executor call to sendPanelMail until the returned function runs. */
  function holdMails(): () => void {
    const original = sim.sendPanelMail.bind(sim);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    sim.sendPanelMail = async (req: PanelMailRequest): Promise<PanelMailResult> => {
      await gate;
      return original(req);
    };
    return release;
  }

  async function addUser(email: string, fields: Partial<typeof users.$inferInsert> = {}) {
    const id = `usr_${email.split("@")[0]!.replace(/\W/g, "")}`;
    await dbClient.db.insert(users).values({ id, email, name: "Sentinel", passwordHash: await hashPassword("sentinel-old-pass"), ...fields });
    return id;
  }

  async function configureRelay() {
    const patched = await fetch(`${app.baseUrl!}/v1/admin/mail-relay`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify(RELAY),
    });
    expect(patched.status).toBe(200);
    await app.mailRelay.ensureApplied();
  }

  beforeEach(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, { email: ADMIN, name: "Admin", password: PW });
    sim = new InMemoryDockerSimulatorAdapter();
    app = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      runtimeBackend: "local-simulator",
      dockerExecutor: sim,
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
      domainReconcileIntervalMs: null,
      mailRelayRetryIntervalMs: null,
      recoverUnknownOnStart: false,
    });
    service = app.nestApp.get(PasswordResetService);
    adminToken = (await login(ADMIN, PW, admin.totpSecretBase32)).body.data.accessToken as string;
    const created = await post(
      "/v1/admin/customer-account",
      { organizationName: "Customer Org", ownerEmail: CUSTOMER, ownerName: "Customer" },
      adminToken,
    );
    expect(created.status).toBe(201);
    customerPassword = created.body.data.temporaryPassword as string;
    customerId = await userId(CUSTOMER);
    await addUser(EN, { locale: "en" });
    await addUser(DISABLED, { userStatus: "disabled" });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    await dbClient.close();
  });

  it("answers 202, empty and alike, before any mail work, and only the active customer gets a token and a mail", async () => {
    await configureRelay();
    const release = holdMails();
    const answers = [];
    for (const email of [CUSTOMER, "nobody@example.test", ADMIN, DISABLED, "  Customer@Example.TEST "]) {
      const res = await request(email);
      // Both differ per request, never per account.
      const headers = Object.fromEntries([...res.headers].filter(([k]) => k !== "date" && k !== "x-request-id"));
      answers.push({ status: res.status, raw: res.raw, headers });
    }
    expect(answers[0]).toMatchObject({ status: 202, raw: "" });
    for (const a of answers) expect(a).toEqual(answers[0]);

    release();
    await service.idle();
    // The upper-case address is the same customer: two mails, both to the customer.
    expect(sim.panelMails.map((m) => m.to)).toEqual([CUSTOMER, CUSTOMER]);
    expect(sim.panelMails[0]).toMatchObject({ kind: "password_reset", locale: "it", from: "noreply@mail.example.test" });
    expect(sim.panelMails[0]!.link).toMatch(/^https:\/\/panel\.example\.test\/reset-password#[A-Za-z0-9_-]{43}$/);
    expect(await tokens(customerId)).toHaveLength(2);
    for (const email of [ADMIN, DISABLED]) expect(await tokens(await userId(email))).toEqual([]);

    const rows = await audits("auth.password_reset.requested");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({ actorType: "system", actorId: null, targetType: "user", targetId: customerId, details: { delivery: "queued" } });
    }
  });

  it("stores the token but sends nothing while the relay is not configured", async () => {
    expect((await request(CUSTOMER)).status).toBe(202);
    await service.idle();
    expect(sim.panelMails).toEqual([]);
    expect(await tokens(customerId)).toHaveLength(1);
    const [row] = await audits("auth.password_reset.requested");
    expect(row?.details).toEqual({ delivery: "not_sent" });
  });

  it("sets the password once, ends every session, unlocks, and the old password stops working", async () => {
    await configureRelay();
    const session = (await login(CUSTOMER, customerPassword)).body.data.accessToken as string;
    expect((await fetch(`${app.baseUrl!}/v1/me`, { headers: { Authorization: `Bearer ${session}` } })).status).toBe(200);
    const token = tokenOf(await requestMail());
    await dbClient.db
      .update(users)
      .set({ lockedUntil: new Date(Date.now() + 3600_000), failedLoginCount: 9, totpFailedCount: 4, mustChangePassword: true })
      .where(eq(users.id, customerId));

    const weak = await confirm(token, "short");
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe("VALIDATION_ERROR");

    expect((await confirm(token)).status).toBe(204);
    const again = await confirm(token);
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe("PASSWORD_RESET_INVALID");

    const [user] = await dbClient.db.select().from(users).where(eq(users.id, customerId));
    // Four wrong codes are no lock, so the lock goes; the count of wrong codes stays.
    expect(user).toMatchObject({ lockedUntil: null, failedLoginCount: 0, totpFailedCount: 4, mustChangePassword: false });
    expect((await fetch(`${app.baseUrl!}/v1/me`, { headers: { Authorization: `Bearer ${session}` } })).status).toBe(401);
    expect((await login(CUSTOMER, NEW_PW)).status).toBe(200);
    expect((await login(CUSTOMER, customerPassword)).status).toBe(401);
    const [completed] = await audits("auth.password_reset.completed");
    expect(completed).toMatchObject({ actorType: "user", actorId: customerId, targetType: "user", targetId: customerId, details: {} });
  });

  it("keeps a lock made by wrong second-factor codes: the new password with the right code is still refused", async () => {
    await configureRelay();
    const id = await userId(EN);
    const secret = generateTotpSecret();
    const env = encryptSecretAesGcm({ plaintext: secret, masterKey: KEY, organizationId: "platform", siteId: null, secretKey: `totp:${id}` });
    await dbClient.db
      .update(users)
      .set({ totpCiphertextBase64: env.ciphertextBase64, totpIvBase64: env.ivBase64, totpAuthTagBase64: env.authTagBase64, totpEnabledAt: new Date() })
      .where(eq(users.id, id));
    const right = totpCodeAt(secret, Math.floor(Date.now() / 30_000));
    const wrong = String((Number(right) + 1) % 1_000_000).padStart(6, "0");
    for (let i = 0; i < 5; i++) {
      expect((await post("/v1/auth/login", { email: EN, password: "sentinel-old-pass", totpCode: wrong })).status).toBe(401);
    }
    const [locked] = await dbClient.db.select().from(users).where(eq(users.id, id));
    expect(locked!.totpFailedCount).toBe(5);
    expect(locked!.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

    expect((await confirm(tokenOf(await requestMail(EN)))).status).toBe(204);
    const [after] = await dbClient.db.select().from(users).where(eq(users.id, id));
    expect(after).toMatchObject({ lockedUntil: locked!.lockedUntil, failedLoginCount: 0, totpFailedCount: 5 });
    const refused = await login(EN, NEW_PW, secret);
    expect(refused.status).toBe(423);
    expect(refused.body.error.code).toBe("ACCOUNT_LOCKED");
  });

  it("lifts a lock made by wrong passwords, and the new password then logs in", async () => {
    await configureRelay();
    for (let i = 0; i < 5; i++) expect((await login(CUSTOMER, "sentinel-wrong-pass")).status).toBe(401);
    expect((await login(CUSTOMER, customerPassword)).status).toBe(423);
    expect((await confirm(tokenOf(await requestMail()))).status).toBe(204);
    expect((await login(CUSTOMER, NEW_PW)).status).toBe(200);
  });

  it("leaves the TOTP secret as it was", async () => {
    await configureRelay();
    const totp = {
      totpCiphertextBase64: "c2VudGluZWwtY2lwaGVy",
      totpIvBase64: "c2VudGluZWwtaXY=",
      totpAuthTagBase64: "c2VudGluZWwtdGFn",
      totpEnabledAt: new Date("2026-01-01T00:00:00Z"),
      totpLastStep: 42,
    };
    const id = await userId(EN);
    await dbClient.db.update(users).set(totp).where(eq(users.id, id));
    expect((await confirm(tokenOf(await requestMail(EN)))).status).toBe(204);
    const [user] = await dbClient.db.select().from(users).where(eq(users.id, id));
    expect(user).toMatchObject(totp);
  });

  it("refuses an expired token, and the token of an account disabled or made an administrator after the request", async () => {
    await configureRelay();
    const expired = tokenOf(await requestMail());
    await dbClient.db.execute(sql`UPDATE password_reset_tokens SET expires_at = now() - interval '1 second'`);
    expect((await confirm(expired)).body.error.code).toBe("PASSWORD_RESET_INVALID");

    for (const change of [{ userStatus: "disabled" }, { platformRole: "infrastructure_admin" as const }]) {
      const id = await userId(EN);
      await dbClient.db.update(users).set({ userStatus: "active", platformRole: null }).where(eq(users.id, id));
      const token = tokenOf(await requestMail(EN));
      await dbClient.db.update(users).set(change).where(eq(users.id, id));
      const res = await confirm(token);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("PASSWORD_RESET_INVALID");
      const hash = createHash("sha256").update(token).digest("hex");
      const [row] = await dbClient.db.select().from(passwordResetTokens).where(eq(passwordResetTokens.tokenHash, hash));
      expect(row?.usedAt).toBeNull();
    }
    expect(await audits("auth.password_reset.completed")).toEqual([]);
  });

  it("retires the first token when a second one is asked for", async () => {
    await configureRelay();
    const first = tokenOf(await requestMail());
    const second = tokenOf(await requestMail());
    expect((await confirm(first)).body.error.code).toBe("PASSWORD_RESET_INVALID");
    expect((await confirm(second)).status).toBe(204);
  });

  it("makes no token and no mail past 3 an account or 20 overall an hour, and still answers 202", async () => {
    await configureRelay();
    for (let i = 0; i < 4; i++) expect((await request(CUSTOMER)).status).toBe(202);
    await service.idle();
    expect(sim.panelMails).toHaveLength(3);
    expect(await tokens(customerId)).toHaveLength(3);

    for (let i = 0; i < 6; i++) await addUser(`extra${i}@example.test`);
    const emails = [EN, ...Array.from({ length: 6 }, (_, i) => `extra${i}@example.test`)];
    for (let i = 0; i < 18; i++) expect((await request(emails[i % emails.length]!)).status).toBe(202);
    await service.idle();
    expect(sim.panelMails).toHaveLength(20);
    expect(await audits("auth.password_reset.requested")).toHaveLength(20);
    const [{ count }] = (await dbClient.db.execute<{ count: number }>(sql`SELECT count(*)::int AS count FROM password_reset_tokens`)).rows as [{ count: number }];
    expect(count).toBe(20);
  });

  it("drops a request while 32 are pending, silently, with the same 202", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const deliver = vi.spyOn(service, "deliver").mockImplementation(() => gate);
    for (let i = 0; i < 32; i++) expect((await request(`held${i}@example.test`)).status).toBe(202);
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(32));

    const logs = ["log", "info", "warn", "error"].map((m) => vi.spyOn(console, m as "log"));
    const dropped = await request(CUSTOMER);
    expect(dropped).toMatchObject({ status: 202, raw: "" });
    await new Promise((r) => setTimeout(r, 50));
    expect(deliver).toHaveBeenCalledTimes(32);
    for (const l of logs) expect(l).not.toHaveBeenCalled();

    release();
    await service.idle();
    expect((await request(CUSTOMER)).status).toBe(202);
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(33));
  });

  it("keeps the token and the link out of every table and log line, and writes in the account's language", async () => {
    const lines: unknown[] = [];
    for (const m of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void lines.push(args));
    }
    await configureRelay();
    const itMail = await requestMail(CUSTOMER);
    const en = await requestMail(EN);
    expect(itMail).toMatchObject({ locale: "it", to: CUSTOMER, from: "noreply@mail.example.test" });
    expect(en).toMatchObject({ locale: "en", to: EN, from: "noreply@mail.example.test" });
    expect((await confirm(tokenOf(itMail))).status).toBe(204);
    await confirm(tokenOf(en), "short");

    const audit = JSON.stringify(await dbClient.db.select().from(auditEvents));
    const outbox = JSON.stringify(await dbClient.db.select().from(outboxEvents));
    const stored = await dbClient.db.select().from(passwordResetTokens);
    const logged = JSON.stringify(lines);
    for (const mail of [itMail, en]) {
      const token = tokenOf(mail);
      const hash = createHash("sha256").update(token).digest("hex");
      expect(stored.some((r) => r.tokenHash === hash)).toBe(true);
      for (const secret of [token, mail.link, hash]) {
        expect(audit).not.toContain(secret);
        expect(outbox).not.toContain(secret);
        expect(logged).not.toContain(secret);
      }
      expect(JSON.stringify(stored)).not.toContain(token);
    }
  });
});
