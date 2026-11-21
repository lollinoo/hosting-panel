import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import type { BackupsIpcRequest } from "@hosting-panel/contracts";
import {
  archiveBackupTarget,
  auditEvents,
  backupSettings,
  backupTargets,
  createDatabaseClient,
  eq,
  hostAllocations,
  hosts,
  insertLocalTarget,
  insertS3Target,
  insertSiteBackup,
  insertSiteBackupCopies,
  membershipRoles,
  memberships,
  operations,
  organizations,
  outboxEvents,
  platformInstallations,
  settleSiteBackupAggregate,
  settleSiteBackupCopy,
  siteBackupCopies,
  siteBackups,
  sites,
  upsertBackupSettings,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { InMemoryHostSimulatorAdapter } from "@hosting-panel/host-agent";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module.js";
import { BackupPoliciesService } from "../src/backups/backup-policies.service.js";
import { hashPassword } from "../src/auth/password.js";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { skipPasswordChange } from "./fixtures/password-change.js";

const KEY = Buffer.alloc(32, 11);
const PW = "correct horse battery";
const CANARY_SECRET = "canary-copy-s3-secret-DO-NOT-LEAK-33";
const LEGACY_S3 = {
  endpoint: "https://s3.example.com",
  region: "eu-south-1",
  bucket: "legacy-bucket",
  prefix: "panel",
  accessKeyId: "AKIALEGACYTEST1",
  secretAccessKey: CANARY_SECRET,
};
const SITE_A = {
  name: "Hotel Roma",
  domain: "hotelroma-copy.it",
  title: "Hotel Roma",
  adminUser: "admin",
  adminEmail: "admin@hotelroma-copy.it",
  adminPassword: "canary-Pass-123456",
};
const SITE_A2 = { ...SITE_A, name: "Hotel Milano", domain: "hotelmilano-copy.it", adminEmail: "a@hotelmilano-copy.it" };

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function httpJson(
  baseUrl: string,
  method: string,
  path: string,
  options?: { token?: string; body?: unknown; key?: string },
): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = {};
  if (options?.token) headers["Authorization"] = `Bearer ${options.token}`;
  if (options?.key) headers["Idempotency-Key"] = options.key;
  if (options?.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Json) : {} };
}

const hashOf = (backupId: string, targetId: string | null) =>
  createHash("sha256").update(JSON.stringify({ backupId, targetId })).digest("hex");

describe("restore and download from a selected copy (BKP-11 API side, BKP-15, BKP-17)", () => {
  let dbClient: DatabaseClient;
  let sim: InMemoryDockerSimulatorAdapter;
  let app: ControlPlaneAppHandle;
  let calls: BackupsIpcRequest[];
  let adminToken: string;
  let adminUserId: string;
  let ownerToken: string;
  let otherOwnerToken: string;
  let orgId: string;
  let otherOrgId: string;
  let siteId: string;
  let site2Id: string;
  let serviceId: string;
  let localId: string;
  let s3Id: string;

  const base = () => app.baseUrl!;
  const sitePath = (id = siteId, org = orgId) => `/v1/organizations/${org}/managed-sites/${id}`;
  const restore = (backupId: string, body: unknown, key: string = randomUUID(), token = ownerToken, id = siteId) =>
    httpJson(base(), "POST", `${sitePath(id)}/backups/${backupId}/restore`, { token, body, key });
  const download = (backupId: string, body: unknown, key: string = randomUUID(), id = siteId) =>
    httpJson(base(), "POST", `${sitePath(id)}/backups/${backupId}/download`, { token: ownerToken, body, key });

  /** Registers a snapshot in the simulator for the given target, as a finished copy would have. */
  async function snapshotOn(target: object): Promise<string> {
    const jobId = `op_${randomUUID().replaceAll("-", "")}`;
    await sim.backupState.handle({
      action: "start",
      jobId,
      siteId,
      serviceInstanceId: serviceId,
      target,
    } as BackupsIpcRequest & { action: "start" });
    return (await sim.backupState.handle({ action: "status", jobId })).snapshot!.snapshotId;
  }

  const dispatchOf = (id: string): object => (id === localId ? { kind: "local", targetId: id } : LEGACY_S3);

  /** A finished backup with one copy per entry (priority = position + 1), settled and aggregated as the appliers do. */
  async function seedBackup(
    copies: readonly { targetId: string; status: "succeeded" | "failed" }[],
    forSite = siteId,
  ): Promise<{ backupId: string; snapshots: Map<string, string> }> {
    const operationId = `op_${randomUUID().replaceAll("-", "")}`;
    const snapshots = new Map<string, string>();
    const { id: backupId } = await insertSiteBackup(dbClient.db, {
      siteId: forSite,
      kind: "manual",
      status: "running",
      operationId,
      siteUrl: "http://hotelroma-copy.it",
      startedAt: new Date(Date.now() - 60_000),
    });
    await insertSiteBackupCopies(
      dbClient.db,
      backupId,
      operationId,
      copies.map((c, i) => ({ targetId: c.targetId, priority: i + 1, required: true })),
    );
    const rows = await dbClient.db.select().from(siteBackupCopies).where(eq(siteBackupCopies.backupId, backupId));
    for (const copy of rows) {
      const wanted = copies.find((c) => c.targetId === copy.targetId)!;
      if (wanted.status === "succeeded") {
        const snapshotId = await snapshotOn(dispatchOf(copy.targetId));
        snapshots.set(copy.targetId, snapshotId);
        await settleSiteBackupCopy(dbClient.db, copy.id, { status: "succeeded", snapshotId, sizeBytes: 4096 });
      } else {
        await settleSiteBackupCopy(dbClient.db, copy.id, { status: "failed", problem: "other" });
      }
    }
    await settleSiteBackupAggregate(dbClient.db, backupId);
    return { backupId, snapshots };
  }

  const rowOf = async (backupId: string) =>
    (await dbClient.db.select().from(siteBackups).where(eq(siteBackups.id, backupId)))[0]!;

  async function createSite(token: string, org: string, body: typeof SITE_A): Promise<string> {
    const res = await httpJson(base(), "POST", `/v1/organizations/${org}/managed-sites`, {
      token,
      body,
      key: randomUUID(),
    });
    expect(res.status).toBe(202);
    return res.body.data.siteId as string;
  }

  /** A second organisation with its owner, written directly: the installation has one customer account. */
  async function createOtherOrg(): Promise<{ orgId: string; token: string }> {
    const [inst] = await dbClient.db.select().from(platformInstallations).limit(1);
    const hostId = `hst_${randomUUID()}`;
    await dbClient.db.insert(hosts).values({
      id: hostId,
      platformInstallationId: inst!.id,
      name: "copy-host-b.test",
      hostname: "copy-host-b.test",
      ipv4Address: "10.0.0.22",
      hostingMode: "dedicated",
      totalCpuMilli: 4000,
      totalMemoryBytes: "8589934592",
      totalStorageBytes: "107374182400",
    });
    const id = `org_${randomUUID()}`;
    await dbClient.db.insert(organizations).values({
      id,
      platformInstallationId: inst!.id,
      name: "Other Copy Org",
      slug: "other-copy-org",
    });
    await dbClient.db.insert(hostAllocations).values({
      id: `alloc_${randomUUID()}`,
      hostId,
      organizationId: id,
      status: "active",
    });
    const userId = `usr_${randomUUID()}`;
    const membershipId = `mem_${randomUUID()}`;
    await dbClient.db.insert(users).values({
      id: userId,
      email: "other-copy@hotel.it",
      name: "Other",
      passwordHash: await hashPassword(PW),
    });
    await dbClient.db.insert(memberships).values({ id: membershipId, organizationId: id, userId });
    await dbClient.db
      .insert(membershipRoles)
      .values({ id: `mrl_${randomUUID()}`, membershipId, roleId: "role_customer_owner" });
    const login = await httpJson(base(), "POST", "/v1/auth/login", {
      body: { email: "other-copy@hotel.it", password: PW },
    });
    expect(login.status).toBe(200);
    return { orgId: id, token: login.body.data.accessToken as string };
  }

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, {
      installationName: "Test Restore Copy",
      hostHostname: "panel-restore-copy.test",
      hostIpv4: "10.0.0.1",
    });
    const admin = await createServerAdmin(dbClient.db, KEY, {
      email: "admin-copy@x.it",
      name: "Admin",
      password: PW,
    });
    adminUserId = admin.userId;

    sim = new InMemoryDockerSimulatorAdapter();
    calls = [];
    const realBackups = sim.backups.bind(sim);
    sim.backups = (async (req: BackupsIpcRequest) => {
      calls.push(req);
      return realBackups(req);
    }) as typeof sim.backups;

    // Provides BackupPoliciesService until app.module.ts does (not part of this task); idempotent after.
    const register = AppModule.register.bind(AppModule);
    vi.spyOn(AppModule, "register").mockImplementation((options) => {
      const mod = register(options);
      const providers = mod.providers ?? [];
      return {
        ...mod,
        providers: providers.includes(BackupPoliciesService) ? providers : [...providers, BackupPoliciesService],
      };
    });

    app = await createControlPlaneApp({
      listen: true,
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

    const login = await httpJson(base(), "POST", "/v1/auth/login", {
      body: {
        email: "admin-copy@x.it",
        password: PW,
        totpCode: totpCodeAt(admin.totpSecretBase32, Math.floor(Date.now() / 30_000)),
      },
    });
    adminToken = login.body.data.accessToken as string;

    const created = await httpJson(base(), "POST", "/v1/admin/customer-account", {
      token: adminToken,
      body: { organizationName: "Hotel Roma Copy Org", ownerEmail: "mario-copy@hotel.it", ownerName: "Mario" },
    });
    expect(created.status).toBe(201);
    await skipPasswordChange(dbClient.db, "mario-copy@hotel.it");
    orgId = created.body.data.organizationId as string;
    const ownerLogin = await httpJson(base(), "POST", "/v1/auth/login", {
      body: { email: "mario-copy@hotel.it", password: created.body.data.temporaryPassword as string },
    });
    ownerToken = ownerLogin.body.data.accessToken as string;
    ({ orgId: otherOrgId, token: otherOwnerToken } = await createOtherOrg());
    siteId = await createSite(ownerToken, orgId, SITE_A);
    site2Id = await createSite(ownerToken, orgId, SITE_A2);
    await app.outboxWorker.processPendingOnce();
    serviceId = sim.deployedSpecs[0]!.serviceInstanceId;

    localId = (await insertLocalTarget(dbClient.db, { name: "On this server", customerSelectable: true, actorId: adminUserId })).id;
    s3Id = (
      await insertS3Target(dbClient.db, KEY, {
        name: "Offsite",
        endpoint: LEGACY_S3.endpoint,
        region: LEGACY_S3.region,
        bucket: "copy-bucket",
        prefix: "panel",
        accessKeyId: "AKIACOPYTEST1",
        secretAccessKey: CANARY_SECRET,
        customerSelectable: true,
        actorId: adminUserId,
      })
    ).id;
  });

  afterAll(async () => {
    await app.close();
    await dbClient.close();
  });

  beforeEach(async () => {
    calls.length = 0;
    await dbClient.db.delete(siteBackups);
    await dbClient.db.delete(outboxEvents);
    await dbClient.db.delete(operations).where(eq(operations.organizationId, orgId));
    await dbClient.db.delete(backupSettings);
    await dbClient.db.update(backupTargets).set({ archivedAt: null, enabled: true, customerSelectable: true }).where(eq(backupTargets.id, localId));
    await dbClient.db.update(sites).set({ status: "ready", siteUrl: "http://hotelroma-copy.it" }).where(eq(sites.id, siteId));
  });

  it("restores from the requested copy: persists the target, keeps the outbox payload, sends that copy's target and snapshot", async () => {
    const { backupId, snapshots } = await seedBackup([
      { targetId: s3Id, status: "succeeded" },
      { targetId: localId, status: "succeeded" },
    ]);
    const res = await restore(backupId, { confirmName: SITE_A.name, targetId: localId });
    expect(res.status).toBe(202);
    const operationId = res.body.data.operationId as string;

    expect((await rowOf(backupId)).restoreTargetId).toBe(localId);
    const [op] = await dbClient.db.select().from(operations).where(eq(operations.id, operationId));
    expect(op!.requestHash).toBe(hashOf(backupId, localId));
    const [evt] = await dbClient.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, siteId));
    expect(evt!.payload).toMatchObject({ siteId, backupId, operationId });
    expect(evt!.payload).not.toHaveProperty("targetId");
    const audit = (await dbClient.db.select().from(auditEvents)).find(
      (a) => a.action === "site.backups.restore" && (a.details as Json).operationId === operationId,
    );
    expect(audit!.details).toMatchObject({ backupId, targetId: localId, targetKind: "local" });

    await app.outboxWorker.processPendingOnce();
    const sent = calls.find((c) => c.action === "restore" && c.jobId === operationId);
    expect(sent).toMatchObject({ target: { kind: "local", targetId: localId }, snapshotId: snapshots.get(localId) });
    expect(JSON.stringify(sent)).not.toContain(CANARY_SECRET);
    expect((await rowOf(backupId)).restoreStatus).toBe("succeeded");
  });

  it("without a targetId restores from the lowest-priority succeeded copy, skipping a failed one", async () => {
    const { backupId, snapshots } = await seedBackup([
      { targetId: localId, status: "failed" },
      { targetId: s3Id, status: "succeeded" },
    ]);
    expect((await rowOf(backupId)).status).toBe("partial");

    const res = await restore(backupId, { confirmName: SITE_A.name });
    expect(res.status).toBe(202);
    expect((await rowOf(backupId)).restoreTargetId).toBe(s3Id);

    await app.outboxWorker.processPendingOnce();
    const sent = calls.find((c) => c.action === "restore");
    expect(sent).toMatchObject({ snapshotId: snapshots.get(s3Id) });
    expect(sent && "target" in sent && "bucket" in sent.target && sent.target.bucket).toBe("copy-bucket");
  });

  it("answers 404 for a failed copy, a target the backup never had, another site's backup and a failed backup", async () => {
    const { backupId } = await seedBackup([
      { targetId: s3Id, status: "succeeded" },
      { targetId: localId, status: "failed" },
    ]);
    const only = await seedBackup([{ targetId: localId, status: "succeeded" }]);
    const foreign = await seedBackup([{ targetId: localId, status: "succeeded" }], site2Id);
    const dead = await seedBackup([{ targetId: localId, status: "failed" }]);

    const body = (targetId?: string) => ({ confirmName: SITE_A.name, ...(targetId ? { targetId } : {}) });
    expect((await restore(backupId, body(localId))).status).toBe(404);
    expect((await restore(only.backupId, body(s3Id))).status).toBe(404);
    expect((await restore(foreign.backupId, body())).status).toBe(404);
    expect((await restore(dead.backupId, body())).status).toBe(404);
    expect((await download(backupId, { targetId: localId })).status).toBe(404);
    expect((await restore(backupId, body(`bkt_${"0".repeat(32)}`))).status).toBe(404);
    expect((await restore(backupId, { confirmName: SITE_A.name, targetId: "nope" })).status).toBe(400);
    expect(await dbClient.db.select().from(operations).where(eq(operations.kind, "site.backups.restore"))).toHaveLength(0);
  });

  it("refuses another organisation's owner (BKP-15): the site is not theirs", async () => {
    const { backupId } = await seedBackup([{ targetId: localId, status: "succeeded" }]);
    const res = await restore(backupId, { confirmName: SITE_A.name }, randomUUID(), otherOwnerToken);
    expect([403, 404]).toContain(res.status);
    const cross = await httpJson(base(), "POST", `${sitePath(siteId, otherOrgId)}/backups/${backupId}/restore`, {
      token: otherOwnerToken,
      body: { confirmName: SITE_A.name },
      key: randomUUID(),
    });
    expect(cross.status).toBe(404);
    expect((await rowOf(backupId)).restoreTargetId).toBeNull();
  });

  it("replays the same key and target to the same operation, and refuses the same key with another target", async () => {
    const { backupId } = await seedBackup([
      { targetId: s3Id, status: "succeeded" },
      { targetId: localId, status: "succeeded" },
    ]);
    const key = randomUUID();
    const first = await restore(backupId, { confirmName: SITE_A.name, targetId: localId }, key);
    expect(first.status).toBe(202);

    const same = await restore(backupId, { confirmName: SITE_A.name, targetId: localId }, key);
    expect(same.status).toBe(202);
    expect(same.body.data.operationId).toBe(first.body.data.operationId);

    const other = await restore(backupId, { confirmName: SITE_A.name, targetId: s3Id }, key);
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
    // The first request's choice is untouched.
    expect((await rowOf(backupId)).restoreTargetId).toBe(localId);
  });

  it("restores and downloads from an archived or disabled target: 'configured' is not required", async () => {
    const { backupId } = await seedBackup([{ targetId: localId, status: "succeeded" }]);
    await archiveBackupTarget(dbClient.db, localId);
    expect(await dbClient.db.select().from(backupSettings)).toHaveLength(0);

    const res = await restore(backupId, { confirmName: SITE_A.name });
    expect(res.status).toBe(202);
    await app.outboxWorker.processPendingOnce();
    expect((await rowOf(backupId)).restoreStatus).toBe("succeeded");

    const dl = await download(backupId, {});
    expect(dl.status).toBe(202);
    await app.outboxWorker.processPendingOnce();
    const row = await rowOf(backupId);
    expect(row).toMatchObject({ archiveStatus: "ready", archiveTargetId: localId });
  });

  it("prepares a download from the requested copy and queues a new archive when another copy is asked", async () => {
    const { backupId, snapshots } = await seedBackup([
      { targetId: s3Id, status: "succeeded" },
      { targetId: localId, status: "succeeded" },
    ]);
    const first = await download(backupId, { targetId: localId });
    expect(first.status).toBe(202);
    expect((await rowOf(backupId)).archiveTargetId).toBe(localId);
    await app.outboxWorker.processPendingOnce();
    expect((await rowOf(backupId)).archiveStatus).toBe("ready");
    expect(calls.find((c) => c.action === "archive" && c.jobId === first.body.data.operationId)).toMatchObject({
      snapshotId: snapshots.get(localId),
      target: { kind: "local", targetId: localId },
    });

    // The same copy while its archive is ready: the active archive is reused, nothing new queued.
    const again = await download(backupId, { targetId: localId });
    expect(again.body.data.operationId).toBe(first.body.data.operationId);

    // Another copy: a new archive from that copy.
    calls.length = 0;
    const other = await download(backupId, { targetId: s3Id });
    expect(other.status).toBe(202);
    expect(other.body.data.operationId).not.toBe(first.body.data.operationId);
    expect((await rowOf(backupId)).archiveTargetId).toBe(s3Id);
    await app.outboxWorker.processPendingOnce();
    expect(calls.find((c) => c.action === "archive")).toMatchObject({
      jobId: other.body.data.operationId,
      snapshotId: snapshots.get(s3Id),
    });
  });

  it("restores a legacy backup (snapshot, no copy rows) from the legacy S3 target; an explicit foreign target is 404", async () => {
    await upsertBackupSettings(dbClient.db, KEY, { ...LEGACY_S3, scheduleHourUtc: 2, retentionDays: 14, updatedByUserId: adminUserId });
    const snapshotId = await snapshotOn(LEGACY_S3);
    const { id: backupId } = await insertSiteBackup(dbClient.db, {
      siteId,
      kind: "manual",
      status: "running",
      operationId: null,
      siteUrl: "http://hotelroma-copy.it",
    });
    await dbClient.db
      .update(siteBackups)
      .set({ status: "succeeded", snapshotId, sizeBytes: 1, finishedAt: new Date() })
      .where(eq(siteBackups.id, backupId));

    expect((await restore(backupId, { confirmName: SITE_A.name, targetId: localId })).status).toBe(404);
    const res = await restore(backupId, { confirmName: SITE_A.name });
    expect(res.status).toBe(202);
    expect((await rowOf(backupId)).restoreTargetId).toBeNull();
    await app.outboxWorker.processPendingOnce();
    const sent = calls.find((c) => c.action === "restore");
    expect(sent).toMatchObject({ snapshotId, target: { bucket: "legacy-bucket", accessKeyId: LEGACY_S3.accessKeyId } });
  });

  it("lets the administrator restore the newest backup with a succeeded copy, partial included, from a chosen copy", async () => {
    const older = await seedBackup([{ targetId: s3Id, status: "succeeded" }]);
    await dbClient.db.update(siteBackups).set({ startedAt: new Date(Date.now() - 3_600_000) }).where(eq(siteBackups.id, older.backupId));
    const newest = await seedBackup([
      { targetId: s3Id, status: "failed" },
      { targetId: localId, status: "succeeded" },
    ]);
    expect((await rowOf(newest.backupId)).status).toBe("partial");

    const adminRestore = (body: unknown, key: string = randomUUID()) =>
      httpJson(base(), "POST", `/v1/admin/backups/sites/${siteId}/restore`, { token: adminToken, body, key });

    const res = await adminRestore({ confirmName: SITE_A.name });
    expect(res.status).toBe(202);
    expect(res.body.data.backupId).toBe(newest.backupId);
    expect((await rowOf(newest.backupId)).restoreTargetId).toBe(localId);

    // Asking for the target only the older backup holds picks that backup.
    await app.outboxWorker.processPendingOnce();
    const byTarget = await adminRestore({ confirmName: SITE_A.name, targetId: s3Id });
    expect(byTarget.status).toBe(202);
    expect(byTarget.body.data.backupId).toBe(older.backupId);
    expect((await rowOf(older.backupId)).restoreTargetId).toBe(s3Id);

    // A target no backup holds: nothing to restore.
    const none = await adminRestore({ confirmName: SITE_A.name, targetId: `bkt_${"1".repeat(32)}` });
    expect(none.status).toBe(400);
  });

  it("customer backup-policy routes: read, choose, inherit again; cross-tenant 404; unknown target 404", async () => {
    const get = await httpJson(base(), "GET", `${sitePath()}/backup-policy`, { token: ownerToken });
    expect(get.status).toBe(200);
    expect(get.body.data).toMatchObject({ inherited: true });
    expect(get.body.data.choices.map((c: Json) => c.id).sort()).toEqual([localId, s3Id].sort());
    expect(JSON.stringify(get.body)).not.toContain(CANARY_SECRET);

    const set = await httpJson(base(), "PATCH", `${sitePath()}/backup-policy`, {
      token: ownerToken,
      body: { targetIds: [localId] },
    });
    expect(set.status).toBe(200);
    expect(set.body.data).toMatchObject({ targetIds: [localId], inherited: false });

    const missing = await httpJson(base(), "PATCH", `${sitePath()}/backup-policy`, {
      token: ownerToken,
      body: { targetIds: [`bkt_${"2".repeat(32)}`] },
    });
    expect(missing.status).toBe(404);

    const inherit = await httpJson(base(), "PATCH", `${sitePath()}/backup-policy`, {
      token: ownerToken,
      body: { targetIds: null },
    });
    expect(inherit.body.data.inherited).toBe(true);

    for (const method of ["GET", "PATCH"]) {
      const cross = await httpJson(base(), method, `${sitePath(siteId, otherOrgId)}/backup-policy`, {
        token: otherOwnerToken,
        body: method === "PATCH" ? { targetIds: null } : undefined,
      });
      expect(cross.status).toBe(404);
    }
  });
});
