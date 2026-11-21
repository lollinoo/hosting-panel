import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  auditEvents,
  createDatabaseClient,
  eq,
  insertSiteBackup,
  insertSiteBackupCopies,
  insertS3Target,
  operations,
  outboxEvents,
  settleSiteBackupAggregate,
  settleSiteBackupCopy,
  siteBackupCopies,
  siteBackups,
  sites,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { InMemoryHostSimulatorAdapter } from "@hosting-panel/host-agent";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { skipPasswordChange } from "./fixtures/password-change.js";

const KEY = Buffer.alloc(32, 12);
const PW = "correct horse battery";
// A well-formed age X25519 recipient (age1 + 58 bech32 characters).
const RECIPIENT = `age1${"q".repeat(58)}`;
const SITE = {
  name: "Hotel Roma",
  domain: "hotelroma-export.it",
  title: "Hotel Roma",
  adminUser: "admin",
  adminEmail: "admin@hotelroma-export.it",
  adminPassword: "canary-Pass-123456",
};

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

describe("download format and the .zip.age refusal (BKP-13 while the export capability is off)", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let adminToken: string;
  let adminUserId: string;
  let ownerToken: string;
  let orgId: string;
  let siteId: string;
  let backupId: string;

  const base = () => app.baseUrl!;
  const sitePath = () => `/v1/organizations/${orgId}/managed-sites/${siteId}`;
  const download = (body: unknown, token = ownerToken, id = backupId) =>
    httpJson(base(), "POST", `${sitePath()}/backups/${id}/download`, { token, body, key: randomUUID() });
  const counts = async () => ({
    operations: (await dbClient.db.select().from(operations)).length,
    outbox: (await dbClient.db.select().from(outboxEvents)).length,
    audit: (await dbClient.db.select().from(auditEvents)).length,
  });

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, {
      installationName: "Test Export Format",
      hostHostname: "panel-export-format.test",
      hostIpv4: "10.0.0.1",
    });
    const admin = await createServerAdmin(dbClient.db, KEY, {
      email: "admin-export@x.it",
      name: "Admin",
      password: PW,
    });
    adminUserId = admin.userId;
    const sim = new InMemoryDockerSimulatorAdapter();
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
        email: "admin-export@x.it",
        password: PW,
        totpCode: totpCodeAt(admin.totpSecretBase32, Math.floor(Date.now() / 30_000)),
      },
    });
    adminToken = login.body.data.accessToken as string;
    const created = await httpJson(base(), "POST", "/v1/admin/customer-account", {
      token: adminToken,
      body: { organizationName: "Hotel Roma Export Org", ownerEmail: "mario-export@hotel.it", ownerName: "Mario" },
    });
    expect(created.status).toBe(201);
    await skipPasswordChange(dbClient.db, "mario-export@hotel.it");
    orgId = created.body.data.organizationId as string;
    const ownerLogin = await httpJson(base(), "POST", "/v1/auth/login", {
      body: { email: "mario-export@hotel.it", password: created.body.data.temporaryPassword as string },
    });
    ownerToken = ownerLogin.body.data.accessToken as string;
    const site = await httpJson(base(), "POST", `/v1/organizations/${orgId}/managed-sites`, {
      token: ownerToken,
      body: SITE,
      key: randomUUID(),
    });
    expect(site.status).toBe(202);
    siteId = site.body.data.siteId as string;
    await app.outboxWorker.processPendingOnce();

    const target = await insertS3Target(dbClient.db, KEY, {
      name: "Offsite",
      endpoint: "https://s3.example.com",
      region: "eu-south-1",
      bucket: "export-bucket",
      prefix: "panel",
      accessKeyId: "AKIAEXPORTTEST1",
      secretAccessKey: "canary-export-secret-DO-NOT-LEAK",
      customerSelectable: true,
      actorId: adminUserId,
    });
    const operationId = `op_${randomUUID().replaceAll("-", "")}`;
    ({ id: backupId } = await insertSiteBackup(dbClient.db, {
      siteId,
      kind: "manual",
      status: "running",
      operationId,
      siteUrl: `http://${SITE.domain}`,
      startedAt: new Date(Date.now() - 60_000),
    }));
    await insertSiteBackupCopies(dbClient.db, backupId, operationId, [
      { targetId: target.id, priority: 1, required: true },
    ]);
    const [copy] = await dbClient.db.select().from(siteBackupCopies).where(eq(siteBackupCopies.backupId, backupId));
    await settleSiteBackupCopy(dbClient.db, copy!.id, { status: "succeeded", snapshotId: "snap1", sizeBytes: 4096 });
    await settleSiteBackupAggregate(dbClient.db, backupId);
  });

  afterAll(async () => {
    await app.close();
    await dbClient.close();
  });

  beforeEach(async () => {
    await dbClient.db.update(sites).set({ status: "ready", siteUrl: `http://${SITE.domain}` }).where(eq(sites.id, siteId));
    await dbClient.db
      .update(siteBackups)
      .set({ archiveStatus: null, archiveOperationId: null, archiveReadyUntil: null })
      .where(eq(siteBackups.id, backupId));
  });

  it("refuses zip.age with 422 NOT_SUPPORTED, queues nothing and never records the recipient", async () => {
    const before = await counts();
    const res = await download({ format: "zip.age", recipient: RECIPIENT });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("NOT_SUPPORTED");
    expect(res.body.error.message).toBe("Encrypted backup export is not available.");
    expect(JSON.stringify(res.body)).not.toContain(RECIPIENT);
    expect(await counts()).toEqual(before);
    expect(JSON.stringify(await dbClient.db.select().from(auditEvents))).not.toContain(RECIPIENT);
    expect(JSON.stringify(await dbClient.db.select().from(operations))).not.toContain(RECIPIENT);
    expect(JSON.stringify(await dbClient.db.select().from(outboxEvents))).not.toContain(RECIPIENT);
    const [row] = await dbClient.db.select().from(siteBackups).where(eq(siteBackups.id, backupId));
    expect(row!.archiveStatus).toBeNull();
  });

  it("refuses zip.age before looking the backup up", async () => {
    const res = await download({ format: "zip.age", recipient: RECIPIENT }, ownerToken, `bkp_${randomUUID()}`);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("NOT_SUPPORTED");
  });

  it("answers 400 invalid_recipient for a malformed recipient, without echoing it", async () => {
    const before = await counts();
    for (const body of [
      { format: "zip.age", recipient: "age1short" },
      { format: "zip.age", recipient: `AGE1${"q".repeat(58)}` },
      { recipient: "not-a-key" },
    ]) {
      const res = await download(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(res.body.error.details).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: "recipient", message: "invalid_recipient" })]),
      );
      expect(JSON.stringify(res.body)).not.toContain(body.recipient);
    }
    expect(await counts()).toEqual(before);
  });

  it("answers 400 when zip.age has no recipient or zip carries one", async () => {
    expect((await download({ format: "zip.age" })).status).toBe(400);
    expect((await download({ format: "zip", recipient: RECIPIENT })).status).toBe(400);
    expect((await download({ recipient: RECIPIENT })).status).toBe(400);
    expect((await download({ format: "tar" })).status).toBe(400);
  });

  it("keeps zip exactly as today: no body, {}, and an explicit format zip all queue the same archive", async () => {
    const first = await download(undefined);
    expect(first.status).toBe(202);
    const operationId = first.body.data.operationId as string;
    const [op] = await dbClient.db.select().from(operations).where(eq(operations.id, operationId));
    expect(op!.kind).toBe("site.backups.download");
    // Same archive while preparing: no second operation for {} nor for format zip.
    expect((await download({})).body.data.operationId).toBe(operationId);
    const explicit = await download({ format: "zip" });
    expect(explicit.status).toBe(202);
    expect(explicit.body.data.operationId).toBe(operationId);
  });

  it("is a customer route only: a server admin token never reaches the refusal", async () => {
    const res = await download({ format: "zip.age", recipient: RECIPIENT }, adminToken);
    expect([403, 404]).toContain(res.status);
    expect(res.body.error.code).not.toBe("NOT_SUPPORTED");
    const anonymous = await httpJson(base(), "POST", `${sitePath()}/backups/${backupId}/download`, {
      body: { format: "zip.age", recipient: RECIPIENT },
      key: randomUUID(),
    });
    expect(anonymous.status).toBe(401);
  });
});
