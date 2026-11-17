import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { PLATFORM_OPS_ORG_ID, type BackupsIpcRequest } from "@hosting-panel/contracts";
import {
  auditEvents,
  backupSettings,
  createDatabaseClient,
  createSiteTransactional,
  deleteBackupSettings,
  eq,
  hostAllocations,
  hosts,
  insertSiteBackup,
  listAdminBackupStatus,
  operationSteps,
  operations,
  organizations,
  outboxEvents,
  platformInstallations,
  settleSiteBackup,
  siteBackups,
  sites,
  upsertBackupSettings,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { InMemoryHostSimulatorAdapter } from "@hosting-panel/host-agent";
import { Logger } from "@nestjs/common";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BackupSchedulerService } from "../src/backups/backup-scheduler.service.js";
import { BackupSettingsService } from "../src/backups/backup-settings.service.js";
import { PANEL_BACKUP_STEPS } from "../src/backups/panel-backup-applier.js";
import { PanelDumpError, type PanelDumpCommand } from "../src/backups/panel-dump.js";
import { BACKUP_POLL_DEADLINE_MS, SiteBackupsApplier } from "../src/backups/site-backups-applier.js";
import { setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";

const KEY = Buffer.alloc(32, 9);
const KEY_HEX = KEY.toString("hex");
const DB_PW = "canary-PanelDb-Pw-DO-NOT-LEAK-41";
const S3_SECRET = "canary-panel-s3-secret-DO-NOT-LEAK-88";
const NIGHT = new Date("2026-11-15T03:00:00.000Z");
const SETTINGS = {
  endpoint: "https://s3.example.com",
  region: "eu-south-1",
  bucket: "panel-backups",
  prefix: "panel",
  accessKeyId: "AKIAPANEL1",
  secretAccessKey: S3_SECRET,
  scheduleHourUtc: 2,
  retentionDays: 21,
  updatedByUserId: null,
};

describe("nightly panel copy (panel.backups.create)", () => {
  let dbClient: DatabaseClient;
  let sim: InMemoryDockerSimulatorAdapter;
  let app: ControlPlaneAppHandle;
  let applier: SiteBackupsApplier;
  let scheduler: BackupSchedulerService;
  let dumpDir: string;
  let jwtSigningKeyPem: string;
  let calls: BackupsIpcRequest[];
  let fileSeenAtStart: boolean[];
  let dumps: PanelDumpCommand[];
  let logs: string[];
  let seenAudits = new Set<string>();
  const extraApps: ControlPlaneAppHandle[] = [];

  const panelConfig = () => ({
    dir: dumpDir,
    databaseUrl: `postgresql://hosting_panel:${DB_PW}@127.0.0.1:5432/hosting_panel`,
  });

  const makeApp = (panelDump: { dir: string; databaseUrl: string } | null = panelConfig()) =>
    createControlPlaneApp({
      listen: false,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      jwtSigningKeyPem,
      runtimeBackend: "linux-systemd",
      dockerExecutor: sim,
      hostAgent: new InMemoryHostSimulatorAdapter(),
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
      domainReconcileIntervalMs: null,
      mailRelayRetryIntervalMs: null,
      sftpRetryIntervalMs: null,
      backupScheduleIntervalMs: null,
      recoverUnknownOnStart: false,
      panelDump,
    });

  const fakeDump = async (cmd: PanelDumpCommand) => {
    dumps.push(cmd);
    await writeFile(cmd.args[cmd.args.length - 1]!, "PGDMP fake");
  };

  const panelOps = () =>
    dbClient.db.select().from(operations).where(eq(operations.kind, "panel.backups.create"));
  const panelAudits = async () =>
    (await dbClient.db.select().from(auditEvents)).filter(
      (a) => !seenAudits.has(a.id) && a.action.startsWith("panel.backups."),
    );
  const settingsRow = async () => (await dbClient.db.select().from(backupSettings))[0]!;
  const dumpFiles = () => readdir(dumpDir);

  async function queuePanel(): Promise<string> {
    await scheduler.tick(NIGHT);
    const [op] = await panelOps();
    expect(op).toBeDefined();
    return op!.id;
  }

  /** Concatenates every row a secret must never reach. */
  async function everyRow(): Promise<string> {
    const [ops, steps, outbox, audits, settings] = await Promise.all([
      dbClient.db.select().from(operations),
      dbClient.db.select().from(operationSteps),
      dbClient.db.select().from(outboxEvents),
      dbClient.db.select().from(auditEvents),
      dbClient.db.select().from(backupSettings),
    ]);
    return JSON.stringify({ ops, steps, outbox, audits, settings });
  }

  async function expectNoSecrets(): Promise<void> {
    const dto = await app.nestApp.get(BackupSettingsService).get();
    const sites = await listAdminBackupStatus(dbClient.db);
    const haystack = (await everyRow()) + JSON.stringify({ dto, sites }) + logs.join("\n");
    expect(haystack).not.toContain(KEY_HEX);
    expect(haystack).not.toContain(DB_PW);
    // The master key travels only in panelStart.
    for (const call of calls) {
      if (call.action !== "panelStart") {
        expect(JSON.stringify(call)).not.toContain(KEY_HEX);
      }
    }
  }

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, {
      installationName: "Panel Copy Test",
      hostHostname: "panel.test",
      hostIpv4: "10.0.0.1",
    });
    sim = new InMemoryDockerSimulatorAdapter();
    const original = sim.backups.bind(sim);
    sim.backups = (async (req: BackupsIpcRequest) => {
      calls.push(req);
      if (req.action === "panelStart") {
        fileSeenAtStart.push(existsSync(join(dumpDir, `${req.jobId}.dump`)));
      }
      return original(req);
    }) as typeof sim.backups;
    jwtSigningKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    dumpDir = await mkdtemp(join(tmpdir(), "hp-panel-dump-it-"));
    app = await makeApp();
    applier = app.nestApp.get(SiteBackupsApplier);
    scheduler = app.nestApp.get(BackupSchedulerService);
  });

  afterAll(async () => {
    await app.close();
    await dbClient.close();
    await rm(dumpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    calls = [];
    fileSeenAtStart = [];
    dumps = [];
    logs = [];
    for (const stream of [process.stdout, process.stderr]) {
      const write = stream.write.bind(stream);
      vi.spyOn(stream, "write").mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
        logs.push(String(chunk));
        return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof stream.write);
    }
    for (const level of ["log", "warn", "error", "info", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      });
    }
    for (const level of ["log", "warn", "error", "debug", "verbose"] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      });
    }
    sim.backupState.holdJobs(false);
    applier.pollMs = 0;
    applier.pollGiveUpMs = 0;
    applier.pollDeadlineMs = BACKUP_POLL_DEADLINE_MS;
    applier.panel.dump = fakeDump;
    await dbClient.db.delete(siteBackups);
    await dbClient.db.delete(outboxEvents);
    await dbClient.db.delete(operationSteps);
    await dbClient.db.delete(operations);
    seenAudits = new Set((await dbClient.db.select({ id: auditEvents.id }).from(auditEvents)).map((a) => a.id));
    await deleteBackupSettings(dbClient.db);
    await upsertBackupSettings(dbClient.db, KEY, SETTINGS);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const extra of extraApps.splice(0)) {
      await extra.close();
    }
    for (const name of await dumpFiles()) {
      await rm(join(dumpDir, name), { force: true });
    }
  });

  it("Panel copy: queued once per night after the last site, under the platform organisation and its own lock", async () => {
    const [host] = await dbClient.db.select().from(hosts).limit(1);
    const [inst] = await dbClient.db.select().from(platformInstallations).limit(1);
    const orgId = `org_${randomUUID()}`;
    const allocId = `alloc_${randomUUID()}`;
    await dbClient.db.insert(organizations).values({
      id: orgId,
      platformInstallationId: inst!.id,
      name: "Customer",
      slug: `customer-${randomUUID().slice(0, 8)}`,
    });
    await dbClient.db.insert(hostAllocations).values({ id: allocId, hostId: host!.id, organizationId: orgId, status: "active" });
    const { site } = await createSiteTransactional(dbClient.db, {
      organizationId: orgId,
      hostAllocationId: allocId,
      name: "Night Site",
      slug: "night-site",
      phpVersion: "8.4",
      siteType: "wordpress",
    });
    await dbClient.db.update(sites).set({ status: "ready" }).where(eq(sites.id, site.id));
    try {
      // First tick queues the site; the panel copy waits for it.
      await scheduler.tick(NIGHT);
      expect(await panelOps()).toHaveLength(0);
      await scheduler.tick(NIGHT);
      expect(await panelOps()).toHaveLength(0);

      await dbClient.db
        .update(operations)
        .set({ status: "succeeded" })
        .where(eq(operations.kind, "site.backups.create"));
      await scheduler.tick(NIGHT);
      const ops = await panelOps();
      expect(ops).toHaveLength(1);
      expect(ops[0]).toMatchObject({
        organizationId: PLATFORM_OPS_ORG_ID,
        resourceType: "host",
        resourceId: "panel",
        lockKey: "panel:db",
        idempotencyKey: "panel-backup:2026-11-15",
        status: "queued",
      });
      const steps = await dbClient.db
        .select({ key: operationSteps.key })
        .from(operationSteps)
        .where(eq(operationSteps.operationId, ops[0]!.id));
      expect(steps.map((s) => s.key)).toEqual(PANEL_BACKUP_STEPS.map((s) => s.key));
      expect((await settingsRow()).nightlyRunStartedAt).toBeNull();

      // A second tick and a rebuilt app queue nothing new.
      await scheduler.tick(new Date(NIGHT.getTime() + 60_000));
      const rebuilt = await makeApp();
      extraApps.push(rebuilt);
      await rebuilt.nestApp.get(BackupSchedulerService).tick(new Date(NIGHT.getTime() + 120_000));
      expect(await panelOps()).toHaveLength(1);
    } finally {
      await dbClient.db.delete(sites).where(eq(sites.id, site.id));
    }
  });

  it("Panel copy: nothing is queued when not configured, not available, or without panelDump", async () => {
    await deleteBackupSettings(dbClient.db);
    await scheduler.tick(NIGHT);
    expect(await panelOps()).toHaveLength(0);

    await upsertBackupSettings(dbClient.db, KEY, SETTINGS);
    const noDump = await makeApp(null);
    extraApps.push(noDump);
    await noDump.nestApp.get(BackupSchedulerService).tick(NIGHT);
    expect(await panelOps()).toHaveLength(0);
    expect((await settingsRow()).lastNightlyRunOn).toBe("2026-11-15");

    await dbClient.db.update(backupSettings).set({ lastNightlyRunOn: null });
    const disabled = await createControlPlaneApp({
      listen: false,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      jwtSigningKeyPem,
      runtimeBackend: "disabled",
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      backupScheduleIntervalMs: null,
      recoverUnknownOnStart: false,
      panelDump: panelConfig(),
    });
    extraApps.push(disabled);
    await disabled.nestApp.get(BackupSchedulerService).tick(NIGHT);
    expect(await panelOps()).toHaveLength(0);
  });

  it("Outcome + Dump file + Secrets: success writes the line, one audit, ends the operation and removes the file", async () => {
    const opId = await queuePanel();
    await app.outboxWorker.processPendingOnce();

    const [op] = await panelOps();
    expect(op!.status).toBe("succeeded");
    const row = await settingsRow();
    expect(row).toMatchObject({ lastPanelBackupStatus: "succeeded", lastPanelBackupProblem: null });
    expect(row.lastPanelBackupAt).toBeInstanceOf(Date);
    const audits = await panelAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "panel.backups.succeeded",
      actorType: "system",
      organizationId: null,
      targetType: "backups",
      details: { operationId: opId, problem: null },
    });
    const steps = await dbClient.db.select().from(operationSteps).where(eq(operationSteps.operationId, opId));
    expect(steps.map((s) => [s.key, s.status])).toEqual([
      ["dump", "succeeded"],
      ["upload", "succeeded"],
    ]);

    // The dump: product's fixed arguments, password only in the child's environment.
    expect(dumps).toHaveLength(1);
    expect(dumps[0]!.args).toEqual([
      "--format=custom",
      "--compress=none",
      "--no-password",
      "--file",
      join(dumpDir, `${opId}.dump`),
    ]);
    expect(dumps[0]!.env.PGPASSWORD).toBe(DB_PW);
    expect(JSON.stringify(dumps[0]!.args)).not.toContain(DB_PW);

    const starts = calls.filter((c) => c.action === "panelStart");
    expect(starts).toEqual([
      expect.objectContaining({ jobId: opId, masterKey: KEY_HEX, retentionDays: 21 }),
    ]);
    expect(fileSeenAtStart).toEqual([true]);
    expect(await dumpFiles()).toEqual([]);

    const dto = await app.nestApp.get(BackupSettingsService).get();
    expect(dto.lastPanelBackup).toEqual({ at: row.lastPanelBackupAt!.toISOString(), status: "succeeded", problem: null });
    await expectNoSecrets();
  });

  const dumpFailures: [string, () => Promise<void>, string][] = [
    ["absent tool", () => Promise.reject(new PanelDumpError("tool_missing")), "panel_dump_tool_missing"],
    ["pg_dump fails", () => Promise.reject(new PanelDumpError("exit", 1)), "panel_dump_failed"],
  ];
  for (const [name, dump, problem] of dumpFailures) {
    it(`Outcome: ${name} fails with ${problem}, never calls panelStart, removes the file`, async () => {
      applier.panel.dump = async (cmd) => {
        await writeFile(cmd.args[cmd.args.length - 1]!, "partial");
        await dump();
      };
      const opId = await queuePanel();
      await app.outboxWorker.processPendingOnce();

      const [op] = await panelOps();
      expect(op!.status).toBe("failed");
      expect(await settingsRow()).toMatchObject({ lastPanelBackupStatus: "failed", lastPanelBackupProblem: problem });
      const audits = await panelAudits();
      expect(audits.map((a) => [a.action, a.organizationId, (a.details as { problem: string }).problem])).toEqual([
        ["panel.backups.failed", null, problem],
      ]);
      const steps = await dbClient.db.select().from(operationSteps).where(eq(operationSteps.operationId, opId));
      expect(steps.map((s) => [s.key, s.status])).toEqual([
        ["dump", "failed"],
        ["upload", "skipped"],
      ]);
      expect(calls.filter((c) => c.action === "panelStart")).toEqual([]);
      expect(await dumpFiles()).toEqual([]);
      expect(logs.join("\n")).toContain('"event":"panel_dump_failed"');
      await expectNoSecrets();
    });
  }

  it("Outcome: an executor failure class is stored as the problem; the file is removed", async () => {
    sim.backupState.failNext("panel_dump_missing");
    const opId = await queuePanel();
    await app.outboxWorker.processPendingOnce();

    const [op] = await panelOps();
    expect(op!.status).toBe("failed");
    expect(await settingsRow()).toMatchObject({ lastPanelBackupStatus: "failed", lastPanelBackupProblem: "panel_dump_missing" });
    expect((await panelAudits()).map((a) => a.action)).toEqual(["panel.backups.failed"]);
    const steps = await dbClient.db.select().from(operationSteps).where(eq(operationSteps.operationId, opId));
    expect(steps.map((s) => [s.key, s.status])).toEqual([
      ["dump", "succeeded"],
      ["upload", "failed"],
    ]);
    expect(await dumpFiles()).toEqual([]);
    await expectNoSecrets();
  });

  /** Runs the copy until the poll gives up, leaving the operation unknown and the job held. */
  async function runUntilAmbiguous(): Promise<string> {
    sim.backupState.holdJobs();
    const opId = await queuePanel();
    const original = sim.backups;
    sim.backups = (async (req: BackupsIpcRequest) => {
      if (req.action === "status") throw new Error("executor unreachable");
      return original(req);
    }) as typeof sim.backups;
    try {
      await app.outboxWorker.processPendingOnce();
    } finally {
      sim.backups = original;
    }
    const [op] = await panelOps();
    expect(op!.status).toBe("unknown");
    // The job may still read the file.
    expect(await dumpFiles()).toEqual([`${opId}.dump`]);
    return opId;
  }

  it("Recovery: a running job stays pending, then settles succeeded without a second panelStart", async () => {
    const opId = await runUntilAmbiguous();
    await app.outboxWorker.recoverUnknownOperations();
    expect((await panelOps())[0]!.status).toBe("unknown");
    expect(await dumpFiles()).toEqual([`${opId}.dump`]);

    sim.backupState.finishHeld();
    await app.outboxWorker.recoverUnknownOperations();
    expect((await panelOps())[0]!.status).toBe("succeeded");
    expect(sim.backupState.panelJobIds().filter((id) => id === opId)).toHaveLength(1);
    expect(calls.filter((c) => c.action === "panelStart")).toHaveLength(1);
    expect((await settingsRow()).lastPanelBackupStatus).toBe("succeeded");
    expect((await panelAudits()).map((a) => a.action)).toEqual(["panel.backups.succeeded"]);
    expect(await dumpFiles()).toEqual([]);
    await expectNoSecrets();
  });

  it("Recovery: a job the executor no longer knows fails with interrupted", async () => {
    await runUntilAmbiguous();
    sim.backupState.simulateRestart();
    await app.outboxWorker.recoverUnknownOperations();
    const [op] = await panelOps();
    expect(op!.status).toBe("failed");
    expect(await settingsRow()).toMatchObject({ lastPanelBackupStatus: "failed", lastPanelBackupProblem: "interrupted" });
    expect((await panelAudits()).map((a) => a.action)).toEqual(["panel.backups.failed"]);
    expect(calls.filter((c) => c.action === "panelStart")).toHaveLength(1);
    expect(await dumpFiles()).toEqual([]);
    await expectNoSecrets();
  });

  it("Deadline (R120): a copy the executor keeps running ends the poll as ambiguous and records nothing", async () => {
    sim.backupState.holdJobs();
    applier.pollDeadlineMs = 1;
    const opId = await queuePanel();
    await app.outboxWorker.processPendingOnce();
    expect((await panelOps())[0]!.status).toBe("unknown");
    expect(await panelAudits()).toEqual([]);
    expect((await settingsRow()).lastPanelBackupStatus).toBeNull();
    expect(await dumpFiles()).toEqual([`${opId}.dump`]);
    sim.backupState.holdJobs(false);
    sim.backupState.finishHeld();
  });

  it("Recovery (R120): a copy still running past the deadline fails with timeout once, and the next night is queued again", async () => {
    const opId = await runUntilAmbiguous();
    const recoverSpy = vi.spyOn(applier, "recover");
    await app.outboxWorker.recoverUnknownOperations();
    expect(await recoverSpy.mock.results[0]!.value).toBe("pending");
    expect((await panelOps())[0]!.status).toBe("unknown");
    const nextNight = new Date(NIGHT.getTime() + 86_400_000);
    await scheduler.tick(nextNight);
    expect(await panelOps()).toHaveLength(1);

    const old = new Date(Date.now() - BACKUP_POLL_DEADLINE_MS - 60_000);
    await dbClient.db.update(operations).set({ startedAt: old, submittedAt: old }).where(eq(operations.id, opId));
    const before = calls.length;
    await app.outboxWorker.recoverUnknownOperations();
    await app.outboxWorker.recoverUnknownOperations();
    expect(await recoverSpy.mock.results[1]!.value).toBe("settled");
    expect((await panelOps())[0]!.status).toBe("failed");
    expect(await settingsRow()).toMatchObject({ lastPanelBackupStatus: "failed", lastPanelBackupProblem: "timeout" });
    expect((await panelAudits()).map((a) => a.action)).toEqual(["panel.backups.failed"]);
    expect(calls.slice(before).every((c) => c.action === "status")).toBe(true);
    expect(await dumpFiles()).toEqual([]);

    sim.backupState.holdJobs(false);
    sim.backupState.finishHeld();
    await scheduler.tick(nextNight);
    expect((await panelOps()).filter((o) => o.id !== opId)).toHaveLength(1);
    await expectNoSecrets();
  });

  it("Dump file: the start sweep keeps an active operation's file and removes a finished one's", async () => {
    const activeId = await queuePanel();
    const doneId = `op_${"e".repeat(32)}`;
    const goneId = `op_${"f".repeat(32)}`;
    await dbClient.db.insert(operations).values({
      id: doneId,
      organizationId: PLATFORM_OPS_ORG_ID,
      kind: "panel.backups.create",
      resourceType: "host",
      resourceId: "panel",
      status: "succeeded",
    });
    for (const id of [activeId, doneId, goneId]) {
      await writeFile(join(dumpDir, `${id}.dump`), "x");
    }
    await writeFile(join(dumpDir, "other.txt"), "x");
    await applier.panel.sweepStaleDumps();
    expect((await dumpFiles()).sort()).toEqual([`${activeId}.dump`, "other.txt"].sort());
  });

  it("Figures: the settings answer sums each site's newest succeeded copy", async () => {
    const [host] = await dbClient.db.select().from(hosts).limit(1);
    const [inst] = await dbClient.db.select().from(platformInstallations).limit(1);
    const orgId = `org_${randomUUID()}`;
    const allocId = `alloc_${randomUUID()}`;
    await dbClient.db.insert(organizations).values({
      id: orgId,
      platformInstallationId: inst!.id,
      name: "Figures",
      slug: `figures-${randomUUID().slice(0, 8)}`,
    });
    await dbClient.db.insert(hostAllocations).values({ id: allocId, hostId: host!.id, organizationId: orgId, status: "active" });
    const made: string[] = [];
    try {
      for (const slug of ["fig-a", "fig-b"]) {
        const { site } = await createSiteTransactional(dbClient.db, {
          organizationId: orgId,
          hostAllocationId: allocId,
          name: slug,
          slug,
          phpVersion: "8.4",
          siteType: "wordpress",
        });
        made.push(site.id);
      }
      const copy = async (siteId: string, at: string, size: number) => {
        const opId = `op_${randomUUID().replace(/-/g, "")}`;
        await insertSiteBackup(dbClient.db, { siteId, kind: "manual", status: "running", operationId: opId, startedAt: new Date(at) });
        await settleSiteBackup(dbClient.db, opId, { status: "succeeded", snapshotId: "a".repeat(64), sizeBytes: size });
      };
      await copy(made[0]!, "2026-11-13T02:00:00Z", 10);
      await copy(made[0]!, "2026-11-14T02:00:00Z", 1000);
      await copy(made[1]!, "2026-11-14T02:00:00Z", 234);
      const dto = await app.nestApp.get(BackupSettingsService).get();
      expect(dto.newestBackupsTotalBytes).toBe(1234);
      const rows = await listAdminBackupStatus(dbClient.db);
      expect(rows.find((r) => r.siteId === made[0])?.lastSuccessSizeBytes).toBe(1000);
    } finally {
      for (const id of made) await dbClient.db.delete(sites).where(eq(sites.id, id));
    }
  });
});
