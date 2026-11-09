import { randomUUID } from "node:crypto";
import {
  appendStackRevisionTransactional,
  auditEvents,
  createDatabaseClient,
  enqueueOperationTransactional,
  eq,
  operations,
  outboxEvents,
  serviceInstances,
  sql,
  stackRevisions,
  upsertMailRelaySettings,
  type DatabaseClient,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import type { MailRelayApplyRequest, MailRelayStatusReport } from "@hosting-panel/executor-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";

const KEY = Buffer.alloc(32, 7);
const PW = "correct horse battery";
const SETUP = { installationName: "Test", hostHostname: "panel.test", hostIpv4: "10.0.0.1" };
const CANARY = "canary-API:pw 1";
const SETTINGS = { host: "smtp.example.com", port: 587, username: "apikey", password: CANARY, senderDomain: "hotel-mail.it" };
const STORED = { host: "smtp.example.com", port: 587 as const, username: "apikey", senderDomain: "hotel-mail.it" };
const SITE = {
  name: "Hotel Bella",
  domain: "hotel.it",
  title: "Hotel Bella Vista",
  adminUser: "admin",
  adminEmail: "admin@hotel.it",
  adminPassword: "canary-Pass-123456",
};
const RELAY = "/v1/admin/mail-relay";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const coded = (code: string) => Object.assign(new Error(`simulated ${code}`), { code });

describe("mail relay API", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let sim: InMemoryDockerSimulatorAdapter;
  let token: string;
  let adminToken: string;
  let orgId: string;
  const extraApps: ControlPlaneAppHandle[] = [];

  async function login(email: string, password: string, totpSecret?: string): Promise<string> {
    const res = await fetch(`${app.baseUrl!}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        ...(totpSecret ? { totpCode: totpCodeAt(totpSecret, Math.floor(Date.now() / 30_000)) } : {}),
      }),
    });
    return ((await res.json()) as Json).data.accessToken as string;
  }

  async function call(
    method: string,
    path: string,
    body?: unknown,
    as: string = adminToken,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: Json; raw: string }> {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: { Authorization: `Bearer ${as}`, "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {}, raw };
  }

  const audits = (action: string) => dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, action));
  const run = () => app.outboxWorker.processPendingOnce();

  async function saveAndApply(body: Record<string, unknown> = SETTINGS) {
    const res = await call("PATCH", RELAY, body);
    expect(res.status).toBe(200);
    await app.mailRelay.ensureApplied();
    return res;
  }

  async function provisionSite(): Promise<string> {
    const res = await call("POST", `/v1/organizations/${orgId}/managed-sites`, SITE, token, { "Idempotency-Key": randomUUID() });
    expect(res.status).toBe(202);
    await run();
    return res.body.data.siteId as string;
  }

  /** Releases a held apply: the simulator's apply waits on the returned function. */
  function holdApplies(): () => void {
    const original = sim.applyMailRelay.bind(sim);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    sim.applyMailRelay = async (req: MailRelayApplyRequest | null) => {
      await gate;
      return original(req);
    };
    return release;
  }

  /** A second app on the same database, without HTTP: its setInterval is faked by the caller. */
  async function bootApp(executor: InMemoryDockerSimulatorAdapter): Promise<ControlPlaneAppHandle> {
    const booted = await createControlPlaneApp({
      listen: false,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      runtimeBackend: "local-simulator",
      dockerExecutor: executor,
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
      domainReconcileIntervalMs: null,
      mailRelayRetryIntervalMs: 20,
      recoverUnknownOnStart: false,
    });
    extraApps.push(booted);
    return booted;
  }

  beforeEach(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, { email: "admin@x.it", name: "Admin", password: PW });
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
    adminToken = await login("admin@x.it", PW, admin.totpSecretBase32);
    const created = await call("POST", "/v1/admin/customer-account", {
      organizationName: "Hotel Mario",
      ownerEmail: "mario@hotel.it",
      ownerName: "Mario",
    });
    expect(created.status).toBe(201);
    orgId = created.body.data.organizationId as string;
    token = await login("mario@hotel.it", created.body.data.temporaryPassword as string);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const extra of extraApps.splice(0)) await extra.close();
    await app.close();
    await dbClient.close();
  });

  it("admin saves settings and the relay is applied", async () => {
    const res = await call("PATCH", RELAY, SETTINGS);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ ...STORED, configured: true, passwordSet: true, applied: false });

    await app.mailRelay.ensureApplied();
    const got = await call("GET", RELAY);
    expect(got.status).toBe(200);
    expect(got.body.data).toMatchObject({ applied: true, relayRunning: true, sentLast24h: 0, failures: [] });
    expect(sim.mailRelay).toEqual({ ...STORED, password: CANARY });
    expect(sim.mailRelay?.password).toBe("canary-API:pw 1");

    const [audit] = await audits("admin.mail_relay.update");
    expect(audit?.details).toEqual({ ...STORED, passwordChanged: true });
  });

  it("save answers before the apply finishes, and GET never waits on it", async () => {
    const release = holdApplies();
    const res = await call("PATCH", RELAY, SETTINGS);
    expect(res.status).toBe(200);
    expect(res.body.data.applied).toBe(false);
    const got = await call("GET", RELAY);
    expect(got.status).toBe(200);
    expect(got.body.data.applied).toBe(false);
    expect(sim.mailRelayApplies).toEqual([]);

    release();
    await app.mailRelay.ensureApplied();
    expect((await call("GET", RELAY)).body.data.applied).toBe(true);
  });

  it("the password never leaves the API in a response or an audit row", async () => {
    const logs: unknown[][] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args));
    }
    const saved = await saveAndApply();
    const got = await call("GET", RELAY);
    const tested = await call("POST", `${RELAY}/test`, { to: "admin@x.it" });
    expect(tested.status).toBe(200);

    sim.failNextMailRelayApply(2); // the save's own apply, then the one awaited here
    const failed = await call("PATCH", RELAY, { ...SETTINGS, password: `${CANARY}-2` });
    await app.mailRelay.ensureApplied();
    expect((await call("GET", RELAY)).body.data.applied).toBe(false);

    for (const r of [saved, got, tested, failed]) expect(r.raw).not.toContain(CANARY);
    const allAudits = await dbClient.db.select().from(auditEvents);
    expect(JSON.stringify(allAudits)).not.toContain(CANARY);
    expect(JSON.stringify(await dbClient.db.select().from(outboxEvents))).not.toContain(CANARY);
    const logged = logs.map((args) => args.map(String).join(" "));
    expect(logged.join("\n")).not.toContain(CANARY);
    expect(logged.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Json)).toContainEqual({
      event: "mail_relay_apply_failed",
      code: "DOCKER_ENGINE_UNAVAILABLE",
    });
  });

  it("saving without a password keeps the stored one", async () => {
    await saveAndApply();
    const { password: _password, ...rest } = SETTINGS;
    const res = await saveAndApply({ ...rest, port: 465 });
    expect(res.body.data).toMatchObject({ port: 465, passwordSet: true });
    expect(sim.mailRelay).toEqual({ ...STORED, port: 465, password: CANARY });
    const updates = await audits("admin.mail_relay.update");
    expect(updates.map((a) => (a.details as Json)["passwordChanged"]).sort()).toEqual([false, true]);
  });

  it("the first save requires a password", async () => {
    const { password: _password, ...rest } = SETTINGS;
    const res = await call("PATCH", RELAY, rest);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.message).toBe("password_required");
    expect(res.body.error.details).toEqual([{ field: "password", message: "password_required" }]);
    expect(sim.mailRelayApplies).toEqual([]);
  });

  it("invalid fields are refused with their message key", async () => {
    const res = await call("PATCH", RELAY, { ...SETTINGS, host: "10.0.0.5" });
    expect(res.status).toBe(400);
    expect(res.body.error.details).toContainEqual(expect.objectContaining({ field: "host", message: "host_invalid" }));
  });

  it("boot applies stored settings and retries until the executor answers", async () => {
    await upsertMailRelaySettings(dbClient.db, KEY.toString("hex"), { ...SETTINGS, actorId: null });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const fresh = new InMemoryDockerSimulatorAdapter();
    fresh.failNextMailRelayApply(2);
    const booted = await bootApp(fresh);
    const tick = async () => {
      await vi.advanceTimersByTimeAsync(20);
      await booted.mailRelay.idle();
    };

    await booted.mailRelay.idle(); // tick 1, at boot: fails
    expect(fresh.mailRelayApplies).toEqual([]);
    await tick(); // tick 2: fails
    expect(fresh.mailRelayApplies).toEqual([]);
    await tick(); // tick 3: applied
    expect(fresh.mailRelayApplies).toEqual([{ ...STORED, password: CANARY }]);
    for (let i = 4; i <= 9; i += 1) await tick();
    expect(fresh.mailRelayApplies).toHaveLength(1);
    await tick(); // tick 10: forced
    expect(fresh.mailRelayApplies).toEqual([{ ...STORED, password: CANARY }, { ...STORED, password: CANARY }]);
  });

  it("boot with no settings removes a leftover relay", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const fresh = new InMemoryDockerSimulatorAdapter();
    fresh.mailRelay = { ...STORED, password: "leftover" };
    const booted = await bootApp(fresh);
    await booted.mailRelay.idle();
    expect(fresh.mailRelayApplies).toEqual([null]);
    expect(fresh.mailRelay).toBeNull();
    await vi.advanceTimersByTimeAsync(20);
    await booted.mailRelay.idle();
    expect(fresh.mailRelayApplies).toEqual([null]);
  });

  it("test email outcome maps to the admin result", async () => {
    await saveAndApply();
    sim.nextTestMailResult = { outcome: "deferred", problem: "auth_failed", detail: "535 5.7.8 authentication failed" };
    const res = await call("POST", `${RELAY}/test`, { to: "admin@x.it" });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ outcome: "deferred", problem: "auth_failed", detail: "535 5.7.8 authentication failed" });
    expect(sim.mailDeliveries.map((d) => [d.to, d.from])).toEqual([["admin@x.it", "noreply@hotel-mail.it"]]);
    const [audit] = await audits("admin.mail_relay.test");
    expect(audit?.details).toEqual({ to: "admin@x.it", outcome: "deferred", problem: "auth_failed" });
  });

  it("test email before the relay is applied is MAIL_RELAY_UNAVAILABLE, before setup not_configured", async () => {
    const before = await call("POST", `${RELAY}/test`, { to: "admin@x.it" });
    expect(before.status).toBe(400);
    expect(before.body.error.message).toBe("not_configured");

    const release = holdApplies();
    await call("PATCH", RELAY, SETTINGS);
    const pending = await call("POST", `${RELAY}/test`, { to: "admin@x.it" });
    expect(pending.status).toBe(503);
    expect(pending.body.error.code).toBe("MAIL_RELAY_UNAVAILABLE");
    release();
    await app.mailRelay.ensureApplied();

    // The executor's own refusal, and an executor that is down, are both 503 for the admin.
    sim.sendTestMail = () => Promise.reject(coded("MAIL_RELAY_UNAVAILABLE"));
    expect((await call("POST", `${RELAY}/test`, { to: "admin@x.it" })).body.error.code).toBe("MAIL_RELAY_UNAVAILABLE");
    sim.sendTestMail = () => Promise.reject(coded("DOCKER_ENGINE_UNAVAILABLE"));
    const down = await call("POST", `${RELAY}/test`, { to: "admin@x.it" });
    expect(down.status).toBe(503);
    expect(down.body.error.code).toBe("MAIL_RELAY_UNAVAILABLE");
  });

  it("status failures appear in GET", async () => {
    await saveAndApply();
    const failure = {
      at: "2026-11-09T10:00:00.000Z",
      recipient: "guest@example.org",
      status: "deferred" as const,
      problem: "unreachable" as const,
      detail: "connect to smtp.example.com[1.2.3.4]:587: Connection timed out",
    };
    const sinces: string[] = [];
    sim.getMailRelayStatus = async (req: { since: string }): Promise<MailRelayStatusReport> => {
      sinces.push(req.since);
      return { present: true, running: true, sentCount: 3, failures: [failure] };
    };
    const got = await call("GET", RELAY);
    expect(got.body.data).toMatchObject({ relayRunning: true, sentLast24h: 3, failures: [failure] });
    expect(Math.abs(Date.now() - 24 * 3600_000 - Date.parse(sinces[0]!))).toBeLessThan(60_000);
  });

  it("GET still answers when the executor is down", async () => {
    await saveAndApply();
    sim.getMailRelayStatus = () => Promise.reject(coded("DOCKER_ENGINE_UNAVAILABLE"));
    const got = await call("GET", RELAY);
    expect(got.status).toBe(200);
    expect(got.body.data).toMatchObject({ configured: true, applied: true, relayRunning: null, sentLast24h: null, failures: [] });
  });

  it("clear removes the settings and stops the relay", async () => {
    await saveAndApply();
    const res = await call("DELETE", RELAY);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ configured: false, host: null, passwordSet: false });
    await app.mailRelay.ensureApplied();
    expect(sim.mailRelay).toBeNull();
    expect(sim.mailRelayApplies.at(-1)).toBeNull();
    expect(await audits("admin.mail_relay.clear")).toHaveLength(1);
    expect((await call("GET", RELAY)).body.data).toMatchObject({ configured: false, applied: true });
  });

  it("only server administrators reach the mail relay routes", async () => {
    for (const [method, path, body] of [
      ["GET", RELAY, undefined],
      ["PATCH", RELAY, SETTINGS],
      ["DELETE", RELAY, undefined],
      ["POST", `${RELAY}/test`, { to: "a@b.it" }],
    ] as const) {
      expect((await call(method, path, body, token)).status).toBe(403);
    }
    expect(sim.mailRelayApplies).toEqual([]);
  });

  it("customers see where their site's email comes from", async () => {
    const siteId = await provisionSite();
    const url = `/v1/organizations/${orgId}/managed-sites/${siteId}/domains`;
    expect((await call("GET", url, undefined, token)).body.data.mail).toEqual({ configured: false, fromAddress: null });
    await saveAndApply();
    expect((await call("GET", url, undefined, token)).body.data.mail).toEqual({
      configured: true,
      fromAddress: "noreply@hotel-mail.it",
    });
  });

  describe("sites from before 0.5.0", () => {
    const webService = async (siteId: string) =>
      (await dbClient.db.select().from(serviceInstances).where(eq(serviceInstances.siteId, siteId)))[0]!;
    const revisions = async (siteId: string) =>
      dbClient.db.select().from(stackRevisions).where(eq(stackRevisions.serviceInstanceId, (await webService(siteId)).id));
    const deploys = async (siteId: string) =>
      dbClient.db.select().from(operations).where(eq(operations.resourceId, (await webService(siteId)).id));

    /** As 0.4.x wrote it: the current revision has no siteMail (revisions are immutable, so append one). */
    async function stripSiteMail(siteId: string) {
      const svc = await webService(siteId);
      const [rev] = await dbClient.db.select().from(stackRevisions).where(eq(stackRevisions.id, svc.currentRevisionId!));
      const { siteMail: _siteMail, ...config } = rev!.declarativeConfig as Json;
      await appendStackRevisionTransactional(dbClient.db as unknown as HostingPanelDatabase, {
        serviceInstanceId: svc.id,
        organizationId: orgId,
        declarativeConfig: config,
        secretRefs: rev!.secretRefs as Record<string, string>,
      });
    }

    it("a pre-0.5.0 site is upgraded once with a new revision and a deploy", async () => {
      const siteId = await provisionSite();
      await stripSiteMail(siteId);
      const before = await revisions(siteId);

      await app.mailRelay.tick();
      const after = await revisions(siteId);
      expect(after).toHaveLength(before.length + 1);
      const newest = after.sort((a, b) => b.revisionNumber - a.revisionNumber)[0]!;
      const { siteMail: _siteMail, ...oldConfig } = newest.declarativeConfig as Json;
      expect(newest.declarativeConfig).toMatchObject({ siteMail: true });
      expect(oldConfig).toEqual(before.sort((a, b) => b.revisionNumber - a.revisionNumber)[0]!.declarativeConfig);
      const ops = await deploys(siteId);
      expect(ops.map((o) => [o.kind, o.status, o.requestedByUserId])).toEqual([["service.deploy", "queued", null]]);

      await run();
      expect((await deploys(siteId))[0]!.status).toBe("succeeded");
      expect(sim.deployedSpecs.at(-1)).toMatchObject({ siteId, siteMail: true, specHash: newest.specHash });

      await app.mailRelay.tick();
      expect(await revisions(siteId)).toHaveLength(after.length);
      expect(await deploys(siteId)).toHaveLength(1);

      await app.driftReconciler.reconcileAllOnce();
      const site = await call("GET", `/v1/organizations/${orgId}/sites/${siteId}`, undefined, token);
      expect(site.body.data.driftSummary).toMatchObject({ overallDriftStatus: "in_sync", driftedCount: 0 });
    });

    it("a locked site is upgraded on a later tick", async () => {
      const siteId = await provisionSite();
      await stripSiteMail(siteId);
      const held = await enqueueOperationTransactional(dbClient.db as unknown as HostingPanelDatabase, {
        organizationId: orgId,
        kind: "site.provision",
        resourceType: "site",
        resourceId: siteId,
        lockKey: `site:${siteId}`,
      });
      const before = await revisions(siteId);

      await app.mailRelay.tick();
      expect(await revisions(siteId)).toHaveLength(before.length);
      expect(await deploys(siteId)).toHaveLength(0);

      await dbClient.db.update(operations).set({ status: "failed" }).where(eq(operations.id, held.operation.id));
      await dbClient.db
        .update(outboxEvents)
        .set({ status: "published" })
        .where(sql`${outboxEvents.payload}->>'operationId' = ${held.operation.id}`);
      await app.mailRelay.tick();
      expect(await revisions(siteId)).toHaveLength(before.length + 1);
      expect(await deploys(siteId)).toHaveLength(1);
    });
  });
});
