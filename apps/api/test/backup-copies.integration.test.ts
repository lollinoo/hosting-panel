import { generateKeyPairSync, randomUUID } from "node:crypto";
import { SiteBackupsDtoSchema, type BackupJobStatus, type BackupsIpcRequest } from "@hosting-panel/contracts";
import {
  and,
  archiveBackupTarget,
  auditEvents,
  createDatabaseClient,
  enqueueOperationTransactional,
  eq,
  getPolicy,
  hostAllocations,
  hosts,
  insertLocalTarget,
  insertS3Target,
  LEGACY_BACKUP_TARGET_ID,
  insertSiteBackup,
  insertSiteBackupCopies,
  listSiteBackupCopies,
  operationSteps,
  operations,
  organizations,
  outboxEvents,
  platformInstallations,
  setPolicyTargets,
  upsertBackupSettings,
  settleSiteBackup,
  settleSiteBackupAggregate,
  settleSiteBackupCopy,
  siteBackupCopies,
  siteBackups,
  sites,
  unlockOperationBreakGlassTransactional,
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
import {
  BACKUP_LEASE_MS,
  SITE_BACKUPS_INTERRUPTED,
  SiteBackupsApplier,
  type BackupOperationRef,
} from "../src/backups/site-backups-applier.js";
import {
  SITE_BACKUP_PRUNE_STEPS,
  SITE_BACKUP_STEPS,
  SiteBackupsService,
  createBackupWithCopies,
  type BackupSiteRef,
  type SiteBackupActor,
} from "../src/backups/site-backups.service.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { ControlPlaneError } from "../src/common/control-plane.error.js";
import { AppModule } from "../src/app.module.js";
import { AdminBackupPoliciesController } from "../src/controllers/admin-backup-policies.controller.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import {
  RECOVERY_READ_GIVE_UP_MS,
  RECOVERY_UNCONFIRMED_AUDIT_ACTION,
  RECOVERY_UNCONFIRMED_TEXT,
  RecoveryReadBound,
} from "../src/runtime/recovery-read-bound.js";

vi.mock("../src/sites/site-files.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sites/site-files.service.js")>();
  return { ...actual, resolveSiteFilesServiceId: async () => "svc_copies" };
});

const KEY = Buffer.alloc(32, 9);
const SNAP = "a".repeat(64);
const CANARY = "canary-copies-secret-DO-NOT-LEAK";
const DAY = 86_400_000;

const s3Input = (name: string, bucket: string, selectable: boolean, actorId: string) => ({
  name,
  endpoint: "https://s3.example.com",
  region: "eu-south-1",
  bucket,
  prefix: "panel",
  accessKeyId: "AKIACOPIES",
  secretAccessKey: CANARY,
  customerSelectable: selectable,
  actorId,
});

type StartReq = Extract<BackupsIpcRequest, { action: "start" }>;
type ForgetReq = Extract<BackupsIpcRequest, { action: "forget" }>;

describe("backup copies ledger: enqueue, apply, recover, retention", () => {
  let dbClient: DatabaseClient;
  let db: HostingPanelDatabase;
  let app: ControlPlaneAppHandle;
  let applier: SiteBackupsApplier;
  let service: SiteBackupsService;
  let adminId: string;
  let customerId: string;
  let orgId: string;
  let siteId: string;
  let site: BackupSiteRef & { name: string };
  let s3A: string;
  let s3B: string;
  let local: string;
  let defaultPolicyId: string;
  const calls: BackupsIpcRequest[] = [];
  /** jobId → answer of the executor `status`; absent = succeeded. */
  const statusAnswers = new Map<string, BackupJobStatus | Error>();
  let forgetFails: (req: ForgetReq) => boolean = () => false;
  let startFails: (req: StartReq) => boolean = () => false;
  /** Runs inside a `status` read, before its answer. */
  let beforeStatus: () => Promise<void> = async () => undefined;

  const customer = (): SiteBackupActor => ({
    auth: { user: { id: customerId } } as unknown as SiteBackupActor["auth"],
    req: { headers: {}, ip: "127.0.0.1" } as unknown as FastifyRequest,
  });
  const admin = (): SiteBackupActor => ({
    auth: { user: { id: adminId } } as unknown as SiteBackupActor["auth"],
    req: { headers: {}, ip: "127.0.0.1" } as unknown as FastifyRequest,
    actionPrefix: "admin.site.backups",
  });
  const dispatches = () => calls.filter((c): c is StartReq => c.action === "start");
  const forgets = () => calls.filter((c): c is ForgetReq => c.action === "forget");

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
  let baselineAuditIds = new Set<string>();
  const newAudits = async () => (await db.select().from(auditEvents)).filter((r) => !baselineAuditIds.has(r.id));
  const audits = async (action: string) => (await newAudits()).filter((r) => r.action === action);

  /** A finished backup of the site with one succeeded copy per target. */
  const seedBackup = async (
    startedAt: Date,
    copies: readonly { targetId: string; snapshotId: string }[],
    kind: "nightly" | "manual" = "nightly",
  ) => {
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
    for (const c of copies) {
      const [copy] = (await copiesOf(id)).filter((x) => x.targetId === c.targetId);
      await settleSiteBackupCopy(db, copy!.id, { status: "succeeded", snapshotId: c.snapshotId, sizeBytes: 100 });
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
    await setupInstallation(db, { installationName: "Copies", hostHostname: "panel.test", hostIpv4: "10.0.0.1" });
    adminId = (await createServerAdmin(db, KEY, { email: "admin-copies@x.it", name: "Admin", password: "correct horse battery" })).userId;

    customerId = `usr_${randomUUID()}`;
    await db.insert(users).values({ id: customerId, email: "customer-copies@x.it", name: "Customer", passwordHash: "x" });
    const [inst] = await db.select().from(platformInstallations).limit(1);
    const hostId = `hst_${randomUUID()}`;
    await db.insert(hosts).values({
      id: hostId,
      platformInstallationId: inst!.id,
      name: "copies.test",
      hostname: "copies.test",
      ipv4Address: "10.0.0.9",
      hostingMode: "dedicated",
      totalCpuMilli: 4000,
      totalMemoryBytes: "8589934592",
      totalStorageBytes: "107374182400",
    });
    orgId = `org_${randomUUID()}`;
    await db.insert(organizations).values({ id: orgId, platformInstallationId: inst!.id, name: "Copies Org", slug: "copies-org" });
    const allocId = `alloc_${randomUUID()}`;
    await db.insert(hostAllocations).values({ id: allocId, hostId, organizationId: orgId, status: "active" });
    siteId = `sit_${randomUUID()}`;
    await db.insert(sites).values({
      id: siteId,
      organizationId: orgId,
      hostAllocationId: allocId,
      name: "Copies Site",
      slug: "copies-site",
      status: "ready",
      siteType: "wordpress",
    });
    site = { id: siteId, organizationId: orgId, status: "ready", name: "Copies Site" };

    s3A = (await insertS3Target(db, KEY, s3Input("S3 A", "bucket-a", false, adminId))).id;
    s3B = (await insertS3Target(db, KEY, s3Input("S3 B", "bucket-b", true, adminId))).id;
    local = (await insertLocalTarget(db, { name: "This server", customerSelectable: true, actorId: adminId })).id;
    defaultPolicyId = (await getPolicy(db, "default_site")).id;

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
          await beforeStatus();
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
              : { snapshotId: SNAP, bytesAdded: 1, totalBytes: 4096, fileCount: 3, durationMs: 10 },
          };
        }
        default:
          throw new Error(`Unexpected backup action in test stub: ${req.action}`);
      }
    }) as DockerExecutorPort["backups"];

    // Registers the policy service until app.module.ts does (the next phase); idempotent after.
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
    beforeStatus = async () => undefined;
    await db.delete(siteBackups);
    await db.delete(operations);
    baselineAuditIds = new Set((await db.select({ id: auditEvents.id }).from(auditEvents)).map((r) => r.id));
    await db.update(sites).set({ status: "ready" }).where(eq(sites.id, siteId));
    await setPolicyTargets(db, defaultPolicyId, [local]);
    await updatePolicySettings(db, "default_site", { retentionDays: 14 }, adminId);
  });

  it("writes the logical backup with one running copy on the effective target, the job id pinned to the operation", async () => {
    const accepted = await service.create(site, customer(), "k-copy-1");
    const backup = await backupOf(accepted.operationId);
    expect(backup).toMatchObject({ id: accepted.backupId, status: "running" });
    const copies = await copiesOf(backup.id);
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({
      targetId: local,
      targetKind: "local",
      priority: 1,
      required: true,
      status: "running",
      jobId: accepted.operationId,
    });

    const listed = SiteBackupsDtoSchema.parse(await service.list(site));
    expect(listed.configured).toBe(true);
    expect(listed.retentionDays).toBe(14);
    expect(listed.targets).toEqual([{ id: local, kind: "local" }]);
    expect(listed.backups[0]!.copies).toEqual([
      expect.objectContaining({ targetId: local, kind: "local", status: "running", sizeBytes: null }),
    ]);
  });

  it("dispatches from the copy's target, settles the copy and the row, and audits the copy without secrets", async () => {
    const accepted = await service.create(site, customer(), "k-copy-2");
    await applier.apply(await claim(accepted.operationId));

    expect(dispatches()).toHaveLength(1);
    expect(dispatches()[0]).toMatchObject({ jobId: accepted.operationId, siteId, target: { kind: "local", targetId: local } });
    const backup = await backupOf(accepted.operationId);
    expect(backup).toMatchObject({ status: "succeeded", snapshotId: SNAP, sizeBytes: 4096, problem: null });
    expect(await copiesOf(backup.id)).toEqual([
      expect.objectContaining({ status: "succeeded", snapshotId: SNAP, sizeBytes: 4096, problem: null }),
    ]);
    const [op] = await db.select().from(operations).where(eq(operations.id, accepted.operationId));
    expect(op?.status).toBe("succeeded");

    const [audit] = await audits("site.backups.copy_succeeded");
    expect(audit).toMatchObject({ actorType: "system", targetId: siteId, organizationId: orgId });
    expect(audit!.details).toMatchObject({ backupId: backup.id, targetId: local, targetKind: "local", problem: null });
    expect(JSON.stringify(await newAudits())).not.toContain(CANARY);
  });

  it("settles a failed copy with the executor's problem and fails the operation", async () => {
    const accepted = await service.create(site, customer(), "k-copy-3");
    statusAnswers.set(accepted.operationId, {
      jobId: accepted.operationId,
      state: "failed",
      failure: "local_target_unmounted",
      snapshot: null,
    });
    await expect(applier.apply(await claim(accepted.operationId))).rejects.toMatchObject({ code: "INTERNAL_ERROR" });

    const backup = await backupOf(accepted.operationId);
    expect(backup).toMatchObject({ status: "failed", problem: "local_target_unmounted" });
    expect(await copiesOf(backup.id)).toEqual([
      expect.objectContaining({ status: "failed", problem: "local_target_unmounted" }),
    ]);
    const [audit] = await audits("site.backups.copy_failed");
    expect(audit!.details).toMatchObject({ targetId: local, problem: "local_target_unmounted" });
  });

  it("keeps the target pinned at enqueue when the policy and the target change mid-run", async () => {
    const pinned = (await insertS3Target(db, KEY, s3Input("S3 pinned", "bucket-pinned", false, adminId))).id;
    await setPolicyTargets(db, defaultPolicyId, [pinned]);
    const accepted = await service.create(site, customer(), "k-pin");
    // The administrator swaps the destination while the operation is queued.
    await setPolicyTargets(db, defaultPolicyId, [local]);
    await archiveBackupTarget(db, pinned);

    await applier.apply(await claim(accepted.operationId));

    expect(dispatches()).toHaveLength(1);
    const target = dispatches()[0]!.target;
    expect("kind" in target).toBe(false);
    expect(target).toMatchObject({ endpoint: "https://s3.example.com", bucket: "bucket-pinned", secretAccessKey: CANARY });
    const backup = await backupOf(accepted.operationId);
    expect(backup.status).toBe("succeeded");
    expect(await copiesOf(backup.id)).toEqual([expect.objectContaining({ targetId: pinned, status: "succeeded" })]);
  });

  it("recovers by reading status per open copy job and never starts a job (BKP-14)", async () => {
    const accepted = await service.create(site, customer(), "k-recover-ok");
    const op = await claim(accepted.operationId);
    statusAnswers.set(accepted.operationId, { jobId: accepted.operationId, state: "running", failure: null, snapshot: null });
    expect(await applier.recover(op)).toBe("pending");

    statusAnswers.delete(accepted.operationId);
    expect(await applier.recover(op)).toBe("settled");
    expect(calls.filter((c) => c.action !== "status")).toEqual([]);
    const backup = await backupOf(accepted.operationId);
    expect(backup).toMatchObject({ status: "succeeded", snapshotId: SNAP });
    expect((await copiesOf(backup.id))[0]).toMatchObject({ status: "succeeded", snapshotId: SNAP });
    const [row] = await db.select().from(operations).where(eq(operations.id, accepted.operationId));
    expect(row?.status).toBe("succeeded");
  });

  it("fails a copy the executor does not know as interrupted, and keeps pending while the executor is unreachable", async () => {
    const accepted = await service.create(site, customer(), "k-recover-unknown");
    const op = await claim(accepted.operationId);
    statusAnswers.set(accepted.operationId, new Error("executor down"));
    expect(await applier.recover(op)).toBe("pending");
    expect((await copiesOf((await backupOf(accepted.operationId)).id))[0]!.status).toBe("running");

    statusAnswers.set(accepted.operationId, { jobId: accepted.operationId, state: "unknown", failure: null, snapshot: null });
    expect(await applier.recover(op)).toBe("settled");
    expect(calls.filter((c) => c.action === "start" || c.action === "forget")).toEqual([]);
    const backup = await backupOf(accepted.operationId);
    expect(backup).toMatchObject({ status: "failed", problem: "interrupted" });
    expect((await copiesOf(backup.id))[0]).toMatchObject({ status: "failed", problem: "interrupted" });
    const [row] = await db.select().from(operations).where(eq(operations.id, accepted.operationId));
    expect(row).toMatchObject({ status: "failed", errorCode: "OPERATION_INTERRUPTED", errorMessage: SITE_BACKUPS_INTERRUPTED });
  });

  describe("retention per target (BKP-09)", () => {
    it("keeps each target's own newest good copy, forgets only on the target holding the snapshot, and deletes a backup with its last copy", async () => {
      await updatePolicySettings(db, "default_site", { retentionDays: 1 }, adminId);
      const oldCopy = "1".repeat(64);
      const sharedB = "2".repeat(64);
      const keepA = "3".repeat(64);
      const keepB = "4".repeat(64);
      // M: on both targets, 10 days old. P: only on s3A, 2 days. Q: only on local, 3 days (older than the retention, but local's newest).
      const m = await seedBackup(new Date(Date.now() - 10 * DAY), [
        { targetId: s3A, snapshotId: oldCopy },
        { targetId: local, snapshotId: sharedB },
      ]);
      const p = await seedBackup(new Date(Date.now() - 2 * DAY), [{ targetId: s3A, snapshotId: keepA }]);
      const q = await seedBackup(new Date(Date.now() - 3 * DAY), [{ targetId: local, snapshotId: keepB }]);
      // The forget on the local target fails: M keeps that copy, and with it its logical row.
      forgetFails = (req) => "kind" in req.target;

      const op = await enqueuePrune();
      await applier.apply(op);

      const sent = forgets();
      expect(sent).toHaveLength(2);
      const onS3 = sent.find((f) => !("kind" in f.target))!;
      const onLocal = sent.find((f) => "kind" in f.target)!;
      expect(onS3.snapshotIds).toEqual([oldCopy]);
      expect(onS3.target).toMatchObject({ bucket: "bucket-a" });
      expect(onLocal.snapshotIds).toEqual([sharedB]);
      expect(onLocal.target).toEqual({ kind: "local", targetId: local });
      expect(new Set(sent.map((f) => f.jobId))).toEqual(new Set([`${op.id}-forget`, `${op.id}-forget-t2`]));

      // s3A: M's copy is gone, P's stays. local: nothing was removed (its forget failed), Q stays.
      expect((await copiesOf(m)).map((c) => c.targetId)).toEqual([local]);
      expect((await copiesOf(p)).map((c) => c.targetId)).toEqual([s3A]);
      expect((await copiesOf(q)).map((c) => c.targetId)).toEqual([local]);
      expect(await db.select({ id: siteBackups.id }).from(siteBackups).where(eq(siteBackups.id, m))).toHaveLength(1);

      // The next run succeeds on the local target and removes the logical backup with its last copy.
      forgetFails = () => false;
      await applier.apply(await enqueuePruneAfter(op.id));
      expect(await db.select({ id: siteBackups.id }).from(siteBackups).where(eq(siteBackups.id, m))).toEqual([]);
      expect(await db.select().from(siteBackupCopies).where(eq(siteBackupCopies.backupId, m))).toEqual([]);
      expect((await copiesOf(p))).toHaveLength(1);
      expect((await copiesOf(q))).toHaveLength(1);
    });

    async function enqueuePruneAfter(previousOpId: string) {
      await db.update(operations).set({ status: "succeeded" }).where(eq(operations.id, previousOpId));
      return enqueuePrune();
    }

    it("gives every target of one run its own forget job id, so a third target's snapshot is forgotten too", async () => {
      await updatePolicySettings(db, "default_site", { retentionDays: 1 }, adminId);
      const snaps = ["a", "b", "c"].map((c) => c.repeat(64));
      const old = new Date(Date.now() - 10 * DAY);
      const fresh = new Date(Date.now() - 1000);
      // One old backup per target (s3A, s3B, local), each with a newer good copy that stays.
      const olds = [] as string[];
      for (const [i, t] of [s3A, s3B, local].entries()) {
        olds.push(await seedBackup(old, [{ targetId: t, snapshotId: snaps[i]! }]));
        await seedBackup(fresh, [{ targetId: t, snapshotId: "9".repeat(64) }]);
      }

      const op = await enqueuePrune();
      await applier.apply(op);

      const sent = forgets();
      expect(sent).toHaveLength(3);
      expect(new Set(sent.map((f) => f.jobId))).toEqual(
        new Set([`${op.id}-forget`, `${op.id}-forget-t2`, `${op.id}-forget-t3`]),
      );
      for (const id of olds) {
        expect(await copiesOf(id)).toEqual([]);
        expect(await db.select({ id: siteBackups.id }).from(siteBackups).where(eq(siteBackups.id, id))).toEqual([]);
      }
    });

    it("forgets the snapshot of a copy-less row (written by an older release) on the legacy target", async () => {
      await updatePolicySettings(db, "default_site", { retentionDays: 1 }, adminId);
      await upsertBackupSettings(db, KEY, {
        endpoint: "https://s3.example.com",
        region: "eu-south-1",
        bucket: "legacy-bucket",
        prefix: "panel",
        accessKeyId: "AKIALEGACY00001",
        secretAccessKey: "legacy-secret",
        scheduleHourUtc: 2,
        retentionDays: 14,
        updatedByUserId: adminId,
      });
      const snap = "d".repeat(64);
      const { id } = await insertSiteBackup(db, {
        siteId,
        kind: "nightly",
        status: "running",
        operationId: `op_${randomUUID().replaceAll("-", "")}`,
        startedAt: new Date(Date.now() - 10 * DAY),
      });
      await db.update(siteBackups).set({ status: "succeeded", snapshotId: snap }).where(eq(siteBackups.id, id));
      // The legacy target keeps its own newest good copy; the copy-less row is the older one.
      await seedBackup(new Date(Date.now() - 1000), [{ targetId: LEGACY_BACKUP_TARGET_ID, snapshotId: "8".repeat(64) }]);

      await applier.apply(await enqueuePrune());

      expect(forgets().map((f) => f.snapshotIds)).toContainEqual([snap]);
      expect(await db.select({ id: siteBackups.id }).from(siteBackups).where(eq(siteBackups.id, id))).toEqual([]);
    });

    it("does not forget a snapshot a missing copy never had, and keeps running copies untouched", async () => {
      await updatePolicySettings(db, "default_site", { retentionDays: 1 }, adminId);
      const goodNew = await seedBackup(new Date(Date.now() - 1000), [{ targetId: local, snapshotId: "5".repeat(64) }]);
      const missing = await seedBackup(new Date(Date.now() - 9 * DAY), [{ targetId: local, snapshotId: "6".repeat(64) }]);
      const [missingCopy] = await copiesOf(missing);
      await db.update(siteBackupCopies).set({ status: "missing" }).where(eq(siteBackupCopies.id, missingCopy!.id));
      const running = await seedBackup(new Date(Date.now() - 9 * DAY), [{ targetId: local, snapshotId: "7".repeat(64) }]);
      const [runningCopy] = await copiesOf(running);
      await db.update(siteBackupCopies).set({ status: "running", snapshotId: null }).where(eq(siteBackupCopies.id, runningCopy!.id));

      await applier.apply(await enqueuePrune());

      expect(forgets()).toEqual([]);
      expect(await copiesOf(missing)).toEqual([]);
      expect(await copiesOf(goodNew)).toHaveLength(1);
      expect(await copiesOf(running)).toHaveLength(1);
    });
  });

  describe("destination named at create (BKP-20)", () => {
    it("pins the one named destination: a customer may name an offered one, not a hidden one", async () => {
      const accepted = await service.create(site, customer(), "k-named-1", { targetId: s3B });
      const copies = await copiesOf((await backupOf(accepted.operationId)).id);
      expect(copies.map((c) => ({ id: c.targetId, job: c.jobId }))).toEqual([{ id: s3B, job: accepted.operationId }]);

      await db.update(operations).set({ status: "succeeded" }).where(eq(operations.id, accepted.operationId));
      await expect(service.create(site, customer(), "k-named-2", { targetId: s3A })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(
        service.create(site, customer(), "k-named-3", { targetId: `bkt_${"0".repeat(32)}` }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      // No operation, row or copy is left behind by a refused request.
      expect(await db.select().from(siteBackups)).toHaveLength(1);

      // An administrator may name any enabled destination.
      const adminRun = await service.create(site, admin(), "k-named-4", { targetId: s3A });
      expect((await copiesOf((await backupOf(adminRun.operationId)).id)).map((c) => c.targetId)).toEqual([s3A]);
    });

    it("counts the same heavy actions whatever the destination: the seventh in the hour is refused", async () => {
      const kinds = ["site.backups.restore", "site.backups.download"] as const;
      for (let i = 0; i < 6; i++) {
        await db.insert(operations).values({
          id: `op_cap_${i}_${randomUUID().slice(0, 8)}`,
          organizationId: orgId,
          requestedByUserId: customerId,
          kind: kinds[i % 2]!,
          status: "succeeded",
          resourceType: "site",
          resourceId: siteId,
          submittedAt: new Date(Date.now() - (50 - i) * 60_000),
        });
      }
      const before = (await db.select().from(operations)).length;
      for (const body of [{ targetId: local }, { targetId: s3B }, {}]) {
        await expect(service.create(site, customer(), `k-cap-${JSON.stringify(body)}`, body)).rejects.toMatchObject({
          code: "QUOTA_EXCEEDED",
        });
      }
      expect(await db.select().from(operations)).toHaveLength(before);
      expect(await db.select().from(siteBackups)).toEqual([]);
    });

    it("refuses a backup when the site has no usable destination, and answers not configured", async () => {
      await setPolicyTargets(db, defaultPolicyId, []);
      await expect(service.create(site, customer(), "k-none")).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        message: "not_configured",
      });
      const listed = await service.list(site);
      expect(listed.configured).toBe(false);
      expect(listed.targets).toEqual([]);
      expect(await BackupPoliciesService.isSiteBackupConfigured(db, "linux-systemd", siteId)).toBe(false);
    });
  });

  describe("two copies in one operation", () => {
    const twoTargets = () => [
      { targetId: local, kind: "local" as const, priority: 1, required: true },
      { targetId: s3B, kind: "s3" as const, priority: 2, required: true },
    ];

    async function enqueueWithTwoCopies(kind: "site.backups.create" | "site.wordpress.update", backupKind: "manual" | "pre_update") {
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
      await db.transaction((tx) =>
        createBackupWithCopies(tx, { id: siteId }, { kind: backupKind, operationId: operation.id, targets: twoTargets() }),
      );
      return claim(operation.id, kind);
    }

    it("runs the copies in order with job ids <op> and <op>-t2, each against its own target", async () => {
      const op = await enqueueWithTwoCopies("site.backups.create", "manual");
      await applier.apply(op);
      expect(dispatches().map((d) => [d.jobId, "kind" in d.target ? d.target.kind : "s3"])).toEqual([
        [op.id, "local"],
        [`${op.id}-t2`, "s3"],
      ]);
      const backup = await backupOf(op.id);
      expect(backup.status).toBe("succeeded");
      expect((await copiesOf(backup.id)).map((c) => c.status)).toEqual(["succeeded", "succeeded"]);
    });

    it("a partial result is a success for a requested backup (the saved copy stays restorable)", async () => {
      const op = await enqueueWithTwoCopies("site.backups.create", "manual");
      statusAnswers.set(`${op.id}-t2`, { jobId: `${op.id}-t2`, state: "failed", failure: "unreachable", snapshot: null });
      await applier.apply(op);

      const backup = await backupOf(op.id);
      expect(backup).toMatchObject({ status: "partial", snapshotId: SNAP, problem: "unreachable" });
      const [row] = await db.select().from(operations).where(eq(operations.id, op.id));
      expect(row?.status).toBe("succeeded");
      expect(await audits("site.backups.partial")).toHaveLength(1);
      expect((await copiesOf(backup.id)).map((c) => c.status)).toEqual(["succeeded", "failed"]);
    });

    it("a partial result fails the backup that gates a change (pre_update), keeping the good copy", async () => {
      const op = await enqueueWithTwoCopies("site.wordpress.update", "pre_update");
      startFails = (req) => req.jobId.endsWith("-t2");
      await expect(applier.runBackupStep(op)).rejects.toMatchObject({ code: "INTERNAL_ERROR" });

      const backup = await backupOf(op.id);
      expect(backup.status).toBe("partial");
      expect((await copiesOf(backup.id)).map((c) => c.status)).toEqual(["succeeded", "failed"]);
      const [row] = await db.select().from(operations).where(eq(operations.id, op.id));
      expect(row).toMatchObject({ status: "failed", errorCode: "INTERNAL_ERROR" });
    });
  });

  it("gives a pre_update backup its copy through the shared helper, and refuses when nothing is configured", async () => {
    const operationId = `op_${randomUUID().replaceAll("-", "")}`;
    const { id } = await db.transaction((tx) => createBackupWithCopies(tx, { id: siteId }, { kind: "pre_update", operationId }));
    expect(await copiesOf(id)).toEqual([expect.objectContaining({ targetId: local, jobId: operationId, status: "running" })]);

    await setPolicyTargets(db, defaultPolicyId, []);
    await expect(
      db.transaction((tx) => createBackupWithCopies(tx, { id: siteId }, { kind: "pre_update", operationId: `op_${randomUUID().replaceAll("-", "")}` })),
    ).rejects.toBeInstanceOf(ControlPlaneError);
  });

  it("leaves a settled row alone when a late settle arrives", async () => {
    const accepted = await service.create(site, customer(), "k-late");
    await applier.apply(await claim(accepted.operationId));
    const backup = await backupOf(accepted.operationId);
    await settleSiteBackup(db, accepted.operationId, { status: "failed", problem: "other" });
    expect((await backupOf(accepted.operationId)).status).toBe(backup.status);
    expect(await settleSiteBackupCopy(db, (await copiesOf(backup.id))[0]!.id, { status: "failed", problem: "other" })).toBe(false);
  });

  describe("a read of the copy job that keeps failing (issue #183)", () => {
    const MINUTE = 60_000;
    const clock = { t: Date.now() };
    const coded = (code: string) => Object.assign(new Error(`executor said ${code}`), { code });
    const running = (jobId: string): BackupJobStatus => ({ jobId, state: "running", failure: null, snapshot: null });
    const statusReads = (jobId: string) => calls.filter((c) => c.action === "status" && c.jobId === jobId).length;
    const opRow = async (id: string) => (await db.select().from(operations).where(eq(operations.id, id)))[0]!;
    const stepsOf = async (id: string) =>
      Object.fromEntries(
        (await db.select().from(operationSteps).where(eq(operationSteps.operationId, id))).map((s) => [s.key, [s.status, s.message]]),
      );
    const unconfirmed = (id: string) =>
      db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.targetId, id), eq(auditEvents.action, RECOVERY_UNCONFIRMED_AUDIT_ACTION)));
    const worker = () => {
      app.outboxWorker.recoveryReads = new RecoveryReadBound(() => clock.t);
      return app.outboxWorker;
    };
    /** The operation in doubt as the worker leaves it when its lease ran out while the copy job ran. */
    const inDoubt = async (opId: string) => {
      await db.update(operations).set({ status: "unknown", leaseExpiresAt: null }).where(eq(operations.id, opId));
      calls.length = 0;
      return opId;
    };

    it("a copy whose job cannot be read for the whole bound is closed as not confirmed: copy interrupted, only reads sent", async () => {
      const opId = await inDoubt((await service.create(site, customer(), "k-183-close")).operationId);
      const w = worker();
      statusAnswers.set(opId, coded("INTERNAL_ERROR"));
      expect(await w.recoverUnknownOperations()).toMatchObject({ convergedSucceeded: 0, convergedFailed: 0 });
      clock.t += RECOVERY_READ_GIVE_UP_MS - 1;
      statusAnswers.set(opId, new Error("Unexpected token < in JSON"));
      expect(await w.recoverUnknownOperations()).toMatchObject({ convergedFailed: 0 });
      expect((await opRow(opId)).status).toBe("unknown");
      expect((await copiesOf((await backupOf(opId)).id))[0]!.status).toBe("running");

      clock.t += 1;
      expect(await w.recoverUnknownOperations()).toMatchObject({ convergedSucceeded: 0, convergedFailed: 1 });

      expect(await opRow(opId)).toMatchObject({ status: "failed", errorCode: "OPERATION_AMBIGUOUS", errorMessage: RECOVERY_UNCONFIRMED_TEXT });
      expect(await stepsOf(opId)).toEqual({
        backup: ["failed", RECOVERY_UNCONFIRMED_TEXT],
        retention: ["skipped", "Skipped because backup did not finish"],
      });
      // What a copy whose job the executor no longer knows gets: interrupted. The job may still run on the executor.
      const backup = await backupOf(opId);
      expect(backup).toMatchObject({ status: "failed", problem: "interrupted" });
      expect((await copiesOf(backup.id)).map((c) => [c.status, c.problem])).toEqual([["failed", "interrupted"]]);
      const rows = await unconfirmed(opId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorType: "system", organizationId: orgId, targetType: "operation" });
      expect(rows[0]!.details).toEqual({
        operationId: opId,
        kind: "site.backups.create",
        resourceType: "site",
        resourceId: siteId,
        minutesWaited: 30,
        failure: "unexpected_error",
      });
      // One audit row for the closing: none per copy, none of the other recovery ends.
      expect(await audits("site.backups.copy_failed")).toEqual([]);
      expect(await audits("operation.recovered.failed")).toEqual([]);
      const events = await db.select().from(outboxEvents);
      expect(events.filter((e) => (e.payload as { operationId?: string }).operationId === opId).map((e) => e.status)).toEqual(["failed"]);
      expect(statusReads(opId)).toBe(3);
      expect(calls.filter((c) => c.action !== "status")).toEqual([]);

      // A second pass finds nothing in doubt: no read, no row.
      const closed = await opRow(opId);
      expect(await w.recoverUnknownOperations()).toMatchObject({ convergedFailed: 0 });
      expect(statusReads(opId)).toBe(3);
      expect(await opRow(opId)).toEqual(closed);
      expect(await unconfirmed(opId)).toHaveLength(1);
      expect(w.recoveryReads.size).toBe(0);
    });

    it("an executor that cannot be reached never closes it; an answer it can read starts the count again", async () => {
      const opId = await inDoubt((await service.create(site, customer(), "k-183-wait")).operationId);
      const w = worker();
      const honest = [coded("DOCKER_ENGINE_UNAVAILABLE"), Object.assign(coded("OPERATION_AMBIGUOUS"), { ambiguousOutcome: true }), coded("RESOURCE_LOCKED")];
      for (let pass = 0; pass < 48; pass += 1) {
        statusAnswers.set(opId, honest[pass % honest.length]!);
        expect(await w.recoverUnknownOperations()).toMatchObject({ convergedFailed: 0 });
        clock.t += 30 * MINUTE;
      }
      expect((await opRow(opId)).status).toBe("unknown");
      expect(w.recoveryReads.size).toBe(0);

      // Counted, then an answer it can read (the job runs), then counted again: the bound is counted from the last one.
      statusAnswers.set(opId, coded("INTERNAL_ERROR"));
      await w.recoverUnknownOperations();
      clock.t += 20 * MINUTE;
      statusAnswers.set(opId, running(opId));
      await w.recoverUnknownOperations();
      clock.t += 20 * MINUTE;
      statusAnswers.set(opId, coded("INTERNAL_ERROR"));
      await w.recoverUnknownOperations();
      clock.t += RECOVERY_READ_GIVE_UP_MS - MINUTE;
      expect(await w.recoverUnknownOperations()).toMatchObject({ convergedFailed: 0 });
      expect((await opRow(opId)).status).toBe("unknown");

      clock.t += MINUTE;
      expect(await w.recoverUnknownOperations()).toMatchObject({ convergedFailed: 1 });
      expect(await opRow(opId)).toMatchObject({ status: "failed", errorCode: "OPERATION_AMBIGUOUS" });
      expect((await unconfirmed(opId))[0]!.details).toMatchObject({ minutesWaited: 30, failure: "error_code" });
      expect(calls.filter((c) => c.action !== "status")).toEqual([]);
    });

    it("never closes as succeeded: a copy saved before the reads failed keeps the backup partial, the operation fails", async () => {
      const { operation } = await db.transaction((tx) =>
        enqueueOperationTransactional(tx as unknown as HostingPanelDatabase, {
          organizationId: orgId,
          kind: "site.backups.create",
          resourceType: "site",
          resourceId: siteId,
          lockKey: `site:${siteId}`,
          leaseDurationMs: BACKUP_LEASE_MS,
          steps: SITE_BACKUP_STEPS,
          outboxPayload: { siteId },
        }),
      );
      await db.transaction((tx) =>
        createBackupWithCopies(tx, { id: siteId }, {
          kind: "manual",
          operationId: operation.id,
          targets: [
            { targetId: local, kind: "local", priority: 1, required: true },
            { targetId: s3B, kind: "s3", priority: 2, required: true },
          ],
        }),
      );
      const opId = await inDoubt(operation.id);
      const w = worker();
      // The first copy's job answers (succeeded); the second's read keeps failing.
      statusAnswers.set(`${opId}-t2`, coded("INTERNAL_ERROR"));
      await w.recoverUnknownOperations();
      clock.t += RECOVERY_READ_GIVE_UP_MS;
      expect(await w.recoverUnknownOperations()).toMatchObject({ convergedSucceeded: 0, convergedFailed: 1 });

      expect(await opRow(opId)).toMatchObject({ status: "failed", errorCode: "OPERATION_AMBIGUOUS" });
      const backup = await backupOf(opId);
      expect(backup).toMatchObject({ status: "partial", snapshotId: SNAP });
      expect((await copiesOf(backup.id)).map((c) => [c.status, c.problem])).toEqual([
        ["succeeded", null],
        ["failed", "interrupted"],
      ]);
      expect(statusReads(opId)).toBe(1);
      expect(statusReads(`${opId}-t2`)).toBe(2);
      expect(calls.filter((c) => c.action !== "status")).toEqual([]);
    });

    it("an operation unlocked by hand while the last read fails is left as the unlock wrote it", async () => {
      const opId = await inDoubt((await service.create(site, customer(), "k-183-unlock")).operationId);
      const w = worker();
      statusAnswers.set(opId, coded("INTERNAL_ERROR"));
      await w.recoverUnknownOperations();
      clock.t += RECOVERY_READ_GIVE_UP_MS;
      beforeStatus = async () => {
        await unlockOperationBreakGlassTransactional(db, { operationId: opId, reason: "checked by hand" });
      };
      expect(await w.recoverUnknownOperations()).toMatchObject({ convergedFailed: 0 });

      expect(await opRow(opId)).toMatchObject({ status: "failed", errorCode: "OPERATION_INTERRUPTED" });
      expect(await unconfirmed(opId)).toEqual([]);
      const backup = await backupOf(opId);
      expect(backup.status).toBe("running");
      expect((await copiesOf(backup.id))[0]!.status).toBe("running");
    });
  });
});
