import {
  SiteWordpressLastImportDtoSchema,
  siteJobClientWaitMs,
  type BackupJobStatus,
  type SiteWordpressLastImportDto,
} from "@hosting-panel/contracts";
import {
  and,
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
  saveSiteWordpressLastImport,
  serviceInstances,
  siteBackups,
  siteWordpressState,
  sites,
  transitionOperation,
  upsertBackupSettings,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import type { SiteFilesRequest, SiteJobRequest, SiteJobResult } from "@hosting-panel/executor-contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { totpCodeAt } from "../src/auth/totp.js";
import { SiteBackupsApplier } from "../src/backups/site-backups-applier.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { SITE_STEP_LEASE_MS } from "../src/runtime/site-provisioner.js";
import { SiteWordpressApplier } from "../src/sites/site-wordpress-applier.js";
import { SITE_WORDPRESS_IMPORT_STEPS, SiteWordpressImportApplier } from "../src/sites/site-wordpress-import-applier.js";
import type { ControlPlaneRuntimeConfig } from "../src/tokens.js";

// Every lease renewal and every executor call lands in one ordered log.
const events = vi.hoisted(() => [] as string[]);
// Set to make the next move of an operation to an end status throw.
const failTransition = vi.hoisted(() => ({ on: false }));
vi.mock("@hosting-panel/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hosting-panel/database")>();
  return {
    ...actual,
    transitionOperation: async (...args: Parameters<typeof actual.transitionOperation>) => {
      if (failTransition.on && (args[2] === "failed" || args[2] === "succeeded")) throw new Error("database went away");
      return actual.transitionOperation(...args);
    },
    renewOperationLease: async (...args: Parameters<typeof actual.renewOperationLease>) => {
      events.push(`lease:${String(args[2])}`);
      return actual.renewOperationLease(...args);
    },
  };
});

const KEY = Buffer.alloc(32, 7);
const PW = "correct horse battery";
const SETTINGS = {
  endpoint: "https://s3.example.test",
  region: "eu-south-1",
  bucket: "copies",
  prefix: "panel",
  accessKeyId: "AKIAIMPORTTEST01",
  secretAccessKey: "not-a-real-secret-import",
  scheduleHourUtc: 2,
  retentionDays: 14,
  updatedByUserId: null,
};
const b64 = (s: string) => Buffer.from(s).toString("base64");
const ARCHIVE = Buffer.from(
  `HPSIMZIP\n${JSON.stringify([
    { p: "site/wp-load.php", d: b64("<?php // load") },
    { p: "site/wp-includes/version.php", d: b64("<?php $wp_version = '6.0';") },
    { p: "site/wp-content/themes/neutral/style.css", d: b64("/* neutral */") },
    { p: "site/wp-config.php", d: b64("<?php // theirs") },
    { p: "site/.htaccess", d: b64("# theirs") },
  ])}`,
);
const DUMP = Buffer.from("-- MariaDB dump\nCREATE TABLE t (x INT);\n-- Dump completed\n");
const ALL_CALLS = [
  "import.stat",
  "import.unpack",
  "db.import:prepare",
  "db.import-load",
  "import.switch",
  "db.import:switch",
  "wordpress.import-finalize",
  "import.finish",
  "db.import:finish",
  "wordpress.inspect",
];
const UNDO = ["db.import:undo", "import.undo"];
const NEVER_TWICE = ["import.unpack", "db.import:prepare", "db.import-load", "import.switch", "db.import:switch", "wordpress.import-finalize"];
const OPENING = "The site was imported and is being opened to visitors again. Check again in a few minutes.";
const FORBIDDEN = /docker|container|image|network|volume|revision|job|schema|hp_i[saum]_|\.htpanel-import/i;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Op = typeof operations.$inferSelect;
type Call = { name: string; req: Json };
type Hook = (req: Json) => Promise<unknown>;

const ambiguous = () =>
  Object.assign(new Error("Timed out waiting for docker-executor IPC response"), {
    code: "OPERATION_AMBIGUOUS",
    ambiguousOutcome: true,
  });
const coded = (code: string, message = "engine said no") => Object.assign(new Error(message), { code });

describe("SiteWordpressImportApplier", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let sim: InMemoryDockerSimulatorAdapter;
  let orgId: string;
  let siteId: string;
  let svcId: string;
  const config = { runtimeBackend: "local-simulator", secretsMasterKey: KEY } as unknown as ControlPlaneRuntimeConfig;
  const hooks = new Map<string, Hook[]>();
  // While set, executor calls are test setup: not recorded and not hooked.
  let quiet = false;

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
    svcId = (await dbClient.db.select().from(serviceInstances).where(eq(serviceInstances.siteId, siteId)))[0]!.id;
    await upsertBackupSettings(dbClient.db, KEY, SETTINGS);
  });

  afterAll(async () => {
    await app.close();
    await dbClient.close();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    hooks.clear();
    events.length = 0;
    failTransition.on = false;
    quiet = false;
    // The simulator has no public reset of its one-shot import knobs; drop any a test left unconsumed.
    (sim.files as unknown as { importFailures: Map<string, unknown> }).importFailures.clear();
    // Leave the simulated site without any import: undo what a test left switched, then empty the slots.
    for (const id of sim.files.importState(svcId).plans) {
      await sim.siteFiles({ serviceInstanceId: svcId, op: "import.undo", importId: id });
    }
    await sim.siteFiles({ serviceInstanceId: svcId, op: "import.discard" });
    await dbClient.db
      .update(operations)
      .set({ status: "failed" })
      .where(and(eq(operations.resourceId, siteId), inArray(operations.status, ["queued", "processing", "unknown", "reconciling"])));
    await dbClient.db.delete(siteWordpressState).where(eq(siteWordpressState.siteId, siteId));
  });

  function applier(): SiteWordpressImportApplier {
    const backups = new SiteBackupsApplier(dbClient, sim, config);
    backups.pollMs = 0;
    return new SiteWordpressImportApplier(backups, new SiteWordpressApplier(backups, dbClient, sim, config), dbClient, sim, config);
  }

  /** Makes the next call named `name` answer through `fn` instead of the simulator. */
  function hook(name: string, fn: Hook) {
    hooks.set(name, [...(hooks.get(name) ?? []), fn]);
  }
  const exit = (code: number, result?: unknown): Hook => async (req) =>
    ({ jobId: req.jobId, exitCode: code, outputTail: "", ...(result === undefined ? {} : { result }) }) as unknown as SiteJobResult; // forged answers may be off-type
  const throws = (err: unknown): Hook => async () => {
    throw err;
  };

  /** Records every executor call in order; hooks answer in place of the simulator. */
  function log(): Call[] {
    const calls: Call[] = [];
    const realJob = sim.runSiteJob.bind(sim);
    const realFiles = sim.siteFiles.bind(sim);
    const route = async (name: string, req: Json, real: () => Promise<unknown>) => {
      if (quiet) return real();
      calls.push({ name, req });
      events.push(`call:${name}`);
      const fn = hooks.get(name)?.shift();
      return fn ? fn(req) : real();
    };
    vi.spyOn(sim, "runSiteJob").mockImplementation(async (req: SiteJobRequest) =>
      route(req.kind === "db.import" ? `db.import:${req.params?.["step"]}` : req.kind, req, () => realJob(req)) as Promise<SiteJobResult>,
    );
    vi.spyOn(sim, "siteFiles").mockImplementation((async (req: SiteFilesRequest) =>
      route(req.op, req, () => realFiles(req))) as never);
    return calls;
  }

  async function fill(slots: ("archive" | "dump")[] = ["archive", "dump"]) {
    for (const slot of slots) {
      await sim.files.handle({
        serviceInstanceId: svcId,
        op: "import.put",
        slot,
        uploadId: `upload_${slot}_0000000000`,
        offset: 0,
        dataBase64: (slot === "archive" ? ARCHIVE : DUMP).toString("base64"),
        final: true,
      });
    }
  }

  async function enqueue(copy = false): Promise<Op> {
    const { operation } = await enqueueOperationTransactional(dbClient.db, {
      organizationId: orgId,
      kind: "site.wordpress.import",
      resourceType: "site",
      resourceId: siteId,
      lockKey: `site:${siteId}`,
      leaseDurationMs: SITE_STEP_LEASE_MS,
      steps: SITE_WORDPRESS_IMPORT_STEPS,
      outboxPayload: { siteId },
    });
    if (copy) await insertSiteBackup(dbClient.db, { siteId, kind: "pre_update", status: "running", operationId: operation.id });
    await transitionOperation(dbClient.db, operation.id, "processing");
    return operation;
  }

  const opRow = async (id: string) => (await dbClient.db.select().from(operations).where(eq(operations.id, id)))[0]!;
  const siteStatus = async () => (await dbClient.db.select({ s: sites.status }).from(sites).where(eq(sites.id, siteId)))[0]!.s;
  const steps = async (id: string) =>
    Object.fromEntries(
      (await dbClient.db.select().from(operationSteps).where(eq(operationSteps.operationId, id))).map((s) => [s.key, s.status]),
    );
  const stepNotes = async (id: string) =>
    (await dbClient.db.select().from(operationSteps).where(eq(operationSteps.operationId, id))).map((s) => s.message ?? "");
  const lastImport = async (): Promise<SiteWordpressLastImportDto | null> => {
    const row = await getSiteWordpressState(dbClient.db, { organizationId: orgId, siteId });
    return row?.lastImport ? SiteWordpressLastImportDtoSchema.parse(row.lastImport) : null;
  };
  const finishedAudits = async (opId: string) =>
    (await dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, "site.wordpress.import.finished"))).filter(
      (r) => (r.details as Json)["operationId"] === opId,
    );
  const names = (calls: Call[]) => calls.map((c) => c.name);

  async function run(opts: { copy?: boolean; filled?: boolean } = {}) {
    if (opts.filled !== false) await fill();
    const before = await siteStatus();
    const op = await enqueue(opts.copy);
    const error = await applier()
      .apply(op)
      .then(() => null, (err: unknown) => err as Json);
    expect(await siteStatus()).toBe(before);
    return { op, error, row: await opRow(op.id), steps: await steps(op.id), last: await lastImport() };
  }

  describe("apply", () => {
    it("runs the calls of R150 in order and ends imported", async () => {
      const calls = log();
      const r = await run();
      expect(r.error).toBeNull();
      expect(names(calls)).toEqual(ALL_CALLS);
      const importId = r.op.id.slice(3);
      const byName = Object.fromEntries(calls.map((c) => [c.name, c.req]));
      expect(byName["import.stat"]).toEqual({ serviceInstanceId: svcId, op: "import.stat" });
      for (const op of ["import.unpack", "import.switch", "import.finish"]) {
        expect(byName[op]).toEqual({ serviceInstanceId: svcId, op, importId });
      }
      for (const step of ["prepare", "switch", "finish"]) {
        expect(byName[`db.import:${step}`]!["params"]).toEqual({ step, importId });
      }
      expect(byName["db.import-load"]!["params"]).toEqual({ importId });
      expect(byName["wordpress.import-finalize"]!["params"]).toEqual({
        phpVersion: expect.any(String),
        tablePrefix: "wp_",
        siteUrl: expect.stringMatching(/^https?:\/\/wp-a\.example\.test$/),
        previousUrl: "http://old.example.test",
      });
      expect(new Set(calls.filter((c) => c.req["jobId"]).map((c) => c.req["jobId"])).size).toBe(6);
      expect(r.row.status).toBe("succeeded");
      expect(r.steps).toEqual({
        check: "succeeded",
        backup: "skipped",
        unpack: "succeeded",
        database: "succeeded",
        switch: "succeeded",
        finish: "succeeded",
      });
      expect(r.last).toMatchObject({
        operationId: r.op.id,
        outcome: "imported",
        reason: null,
        backup: "skipped",
        oldAddress: "http://old.example.test",
        leftOut: ["wp-config.php", ".htaccess"],
        tables: 12,
        line: null,
        errorNumber: null,
      });
      expect(Date.parse(r.last!.finishedAt)).toBeGreaterThan(Date.now() - 60_000);
      const audits = await finishedAudits(r.op.id);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ actorType: "system", actorId: null, targetType: "site", targetId: siteId });
      expect(audits[0]!.details).toMatchObject({ outcome: "imported", reason: null, tables: 12, leftOut: ["wp-config.php", ".htaccess"] });
      expect(sim.files.importState(svcId)).toEqual({ gate: false, plans: [] });
      const notes = [...(await stepNotes(r.op.id)), ...SITE_WORDPRESS_IMPORT_STEPS.map((s) => s.label)];
      for (const note of notes) expect(note).not.toMatch(FORBIDDEN);
    });

    it("takes the copy first when a copy row exists", async () => {
      const calls = log();
      const r = await run({ copy: true });
      expect(r.row.status).toBe("succeeded");
      expect(r.steps["backup"]).toBe("succeeded");
      expect(r.last).toMatchObject({ outcome: "imported", backup: "taken" });
      expect(names(calls)).toEqual(ALL_CALLS);
      expect((await dbClient.db.select().from(siteBackups).where(eq(siteBackups.operationId, r.op.id)))[0]!.status).toBe("succeeded");
    });

    it.each([
      ["a slot that is not complete", "files_missing", false],
      ["remains of an earlier import", "earlier_import_unfinished", true],
    ])("check: %s ends %s without the undo pair", async (_n, reason, remains) => {
      if (remains) {
        // An earlier import left its switched work folder behind.
        await fill();
        await sim.siteFiles({ serviceInstanceId: svcId, op: "import.unpack", importId: "e".repeat(32) });
        await sim.siteFiles({ serviceInstanceId: svcId, op: "import.switch", importId: "e".repeat(32) });
      } else {
        await fill(["archive"]);
      }
      const calls = log();
      const r = await run({ filled: false });
      expect(names(calls)).toEqual(["import.stat"]);
      expect(r.row.status).toBe("failed");
      expect(r.steps).toMatchObject({ check: "failed", backup: "skipped", unpack: "skipped", finish: "skipped" });
      expect(r.last).toMatchObject({ outcome: "nothing_changed", reason, backup: "skipped", leftOut: [], tables: null });
      expect(await finishedAudits(r.op.id)).toHaveLength(1);
      if (remains) expect(sim.files.importState(svcId).plans).toEqual(["e".repeat(32)]);
    });

    it("backup: a failed copy ends backup_failed without the undo pair", async () => {
      const calls = log();
      const real = sim.backups.bind(sim);
      vi.spyOn(sim, "backups").mockImplementation((async (req: { action: string; jobId: string }) =>
        req.action === "start"
          ? ({ jobId: req.jobId, state: "failed", failure: "other", snapshot: null } as unknown as BackupJobStatus)
          : real(req as never)) as never);
      const r = await run({ copy: true });
      expect(names(calls)).toEqual(["import.stat"]);
      expect(r.row.status).toBe("failed");
      expect(r.steps).toMatchObject({ check: "succeeded", backup: "failed", unpack: "skipped" });
      expect(r.last).toMatchObject({ outcome: "nothing_changed", reason: "backup_failed", backup: "failed" });
      expect(await finishedAudits(r.op.id)).toHaveLength(1);
    });

    it.each([
      ["import.unpack", "unpack"],
      ["db.import:prepare", "database"],
      ["db.import-load", "database"],
    ])("%s failing runs the undo pair and ends nothing_changed, slots kept", async (name, step) => {
      const calls = log();
      if (name === "import.unpack") sim.files.failNextImport("import.unpack", "archive_not_wordpress");
      else hook(name, exit(name === "db.import-load" ? 54 : 85));
      const r = await run();
      const upTo = ALL_CALLS.slice(0, ALL_CALLS.indexOf(name) + 1);
      expect(names(calls)).toEqual([...upTo, ...UNDO]);
      expect(r.steps[step]).toBe("failed");
      expect(r.steps["switch"]).toBe("skipped");
      expect(r.last).toMatchObject({ outcome: "nothing_changed" });
      expect(r.row.status).toBe("failed");
      expect(sim.files.importState(svcId)).toEqual({ gate: false, plans: [] });
      const stat = await sim.siteFiles({ serviceInstanceId: svcId, op: "import.stat" });
      expect([stat.archive.state, stat.dump.state]).toEqual(["complete", "complete"]);
    });

    it.each(["import.switch", "db.import:switch", "wordpress.import-finalize"])(
      "%s failing runs the undo pair and ends site_restored",
      async (name) => {
        const calls = log();
        if (name === "import.switch") sim.files.failNextImport("import.switch", "disk_full");
        else hook(name, exit(name === "db.import:switch" ? 85 : 25));
        const r = await run();
        expect(names(calls)).toEqual([...ALL_CALLS.slice(0, ALL_CALLS.indexOf(name) + 1), ...UNDO]);
        expect(r.steps).toMatchObject({ database: "succeeded", switch: "failed", finish: "skipped" });
        expect(r.last).toMatchObject({ outcome: "site_restored", oldAddress: "http://old.example.test" });
        expect(r.row.status).toBe("failed");
        expect(r.row.errorMessage).not.toMatch(FORBIDDEN);
        expect(sim.files.importState(svcId)).toEqual({ gate: false, plans: [] });
      },
    );

    it.each([
      ["db.import:finish", exit(97)],
      ["db.import:finish", throws(ambiguous())],
      ["wordpress.inspect", exit(1)],
    ])("finish: %s failing still ends imported", async (name, fn) => {
      const calls = log();
      hook(name, fn);
      const r = await run();
      expect(r.error).toBeNull();
      expect(names(calls)).toEqual(ALL_CALLS);
      expect(r.row.status).toBe("succeeded");
      expect(r.steps["finish"]).toBe("failed");
      expect(r.last).toMatchObject({ outcome: "imported", oldAddress: "http://old.example.test" });
      expect(await finishedAudits(r.op.id)).toHaveLength(1);
    });

    it.each([
      ["refused by the helper", () => sim.files.failNextImport("import.finish", "staging_unsafe")],
      ["with an unknown end", () => sim.files.failNextImport("import.finish", "timeout")],
      ["with a down executor", () => hook("import.finish", throws(coded("DOCKER_ENGINE_UNAVAILABLE")))],
    ])("finish: import.finish %s settles nothing and is left for recovery", async (_n, arm) => {
      const calls = log();
      arm();
      const r = await run();
      expect(r.error).toMatchObject({ code: "OPERATION_AMBIGUOUS", ambiguousOutcome: true });
      expect(r.error!["message"]).not.toMatch(FORBIDDEN);
      expect(names(calls)).toEqual(ALL_CALLS.slice(0, ALL_CALLS.indexOf("import.finish") + 1));
      expect(r.row.status).toBe("processing");
      expect(r.steps).toMatchObject({ switch: "succeeded", finish: "running" });
      expect(await stepNotes(r.op.id)).toContain(OPENING);
      expect(OPENING).not.toMatch(FORBIDDEN);
      expect(r.last).toBeNull();
      expect(await finishedAudits(r.op.id)).toEqual([]);
    });
  });

  describe("the undo itself", () => {
    it("exit 92 of the database undo ends undo_incomplete and never calls the files undo", async () => {
      const calls = log();
      hook("db.import-load", exit(54));
      hook("db.import:undo", exit(92));
      const r = await run();
      expect(names(calls).slice(-2)).toEqual(["db.import-load", "db.import:undo"]);
      expect(r.last).toMatchObject({ outcome: "undo_incomplete", reason: "dump_not_wordpress" });
      expect(r.row.status).toBe("failed");
      expect(r.row.errorMessage).toMatch(/Backups/);
    });

    it("{ complete: false } of the files undo ends undo_incomplete", async () => {
      const calls = log();
      hook("db.import:switch", exit(85));
      sim.files.failNextImport("import.undo", "undo_incomplete");
      const r = await run();
      expect(names(calls).slice(-2)).toEqual(UNDO);
      expect(r.last).toMatchObject({ outcome: "undo_incomplete", reason: "site_objects_unsupported" });
      expect(sim.files.importState(svcId).gate).toBe(true);
    });

    it.each([
      ["exit 1 of the database undo", "db.import:undo", exit(1)],
      ["a transport error of the files undo", "import.undo", throws(coded("DOCKER_ENGINE_UNAVAILABLE"))],
      ["an unknown end of the files undo", "import.undo", throws(ambiguous())],
    ])("%s leaves the operation for recovery and writes nothing", async (_n, name, fn) => {
      const calls = log();
      hook("wordpress.import-finalize", exit(25));
      hook(name, fn);
      const r = await run();
      expect(r.error).toMatchObject({ code: "OPERATION_AMBIGUOUS" });
      expect(r.error!["message"]).not.toMatch(FORBIDDEN);
      expect(names(calls).at(-1)).toBe(name);
      if (name === "db.import:undo") expect(names(calls)).not.toContain("import.undo");
      expect(r.row.status).toBe("processing");
      expect(r.steps["switch"]).toBe("failed");
      expect(r.last).toBeNull();
      expect(await finishedAudits(r.op.id)).toEqual([]);
    });
  });

  describe("an unknown end of a call never sent twice", () => {
    it.each(NEVER_TWICE)("%s is rethrown, nothing is written, and it is not sent again", async (name) => {
      const calls = log();
      if (name.startsWith("import.")) sim.files.failNextImport(name as "import.unpack", "timeout");
      else hook(name, throws(ambiguous()));
      const r = await run();
      expect(r.error).toMatchObject({ ambiguousOutcome: true });
      expect(names(calls)).toEqual(ALL_CALLS.slice(0, ALL_CALLS.indexOf(name) + 1));
      expect(r.row.status).toBe("processing");
      expect(r.last).toBeNull();
      expect(await finishedAudits(r.op.id)).toEqual([]);
    });
  });

  describe("R157: where every reason comes from", () => {
    const line = { line: 631, errorNumber: 1044 };
    const cases: [string, string, Hook | string, string, string][] = [
      // [title, call, failure (a hook, or a helper reason for the files op), reason, outcome]
      ...(
        [
          ["not_a_zip", "archive_not_zip"],
          ["dump_not_sql", "dump_not_sql"],
          ["archive_unsafe", "archive_unsafe"],
          ["archive_limit", "archive_limit"],
          ["archive_not_wordpress", "archive_not_wordpress"],
          ["disk_full", "disk_full"],
          ["staging_unsafe", "staging_unsafe"],
          ["files_missing", "files_missing"],
          ["protected", "other"],
        ] as const
      ).map(([h, reason]) => [`helper ${h}`, "import.unpack", h, reason, "nothing_changed"] as [string, string, string, string, string]),
      ["helper time limit", "import.unpack", throws(coded("OPERATION_INTERRUPTED", "Site files operation timed out")), "timed_out", "nothing_changed"],
      ["helper not reachable", "import.unpack", throws(coded("DOCKER_ENGINE_UNAVAILABLE")), "unavailable", "nothing_changed"],
      ["an odd helper error", "import.unpack", throws(new Error("weird")), "other", "nothing_changed"],
      ...(
        [
          [50, "dump_unsafe"],
          [51, "dump_not_sql"],
          [52, "dump_too_large"],
          [53, "dump_incomplete"],
          [54, "dump_not_wordpress"],
          [55, "dump_ambiguous"],
          [56, "multisite_unsupported"],
          [57, "dump_objects_unsupported"],
          [58, "dump_names_unsupported"],
          [59, "address_unsupported"],
          [62, "dump_too_many_tables"],
          [11, "unavailable"],
          [124, "timed_out"],
          [137, "timed_out"],
          [64, "other"],
          [1, "other"],
          [99, "other"],
        ] as const
      ).map(([code, reason]) => [`load exit ${code}`, "db.import-load", exit(code), reason, "nothing_changed"] as [string, string, Hook, string, string]),
      ["load exit 60", "db.import-load", exit(60, line), "dump_load_failed", "nothing_changed"],
      ["load exit 61", "db.import-load", exit(61, line), "dump_statement_unsupported", "nothing_changed"],
      ["prepare exit 1", "db.import:prepare", exit(1), "unavailable", "nothing_changed"],
      ["prepare exit 86", "db.import:prepare", exit(86), "other", "nothing_changed"],
      ["prepare exit 124", "db.import:prepare", exit(124), "timed_out", "nothing_changed"],
      ["db switch exit 84", "db.import:switch", exit(84), "dump_names_unsupported", "site_restored"],
      ["db switch exit 85", "db.import:switch", exit(85), "site_objects_unsupported", "site_restored"],
      ["db switch exit 1", "db.import:switch", exit(1), "unavailable", "site_restored"],
      ["db switch exit 11", "db.import:switch", exit(11), "unavailable", "site_restored"],
      ["db switch exit 64", "db.import:switch", exit(64), "other", "site_restored"],
      ["finalize exit 25", "wordpress.import-finalize", exit(25), "site_check_failed", "site_restored"],
      ["finalize exit 26", "wordpress.import-finalize", exit(26), "address_rewrite_failed", "site_restored"],
      ["finalize exit 20", "wordpress.import-finalize", exit(20), "other", "site_restored"],
      ["finalize exit 137", "wordpress.import-finalize", exit(137), "timed_out", "site_restored"],
      ["finalize not reachable", "wordpress.import-finalize", throws(coded("DOCKER_ENGINE_UNAVAILABLE")), "unavailable", "site_restored"],
      ["files switch staging_unsafe", "import.switch", "staging_unsafe", "staging_unsafe", "site_restored"],
    ];

    it.each(cases)("%s gives exactly its reason", async (_t, name, failure, reason, outcome) => {
      const calls = log();
      if (typeof failure === "string") sim.files.failNextImport(name as "import.unpack", failure as never);
      else hook(name, failure);
      const r = await run();
      expect(r.last).toMatchObject({ outcome, reason });
      expect(names(calls).slice(-2)).toEqual(UNDO);
      const fromLoad = reason === "dump_load_failed" || reason === "dump_statement_unsupported";
      expect(r.last).toMatchObject(fromLoad ? line : { line: null, errorNumber: null });
      expect(r.row.errorMessage).not.toMatch(FORBIDDEN);
    });

    it("line and errorNumber come only from an answer the schema accepts", async () => {
      log();
      hook("db.import-load", exit(61, { ...line, extra: "x" }));
      const r = await run();
      expect(r.last).toMatchObject({ reason: "dump_statement_unsupported", line: null, errorNumber: null });
    });

    // R164.4: the pattern accepts these, the URL parser does not; the end is written all the same.
    it.each([
      ["http://10.0.0.300", "10.0.0.300"],
      ["http://1.2.3.4.5", "1.2.3.4.5"],
      ["https://old.example.test:99999", "old.example.test:99999"],
    ])("an old address %s ends imported with oldHost %s", async (oldUrl, oldHost) => {
      log();
      hook("db.import-load", exit(0, { prefix: "wp_", oldUrl, tables: 12 }));
      const r = await run();
      expect(r.error).toBeNull();
      expect(r.row.status).toBe("succeeded");
      expect(r.last).toMatchObject({ outcome: "imported", oldAddress: oldUrl });
      const audits = await finishedAudits(r.op.id);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.details).toMatchObject({ outcome: "imported", oldHost });
    });

    it("an old address the URL parser refuses still writes the end of a failure after the load", async () => {
      const calls = log();
      hook("db.import-load", exit(0, { prefix: "wp_", oldUrl: "http://old.example.test:99999", tables: 12 }));
      hook("wordpress.import-finalize", exit(25));
      const r = await run();
      expect(names(calls).slice(-2)).toEqual(UNDO);
      expect(r.row.status).toBe("failed");
      expect(r.last).toMatchObject({ outcome: "site_restored", reason: "site_check_failed", oldAddress: "http://old.example.test:99999" });
      const audits = await finishedAudits(r.op.id);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.details).toMatchObject({ outcome: "site_restored", oldHost: "old.example.test:99999" });
    });

    it.each([
      ["a prefix with odd characters", { prefix: "wp-;", oldUrl: "http://old.example.test", tables: 12 }],
      ["an address with a path", { prefix: "wp_", oldUrl: "http://old.example.test/blog", tables: 12 }],
      ["an upper-case host", { prefix: "wp_", oldUrl: "http://OLD.example.test", tables: 12 }],
      ["no answer at all", undefined],
    ])("a successful load with %s is address_unsupported and nothing is switched", async (_n, result) => {
      const calls = log();
      hook("db.import-load", exit(0, result));
      const r = await run();
      expect(names(calls)).toEqual([...ALL_CALLS.slice(0, 4), ...UNDO]);
      expect(r.last).toMatchObject({ outcome: "nothing_changed", reason: "address_unsupported", oldAddress: null });
    });
  });

  it("renews the lease before each call to its client wait plus 60 s", async () => {
    log();
    hook("wordpress.import-finalize", exit(25));
    await run();
    const wait: Record<string, number> = {
      "import.stat": 60_000,
      "import.unpack": 600_000,
      "db.import:prepare": siteJobClientWaitMs("db.import"),
      "db.import-load": siteJobClientWaitMs("db.import-load"),
      "import.switch": 60_000,
      "db.import:switch": siteJobClientWaitMs("db.import"),
      "wordpress.import-finalize": siteJobClientWaitMs("wordpress.import-finalize"),
      "db.import:undo": siteJobClientWaitMs("db.import"),
      "import.undo": 600_000,
    };
    const seen = events.filter((e) => e.startsWith("call:"));
    expect(seen.map((e) => e.slice(5))).toEqual(Object.keys(wait));
    events.forEach((e, i) => {
      if (e.startsWith("call:")) expect(events[i - 1]).toBe(`lease:${String(wait[e.slice(5)]! + 60_000)}`);
    });
  });

  it("the password lives only in resolvedSecrets of prepare and load", async () => {
    const out: string[] = [];
    for (const m of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void out.push(a.map(String).join(" ")));
    }
    const write = process.stdout.write.bind(process.stdout);
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown, ...rest: never[]) => {
      out.push(String(chunk));
      return write(chunk as string, ...rest);
    }) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => void out.push(String(chunk))) as never);
    const calls = log();
    hook("wordpress.import-finalize", exit(26));
    const r = await run();
    const withSecret = calls.filter((c) => c.req["resolvedSecrets"]);
    expect(withSecret.map((c) => c.name)).toEqual(["db.import:prepare", "db.import-load"]);
    const pw = withSecret[0]!.req["resolvedSecrets"]["HP_IMPORT_DB_PASSWORD"] as string;
    expect(pw).toMatch(/^[0-9a-f]{64}$/);
    expect(withSecret[1]!.req["resolvedSecrets"]).toEqual({ HP_IMPORT_DB_PASSWORD: pw });
    const written = [
      calls.map((c) => ({ ...c.req, resolvedSecrets: undefined })),
      await dbClient.db.select().from(operations),
      await dbClient.db.select().from(operationSteps),
      await dbClient.db.select().from(auditEvents),
      await dbClient.db.select().from(outboxEvents),
      await dbClient.db.select().from(siteWordpressState),
      r.error,
      out,
    ];
    expect(JSON.stringify(written)).not.toContain(pw);
    const audit = (await finishedAudits(r.op.id))[0]!;
    expect(JSON.stringify(audit.details)).not.toMatch(/HP_|hp_i|\.htpanel-import|password|[0-9a-f]{64}/i);
  });

  describe("the end is written once, in one transaction", () => {
    it.each([
      ["a failed import", false],
      ["an imported site", true],
    ])("a failing last write for %s leaves no outcome, no audit, and the operation not ended", async (_n, ok) => {
      if (!ok) await fill(["archive"]);
      failTransition.on = true;
      const r = await run({ filled: ok });
      expect(r.error).toMatchObject({ message: "database went away" });
      expect(r.row.status).toBe("processing");
      expect(r.last).toBeNull();
      expect(await finishedAudits(r.op.id)).toEqual([]);
    });

    async function stored(outcome: "imported" | "site_restored") {
      const op = await enqueue();
      const last = {
        operationId: op.id,
        finishedAt: new Date().toISOString(),
        outcome,
        reason: outcome === "imported" ? null : "site_check_failed",
        backup: "skipped",
        oldAddress: null,
        leftOut: [],
        tables: null,
        line: null,
        errorNumber: null,
      };
      await saveSiteWordpressLastImport(dbClient.db, { organizationId: orgId, siteId, lastImport: last });
      return { op, last };
    }

    it.each([
      ["imported", "succeeded"],
      ["site_restored", "failed"],
    ] as const)("a second apply of a stored %s only moves the operation", async (outcome, status) => {
      const calls = log();
      const { op, last } = await stored(outcome);
      await applier().apply(op).catch(() => null);
      expect(calls).toEqual([]);
      expect((await opRow(op.id)).status).toBe(status);
      expect(await lastImport()).toEqual(last);
      expect(await finishedAudits(op.id)).toEqual([]);
    });

    it("recover of a stored outcome answers settled and only moves the operation", async () => {
      const calls = log();
      const { op, last } = await stored("site_restored");
      await dbClient.db.update(operations).set({ status: "unknown" }).where(eq(operations.id, op.id));
      expect(await applier().recover({ ...op, status: "unknown" })).toBe("settled");
      expect(calls).toEqual([]);
      expect(await opRow(op.id)).toMatchObject({ status: "failed", errorCode: "OPERATION_INTERRUPTED" });
      expect(await lastImport()).toEqual(last);
      expect(await finishedAudits(op.id)).toEqual([]);
    });
  });

  describe("recover", () => {
    /** An import whose steps stopped as given, with the files side in the matching state. */
    async function unknownImport(stepStatus: Record<string, string>, opts: { copy?: boolean; switched?: boolean } = {}) {
      quiet = true;
      await fill();
      const op = await enqueue(opts.copy);
      const importId = op.id.slice(3);
      if (stepStatus["unpack"] && stepStatus["unpack"] !== "pending") {
        await sim.siteFiles({ serviceInstanceId: svcId, op: "import.unpack", importId });
      }
      if (opts.switched) await sim.siteFiles({ serviceInstanceId: svcId, op: "import.switch", importId });
      quiet = false;
      for (const [key, status] of Object.entries(stepStatus)) {
        await dbClient.db
          .update(operationSteps)
          .set({ status: status as never })
          .where(and(eq(operationSteps.operationId, op.id), eq(operationSteps.key, key)));
      }
      await dbClient.db.update(operations).set({ status: "unknown" }).where(eq(operations.id, op.id));
      return { ...op, status: "unknown" as const };
    }
    const before = { check: "succeeded", backup: "skipped" };

    it("a site that is gone fails the operation without any call", async () => {
      const calls = log();
      const op = await unknownImport({ ...before, unpack: "succeeded", database: "succeeded", switch: "running" });
      await dbClient.db.update(operations).set({ resourceId: "site_gone" }).where(eq(operations.id, op.id));
      expect(await applier().recover({ ...op, resourceId: "site_gone" })).toBe("settled");
      expect(calls).toEqual([]);
      expect(await opRow(op.id)).toMatchObject({ status: "failed", errorCode: "OPERATION_INTERRUPTED" });
      await dbClient.db.update(operations).set({ resourceId: siteId }).where(eq(operations.id, op.id));
    });

    it.each(["running", "unknown"])("the copy step %s is settled: still running answers pending", async (backup) => {
      const calls = log();
      vi.spyOn(sim, "backups").mockImplementation((async (req: { jobId: string }) =>
        ({ jobId: req.jobId, state: "running", failure: null, snapshot: null }) as unknown as BackupJobStatus) as never);
      const op = await unknownImport({ check: "succeeded", backup }, { copy: true });
      expect(await applier().recover(op)).toBe("pending");
      expect(calls).toEqual([]);
      expect((await opRow(op.id)).status).toBe("unknown");
      expect(await lastImport()).toBeNull();
    });

    it("stopped before the unpack: nothing to undo, interrupted", async () => {
      const calls = log();
      const settle = vi.spyOn(SiteBackupsApplier.prototype, "settleBackupJob");
      // The backup step is still pending: no copy was ever started (R164.5.2).
      const op = await unknownImport({ check: "unknown" });
      expect(await applier().recover(op)).toBe("settled");
      expect(calls).toEqual([]);
      expect(settle).not.toHaveBeenCalled();
      expect(await lastImport()).toMatchObject({ outcome: "nothing_changed", reason: "interrupted", backup: "skipped" });
      expect(await opRow(op.id)).toMatchObject({ status: "failed", errorCode: "OPERATION_INTERRUPTED" });
    });

    it.each([
      ["unpack", { unpack: "unknown" }],
      ["database", { unpack: "succeeded", database: "unknown" }],
      ["database failed", { unpack: "succeeded", database: "failed", switch: "skipped" }],
    ])("unknown in %s: the undo pair, nothing_changed, interrupted", async (_n, s) => {
      const calls = log();
      const op = await unknownImport({ ...before, ...s });
      expect(await applier().recover(op)).toBe("settled");
      expect(names(calls)).toEqual(UNDO);
      expect(await lastImport()).toMatchObject({ outcome: "nothing_changed", reason: "interrupted" });
      expect(await opRow(op.id)).toMatchObject({ status: "failed", errorCode: "OPERATION_INTERRUPTED" });
      expect(await finishedAudits(op.id)).toHaveLength(1);
      const st = await steps(op.id);
      expect(Object.values(st).every((v) => ["succeeded", "failed", "skipped"].includes(v))).toBe(true);
    });

    it.each(["running", "unknown", "failed"])("switch %s: the undo pair, site_restored", async (sw) => {
      const calls = log();
      const op = await unknownImport({ ...before, unpack: "succeeded", database: "succeeded", switch: sw }, { switched: true });
      expect(sim.files.importState(svcId).gate).toBe(true);
      expect(await applier().recover(op)).toBe("settled");
      expect(names(calls)).toEqual(UNDO);
      expect(await lastImport()).toMatchObject({ outcome: "site_restored", reason: "interrupted" });
      expect(sim.files.importState(svcId)).toEqual({ gate: false, plans: [] });
      expect((await opRow(op.id)).status).toBe("failed");
    });

    it.each([
      ["exit 92", (h: typeof hook) => h("db.import:undo", exit(92)), ["db.import:undo"]],
      ["{ complete: false }", () => sim.files.failNextImport("import.undo", "undo_incomplete"), UNDO],
    ])("the pair answering %s settles undo_incomplete", async (_n, arm, sent) => {
      const calls = log();
      const op = await unknownImport({ ...before, unpack: "succeeded", database: "succeeded", switch: "unknown" }, { switched: true });
      arm(hook);
      expect(await applier().recover(op)).toBe("settled");
      expect(names(calls)).toEqual(sent);
      expect(await lastImport()).toMatchObject({ outcome: "undo_incomplete" });
      expect((await opRow(op.id)).status).toBe("failed");
    });

    it.each([
      ["exit 1", "db.import:undo", exit(1)],
      ["exit 124", "db.import:undo", exit(124)],
      ["a down executor", "db.import:undo", throws(coded("DOCKER_ENGINE_UNAVAILABLE"))],
      ["an unknown end of the files undo", "import.undo", throws(ambiguous())],
      ["a helper error", "import.undo", throws(new Error("staging_unsafe"))],
    ])("the pair failing with %s answers pending and writes nothing", async (_n, name, fn) => {
      const calls = log();
      const op = await unknownImport({ ...before, unpack: "succeeded", database: "succeeded", switch: "unknown" }, { switched: true });
      hook(name, fn);
      expect(await applier().recover(op)).toBe("pending");
      expect(names(calls).at(-1)).toBe(name);
      expect((await opRow(op.id)).status).toBe("unknown");
      expect(await lastImport()).toBeNull();
      expect(await finishedAudits(op.id)).toEqual([]);
      // The next pass ends it.
      expect(await applier().recover(op)).toBe("settled");
      expect(await lastImport()).toMatchObject({ outcome: "site_restored" });
    });

    it("switch done and finish not: finish again, imported, succeeded", async () => {
      const calls = log();
      const op = await unknownImport(
        { ...before, unpack: "succeeded", database: "succeeded", switch: "succeeded", finish: "running" },
        { switched: true },
      );
      expect(await applier().recover(op)).toBe("settled");
      expect(names(calls)).toEqual(["import.finish", "db.import:finish", "wordpress.inspect"]);
      expect(await lastImport()).toMatchObject({ outcome: "imported", reason: null, oldAddress: null });
      expect((await opRow(op.id)).status).toBe("succeeded");
      expect((await steps(op.id))["finish"]).toBe("succeeded");
      expect(sim.files.importState(svcId)).toEqual({ gate: false, plans: [] });
    });

    it.each([
      ["refused by the helper", "staging_unsafe"],
      ["with an unknown end", "timeout"],
    ] as const)("import.finish %s answers pending and writes nothing; the next pass ends imported", async (_n, outcome) => {
      const calls = log();
      const op = await unknownImport(
        { ...before, unpack: "succeeded", database: "succeeded", switch: "succeeded", finish: "running" },
        { switched: true },
      );
      sim.files.failNextImport("import.finish", outcome);
      expect(await applier().recover(op)).toBe("pending");
      expect(names(calls)).toEqual(["import.finish"]);
      expect((await opRow(op.id)).status).toBe("unknown");
      expect((await steps(op.id))["finish"]).toBe("running");
      expect(await stepNotes(op.id)).toContain(OPENING);
      expect(await lastImport()).toBeNull();
      expect(await finishedAudits(op.id)).toEqual([]);
      // The next pass repeats import.finish (R151) and ends it.
      expect(await applier().recover(op)).toBe("settled");
      expect(names(calls)).toEqual(["import.finish", "import.finish", "db.import:finish", "wordpress.inspect"]);
      expect(await lastImport()).toMatchObject({ outcome: "imported", reason: null });
      expect((await opRow(op.id)).status).toBe("succeeded");
      expect((await steps(op.id))["finish"]).toBe("succeeded");
      expect(await finishedAudits(op.id)).toHaveLength(1);
      expect(sim.files.importState(svcId)).toEqual({ gate: false, plans: [] });
    });

    it("no branch sends a call of R151", async () => {
      const calls = log();
      for (const s of [
        { unpack: "unknown" } as Record<string, string>,
        { unpack: "succeeded", database: "running" },
        { unpack: "succeeded", database: "succeeded", switch: "running" },
        { unpack: "succeeded", database: "succeeded", switch: "succeeded" },
      ]) {
        const op = await unknownImport({ ...before, ...s }, { switched: s["switch"] !== undefined });
        expect(await applier().recover(op)).toBe("settled");
      }
      expect(names(calls).filter((n) => NEVER_TWICE.includes(n))).toEqual([]);
    });
  });
});
