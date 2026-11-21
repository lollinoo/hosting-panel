import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { PLATFORM_OPS_ORG_ID, type BackupsIpcRequest } from "@hosting-panel/contracts";
import {
  asc,
  auditEvents,
  backupPolicies,
  backupSettings,
  backupTargets,
  createDatabaseClient,
  deleteBackupSettings,
  eq,
  getPolicy,
  hostAllocations,
  hosts,
  insertS3Target,
  insertSiteBackup,
  listPanelBackupCopies,
  membershipRoles,
  memberships,
  operationSteps,
  operations,
  organizations,
  outboxEvents,
  platformInstallations,
  serviceInstances,
  setPolicyTargets,
  siteBackups,
  sites,
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
import { BackupSettingsService } from "../src/backups/backup-settings.service.js";
import { PG_DUMP_PATH, runPanelDump, type PanelDumpCommand } from "../src/backups/panel-dump.js";
import { SiteBackupsApplier } from "../src/backups/site-backups-applier.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { skipPasswordChange } from "./fixtures/password-change.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// Sentinels: none of these may leave the places the design allows.
const KEY = Buffer.from("a1b2c3d4".repeat(8), "hex");
const KEY_HEX = KEY.toString("hex");
const KEY_B64 = KEY.toString("base64");
const DB_PW_MARK = "QADBPWSENTINEL77";
const DB_URL = `postgresql://hosting_panel:p%40ss-${DB_PW_MARK}@127.0.0.1:5432/hosting_panel`;
const ENV_CANARY = "qa-api-env-canary-NEVER-IN-CHILD-5521";
const EXEC_TEXT = "EXECUTOR-FREE-TEXT-SENTINEL-913";
const S3_SECRET = "canary-qa-panel-s3-secret-31";
const PW = "correct horse battery staple";
const NIGHT = new Date("2026-11-15T03:00:00.000Z");
const DAY_MS = 24 * 60 * 60_000;
const SETTINGS = {
  endpoint: "https://s3.example.com",
  region: "eu-south-1",
  bucket: "qa-panel-backups",
  prefix: "qa",
  accessKeyId: "AKIAQAPANEL1",
  secretAccessKey: S3_SECRET,
  scheduleHourUtc: 2,
  retentionDays: 14,
};
const TARGET = {
  endpoint: SETTINGS.endpoint,
  region: SETTINGS.region,
  bucket: SETTINGS.bucket,
  prefix: SETTINGS.prefix,
  accessKeyId: SETTINGS.accessKeyId,
  secretAccessKey: SETTINGS.secretAccessKey,
};
const ALLOWED_CHILD_ENV = [
  "LC_ALL",
  "PGCONNECT_TIMEOUT",
  "PGAPPNAME",
  "PGHOST",
  "PGPORT",
  "PGUSER",
  "PGPASSWORD",
  "PGDATABASE",
  "PGSSLMODE",
];
const CUSTOMER_FORBIDDEN = /\b(docker|container|image|network|volume|revision)\b/i;

describe("QA: nightly panel copy and the administrator's restore (M3c)", () => {
  let dbClient: DatabaseClient;
  let sim: InMemoryDockerSimulatorAdapter;
  let app: ControlPlaneAppHandle;
  let offApp: ControlPlaneAppHandle;
  let applier: SiteBackupsApplier;
  let scheduler: BackupSchedulerService;
  let dumpDir: string;
  let jwtSigningKeyPem: string;
  let origBackups: InMemoryDockerSimulatorAdapter["backups"];
  let adminId: string;
  let adminToken: string;
  let ownerAToken: string;
  let ownerAId: string;
  let ownerBToken: string;
  let memberToken: string;
  let orgA: string;
  let siteA: string;
  let siteB: string;
  let svcA: string;
  let svcB: string;

  // Per-test recorders and switches.
  let calls: BackupsIpcRequest[];
  let answers: string[];
  let logs: string[];
  let runs: { file: string; args: readonly string[]; env: Record<string, string> }[];
  let order: string[];
  let statusDown: boolean;
  let hook: ((req: BackupsIpcRequest) => Promise<unknown> | undefined) | null;
  let auditBaseline: Set<string>;
  const extraApps: ControlPlaneAppHandle[] = [];

  /** Sends one HTTP request and keeps the raw answer for the secret scan. */
  async function request(
    baseUrl: string,
    method: string,
    path: string,
    options: { token?: string; body?: unknown; rawBody?: string; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; body: Json }> {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.token) headers["Authorization"] = `Bearer ${options.token}`;
    if (options.body !== undefined || options.rawBody !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
    });
    const raw = await res.text();
    answers?.push(raw);
    let body: Json;
    try {
      body = raw ? (JSON.parse(raw) as Json) : {};
    } catch {
      body = { raw };
    }
    return { status: res.status, body };
  }

  /** Logs in and returns the bearer token. */
  async function login(email: string, password: string, totp?: string): Promise<string> {
    const res = await request(app.baseUrl!, "POST", "/v1/auth/login", {
      body: { email, password, ...(totp ? { totpCode: totpCodeAt(totp, Math.floor(Date.now() / 30_000)) } : {}) },
    });
    if (res.status !== 200) throw new Error(`login ${email}: ${res.status}`);
    return res.body.data.accessToken as string;
  }

  /** Creates a user with one membership and the given roles. */
  async function addMember(orgId: string, email: string, roles: string[], userId = `usr_${randomUUID()}`) {
    const exists = (await dbClient.db.select().from(users).where(eq(users.id, userId))).length > 0;
    if (!exists) {
      await dbClient.db.insert(users).values({ id: userId, email, name: email, passwordHash: await hashPassword(PW) });
    }
    const memId = `mem_${randomUUID()}`;
    await dbClient.db.insert(memberships).values({ id: memId, organizationId: orgId, userId });
    for (const roleId of roles) {
      await dbClient.db.insert(membershipRoles).values({ id: `mrl_${randomUUID()}`, membershipId: memId, roleId });
    }
    return userId;
  }

  /** Creates a managed site through the customer route and returns its ids. */
  async function createSite(name: string, domain: string): Promise<{ siteId: string; svcId: string }> {
    const before = sim.deployedSpecs.length;
    const res = await request(app.baseUrl!, "POST", `/v1/organizations/${orgA}/managed-sites`, {
      token: ownerAToken,
      body: { name, domain, title: name, adminUser: "admin", adminEmail: `admin@${domain}`, adminPassword: "canary-Pass-123456" },
      headers: { "Idempotency-Key": randomUUID() },
    });
    expect(res.status).toBe(202);
    await app.outboxWorker.processPendingOnce();
    expect(sim.deployedSpecs.length).toBeGreaterThan(before);
    const siteId = res.body.data.siteId as string;
    const [svc] = await dbClient.db
      .select({ id: serviceInstances.id })
      .from(serviceInstances)
      .where(eq(serviceInstances.siteId, siteId))
      .orderBy(asc(serviceInstances.createdAt), asc(serviceInstances.id));
    return { siteId, svcId: svc!.id };
  }

  /** Stores a succeeded copy of the site with a real simulator snapshot. */
  async function seedBackup(siteId: string, svcId: string, startedAt = new Date(), sizeBytes = 4096): Promise<string> {
    const jobId = `op_${randomUUID().replace(/-/g, "")}`;
    await origBackups({ action: "start", jobId, siteId, serviceInstanceId: svcId, target: TARGET } as BackupsIpcRequest);
    const status = (await origBackups({ action: "status", jobId } as BackupsIpcRequest)) as Json;
    const { id } = await insertSiteBackup(dbClient.db, { siteId, kind: "manual", status: "running", operationId: null, startedAt });
    await dbClient.db
      .update(siteBackups)
      .set({ status: "succeeded", snapshotId: status.snapshot.snapshotId as string, sizeBytes, finishedAt: startedAt })
      .where(eq(siteBackups.id, id));
    return id;
  }

  /**
   * Resets every backup setting: policies emptied and cursor cleared, all targets deleted (an archived legacy target is never
   * revived), then the settings row removed. The backup_settings trigger recreates the live legacy target on the next upsert.
   */
  async function resetBackupConfig(): Promise<void> {
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

  const panelOps = () => dbClient.db.select().from(operations).where(eq(operations.kind, "panel.backups.create"));
  const settingsRow = async () => (await dbClient.db.select().from(backupSettings))[0]!;
  const dumpFiles = () => readdir(dumpDir);
  const countCalls = (action: string) => calls.filter((c) => c.action === action).length;
  const newAudits = async () =>
    (await dbClient.db.select().from(auditEvents)).filter((a) => !auditBaseline.has(a.id));
  const restorePath = (id: string) => `/v1/admin/backups/sites/${id}/restore`;
  const adminRestore = (body: unknown, key: string | null = randomUUID(), id: string = siteA, token = adminToken) =>
    request(app.baseUrl!, "POST", restorePath(id), {
      token,
      body,
      headers: key === null ? {} : { "Idempotency-Key": key },
    });

  /** Ticks the night, running each queued site backup, until the panel copy is queued. */
  async function queuePanel(now: Date = NIGHT): Promise<string> {
    const known = new Set((await panelOps()).map((o) => o.id));
    for (let i = 0; i < 10; i += 1) {
      await scheduler.tick(now);
      const op = (await panelOps()).find((o) => !known.has(o.id));
      if (op) return op.id;
      await app.outboxWorker.processPendingOnce();
    }
    throw new Error("panel copy never queued");
  }

  /** Runs the panel copy with the job held and status unreachable, leaving the op unknown. */
  async function panelUntilAmbiguous(): Promise<string> {
    const opId = await queuePanel();
    sim.backupState.holdJobs(true);
    statusDown = true;
    applier.pollGiveUpMs = 0;
    await app.outboxWorker.processPendingOnce();
    statusDown = false;
    const [op] = await panelOps();
    expect(op!.status).toBe("unknown");
    return opId;
  }

  /** A fake execFile for runPanelDump: records the call, writes a partial file, then fails or succeeds. */
  function runner(fail?: unknown) {
    return async (file: string, args: readonly string[], options: object) => {
      runs.push({ file, args, env: { ...((options as { env: Record<string, string> }).env ?? {}) } });
      await writeFile(args[args.length - 1]!, "PGDMP partial");
      if (fail !== undefined) throw fail;
      return { stdout: "", stderr: "" };
    };
  }
  const useRunner = (fail?: unknown) => {
    applier.panel.dump = (cmd: PanelDumpCommand) => runPanelDump(cmd, runner(fail));
  };

  /** Every place a secret must never reach: tables, answers, logs. */
  async function haystack(): Promise<string> {
    const [ops, steps, outbox, audits, settings, backups] = await Promise.all([
      dbClient.db.select().from(operations),
      dbClient.db.select().from(operationSteps),
      dbClient.db.select().from(outboxEvents),
      dbClient.db.select().from(auditEvents),
      dbClient.db.select().from(backupSettings),
      dbClient.db.select().from(siteBackups),
    ]);
    await request(app.baseUrl!, "GET", "/v1/admin/backups", { token: adminToken });
    await request(app.baseUrl!, "GET", "/v1/admin/backups/sites", { token: adminToken });
    await request(app.baseUrl!, "GET", `/v1/organizations/${orgA}/operations`, { token: ownerAToken });
    const dto = await app.nestApp.get(BackupSettingsService).get();
    return [JSON.stringify({ ops, steps, outbox, audits, settings, backups, dto }), ...answers, ...logs].join("\n");
  }

  /** R113: neither the master key nor the DB password leaves its allowed place. */
  async function expectNoSecrets(expectedPanelStarts: number): Promise<void> {
    const text = await haystack();
    for (const secret of [KEY_HEX, KEY_B64, DB_PW_MARK, ENV_CANARY]) {
      expect(text).not.toContain(secret);
    }
    const withKey = calls.filter((c) => JSON.stringify(c).includes(KEY_HEX) || JSON.stringify(c).includes(KEY_B64));
    expect(withKey.map((c) => c.action)).toEqual(Array(expectedPanelStarts).fill("panelStart"));
    for (const run of runs) {
      expect(run.file).toBe(PG_DUMP_PATH);
      expect(JSON.stringify(run.args)).not.toContain(DB_PW_MARK);
      expect(Object.keys(run.env).every((k) => ALLOWED_CHILD_ENV.includes(k))).toBe(true);
      expect(JSON.stringify(run.env)).not.toContain(ENV_CANARY);
    }
  }

  beforeAll(async () => {
    process.env["HP_QA_ENV_CANARY"] = ENV_CANARY;
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, {
      installationName: "QA Panel Copy",
      hostHostname: "qa-panel.test",
      hostIpv4: "10.0.0.1",
    });
    const admin = await createServerAdmin(dbClient.db, KEY, { email: "qa-admin@x.it", name: "Admin", password: PW });
    adminId = admin.userId;
    sim = new InMemoryDockerSimulatorAdapter();
    origBackups = sim.backups.bind(sim);
    sim.backups = (async (req: BackupsIpcRequest) => {
      calls?.push(req);
      if (req.action !== "status" && req.action !== "settle") order?.push(req.action);
      if (req.action === "status" && statusDown) {
        throw Object.assign(new Error("executor unreachable"), { code: "DOCKER_ENGINE_UNAVAILABLE" });
      }
      const over = hook?.(req);
      if (over !== undefined) return over;
      return origBackups(req);
    }) as typeof sim.backups;
    jwtSigningKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    dumpDir = await mkdtemp(join(tmpdir(), "hp-qa-panel-dump-"));
    const base = {
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      jwtSigningKeyPem,
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
    } as const;
    app = await createControlPlaneApp({ ...base, runtimeBackend: "linux-systemd", dockerExecutor: sim });
    offApp = await createControlPlaneApp({ ...base, runtimeBackend: "disabled" });
    applier = app.nestApp.get(SiteBackupsApplier);
    scheduler = app.nestApp.get(BackupSchedulerService);
    adminToken = await login("qa-admin@x.it", PW, admin.totpSecretBase32);

    const created = await request(app.baseUrl!, "POST", "/v1/admin/customer-account", {
      token: adminToken,
      body: { organizationName: "QA Alpha Org", ownerEmail: "owner-a-qa@hotel.it", ownerName: "Anna" },
    });
    expect(created.status).toBe(201);
    orgA = created.body.data.organizationId as string;
    await skipPasswordChange(dbClient.db, "owner-a-qa@hotel.it");
    ownerAToken = await login("owner-a-qa@hotel.it", created.body.data.temporaryPassword as string);
    ownerAId = (await dbClient.db.select().from(users).where(eq(users.email, "owner-a-qa@hotel.it")))[0]!.id;
    ({ siteId: siteA, svcId: svcA } = await createSite("QA Alpha Site", "qa-alpha-site.it"));
    ({ siteId: siteB, svcId: svcB } = await createSite("QA Beta Site", "qa-beta-site.it"));

    // Another organisation and its owner.
    const [host] = await dbClient.db.select().from(hosts).limit(1);
    const [inst] = await dbClient.db.select().from(platformInstallations).limit(1);
    const orgB = `org_${randomUUID()}`;
    await dbClient.db.insert(organizations).values({
      id: orgB,
      platformInstallationId: inst!.id,
      name: "QA Beta Org",
      slug: `qa-beta-${randomUUID().slice(0, 8)}`,
    });
    await dbClient.db
      .insert(hostAllocations)
      .values({ id: `alloc_${randomUUID()}`, hostId: host!.id, organizationId: orgB, status: "active" });
    await addMember(orgB, "owner-b-qa@test.local", ["role_customer_owner"]);
    ownerBToken = await login("owner-b-qa@test.local", PW);
    // A member of the site's organisation with every site permission.
    await addMember(orgA, "member-a-qa@test.local", ["role_hosting_admin", "role_customer_owner"]);
    memberToken = await login("member-a-qa@test.local", PW);
    // The administrator is also a member of the customer organisation.
    await addMember(orgA, "qa-admin@x.it", ["role_customer_owner"], adminId);
  });

  afterAll(async () => {
    delete process.env["HP_QA_ENV_CANARY"];
    await offApp?.close();
    await app?.close();
    await dbClient?.close();
    await rm(dumpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    calls = [];
    answers = [];
    logs = [];
    runs = [];
    order = [];
    statusDown = false;
    hook = null;
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
    sim.backupState.finishHeld();
    sim.backupState.setSiteState(svcA, { filesVolume: true, container: true });
    sim.backupState.setSiteState(svcB, { filesVolume: true, container: true });
    sim.jobs.length = 0;
    sim.deployedSpecs.length = 0;
    sim.onJob = async (req) => {
      order.push(`job:${req.kind}`);
    };
    sim.onDeploy = async () => {
      order.push("deploy");
    };
    applier.pollMs = 0;
    applier.pollGiveUpMs = 120_000;
    useRunner();
    await dbClient.db.delete(siteBackups);
    await dbClient.db.delete(outboxEvents);
    await dbClient.db.delete(operationSteps);
    await dbClient.db.delete(operations);
    await dbClient.db.update(sites).set({ status: "ready" }).where(eq(sites.id, siteA));
    await dbClient.db.update(sites).set({ status: "ready" }).where(eq(sites.id, siteB));
    await resetBackupConfig();
    await upsertBackupSettings(dbClient.db, KEY, { ...SETTINGS, updatedByUserId: adminId });
    auditBaseline = new Set((await dbClient.db.select({ id: auditEvents.id }).from(auditEvents)).map((r) => r.id));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    sim.backupState.holdJobs(false);
    sim.backupState.finishHeld();
    for (const extra of extraApps.splice(0)) await extra.close();
    for (const name of await dumpFiles()) await rm(join(dumpDir, name), { force: true });
  });

  // ---------------------------------------------------------------- Secret (R113)

  it("Secret: a successful copy sends the key in exactly one panelStart and nowhere else", async () => {
    const opId = await queuePanel();
    await app.outboxWorker.processPendingOnce();
    expect((await panelOps())[0]!.status).toBe("succeeded");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.env["PGPASSWORD"]).toBe(`p@ss-${DB_PW_MARK}`);
    expect(runs[0]!.args.at(-1)).toBe(join(dumpDir, `${opId}.dump`));
    expect(await dumpFiles()).toEqual([]);
    await expectNoSecrets(1);
  });

  const dumpFailures: [string, () => unknown, string][] = [
    ["tool missing", () => Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }), "panel_dump_tool_missing"],
    [
      "tool failing with the password in its text",
      () =>
        Object.assign(new Error(`pg_dump: password authentication failed for p@ss-${DB_PW_MARK}`), {
          code: 1,
          stderr: `FATAL: password p@ss-${DB_PW_MARK} rejected ${ENV_CANARY}`,
        }),
      "panel_dump_failed",
    ],
    ["time limit", () => Object.assign(new Error("killed"), { killed: true, signal: "SIGKILL" }), "panel_dump_failed"],
    [
      "output limit",
      () => Object.assign(new Error("maxBuffer"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }),
      "panel_dump_failed",
    ],
  ];
  for (const [name, fail, problem] of dumpFailures) {
    it(`Secret + outcome: dump fails (${name}) → ${problem}, no panelStart, file gone, no secret anywhere`, async () => {
      useRunner(fail());
      await queuePanel();
      await app.outboxWorker.processPendingOnce();
      expect((await panelOps())[0]!.status).toBe("failed");
      expect(await settingsRow()).toMatchObject({ lastPanelBackupStatus: "failed", lastPanelBackupProblem: problem });
      expect(countCalls("panelStart")).toBe(0);
      expect(await dumpFiles()).toEqual([]);
      const dto = (await request(app.baseUrl!, "GET", "/v1/admin/backups", { token: adminToken })).body.data;
      expect(dto.lastPanelBackup).toMatchObject({ status: "failed", problem });
      await expectNoSecrets(0);
    });
  }

  for (const problem of ["panel_dump_missing", "wrong_key", "unreachable"] as const) {
    it(`Secret + outcome: the executor fails with ${problem}; the problem is stored and no secret leaks`, async () => {
      await queuePanel();
      sim.backupState.failNext(problem);
      await app.outboxWorker.processPendingOnce();
      expect((await panelOps())[0]!.status).toBe("failed");
      expect(await settingsRow()).toMatchObject({ lastPanelBackupStatus: "failed", lastPanelBackupProblem: problem });
      const dto = (await request(app.baseUrl!, "GET", "/v1/admin/backups", { token: adminToken })).body.data;
      expect(dto.lastPanelBackup).toMatchObject({ status: "failed", problem });
      expect(await dumpFiles()).toEqual([]);
      await expectNoSecrets(1);
    });
  }

  it("Secret + recovery: after an executor restart the copy fails interrupted, one panelStart, file gone", async () => {
    await panelUntilAmbiguous();
    sim.backupState.simulateRestart();
    await app.outboxWorker.recoverUnknownOperations();
    expect((await panelOps())[0]!.status).toBe("failed");
    expect(await settingsRow()).toMatchObject({ lastPanelBackupProblem: "interrupted" });
    expect(await dumpFiles()).toEqual([]);
    await expectNoSecrets(1);
  });

  // ---------------------------------------------------------------- Never twice

  it("Never twice: one panel copy per night however many ticks; the next night gets its own", async () => {
    await queuePanel();
    await app.outboxWorker.processPendingOnce();
    await scheduler.tick(NIGHT);
    await scheduler.tick(new Date(NIGHT.getTime() + 60 * 60_000));
    await app.outboxWorker.processPendingOnce();
    expect(await panelOps()).toHaveLength(1);
    expect(countCalls("panelStart")).toBe(1);
    await queuePanel(new Date(NIGHT.getTime() + DAY_MS));
    expect(await panelOps()).toHaveLength(2);
  });

  it("Never twice: no copy when backups are not configured", async () => {
    await resetBackupConfig();
    for (let i = 0; i < 5; i += 1) {
      await scheduler.tick(NIGHT);
      await app.outboxWorker.processPendingOnce();
    }
    expect(await panelOps()).toHaveLength(0);
  });

  it("Never twice: no copy when the backend is disabled", async () => {
    for (let i = 0; i < 5; i += 1) await offApp.nestApp.get(BackupSchedulerService).tick(NIGHT);
    expect(await dbClient.db.select().from(operations)).toHaveLength(0);
  });

  it("Never twice: no copy when panelDump is not set", async () => {
    const noDump = await createControlPlaneApp({
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
      panelDump: null,
    });
    extraApps.push(noDump);
    const noDumpScheduler = noDump.nestApp.get(BackupSchedulerService);
    for (let i = 0; i < 5; i += 1) {
      await noDumpScheduler.tick(NIGHT);
      await app.outboxWorker.processPendingOnce();
    }
    expect(await panelOps()).toHaveLength(0);
    const audits = await newAudits();
    expect(audits.filter((a) => a.action === "backups.nightly_run")).toHaveLength(1);
  });

  it("Never twice: recovery of a running job stays pending and never sends panelStart again", async () => {
    const opId = await panelUntilAmbiguous();
    for (let i = 0; i < 3; i += 1) await app.outboxWorker.recoverUnknownOperations();
    expect((await panelOps())[0]!.status).toBe("unknown");
    expect(await dumpFiles()).toEqual([`${opId}.dump`]);
    sim.backupState.finishHeld();
    await app.outboxWorker.recoverUnknownOperations();
    await app.outboxWorker.recoverUnknownOperations();
    expect((await panelOps())[0]!.status).toBe("succeeded");
    expect(sim.backupState.panelJobIds().filter((id) => id === opId)).toHaveLength(1);
    expect(countCalls("panelStart")).toBe(1);
    // One outcome audit; the enqueue audit panel.backups.create (SPEC 15.1) is the second.
    expect((await newAudits()).filter((a) => a.action.startsWith("panel.backups.") && a.action !== "panel.backups.create")).toHaveLength(1);
    expect(await dumpFiles()).toEqual([]);
  });

  it("Recovery uses only the copies recorded at enqueue: a panel policy change meanwhile adds no never-run copy and the operation still succeeds", async () => {
    const opId = await panelUntilAmbiguous();
    const recorded = (await listPanelBackupCopies(dbClient.db, opId)).map((c) => c.targetId);
    expect(recorded).toHaveLength(1);
    const second = await insertS3Target(dbClient.db, KEY, {
      name: "Second",
      endpoint: "https://second.example.com",
      region: "eu-south-1",
      bucket: "second-bucket",
      prefix: "",
      accessKeyId: "AKIASECONDTEST001",
      secretAccessKey: "second-secret",
      customerSelectable: false,
      actorId: null,
    });
    await setPolicyTargets(dbClient.db, (await getPolicy(dbClient.db, "panel")).id, [...recorded, second.id]);

    sim.backupState.finishHeld();
    await app.outboxWorker.recoverUnknownOperations();
    await app.outboxWorker.recoverUnknownOperations();

    expect((await panelOps())[0]!.status).toBe("succeeded");
    expect((await listPanelBackupCopies(dbClient.db, opId)).map((c) => c.targetId)).toEqual(recorded);
    expect(countCalls("panelStart")).toBe(1);
  });

  it("Never twice: recovery of a job that failed settles failed with its problem, without panelStart", async () => {
    const opId = await queuePanel();
    sim.backupState.failNext("wrong_key");
    sim.backupState.holdJobs(true);
    statusDown = true;
    applier.pollGiveUpMs = 0;
    await app.outboxWorker.processPendingOnce();
    statusDown = false;
    expect((await panelOps())[0]!.status).toBe("unknown");
    sim.backupState.finishHeld();
    await app.outboxWorker.recoverUnknownOperations();
    expect((await panelOps())[0]!.status).toBe("failed");
    expect(await settingsRow()).toMatchObject({ lastPanelBackupStatus: "failed", lastPanelBackupProblem: "wrong_key" });
    expect(sim.backupState.panelJobIds().filter((id) => id === opId)).toHaveLength(1);
    expect(countCalls("panelStart")).toBe(1);
    expect(await dumpFiles()).toEqual([]);
  });

  // ---------------------------------------------------------------- Outcome

  it("Outcome: one system audit per finished copy, the three columns, and the settings line", async () => {
    const opId = await queuePanel();
    await app.outboxWorker.processPendingOnce();
    await app.outboxWorker.processPendingOnce();
    // SPEC 15.1: the enqueue wrote exactly one panel.backups.create with the single key operationId; the outcome audit is separate.
    const created = (await newAudits()).filter((a) => a.action === "panel.backups.create");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ actorType: "system", actorId: null, organizationId: null, targetType: "backups" });
    expect(created[0]!.details).toEqual({ operationId: opId });
    const audits = (await newAudits()).filter((a) => a.action.startsWith("panel.backups.") && a.action !== "panel.backups.create");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "panel.backups.succeeded",
      actorType: "system",
      actorId: null,
      organizationId: null,
      details: expect.objectContaining({ operationId: opId, problem: null }),
    });
    const row = await settingsRow();
    expect(row.lastPanelBackupStatus).toBe("succeeded");
    expect(row.lastPanelBackupProblem).toBeNull();
    expect(row.lastPanelBackupAt).toBeInstanceOf(Date);
    const dto = (await request(app.baseUrl!, "GET", "/v1/admin/backups", { token: adminToken })).body.data;
    // D4: the DTO's lastPanelBackup is read from panel_backup_copies (the copy's finishedAt), not the backup_settings mirror line.
    const copies = await listPanelBackupCopies(dbClient.db, opId);
    expect(dto.lastPanelBackup).toEqual({ at: copies[0]!.finishedAt!.toISOString(), status: "succeeded", problem: null });
  });

  it("Outcome: before any copy the settings line is null", async () => {
    const dto = (await request(app.baseUrl!, "GET", "/v1/admin/backups", { token: adminToken })).body.data;
    expect(dto.lastPanelBackup).toBeNull();
  });

  it("Outcome: an unknown problem name from the executor ends as other, its text shown nowhere", async () => {
    await queuePanel();
    hook = (req) => {
      if (req.action !== "status") return undefined;
      return (async () => ({
        ...((await origBackups(req)) as Json),
        state: "failed",
        failure: "brand_new_failure_class",
        message: EXEC_TEXT,
        snapshot: null,
      }))();
    };
    await app.outboxWorker.processPendingOnce();
    hook = null;
    expect((await panelOps())[0]!.status).toBe("failed");
    expect(await settingsRow()).toMatchObject({ lastPanelBackupStatus: "failed", lastPanelBackupProblem: "other" });
    const text = await haystack();
    expect(text).not.toContain(EXEC_TEXT);
    expect(text).not.toContain("brand_new_failure_class");
    expect(await dumpFiles()).toEqual([]);
  });

  // ---------------------------------------------------------------- Dump file

  it("Dump file: the start sweep removes stale files and keeps an in-flight one", async () => {
    const inFlight = await panelUntilAmbiguous();
    const failedId = `op_${"c".repeat(32)}`;
    await dbClient.db.insert(operations).values({
      id: failedId,
      organizationId: PLATFORM_OPS_ORG_ID,
      kind: "panel.backups.create",
      resourceType: "host",
      resourceId: "panel",
      status: "failed",
    });
    const orphanId = `op_${"d".repeat(32)}`;
    for (const id of [failedId, orphanId]) await writeFile(join(dumpDir, `${id}.dump`), "x");
    await writeFile(join(dumpDir, "op_short.dump"), "x");
    await applier.panel.sweepStaleDumps();
    expect((await dumpFiles()).sort()).toEqual([`${inFlight}.dump`, "op_short.dump"].sort());
    sim.backupState.finishHeld();
    await app.outboxWorker.recoverUnknownOperations();
    expect(await dumpFiles()).toEqual(["op_short.dump"]);
  });

  it("Dump file: owner and group only — the API unit sets UMask 0027 and the directory is 2770 root:hp-ipc", async () => {
    // The API never chmods the dump; pg_dump's file mode comes from the service umask.
    const unit = await readFile(fileURLToPath(new URL("../../../infra/systemd/hp-api.service", import.meta.url)), "utf8");
    expect(unit).toMatch(/^UMask=0027$/m);
    expect(unit).toMatch(/^Environment=HP_PANEL_DUMP_DIR=\/var\/lib\/hosting-panel\/panel-dump$/m);
    const boot = await readFile(fileURLToPath(new URL("../../../infra/linux/bootstrap-dedicated.sh", import.meta.url)), "utf8");
    expect(boot).toMatch(/install -d -m 2770 -o root -g hp-ipc \/var\/lib\/hosting-panel\/panel-dump/);
  });

  // ---------------------------------------------------------------- No harm to sites

  it("No harm: a failing panel copy leaves the night's site backups succeeded", async () => {
    useRunner(Object.assign(new Error("boom"), { code: 2 }));
    await queuePanel();
    await app.outboxWorker.processPendingOnce();
    expect((await panelOps())[0]!.status).toBe("failed");
    const rows = await dbClient.db.select().from(siteBackups);
    expect(rows.filter((r) => r.kind === "nightly").map((r) => [r.siteId, r.status]).sort()).toEqual(
      [
        [siteA, "succeeded"],
        [siteB, "succeeded"],
      ].sort(),
    );
  });

  it("No harm: a held site backup delays the panel copy only until it settles", async () => {
    await scheduler.tick(NIGHT);
    sim.backupState.holdJobs(true);
    statusDown = true;
    applier.pollGiveUpMs = 0;
    await app.outboxWorker.processPendingOnce();
    statusDown = false;
    const unknown = (await dbClient.db.select().from(operations)).filter((o) => o.status === "unknown");
    expect(unknown).toHaveLength(1);
    await scheduler.tick(NIGHT);
    expect(await panelOps()).toHaveLength(0);
    sim.backupState.holdJobs(false);
    sim.backupState.finishHeld();
    await app.outboxWorker.recoverUnknownOperations();
    applier.pollGiveUpMs = 120_000;
    await queuePanel();
    expect(await panelOps()).toHaveLength(1);
  });

  it("No harm: the panel copy takes no site lock — an admin restore is accepted while it is in flight", async () => {
    await seedBackup(siteA, svcA);
    const opId = await panelUntilAmbiguous();
    const [op] = await panelOps();
    expect(op!.lockKey).toBe("panel:db");
    expect(op!.lockKey).not.toMatch(/^site:/);
    const res = await adminRestore({ confirmName: "QA Alpha Site" });
    expect(res.status).toBe(202);
    sim.backupState.finishHeld();
    await app.outboxWorker.recoverUnknownOperations();
    expect(sim.backupState.panelJobIds().filter((id) => id === opId)).toHaveLength(1);
  });

  it("No harm: no customer route shows the panel copy, also for the admin who is a member", async () => {
    const opId = await queuePanel();
    await app.outboxWorker.processPendingOnce();
    for (const token of [ownerAToken, adminToken, memberToken]) {
      const list = await request(app.baseUrl!, "GET", `/v1/organizations/${orgA}/operations`, { token });
      expect(list.status).toBe(200);
      expect(JSON.stringify(list.body)).not.toContain(opId);
      expect(JSON.stringify(list.body)).not.toContain("panel.backups");
      const one = await request(app.baseUrl!, "GET", `/v1/organizations/${orgA}/operations/${opId}`, { token });
      expect(one.status).toBe(404);
    }
    const platformList = await request(app.baseUrl!, "GET", `/v1/organizations/${PLATFORM_OPS_ORG_ID}/operations`, {
      token: ownerAToken,
    });
    expect([403, 404]).toContain(platformList.status);
  });

  // ---------------------------------------------------------------- Admin restore: access

  const deniedTokens = () =>
    [
      ["the site's own org owner", ownerAToken],
      ["another org's owner", ownerBToken],
      ["a member with every site permission", memberToken],
    ] as const;
  for (const idx of [0, 1, 2]) {
    it(`Access: 403 for customer #${idx + 1}, one denied audit and nothing else written`, async () => {
      const [label, token] = deniedTokens()[idx]!;
      const backupId = await seedBackup(siteA, svcA);
      const res = await adminRestore({ confirmName: "QA Alpha Site", backupId }, randomUUID(), siteA, token);
      expect(res.status, label).toBe(403);
      const audits = await newAudits();
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ action: "platform.users.manage", organizationId: null });
      expect(await dbClient.db.select().from(operations)).toHaveLength(0);
      expect(await dbClient.db.select().from(outboxEvents)).toHaveLength(0);
      const [row] = await dbClient.db.select().from(siteBackups).where(eq(siteBackups.id, backupId));
      expect(row!.restoreStatus ?? null).toBeNull();
    });
  }

  it("Access: no session → 401; unknown or malformed site → 404; nothing written", async () => {
    await seedBackup(siteA, svcA);
    const anon = await request(app.baseUrl!, "POST", restorePath(siteA), {
      body: { confirmName: "QA Alpha Site" },
      headers: { "Idempotency-Key": randomUUID() },
    });
    expect(anon.status).toBe(401);
    expect((await adminRestore({ confirmName: "QA Alpha Site" }, randomUUID(), `site_${randomUUID()}`)).status).toBe(404);
    expect((await adminRestore({ confirmName: "QA Alpha Site" }, randomUUID(), "not-a-site%20id")).status).toBe(404);
    expect(await dbClient.db.select().from(operations)).toHaveLength(0);
  });

  it("Access: backend disabled → 422", async () => {
    await seedBackup(siteA, svcA);
    const res = await request(offApp.baseUrl!, "POST", restorePath(siteA), {
      token: adminToken,
      body: { confirmName: "QA Alpha Site" },
      headers: { "Idempotency-Key": randomUUID() },
    });
    expect(res.status).toBe(422);
    expect(await dbClient.db.select().from(operations)).toHaveLength(0);
  });

  it("Access: missing key, unknown body key, malformed backupId → 400; wrong name → 400 naming confirmName", async () => {
    await seedBackup(siteA, svcA);
    expect((await adminRestore({ confirmName: "QA Alpha Site" }, null)).status).toBe(400);
    expect((await adminRestore({ confirmName: "QA Alpha Site", force: true })).status).toBe(400);
    expect((await adminRestore({ confirmName: "QA Alpha Site", backupId: "bkp_../../x" })).status).toBe(400);
    expect((await adminRestore({ confirmName: "QA Alpha Site", backupId: `bkp_${"A".repeat(32)}` })).status).toBe(400);
    const wrong = await adminRestore({ confirmName: "QA Beta Site" });
    expect(wrong.status).toBe(400);
    expect(JSON.stringify(wrong.body)).toContain("confirmName");
    expect(await dbClient.db.select().from(operations)).toHaveLength(0);
  });

  it("Access: no succeeded copy → 400 no_succeeded_backup; another site's copy → the same, nothing written", async () => {
    const none = await adminRestore({ confirmName: "QA Alpha Site" });
    expect(none.status).toBe(400);
    expect(JSON.stringify(none.body)).toContain("no_succeeded_backup");
    const otherCopy = await seedBackup(siteB, svcB);
    const cross = await adminRestore({ confirmName: "QA Alpha Site", backupId: otherCopy });
    expect(cross.status).toBe(400);
    expect(JSON.stringify(cross.body)).toContain("no_succeeded_backup");
    expect(await dbClient.db.select().from(operations)).toHaveLength(0);
    const [row] = await dbClient.db.select().from(siteBackups).where(eq(siteBackups.id, otherCopy));
    expect(row!.restoreStatus ?? null).toBeNull();
  });

  it("Access: another backup action of the site in flight → 409 RESOURCE_LOCKED", async () => {
    await seedBackup(siteA, svcA);
    expect((await adminRestore({ confirmName: "QA Alpha Site" })).status).toBe(202);
    const second = await adminRestore({ confirmName: "QA Alpha Site" });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("RESOURCE_LOCKED");
    expect(await dbClient.db.select().from(operations)).toHaveLength(1);
  });

  it("Access: the customer's six-per-hour limit neither refuses nor counts the admin restore", async () => {
    const seedOps = async (n: number) => {
      for (let i = 0; i < n; i += 1) {
        await dbClient.db.insert(operations).values({
          id: `op_${randomUUID().replace(/-/g, "")}`,
          organizationId: orgA,
          kind: "site.backups.create",
          resourceType: "site",
          resourceId: siteA,
          status: "succeeded",
          requestedByUserId: ownerAId,
        });
      }
    };
    await seedOps(6);
    await seedBackup(siteA, svcA);
    const res = await adminRestore({ confirmName: "QA Alpha Site" });
    expect(res.status).toBe(202);
    await app.outboxWorker.processPendingOnce();
    // Five customer actions plus the admin's: the customer may still make a sixth.
    await dbClient.db.delete(operations).where(eq(operations.kind, "site.backups.create"));
    await seedOps(5);
    const own = await request(app.baseUrl!, "POST", `/v1/organizations/${orgA}/managed-sites/${siteA}/backups`, {
      token: ownerAToken,
      body: {},
      headers: { "Idempotency-Key": randomUUID() },
    });
    expect(own.status).toBe(202);
  });

  // ---------------------------------------------------------------- Admin restore: run

  /** Accepts an admin restore of the given copy (or the newest) and returns its operation id. */
  async function accept(backupId?: string, key = randomUUID()): Promise<string> {
    const res = await adminRestore({ confirmName: "QA Alpha Site", ...(backupId ? { backupId } : {}) }, key);
    expect(res.status).toBe(202);
    return res.body.data.operationId as string;
  }
  const stepsOf = async (opId: string) =>
    Object.fromEntries(
      (await dbClient.db.select().from(operationSteps).where(eq(operationSteps.operationId, opId))).map((r) => [
        r.key,
        r.status,
      ]),
    );
  const opOf = async (opId: string) => (await dbClient.db.select().from(operations).where(eq(operations.id, opId)))[0]!;
  const rowOf = async (id: string) => (await dbClient.db.select().from(siteBackups).where(eq(siteBackups.id, id)))[0]!;
  const siteRow = async () => (await dbClient.db.select().from(sites).where(eq(sites.id, siteA)))[0]!;

  it("Run: nothing exists → database job, restore with createVolume, exactly one deploy, never an install", async () => {
    sim.backupState.setSiteState(svcA, { filesVolume: false, container: false });
    const backupId = await seedBackup(siteA, svcA);
    const opId = await accept(backupId);
    await app.outboxWorker.processPendingOnce();
    expect(order.indexOf("job:db.provision")).toBeGreaterThan(-1);
    expect(order.indexOf("job:db.provision")).toBeLessThan(order.indexOf("restore"));
    expect(order.indexOf("restore")).toBeLessThan(order.indexOf("deploy"));
    expect(calls.find((c) => c.action === "restore")).toMatchObject({ createVolume: true });
    expect(order.filter((x) => x === "deploy")).toHaveLength(1);
    expect(sim.jobs.map((j) => j.kind)).not.toContain("wordpress.install");
    const detail = await request(app.baseUrl!, "GET", `/v1/organizations/${orgA}/operations/${opId}`, {
      token: ownerAToken,
    });
    expect((detail.body.data.steps as Json[]).map((s) => s.key)).toEqual([
      "provision_database",
      "restore",
      "start_site",
      "update_address",
      "sftp",
    ]);
    expect((await opOf(opId)).status).toBe("succeeded");
    expect(await rowOf(backupId)).toMatchObject({ restoreStatus: "succeeded", restoreProblem: null });
  });

  it("Run: files exist → database job still runs (R119), no createVolume", async () => {
    sim.backupState.setSiteState(svcA, { filesVolume: true, container: false });
    await seedBackup(siteA, svcA);
    const opId = await accept();
    await app.outboxWorker.processPendingOnce();
    expect(sim.jobs.filter((j) => j.kind === "db.provision")).toHaveLength(1);
    expect(calls.find((c) => c.action === "restore")).not.toHaveProperty("createVolume");
    expect((await stepsOf(opId)).provision_database).toBe("succeeded");
  });

  for (const files of [true, false]) {
    it(`Run (CP-01): a container exists (files ${files ? "present" : "missing"}) → no deploy`, async () => {
      sim.backupState.setSiteState(svcA, { filesVolume: files, container: true });
      await seedBackup(siteA, svcA);
      const opId = await accept();
      await app.outboxWorker.processPendingOnce();
      expect(order).not.toContain("deploy");
      expect(sim.deployedSpecs).toHaveLength(0);
      expect((await stepsOf(opId)).start_site).toBe("skipped");
    });
  }

  it("Run (R115): a container that appears between the first siteState and start_site → no deploy", async () => {
    sim.backupState.setSiteState(svcA, { filesVolume: false, container: false });
    hook = (req) => {
      if (req.action === "restore") sim.backupState.setSiteState(svcA, { filesVolume: false, container: true });
      return undefined;
    };
    await seedBackup(siteA, svcA);
    const opId = await accept();
    await app.outboxWorker.processPendingOnce();
    expect(countCalls("siteState")).toBe(2);
    expect(order).not.toContain("deploy");
    expect((await stepsOf(opId)).start_site).toBe("skipped");
  });

  it("Run failure: siteState fails → row failed restore_prepare_failed, no restore, op failed", async () => {
    hook = (req) => {
      if (req.action === "siteState") throw Object.assign(new Error("engine down"), { code: "DOCKER_ENGINE_UNAVAILABLE" });
      return undefined;
    };
    const backupId = await seedBackup(siteA, svcA);
    const opId = await accept(backupId);
    await app.outboxWorker.processPendingOnce();
    expect(countCalls("restore")).toBe(0);
    expect((await opOf(opId)).status).toBe("failed");
    expect(await rowOf(backupId)).toMatchObject({ restoreStatus: "failed", restoreProblem: "restore_prepare_failed" });
  });

  it("Run failure: the database job fails → restore_prepare_failed, no restore, no deploy", async () => {
    sim.backupState.setSiteState(svcA, { filesVolume: false, container: false });
    sim.failNextJob("db.provision", 1);
    const backupId = await seedBackup(siteA, svcA);
    const opId = await accept(backupId);
    await app.outboxWorker.processPendingOnce();
    expect(countCalls("restore")).toBe(0);
    expect(order).not.toContain("deploy");
    expect((await opOf(opId)).status).toBe("failed");
    expect(await stepsOf(opId)).toMatchObject({ provision_database: "failed", restore: "skipped" });
    expect(await rowOf(backupId)).toMatchObject({ restoreStatus: "failed", restoreProblem: "restore_prepare_failed" });
    expect((await newAudits()).filter((a) => a.action === "admin.site.backups.restore.finished")).toHaveLength(1);
  });

  it("Run failure: the restore fails → its problem on the row, no deploy, site status unchanged", async () => {
    sim.backupState.setSiteState(svcA, { filesVolume: true, container: false });
    await dbClient.db.update(sites).set({ status: "degraded" }).where(eq(sites.id, siteA));
    const backupId = await seedBackup(siteA, svcA);
    sim.backupState.failNext("files_unreadable");
    const opId = await accept(backupId);
    await app.outboxWorker.processPendingOnce();
    expect(order).not.toContain("deploy");
    expect((await opOf(opId)).status).toBe("failed");
    expect(await rowOf(backupId)).toMatchObject({ restoreStatus: "failed", restoreProblem: "files_unreadable" });
    expect((await siteRow()).status).toBe("degraded");
  });

  it("Run failure: start fails → step failed, site degraded, row succeeded with site_not_started, op failed", async () => {
    sim.backupState.setSiteState(svcA, { filesVolume: false, container: false });
    sim.failNextDeploy();
    const backupId = await seedBackup(siteA, svcA);
    const opId = await accept(backupId);
    await app.outboxWorker.processPendingOnce();
    expect(await stepsOf(opId)).toMatchObject({ restore: "succeeded", start_site: "failed" });
    expect((await opOf(opId)).status).toBe("failed");
    expect((await siteRow()).status).toBe("degraded");
    expect(await rowOf(backupId)).toMatchObject({ restoreStatus: "succeeded", restoreProblem: "site_not_started" });
    expect(countCalls("restore")).toBe(1);
  });

  it("Run: the same key twice → one op, one requested audit, one restore", async () => {
    const backupId = await seedBackup(siteA, svcA);
    const key = randomUUID();
    const first = await accept(backupId, key);
    const again = await adminRestore({ confirmName: "QA Alpha Site", backupId }, key);
    expect([200, 202]).toContain(again.status);
    expect(again.body.data.operationId).toBe(first);
    await app.outboxWorker.processPendingOnce();
    await app.outboxWorker.processPendingOnce();
    expect(await dbClient.db.select().from(operations)).toHaveLength(1);
    expect((await newAudits()).filter((a) => a.action === "admin.site.backups.restore.requested")).toHaveLength(1);
    expect(countCalls("restore")).toBe(1);
  });

  it("Run: the same key without backupId after a newer copy appeared → the first op and its copy", async () => {
    const older = await seedBackup(siteA, svcA, new Date(Date.now() - 60_000));
    const key = randomUUID();
    const first = await accept(undefined, key);
    const newer = await seedBackup(siteA, svcA, new Date());
    const again = await adminRestore({ confirmName: "QA Alpha Site" }, key);
    expect([200, 202]).toContain(again.status);
    expect(again.body.data.operationId).toBe(first);
    expect(again.body.data.backupId).toBe(older);
    expect(again.body.data.backupId).not.toBe(newer);
    expect(await dbClient.db.select().from(operations)).toHaveLength(1);
  });

  // ---------------------------------------------------------------- Recovery

  it("Recovery: a pending restore step fails interrupted without any executor call", async () => {
    const backupId = await seedBackup(siteA, svcA);
    const opId = await accept(backupId);
    await dbClient.db.update(operations).set({ status: "unknown" }).where(eq(operations.id, opId));
    calls.length = 0;
    order.length = 0;
    await app.outboxWorker.recoverUnknownOperations();
    expect(calls).toHaveLength(0);
    expect(order).toHaveLength(0);
    expect((await opOf(opId)).status).toBe("failed");
    expect(await rowOf(backupId)).toMatchObject({ restoreStatus: "failed", restoreProblem: "interrupted" });
    expect((await newAudits()).filter((a) => a.action === "admin.site.backups.restore.finished")).toHaveLength(1);
  });

  it("Recovery: stopped during the restore → one restore, one deploy, one finished audit", async () => {
    sim.backupState.setSiteState(svcA, { filesVolume: false, container: false });
    const backupId = await seedBackup(siteA, svcA);
    const opId = await accept(backupId);
    sim.backupState.holdJobs(true);
    statusDown = true;
    applier.pollGiveUpMs = 0;
    await app.outboxWorker.processPendingOnce();
    statusDown = false;
    expect((await opOf(opId)).status).toBe("unknown");
    await app.outboxWorker.recoverUnknownOperations();
    expect((await opOf(opId)).status).toBe("unknown");
    sim.backupState.finishHeld();
    await app.outboxWorker.recoverUnknownOperations();
    await app.outboxWorker.recoverUnknownOperations();
    expect(countCalls("restore")).toBe(1);
    expect(order.filter((x) => x === "deploy")).toHaveLength(1);
    expect(await rowOf(backupId)).toMatchObject({ restoreStatus: "succeeded" });
    expect((await opOf(opId)).status).toBe("succeeded");
    expect((await newAudits()).filter((a) => a.action === "admin.site.backups.restore.finished")).toHaveLength(1);
  });

  it("Recovery: stopped at start_site (ambiguous deploy) → the tail runs again, never a second restore or deploy", async () => {
    sim.backupState.setSiteState(svcA, { filesVolume: false, container: false });
    let deployAttempts = 0;
    sim.onDeploy = async () => {
      order.push("deploy");
      deployAttempts += 1;
      if (deployAttempts === 1) {
        // The container got created but the answer was lost.
        sim.backupState.setSiteState(svcA, { filesVolume: true, container: true });
        throw Object.assign(new Error("lost answer"), { code: "OPERATION_AMBIGUOUS" });
      }
    };
    const backupId = await seedBackup(siteA, svcA);
    const opId = await accept(backupId);
    await app.outboxWorker.processPendingOnce();
    expect((await opOf(opId)).status).toBe("unknown");
    await app.outboxWorker.recoverUnknownOperations();
    await app.outboxWorker.recoverUnknownOperations();
    expect(countCalls("restore")).toBe(1);
    expect(deployAttempts).toBe(1);
    expect(await rowOf(backupId)).toMatchObject({ restoreStatus: "succeeded" });
    expect((await stepsOf(opId)).start_site).toBe("skipped");
    expect((await newAudits()).filter((a) => a.action === "admin.site.backups.restore.finished")).toHaveLength(1);
  });

  it("Recovery: after an executor restart the restore ends failed interrupted, no deploy", async () => {
    sim.backupState.setSiteState(svcA, { filesVolume: false, container: false });
    const backupId = await seedBackup(siteA, svcA);
    const opId = await accept(backupId);
    sim.backupState.holdJobs(true);
    statusDown = true;
    applier.pollGiveUpMs = 0;
    await app.outboxWorker.processPendingOnce();
    statusDown = false;
    sim.backupState.simulateRestart();
    sim.backupState.holdJobs(false);
    await app.outboxWorker.recoverUnknownOperations();
    expect((await opOf(opId)).status).toBe("failed");
    expect(await rowOf(backupId)).toMatchObject({ restoreStatus: "failed", restoreProblem: "interrupted" });
    expect(order).not.toContain("deploy");
    expect(countCalls("restore")).toBe(1);
  });

  // ---------------------------------------------------------------- Audit

  it("Audit: one requested (site org, admin actor) and one finished per run; a refused request writes only denied", async () => {
    const backupId = await seedBackup(siteA, svcA);
    const opId = await accept(backupId);
    await app.outboxWorker.processPendingOnce();
    const audits = await newAudits();
    const requested = audits.filter((a) => a.action === "admin.site.backups.restore.requested");
    const finished = audits.filter((a) => a.action === "admin.site.backups.restore.finished");
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatchObject({
      actorType: "user",
      actorId: adminId,
      organizationId: orgA,
      targetId: siteA,
      details: expect.objectContaining({ backupId, operationId: opId }),
    });
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({
      organizationId: orgA,
      details: expect.objectContaining({ operationId: opId, backupId, outcome: "succeeded" }),
    });
    const before = new Set((await newAudits()).map((a) => a.id));
    await adminRestore({ confirmName: "QA Alpha Site" }, randomUUID(), siteA, ownerBToken);
    const after = (await newAudits()).filter((a) => !before.has(a.id));
    expect(after.map((a) => a.action)).toEqual(["platform.users.manage"]);
  });

  // ---------------------------------------------------------------- Figures

  it("Figures: the total sums each site's newest succeeded copy; a newer failure hides nothing; deleted sites are left out", async () => {
    const t0 = Date.now() - 10 * 60_000;
    await seedBackup(siteA, svcA, new Date(t0), 100);
    await insertSiteBackup(dbClient.db, {
      siteId: siteA,
      kind: "nightly",
      status: "failed",
      operationId: null,
      problem: "unreachable",
      startedAt: new Date(t0 + 60_000),
      finishedAt: new Date(t0 + 60_000),
    });
    await seedBackup(siteB, svcB, new Date(t0), 5);
    const newestB = await seedBackup(siteB, svcB, new Date(t0 + 120_000), 7);
    const gone = `site_${randomUUID().replace(/-/g, "")}`;
    const goneRow = await insertSiteBackup(dbClient.db, { siteId: gone, kind: "nightly", status: "running", operationId: null });
    await dbClient.db.update(siteBackups).set({ status: "succeeded", sizeBytes: 1000 }).where(eq(siteBackups.id, goneRow.id));

    const settings = await request(app.baseUrl!, "GET", "/v1/admin/backups", { token: adminToken });
    expect(settings.body.data.newestBackupsTotalBytes).toBe(107);
    const list = await request(app.baseUrl!, "GET", "/v1/admin/backups/sites", { token: adminToken });
    const a = (list.body.data as Json[]).find((r) => r.siteId === siteA)!;
    const b = (list.body.data as Json[]).find((r) => r.siteId === siteB)!;
    expect(a).toMatchObject({ lastSuccessSizeBytes: 100, lastStatus: "failed" });
    expect(b).toMatchObject({ lastSuccessSizeBytes: 7, lastSuccessBackupId: newestB });
    expect((list.body.data as Json[]).some((r) => r.siteId === gone)).toBe(false);
  });

  it("Figures: zero when no site has a copy; lastRestore null, running, succeeded and failed", async () => {
    const empty = await request(app.baseUrl!, "GET", "/v1/admin/backups", { token: adminToken });
    expect(empty.body.data.newestBackupsTotalBytes).toBe(0);
    const restoreOf = async () =>
      ((await request(app.baseUrl!, "GET", "/v1/admin/backups/sites", { token: adminToken })).body.data as Json[]).find(
        (r) => r.siteId === siteA,
      )!.lastRestore;
    expect(await restoreOf()).toBeNull();
    const ok = await seedBackup(siteA, svcA);
    await accept(ok);
    expect(await restoreOf()).toMatchObject({ backupId: ok, status: "running", problem: null });
    await app.outboxWorker.processPendingOnce();
    expect(await restoreOf()).toMatchObject({ backupId: ok, status: "succeeded", problem: null });
    sim.backupState.failNext("files_unreadable");
    await accept(ok);
    await app.outboxWorker.processPendingOnce();
    expect(await restoreOf()).toMatchObject({ backupId: ok, status: "failed", problem: "files_unreadable" });
  });

  it("Figures: the admin answers hold no host path, executor id, snapshot id or key", async () => {
    const backupId = await seedBackup(siteA, svcA);
    await accept(backupId);
    await app.outboxWorker.processPendingOnce();
    await queuePanel();
    await app.outboxWorker.processPendingOnce();
    const [row] = await dbClient.db.select().from(siteBackups).where(eq(siteBackups.id, backupId));
    const text = [
      JSON.stringify((await request(app.baseUrl!, "GET", "/v1/admin/backups", { token: adminToken })).body),
      JSON.stringify((await request(app.baseUrl!, "GET", "/v1/admin/backups/sites", { token: adminToken })).body),
    ].join("\n");
    for (const banned of [dumpDir, "/var/lib", svcA, row!.snapshotId!, KEY_HEX, KEY_B64, S3_SECRET, DB_PW_MARK]) {
      expect(text).not.toContain(banned);
    }
    expect(text).not.toMatch(/[0-9a-f]{64}/);
  });

  // ---------------------------------------------------------------- Customer view

  it("Customer view: the backup list and operations show the admin restore without technical words", async () => {
    const backupId = await seedBackup(siteA, svcA);
    const opId = await accept(backupId);
    await app.outboxWorker.processPendingOnce();
    const list = await request(app.baseUrl!, "GET", `/v1/organizations/${orgA}/managed-sites/${siteA}/backups`, {
      token: ownerAToken,
    });
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).toContain(backupId);
    const ops = await request(app.baseUrl!, "GET", `/v1/organizations/${orgA}/operations`, { token: ownerAToken });
    expect(ops.status).toBe(200);
    const mine = (ops.body.data as Json[]).find((o) => o.id === opId);
    expect(mine).toBeDefined();
    const one = await request(app.baseUrl!, "GET", `/v1/organizations/${orgA}/operations/${opId}`, { token: ownerAToken });
    expect(one.status).toBe(200);
    // Every human-readable string the customer receives (keys, ids and codes are not texts).
    const texts: string[] = [];
    const walk = (v: unknown, key = ""): void => {
      if (typeof v === "string") {
        if (["label", "message", "title", "description", "summary", "error"].some((k) => key.toLowerCase().includes(k))) texts.push(v);
      } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
    };
    walk([list.body, mine, one.body]);
    expect(texts.length).toBeGreaterThan(0);
    for (const t of texts) expect(t, t).not.toMatch(CUSTOMER_FORBIDDEN);
  });

  it("Customer view: a start failure tells the customer in plain words", async () => {
    sim.backupState.setSiteState(svcA, { filesVolume: false, container: false });
    sim.failNextDeploy();
    const backupId = await seedBackup(siteA, svcA);
    const opId = await accept(backupId);
    await app.outboxWorker.processPendingOnce();
    const one = await request(app.baseUrl!, "GET", `/v1/organizations/${orgA}/operations/${opId}`, { token: ownerAToken });
    expect(one.status).toBe(200);
    expect(JSON.stringify(one.body)).not.toMatch(CUSTOMER_FORBIDDEN);
    expect(existsSync(dumpDir)).toBe(true);
  });
});
