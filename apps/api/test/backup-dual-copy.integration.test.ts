import { generateKeyPairSync, randomUUID } from "node:crypto";
import { SiteBackupsDtoSchema, type BackupJobStatus, type BackupsIpcRequest } from "@hosting-panel/contracts";
import {
  auditEvents,
  createDatabaseClient,
  enqueueOperationTransactional,
  eq,
  hostAllocations,
  hosts,
  insertLocalTarget,
  insertS3Target,
  insertSiteBackup,
  insertSiteBackupCopies,
  listSiteBackupCopies,
  operations,
  organizations,
  platformInstallations,
  settleSiteBackupAggregate,
  settleSiteBackupCopy,
  siteBackups,
  sites,
  updatePolicySettings,
  users,
  type DatabaseClient,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
import { InMemoryHostSimulatorAdapter } from "@hosting-panel/host-agent";
import type { FastifyRequest } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_COPIES, BackupPoliciesService } from "../src/backups/backup-policies.service.js";
import { BACKUP_LEASE_MS, SiteBackupsApplier, type BackupOperationRef } from "../src/backups/site-backups-applier.js";
import { SiteRestoreService } from "../src/backups/site-restore.service.js";
import {
  SITE_BACKUP_PRUNE_STEPS,
  SITE_BACKUP_STEPS,
  SiteBackupsService,
  createBackupWithCopies,
  type BackupSiteRef,
  type SiteBackupActor,
} from "../src/backups/site-backups.service.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { AppModule } from "../src/app.module.js";
import { AdminBackupPoliciesController } from "../src/controllers/admin-backup-policies.controller.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";

vi.mock("../src/sites/site-files.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sites/site-files.service.js")>();
  return { ...actual, resolveSiteFilesServiceId: async () => "svc_dual" };
});

const KEY = Buffer.alloc(32, 7);
const SNAP_LOCAL = "a".repeat(64);
const SNAP_S3 = "b".repeat(64);
const DAY = 86_400_000;

type StartReq = Extract<BackupsIpcRequest, { action: "start" }>;
type ForgetReq = Extract<BackupsIpcRequest, { action: "forget" }>;

describe("two destinations per policy: both copies, partial, pre_update refusal (BKP-07, BKP-08, BKP-09)", () => {
  let dbClient: DatabaseClient;
  let db: HostingPanelDatabase;
  let app: ControlPlaneAppHandle;
  let applier: SiteBackupsApplier;
  let service: SiteBackupsService;
  let restoreService: SiteRestoreService;
  let policies: BackupPoliciesService;
  let adminId: string;
  let customerId: string;
  let orgId: string;
  let siteId: string;
  let site: BackupSiteRef & { name: string };
  let s3: string;
  let local: string;
  const calls: BackupsIpcRequest[] = [];
  const statusAnswers = new Map<string, BackupJobStatus | Error>();
  let forgetFails: (req: ForgetReq) => boolean = () => false;
  let startFails: (req: StartReq) => boolean = () => false;

  const customer = (): SiteBackupActor => ({
    auth: { user: { id: customerId } } as unknown as SiteBackupActor["auth"],
    req: { headers: {}, ip: "127.0.0.1" } as unknown as FastifyRequest,
  });
  const dispatches = () => calls.filter((c): c is StartReq => c.action === "start");
  const forgets = () => calls.filter((c): c is ForgetReq => c.action === "forget");
  const isLocal = (target: object) => "kind" in target;
  const failedStatus = (jobId: string): BackupJobStatus => ({ jobId, state: "failed", failure: "unreachable", snapshot: null });

  const claim = async (opId: string, kind: BackupOperationRef["kind"] = "site.backups.create"): Promise<BackupOperationRef> => {
    await db
      .update(operations)
      .set({ status: "processing", leaseExpiresAt: new Date(Date.now() + BACKUP_LEASE_MS) })
      .where(eq(operations.id, opId));
    return { id: opId, organizationId: orgId, kind, resourceId: siteId };
  };
  const copiesOf = async (backupId: string) => (await listSiteBackupCopies(db, [backupId])).get(backupId) ?? [];
  const backupOf = async (opId: string) =>
    (await db.select().from(siteBackups).where(eq(siteBackups.operationId, opId)))[0]!;
  const opRow = async (opId: string) => (await db.select().from(operations).where(eq(operations.id, opId)))[0]!;
  let baselineAuditIds = new Set<string>();
  const audits = async (action: string) =>
    (await db.select().from(auditEvents)).filter((r) => !baselineAuditIds.has(r.id) && r.action === action);

  /** A create operation whose backup has one running copy per policy target (the real enqueue path). */
  const create = async (key: string) => {
    const accepted = await service.create(site, customer(), key);
    return { accepted, op: await claim(accepted.operationId) };
  };

  /** An operation of another kind (a pre_update backup gating a change) with the policy's copies. */
  const enqueueGating = async (kind = "site.wordpress.update" as BackupOperationRef["kind"]) => {
    const { operation } = await db.transaction((tx) =>
      enqueueOperationTransactional(tx as unknown as HostingPanelDatabase, {
        organizationId: orgId,
        kind,
        resourceType: "site",
        resourceId: siteId,
        lockKey: `site:${siteId}`,
        leaseDurationMs: BACKUP_LEASE_MS,
        steps: SITE_BACKUP_STEPS,
        outboxPayload: { siteId },
      }),
    );
    await db.transaction((tx) => createBackupWithCopies(tx, { id: siteId }, { kind: "pre_update", operationId: operation.id }));
    return claim(operation.id, kind);
  };

  const seedBackup = async (startedAt: Date, copies: readonly { targetId: string; snapshotId: string }[]) => {
    const { id } = await insertSiteBackup(db, {
      siteId,
      kind: "nightly",
      status: "running",
      operationId: `op_${randomUUID().replaceAll("-", "")}`,
      startedAt,
    });
    await insertSiteBackupCopies(
      db,
      id,
      `op_${randomUUID().replaceAll("-", "")}`,
      copies.map((c, i) => ({ targetId: c.targetId, priority: i + 1, required: true })),
    );
    for (const c of copies) {
      const copy = (await copiesOf(id)).find((x) => x.targetId === c.targetId)!;
      await settleSiteBackupCopy(db, copy.id, { status: "succeeded", snapshotId: c.snapshotId, sizeBytes: 100 });
    }
    await settleSiteBackupAggregate(db, id);
    return id;
  };

  const enqueuePrune = async () => {
    const { operation } = await db.transaction((tx) =>
      enqueueOperationTransactional(tx as unknown as HostingPanelDatabase, {
        organizationId: orgId,
        kind: "site.backups.prune",
        resourceType: "site",
        resourceId: siteId,
        lockKey: `site:${siteId}`,
        leaseDurationMs: BACKUP_LEASE_MS,
        steps: SITE_BACKUP_PRUNE_STEPS,
        outboxPayload: { siteId },
      }),
    );
    return claim(operation.id, "site.backups.prune");
  };

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    db = dbClient.db;
    await dbClient.migrate();
    await setupInstallation(db, { installationName: "Dual", hostHostname: "panel.test", hostIpv4: "10.0.0.1" });
    adminId = (await createServerAdmin(db, KEY, { email: "admin-dual@x.it", name: "Admin", password: "correct horse battery" })).userId;
    customerId = `usr_${randomUUID()}`;
    await db.insert(users).values({ id: customerId, email: "customer-dual@x.it", name: "Customer", passwordHash: "x" });
    const [inst] = await db.select().from(platformInstallations).limit(1);
    const hostId = `hst_${randomUUID()}`;
    await db.insert(hosts).values({
      id: hostId,
      platformInstallationId: inst!.id,
      name: "dual.test",
      hostname: "dual.test",
      ipv4Address: "10.0.0.9",
      hostingMode: "dedicated",
      totalCpuMilli: 4000,
      totalMemoryBytes: "8589934592",
      totalStorageBytes: "107374182400",
    });
    orgId = `org_${randomUUID()}`;
    await db.insert(organizations).values({ id: orgId, platformInstallationId: inst!.id, name: "Dual Org", slug: "dual-org" });
    const allocId = `alloc_${randomUUID()}`;
    await db.insert(hostAllocations).values({ id: allocId, hostId, organizationId: orgId, status: "active" });
    siteId = `sit_${randomUUID()}`;
    await db.insert(sites).values({
      id: siteId,
      organizationId: orgId,
      hostAllocationId: allocId,
      name: "Dual Site",
      slug: "dual-site",
      status: "ready",
      siteType: "wordpress",
    });
    site = { id: siteId, organizationId: orgId, status: "ready", name: "Dual Site" };

    s3 = (
      await insertS3Target(db, KEY, {
        name: "Off-server",
        endpoint: "https://s3.example.com",
        region: "eu-south-1",
        bucket: "bucket-dual",
        prefix: "panel",
        accessKeyId: "AKIADUAL",
        secretAccessKey: "canary-dual-secret",
        customerSelectable: true,
        actorId: adminId,
      })
    ).id;
    local = (await insertLocalTarget(db, { name: "This server", customerSelectable: true, actorId: adminId })).id;

    const sim = new InMemoryDockerSimulatorAdapter();
    sim.backups = (async (req: BackupsIpcRequest) => {
      calls.push(req);
      switch (req.action) {
        case "start":
          if (startFails(req)) throw new Error("executor refused");
          return { jobId: req.jobId, state: "running", failure: null, snapshot: null };
        case "forget":
          if (forgetFails(req)) throw new Error("repository unavailable");
          return { jobId: req.jobId, state: "running", failure: null, snapshot: null };
        case "status": {
          const answer = statusAnswers.get(req.jobId);
          if (answer instanceof Error) throw answer;
          if (answer) return answer;
          const isForget = /-forget(-t[2-9])?$/.test(req.jobId);
          return {
            jobId: req.jobId,
            state: "succeeded",
            failure: null,
            snapshot: isForget
              ? null
              : { snapshotId: req.jobId.endsWith("-t2") ? SNAP_S3 : SNAP_LOCAL, bytesAdded: 1, totalBytes: 4096, fileCount: 3, durationMs: 10 },
          };
        }
        default:
          throw new Error(`Unexpected backup action in test stub: ${req.action}`);
      }
    }) as DockerExecutorPort["backups"];

    // Registers the policy service until app.module.ts does; idempotent after.
    const register = AppModule.register.bind(AppModule);
    vi.spyOn(AppModule, "register").mockImplementation((options) => {
      const mod = register(options);
      const controllers = mod.controllers ?? [];
      const providers = mod.providers ?? [];
      return {
        ...mod,
        controllers: controllers.includes(AdminBackupPoliciesController)
          ? controllers
          : [...controllers, AdminBackupPoliciesController],
        providers: providers.includes(BackupPoliciesService) ? providers : [...providers, BackupPoliciesService],
      };
    });
    app = await createControlPlaneApp({
      listen: false,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      jwtSigningKeyPem: generateKeyPairSync("rsa", { modulusLength: 2048 })
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString(),
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
    });
    applier = app.nestApp.get(SiteBackupsApplier);
    service = app.nestApp.get(SiteBackupsService);
    restoreService = app.nestApp.get(SiteRestoreService);
    policies = new BackupPoliciesService(dbClient);
  });

  afterAll(async () => {
    await app.close();
    await dbClient.close();
  });

  beforeEach(async () => {
    calls.length = 0;
    statusAnswers.clear();
    forgetFails = () => false;
    startFails = () => false;
    await db.delete(siteBackups);
    await db.delete(operations);
    baselineAuditIds = new Set((await db.select({ id: auditEvents.id }).from(auditEvents)).map((r) => r.id));
    await db.update(sites).set({ status: "ready" }).where(eq(sites.id, siteId));
    await updatePolicySettings(db, "default_site", { retentionDays: 14 }, adminId);
    // The administrator's way in: two destinations, local first.
    await policies.update("default_site", { targetIds: [local, s3] }, adminId);
    await policies.updateSitePolicy(site, { targetIds: null }, customer());
  });

  describe("policy limit", () => {
    it("allows two destinations on the default and the site policy, and no more", async () => {
      expect(MAX_COPIES).toBe(2);
      expect((await policies.get("default_site")).targets.map((t) => [t.targetId, t.priority])).toEqual([
        [local, 1],
        [s3, 2],
      ]);
      await policies.updateSitePolicy(site, { targetIds: [s3, local] }, customer());
      expect((await policies.getSitePolicy(site)).targetIds).toEqual([s3, local]);
      // The contract schema caps the list at two (a ZodError that the HTTP filter turns into a 400).
      await expect(policies.update("default_site", { targetIds: [local, s3, local] }, adminId)).rejects.toMatchObject({
        name: "ZodError",
      });
      await expect(policies.updateSitePolicy(site, { targetIds: [local, s3, "bkt_x"] }, customer())).rejects.toMatchObject({
        name: "ZodError",
      });
      await policies.updateSitePolicy(site, { targetIds: null }, customer());
    });
  });

  describe("BKP-07: both copies succeed", () => {
    it("writes one logical backup with two copies, job ids <op> and <op>-t2, and settles it succeeded", async () => {
      const { accepted, op } = await create("k-dual-1");
      const backup = await backupOf(accepted.operationId);
      expect(await copiesOf(backup.id)).toMatchObject([
        { targetId: local, priority: 1, status: "running", jobId: op.id },
        { targetId: s3, priority: 2, status: "running", jobId: `${op.id}-t2` },
      ]);

      await applier.apply(op);

      expect(dispatches().map((d) => [d.jobId, isLocal(d.target) ? "local" : "s3"])).toEqual([
        [op.id, "local"],
        [`${op.id}-t2`, "s3"],
      ]);
      expect(await db.select().from(siteBackups).where(eq(siteBackups.siteId, siteId))).toHaveLength(1);
      expect(await backupOf(op.id)).toMatchObject({ status: "succeeded", snapshotId: SNAP_LOCAL, problem: null });
      expect(await copiesOf(backup.id)).toMatchObject([
        { targetId: local, status: "succeeded", snapshotId: SNAP_LOCAL },
        { targetId: s3, status: "succeeded", snapshotId: SNAP_S3 },
      ]);
      expect((await opRow(op.id)).status).toBe("succeeded");
      expect(await audits("site.backups.copy_succeeded")).toHaveLength(2);
      expect(await audits("site.backups.partial")).toEqual([]);

      const listed = SiteBackupsDtoSchema.parse(await service.list(site));
      expect(listed.backups).toHaveLength(1);
      expect(listed.backups[0]!.copies.map((c) => [c.kind, c.status])).toEqual([
        ["local", "succeeded"],
        ["s3", "succeeded"],
      ]);
    });
  });

  describe("BKP-08: one copy fails, the backup is partial", () => {
    it("keeps the operation succeeded, mirrors the good copy, audits partial and restores from the good copy only", async () => {
      const { op } = await create("k-dual-partial");
      statusAnswers.set(`${op.id}-t2`, failedStatus(`${op.id}-t2`));
      await applier.apply(op);

      const backup = await backupOf(op.id);
      expect(backup).toMatchObject({ status: "partial", snapshotId: SNAP_LOCAL, problem: "unreachable" });
      expect(await copiesOf(backup.id)).toMatchObject([
        { targetId: local, status: "succeeded" },
        { targetId: s3, status: "failed", problem: "unreachable" },
      ]);
      expect((await opRow(op.id)).status).toBe("succeeded");
      expect(await audits("site.backups.partial")).toHaveLength(1);
      expect(await audits("site.backups.copy_failed")).toHaveLength(1);
      expect(JSON.stringify(await audits("site.backups.partial"))).not.toContain("canary-dual-secret");

      // The good copy restores (by default and by name); the failed one is not offered.
      const accepted = await restoreService.restore(site, customer(), backup.id, { confirmName: "Dual Site" }, "k-restore-good");
      expect((await db.select().from(siteBackups).where(eq(siteBackups.id, backup.id)))[0]!.restoreTargetId).toBe(local);
      expect(accepted.backupId).toBe(backup.id);
      await db.update(operations).set({ status: "succeeded" }).where(eq(operations.id, accepted.operationId));
      await db.update(siteBackups).set({ restoreStatus: null }).where(eq(siteBackups.id, backup.id));
      await db.update(sites).set({ status: "ready" }).where(eq(sites.id, siteId));
      await expect(
        restoreService.restore(site, customer(), backup.id, { confirmName: "Dual Site", targetId: s3 }, "k-restore-bad"),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("is partial the other way round too: the second copy is the survivor", async () => {
      const { op } = await create("k-dual-partial-2");
      statusAnswers.set(op.id, failedStatus(op.id));
      await applier.apply(op);
      expect(await backupOf(op.id)).toMatchObject({ status: "partial", snapshotId: SNAP_S3 });
      expect((await opRow(op.id)).status).toBe("succeeded");
    });

    it("a copy whose start the executor refuses fails alone; the next copy still runs", async () => {
      const { op } = await create("k-dual-refused");
      startFails = (req) => !req.jobId.endsWith("-t2");
      await applier.apply(op);
      expect(await backupOf(op.id)).toMatchObject({ status: "partial", snapshotId: SNAP_S3 });
      expect(dispatches().map((d) => d.jobId)).toEqual([op.id, `${op.id}-t2`]);
    });

    it("fails the backup and the operation when both copies fail", async () => {
      const { op } = await create("k-dual-failed");
      statusAnswers.set(op.id, failedStatus(op.id));
      statusAnswers.set(`${op.id}-t2`, failedStatus(`${op.id}-t2`));
      await expect(applier.apply(op)).rejects.toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE" });
      expect(await backupOf(op.id)).toMatchObject({ status: "failed", snapshotId: null });
      expect((await opRow(op.id)).status).toBe("failed");
      expect(await audits("site.backups.partial")).toEqual([]);
    });
  });

  describe("a partial backup that gates a change is refused", () => {
    it("fails a pre_update backup with backup_failed semantics and keeps the good copy", async () => {
      const op = await enqueueGating();
      statusAnswers.set(`${op.id}-t2`, failedStatus(`${op.id}-t2`));
      await expect(applier.runBackupStep(op)).rejects.toMatchObject({ code: "INTERNAL_ERROR", message: "Backup did not finish." });

      const backup = await backupOf(op.id);
      expect(backup).toMatchObject({ status: "partial", snapshotId: SNAP_LOCAL });
      expect((await copiesOf(backup.id)).map((c) => c.status)).toEqual(["succeeded", "failed"]);
      expect(await opRow(op.id)).toMatchObject({ status: "failed", errorCode: "INTERNAL_ERROR" });
      expect(await audits("site.backups.partial")).toHaveLength(1);
    });

    it("passes a pre_update backup whose two copies both succeed", async () => {
      const op = await enqueueGating();
      await applier.runBackupStep(op);
      expect((await backupOf(op.id)).status).toBe("succeeded");
      expect((await opRow(op.id)).status).not.toBe("failed");
    });
  });

  describe("recovery with one copy settled and the other unknown (BKP-14)", () => {
    it("settles the unknown copy as interrupted without starting a job: partial, a success for create", async () => {
      const { op } = await create("k-dual-recover");
      const backup = await backupOf(op.id);
      const first = (await copiesOf(backup.id))[0]!;
      await settleSiteBackupCopy(db, first.id, { status: "succeeded", snapshotId: SNAP_LOCAL, sizeBytes: 10 });
      statusAnswers.set(`${op.id}-t2`, { jobId: `${op.id}-t2`, state: "unknown", failure: null, snapshot: null });

      expect(await applier.recover(op)).toBe("settled");

      expect(calls.filter((c) => c.action !== "status")).toEqual([]);
      expect(calls).toEqual([{ action: "status", jobId: `${op.id}-t2` }]);
      expect(await backupOf(op.id)).toMatchObject({ status: "partial", snapshotId: SNAP_LOCAL });
      expect(await copiesOf(backup.id)).toMatchObject([
        { status: "succeeded" },
        { status: "failed", problem: "interrupted" },
      ]);
      expect((await opRow(op.id)).status).toBe("succeeded");
    });

    it("stays pending while the open copy still runs, then takes both copies' answers", async () => {
      const { op } = await create("k-dual-recover-2");
      statusAnswers.set(op.id, { jobId: op.id, state: "running", failure: null, snapshot: null });
      expect(await applier.recover(op)).toBe("pending");
      statusAnswers.delete(op.id);
      expect(await applier.recover(op)).toBe("settled");
      expect(await backupOf(op.id)).toMatchObject({ status: "succeeded" });
      expect(calls.filter((c) => c.action !== "status")).toEqual([]);
    });

    it("fails a gating operation recovered as partial", async () => {
      const op = await enqueueGating();
      const backup = await backupOf(op.id);
      await settleSiteBackupCopy(db, (await copiesOf(backup.id))[0]!.id, { status: "succeeded", snapshotId: SNAP_LOCAL, sizeBytes: 1 });
      statusAnswers.set(`${op.id}-t2`, failedStatus(`${op.id}-t2`));
      expect(await applier.recover(op)).toBe("settled");
      expect((await backupOf(op.id)).status).toBe("partial");
      expect((await opRow(op.id)).status).toBe("failed");
    });
  });

  describe("aggregate truth table", () => {
    type Outcome = "running" | "succeeded" | "failed";
    const rows: readonly [Outcome, Outcome | null, string][] = [
      ["succeeded", "succeeded", "succeeded"],
      ["succeeded", "failed", "partial"],
      ["failed", "succeeded", "partial"],
      ["failed", "failed", "failed"],
      ["succeeded", "running", "running"],
      ["running", "failed", "running"],
      ["running", null, "running"],
      ["succeeded", null, "succeeded"],
      ["failed", null, "failed"],
    ];
    it.each(rows)("copies %s + %s gives %s", async (a, b, expected) => {
      const { id } = await insertSiteBackup(db, {
        siteId,
        kind: "manual",
        status: "running",
        operationId: `op_${randomUUID().replaceAll("-", "")}`,
        startedAt: new Date(),
      });
      const wanted = [a, b].filter((x): x is Outcome => x !== null);
      await insertSiteBackupCopies(
        db,
        id,
        `op_${randomUUID().replaceAll("-", "")}`,
        wanted.map((_, i) => ({ targetId: i === 0 ? local : s3, priority: i + 1, required: true })),
      );
      const copies = await copiesOf(id);
      for (const [i, outcome] of wanted.entries()) {
        if (outcome === "succeeded") {
          await settleSiteBackupCopy(db, copies[i]!.id, { status: "succeeded", snapshotId: i === 0 ? SNAP_LOCAL : SNAP_S3, sizeBytes: 1 });
        } else if (outcome === "failed") {
          await settleSiteBackupCopy(db, copies[i]!.id, { status: "failed", problem: "other" });
        }
      }
      expect(await settleSiteBackupAggregate(db, id)).toBe(expected);
      expect((await db.select().from(siteBackups).where(eq(siteBackups.id, id)))[0]!.status).toBe(expected);
    });
  });

  describe("BKP-09: retention is independent per target with two targets", () => {
    it("forgets the old snapshot on each target with its own job id and keeps the fresh two-copy backup", async () => {
      await updatePolicySettings(db, "default_site", { retentionDays: 1 }, adminId);
      const oldLocal = "1".repeat(64);
      const oldS3 = "2".repeat(64);
      const { op: createOp } = await create("k-dual-retention");
      await applier.apply(createOp);
      const fresh = (await backupOf(createOp.id)).id;
      const old = await seedBackup(new Date(Date.now() - 10 * DAY), [
        { targetId: local, snapshotId: oldLocal },
        { targetId: s3, snapshotId: oldS3 },
      ]);
      calls.length = 0;

      const prune = await enqueuePrune();
      await applier.apply(prune);

      const sent = forgets();
      expect(sent).toHaveLength(2);
      const onLocal = sent.find((f) => isLocal(f.target))!;
      const onS3 = sent.find((f) => !isLocal(f.target))!;
      expect(onLocal.snapshotIds).toEqual([oldLocal]);
      expect(onS3.snapshotIds).toEqual([oldS3]);
      expect(new Set(sent.map((f) => f.jobId))).toEqual(new Set([`${prune.id}-forget`, `${prune.id}-forget-t2`]));
      expect(await db.select({ id: siteBackups.id }).from(siteBackups).where(eq(siteBackups.id, old))).toEqual([]);
      expect(await copiesOf(fresh)).toHaveLength(2);
    });

    it("keeps one target's old copy when its forget fails, without blocking the other target", async () => {
      await updatePolicySettings(db, "default_site", { retentionDays: 1 }, adminId);
      const { op: createOp } = await create("k-dual-retention-2");
      await applier.apply(createOp);
      const old = await seedBackup(new Date(Date.now() - 10 * DAY), [
        { targetId: local, snapshotId: "3".repeat(64) },
        { targetId: s3, snapshotId: "4".repeat(64) },
      ]);
      forgetFails = (req) => isLocal(req.target);

      await applier.apply(await enqueuePrune());

      expect((await copiesOf(old)).map((c) => c.targetId)).toEqual([local]);
      expect(await db.select({ id: siteBackups.id }).from(siteBackups).where(eq(siteBackups.id, old))).toHaveLength(1);
    });
  });
});
