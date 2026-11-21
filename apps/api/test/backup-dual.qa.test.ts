import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  SiteBackupsDtoSchema,
  WORDPRESS_IMPORT_KIND,
  type BackupJobStatus,
  type BackupKind,
  type BackupsIpcRequest,
} from "@hosting-panel/contracts";
import {
  auditEvents,
  backupTargets,
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
  operationSteps,
  operations,
  organizations,
  platformInstallations,
  settleSiteBackupAggregate,
  settleSiteBackupCopy,
  siteBackupCopies,
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
import { BackupPoliciesService } from "../src/backups/backup-policies.service.js";
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
import { AdminHealthService } from "../src/health/admin-health.service.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";

vi.mock("../src/sites/site-files.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sites/site-files.service.js")>();
  return { ...actual, resolveSiteFilesServiceId: async () => "svc_dual_qa" };
});

const KEY = Buffer.alloc(32, 9);
const SNAP_LOCAL = "a".repeat(64);
const SNAP_S3 = "b".repeat(64);
const DAY = 86_400_000;
const HOUR = 3_600_000;
const S3_SECRET = "canary-dual-qa-secret";
const RECIPIENT = `age1${"q".repeat(58)}`;
const ambiguous = () => Object.assign(new Error("timeout"), { code: "OPERATION_AMBIGUOUS", ambiguousOutcome: true });
const snap = (c: string) => c.repeat(64);

type StartReq = Extract<BackupsIpcRequest, { action: "start" }>;
type ForgetReq = Extract<BackupsIpcRequest, { action: "forget" }>;
type Kind = "local" | "s3";
interface SeedCopy {
  readonly targetId: string;
  readonly snapshotId?: string;
  readonly outcome?: "succeeded" | "failed" | "running";
}

describe("QA: two destinations per policy, partial and per-target retention (BKP-07, BKP-08, BKP-09)", () => {
  let dbClient: DatabaseClient;
  let db: HostingPanelDatabase;
  let app: ControlPlaneAppHandle;
  let applier: SiteBackupsApplier;
  let service: SiteBackupsService;
  let restoreService: SiteRestoreService;
  let policies: BackupPoliciesService;
  let health: AdminHealthService;
  let adminId: string;
  let customerId: string;
  let orgId: string;
  let siteId: string;
  let site: BackupSiteRef & { name: string };
  let s3: string;
  let local: string;
  const calls: BackupsIpcRequest[] = [];
  const statusAnswers = new Map<string, BackupJobStatus | Error>();
  const startErrors = new Map<string, Error>();
  const startKinds = new Map<string, Kind>();
  const forgetKinds = new Map<string, Kind>();
  let forgetStartFails: (kind: Kind) => boolean = () => false;
  let forgetStateFails: (kind: Kind) => boolean = () => false;

  const customer = (): SiteBackupActor => ({
    auth: { user: { id: customerId } } as unknown as SiteBackupActor["auth"],
    req: { headers: {}, ip: "127.0.0.1" } as unknown as FastifyRequest,
  });
  const kindOf = (target: object): Kind => ("kind" in target ? "local" : "s3");
  const dispatches = () => calls.filter((c): c is StartReq => c.action === "start");
  const forgets = () => calls.filter((c): c is ForgetReq => c.action === "forget");
  const failedStatus = (jobId: string, failure: string = "unreachable"): BackupJobStatus =>
    ({ jobId, state: "failed", failure, snapshot: null }) as BackupJobStatus;
  const stateStatus = (jobId: string, state: "running" | "unknown"): BackupJobStatus => ({
    jobId,
    state,
    failure: null,
    snapshot: null,
  });

  const claim = async (opId: string, kind: BackupOperationRef["kind"] = "site.backups.create"): Promise<BackupOperationRef> => {
    await db
      .update(operations)
      .set({ status: "processing", leaseExpiresAt: new Date(Date.now() + BACKUP_LEASE_MS) })
      .where(eq(operations.id, opId));
    return { id: opId, organizationId: orgId, kind, resourceId: siteId };
  };
  const copiesOf = async (backupId: string) => (await listSiteBackupCopies(db, [backupId])).get(backupId) ?? [];
  const backupOf = async (opId: string) => (await db.select().from(siteBackups).where(eq(siteBackups.operationId, opId)))[0]!;
  const backupById = async (id: string) => (await db.select().from(siteBackups).where(eq(siteBackups.id, id)))[0];
  const opRow = async (opId: string) => (await db.select().from(operations).where(eq(operations.id, opId)))[0]!;
  const stepsOf = async (opId: string) =>
    Object.fromEntries(
      (await db.select().from(operationSteps).where(eq(operationSteps.operationId, opId))).map((s) => [s.key, s.status]),
    );
  let baselineAuditIds = new Set<string>();
  const audits = async (action: string) =>
    (await db.select().from(auditEvents)).filter((r) => !baselineAuditIds.has(r.id) && r.action === action);
  const nonStatusCalls = () => calls.filter((c) => c.action !== "status");

  const create = async (key: string) => {
    const accepted = await service.create(site, customer(), key);
    return { accepted, op: await claim(accepted.operationId) };
  };
  const enqueueGating = async (kind: BackupOperationRef["kind"]) => {
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
  const prune = async () => {
    calls.length = 0;
    const op = await enqueuePrune();
    await applier.apply(op);
    return op;
  };

  /** A finished logical backup with the given copies, written straight to the ledger. */
  const seed = async (startedAt: Date, kind: BackupKind, copies: readonly SeedCopy[]) => {
    const { id } = await insertSiteBackup(db, {
      siteId,
      kind,
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
    const rows = await copiesOf(id);
    for (const [i, c] of copies.entries()) {
      const outcome = c.outcome ?? "succeeded";
      if (outcome === "succeeded") {
        await settleSiteBackupCopy(db, rows[i]!.id, { status: "succeeded", snapshotId: c.snapshotId ?? snap("e"), sizeBytes: 100 });
      } else if (outcome === "failed") {
        await settleSiteBackupCopy(db, rows[i]!.id, { status: "failed", problem: "other" });
      }
    }
    await settleSiteBackupAggregate(db, id);
    return id;
  };

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    db = dbClient.db;
    await dbClient.migrate();
    await setupInstallation(db, { installationName: "DualQa", hostHostname: "panel.test", hostIpv4: "10.0.0.1" });
    adminId = (await createServerAdmin(db, KEY, { email: "admin-dualqa@x.it", name: "Admin", password: "correct horse battery" })).userId;
    customerId = `usr_${randomUUID()}`;
    await db.insert(users).values({ id: customerId, email: "customer-dualqa@x.it", name: "Customer", passwordHash: "x" });
    const [inst] = await db.select().from(platformInstallations).limit(1);
    const hostId = `hst_${randomUUID()}`;
    await db.insert(hosts).values({
      id: hostId,
      platformInstallationId: inst!.id,
      name: "dualqa.test",
      hostname: "dualqa.test",
      ipv4Address: "10.0.0.9",
      hostingMode: "dedicated",
      totalCpuMilli: 4000,
      totalMemoryBytes: "8589934592",
      totalStorageBytes: "107374182400",
    });
    orgId = `org_${randomUUID()}`;
    await db.insert(organizations).values({ id: orgId, platformInstallationId: inst!.id, name: "DualQa Org", slug: "dualqa-org" });
    const allocId = `alloc_${randomUUID()}`;
    await db.insert(hostAllocations).values({ id: allocId, hostId, organizationId: orgId, status: "active" });
    siteId = `sit_${randomUUID()}`;
    await db.insert(sites).values({
      id: siteId,
      organizationId: orgId,
      hostAllocationId: allocId,
      name: "Dual Qa Site",
      slug: "dual-qa-site",
      status: "ready",
      siteType: "wordpress",
    });
    site = { id: siteId, organizationId: orgId, status: "ready", name: "Dual Qa Site" };

    s3 = (
      await insertS3Target(db, KEY, {
        name: "Off-server",
        endpoint: "https://s3.example.com",
        region: "eu-south-1",
        bucket: "bucket-dual-qa",
        prefix: "panel",
        accessKeyId: "AKIADUALQA",
        secretAccessKey: S3_SECRET,
        customerSelectable: true,
        actorId: adminId,
      })
    ).id;
    local = (await insertLocalTarget(db, { name: "This server", customerSelectable: true, actorId: adminId })).id;

    const sim = new InMemoryDockerSimulatorAdapter();
    sim.backups = (async (req: BackupsIpcRequest) => {
      calls.push(req);
      switch (req.action) {
        case "start": {
          const err = startErrors.get(req.jobId);
          if (err) throw err;
          startKinds.set(req.jobId, kindOf(req.target));
          return { jobId: req.jobId, state: "running", failure: null, snapshot: null };
        }
        case "forget": {
          forgetKinds.set(req.jobId, kindOf(req.target));
          if (forgetStartFails(kindOf(req.target))) throw new Error("repository unavailable");
          return { jobId: req.jobId, state: "running", failure: null, snapshot: null };
        }
        case "status": {
          const answer = statusAnswers.get(req.jobId);
          if (answer instanceof Error) throw answer;
          if (answer) return answer;
          if (/-forget(-t[2-9])?$/.test(req.jobId)) {
            const kind = forgetKinds.get(req.jobId);
            if (kind && forgetStateFails(kind)) return failedStatus(req.jobId, "other");
            return { jobId: req.jobId, state: "succeeded", failure: null, snapshot: null };
          }
          const kind: Kind = startKinds.get(req.jobId) ?? (req.jobId.endsWith("-t2") ? "s3" : "local");
          return {
            jobId: req.jobId,
            state: "succeeded",
            failure: null,
            snapshot: { snapshotId: kind === "local" ? SNAP_LOCAL : SNAP_S3, bytesAdded: 1, totalBytes: 4096, fileCount: 3, durationMs: 10 },
          };
        }
        default:
          throw new Error(`Unexpected backup action in test stub: ${req.action}`);
      }
    }) as DockerExecutorPort["backups"];

    const register = AppModule.register.bind(AppModule);
    vi.spyOn(AppModule, "register").mockImplementation((options) => {
      const mod = register(options);
      const controllers = mod.controllers ?? [];
      const providers = mod.providers ?? [];
      return {
        ...mod,
        controllers: controllers.includes(AdminBackupPoliciesController) ? controllers : [...controllers, AdminBackupPoliciesController],
        providers: providers.includes(BackupPoliciesService) ? providers : [...providers, BackupPoliciesService],
      };
    });
    app = await createControlPlaneApp({
      listen: false,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      jwtSigningKeyPem: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
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
    health = app.nestApp.get(AdminHealthService);
    policies = new BackupPoliciesService(dbClient);
  });

  afterAll(async () => {
    await app.close();
    await dbClient.close();
  });

  beforeEach(async () => {
    calls.length = 0;
    statusAnswers.clear();
    startErrors.clear();
    startKinds.clear();
    forgetKinds.clear();
    forgetStartFails = () => false;
    forgetStateFails = () => false;
    applier.pollDeadlineMs = 6 * 3_600_000;
    await db.delete(siteBackups);
    await db.delete(operations);
    baselineAuditIds = new Set((await db.select({ id: auditEvents.id }).from(auditEvents)).map((r) => r.id));
    await db.update(sites).set({ status: "ready" }).where(eq(sites.id, siteId));
    await db.update(backupTargets).set({ enabled: true, customerSelectable: true, archivedAt: null }).where(eq(backupTargets.id, local));
    await db.update(backupTargets).set({ enabled: true, customerSelectable: true, archivedAt: null }).where(eq(backupTargets.id, s3));
    await updatePolicySettings(db, "default_site", { retentionDays: 14 }, adminId);
    await policies.update("default_site", { targetIds: [local, s3] }, adminId);
    await policies.updateSitePolicy(site, { targetIds: null }, customer());
  });

  // ----------------------------------------------------------------------------------------------------- BKP-07

  describe("BKP-07: both copies succeed", () => {
    it("is one operation and one logical backup, each copy sent to its own repository, one after the other", async () => {
      const { accepted, op } = await create("qa-both-1");
      await applier.apply(op);

      expect(await db.select().from(operations).where(eq(operations.kind, "site.backups.create"))).toHaveLength(1);
      expect(await db.select().from(siteBackups)).toHaveLength(1);
      const [first, second] = dispatches();
      expect(first!.target).toEqual({ kind: "local", targetId: local });
      expect(second!.target).toMatchObject({ bucket: "bucket-dual-qa", accessKeyId: "AKIADUALQA" });
      // The local job never receives the S3 credentials.
      expect(JSON.stringify(first)).not.toContain(S3_SECRET);
      // The same logical backup: same site, service and type for both jobs.
      expect({ s: first!.siteId, v: first!.serviceInstanceId, t: first!.siteType }).toEqual({
        s: second!.siteId,
        v: second!.serviceInstanceId,
        t: second!.siteType,
      });
      // Sequential: the first job's status is read before the second one starts.
      expect(calls.map((c) => `${c.action}:${(c as { jobId: string }).jobId}`)).toEqual([
        `start:${op.id}`,
        `status:${op.id}`,
        `start:${op.id}-t2`,
        `status:${op.id}-t2`,
      ]);

      const backup = await backupOf(accepted.operationId);
      expect(backup).toMatchObject({ status: "succeeded", snapshotId: SNAP_LOCAL, problem: null });
      const copies = await copiesOf(backup.id);
      expect(copies.map((c) => [c.targetId, c.snapshotId])).toEqual([
        [local, SNAP_LOCAL],
        [s3, SNAP_S3],
      ]);
      expect(copies.every((c) => c.problem === null && c.finishedAt !== null)).toBe(true);
      expect(await stepsOf(op.id)).toEqual({ backup: "succeeded", retention: "succeeded" });
      expect(await audits("site.backups.partial")).toEqual([]);
    });

    it("keeps one copy per destination when the same Idempotency-Key is replayed, and one create audit", async () => {
      const a = await service.create(site, customer(), "qa-replay");
      const b = await service.create(site, customer(), "qa-replay");
      expect(b).toEqual(a);
      expect(await db.select().from(siteBackups)).toHaveLength(1);
      expect(await db.select().from(siteBackupCopies)).toHaveLength(2);
      expect(await audits("site.backups.create")).toHaveLength(1);
    });

    it("counts one heavy action per logical backup: six requests pass with two copies each, the seventh is refused", async () => {
      for (let i = 0; i < 6; i += 1) {
        const accepted = await service.create(site, customer(), `qa-cap-${String(i)}`);
        await db.update(operations).set({ status: "succeeded" }).where(eq(operations.id, accepted.operationId));
      }
      await expect(service.create(site, customer(), "qa-cap-6")).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
      expect(await db.select().from(operations).where(eq(operations.kind, "site.backups.create"))).toHaveLength(6);
      expect(await db.select().from(siteBackupCopies)).toHaveLength(12);
      // A single requested destination is the same single operation.
      expect(await db.select().from(siteBackups)).toHaveLength(6);
    });

    it("a customer who names one destination of a two-destination site gets one copy and a plain succeeded", async () => {
      const accepted = await service.create(site, customer(), "qa-one-of-two", { targetId: s3 });
      const op = await claim(accepted.operationId);
      await applier.apply(op);
      const backup = await backupOf(op.id);
      expect(backup.status).toBe("succeeded");
      expect((await copiesOf(backup.id)).map((c) => [c.targetId, c.jobId])).toEqual([[s3, op.id]]);
      expect(dispatches()).toHaveLength(1);
    });
  });

  // ----------------------------------------------------------------------------------------------------- BKP-08

  describe("BKP-08: a destination fails, the backup is partial", () => {
    it.each(["local_target_unmounted", "no_space", "local_target_readonly", "local_target_unsafe"] as const)(
      "the second copy (local) fails with %s: partial, operation succeeded, list, audit and alert show it",
      async (failure) => {
        await policies.updateSitePolicy(site, { targetIds: [s3, local] }, customer());
        const { op } = await create(`qa-partial-${failure}`);
        statusAnswers.set(`${op.id}-t2`, failedStatus(`${op.id}-t2`, failure));
        await applier.apply(op);

        const backup = await backupOf(op.id);
        expect(backup).toMatchObject({ status: "partial", snapshotId: SNAP_S3, problem: failure });
        expect((await copiesOf(backup.id)).map((c) => [c.targetKind, c.status, c.problem])).toEqual([
          ["s3", "succeeded", null],
          ["local", "failed", failure],
        ]);
        expect(await opRow(op.id)).toMatchObject({ status: "succeeded", errorCode: null });
        expect(await stepsOf(op.id)).toEqual({ backup: "succeeded", retention: "succeeded" });

        const listed = SiteBackupsDtoSchema.parse(await service.list(site));
        expect(listed.backups).toHaveLength(1);
        expect(listed.backups[0]).toMatchObject({ status: "partial", problem: failure });
        expect(listed.backups[0]!.copies.map((c) => [c.kind, c.status, c.problem])).toEqual([
          ["s3", "succeeded", null],
          ["local", "failed", failure],
        ]);
        const wire = JSON.stringify(listed);
        for (const leak of [S3_SECRET, "bucket-dual-qa", "AKIADUALQA", "https://s3.example.com"]) {
          expect(wire).not.toContain(leak);
        }

        const partial = await audits("site.backups.partial");
        expect(partial).toHaveLength(1);
        expect(partial[0]).toMatchObject({ organizationId: orgId, targetId: siteId, actorType: "system" });
        expect(partial[0]!.details).toMatchObject({ backupId: backup.id });
        expect(await audits("site.backups.copy_failed")).toHaveLength(1);
        expect((await audits("site.backups.copy_failed"))[0]!.details).toMatchObject({ targetId: local, targetKind: "local", problem: failure });

        const alerts = (await health.alerts()).filter((a) => a.kind === "backup_partial" || a.kind === "backup_failed");
        expect(alerts.map((a) => a.kind)).toEqual(["backup_partial"]);
        expect(alerts[0]!.details).toMatchObject({ siteId, backupId: backup.id });
      },
    );

    it("an executor failure class it does not know becomes 'other', never a raw string", async () => {
      const { op } = await create("qa-unknown-class");
      statusAnswers.set(`${op.id}-t2`, failedStatus(`${op.id}-t2`, "/var/lib/hosting-panel/secret-path exploded"));
      await applier.apply(op);
      const backup = await backupOf(op.id);
      expect(backup).toMatchObject({ status: "partial", problem: "other" });
      expect(JSON.stringify(await copiesOf(backup.id))).not.toContain("/var/lib");
    });

    it("the first copy fails and the second succeeds: partial; the good copy downloads, the failed one is refused", async () => {
      const { op } = await create("qa-first-fails");
      statusAnswers.set(op.id, failedStatus(op.id, "local_target_unmounted"));
      await applier.apply(op);
      const backup = await backupOf(op.id);
      expect(backup).toMatchObject({ status: "partial", snapshotId: SNAP_S3, problem: "local_target_unmounted" });
      expect(await opRow(op.id)).toMatchObject({ status: "succeeded" });

      await expect(
        restoreService.prepareDownload(site, customer(), backup.id, "qa-dl-bad", { targetId: local }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      const accepted = await restoreService.prepareDownload(site, customer(), backup.id, "qa-dl-good");
      expect((await opRow(accepted.operationId)).kind).toBe("site.backups.download");
      expect((await backupById(backup.id))!.archiveTargetId).toBe(s3);
      // The encrypted export stays refused on a partial backup as on any other.
      await expect(
        restoreService.prepareDownload(site, customer(), backup.id, "qa-dl-age", { format: "zip.age", recipient: RECIPIENT }),
      ).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    });

    it("a partial backup restores by default from its good copy and an admin restore of the failed copy is a 404", async () => {
      const { op } = await create("qa-restore-partial");
      statusAnswers.set(op.id, failedStatus(op.id, "no_space"));
      await applier.apply(op);
      const backup = await backupOf(op.id);
      const accepted = await restoreService.restore(site, customer(), backup.id, { confirmName: "Dual Qa Site" }, "qa-rst");
      expect((await backupById(backup.id))!.restoreTargetId).toBe(s3);
      expect((await opRow(accepted.operationId)).kind).toBe("site.backups.restore");
      await db.update(operations).set({ status: "succeeded" }).where(eq(operations.id, accepted.operationId));
      await db.update(siteBackups).set({ restoreStatus: null }).where(eq(siteBackups.id, backup.id));
      await expect(
        restoreService.restore(site, customer(), backup.id, { confirmName: "Dual Qa Site", targetId: local }, "qa-rst-bad"),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("the executor refusing the first start with RESOURCE_LOCKED fails only that copy as site_busy; the second still runs", async () => {
      const { op } = await create("qa-locked");
      startErrors.set(op.id, Object.assign(new Error("busy"), { code: "RESOURCE_LOCKED" }));
      await applier.apply(op);
      const backup = await backupOf(op.id);
      expect(backup).toMatchObject({ status: "partial", problem: "site_busy", snapshotId: SNAP_S3 });
      // The refused attempt was made, the second copy still ran.
      expect(dispatches().map((d) => d.jobId)).toEqual([op.id, `${op.id}-t2`]);
      expect((await copiesOf(backup.id)).map((c) => [c.status, c.problem])).toEqual([
        ["failed", "site_busy"],
        ["succeeded", null],
      ]);
    });

    it("both executors refusing the start fails the backup and the operation, leaves no copy running and no partial audit", async () => {
      const { op } = await create("qa-both-refused");
      startErrors.set(op.id, new Error("executor refused"));
      startErrors.set(`${op.id}-t2`, new Error("executor refused"));
      await expect(applier.apply(op)).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
      const backup = await backupOf(op.id);
      expect(backup).toMatchObject({ status: "failed", snapshotId: null });
      expect((await copiesOf(backup.id)).map((c) => c.status)).toEqual(["failed", "failed"]);
      expect(await opRow(op.id)).toMatchObject({ status: "failed" });
      expect(await stepsOf(op.id)).toEqual({ backup: "failed", retention: "skipped" });
      expect(await audits("site.backups.partial")).toEqual([]);
      const kinds = (await health.alerts()).map((a) => a.kind);
      expect(kinds).toContain("backup_failed");
      expect(kinds).not.toContain("backup_partial");
    });

    it("the partial alert follows the latest attempt: a later two-copy success clears it", async () => {
      const first = await create("qa-alert-1");
      statusAnswers.set(`${first.op.id}-t2`, failedStatus(`${first.op.id}-t2`));
      await applier.apply(first.op);
      expect((await health.alerts()).filter((a) => a.kind === "backup_partial")).toHaveLength(1);

      const second = await create("qa-alert-2");
      await applier.apply(second.op);
      expect((await backupOf(second.op.id)).status).toBe("succeeded");
      const kinds = (await health.alerts()).map((a) => a.kind);
      expect(kinds).not.toContain("backup_partial");
      expect(kinds).not.toContain("backup_failed");
    });

    // Documented rule (ADR-0032): a destination the administrator disabled is not required for new backups; partial covers
    // runtime failures (unmounted, unreachable, full) of destinations that are enabled.
    it("a destination the administrator disabled is not required (ADR-0032): succeeded with one copy, no copy row, no alert", async () => {
      await db.update(backupTargets).set({ enabled: false }).where(eq(backupTargets.id, local));
      const { op } = await create("qa-disabled");
      await applier.apply(op);
      const backup = await backupOf(op.id);
      expect(backup.status).toBe("succeeded");
      expect((await copiesOf(backup.id)).map((c) => [c.targetId, c.status, c.problem])).toEqual([[s3, "succeeded", null]]);
      expect((await health.alerts()).filter((a) => a.kind === "backup_partial")).toHaveLength(0);
  });
  });

  // ------------------------------------------------------------------------ changes that need a full backup

  describe("a change that needs a protective backup refuses partial and failed", () => {
    const kinds: readonly BackupOperationRef["kind"][] = ["site.wordpress.update", WORDPRESS_IMPORT_KIND];

    it.each(kinds)("%s: a partial backup (second copy fails) stops the change and keeps the good copy", async (kind) => {
      const op = await enqueueGating(kind);
      statusAnswers.set(`${op.id}-t2`, failedStatus(`${op.id}-t2`, "no_space"));
      await expect(applier.runBackupStep(op)).rejects.toMatchObject({ code: "INTERNAL_ERROR", message: "Backup did not finish." });
      const backup = await backupOf(op.id);
      expect(backup).toMatchObject({ status: "partial", snapshotId: SNAP_LOCAL });
      expect((await copiesOf(backup.id)).map((c) => [c.targetKind, c.status])).toEqual([
        ["local", "succeeded"],
        ["s3", "failed"],
      ]);
      expect(await opRow(op.id)).toMatchObject({ status: "failed", errorCode: "INTERNAL_ERROR" });
      expect((await stepsOf(op.id)).backup).toBe("failed");

      // The good copy survives a prune and is still restorable.
      const pruneOp = await prune();
      expect(forgets()).toEqual([]);
      expect((await opRow(pruneOp.id)).status).toBe("succeeded");
      expect((await copiesOf(backup.id)).map((c) => c.status)).toEqual(["succeeded", "failed"]);
      await restoreService.restore(site, customer(), backup.id, { confirmName: "Dual Qa Site" }, `qa-gate-restore-${kind}`);
      expect((await backupById(backup.id))!.restoreTargetId).toBe(local);
    });

    it.each(kinds)("%s: the first copy fails and the second succeeds is still refused", async (kind) => {
      const op = await enqueueGating(kind);
      statusAnswers.set(op.id, failedStatus(op.id, "local_target_unmounted"));
      await expect(applier.runBackupStep(op)).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
      const backup = await backupOf(op.id);
      expect(backup).toMatchObject({ status: "partial", snapshotId: SNAP_S3 });
      expect((await opRow(op.id)).status).toBe("failed");
    });

    it.each(kinds)("%s: both copies failing is refused with the failure and no good copy", async (kind) => {
      const op = await enqueueGating(kind);
      statusAnswers.set(op.id, failedStatus(op.id));
      statusAnswers.set(`${op.id}-t2`, failedStatus(`${op.id}-t2`));
      await expect(applier.runBackupStep(op)).rejects.toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE" });
      expect(await backupOf(op.id)).toMatchObject({ status: "failed", snapshotId: null });
      expect((await opRow(op.id)).status).toBe("failed");
    });

    it.each(kinds)("%s: two good copies let the change proceed", async (kind) => {
      const op = await enqueueGating(kind);
      await applier.runBackupStep(op);
      expect((await backupOf(op.id)).status).toBe("succeeded");
      expect((await opRow(op.id)).status).not.toBe("failed");
    });

    it("recovery of a gating operation with one copy settled and the other lost is refused, without starting anything", async () => {
      const op = await enqueueGating(WORDPRESS_IMPORT_KIND);
      const backup = await backupOf(op.id);
      await settleSiteBackupCopy(db, (await copiesOf(backup.id))[0]!.id, { status: "succeeded", snapshotId: SNAP_LOCAL, sizeBytes: 1 });
      statusAnswers.set(`${op.id}-t2`, stateStatus(`${op.id}-t2`, "unknown"));
      const settled = await applier.settleBackupJob(op.id);
      expect(settled).toMatchObject({ code: "OPERATION_INTERRUPTED" });
      expect((await backupOf(op.id)).status).toBe("partial");
      expect(nonStatusCalls()).toEqual([]);
    });
  });

  // ----------------------------------------------------------------------------------------- BKP-14 on two copies

  describe("executor restart or outage with two copies (recovery is read-only)", () => {
    it("an ambiguous second start leaves the first copy settled and the second open; recovery then completes BOTH as succeeded", async () => {
      const { op } = await create("qa-amb");
      startErrors.set(`${op.id}-t2`, ambiguous());
      await expect(applier.apply(op)).rejects.toMatchObject({ code: "OPERATION_AMBIGUOUS" });
      const backup = await backupOf(op.id);
      expect(backup.status).toBe("running");
      expect((await copiesOf(backup.id)).map((c) => c.status)).toEqual(["succeeded", "running"]);
      startErrors.clear();
      calls.length = 0;

      expect(await applier.recover(op)).toBe("settled");

      expect(calls).toEqual([{ action: "status", jobId: `${op.id}-t2` }]);
      expect((await backupById(backup.id))!.status).toBe("succeeded");
      expect((await copiesOf(backup.id)).map((c) => [c.status, c.snapshotId])).toEqual([
        ["succeeded", SNAP_LOCAL],
        ["succeeded", SNAP_S3],
      ]);
      expect(await opRow(op.id)).toMatchObject({ status: "succeeded" });
      expect(await audits("site.backups.copy_succeeded")).toHaveLength(2);
    });

    it("an executor that restarted and lost both jobs fails both copies as interrupted and the operation as interrupted", async () => {
      const { op } = await create("qa-lost-both");
      statusAnswers.set(op.id, stateStatus(op.id, "unknown"));
      statusAnswers.set(`${op.id}-t2`, stateStatus(`${op.id}-t2`, "unknown"));
      expect(await applier.recover(op)).toBe("settled");
      const backup = await backupOf(op.id);
      expect(backup).toMatchObject({ status: "failed", problem: "interrupted" });
      expect((await copiesOf(backup.id)).map((c) => [c.status, c.problem])).toEqual([
        ["failed", "interrupted"],
        ["failed", "interrupted"],
      ]);
      expect(await opRow(op.id)).toMatchObject({ status: "failed", errorCode: "OPERATION_INTERRUPTED" });
      expect(nonStatusCalls()).toEqual([]);
    });

    it("an unreachable executor leaves everything untouched; the next pass settles only what is still open", async () => {
      const { op } = await create("qa-outage");
      statusAnswers.set(op.id, new Error("executor unreachable"));
      expect(await applier.recover(op)).toBe("pending");
      const backup = await backupOf(op.id);
      expect(backup.status).toBe("running");
      expect((await copiesOf(backup.id)).map((c) => c.status)).toEqual(["running", "running"]);
      expect(await audits("site.backups.copy_succeeded")).toEqual([]);

      statusAnswers.delete(op.id);
      statusAnswers.set(`${op.id}-t2`, stateStatus(`${op.id}-t2`, "running"));
      expect(await applier.recover(op)).toBe("pending");
      // Progress is kept: the first copy is settled, only the second is still open.
      expect((await copiesOf(backup.id)).map((c) => c.status)).toEqual(["succeeded", "running"]);
      expect((await backupById(backup.id))!.status).toBe("running");

      calls.length = 0;
      statusAnswers.clear();
      expect(await applier.recover(op)).toBe("settled");
      expect(calls).toEqual([{ action: "status", jobId: `${op.id}-t2` }]);
      expect((await backupById(backup.id))!.status).toBe("succeeded");
      expect(nonStatusCalls()).toEqual([]);
    });

    it("a copy still running past the poll deadline is failed as a timeout while the settled one is kept: partial", async () => {
      const { op } = await create("qa-deadline");
      statusAnswers.set(`${op.id}-t2`, stateStatus(`${op.id}-t2`, "running"));
      applier.pollDeadlineMs = -1;
      expect(await applier.recover(op)).toBe("settled");
      const backup = await backupOf(op.id);
      expect(backup).toMatchObject({ status: "partial", problem: "timeout", snapshotId: SNAP_LOCAL });
      expect(nonStatusCalls()).toEqual([]);
      expect(await opRow(op.id)).toMatchObject({ status: "succeeded" });
    });

    it("each copy gets its own deadline from when the one before it finished, not from the operation start", async () => {
      const { op } = await create("qa-deadline-own");
      await db.update(operations).set({ startedAt: new Date(Date.now() - 7 * HOUR) }).where(eq(operations.id, op.id));
      statusAnswers.set(`${op.id}-t2`, stateStatus(`${op.id}-t2`, "running"));
      expect(await applier.recover(op)).toBe("pending");
      const backup = await backupOf(op.id);
      expect(backup.status).toBe("running");
      expect((await copiesOf(backup.id)).map((c) => c.status)).toEqual(["succeeded", "running"]);
    });

    it("recovering twice does not write a second audit or change the outcome", async () => {
      const { op } = await create("qa-twice");
      statusAnswers.set(`${op.id}-t2`, stateStatus(`${op.id}-t2`, "unknown"));
      expect(await applier.recover(op)).toBe("settled");
      const copyFailed = (await audits("site.backups.copy_failed")).length;
      const copyOk = (await audits("site.backups.copy_succeeded")).length;
      statusAnswers.clear();
      await applier.recover(op).catch(() => undefined);
      expect(await audits("site.backups.copy_failed")).toHaveLength(copyFailed);
      expect(await audits("site.backups.copy_succeeded")).toHaveLength(copyOk);
      expect((await backupOf(op.id)).status).toBe("partial");
      expect((await copiesOf((await backupOf(op.id)).id)).map((c) => c.status)).toEqual(["succeeded", "failed"]);
    });

    it("recovery of a partial backup writes the same site.backups.partial audit as the normal path", async () => {
      const { op } = await create("qa-recover-audit");
      statusAnswers.set(`${op.id}-t2`, stateStatus(`${op.id}-t2`, "unknown"));
      expect(await applier.recover(op)).toBe("settled");
      expect((await backupOf(op.id)).status).toBe("partial");
      expect(await audits("site.backups.partial")).toHaveLength(1);
    });
  });

  // ----------------------------------------------------------------------------------------------------- BKP-09

  describe("BKP-09: retention with two targets", () => {
    const fresh = () => new Date(Date.now() - HOUR);

    it("never forgets the last good copy of a target because the other target has newer ones", async () => {
      await updatePolicySettings(db, "default_site", { retentionDays: 1 }, adminId);
      const old = await seed(new Date(Date.now() - 10 * DAY), "nightly", [
        { targetId: local, snapshotId: snap("1") },
        { targetId: s3, snapshotId: snap("2") },
      ]);
      const newer = await seed(new Date(Date.now() - 2 * HOUR), "nightly", [
        { targetId: local, outcome: "failed" },
        { targetId: s3, snapshotId: snap("3") },
      ]);

      const op = await prune();

      expect(forgets().map((f) => [kindOf(f.target), f.snapshotIds])).toEqual([["s3", [snap("2")]]]);
      expect((await copiesOf(old)).map((c) => [c.targetKind, c.snapshotId])).toEqual([["local", snap("1")]]);
      expect((await backupById(old))!.status).toBe("succeeded");
      expect((await copiesOf(newer)).map((c) => c.status)).toEqual(["failed", "succeeded"]);
      expect((await opRow(op.id)).status).toBe("succeeded");
    });

    it("keeps the newest good copy on EACH target when everything is older than the retention", async () => {
      await updatePolicySettings(db, "default_site", { retentionDays: 1 }, adminId);
      const oldest = await seed(new Date(Date.now() - 11 * DAY), "nightly", [
        { targetId: local, snapshotId: snap("1") },
        { targetId: s3, snapshotId: snap("2") },
      ]);
      const newest = await seed(new Date(Date.now() - 10 * DAY), "nightly", [
        { targetId: local, snapshotId: snap("3") },
        { targetId: s3, snapshotId: snap("4") },
      ]);

      await prune();

      const sent = forgets();
      expect(sent).toHaveLength(2);
      // Each target is told only about its own snapshot ids, never the other repository's.
      expect(sent.find((f) => kindOf(f.target) === "local")!.snapshotIds).toEqual([snap("1")]);
      expect(sent.find((f) => kindOf(f.target) === "s3")!.snapshotIds).toEqual([snap("2")]);
      expect(await backupById(oldest)).toBeUndefined();
      expect(await copiesOf(newest)).toHaveLength(2);
    });

    it("counts the kept manual backups per target: a partial newest one does not push out the other target's last three", async () => {
      const m = async (hoursAgo: number, localOutcome: "succeeded" | "failed", n: string) =>
        seed(new Date(Date.now() - hoursAgo * HOUR), "manual", [
          { targetId: local, snapshotId: snap("abcdef"[Number(n)]!), outcome: localOutcome },
          { targetId: s3, snapshotId: snap(n) },
        ]);
      const m1 = await m(4, "succeeded", "1");
      await m(3, "succeeded", "2");
      await m(2, "succeeded", "3");
      await m(1, "failed", "4");

      await prune();

      // Local holds three good manual copies (kept); S3 holds four, so only its oldest goes.
      expect(forgets().map((f) => [kindOf(f.target), f.snapshotIds])).toEqual([["s3", [snap("1")]]]);
      expect((await copiesOf(m1)).map((c) => c.targetKind)).toEqual(["local"]);
    });

    it("a forget that the executor reports failed keeps only that target's copy; the other target is still cleaned", async () => {
      await updatePolicySettings(db, "default_site", { retentionDays: 1 }, adminId);
      const old = await seed(new Date(Date.now() - 10 * DAY), "nightly", [
        { targetId: local, snapshotId: snap("1") },
        { targetId: s3, snapshotId: snap("2") },
      ]);
      await seed(fresh(), "nightly", [
        { targetId: local, snapshotId: snap("3") },
        { targetId: s3, snapshotId: snap("4") },
      ]);
      forgetStateFails = (kind) => kind === "s3";

      const op = await prune();

      expect(forgets()).toHaveLength(2);
      expect((await copiesOf(old)).map((c) => [c.targetKind, c.snapshotId])).toEqual([["s3", snap("2")]]);
      expect((await opRow(op.id)).status).toBe("succeeded");

      // The next night it is retried against the same target only.
      forgetStateFails = () => false;
      await prune();
      expect(forgets().map((f) => [kindOf(f.target), f.snapshotIds])).toEqual([["s3", [snap("2")]]]);
      expect(await backupById(old)).toBeUndefined();
    });

    it("an expired failed copy is dropped without any forget, and the logical backup goes only with its last good copy", async () => {
      await updatePolicySettings(db, "default_site", { retentionDays: 1 }, adminId);
      const partial = await seed(new Date(Date.now() - 10 * DAY), "nightly", [
        { targetId: local, snapshotId: snap("1") },
        { targetId: s3, outcome: "failed" },
      ]);
      await seed(fresh(), "nightly", [
        { targetId: local, snapshotId: snap("3") },
        { targetId: s3, snapshotId: snap("4") },
      ]);

      await prune();

      expect(forgets().map((f) => [kindOf(f.target), f.snapshotIds])).toEqual([["local", [snap("1")]]]);
      expect(await backupById(partial)).toBeUndefined();
      expect(await copiesOf(partial)).toEqual([]);
    });

    it("never touches a copy that is still running, and keeps its logical backup", async () => {
      await updatePolicySettings(db, "default_site", { retentionDays: 1 }, adminId);
      const open = await seed(new Date(Date.now() - 10 * DAY), "nightly", [
        { targetId: local, snapshotId: snap("1") },
        { targetId: s3, outcome: "running" },
      ]);
      await seed(fresh(), "nightly", [
        { targetId: local, snapshotId: snap("3") },
        { targetId: s3, snapshotId: snap("4") },
      ]);

      await prune();

      expect(forgets().map((f) => [kindOf(f.target), f.snapshotIds])).toEqual([["local", [snap("1")]]]);
      expect((await copiesOf(open)).map((c) => [c.targetKind, c.status])).toEqual([["s3", "running"]]);
      expect(await backupById(open)).toBeDefined();
    });

    it("a disabled target is still cleaned on its own repository, and removed from the policy it is never mixed into the other", async () => {
      await updatePolicySettings(db, "default_site", { retentionDays: 1 }, adminId);
      const oldest = await seed(new Date(Date.now() - 11 * DAY), "nightly", [
        { targetId: local, snapshotId: snap("1") },
        { targetId: s3, snapshotId: snap("2") },
      ]);
      await seed(new Date(Date.now() - 10 * DAY), "nightly", [
        { targetId: local, snapshotId: snap("3") },
        { targetId: s3, snapshotId: snap("4") },
      ]);
      await db.update(backupTargets).set({ enabled: false }).where(eq(backupTargets.id, local));

      await prune();

      const sent = forgets();
      expect(sent.map((f) => [kindOf(f.target), f.snapshotIds]).sort()).toEqual([
        ["local", [snap("1")]],
        ["s3", [snap("2")]],
      ]);
      expect(await backupById(oldest)).toBeUndefined();
    });

    it("a prune does nothing when the executor cannot be reached for one target: the ledger keeps that copy", async () => {
      await updatePolicySettings(db, "default_site", { retentionDays: 1 }, adminId);
      const old = await seed(new Date(Date.now() - 10 * DAY), "nightly", [
        { targetId: local, snapshotId: snap("1") },
        { targetId: s3, snapshotId: snap("2") },
      ]);
      await seed(fresh(), "nightly", [
        { targetId: local, snapshotId: snap("3") },
        { targetId: s3, snapshotId: snap("4") },
      ]);
      forgetStartFails = (kind) => kind === "local";
      await prune();
      expect((await copiesOf(old)).map((c) => c.targetKind)).toEqual(["local"]);
    });
  });

  // ------------------------------------------------------------------------------ the customer chooses 'both'

  describe("a customer chooses 'both' only when the administrator offered both", () => {
    it("lists exactly the offered destinations and accepts both, in the customer's order", async () => {
      const policy = await policies.getSitePolicy(site);
      expect(policy.choices.map((c) => c.id).sort()).toEqual([local, s3].sort());
      expect(policy.inherited).toBe(true);
      const saved = await policies.updateSitePolicy(site, { targetIds: [s3, local] }, customer());
      expect(saved).toMatchObject({ targetIds: [s3, local], inherited: false });
      const { op } = await create("qa-both-choice");
      await applier.apply(op);
      const backup = await backupOf(op.id);
      expect((await copiesOf(backup.id)).map((c) => [c.targetId, c.jobId, c.status])).toEqual([
        [s3, op.id, "succeeded"],
        [local, `${op.id}-t2`, "succeeded"],
      ]);
    });

    it("refuses 'both' with the same 404 as an unknown id when the administrator offers only one, and changes nothing", async () => {
      await policies.updateSitePolicy(site, { targetIds: [s3] }, customer());
      await db.update(backupTargets).set({ customerSelectable: false }).where(eq(backupTargets.id, local));
      expect((await policies.getSitePolicy(site)).choices.map((c) => c.id)).toEqual([s3]);

      const auditsBefore = (await audits("site.backups.policy.update")).length;
      const notOffered = await policies.updateSitePolicy(site, { targetIds: [s3, local] }, customer()).catch((e: unknown) => e);
      const unknown = await policies
        .updateSitePolicy(site, { targetIds: [s3, `bkt_${"0".repeat(32)}`] }, customer())
        .catch((e: unknown) => e);
      expect(notOffered).toMatchObject({ code: "NOT_FOUND", message: "Backup destination not found" });
      expect(unknown).toMatchObject({ code: "NOT_FOUND", message: "Backup destination not found" });
      expect((await policies.getSitePolicy(site)).targetIds).toEqual([s3]);
      expect(await audits("site.backups.policy.update")).toHaveLength(auditsBefore);
    });

    it.each([
      ["a disabled destination", { enabled: false }],
      ["an archived destination", { enabled: false, customerSelectable: false, archivedAt: new Date() }],
    ])("refuses 'both' when one destination is %s", async (_n, patch) => {
      await db.update(backupTargets).set(patch).where(eq(backupTargets.id, local));
      await expect(policies.updateSitePolicy(site, { targetIds: [s3, local] }, customer())).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect((await policies.getSitePolicy(site)).choices.map((c) => c.id)).toEqual([s3]);
    });

    it("rejects a third destination, a repeated one and an empty list before touching the database", async () => {
      await policies.updateSitePolicy(site, { targetIds: [local] }, customer());
      for (const targetIds of [[local, s3, local], [s3, s3], []]) {
        await expect(policies.updateSitePolicy(site, { targetIds }, customer())).rejects.toMatchObject({ name: "ZodError" });
      }
      expect((await policies.getSitePolicy(site)).targetIds).toEqual([local]);
    });

    it("the administrator's default policy takes two distinct usable destinations and nothing else", async () => {
      await expect(policies.update("default_site", { targetIds: [local, local] }, adminId)).rejects.toMatchObject({ name: "ZodError" });
      await expect(policies.update("default_site", { targetIds: [local, s3, local] }, adminId)).rejects.toMatchObject({ name: "ZodError" });
      await db.update(backupTargets).set({ enabled: false }).where(eq(backupTargets.id, s3));
      await expect(policies.update("default_site", { targetIds: [local, s3] }, adminId)).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        message: "target_unavailable",
      });
      expect((await policies.get("default_site")).targets.map((t) => t.targetId)).toEqual([local, s3]);
      await policies.update("default_site", { targetIds: [s3] }, adminId).catch(() => undefined);
    });

    it("a customer who keeps 'both' after the administrator withdraws one option keeps getting two copies (pinned design)", async () => {
      await policies.updateSitePolicy(site, { targetIds: [s3, local] }, customer());
      await db.update(backupTargets).set({ customerSelectable: false }).where(eq(backupTargets.id, local));
      const { op } = await create("qa-withdrawn");
      await applier.apply(op);
      expect((await copiesOf((await backupOf(op.id)).id)).map((c) => c.targetId)).toEqual([s3, local]);
      // ...but the customer can no longer pick the withdrawn one again.
      await expect(policies.updateSitePolicy(site, { targetIds: [local, s3] }, customer())).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });
});
