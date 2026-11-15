import {
  SiteWordpressLastUpdateDtoSchema,
  SiteWordpressStateDtoSchema,
  type BackupJobStatus,
  type OperationKind,
  type SiteWordpressUpdateRequest,
} from "@hosting-panel/contracts";
import {
  and,
  appendAuditEvent,
  auditEvents,
  createDatabaseClient,
  enqueueOperationTransactional,
  eq,
  getSiteWordpressState,
  inArray,
  insertSiteBackup,
  operationSteps,
  operations,
  outboxEvents,
  saveSiteWordpressLastUpdate,
  saveSiteWordpressState,
  serviceInstances,
  siteBackups,
  siteWordpressState,
  sites,
  sql,
  transitionOperation,
  upsertBackupSettings,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter, SIMULATED_WORDPRESS_STATE } from "@hosting-panel/docker-executor";
import type { SiteJobRequest } from "@hosting-panel/executor-contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { totpCodeAt } from "../src/auth/totp.js";
import { SiteBackupsApplier } from "../src/backups/site-backups-applier.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { SITE_STEP_LEASE_MS } from "../src/runtime/site-provisioner.js";
import {
  SITE_WORDPRESS_INSPECT_STEPS,
  SITE_WORDPRESS_UPDATE_STEPS,
  SiteWordpressApplier,
} from "../src/sites/site-wordpress-applier.js";
import type { ControlPlaneRuntimeConfig } from "../src/tokens.js";

// Every lease renewal and every job lands in one ordered log.
const events = vi.hoisted(() => [] as string[]);
// Set to make the next move of an operation to "failed" throw.
const failTransition = vi.hoisted(() => ({ on: false }));
vi.mock("@hosting-panel/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hosting-panel/database")>();
  return {
    ...actual,
    transitionOperation: async (...args: Parameters<typeof actual.transitionOperation>) => {
      if (failTransition.on && args[2] === "failed") throw new Error("database went away");
      return actual.transitionOperation(...args);
    },
    renewOperationLease: async (...args: Parameters<typeof actual.renewOperationLease>) => {
      events.push(`lease:${String(args[2])}`);
      return actual.renewOperationLease(...args);
    },
  };
});

const KEY = Buffer.alloc(32, 5);
const PW = "correct horse battery";
const MARKER = "MARKER-TAIL-7f3a";
const UNKNOWN_SENTENCE = "The outcome of the update is not known. Check the versions below.";
const SETTINGS = {
  endpoint: "https://s3.example.test",
  region: "eu-south-1",
  bucket: "copies",
  prefix: "panel",
  accessKeyId: "AKIAWPTEST0001",
  secretAccessKey: "not-a-real-secret-wp",
  scheduleHourUtc: 2,
  retentionDays: 14,
  updatedByUserId: null,
};

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Op = typeof operations.$inferSelect;

describe("SiteWordpressApplier", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let sim: InMemoryDockerSimulatorAdapter;
  let orgId: string;
  let siteId: string;
  const config = { runtimeBackend: "local-simulator", secretsMasterKey: KEY } as unknown as ControlPlaneRuntimeConfig;

  async function call(method: string, path: string, token: string | null, body?: unknown): Promise<Json> {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return (await res.json()) as Json;
  }

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, { installationName: "Test", hostHostname: "panel.test", hostIpv4: "10.0.0.1" });
    const admin = await createServerAdmin(dbClient.db, KEY, { email: "admin@example.test", name: "Admin", password: PW });
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
      sftpRetryIntervalMs: null,
      backupScheduleIntervalMs: null,
      recoverUnknownOnStart: false,
    });
    const login = await call("POST", "/v1/auth/login", null, {
      email: "admin@example.test",
      password: PW,
      totpCode: totpCodeAt(admin.totpSecretBase32, Math.floor(Date.now() / 30_000)),
    });
    const site = await call("POST", "/v1/admin/sites", login.data.accessToken as string, {
      name: "Neutral Site",
      domain: "wp-a.example.test",
      title: "Neutral Site",
      adminUser: "admin",
      adminEmail: "admin@example.test",
      adminPassword: "test-Pass-123456",
      ownerOrganizationId: null,
    });
    siteId = site.data.siteId as string;
    await app.outboxWorker.processPendingOnce();
    orgId = (await dbClient.db.select().from(operations).where(eq(operations.resourceId, siteId)))[0]!.organizationId;
    await upsertBackupSettings(dbClient.db, KEY, SETTINGS);
  });

  afterAll(async () => {
    await app.close();
    await dbClient.close();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    events.length = 0;
    failTransition.on = false;
    sim.wordpressOnline = true;
    sim.wordpressSites.clear();
    await dbClient.db
      .update(operations)
      .set({ status: "failed" })
      .where(and(eq(operations.resourceId, siteId), inArray(operations.status, ["queued", "processing", "unknown", "reconciling"])));
    await dbClient.db.delete(siteWordpressState).where(eq(siteWordpressState.siteId, siteId));
  });

  function applier(): SiteWordpressApplier {
    const backups = new SiteBackupsApplier(dbClient, sim, config);
    backups.pollMs = 0;
    return new SiteWordpressApplier(backups, dbClient, sim, config);
  }

  function jobLog() {
    const calls: SiteJobRequest[] = [];
    const real = sim.runSiteJob.bind(sim);
    vi.spyOn(sim, "runSiteJob").mockImplementation(async (req) => {
      calls.push(req);
      events.push(`job:${req.kind}`);
      return real(req);
    });
    return calls;
  }

  async function enqueue(kind: OperationKind, target?: SiteWordpressUpdateRequest, copy = false): Promise<Op> {
    const { operation } = await enqueueOperationTransactional(dbClient.db, {
      organizationId: orgId,
      kind,
      resourceType: "site",
      resourceId: siteId,
      lockKey: `site:${siteId}`,
      leaseDurationMs: SITE_STEP_LEASE_MS,
      steps: kind === "site.wordpress.inspect" ? SITE_WORDPRESS_INSPECT_STEPS : SITE_WORDPRESS_UPDATE_STEPS,
      outboxPayload: target ? { siteId, target } : { siteId },
    });
    if (copy) {
      await insertSiteBackup(dbClient.db, { siteId, kind: "pre_update", status: "running", operationId: operation.id });
    }
    await transitionOperation(dbClient.db, operation.id, "processing");
    return operation;
  }

  const opRow = async (id: string) => (await dbClient.db.select().from(operations).where(eq(operations.id, id)))[0]!;
  const steps = async (id: string) =>
    Object.fromEntries(
      (await dbClient.db.select().from(operationSteps).where(eq(operationSteps.operationId, id))).map((s) => [
        s.key,
        { status: s.status, message: s.message },
      ]),
    );
  const copyRow = async (id: string) =>
    (await dbClient.db.select().from(siteBackups).where(eq(siteBackups.operationId, id)))[0]!;
  const stored = async () => getSiteWordpressState(dbClient.db, { organizationId: orgId, siteId });
  const finishedAudits = async (opId: string) =>
    (await dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, "site.wordpress.update.finished"))).filter(
      (r) => (r.details as Json)["operationId"] === opId,
    );

  async function breakTarget(opId: string) {
    const [row] = await dbClient.db.select().from(outboxEvents).where(sql`${outboxEvents.payload}->>'operationId' = ${opId}`);
    await dbClient.db
      .update(outboxEvents)
      .set({ payload: { ...(row!.payload as Json), target: { scope: "everything" } } })
      .where(eq(outboxEvents.id, row!.id));
  }

  async function update(target: SiteWordpressUpdateRequest, copy = false) {
    const op = await enqueue("site.wordpress.update", target, copy);
    const error = await applier()
      .apply(op)
      .then(() => null, (err: unknown) => err);
    const row = await stored();
    return {
      op,
      error,
      row: await opRow(op.id),
      steps: await steps(op.id),
      lastUpdate: row ? SiteWordpressLastUpdateDtoSchema.parse(row.lastUpdate) : null,
      state: row?.state ? SiteWordpressStateDtoSchema.parse(row.state) : null,
    };
  }

  describe("check", () => {
    it("saves a valid result with checkedAt and no problem", async () => {
      const op = await enqueue("site.wordpress.inspect");
      await applier().apply(op);
      expect((await opRow(op.id)).status).toBe("succeeded");
      expect((await steps(op.id))["inspect"]!.status).toBe("succeeded");
      const state = SiteWordpressStateDtoSchema.parse((await stored())!.state);
      expect(state).toMatchObject({ ...SIMULATED_WORDPRESS_STATE, problem: null });
      expect(Date.parse(state.checkedAt)).toBeGreaterThan(Date.now() - 60_000);
    });

    it("offline (updatesKnown false) still succeeds", async () => {
      sim.wordpressOnline = false;
      const op = await enqueue("site.wordpress.inspect");
      await applier().apply(op);
      expect((await opRow(op.id)).status).toBe("succeeded");
      expect(SiteWordpressStateDtoSchema.parse((await stored())!.state).updatesKnown).toBe(false);
    });

    it.each([
      ["an invalid result", 0, '{"coreVersion":"6.0"}\n'],
      ["a missing result", 0, ""],
      ["an update-shaped result", 0, '{"items":[]}\n'],
      ["a timeout", 137, undefined],
    ])("%s leaves the stored state untouched and fails the operation", async (_name, exit, stdout) => {
      await saveSiteWordpressState(dbClient.db, { organizationId: orgId, siteId, state: { kept: true } });
      sim.failNextJob("wordpress.inspect", exit, MARKER, stdout);
      const op = await enqueue("site.wordpress.inspect");
      await expect(applier().apply(op)).rejects.toThrow();
      expect((await opRow(op.id)).status).toBe("failed");
      expect((await steps(op.id))["inspect"]!.status).toBe("failed");
      expect((await stored())!.state).toEqual({ kept: true });
    });

    it.each([
      [21, "not_installed"],
      [22, "config_broken"],
      [23, "database_unreachable"],
    ])("exit %i saves a problem row %s and fails", async (exit, problem) => {
      sim.failNextJob("wordpress.inspect", exit, MARKER);
      const op = await enqueue("site.wordpress.inspect");
      await expect(applier().apply(op)).rejects.toThrow();
      expect((await opRow(op.id)).status).toBe("failed");
      expect(SiteWordpressStateDtoSchema.parse((await stored())!.state)).toMatchObject({
        problem,
        coreVersion: null,
        coreUpdate: null,
        updatesKnown: false,
        plugins: [],
        themes: [],
        administrators: [],
      });
    });
  });

  describe("update: the copy first", () => {
    it("takes the copy, updates, settles and writes lastUpdate and the end audit", async () => {
      const calls = jobLog();
      const r = await update({ scope: "plugin", name: "classic-editor" }, true);
      expect(r.error).toBeNull();
      expect(r.row.status).toBe("succeeded");
      expect(Object.values(r.steps).map((s) => s.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
      const [copy] = await dbClient.db.select().from(siteBackups).where(eq(siteBackups.operationId, r.op.id));
      expect(copy!.status).toBe("succeeded");
      expect(calls.map((c) => c.kind)).toEqual(["wordpress.update", "wordpress.settle", "wordpress.inspect"]);
      expect(calls[0]!.params).toEqual({ phpVersion: expect.any(String), target: "plugin:classic-editor" });
      expect(r.lastUpdate).toMatchObject({
        operationId: r.op.id,
        target: { scope: "plugin", name: "classic-editor" },
        status: "succeeded",
        problem: null,
        backup: "taken",
        items: [{ type: "plugin", name: "classic-editor", oldVersion: "1.6.0", newVersion: "1.7.0", status: "updated" }],
      });
      expect(r.state!.plugins.find((p) => p.name === "classic-editor")!.version).toBe("1.7.0");
      const [audit] = await finishedAudits(r.op.id);
      expect(audit).toMatchObject({ actorType: "system", actorId: null, targetType: "site", targetId: siteId });
      expect(audit!.details).toEqual({
        operationId: r.op.id,
        target: { scope: "plugin", name: "classic-editor" },
        status: "succeeded",
        problem: null,
        backup: "taken",
        updated: 1,
        failed: 0,
      });
    });

    it("without a pre_update row the copy step is skipped with its sentence", async () => {
      const r = await update({ scope: "all" });
      expect(r.row.status).toBe("succeeded");
      expect(r.steps["backup"]).toEqual({
        status: "skipped",
        message: "Backups are not set up on this server; no copy was taken",
      });
      expect(r.lastUpdate).toMatchObject({ backup: "skipped", status: "succeeded" });
    });

    it("a failed copy updates nothing", async () => {
      const calls = jobLog();
      const real = sim.backups.bind(sim);
      vi.spyOn(sim, "backups").mockImplementation((async (req: { action: string; jobId: string }) =>
        req.action === "start"
          ? ({ jobId: req.jobId, state: "failed", failure: "other", snapshot: null } as unknown as BackupJobStatus)
          : real(req as never)) as never);
      const r = await update({ scope: "all" }, true);
      expect(r.error).toBeTruthy();
      expect(calls).toEqual([]);
      expect(r.row.status).toBe("failed");
      expect(r.steps["backup"]!.status).toBe("failed");
      expect(r.steps["update"]!.status).toBe("skipped");
      expect(r.steps["settle"]!.status).toBe("skipped");
      expect(r.lastUpdate).toMatchObject({ status: "failed", problem: "backup_failed", backup: "failed", items: [] });
      expect(await finishedAudits(r.op.id)).toHaveLength(1);
    });

    it("an update that fails before its copy step leaves no copy row running", async () => {
      vi.spyOn(sim, "runSiteJob");
      const op = await enqueue("site.wordpress.update", { scope: "all" }, true);
      await breakTarget(op.id);
      await expect(applier().apply(op)).rejects.toThrow();
      expect((await copyRow(op.id)).status).toBe("failed");
      expect(sim.runSiteJob).not.toHaveBeenCalled();
    });

    it("lastUpdate, the end audit and the status are written together or not at all", async () => {
      sim.failNextJob("wordpress.update", 32, MARKER);
      failTransition.on = true;
      const op = await enqueue("site.wordpress.update", { scope: "all" });
      await expect(applier().apply(op)).rejects.toThrow("database went away");
      expect((await opRow(op.id)).status).toBe("processing");
      expect((await stored())!.lastUpdate).toBeNull();
      expect(await finishedAudits(op.id)).toEqual([]);
    });
  });

  describe("update: the exit table", () => {
    const items = [{ type: "plugin", name: "classic-editor", oldVersion: "1.6.0", newVersion: null, status: "failed" }];
    it.each([
      ["update_failed (32)", 32, JSON.stringify({ items }), "items_failed", items],
      ["wordpress_org_unreachable (30)", 30, undefined, "wordpress_org_unreachable", []],
      ["item_unknown (31)", 31, undefined, "item_unknown", []],
      ["not_wordpress (21)", 21, undefined, "not_installed", []],
      ["broken_configuration (22)", 22, undefined, "config_broken", []],
      ["database_unreachable (23)", 23, undefined, "database_unreachable", []],
      ["result_unreadable (0, no result)", 0, "not json", "outcome_unknown", []],
      ["result_unreadable (70)", 70, undefined, "outcome_unknown", []],
      ["timed_out (124)", 124, undefined, "outcome_unknown", []],
      ["timed_out (137)", 137, undefined, "outcome_unknown", []],
      ["other (1)", 1, undefined, "outcome_unknown", []],
    ])("%s fails with its problem and still settles", async (_name, exit, stdout, problem, expected) => {
      const calls = jobLog();
      sim.failNextJob("wordpress.update", exit, MARKER, stdout);
      const r = await update({ scope: "all" });
      expect(r.row.status).toBe("failed");
      expect(r.steps["update"]!.status).toBe("failed");
      expect(r.steps["settle"]!.status).toBe("succeeded");
      expect(calls.map((c) => c.kind)).toEqual(["wordpress.update", "wordpress.settle", "wordpress.inspect"]);
      expect(r.lastUpdate).toMatchObject({ status: "failed", problem, items: expected });
      expect(r.state!.problem).toBeNull();
    });

    it("ok (0) with an empty list succeeds", async () => {
      sim.failNextJob("wordpress.update", 0, MARKER, '{"items":[]}\n');
      const r = await update({ scope: "core" });
      expect(r.row.status).toBe("succeeded");
      expect(r.lastUpdate).toMatchObject({ status: "succeeded", problem: null, items: [] });
    });

    it("an executor error that is not ambiguous is outcome_unknown and still settles", async () => {
      const calls = jobLog();
      const real = vi.mocked(sim.runSiteJob).getMockImplementation()!;
      vi.mocked(sim.runSiteJob).mockImplementation(async (req) => {
        if (req.kind !== "wordpress.update") return real(req);
        calls.push(req);
        throw new Error("engine said no");
      });
      const r = await update({ scope: "all" });
      expect(r.row.status).toBe("failed");
      expect(r.lastUpdate).toMatchObject({ problem: "outcome_unknown" });
      expect(calls.map((c) => c.kind)).toEqual(["wordpress.update", "wordpress.settle", "wordpress.inspect"]);
    });

    it("a failed settle fails only its step, still reads the state; the outcome follows the update", async () => {
      const calls = jobLog();
      sim.failNextJob("wordpress.settle", 1, MARKER);
      const r = await update({ scope: "all" });
      expect(r.row.status).toBe("succeeded");
      expect(r.steps["update"]!.status).toBe("succeeded");
      expect(r.steps["settle"]!.status).toBe("failed");
      expect(calls.map((c) => c.kind)).toEqual(["wordpress.update", "wordpress.settle", "wordpress.inspect"]);
      expect(r.lastUpdate).toMatchObject({ status: "succeeded" });
    });

    it("renews the lease before every job", async () => {
      jobLog();
      const r = await update({ scope: "all" }, true);
      const mine = events.filter((e) => e.startsWith("job:") || e === `lease:${String(SITE_STEP_LEASE_MS)}`);
      expect(mine.filter((e) => e.startsWith("job:"))).toHaveLength(3);
      mine.forEach((e, i) => {
        if (e.startsWith("job:")) expect(mine[i - 1]).toBe(`lease:${String(SITE_STEP_LEASE_MS)}`);
      });
      expect(r.row.status).toBe("succeeded");
    });

    it("puts no job output anywhere it writes", async () => {
      sim.failNextJob("wordpress.update", 32, `${MARKER} secret-ish tail`, JSON.stringify({ items }));
      sim.failNextJob("wordpress.settle", 1, MARKER);
      sim.failNextJob("wordpress.inspect", 22, MARKER);
      const r = await update({ scope: "all" }, true);
      const rows = [
        await dbClient.db.select().from(operations).where(eq(operations.id, r.op.id)),
        await dbClient.db.select().from(operationSteps).where(eq(operationSteps.operationId, r.op.id)),
        await dbClient.db.select().from(auditEvents),
        await dbClient.db.select().from(outboxEvents),
        await dbClient.db.select().from(siteWordpressState),
        await dbClient.db.select().from(siteBackups),
      ];
      expect(JSON.stringify(rows)).not.toContain(MARKER);
      const [audit] = await finishedAudits(r.op.id);
      expect(audit!.details).toMatchObject({ status: "failed", problem: "items_failed", updated: 0, failed: 1 });
    });
  });

  describe("recovery", () => {
    async function unknownUpdate(copy: boolean, stepStatus: Record<string, string>) {
      const op = await enqueue("site.wordpress.update", { scope: "all" }, copy);
      for (const [key, status] of Object.entries(stepStatus)) {
        await dbClient.db
          .update(operationSteps)
          .set({ status: status as never })
          .where(and(eq(operationSteps.operationId, op.id), eq(operationSteps.key, key)));
      }
      await dbClient.db.update(operations).set({ status: "unknown" }).where(eq(operations.id, op.id));
      return op;
    }
    const backupStatus = (state: BackupJobStatus["state"]) =>
      vi.spyOn(sim, "backups").mockImplementation((async (req: { jobId: string }) =>
        ({ jobId: req.jobId, state, failure: null, snapshot: null }) as unknown as BackupJobStatus) as never);

    it("the copy still running answers pending", async () => {
      const calls = jobLog();
      backupStatus("running");
      const op = await unknownUpdate(true, { backup: "running" });
      expect(await applier().recover(op)).toBe("pending");
      expect((await opRow(op.id)).status).toBe("unknown");
      expect(calls).toEqual([]);
    });

    it("the copy gone is interrupted and updates nothing", async () => {
      const calls = jobLog();
      backupStatus("unknown");
      const op = await unknownUpdate(true, { backup: "running" });
      expect(await applier().recover(op)).toBe("settled");
      const row = await opRow(op.id);
      expect(row).toMatchObject({ status: "failed", errorCode: "OPERATION_INTERRUPTED" });
      expect(calls).toEqual([]);
      const s = await steps(op.id);
      expect([s["backup"]!.status, s["update"]!.status, s["settle"]!.status]).toEqual(["failed", "skipped", "skipped"]);
      expect(SiteWordpressLastUpdateDtoSchema.parse((await stored())!.lastUpdate)).toMatchObject({
        problem: "interrupted",
        backup: "failed",
        status: "failed",
      });
      expect(await finishedAudits(op.id)).toHaveLength(1);
    });

    it("an update that started runs settle and inspect again, never the update", async () => {
      const calls = jobLog();
      const op = await unknownUpdate(false, { backup: "skipped", update: "unknown" });
      expect(await applier().recover(op)).toBe("settled");
      expect(calls.map((c) => c.kind)).toEqual(["wordpress.settle", "wordpress.inspect"]);
      const tag = op.id.replace(/^op_/, "");
      expect(calls.map((c) => c.jobId)).toEqual([`job_${tag}_settle_r`, `job_${tag}_inspect_r`]);
      expect(await opRow(op.id)).toMatchObject({
        status: "failed",
        errorCode: "OPERATION_INTERRUPTED",
        errorMessage: UNKNOWN_SENTENCE,
      });
      const s = await steps(op.id);
      expect([s["update"]!.status, s["settle"]!.status]).toEqual(["failed", "succeeded"]);
      expect(SiteWordpressLastUpdateDtoSchema.parse((await stored())!.lastUpdate)).toMatchObject({
        problem: "outcome_unknown",
        backup: "skipped",
        items: [],
      });
      expect(SiteWordpressStateDtoSchema.parse((await stored())!.state).problem).toBeNull();
      expect(await finishedAudits(op.id)).toHaveLength(1);
    });

    it("an update that never started is interrupted without any job", async () => {
      const calls = jobLog();
      const op = await unknownUpdate(false, { backup: "skipped" });
      expect(await applier().recover(op)).toBe("settled");
      expect(calls).toEqual([]);
      expect(SiteWordpressLastUpdateDtoSchema.parse((await stored())!.lastUpdate)).toMatchObject({ problem: "interrupted" });
    });

    // A cause that never goes away ends the update without any job and frees the lock.
    async function expectEndedUnknown(op: Op, calls: SiteJobRequest[]) {
      expect(await applier().recover(op)).toBe("settled");
      expect(calls).toEqual([]);
      expect(await opRow(op.id)).toMatchObject({
        status: "failed",
        errorCode: "OPERATION_INTERRUPTED",
        errorMessage: expect.stringMatching(new RegExp(`^${UNKNOWN_SENTENCE}`)),
      });
      const audits = await finishedAudits(op.id);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.details).toMatchObject({ status: "failed", problem: "outcome_unknown" });
      expect((await copyRow(op.id)).status).toBe("failed");
      await expect(enqueue("site.wordpress.inspect")).resolves.toBeTruthy();
    }

    it("a stored target that no longer parses ends as outcome unknown, without any job", async () => {
      const calls = jobLog();
      const op = await unknownUpdate(true, { backup: "succeeded", update: "unknown" });
      await breakTarget(op.id);
      await expectEndedUnknown(op, calls);
      // lastUpdate holds a target by contract: without a readable one it is left as it was.
      expect((await stored())?.lastUpdate ?? null).toBeNull();
    });

    it("a site that is gone ends as outcome unknown, without any job", async () => {
      const calls = jobLog();
      const op = await unknownUpdate(true, { backup: "succeeded", update: "unknown" });
      await dbClient.db.update(operations).set({ resourceId: "site_gone" }).where(eq(operations.id, op.id));
      await expectEndedUnknown({ ...op, resourceId: "site_gone" }, calls);
    });

    // The next read of `table` throws once, as a dropped connection would.
    function failReadOnce(table: unknown) {
      const db = dbClient.db;
      const real = db.select.bind(db);
      let armed = true;
      vi.spyOn(db, "select").mockImplementation(((...args: Parameters<typeof real>) => {
        const query = real(...args);
        const from = query.from.bind(query);
        query.from = ((t: never) => {
          if (armed && t === table) {
            armed = false;
            throw new Error("database went away");
          }
          return from(t);
        }) as never;
        return query;
      }) as never);
    }

    for (const [what, table] of [
      ["the stored target", outboxEvents],
      ["the site", sites],
    ] as const) {
      it(`a passing error reading ${what} leaves the operation for the next pass`, async () => {
        const calls = jobLog();
        const op = await unknownUpdate(true, { backup: "succeeded", update: "unknown" });
        const before = await steps(op.id);
        failReadOnce(table);
        await expect(applier().recover(op)).rejects.toThrow("database went away");
        expect((await opRow(op.id)).status).toBe("unknown");
        expect(await steps(op.id)).toEqual(before);
        expect(await finishedAudits(op.id)).toEqual([]);
        expect((await stored())?.lastUpdate ?? null).toBeNull();
        expect((await copyRow(op.id)).status).toBe("running");
        await expect(enqueue("site.wordpress.inspect")).rejects.toThrow();
        expect(calls).toEqual([]);
        // The next pass ends it the normal way.
        expect(await applier().recover(op)).toBe("settled");
        expect(calls.map((c) => c.kind)).toEqual(["wordpress.settle", "wordpress.inspect"]);
        expect(await finishedAudits(op.id)).toHaveLength(1);
        expect(SiteWordpressLastUpdateDtoSchema.parse((await stored())!.lastUpdate)).toMatchObject({ problem: "outcome_unknown" });
      });
    }

    it("a failed copy whose end was not written ends as a failed copy, without any job", async () => {
      const calls = jobLog();
      const op = await unknownUpdate(true, { backup: "failed", update: "skipped", settle: "skipped" });
      expect(await applier().recover(op)).toBe("settled");
      expect(calls).toEqual([]);
      expect(SiteWordpressLastUpdateDtoSchema.parse((await stored())!.lastUpdate)).toMatchObject({
        problem: "backup_failed",
        backup: "failed",
        status: "failed",
      });
    });

    it("a copy taken whose interrupted end was not written ends as interrupted, without any job", async () => {
      const calls = jobLog();
      const op = await unknownUpdate(true, { backup: "succeeded", update: "skipped", settle: "skipped" });
      expect(await applier().recover(op)).toBe("settled");
      expect(calls).toEqual([]);
      expect(SiteWordpressLastUpdateDtoSchema.parse((await stored())!.lastUpdate)).toMatchObject({
        problem: "interrupted",
        backup: "taken",
      });
    });

    it("an operation whose end was already written only gets its status from it", async () => {
      const calls = jobLog();
      const op = await unknownUpdate(false, { backup: "skipped", update: "succeeded", settle: "succeeded" });
      const lastUpdate = {
        operationId: op.id,
        target: { scope: "all" },
        status: "succeeded",
        finishedAt: new Date().toISOString(),
        problem: null,
        backup: "skipped",
        items: [],
      };
      await saveSiteWordpressLastUpdate(dbClient.db, { organizationId: orgId, siteId, lastUpdate });
      await appendAuditEvent(dbClient.db, {
        actorId: null,
        actorType: "system",
        organizationId: orgId,
        action: "site.wordpress.update.finished",
        targetType: "site",
        targetId: siteId,
        details: { operationId: op.id },
      });
      expect(await applier().recover(op)).toBe("settled");
      expect(calls).toEqual([]);
      expect((await opRow(op.id)).status).toBe("succeeded");
      expect((await stored())!.lastUpdate).toEqual(lastUpdate);
      expect(await finishedAudits(op.id)).toHaveLength(1);
    });

    // Last on purpose: it removes the site's service instance.
    it("a site without its service instance ends with lastUpdate saying the outcome is not known", async () => {
      const calls = jobLog();
      const op = await unknownUpdate(true, { backup: "succeeded", update: "unknown" });
      await dbClient.db.delete(serviceInstances).where(eq(serviceInstances.siteId, siteId));
      await expectEndedUnknown(op, calls);
      expect(SiteWordpressLastUpdateDtoSchema.parse((await stored())!.lastUpdate)).toMatchObject({
        operationId: op.id,
        status: "failed",
        problem: "outcome_unknown",
        backup: "taken",
        items: [],
      });
    });
  });
});
