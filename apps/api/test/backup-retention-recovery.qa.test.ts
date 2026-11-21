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
  insertSiteBackup,
  insertSiteBackupCopies,
  listSiteBackupCopies,
  operationSteps,
  operations,
  organizations,
  platformInstallations,
  setPolicyTargets,
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
import {
  BACKUP_LEASE_MS,
  SiteBackupsApplier,
  type BackupOperationRef,
} from "../src/backups/site-backups-applier.js";
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
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";

vi.mock("../src/sites/site-files.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sites/site-files.service.js")>();
  return { ...actual, resolveSiteFilesServiceId: async () => "svc_retrec" };
});

const KEY = Buffer.alloc(32, 7);
const SNAP = "a".repeat(64);
const CANARY = "canary-retrec-secret-DO-NOT-LEAK";
const DAY = 86_400_000;
const snap = (c: string) => c.repeat(64);

const s3Input = (name: string, bucket: string, selectable: boolean, actorId: string) => ({
  name,
  endpoint: "https://s3.example.com",
  region: "eu-south-1",
  bucket,
  prefix: "panel",
  accessKeyId: "AKIARETREC",
  secretAccessKey: CANARY,
  customerSelectable: selectable,
  actorId,
});

type Req<A extends BackupsIpcRequest["action"]> = Extract<BackupsIpcRequest, { action: A }>;
const isLocalReq = (req: { target: object }) => "kind" in req.target;

describe("backup retention, recovery, key refusal and caps with several targets (BKP-09/14/17/20)", () => {
  let dbClient: DatabaseClient;
  let db: HostingPanelDatabase;
  let app: ControlPlaneAppHandle;
  let applier: SiteBackupsApplier;
  let service: SiteBackupsService;
  let restoreService: SiteRestoreService;
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
  /** jobId → answer of `status` (absent = succeeded, with a snapshot unless it is a forget job). */
  const statusAnswers = new Map<string, BackupJobStatus | Error>();
  /** jobId → answer of the `restore`/`archive`/`forget`/`start` action itself (absent = running). */
  const startAnswers = new Map<string, BackupJobStatus | Error>();
  /** jobId → answer of `settle` (absent = unknown, as an executor that restarted). */
  const settleAnswers = new Map<string, BackupJobStatus | Error>();

  const actor = (id: string, prefix?: SiteBackupActor["actionPrefix"]): SiteBackupActor => ({
    auth: { user: { id } } as unknown as SiteBackupActor["auth"],
    req: { headers: {}, ip: "127.0.0.1" } as unknown as FastifyRequest,
    ...(prefix ? { actionPrefix: prefix } : {}),
  });
  const customer = () => actor(customerId);
  const admin = () => actor(adminId, "admin.site.backups");
  const sent = <A extends BackupsIpcRequest["action"]>(action: A) =>
    calls.filter((c): c is Req<A> => c.action === action);
  const mutating = () => calls.filter((c) => c.action !== "status");

  const claim = async (opId: string, kind: BackupOperationRef["kind"] = "site.backups.create"): Promise<BackupOperationRef> => {
    await db
      .update(operations)
      .set({ status: "processing", leaseExpiresAt: new Date(Date.now() + BACKUP_LEASE_MS) })
      .where(eq(operations.id, opId));
    return { id: opId, organizationId: orgId, kind, resourceId: siteId };
  };
  /** The state a crashed API leaves: the operation processing, its lease long gone. */
  const expireLease = async (opId: string) => {
    await db
      .update(operations)
      .set({ status: "processing", startedAt: new Date(), leaseExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(operations.id, opId));
  };
  const markStepRunning = (opId: string, key: string) =>
    db.update(operationSteps).set({ status: "running" }).where(and(eq(operationSteps.operationId, opId), eq(operationSteps.key, key)));
  const opRow = async (opId: string) => (await db.select().from(operations).where(eq(operations.id, opId)))[0]!;
  const copiesOf = async (backupId: string) => (await listSiteBackupCopies(db, [backupId])).get(backupId) ?? [];
  const backupById = async (id: string) => (await db.select().from(siteBackups).where(eq(siteBackups.id, id)))[0]!;
  const backupOf = async (opId: string) =>
    (await db.select().from(siteBackups).where(eq(siteBackups.operationId, opId)))[0]!;
  let baselineAuditIds = new Set<string>();
  const audits = async (action: string) =>
    (await db.select().from(auditEvents)).filter((r) => !baselineAuditIds.has(r.id) && r.action === action);
  const siteStatus = async () => (await db.select().from(sites).where(eq(sites.id, siteId)))[0]!.status;

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

  const enqueue = async (kind: "site.backups.prune" | "site.backups.create" | "site.wordpress.update") => {
    const { operation } = await db.transaction((tx) =>
      enqueueOperationTransactional(tx as unknown as HostingPanelDatabase, {
        organizationId: orgId,
        kind,
        resourceType: "site",
        resourceId: siteId,
        lockKey: `site:${siteId}`,
        leaseDurationMs: BACKUP_LEASE_MS,
        steps: kind === "site.backups.prune" ? SITE_BACKUP_PRUNE_STEPS : SITE_BACKUP_STEPS,
        outboxPayload: { siteId },
      }),
    );
    return operation.id;
  };
  const finishOp = (opId: string) => db.update(operations).set({ status: "succeeded" }).where(eq(operations.id, opId));

  /** A backup operation with the given copies (priority = position + 1). */
  const enqueueWithCopies = async (
    kind: "site.backups.create" | "site.wordpress.update",
    backupKind: "manual" | "pre_update",
    copies: readonly { targetId: string; kind: "s3" | "local"; required: boolean }[],
  ) => {
    const opId = await enqueue(kind);
    await db.transaction((tx) =>
      createBackupWithCopies(tx, { id: siteId }, {
        kind: backupKind,
        operationId: opId,
        targets: copies.map((c, i) => ({ ...c, priority: i + 1 })),
      }),
    );
    return opId;
  };

  const seedHeavyOps = async (count: number, forSite: string, minutesAgoStart = 50) => {
    const kinds = ["site.backups.restore", "site.backups.download", "site.backups.create"] as const;
    for (let i = 0; i < count; i++) {
      await db.insert(operations).values({
        id: `op_cap_${randomUUID().replaceAll("-", "")}`,
        organizationId: orgId,
        requestedByUserId: customerId,
        kind: kinds[i % 3]!,
        status: "succeeded",
        resourceType: "site",
        resourceId: forSite,
        submittedAt: new Date(Date.now() - (minutesAgoStart - (i % 40)) * 60_000),
      });
    }
  };

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    db = dbClient.db;
    await dbClient.migrate();
    await setupInstallation(db, { installationName: "RetRec", hostHostname: "panel.test", hostIpv4: "10.0.0.1" });
    adminId = (await createServerAdmin(db, KEY, { email: "admin-retrec@x.it", name: "Admin", password: "correct horse battery" })).userId;

    customerId = `usr_${randomUUID()}`;
    await db.insert(users).values({ id: customerId, email: "customer-retrec@x.it", name: "Customer", passwordHash: "x" });
    const [inst] = await db.select().from(platformInstallations).limit(1);
    const hostId = `hst_${randomUUID()}`;
    await db.insert(hosts).values({
      id: hostId,
      platformInstallationId: inst!.id,
      name: "retrec.test",
      hostname: "retrec.test",
      ipv4Address: "10.0.0.9",
      hostingMode: "dedicated",
      totalCpuMilli: 4000,
      totalMemoryBytes: "8589934592",
      totalStorageBytes: "107374182400",
    });
    orgId = `org_${randomUUID()}`;
    await db.insert(organizations).values({ id: orgId, platformInstallationId: inst!.id, name: "RetRec Org", slug: "retrec-org" });
    const allocId = `alloc_${randomUUID()}`;
    await db.insert(hostAllocations).values({ id: allocId, hostId, organizationId: orgId, status: "active" });
    siteId = `sit_${randomUUID()}`;
    await db.insert(sites).values({
      id: siteId,
      organizationId: orgId,
      hostAllocationId: allocId,
      name: "RetRec Site",
      slug: "retrec-site",
      status: "ready",
      siteType: "wordpress",
    });
    site = { id: siteId, organizationId: orgId, status: "ready", name: "RetRec Site" };

    s3A = (await insertS3Target(db, KEY, s3Input("S3 A", "bucket-a", false, adminId))).id;
    s3B = (await insertS3Target(db, KEY, s3Input("S3 B", "bucket-b", true, adminId))).id;
    local = (await insertLocalTarget(db, { name: "This server", customerSelectable: true, actorId: adminId })).id;
    defaultPolicyId = (await getPolicy(db, "default_site")).id;

    const sim = new InMemoryDockerSimulatorAdapter();
    sim.backups = (async (req: BackupsIpcRequest) => {
      calls.push(req);
      switch (req.action) {
        case "start": {
          const answer = startAnswers.get(req.jobId);
          if (answer instanceof Error) throw answer;
          return answer ?? { jobId: req.jobId, state: "running", failure: null, snapshot: null };
        }
        case "forget": {
          const answer = startAnswers.get(req.jobId);
          if (answer instanceof Error) throw answer;
          return answer ?? { jobId: req.jobId, state: "running", failure: null, snapshot: null };
        }
        case "restore":
        case "archive": {
          const answer = startAnswers.get(req.jobId);
          if (answer instanceof Error) throw answer;
          return answer ?? { jobId: req.jobId, state: "running", failure: null, snapshot: null };
        }
        case "status": {
          const answer = statusAnswers.get(req.jobId);
          if (answer instanceof Error) throw answer;
          if (answer) return answer;
          const isForget = /-forget(-t2|-t3)?$/.test(req.jobId);
          return {
            jobId: req.jobId,
            state: "succeeded",
            failure: null,
            snapshot: isForget
              ? null
              : { snapshotId: SNAP, bytesAdded: 1, totalBytes: 4096, fileCount: 3, durationMs: 10 },
          };
        }
        case "settle": {
          const answer = settleAnswers.get(req.jobId);
          if (answer instanceof Error) throw answer;
          return answer ?? { jobId: req.jobId, state: "unknown", failure: null, snapshot: null };
        }
        default:
          throw new Error(`Unexpected backup action in test stub: ${req.action}`);
      }
    }) as DockerExecutorPort["backups"];

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
  });

  afterAll(async () => {
    await app.close();
    await dbClient.close();
  });

  beforeEach(async () => {
    calls.length = 0;
    statusAnswers.clear();
    startAnswers.clear();
    settleAnswers.clear();
    await db.delete(siteBackups);
    await db.delete(operations);
    baselineAuditIds = new Set((await db.select({ id: auditEvents.id }).from(auditEvents)).map((r) => r.id));
    await db.update(sites).set({ status: "ready" }).where(eq(sites.id, siteId));
    await setPolicyTargets(db, defaultPolicyId, [local]);
    await updatePolicySettings(db, "default_site", { retentionDays: 14 }, adminId);
  });

  // ---------------------------------------------------------------------------------------------- BKP-09
  describe("BKP-09 retention per target", () => {
    it("an archived target's only good copy is kept at any age; its older copy is forgotten only in its own repository", async () => {
      await updatePolicySettings(db, "default_site", { retentionDays: 1 }, adminId);
      const arch = (await insertS3Target(db, KEY, s3Input("S3 archived", "bucket-arch", false, adminId))).id;
      const oldArch = snap("1");
      const keepArch = snap("2");
      const onlyLocal = snap("3");
      const a1 = await seedBackup(new Date(Date.now() - 400 * DAY), [{ targetId: arch, snapshotId: oldArch }]);
      const a2 = await seedBackup(new Date(Date.now() - 300 * DAY), [{ targetId: arch, snapshotId: keepArch }]);
      const l1 = await seedBackup(new Date(Date.now() - 350 * DAY), [{ targetId: local, snapshotId: onlyLocal }]);
      await archiveBackupTarget(db, arch);

      const opId = await enqueue("site.backups.prune");
      await applier.apply(await claim(opId, "site.backups.prune"));

      const forgets = sent("forget");
      expect(forgets).toHaveLength(1);
      expect(forgets[0]).toMatchObject({ siteId, snapshotIds: [oldArch] });
      expect(forgets[0]!.target).toMatchObject({ bucket: "bucket-arch" });
      expect(await copiesOf(a1)).toEqual([]);
      expect((await copiesOf(a2)).map((c) => c.snapshotId)).toEqual([keepArch]);
      expect((await copiesOf(l1)).map((c) => c.snapshotId)).toEqual([onlyLocal]);
      expect((await opRow(opId)).status).toBe("succeeded");
      expect(JSON.stringify(calls)).not.toContain(keepArch);
    });

    it("never forgets the site's last good copy on any target, even when every copy is far past the retention", async () => {
      await updatePolicySettings(db, "default_site", { retentionDays: 1 }, adminId);
      const b = await seedBackup(new Date(Date.now() - 900 * DAY), [
        { targetId: local, snapshotId: snap("4") },
        { targetId: s3A, snapshotId: snap("5") },
      ]);
      const opId = await enqueue("site.backups.prune");
      await applier.apply(await claim(opId, "site.backups.prune"));

      expect(sent("forget")).toEqual([]);
      expect((await copiesOf(b)).map((c) => c.status)).toEqual(["succeeded", "succeeded"]);
    });

    it("a newer failed or running copy on a target never costs it the older good copy", async () => {
      await updatePolicySettings(db, "default_site", { retentionDays: 1 }, adminId);
      const good = await seedBackup(new Date(Date.now() - 10 * DAY), [{ targetId: local, snapshotId: snap("6") }]);
      const failed = await seedBackup(new Date(Date.now() - 2 * DAY), [{ targetId: local, snapshotId: snap("7") }]);
      const [failedCopy] = await copiesOf(failed);
      await db.update(siteBackupCopies).set({ status: "failed", snapshotId: null, problem: "unreachable" }).where(eq(siteBackupCopies.id, failedCopy!.id));
      const running = await seedBackup(new Date(Date.now() - 1000), [{ targetId: local, snapshotId: snap("8") }]);
      const [runningCopy] = await copiesOf(running);
      await db.update(siteBackupCopies).set({ status: "running", snapshotId: null }).where(eq(siteBackupCopies.id, runningCopy!.id));

      const opId = await enqueue("site.backups.prune");
      await applier.apply(await claim(opId, "site.backups.prune"));

      expect(sent("forget")).toEqual([]);
      expect(await copiesOf(good)).toHaveLength(1);
      expect(await copiesOf(running)).toHaveLength(1);
      // The old failed attempt (no snapshot) is dropped without any executor call.
      expect(await copiesOf(failed)).toEqual([]);
    });

    it("excess manual copies go per target: each forget names only the snapshots its own repository holds", async () => {
      const stamp = (n: number) => new Date(Date.now() - n * 60_000);
      const localSnaps = ["a", "b", "c", "d"].map((c) => snap(c));
      const s3Snaps = ["e", "f", "0", "9"].map((c) => snap(c));
      for (let i = 0; i < 4; i++) {
        // i = 0 is the oldest.
        await seedBackup(stamp(100 - i), [
          { targetId: local, snapshotId: localSnaps[i]! },
          { targetId: s3A, snapshotId: s3Snaps[i]! },
        ], "manual");
      }
      const opId = await enqueue("site.backups.prune");
      await applier.apply(await claim(opId, "site.backups.prune"));

      const forgets = sent("forget");
      expect(forgets).toHaveLength(2);
      const onLocal = forgets.find(isLocalReq)!;
      const onS3 = forgets.find((f) => !isLocalReq(f))!;
      expect(onLocal.snapshotIds).toEqual([localSnaps[0]]);
      expect(onLocal.target).toEqual({ kind: "local", targetId: local });
      expect(onS3.snapshotIds).toEqual([s3Snaps[0]]);
      expect(onS3.target).toMatchObject({ bucket: "bucket-a" });
      // The oldest backup lost both copies and with them its row; the three newest keep both.
      const rows = await db.select().from(siteBackups);
      expect(rows).toHaveLength(3);
      for (const row of rows) expect(await copiesOf(row.id)).toHaveLength(2);
    });

    it("a forget the executor reports as failed keeps the copy and its row, still prunes the other target, and the run succeeds", async () => {
      await updatePolicySettings(db, "default_site", { retentionDays: 1 }, adminId);
      const old = await seedBackup(new Date(Date.now() - 10 * DAY), [
        { targetId: local, snapshotId: snap("1") },
        { targetId: s3A, snapshotId: snap("2") },
      ]);
      await seedBackup(new Date(Date.now() - 1000), [
        { targetId: local, snapshotId: snap("3") },
        { targetId: s3A, snapshotId: snap("4") },
      ]);
      const opId = await enqueue("site.backups.prune");
      // Pre-compute job ids: targets are visited in target-id order, the first gets -forget, the second -forget-t2.
      const ordered = [local, s3A].sort();
      const failedTarget = local;
      const failedJob = `${opId}${ordered[0] === failedTarget ? "-forget" : "-forget-t2"}`;
      statusAnswers.set(failedJob, { jobId: failedJob, state: "failed", failure: "unreachable", snapshot: null });

      await applier.apply(await claim(opId, "site.backups.prune"));

      expect(sent("forget")).toHaveLength(2);
      expect((await copiesOf(old)).map((c) => c.targetId)).toEqual([local]);
      expect(await backupById(old)).toBeTruthy();
      const [row] = await db.select().from(operations).where(eq(operations.id, opId));
      expect(row?.status).toBe("succeeded");
      // Next night the same snapshot is asked again, on the same target only.
      statusAnswers.clear();
      calls.length = 0;
      await finishOp(opId);
      const next = await enqueue("site.backups.prune");
      await applier.apply(await claim(next, "site.backups.prune"));
      expect(sent("forget")).toHaveLength(1);
      expect(sent("forget")[0]).toMatchObject({ snapshotIds: [snap("1")], target: { kind: "local", targetId: local } });
      expect(await db.select().from(siteBackups).where(eq(siteBackups.id, old))).toEqual([]);
    });

    it("a second prune after a complete one asks the executor for nothing", async () => {
      await updatePolicySettings(db, "default_site", { retentionDays: 1 }, adminId);
      await seedBackup(new Date(Date.now() - 10 * DAY), [{ targetId: local, snapshotId: snap("1") }]);
      await seedBackup(new Date(Date.now() - 1000), [{ targetId: local, snapshotId: snap("2") }]);
      const first = await enqueue("site.backups.prune");
      await applier.apply(await claim(first, "site.backups.prune"));
      expect(sent("forget")).toHaveLength(1);
      await finishOp(first);

      calls.length = 0;
      const second = await enqueue("site.backups.prune");
      await applier.apply(await claim(second, "site.backups.prune"));
      expect(calls).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------------------------- BKP-14
  describe("BKP-14 an operation left unknown after a restart is recovered read-only", () => {
    it("recovers a two-copy backup per copy job through the real unknown-operation sweep, with status only and once", async () => {
      const opId = await enqueueWithCopies("site.backups.create", "manual", [
        { targetId: local, kind: "local", required: true },
        { targetId: s3B, kind: "s3", required: true },
      ]);
      await expireLease(opId);
      // The first copy finished at the executor, the second is a job the restarted executor has never heard of.
      statusAnswers.set(`${opId}-t2`, { jobId: `${opId}-t2`, state: "unknown", failure: null, snapshot: null });

      await app.outboxWorker.recoverUnknownOperations();

      expect(mutating()).toEqual([]);
      expect(sent("status").map((c) => c.jobId).sort()).toEqual([opId, `${opId}-t2`].sort());
      const backup = await backupOf(opId);
      expect(backup).toMatchObject({ status: "partial", snapshotId: SNAP, problem: "interrupted" });
      expect((await copiesOf(backup.id)).map((c) => [c.targetId, c.status, c.problem])).toEqual([
        [local, "succeeded", null],
        [s3B, "failed", "interrupted"],
      ]);
      // A backup requested by someone keeps its saved copy: the operation succeeds.
      expect((await opRow(opId)).status).toBe("succeeded");

      // A second sweep, or a second recover, changes nothing and asks nothing, and never audits a copy twice.
      calls.length = 0;
      await app.outboxWorker.recoverUnknownOperations();
      await applier.recover({ id: opId, organizationId: orgId, kind: "site.backups.create", resourceId: siteId });
      expect(calls).toEqual([]);
      expect(await audits("site.backups.copy_succeeded")).toHaveLength(1);
      expect(await audits("site.backups.copy_failed")).toHaveLength(1);
    });

    it("a pre_update backup recovered as partial still fails the operation that gates the change", async () => {
      const opId = await enqueueWithCopies("site.wordpress.update", "pre_update", [
        { targetId: local, kind: "local", required: true },
        { targetId: s3B, kind: "s3", required: true },
      ]);
      const op = await claim(opId, "site.wordpress.update");
      statusAnswers.set(`${opId}-t2`, { jobId: `${opId}-t2`, state: "failed", failure: "unreachable", snapshot: null });

      expect(await applier.recover(op)).toBe("settled");

      expect(mutating()).toEqual([]);
      expect((await backupOf(opId)).status).toBe("partial");
      expect((await opRow(opId)).status).toBe("failed");
    });

    it("recovers a prune without any executor call: nothing is forgotten twice, the copies stay for the next night", async () => {
      await updatePolicySettings(db, "default_site", { retentionDays: 1 }, adminId);
      const old = await seedBackup(new Date(Date.now() - 10 * DAY), [{ targetId: local, snapshotId: snap("1") }]);
      await seedBackup(new Date(Date.now() - 1000), [{ targetId: local, snapshotId: snap("2") }]);
      const opId = await enqueue("site.backups.prune");
      await expireLease(opId);

      await app.outboxWorker.recoverUnknownOperations();

      expect(calls).toEqual([]);
      expect((await opRow(opId)).status).toBe("succeeded");
      expect(await copiesOf(old)).toHaveLength(1);
    });

    it("a restore that never began (step pending) fails as interrupted without asking the executor anything", async () => {
      const backupId = await seedBackup(new Date(Date.now() - 60_000), [{ targetId: local, snapshotId: SNAP }], "manual");
      const accepted = await restoreService.restore(site, customer(), backupId, { confirmName: "RetRec Site", targetId: local }, "k-rec-pending");
      await expireLease(accepted.operationId);

      await app.outboxWorker.recoverUnknownOperations();

      expect(calls).toEqual([]);
      expect(await backupById(backupId)).toMatchObject({ restoreStatus: "failed", restoreProblem: "interrupted" });
      expect((await opRow(accepted.operationId)).status).toBe("failed");
      expect(await siteStatus()).toBe("ready");
    });

    it("recovers a restore from a local copy with settle only: never a second restore, the site status is untouched", async () => {
      const backupId = await seedBackup(new Date(Date.now() - 60_000), [{ targetId: local, snapshotId: SNAP }], "manual");
      const accepted = await restoreService.restore(site, customer(), backupId, { confirmName: "RetRec Site", targetId: local }, "k-rec-restore");
      await markStepRunning(accepted.operationId, "restore");
      await expireLease(accepted.operationId);
      await db.update(sites).set({ status: "ready" }).where(eq(sites.id, siteId));

      await app.outboxWorker.recoverUnknownOperations();

      expect(calls.map((c) => c.action)).toEqual(["settle"]);
      expect(calls[0]).toMatchObject({ action: "settle", jobId: accepted.operationId });
      const row = await backupById(backupId);
      expect(row).toMatchObject({ restoreStatus: "failed", restoreProblem: "interrupted", restoreTargetId: local });
      expect((await opRow(accepted.operationId)).status).toBe("failed");
      expect(await siteStatus()).toBe("ready");
      expect((await copiesOf(backupId))[0]).toMatchObject({ status: "succeeded", snapshotId: SNAP });
    });

    it("recovers a restore whose executor is still unreachable as pending, without settling or restarting it", async () => {
      const backupId = await seedBackup(new Date(Date.now() - 60_000), [{ targetId: s3A, snapshotId: SNAP }], "manual");
      await setPolicyTargets(db, defaultPolicyId, [s3A]);
      const accepted = await restoreService.restore(site, customer(), backupId, { confirmName: "RetRec Site" }, "k-rec-down");
      await markStepRunning(accepted.operationId, "restore");
      await expireLease(accepted.operationId);
      settleAnswers.set(accepted.operationId, new Error("executor down"));

      await app.outboxWorker.recoverUnknownOperations();

      expect(calls.map((c) => c.action)).toEqual(["settle"]);
      expect((await backupById(backupId)).restoreStatus).toBe("running");
      expect((await opRow(accepted.operationId)).status).not.toBe("failed");
    });

    it("recovers a download from an S3 copy with status only and never prepares the archive again", async () => {
      const backupId = await seedBackup(new Date(Date.now() - 60_000), [{ targetId: s3A, snapshotId: SNAP }], "manual");
      const accepted = await restoreService.prepareDownload(site, customer(), backupId, "k-rec-dl", { targetId: s3A });
      await expireLease(accepted.operationId);
      statusAnswers.set(accepted.operationId, { jobId: accepted.operationId, state: "unknown", failure: null, snapshot: null });

      await app.outboxWorker.recoverUnknownOperations();

      expect(mutating()).toEqual([]);
      expect(sent("status").map((c) => c.jobId)).toEqual([accepted.operationId]);
      const row = await backupById(backupId);
      expect(row.archiveStatus).toBe("failed");
      expect(row.archiveProblem).toBe("interrupted");
      expect((await opRow(accepted.operationId)).status).toBe("failed");
    });
  });

  // ---------------------------------------------------------------------------------------------- BKP-17
  describe("BKP-17 a missing or wrong backup.key refuses restore and download and changes nothing", () => {
    const keyProblems = ["key_file_missing", "wrong_key"] as const;
    const targetsToTry = () => [
      { label: "local", id: local },
      { label: "s3", id: s3A },
    ];

    for (const problem of keyProblems) {
      for (const via of ["status", "start"] as const) {
        it(`restore from each kind of copy fails with ${problem} (answered on ${via}), the site and the copies are as they were`, async () => {
          for (const t of targetsToTry()) {
            calls.length = 0;
            await db.delete(operations);
            await db.delete(siteBackups);
            const backupId = await seedBackup(new Date(Date.now() - 60_000), [{ targetId: t.id, snapshotId: SNAP }], "manual");
            const before = JSON.stringify(await copiesOf(backupId));
            const sitesBefore = JSON.stringify(await db.select().from(sites).where(eq(sites.id, siteId)));
            const accepted = await restoreService.restore(
              site,
              customer(),
              backupId,
              { confirmName: "RetRec Site", targetId: t.id },
              `k-key-${problem}-${via}-${t.label}`,
            );
            const failed: BackupJobStatus = { jobId: accepted.operationId, state: "failed", failure: problem, snapshot: null };
            (via === "status" ? statusAnswers : startAnswers).set(accepted.operationId, failed);

            await expect(applier.apply(await claim(accepted.operationId, "site.backups.restore"))).rejects.toMatchObject({
              code: "INTERNAL_ERROR",
            });

            // One restore start on the chosen repository, no other mutation, nothing retried.
            expect(sent("restore")).toHaveLength(1);
            expect(sent("restore")[0]!.target).toEqual(
              t.label === "local" ? { kind: "local", targetId: local } : expect.objectContaining({ bucket: "bucket-a" }),
            );
            expect(sent("restore")[0]!.snapshotId).toBe(SNAP);
            expect(mutating().map((c) => c.action)).toEqual(["restore"]);
            expect(await backupById(backupId)).toMatchObject({ restoreStatus: "failed", restoreProblem: problem });
            expect((await opRow(accepted.operationId)).status).toBe("failed");
            // Nothing else moved: the copy is still a good, restorable one, the site did not change.
            expect(JSON.stringify(await copiesOf(backupId))).toBe(before);
            expect(JSON.stringify(await db.select().from(sites).where(eq(sites.id, siteId)))).toBe(sitesBefore);
            expect((await backupById(backupId)).status).toBe("succeeded");
          }
        });

        it(`download from each kind of copy fails with ${problem} (answered on ${via}): no archive, the copy is untouched`, async () => {
          for (const t of targetsToTry()) {
            calls.length = 0;
            await db.delete(operations);
            await db.delete(siteBackups);
            const backupId = await seedBackup(new Date(Date.now() - 60_000), [{ targetId: t.id, snapshotId: SNAP }], "manual");
            const before = JSON.stringify(await copiesOf(backupId));
            const accepted = await restoreService.prepareDownload(site, customer(), backupId, `k-dl-${problem}-${via}-${t.label}`, {
              targetId: t.id,
            });
            const failed: BackupJobStatus = { jobId: accepted.operationId, state: "failed", failure: problem, snapshot: null };
            (via === "status" ? statusAnswers : startAnswers).set(accepted.operationId, failed);

            await expect(applier.apply(await claim(accepted.operationId, "site.backups.download"))).rejects.toMatchObject({
              code: "INTERNAL_ERROR",
            });

            expect(sent("archive")).toHaveLength(1);
            expect(mutating().map((c) => c.action)).toEqual(["archive"]);
            const row = await backupById(backupId);
            expect(row).toMatchObject({ archiveStatus: "failed", archiveProblem: problem, archiveReadyUntil: null });
            expect(await siteStatus()).toBe("ready");
            expect(JSON.stringify(await copiesOf(backupId))).toBe(before);
            expect((await opRow(accepted.operationId)).status).toBe("failed");
          }
        });
      }
    }

    it("shows the key problem to the customer as the stable class, with no path or key text", async () => {
      const backupId = await seedBackup(new Date(Date.now() - 60_000), [{ targetId: local, snapshotId: SNAP }], "manual");
      const accepted = await restoreService.restore(site, customer(), backupId, { confirmName: "RetRec Site", targetId: local }, "k-key-dto");
      statusAnswers.set(accepted.operationId, {
        jobId: accepted.operationId,
        state: "failed",
        // Raw executor text must never travel; only the class does.
        failure: "restic: wrong password for /etc/hosting-panel/backup.key" as never,
        snapshot: null,
      });
      await expect(applier.apply(await claim(accepted.operationId, "site.backups.restore"))).rejects.toBeDefined();
      let listed = SiteBackupsDtoSchema.parse(await service.list(site));
      expect(listed.lastRestore).toMatchObject({ status: "failed", problem: "other" });
      expect(JSON.stringify(listed)).not.toContain("backup.key");

      await db.delete(operations);
      await db.delete(siteBackups);
      const second = await seedBackup(new Date(Date.now() - 60_000), [{ targetId: local, snapshotId: SNAP }], "manual");
      const again = await restoreService.restore(site, customer(), second, { confirmName: "RetRec Site", targetId: local }, "k-key-dto-2");
      statusAnswers.set(again.operationId, { jobId: again.operationId, state: "failed", failure: "wrong_key", snapshot: null });
      await expect(applier.apply(await claim(again.operationId, "site.backups.restore"))).rejects.toBeDefined();
      listed = SiteBackupsDtoSchema.parse(await service.list(site));
      expect(listed.lastRestore).toMatchObject({ status: "failed", problem: "wrong_key" });
    });

    it("a backup that fails on the key marks its copy failed with the class and leaves older good copies alone", async () => {
      const older = await seedBackup(new Date(Date.now() - 2 * DAY), [{ targetId: local, snapshotId: snap("1") }]);
      const accepted = await service.create(site, customer(), "k-key-backup");
      statusAnswers.set(accepted.operationId, { jobId: accepted.operationId, state: "failed", failure: "key_file_missing", snapshot: null });
      await expect(applier.apply(await claim(accepted.operationId))).rejects.toMatchObject({ code: "INTERNAL_ERROR" });

      expect(await backupOf(accepted.operationId)).toMatchObject({ status: "failed", problem: "key_file_missing" });
      expect((await copiesOf(older))[0]).toMatchObject({ status: "succeeded", snapshotId: snap("1") });
      // And the failed attempt never makes retention forget the good copy.
      expect(sent("forget")).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------------------------- BKP-20
  describe("BKP-20 caps, per-site lock and executor limits hold whatever the destination", () => {
    it("the 6/h per-site cap refuses restore and download on any chosen copy, leaving the backup row untouched", async () => {
      const backupId = await seedBackup(new Date(Date.now() - 60_000), [
        { targetId: local, snapshotId: snap("1") },
        { targetId: s3B, snapshotId: snap("2") },
      ], "manual");
      await seedHeavyOps(6, siteId);
      const opsBefore = (await db.select().from(operations)).length;
      const before = JSON.stringify(await backupById(backupId));

      for (const targetId of [local, s3B, undefined]) {
        const body = targetId ? { confirmName: "RetRec Site", targetId } : { confirmName: "RetRec Site" };
        await expect(restoreService.restore(site, customer(), backupId, body, `k-cap-r-${targetId}`)).rejects.toMatchObject({
          code: "QUOTA_EXCEEDED",
        });
        await expect(
          restoreService.prepareDownload(site, customer(), backupId, `k-cap-d-${targetId}`, targetId ? { targetId } : {}),
        ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
      }
      expect((await db.select().from(operations)).length).toBe(opsBefore);
      expect(JSON.stringify(await backupById(backupId))).toBe(before);
      expect(calls).toEqual([]);
    });

    it("an administrator's run on a named destination bypasses the customer cap and is not counted against it", async () => {
      await seedHeavyOps(6, siteId);
      const run = await service.create(site, admin(), "k-cap-admin", { targetId: s3A });
      expect((await copiesOf((await backupOf(run.operationId)).id)).map((c) => c.targetId)).toEqual([s3A]);
      await finishOp(run.operationId);
      // The customer is still refused at the same six, not seven or eight.
      await expect(service.create(site, customer(), "k-cap-after-admin", { targetId: local })).rejects.toMatchObject({
        code: "QUOTA_EXCEEDED",
      });
    });

    it("the 24/h per-organisation cap counts other sites and refuses the 25th action whatever target is named", async () => {
      // 23 heavy actions in the hour spread over other sites of the organisation: below the site cap everywhere.
      for (let i = 0; i < 4; i++) await seedHeavyOps(i === 3 ? 5 : 6, `sit_other_${i}`, 55);
      const seeded = (await db.select().from(operations)).length;
      expect(seeded).toBe(23);

      const accepted = await service.create(site, customer(), "k-org-24", { targetId: s3B });
      expect(accepted.backupId).toBeTruthy();
      await finishOp(accepted.operationId);

      const opsBefore = (await db.select().from(operations)).length;
      for (const body of [{ targetId: local }, { targetId: s3B }, {}]) {
        const err = await service
          .create(site, customer(), `k-org-25-${JSON.stringify(body)}`, body)
          .catch((e: unknown) => e as { code: string; message: string });
        expect(err).toMatchObject({ code: "QUOTA_EXCEEDED" });
        expect((err as { message: string }).message).toContain("organisation");
      }
      expect((await db.select().from(operations)).length).toBe(opsBefore);
      expect(await db.select().from(siteBackups)).toHaveLength(1);
    });

    it("a heavy action older than the hour no longer counts, on every destination", async () => {
      await seedHeavyOps(6, siteId, 50);
      await db.update(operations).set({ submittedAt: new Date(Date.now() - 61 * 60_000) });
      const accepted = await service.create(site, customer(), "k-window", { targetId: local });
      expect(accepted.operationId).toBeTruthy();
    });

    it("the per-site lock refuses a second backup, restore or download on another target while one is active, and writes nothing", async () => {
      const goodBackup = await seedBackup(new Date(Date.now() - 60_000), [
        { targetId: local, snapshotId: snap("1") },
        { targetId: s3B, snapshotId: snap("2") },
      ], "manual");
      const first = await service.create(site, customer(), "k-lock-1", { targetId: local });
      const opsBefore = (await db.select().from(operations)).length;
      const rowsBefore = (await db.select().from(siteBackups)).length;
      const copiesBefore = (await db.select().from(siteBackupCopies)).length;

      await expect(service.create(site, customer(), "k-lock-2", { targetId: s3B })).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });
      await expect(service.create(site, admin(), "k-lock-3", { targetId: s3A })).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });
      await expect(
        restoreService.restore(site, customer(), goodBackup, { confirmName: "RetRec Site", targetId: s3B }, "k-lock-4"),
      ).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });
      await expect(
        restoreService.prepareDownload(site, customer(), goodBackup, "k-lock-5", { targetId: s3B }),
      ).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });

      expect((await db.select().from(operations)).length).toBe(opsBefore);
      expect((await db.select().from(siteBackups)).length).toBe(rowsBefore);
      expect((await db.select().from(siteBackupCopies)).length).toBe(copiesBefore);
      expect((await backupById(goodBackup)).restoreStatus ?? null).toBeNull();
      // The one in flight is the first, and only it.
      expect((await backupOf(first.operationId)).id).toBe(first.backupId);

      // Once it ends, the lock is free again for the other destination.
      await finishOp(first.operationId);
      const next = await service.create(site, customer(), "k-lock-6", { targetId: s3B });
      expect(next.operationId).not.toBe(first.operationId);
    });

    it("replaying the same idempotency key keeps one operation and one copy, even with another body's target", async () => {
      const first = await service.create(site, customer(), "k-idem", { targetId: local });
      const again = await service.create(site, customer(), "k-idem", { targetId: local });
      expect(again.operationId).toBe(first.operationId);
      expect(await db.select().from(siteBackups)).toHaveLength(1);
      expect(await db.select().from(siteBackupCopies)).toHaveLength(1);
    });

    it("an executor at its job limit settles each copy as site_busy once, is asked once per copy, and the saved backup does not pretend success", async () => {
      const opId = await enqueueWithCopies("site.backups.create", "manual", [
        { targetId: local, kind: "local", required: true },
        { targetId: s3B, kind: "s3", required: true },
      ]);
      const { ControlPlaneError } = await import("../src/common/control-plane.error.js");
      startAnswers.set(opId, new ControlPlaneError("RESOURCE_LOCKED", "executor is at its job limit"));
      startAnswers.set(`${opId}-t2`, new ControlPlaneError("RESOURCE_LOCKED", "executor is at its job limit"));

      await expect(applier.apply(await claim(opId))).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });

      expect(sent("start").map((c) => c.jobId)).toEqual([opId, `${opId}-t2`]);
      expect(sent("status")).toEqual([]);
      expect(sent("forget")).toEqual([]);
      const backup = await backupOf(opId);
      expect(backup).toMatchObject({ status: "failed", problem: "site_busy" });
      expect((await copiesOf(backup.id)).map((c) => [c.status, c.problem])).toEqual([
        ["failed", "site_busy"],
        ["failed", "site_busy"],
      ]);
      expect((await opRow(opId)).status).toBe("failed");
    });
  });

  // ---------------------------------------------------------------------------------------------- pre_update
  describe("pre_update refuses to go on unless every required copy succeeded", () => {
    const failJob = (jobId: string) =>
      statusAnswers.set(jobId, { jobId, state: "failed", failure: "unreachable", snapshot: null });

    it("a failed FIRST required copy stops the update even though the second copy saved", async () => {
      const opId = await enqueueWithCopies("site.wordpress.update", "pre_update", [
        { targetId: local, kind: "local", required: true },
        { targetId: s3B, kind: "s3", required: true },
      ]);
      failJob(opId);
      await expect(applier.runBackupStep(await claim(opId, "site.wordpress.update"))).rejects.toMatchObject({ code: "INTERNAL_ERROR" });

      const backup = await backupOf(opId);
      expect(backup.status).toBe("partial");
      expect((await copiesOf(backup.id)).map((c) => c.status)).toEqual(["failed", "succeeded"]);
      expect((await opRow(opId)).status).toBe("failed");
      // The good copy the failed attempt left is kept, and nothing is forgotten on the failure path.
      expect(sent("forget")).toEqual([]);
    });

    it("a failed OPTIONAL copy does not stop the update; a failed required one with only an optional success does", async () => {
      const okId = await enqueueWithCopies("site.wordpress.update", "pre_update", [
        { targetId: local, kind: "local", required: true },
        { targetId: s3B, kind: "s3", required: false },
      ]);
      failJob(`${okId}-t2`);
      await applier.runBackupStep(await claim(okId, "site.wordpress.update"));
      expect((await backupOf(okId)).status).toBe("succeeded");
      await finishOp(okId);

      const badId = await enqueueWithCopies("site.wordpress.update", "pre_update", [
        { targetId: local, kind: "local", required: true },
        { targetId: s3B, kind: "s3", required: false },
      ]);
      failJob(badId);
      await expect(applier.runBackupStep(await claim(badId, "site.wordpress.update"))).rejects.toBeDefined();
      expect((await backupOf(badId)).status).toBe("partial");
      expect((await opRow(badId)).status).toBe("failed");
    });

    it("every required copy failing fails the backup outright, and success on all lets the update proceed", async () => {
      const failing = await enqueueWithCopies("site.wordpress.update", "pre_update", [
        { targetId: local, kind: "local", required: true },
        { targetId: s3B, kind: "s3", required: true },
      ]);
      failJob(failing);
      failJob(`${failing}-t2`);
      await expect(applier.runBackupStep(await claim(failing, "site.wordpress.update"))).rejects.toBeDefined();
      expect((await backupOf(failing)).status).toBe("failed");
      await finishOp(failing);

      const fine = await enqueueWithCopies("site.wordpress.update", "pre_update", [
        { targetId: local, kind: "local", required: true },
        { targetId: s3B, kind: "s3", required: true },
      ]);
      await applier.runBackupStep(await claim(fine, "site.wordpress.update"));
      expect((await backupOf(fine)).status).toBe("succeeded");
      expect((await opRow(fine)).status).not.toBe("failed");
    });

    it("an executor that cannot be reached mid-copy leaves the gate undecided (ambiguous), never a green light", async () => {
      const opId = await enqueueWithCopies("site.wordpress.update", "pre_update", [
        { targetId: local, kind: "local", required: true },
      ]);
      statusAnswers.set(opId, new Error("executor down"));
      const op = await claim(opId, "site.wordpress.update");
      op.id = opId;
      await db.update(operations).set({ status: "processing" }).where(eq(operations.id, opId));
      // Poll gives up immediately: the applier reports the outcome as unknown instead of succeeding.
      applier.pollGiveUpMs = 0;
      applier.pollMs = 0;
      try {
        await expect(applier.runBackupStep(op)).rejects.toMatchObject({ code: "OPERATION_AMBIGUOUS" });
      } finally {
        applier.pollGiveUpMs = 120_000;
        applier.pollMs = 5_000;
      }
      expect((await backupOf(opId)).status).toBe("running");
      expect((await copiesOf((await backupOf(opId)).id))[0]!.status).toBe("running");
    });
  });
});
