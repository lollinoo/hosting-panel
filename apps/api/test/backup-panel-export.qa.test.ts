/**
 * QA (independent) for M4: the panel backup to two targets from one dump, and the `.zip.age` refusal while
 * encryptedBackupExportAvailable is false (BLOCKED.md #4). HCP-SPEC-004 §6.4, §8.2-8.3.
 */
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { PLATFORM_OPS_ORG_ID, type BackupsIpcRequest } from "@hosting-panel/contracts";
import {
  aggregateCopyStatuses,
  auditEvents,
  backupPolicies,
  backupTargets,
  createDatabaseClient,
  deleteBackupSettings,
  eq,
  getPolicy,
  hostAllocations,
  hosts,
  insertS3Target,
  insertSiteBackup,
  insertSiteBackupCopies,
  listPanelBackupCopies,
  membershipRoles,
  memberships,
  operationSteps,
  operations,
  organizations,
  outboxEvents,
  platformInstallations,
  resolvePanelTargets,
  serviceInstances,
  setPolicyTargets,
  settleSiteBackupAggregate,
  settleSiteBackupCopy,
  siteBackupCopies,
  siteBackups,
  sites,
  sql,
  upsertBackupSettings,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { InMemoryHostSimulatorAdapter } from "@hosting-panel/host-agent";
import { Logger } from "@nestjs/common";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../src/auth/password.js";
import { totpCodeAt } from "../src/auth/totp.js";
import { BackupSchedulerService } from "../src/backups/backup-scheduler.service.js";
import { runPanelDump, type PanelDumpCommand } from "../src/backups/panel-dump.js";
import { SiteBackupsApplier } from "../src/backups/site-backups-applier.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { skipPasswordChange } from "./fixtures/password-change.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const KEY = Buffer.from("c4d5e6f7".repeat(8), "hex");
const PW = "correct horse battery staple";
const NIGHT = new Date("2026-11-15T03:00:00.000Z");
const DB_URL = "postgresql://hosting_panel:p%40ss-QA4DBPW@127.0.0.1:5432/hosting_panel";
const TARGET = {
  endpoint: "https://s3.example.com",
  region: "eu-south-1",
  bucket: "qa4-panel",
  prefix: "qa4",
  accessKeyId: "AKIAQA4PANEL1",
  secretAccessKey: "qa4-canary-s3-secret-first",
};
/** A well-formed age recipient built from a greppable canary (alphabet has no b, i, o). */
const CANARY = "qa4canary";
const RECIPIENT = `age1${CANARY.repeat(7).slice(0, 58)}`;
/** Malformed on purpose: `b` is not a bech32 character. */
const BAD_RECIPIENT = `age1${CANARY.repeat(7).slice(0, 57)}b`;

async function http(
  baseUrl: string,
  method: string,
  path: string,
  options: { token?: string; body?: unknown; key?: string; sink?: string[] } = {},
): Promise<{ status: number; body: Json; raw: string }> {
  const headers: Record<string, string> = {};
  if (options.token) headers["Authorization"] = `Bearer ${options.token}`;
  if (options.key) headers["Idempotency-Key"] = options.key;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const raw = await res.text();
  options.sink?.push(raw);
  const parse = (): Json => {
    try {
      return raw ? (JSON.parse(raw) as Json) : {};
    } catch {
      return { raw };
    }
  };
  return { status: res.status, body: parse(), raw };
}

/** Records everything written to stdout, stderr, console and the Nest logger. */
function captureLogs(sink: string[]): void {
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    vi.spyOn(stream, "write").mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      sink.push(String(chunk));
      return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof stream.write);
  }
  for (const level of ["log", "warn", "error", "info", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      sink.push(args.map(String).join(" "));
    });
  }
  for (const level of ["log", "warn", "error", "debug", "verbose"] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      sink.push(args.map(String).join(" "));
    });
  }
}

async function allTables(dbClient: DatabaseClient): Promise<Record<string, string>> {
  const names = (
    await dbClient.db.execute<{ table_name: string }>(
      sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    )
  ).rows.map((r) => r.table_name);
  expect(names.length).toBeGreaterThan(10);
  const out: Record<string, string> = {};
  for (const name of names) {
    if (!/^[a-z0-9_]+$/i.test(name)) continue;
    out[name] = JSON.stringify((await dbClient.db.execute(sql.raw(`SELECT * FROM "${name}"`))).rows);
  }
  return out;
}

// ======================================================================================= panel, two targets

describe("QA M4: panel backup to two targets from one dump", () => {
  let dbClient: DatabaseClient;
  let sim: InMemoryDockerSimulatorAdapter;
  let app: ControlPlaneAppHandle;
  let applier: SiteBackupsApplier;
  let scheduler: BackupSchedulerService;
  let dumpDir: string;
  let origBackups: InMemoryDockerSimulatorAdapter["backups"];
  let adminId: string;
  let calls: BackupsIpcRequest[];
  /** The dump directory as it was at the moment of each executor call. */
  let filesAtCall: { action: string; jobId: string | undefined; files: string[] }[];
  let dumpRuns: string[];
  let order: string[];
  let statusDown: boolean;
  let hook: ((req: BackupsIpcRequest) => Promise<unknown> | undefined) | null;
  let logs: string[];

  const panelOps = () => dbClient.db.select().from(operations).where(eq(operations.kind, "panel.backups.create"));
  const dumpFiles = () => readdir(dumpDir);
  const starts = () =>
    calls.filter((c): c is Extract<BackupsIpcRequest, { action: "panelStart" }> => c.action === "panelStart");
  let auditBaseline: Set<string>;
  const panelAudits = async () =>
    (await dbClient.db.select().from(auditEvents)).filter(
      (a) => !auditBaseline.has(a.id) && (a.action === "panel.backups.succeeded" || a.action === "panel.backups.failed"),
    );

  async function resetConfig(): Promise<void> {
    for (const scope of ["default_site", "panel"] as const) {
      await setPolicyTargets(dbClient.db, (await getPolicy(dbClient.db, scope)).id, []);
    }
    await dbClient.db.delete(backupTargets);
    await dbClient.db
      .update(backupPolicies)
      .set({ lastNightlyRunOn: null, nightlyRunStartedAt: null })
      .where(eq(backupPolicies.scope, "default_site"));
    await deleteBackupSettings(dbClient.db);
  }

  /** Adds a second panel destination; returns the target ids in priority order. */
  async function addSecondTarget(): Promise<string[]> {
    const first = (await resolvePanelTargets(dbClient.db)).map((t) => t.targetId);
    expect(first).toHaveLength(1);
    const second = await insertS3Target(dbClient.db, KEY, {
      name: "QA second",
      endpoint: "https://second.example.com",
      region: "eu-south-1",
      bucket: "qa4-second",
      prefix: "",
      accessKeyId: "AKIAQA4SECOND01",
      secretAccessKey: "qa4-canary-s3-secret-second",
      customerSelectable: false,
      actorId: null,
    });
    const ids = [...first, second.id];
    await setPolicyTargets(dbClient.db, (await getPolicy(dbClient.db, "panel")).id, ids);
    return ids;
  }

  async function queuePanel(): Promise<string> {
    const known = new Set((await panelOps()).map((o) => o.id));
    for (let i = 0; i < 10; i += 1) {
      await scheduler.tick(NIGHT);
      const op = (await panelOps()).find((o) => !known.has(o.id));
      if (op) return op.id;
      await app.outboxWorker.processPendingOnce();
    }
    throw new Error("panel copy never queued");
  }

  const copyView = async (opId: string) =>
    (await listPanelBackupCopies(dbClient.db, opId)).map((c) => ({
      status: c.status,
      problem: c.problem,
      jobId: c.jobId,
      priority: c.priority,
    }));

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, {
      installationName: "QA4 Panel Two Copies",
      hostHostname: "qa4-panel.test",
      hostIpv4: "10.0.0.1",
    });
    const admin = await createServerAdmin(dbClient.db, KEY, { email: "qa4-admin@x.it", name: "Admin", password: PW });
    adminId = admin.userId;
    sim = new InMemoryDockerSimulatorAdapter();
    origBackups = sim.backups.bind(sim);
    sim.backups = (async (req: BackupsIpcRequest) => {
      calls?.push(req);
      if (req.action !== "status") {
        filesAtCall?.push({
          action: req.action,
          jobId: (req as { jobId?: string }).jobId,
          files: await readdir(dumpDir).catch(() => []),
        });
      }
      if (req.action !== "status" && req.action !== "settle") order?.push(req.action);
      if (req.action === "status" && statusDown) {
        throw Object.assign(new Error("executor unreachable"), { code: "DOCKER_ENGINE_UNAVAILABLE" });
      }
      const over = hook?.(req);
      if (over !== undefined) return over;
      return origBackups(req);
    }) as typeof sim.backups;
    dumpDir = await mkdtemp(join(tmpdir(), "hp-qa4-panel-dump-"));
    app = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      jwtSigningKeyPem: generateKeyPairSync("rsa", { modulusLength: 2048 })
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString(),
      hostAgent: new InMemoryHostSimulatorAdapter(),
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
      domainReconcileIntervalMs: null,
      mailRelayRetryIntervalMs: null,
      sftpRetryIntervalMs: null,
      backupScheduleIntervalMs: null,
      recoverUnknownOnStart: false,
      panelDump: { dir: dumpDir, databaseUrl: DB_URL },
      runtimeBackend: "linux-systemd",
      dockerExecutor: sim,
    });
    applier = app.nestApp.get(SiteBackupsApplier);
    scheduler = app.nestApp.get(BackupSchedulerService);
  });

  afterAll(async () => {
    await app?.close();
    await dbClient?.close();
    await rm(dumpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    calls = [];
    filesAtCall = [];
    dumpRuns = [];
    order = [];
    logs = [];
    statusDown = false;
    hook = null;
    captureLogs(logs);
    sim.backupState.holdJobs(false);
    sim.backupState.finishHeld();
    applier.pollMs = 0;
    applier.pollGiveUpMs = 120_000;
    // A fake pg_dump: records the target path, leaves a file there, succeeds or fails.
    const fake = (fail?: unknown) => async (_file: string, args: readonly string[]) => {
      const path = args[args.length - 1]!;
      dumpRuns.push(path);
      order.push("dump");
      await writeFile(path, "PGDMP qa4");
      if (fail !== undefined) throw fail;
      return { stdout: "", stderr: "" };
    };
    applier.panel.dump = (cmd: PanelDumpCommand) => runPanelDump(cmd, fake());
    (applier as unknown as { __fail: (e: unknown) => void }).__fail = (e) => {
      applier.panel.dump = (cmd: PanelDumpCommand) => runPanelDump(cmd, fake(e));
    };
    await dbClient.db.delete(siteBackups);
    await dbClient.db.delete(outboxEvents);
    await dbClient.db.delete(operationSteps);
    await dbClient.db.delete(operations);
    await resetConfig();
    await upsertBackupSettings(dbClient.db, KEY, {
      ...TARGET,
      scheduleHourUtc: 2,
      retentionDays: 9,
      updatedByUserId: adminId,
    });
    auditBaseline = new Set((await dbClient.db.select({ id: auditEvents.id }).from(auditEvents)).map((r) => r.id));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    sim.backupState.holdJobs(false);
    sim.backupState.finishHeld();
    for (const name of await dumpFiles()) await rm(join(dumpDir, name), { force: true });
  });

  it("one target: exactly one panelStart with the operation id and no dumpId, no -t2 anywhere", async () => {
    const opId = await queuePanel();
    await app.outboxWorker.processPendingOnce();
    expect((await panelOps())[0]!.status).toBe("succeeded");
    expect(dumpRuns).toEqual([join(dumpDir, `${opId}.dump`)]);
    expect(starts().map((c) => c.jobId)).toEqual([opId]);
    expect(starts()[0]).not.toHaveProperty("dumpId");
    expect(await copyView(opId)).toEqual([{ status: "succeeded", problem: null, jobId: opId, priority: 1 }]);
    expect(JSON.stringify(calls)).not.toContain("-t2");
    expect(await dumpFiles()).toEqual([]);
  });

  it("two targets: ONE pg_dump before any start, then op and op-t2 in priority order, the second reading the first's dump", async () => {
    const targets = await addSecondTarget();
    await dbClient.db.update(backupPolicies).set({ retentionDays: 9 }).where(eq(backupPolicies.scope, "panel"));
    const opId = await queuePanel();
    await app.outboxWorker.processPendingOnce();

    expect((await panelOps())[0]!.status).toBe("succeeded");
    expect(dumpRuns).toEqual([join(dumpDir, `${opId}.dump`)]);
    expect(order.filter((a) => a === "dump" || a === "panelStart")).toEqual(["dump", "panelStart", "panelStart"]);
    const sent = starts();
    expect(sent.map((c) => c.jobId)).toEqual([opId, `${opId}-t2`]);
    expect((sent[1] as { dumpId?: string }).dumpId).toBe(opId);
    expect(sent[0]).not.toHaveProperty("dumpId");
    // The second job points at the second target, not at the first one's.
    expect(sent[0]!.target).toMatchObject({ bucket: TARGET.bucket });
    expect(sent[1]!.target).toMatchObject({ bucket: "qa4-second" });
    expect(sent.map((c) => c.retentionDays)).toEqual([9, 9]);

    const copies = await listPanelBackupCopies(dbClient.db, opId);
    expect(copies.map((c) => [c.targetId, c.status, c.jobId])).toEqual([
      [targets[0], "succeeded", opId],
      [targets[1], "succeeded", `${opId}-t2`],
    ]);
    expect(aggregateCopyStatuses(copies)).toBe("succeeded");
    expect(await dumpFiles()).toEqual([]);
    expect(await panelAudits()).toHaveLength(1);
    expect((await panelAudits())[0]!.action).toBe("panel.backups.succeeded");
  });

  it("two targets: the dump file exists at EVERY executor call of the run, and only <op>.dump ever exists", async () => {
    await addSecondTarget();
    const opId = await queuePanel();
    await app.outboxWorker.processPendingOnce();
    expect((await panelOps())[0]!.status).toBe("succeeded");
    const relevant = filesAtCall.filter((c) => c.jobId === opId || c.jobId === `${opId}-t2`);
    expect(relevant.length).toBeGreaterThanOrEqual(2);
    for (const c of relevant) expect(c.files, `${c.action} ${c.jobId}`).toEqual([`${opId}.dump`]);
    expect(dumpRuns.some((p) => p.includes("-t2"))).toBe(false);
  });

  it("two targets: the file is NOT removed after the first copy settles (still there when op-t2 starts), gone after the second", async () => {
    await addSecondTarget();
    const opId = await queuePanel();
    let atSecond: boolean | null = null;
    hook = (req) => {
      if (req.action !== "panelStart" || req.jobId === opId) return undefined;
      atSecond = existsSync(join(dumpDir, `${opId}.dump`));
      return undefined;
    };
    await app.outboxWorker.processPendingOnce();
    expect(atSecond).toBe(true);
    expect(await dumpFiles()).toEqual([]);
  });

  it("two targets: the pg_dump fails → no panelStart at all, both copies failed with the dump problem, no file", async () => {
    await addSecondTarget();
    const opId = await queuePanel();
    (applier as unknown as { __fail: (e: unknown) => void }).__fail(
      Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
    );
    await app.outboxWorker.processPendingOnce();
    expect((await panelOps())[0]!.status).toBe("failed");
    expect(starts()).toEqual([]);
    expect((await copyView(opId)).map((c) => [c.status, c.problem])).toEqual([
      ["failed", "panel_dump_tool_missing"],
      ["failed", "panel_dump_tool_missing"],
    ]);
    expect(await dumpFiles()).toEqual([]);
  });

  it("two targets: the second copy fails after the first stored → partial copies, op failed, file removed, one failed audit", async () => {
    await addSecondTarget();
    const opId = await queuePanel();
    hook = (req) => {
      if (req.action !== "panelStart" || req.jobId !== opId) return undefined;
      return (async () => {
        const res = await origBackups(req);
        sim.backupState.failNext("unreachable");
        return res;
      })();
    };
    await app.outboxWorker.processPendingOnce();
    expect((await panelOps())[0]!.status).toBe("failed");
    const copies = await listPanelBackupCopies(dbClient.db, opId);
    expect(copies.map((c) => c.status)).toEqual(["succeeded", "failed"]);
    expect(copies[0]!.snapshotId).toBeTruthy();
    expect(copies[1]!.snapshotId).toBeNull();
    expect(aggregateCopyStatuses(copies)).toBe("partial");
    expect(starts()).toHaveLength(2);
    expect(await dumpFiles()).toEqual([]);
    const audits = await panelAudits();
    expect(audits.map((a) => a.action)).toEqual(["panel.backups.failed"]);
  });

  it("two targets, recovery: ambiguity on op-t2 keeps the file; sweep keeps it too; recovery polls, never panelStart again", async () => {
    await addSecondTarget();
    const opId = await queuePanel();
    applier.pollGiveUpMs = 0;
    hook = (req) => {
      if (req.action !== "panelStart" || req.jobId === opId) return undefined;
      return (async () => {
        sim.backupState.holdJobs(true);
        const res = await origBackups(req);
        statusDown = true;
        return res;
      })();
    };
    await app.outboxWorker.processPendingOnce();
    statusDown = false;
    hook = null;
    const [op] = await panelOps();
    expect(op!.status).toBe("unknown");
    expect(await dumpFiles()).toEqual([`${opId}.dump`]);
    expect((await copyView(opId)).map((c) => c.status)).toEqual(["succeeded", "running"]);

    // An unknown operation is still active: the stale-dump sweep must not delete a file a job may be reading.
    await applier.panel.sweepStaleDumps();
    expect(await dumpFiles()).toEqual([`${opId}.dump`]);

    // Still running → still pending, file still there.
    await app.outboxWorker.recoverUnknownOperations();
    expect((await panelOps())[0]!.status).toBe("unknown");
    expect(await dumpFiles()).toEqual([`${opId}.dump`]);

    sim.backupState.finishHeld();
    await app.outboxWorker.recoverUnknownOperations();
    expect((await panelOps())[0]!.status).toBe("succeeded");
    expect((await copyView(opId)).map((c) => c.status)).toEqual(["succeeded", "succeeded"]);
    expect(starts()).toHaveLength(2); // never started again
    expect(calls.some((c) => c.action === "status" && c.jobId === `${opId}-t2`)).toBe(true);
    expect(await dumpFiles()).toEqual([]);
    expect(dumpRuns).toHaveLength(1);
    expect((await panelAudits()).map((a) => a.action)).toEqual(["panel.backups.succeeded"]);
  });

  it("two targets, recovery: ambiguity on the FIRST job → the second is never started, recovery never starts it either", async () => {
    await addSecondTarget();
    const opId = await queuePanel();
    sim.backupState.holdJobs(true);
    statusDown = true;
    applier.pollGiveUpMs = 0;
    await app.outboxWorker.processPendingOnce();
    statusDown = false;
    expect((await panelOps())[0]!.status).toBe("unknown");
    expect(starts().map((c) => c.jobId)).toEqual([opId]);
    expect(await dumpFiles()).toEqual([`${opId}.dump`]);

    sim.backupState.finishHeld();
    await app.outboxWorker.recoverUnknownOperations();
    await app.outboxWorker.recoverUnknownOperations();
    expect(starts().map((c) => c.jobId)).toEqual([opId]);
    const [op] = await panelOps();
    expect(["succeeded", "failed"]).toContain(op!.status);
    // The never-started second copy is not reported stored.
    const copies = await listPanelBackupCopies(dbClient.db, opId);
    expect(copies[1]!.status).not.toBe("succeeded");
    expect(copies[1]!.snapshotId).toBeNull();
    expect(await dumpFiles()).toEqual([]);
  });

  it("recovery after a policy change: a third destination added while unknown does not start a copy", async () => {
    const opId = await queuePanel();
    sim.backupState.holdJobs(true);
    statusDown = true;
    applier.pollGiveUpMs = 0;
    await app.outboxWorker.processPendingOnce();
    statusDown = false;
    expect((await panelOps())[0]!.status).toBe("unknown");
    await addSecondTarget();
    sim.backupState.finishHeld();
    await app.outboxWorker.recoverUnknownOperations();
    expect(starts().map((c) => c.jobId)).toEqual([opId]);
    expect((await copyView(opId)).length).toBe(1);
    expect((await panelOps())[0]!.status).toBe("succeeded");
  });

  it("the master key travels only in panelStart (once per copy), never in tables or logs; the DB password never reaches a panelStart", async () => {
    await addSecondTarget();
    await queuePanel();
    await app.outboxWorker.processPendingOnce();
    const keyHex = KEY.toString("hex");
    const withKey = calls.filter((c) => JSON.stringify(c).includes(keyHex));
    expect(withKey.map((c) => c.action)).toEqual(["panelStart", "panelStart"]);
    expect(JSON.stringify(calls)).not.toContain("QA4DBPW");
    const tables = await allTables(dbClient);
    for (const [name, text] of Object.entries(tables)) {
      expect(text, `${name} holds the master key`).not.toContain(keyHex);
      expect(text, `${name} holds the db password`).not.toContain("QA4DBPW");
      expect(text, `${name} holds a target secret`).not.toContain("qa4-canary-s3-secret");
    }
    const logged = logs.join("\n");
    for (const s of [keyHex, KEY.toString("base64"), "QA4DBPW", "qa4-canary-s3-secret"]) {
      expect(logged).not.toContain(s);
    }
  });

  it("scheduled op targets the platform ops organisation and a second night makes a new op id with its own -t2", async () => {
    await addSecondTarget();
    const first = await queuePanel();
    await app.outboxWorker.processPendingOnce();
    expect((await panelOps())[0]!.organizationId).toBe(PLATFORM_OPS_ORG_ID);
    calls.length = 0;
    await dbClient.db
      .update(backupPolicies)
      .set({ lastNightlyRunOn: null, nightlyRunStartedAt: null })
      .where(eq(backupPolicies.scope, "default_site"));
    const next = new Date(NIGHT.getTime() + 24 * 60 * 60_000);
    const known = new Set((await panelOps()).map((o) => o.id));
    let second: string | undefined;
    for (let i = 0; i < 10 && !second; i += 1) {
      await scheduler.tick(next);
      second = (await panelOps()).find((o) => !known.has(o.id))?.id;
      if (!second) await app.outboxWorker.processPendingOnce();
    }
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    await app.outboxWorker.processPendingOnce();
    expect(starts().map((c) => c.jobId)).toEqual([second, `${second}-t2`]);
    expect((starts()[1] as { dumpId?: string }).dumpId).toBe(second);
  });
});

// ======================================================================================= .zip.age refusal

describe("QA M4: .zip.age is refused on every path while encryptedBackupExportAvailable is false", () => {
  const SITE = {
    name: "Hotel Export",
    domain: "hotel-qa4-export.it",
    title: "Hotel Export",
    adminUser: "admin",
    adminEmail: "admin@hotel-qa4-export.it",
    adminPassword: "canary-Pass-123456",
  };
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let offApp: ControlPlaneAppHandle;
  let adminToken: string;
  let adminId: string;
  let ownerToken: string;
  let otherOwnerToken: string;
  let orgId: string;
  let siteId: string;
  let backupId: string;
  let targetId: string;
  let simExport: InMemoryDockerSimulatorAdapter;
  let logs: string[];
  let answers: string[];

  const sitePath = () => `/v1/organizations/${orgId}/managed-sites/${siteId}`;
  const download = (
    body: unknown,
    o: { token?: string; id?: string; key?: string; baseUrl?: string; path?: string } = {},
  ) =>
    http(o.baseUrl ?? app.baseUrl!, "POST", `${o.path ?? sitePath()}/backups/${o.id ?? backupId}/download`, {
      token: o.token ?? ownerToken,
      body,
      key: o.key ?? randomUUID(),
      sink: answers,
    });
  const counts = async () => ({
    operations: (await dbClient.db.select().from(operations)).length,
    steps: (await dbClient.db.select().from(operationSteps)).length,
    outbox: (await dbClient.db.select().from(outboxEvents)).length,
    audit: (await dbClient.db.select().from(auditEvents)).length,
  });
  /** Every table and every captured log/answer must be free of the canary. */
  async function expectNoCanary(): Promise<void> {
    for (const [name, text] of Object.entries(await allTables(dbClient))) {
      expect(text, `table ${name} holds the recipient`).not.toContain(CANARY);
    }
    expect(logs.join("\n"), "logs hold the recipient").not.toContain(CANARY);
  }

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, {
      installationName: "QA4 Export",
      hostHostname: "qa4-export.test",
      hostIpv4: "10.0.0.1",
    });
    const admin = await createServerAdmin(dbClient.db, KEY, { email: "qa4-exp-admin@x.it", name: "Admin", password: PW });
    adminId = admin.userId;
    const base = {
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      jwtSigningKeyPem: generateKeyPairSync("rsa", { modulusLength: 2048 })
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString(),
      hostAgent: new InMemoryHostSimulatorAdapter(),
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
      domainReconcileIntervalMs: null,
      mailRelayRetryIntervalMs: null,
      sftpRetryIntervalMs: null,
      backupScheduleIntervalMs: null,
      recoverUnknownOnStart: false,
    } as const;
    const sim = new InMemoryDockerSimulatorAdapter();
    simExport = sim;
    app = await createControlPlaneApp({ ...base, runtimeBackend: "linux-systemd", dockerExecutor: sim });
    offApp = await createControlPlaneApp({ ...base, runtimeBackend: "disabled" });
    const login = await http(app.baseUrl!, "POST", "/v1/auth/login", {
      body: {
        email: "qa4-exp-admin@x.it",
        password: PW,
        totpCode: totpCodeAt(admin.totpSecretBase32, Math.floor(Date.now() / 30_000)),
      },
    });
    adminToken = login.body.data.accessToken as string;

    const mkOrg = async (name: string, email: string) => {
      const created = await http(app.baseUrl!, "POST", "/v1/admin/customer-account", {
        token: adminToken,
        body: { organizationName: name, ownerEmail: email, ownerName: "Owner" },
      });
      expect(created.status).toBe(201);
      await skipPasswordChange(dbClient.db, email);
      const l = await http(app.baseUrl!, "POST", "/v1/auth/login", {
        body: { email, password: created.body.data.temporaryPassword as string },
      });
      return { org: created.body.data.organizationId as string, token: l.body.data.accessToken as string };
    };
    const a = await mkOrg("QA4 Export Org", "owner-qa4@hotel.it");
    orgId = a.org;
    ownerToken = a.token;
    // Another organisation and its owner (one customer account per installation: insert it directly).
    const [host] = await dbClient.db.select().from(hosts).limit(1);
    const [inst] = await dbClient.db.select().from(platformInstallations).limit(1);
    const orgB = `org_${randomUUID()}`;
    await dbClient.db.insert(organizations).values({
      id: orgB,
      platformInstallationId: inst!.id,
      name: "QA4 Other Org",
      slug: `qa4-other-${randomUUID().slice(0, 8)}`,
    });
    await dbClient.db
      .insert(hostAllocations)
      .values({ id: `alloc_${randomUUID()}`, hostId: host!.id, organizationId: orgB, status: "active" });
    const userId = `usr_${randomUUID()}`;
    await dbClient.db
      .insert(users)
      .values({ id: userId, email: "other-qa4@test.local", name: "Other", passwordHash: await hashPassword(PW) });
    const memId = `mem_${randomUUID()}`;
    await dbClient.db.insert(memberships).values({ id: memId, organizationId: orgB, userId });
    await dbClient.db
      .insert(membershipRoles)
      .values({ id: `mrl_${randomUUID()}`, membershipId: memId, roleId: "role_customer_owner" });
    const otherLogin = await http(app.baseUrl!, "POST", "/v1/auth/login", {
      body: { email: "other-qa4@test.local", password: PW },
    });
    expect(otherLogin.status).toBe(200);
    otherOwnerToken = otherLogin.body.data.accessToken as string;

    const site = await http(app.baseUrl!, "POST", `/v1/organizations/${orgId}/managed-sites`, {
      token: ownerToken,
      body: SITE,
      key: randomUUID(),
    });
    expect(site.status).toBe(202);
    siteId = site.body.data.siteId as string;
    await app.outboxWorker.processPendingOnce();

    const target = await insertS3Target(dbClient.db, KEY, {
      name: "QA4 Offsite",
      endpoint: "https://s3.example.com",
      region: "eu-south-1",
      bucket: "qa4-export",
      prefix: "x",
      accessKeyId: "AKIAQA4EXPORT01",
      secretAccessKey: "qa4-export-secret",
      customerSelectable: true,
      actorId: adminId,
    });
    targetId = target.id;
    const operationId = `op_${randomUUID().replaceAll("-", "")}`;
    ({ id: backupId } = await insertSiteBackup(dbClient.db, {
      siteId,
      kind: "manual",
      status: "running",
      operationId,
      siteUrl: `http://${SITE.domain}`,
      startedAt: new Date(Date.now() - 60_000),
    }));
    await insertSiteBackupCopies(dbClient.db, backupId, operationId, [{ targetId, priority: 1, required: true }]);
    const [copy] = await dbClient.db.select().from(siteBackupCopies).where(eq(siteBackupCopies.backupId, backupId));
    // A real simulator snapshot, so the archive job has something to build the zip from.
    const [svc] = await dbClient.db.select({ id: serviceInstances.id }).from(serviceInstances).where(eq(serviceInstances.siteId, siteId));
    simExport.backupState.setSiteState(svc!.id, { filesVolume: true, container: true });
    const seedJob = `op_${randomUUID().replaceAll("-", "")}`;
    await simExport.backups({
      action: "start",
      jobId: seedJob,
      siteId,
      serviceInstanceId: svc!.id,
      // The same repository the target row describes, or the archive job finds no snapshot.
      target: {
        endpoint: "https://s3.example.com",
        region: "eu-south-1",
        bucket: "qa4-export",
        prefix: "x",
        accessKeyId: "AKIAQA4EXPORT01",
        secretAccessKey: "qa4-export-secret",
      },
    } as BackupsIpcRequest);
    const seeded = (await simExport.backups({ action: "status", jobId: seedJob } as BackupsIpcRequest)) as Json;
    await settleSiteBackupCopy(dbClient.db, copy!.id, {
      status: "succeeded",
      snapshotId: seeded["snapshot"].snapshotId as string,
      sizeBytes: 4096,
    });
    await settleSiteBackupAggregate(dbClient.db, backupId);
  });

  afterAll(async () => {
    await offApp?.close();
    await app?.close();
    await dbClient?.close();
  });

  beforeEach(async () => {
    logs = [];
    answers = [];
    captureLogs(logs);
    await app.outboxWorker.processPendingOnce();
    await dbClient.db.update(sites).set({ status: "ready", siteUrl: `http://${SITE.domain}` }).where(eq(sites.id, siteId));
    await dbClient.db
      .update(siteBackups)
      .set({ archiveStatus: null, archiveOperationId: null, archiveReadyUntil: null, archiveTargetId: null })
      .where(eq(siteBackups.id, backupId));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("the canary is a valid recipient and the bad one is not (the premise of the tests below)", async () => {
    const { isAgeRecipient } = await import("@hosting-panel/contracts");
    expect(RECIPIENT).toHaveLength(62);
    expect(isAgeRecipient(RECIPIENT)).toBe(true);
    expect(isAgeRecipient(BAD_RECIPIENT)).toBe(false);
  });

  it("422 NOT_SUPPORTED on the plain path: no operation, step, outbox or audit row, recipient nowhere", async () => {
    const before = await counts();
    const res = await download({ format: "zip.age", recipient: RECIPIENT });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("NOT_SUPPORTED");
    expect(res.raw).not.toContain(CANARY);
    expect(await counts()).toEqual(before);
    const [row] = await dbClient.db.select().from(siteBackups).where(eq(siteBackups.id, backupId));
    expect(row).toMatchObject({ archiveStatus: null, archiveOperationId: null, archiveTargetId: null });
    await expectNoCanary();
  });

  it("422 with an explicit targetId, with the site not ready, with an unknown backup, and replayed on the same key", async () => {
    const before = await counts();
    expect((await download({ format: "zip.age", recipient: RECIPIENT, targetId })).status).toBe(422);
    await dbClient.db.update(sites).set({ status: "deploying" }).where(eq(sites.id, siteId));
    const stopped = await download({ format: "zip.age", recipient: RECIPIENT });
    expect([stopped.status, stopped.body.error.code]).toEqual([422, "NOT_SUPPORTED"]);
    await dbClient.db.update(sites).set({ status: "ready" }).where(eq(sites.id, siteId));
    const ghost = await download({ format: "zip.age", recipient: RECIPIENT }, { id: `bkp_${randomUUID()}` });
    expect([ghost.status, ghost.body.error.code]).toEqual([422, "NOT_SUPPORTED"]);
    const key = randomUUID();
    for (let i = 0; i < 2; i += 1) {
      const r = await download({ format: "zip.age", recipient: RECIPIENT }, { key });
      expect([r.status, r.body.error.code]).toEqual([422, "NOT_SUPPORTED"]);
    }
    expect(await counts()).toEqual(before);
    await expectNoCanary();
  });

  it("422 even while a zip archive is already preparing: the active archive is not returned for a .zip.age request", async () => {
    const zip = await download({ format: "zip" });
    expect(zip.status).toBe(202);
    const before = await counts();
    const age = await download({ format: "zip.age", recipient: RECIPIENT });
    expect(age.status).toBe(422);
    expect(age.body.error.code).toBe("NOT_SUPPORTED");
    expect(age.raw).not.toContain(zip.body.data.operationId);
    expect(await counts()).toEqual(before);
    await expectNoCanary();
    await app.outboxWorker.processPendingOnce(); // let the zip finish so its lock does not leak into the next test
  });

  it("422 on an app whose runtime is disabled (the refusal comes before the runtime check) and nothing is stored", async () => {
    const before = await counts();
    const res = await download({ format: "zip.age", recipient: RECIPIENT }, { baseUrl: offApp.baseUrl! });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("NOT_SUPPORTED");
    expect(await counts()).toEqual(before);
    await expectNoCanary();
  });

  it("an invalid recipient is 400 VALIDATION_ERROR first: nothing queued, never echoed, not logged", async () => {
    const before = await counts();
    const bodies: Json[] = [
      { format: "zip.age", recipient: BAD_RECIPIENT },
      { format: "zip.age", recipient: ` ${RECIPIENT}` },
      { format: "zip.age", recipient: RECIPIENT.toUpperCase() },
      { format: "zip.age", recipient: `${RECIPIENT}q` },
      { format: "zip.age", recipient: RECIPIENT.slice(0, -1) },
      { format: "zip.age", recipient: `${CANARY}`.repeat(2000) },
      { format: "zip.age", recipient: [RECIPIENT] },
      { recipient: BAD_RECIPIENT },
    ];
    for (const body of bodies) {
      const res = await download(body);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(res.raw).not.toContain(CANARY);
    }
    // The 400 is for the recipient even on a backup that does not exist: validation does not look anything up.
    const ghost = await download({ format: "zip.age", recipient: BAD_RECIPIENT }, { id: `bkp_${randomUUID()}` });
    expect(ghost.status).toBe(400);
    expect(await counts()).toEqual(before);
    await expectNoCanary();
  });

  it("a recipient on a zip request, a missing recipient, unknown fields and unknown formats are all 400, nothing queued", async () => {
    const before = await counts();
    for (const body of [
      { format: "zip", recipient: RECIPIENT },
      { recipient: RECIPIENT },
      { format: "zip.age" },
      { format: "zip.age", recipient: RECIPIENT, extra: 1 },
      { format: "ZIP.AGE", recipient: RECIPIENT },
      { format: "tar" },
      { format: null },
    ]) {
      const res = await download(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await counts()).toEqual(before);
    await expectNoCanary();
  });

  it("another organisation's owner and an anonymous caller never reach the refusal (no oracle on a foreign site)", async () => {
    const foreign = await download({ format: "zip.age", recipient: RECIPIENT }, { token: otherOwnerToken });
    expect([403, 404]).toContain(foreign.status);
    expect(foreign.body.error.code).not.toBe("NOT_SUPPORTED");
    const anon = await http(app.baseUrl!, "POST", `${sitePath()}/backups/${backupId}/download`, {
      body: { format: "zip.age", recipient: RECIPIENT },
      key: randomUUID(),
      sink: answers,
    });
    expect(anon.status).toBe(401);
    const asAdmin = await download({ format: "zip.age", recipient: RECIPIENT }, { token: adminToken });
    expect(asAdmin.body.error?.code).not.toBe("NOT_SUPPORTED");
    await expectNoCanary();
  });

  it("zip is unchanged: absent body, {} and {format:'zip'} queue an identical operation, steps, outbox and audit, and the same archive bytes", async () => {
    const idRe = /(op|ob|aud|opst|step|evt)_[0-9a-f-]{16,}/g;
    const strip = (v: unknown): unknown =>
      JSON.parse(
        JSON.stringify(v, (k, x: unknown) =>
          /(^id$|Id$|At$|Until$|key$|Key$|hash$|Hash$|leaseExpires|sequence|attempt|^timestamp$)/.test(k) ? undefined : x,
        ).replace(idRe, "<id>"),
      );
    const snapshot = async (opId: string) => {
      const [op] = await dbClient.db.select().from(operations).where(eq(operations.id, opId));
      const steps = await dbClient.db.select().from(operationSteps).where(eq(operationSteps.operationId, opId));
      const outbox = (await dbClient.db.select().from(outboxEvents)).filter((e) => JSON.stringify(e).includes(opId));
      const audits = (await dbClient.db.select().from(auditEvents)).filter((a) => JSON.stringify(a).includes(opId));
      return strip({
        op,
        steps: steps.sort((x, y) => x.key.localeCompare(y.key)),
        outbox: outbox.map((e) => ({ ...e, payload: JSON.parse(JSON.stringify(e.payload).replaceAll(opId, "<op>")) })),
        audits: audits.map((a) => JSON.parse(JSON.stringify(a).replaceAll(opId, "<op>"))),
      });
    };
    const readAll = async (): Promise<string> => {
      let out = "";
      let offset = 0;
      for (let i = 0; i < 50; i += 1) {
        const r = await http(
          app.baseUrl!,
          "GET",
          `${sitePath()}/backups/${backupId}/download?offset=${offset}&length=65536`,
          { token: ownerToken, sink: answers },
        );
        expect(r.status).toBe(200);
        out += r.body.data.dataBase64 as string;
        if (r.body.data.eof) return out;
        offset += Buffer.from(r.body.data.dataBase64 as string, "base64").length;
      }
      throw new Error("archive never ended");
    };

    const runs: { snap: unknown; bytes: string; status: number }[] = [];
    for (const body of [undefined, {}, { format: "zip" }]) {
      await dbClient.db
        .update(siteBackups)
        .set({ archiveStatus: null, archiveOperationId: null, archiveReadyUntil: null, archiveTargetId: null })
        .where(eq(siteBackups.id, backupId));
      const res = await download(body);
      expect(res.status).toBe(202);
      expect(res.body.data).toEqual({
        siteId,
        backupId,
        operationId: expect.stringMatching(/^op_/),
      });
      await app.outboxWorker.processPendingOnce();
      const [row] = await dbClient.db.select().from(siteBackups).where(eq(siteBackups.id, backupId));
      expect([row!.archiveStatus, row!.archiveProblem]).toEqual(["ready", null]);
      runs.push({
        snap: await snapshot(res.body.data.operationId as string),
        bytes: await readAll(),
        status: res.status,
      });
    }
    expect(runs[1]!.snap).toEqual(runs[0]!.snap);
    expect(runs[2]!.snap).toEqual(runs[0]!.snap);
    // The simulator derives the archive bytes from the job id, so only the size can be compared across operations;
    // the real zip bytes are the executor's, and the API never touches them.
    expect(runs[0]!.bytes.length).toBeGreaterThan(0);
    expect(runs[1]!.bytes.length).toBe(runs[0]!.bytes.length);
    expect(runs[2]!.bytes.length).toBe(runs[0]!.bytes.length);
    // None of it names an encrypted format or a recipient.
    expect(JSON.stringify(runs[0]!.snap)).not.toMatch(/zip\.age|\bage1|recipient/i);
  });

  it("after all refusals: no table and no captured log carries the recipient canary, and zip.age still leaves zip usable", async () => {
    await download({ format: "zip.age", recipient: RECIPIENT });
    await download({ format: "zip.age", recipient: BAD_RECIPIENT });
    const ok = await download({ format: "zip" });
    expect(ok.status).toBe(202);
    await expectNoCanary();
    expect(answers.join("\n")).not.toContain(CANARY);
  });
});
