import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import {
  PRESET_ROLE_PERMISSIONS,
  SHA512_CRYPT_HASH_PATTERN,
  SITE_SFTP_MAX_USERS,
  SiteSftpDtoSchema,
  SiteSftpPasswordResetDtoSchema,
  SiteSftpUserCreatedDtoSchema,
} from "@hosting-panel/contracts";
import {
  and,
  auditEvents,
  createDatabaseClient,
  eq,
  hostAllocations,
  hosts,
  membershipRoles,
  memberships,
  operations,
  operationSteps,
  organizations,
  outboxEvents,
  platformInstallations,
  rolePermissions,
  serviceInstances,
  sites,
  siteSftpUsers,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import {
  ExecutorCodedError,
  InMemoryDockerSimulatorAdapter,
} from "@hosting-panel/docker-executor";
import { InMemoryHostSimulatorAdapter } from "@hosting-panel/host-agent";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../src/auth/password.js";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { SiteProvisioner } from "../src/runtime/site-provisioner.js";

const KEY = Buffer.alloc(32, 7);
const PW = "correct horse battery";
const SETUP = { installationName: "Test SFTP", hostHostname: "panel.test", hostIpv4: "10.0.0.1" };
const SITE_A1 = {
  name: "Hotel Bella",
  domain: "hotel.it",
  title: "Hotel Bella Vista",
  adminUser: "admin",
  adminEmail: "admin@hotel.it",
  adminPassword: "canary-Pass-123456",
};
const SITE_A2 = {
  name: "Hotel Bella Two",
  domain: "hotel2.it",
  title: "Hotel Bella Two",
  adminUser: "admin",
  adminEmail: "admin@hotel2.it",
  adminPassword: "canary-Pass-123456",
};
const SITE_B = {
  name: "Bar Sport",
  domain: "barsport.it",
  title: "Bar Sport",
  adminUser: "admin",
  adminEmail: "admin@barsport.it",
  adminPassword: "canary-Pass-123456",
};

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

interface HttpResult {
  readonly status: number;
  readonly body: Json;
  readonly raw: string;
}

function expectedPrefix(siteId: string): string {
  return `s${createHash("sha256").update(siteId).digest("hex").slice(0, 8)}`;
}

function assertNoHashOrForbiddenKey(value: unknown, rawText: string): void {
  expect(rawText).not.toContain("$6$");
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        expect(k).not.toBe("passwordHash");
        expect(k).not.toBe("password_hash");
        walk(v);
      }
      return;
    }
    if (typeof node === "string") {
      expect(node.startsWith("$6$")).toBe(false);
    }
  };
  walk(value);
}

async function loginUser(
  baseUrl: string,
  email: string,
  password: string,
  totpSecret?: string,
): Promise<string> {
  const res = await fetch(`${baseUrl}/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password,
      ...(totpSecret ? { totpCode: totpCodeAt(totpSecret, Math.floor(Date.now() / 30_000)) } : {}),
    }),
  });
  const body = (await res.json()) as Json;
  return body.data.accessToken as string;
}

async function httpJson(
  baseUrl: string,
  method: string,
  path: string,
  options: {
    readonly token?: string;
    readonly body?: unknown;
    readonly headers?: Record<string, string>;
  } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = {
    ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    ...(options.headers ?? {}),
  };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const raw = await res.text();
  const parsed = raw ? (JSON.parse(raw) as Json) : {};
  assertNoHashOrForbiddenKey(parsed, raw);
  return {
    status: res.status,
    body: parsed,
    raw,
  };
}

describe("site SFTP HTTP API integration (linux-systemd)", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let sim: InMemoryDockerSimulatorAdapter;
  let hostSim: InMemoryHostSimulatorAdapter;

  let orgAId: string;
  let orgBId: string;
  let siteA1Id: string;
  let siteA2Id: string;
  let siteBId: string;
  let svcA1Id: string;
  let svcA2Id: string;

  let ownerAToken: string;
  let ownerBToken: string;
  let adminToken: string;
  let infraMemberToken: string;
  let collabToken: string;
  let baselineAuditIds: Set<string>;

  const sftpBase = (orgId: string, siteId: string, tail = "") =>
    `/v1/organizations/${orgId}/managed-sites/${siteId}/sftp${tail}`;

  const call = (
    method: string,
    path: string,
    body?: unknown,
    token: string | undefined = ownerAToken,
    headers?: Record<string, string>,
  ) => httpJson(app.baseUrl!, method, path, { token, body, headers });

  async function snapshotAudits(): Promise<void> {
    const rows = await dbClient.db.select({ id: auditEvents.id }).from(auditEvents);
    baselineAuditIds = new Set(rows.map((r) => r.id));
  }

  async function newAudits() {
    const rows = await dbClient.db.select().from(auditEvents);
    return rows.filter((r) => !baselineAuditIds.has(r.id));
  }

  function allFourRouteSpecs(orgId: string, siteId: string, userId = "usr_sftp_dummy") {
    return [
      { method: "GET", path: sftpBase(orgId, siteId), body: undefined },
      { method: "POST", path: sftpBase(orgId, siteId, "/users"), body: { name: "probe" } },
      {
        method: "POST",
        path: sftpBase(orgId, siteId, `/users/${userId}/reset-password`),
        body: undefined,
      },
      { method: "DELETE", path: sftpBase(orgId, siteId, `/users/${userId}`), body: undefined },
    ] as const;
  }

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, {
      email: "admin-sftp@x.it",
      name: "Admin",
      password: PW,
    });

    sim = new InMemoryDockerSimulatorAdapter();
    hostSim = new InMemoryHostSimulatorAdapter();
    const jwtSigningKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();

    app = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      jwtSigningKeyPem,
      runtimeBackend: "linux-systemd",
      dockerExecutor: sim,
      hostAgent: hostSim,
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
      domainReconcileIntervalMs: null,
      mailRelayRetryIntervalMs: null,
      sftpRetryIntervalMs: null,
      recoverUnknownOnStart: false,
    });

    adminToken = await loginUser(app.baseUrl!, "admin-sftp@x.it", PW, admin.totpSecretBase32);

    // Organization A + owner
    const createdA = await call(
      "POST",
      "/v1/admin/customer-account",
      { organizationName: "Hotel Mario", ownerEmail: "mario-sftp@hotel.it", ownerName: "Mario" },
      adminToken,
    );
    expect(createdA.status).toBe(201);
    orgAId = createdA.body.data.organizationId as string;
    ownerAToken = await loginUser(
      app.baseUrl!,
      "mario-sftp@hotel.it",
      createdA.body.data.temporaryPassword as string,
    );

    // Organization B + dedicated host + owner
    const [inst] = await dbClient.db.select().from(platformInstallations).limit(1);
    const hostBId = `hst_${randomUUID()}`;
    await dbClient.db.insert(hosts).values({
      id: hostBId,
      platformInstallationId: inst!.id,
      name: "panel-b.test",
      hostname: "panel-b.test",
      ipv4Address: "10.0.0.2",
      hostingMode: "dedicated",
      totalCpuMilli: 4000,
      totalMemoryBytes: "8589934592",
      totalStorageBytes: "107374182400",
    });
    orgBId = `org_${randomUUID()}`;
    await dbClient.db.insert(organizations).values({
      id: orgBId,
      platformInstallationId: inst!.id,
      name: "Bar Sport Org",
      slug: "bar-sport-sftp-org",
    });
    await dbClient.db.insert(hostAllocations).values({
      id: `alloc_${randomUUID()}`,
      hostId: hostBId,
      organizationId: orgBId,
      status: "active",
    });
    const ownerBUserId = `usr_${randomUUID()}`;
    const ownerBMemId = `mem_${randomUUID()}`;
    await dbClient.db.insert(users).values({
      id: ownerBUserId,
      email: "luigi-sftp@barsport.it",
      name: "Luigi",
      passwordHash: await hashPassword(PW),
    });
    await dbClient.db
      .insert(memberships)
      .values({ id: ownerBMemId, organizationId: orgBId, userId: ownerBUserId });
    await dbClient.db.insert(membershipRoles).values({
      id: `mrl_${randomUUID()}`,
      membershipId: ownerBMemId,
      roleId: "role_customer_owner",
    });
    ownerBToken = await loginUser(app.baseUrl!, "luigi-sftp@barsport.it", PW);

    // Collaborator in Org A
    const collabId = `usr_${randomUUID()}`;
    const collabMemId = `mem_${randomUUID()}`;
    await dbClient.db.insert(users).values({
      id: collabId,
      email: "collab-sftp@hotel.it",
      name: "Collab",
      passwordHash: await hashPassword(PW),
    });
    await dbClient.db
      .insert(memberships)
      .values({ id: collabMemId, organizationId: orgAId, userId: collabId });
    await dbClient.db.insert(membershipRoles).values({
      id: `mrl_${randomUUID()}`,
      membershipId: collabMemId,
      roleId: "role_customer_collaborator",
    });
    collabToken = await loginUser(app.baseUrl!, "collab-sftp@hotel.it", PW);

    // Infrastructure admin assigned to Org A with role_infrastructure_admin (no site.sftp.manage)
    const infraMemAdmin = await createServerAdmin(dbClient.db, KEY, {
      email: "infra-member-sftp@hotel.it",
      name: "Infra Member",
      password: PW,
    });
    const infraMemId = `mem_${randomUUID()}`;
    await dbClient.db
      .insert(memberships)
      .values({ id: infraMemId, organizationId: orgAId, userId: infraMemAdmin.userId });
    await dbClient.db.insert(membershipRoles).values({
      id: `mrl_${randomUUID()}`,
      membershipId: infraMemId,
      roleId: "role_infrastructure_admin",
    });
    infraMemberToken = await loginUser(
      app.baseUrl!,
      "infra-member-sftp@hotel.it",
      PW,
      infraMemAdmin.totpSecretBase32,
    );

    // Provision two sites in Org A and one site in Org B
    const cA1 = await call(
      "POST",
      `/v1/organizations/${orgAId}/managed-sites`,
      SITE_A1,
      ownerAToken,
      { "Idempotency-Key": randomUUID() },
    );
    expect(cA1.status).toBe(202);
    siteA1Id = cA1.body.data.siteId as string;

    const cA2 = await call(
      "POST",
      `/v1/organizations/${orgAId}/managed-sites`,
      SITE_A2,
      ownerAToken,
      { "Idempotency-Key": randomUUID() },
    );
    expect(cA2.status).toBe(202);
    siteA2Id = cA2.body.data.siteId as string;

    const cB = await call(
      "POST",
      `/v1/organizations/${orgBId}/managed-sites`,
      SITE_B,
      ownerBToken,
      { "Idempotency-Key": randomUUID() },
    );
    expect(cB.status).toBe(202);
    siteBId = cB.body.data.siteId as string;

    await app.outboxWorker.processPendingOnce();

    const [svcA1] = await dbClient.db
      .select()
      .from(serviceInstances)
      .where(eq(serviceInstances.siteId, siteA1Id));
    const [svcA2] = await dbClient.db
      .select()
      .from(serviceInstances)
      .where(eq(serviceInstances.siteId, siteA2Id));
    svcA1Id = svcA1!.id;
    svcA2Id = svcA2!.id;
  });

  afterAll(async () => {
    await app.close();
    await dbClient.close();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await dbClient.db.delete(siteSftpUsers);
    await dbClient.db.delete(outboxEvents);
    await dbClient.db.delete(operationSteps);
    await dbClient.db.delete(operations);
    await dbClient.db.update(sites).set({ status: "ready" }).where(eq(sites.id, siteA1Id));
    await dbClient.db.update(sites).set({ status: "ready" }).where(eq(sites.id, siteA2Id));
    sim.sftpUsers = [];
    sim.failNextSftpApply(0);
    sim.sftpApplies.length = 0;
    await app.siteSftp.ensureApplied(true);
    sim.sftpApplies.length = 0;
    await snapshotAudits();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports sftpAvailable: true on linux-systemd in /v1/me and organization capabilities", async () => {
    const meRes = await call("GET", "/v1/me");
    expect(meRes.status).toBe(200);
    expect(meRes.body.data.platformCapabilities.sftpAvailable).toBe(true);
    expect(meRes.body.data.platformCapabilities.phpMyAdminAvailable).toBe(true);

    const capRes = await call("GET", `/v1/organizations/${orgAId}/capabilities`);
    expect(capRes.status).toBe(200);
    expect(capRes.body.data.sftpAvailable).toBe(true);
    expect(capRes.body.data.phpMyAdminAvailable).toBe(true);
  });

  it("GET /sftp returns host IPv4, port and fingerprint from spy, and degrades port/fingerprint to null with 200 when getSftpStatus throws", async () => {
    vi.spyOn(sim, "getSftpStatus").mockResolvedValueOnce({
      running: true,
      port: 2222,
      hostKeyFingerprint: "SHA256:abcdef1234567890",
    });

    const okRes = await call("GET", sftpBase(orgAId, siteA1Id));
    expect(okRes.status).toBe(200);
    expect(SiteSftpDtoSchema.parse(okRes.body.data)).toEqual({
      available: true,
      host: "10.0.0.1",
      port: 2222,
      hostKeyFingerprint: "SHA256:abcdef1234567890",
      users: [],
    });

    vi.spyOn(sim, "getSftpStatus").mockRejectedValueOnce(
      new ExecutorCodedError("SFTP status failed", "DOCKER_ENGINE_UNAVAILABLE"),
    );

    const degradedRes = await call("GET", sftpBase(orgAId, siteA1Id));
    expect(degradedRes.status).toBe(200);
    expect(SiteSftpDtoSchema.parse(degradedRes.body.data)).toEqual({
      available: true,
      host: "10.0.0.1",
      port: null,
      hostKeyFingerprint: null,
      users: [],
    });
  });

  it("create, reset-password, and delete lifecycle: 24-char temporaryPassword shown once, $6$ hash in DB & spy, audit rows, zero secret leaks", async () => {
    const applySpy = vi.spyOn(sim, "applySftpAccess");
    const generatedPasswords: string[] = [];

    // 1. Create first user
    const create1 = await call("POST", sftpBase(orgAId, siteA1Id, "/users"), { name: "dev1" });
    expect(create1.status).toBe(201);
    const created1 = SiteSftpUserCreatedDtoSchema.parse(create1.body.data);
    expect(created1.temporaryPassword).toHaveLength(24);
    expect(created1.user.username).toBe(`${expectedPrefix(siteA1Id)}_dev1`);
    generatedPasswords.push(created1.temporaryPassword);

    const [dbRow1] = await dbClient.db
      .select()
      .from(siteSftpUsers)
      .where(eq(siteSftpUsers.id, created1.user.id));
    expect(dbRow1).toBeDefined();
    expect(dbRow1!.passwordHash).toMatch(SHA512_CRYPT_HASH_PATTERN);
    expect(dbRow1!.passwordHash.startsWith("$6$")).toBe(true);

    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(applySpy).toHaveBeenLastCalledWith({
      users: [
        {
          username: created1.user.username,
          passwordHash: dbRow1!.passwordHash,
          siteId: siteA1Id,
          serviceInstanceId: svcA1Id,
        },
      ],
    });

    // 2. Create second user -> spy receives full desired state (both users)
    const create2 = await call("POST", sftpBase(orgAId, siteA1Id, "/users"), { name: "alice" });
    expect(create2.status).toBe(201);
    const created2 = SiteSftpUserCreatedDtoSchema.parse(create2.body.data);
    expect(created2.temporaryPassword).toHaveLength(24);
    generatedPasswords.push(created2.temporaryPassword);

    const [dbRow2] = await dbClient.db
      .select()
      .from(siteSftpUsers)
      .where(eq(siteSftpUsers.id, created2.user.id));
    expect(applySpy).toHaveBeenCalledTimes(2);
    expect(applySpy.mock.calls[1]![0].users).toHaveLength(2);
    expect(applySpy.mock.calls[1]![0].users).toEqual(
      expect.arrayContaining([
        {
          username: created1.user.username,
          passwordHash: dbRow1!.passwordHash,
          siteId: siteA1Id,
          serviceInstanceId: svcA1Id,
        },
        {
          username: created2.user.username,
          passwordHash: dbRow2!.passwordHash,
          siteId: siteA1Id,
          serviceInstanceId: svcA1Id,
        },
      ]),
    );

    // 3. Reset password on user 1
    const resetRes = await call(
      "POST",
      sftpBase(orgAId, siteA1Id, `/users/${created1.user.id}/reset-password`),
    );
    expect(resetRes.status).toBe(200);
    const resetDto = SiteSftpPasswordResetDtoSchema.parse(resetRes.body.data);
    expect(resetDto.temporaryPassword).toHaveLength(24);
    expect(resetDto.temporaryPassword).not.toBe(created1.temporaryPassword);
    generatedPasswords.push(resetDto.temporaryPassword);

    const [dbRow1AfterReset] = await dbClient.db
      .select()
      .from(siteSftpUsers)
      .where(eq(siteSftpUsers.id, created1.user.id));
    expect(dbRow1AfterReset!.passwordHash).toMatch(SHA512_CRYPT_HASH_PATTERN);
    expect(dbRow1AfterReset!.passwordHash).not.toBe(dbRow1!.passwordHash);
    expect(applySpy).toHaveBeenCalledTimes(3);
    expect(
      applySpy.mock.calls[2]![0].users.find((u) => u.username === created1.user.username)
        ?.passwordHash,
    ).toBe(dbRow1AfterReset!.passwordHash);

    // 4. GET /sftp does not leak any temporaryPassword or passwordHash
    const listRes = await call("GET", sftpBase(orgAId, siteA1Id));
    expect(listRes.status).toBe(200);
    const listed = SiteSftpDtoSchema.parse(listRes.body.data);
    expect(listed.users).toHaveLength(2);
    for (const pw of generatedPasswords) {
      expect(listRes.raw).not.toContain(pw);
    }

    // 5. Delete user 1 -> 204 empty body, removed from DB and spy receives only user 2
    const delRes = await call("DELETE", sftpBase(orgAId, siteA1Id, `/users/${created1.user.id}`));
    expect(delRes.status).toBe(204);
    expect(delRes.raw).toBe("");
    const afterDelRows = await dbClient.db
      .select()
      .from(siteSftpUsers)
      .where(eq(siteSftpUsers.id, created1.user.id));
    expect(afterDelRows).toEqual([]);
    expect(applySpy).toHaveBeenCalledTimes(4);
    expect(applySpy.mock.calls[3]![0].users).toEqual([
      {
        username: created2.user.username,
        passwordHash: dbRow2!.passwordHash,
        siteId: siteA1Id,
        serviceInstanceId: svcA1Id,
      },
    ]);

    // 6. Verify audit events for create, reset, and delete carry { userId, username } and targetType: "site"
    const audits = await newAudits();
    expect(audits.map((a) => a.action)).toEqual([
      "site.sftp.user.create",
      "site.sftp.user.create",
      "site.sftp.user.password_reset",
      "site.sftp.user.delete",
    ]);
    expect(audits[0]).toMatchObject({
      action: "site.sftp.user.create",
      targetType: "site",
      targetId: siteA1Id,
      details: { userId: created1.user.id, username: created1.user.username },
    });
    expect(audits[2]).toMatchObject({
      action: "site.sftp.user.password_reset",
      targetType: "site",
      targetId: siteA1Id,
      details: { userId: created1.user.id, username: created1.user.username },
    });
    expect(audits[3]).toMatchObject({
      action: "site.sftp.user.delete",
      targetType: "site",
      targetId: siteA1Id,
      details: { userId: created1.user.id, username: created1.user.username },
    });

    // 7. Temporary passwords never appear in audit_events, outbox_events, or operations
    const allAuditsText = JSON.stringify(await dbClient.db.select().from(auditEvents));
    const allOutboxText = JSON.stringify(await dbClient.db.select().from(outboxEvents));
    const allOpsText = JSON.stringify(await dbClient.db.select().from(operations));
    for (const pw of generatedPasswords) {
      expect(allAuditsText).not.toContain(pw);
      expect(allOutboxText).not.toContain(pw);
      expect(allOpsText).not.toContain(pw);
    }
    expect(allAuditsText).not.toContain("$6$");
    expect(allOutboxText).not.toContain("$6$");
    expect(allOpsText).not.toContain("$6$");
  });

  it("normalizes uppercase and spaces in name, rejects a_b and 17-char names with VALIDATION_ERROR, and allows same name on two different sites with distinct login names", async () => {
    const applySpy = vi.spyOn(sim, "applySftpAccess");

    const normalizedRes = await call("POST", sftpBase(orgAId, siteA1Id, "/users"), {
      name: " Dev1 ",
    });
    expect(normalizedRes.status).toBe(201);
    expect(normalizedRes.body.data.user.username).toBe(`${expectedPrefix(siteA1Id)}_dev1`);

    const sameNameSite2Res = await call("POST", sftpBase(orgAId, siteA2Id, "/users"), {
      name: "dev1",
    });
    expect(sameNameSite2Res.status).toBe(201);
    expect(sameNameSite2Res.body.data.user.username).toBe(`${expectedPrefix(siteA2Id)}_dev1`);
    expect(sameNameSite2Res.body.data.user.username).not.toBe(
      normalizedRes.body.data.user.username,
    );
    expect(applySpy).toHaveBeenLastCalledWith({
      users: expect.arrayContaining([
        expect.objectContaining({
          username: `${expectedPrefix(siteA2Id)}_dev1`,
          siteId: siteA2Id,
          serviceInstanceId: svcA2Id,
        }),
      ]),
    });

    const callsBeforeInvalid = applySpy.mock.calls.length;

    const underscoreRes = await call("POST", sftpBase(orgAId, siteA1Id, "/users"), {
      name: "a_b",
    });
    expect(underscoreRes.status).toBe(400);
    expect(underscoreRes.body.error.code).toBe("VALIDATION_ERROR");

    const tooLongRes = await call("POST", sftpBase(orgAId, siteA1Id, "/users"), {
      name: "a".repeat(17),
    });
    expect(tooLongRes.status).toBe(400);
    expect(tooLongRes.body.error.code).toBe("VALIDATION_ERROR");

    expect(applySpy).toHaveBeenCalledTimes(callsBeforeInvalid);
  });

  it("enforces duplicate ALREADY_EXISTS, 10-user QUOTA_EXCEEDED, and serializes two concurrent creates at 9 users", async () => {
    const applySpy = vi.spyOn(sim, "applySftpAccess");

    for (let i = 1; i <= 8; i += 1) {
      const res = await call("POST", sftpBase(orgAId, siteA1Id, "/users"), { name: `user${i}` });
      expect(res.status).toBe(201);
    }

    // Duplicate while under quota -> 409 ALREADY_EXISTS without calling executor
    const callsBeforeDup = applySpy.mock.calls.length;
    const dupRes = await call("POST", sftpBase(orgAId, siteA1Id, "/users"), { name: "user1" });
    expect(dupRes.status).toBe(409);
    expect(dupRes.body.error.code).toBe("ALREADY_EXISTS");
    expect(applySpy).toHaveBeenCalledTimes(callsBeforeDup);

    // 9th user
    const ninth = await call("POST", sftpBase(orgAId, siteA1Id, "/users"), { name: "user9" });
    expect(ninth.status).toBe(201);

    // Two creates sent concurrently at 9 users -> one 201, one 409 QUOTA_EXCEEDED, exactly 10 users
    const [race1, race2] = await Promise.all([
      call("POST", sftpBase(orgAId, siteA1Id, "/users"), { name: "race1" }),
      call("POST", sftpBase(orgAId, siteA1Id, "/users"), { name: "race2" }),
    ]);
    const statuses = [race1.status, race2.status].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);
    const rejectedRace = race1.status === 409 ? race1 : race2;
    expect(rejectedRace.body.error.code).toBe("QUOTA_EXCEEDED");

    const dbUsers = await dbClient.db
      .select()
      .from(siteSftpUsers)
      .where(eq(siteSftpUsers.siteId, siteA1Id));
    expect(dbUsers).toHaveLength(SITE_SFTP_MAX_USERS);

    // 11th user after reaching 10 -> 409 QUOTA_EXCEEDED without calling executor
    const callsBefore11th = applySpy.mock.calls.length;
    const eleventh = await call("POST", sftpBase(orgAId, siteA1Id, "/users"), { name: "user11" });
    expect(eleventh.status).toBe(409);
    expect(eleventh.body.error.code).toBe("QUOTA_EXCEEDED");
    expect(applySpy).toHaveBeenCalledTimes(callsBefore11th);
  });

  it("compensates DB state on apply failure (create, reset, delete) and OPERATION_AMBIGUOUS, then tick() sends full desired state on recovery", async () => {
    const seed = await call("POST", sftpBase(orgAId, siteA1Id, "/users"), { name: "anchor" });
    expect(seed.status).toBe(201);
    const anchorId = seed.body.data.user.id as string;

    const [anchorBefore] = await dbClient.db
      .select()
      .from(siteSftpUsers)
      .where(eq(siteSftpUsers.id, anchorId));
    await snapshotAudits();

    // 1. Create failure -> 503 DOCKER_ENGINE_UNAVAILABLE, row gone
    sim.failNextSftpApply(1);
    const failedCreate = await call("POST", sftpBase(orgAId, siteA1Id, "/users"), {
      name: "willfail",
    });
    expect(failedCreate.status).toBe(503);
    expect(failedCreate.body.error.code).toBe("DOCKER_ENGINE_UNAVAILABLE");
    expect(failedCreate.body.error.retryable).toBe(true);
    expect(
      await dbClient.db.select().from(siteSftpUsers).where(eq(siteSftpUsers.siteId, siteA1Id)),
    ).toHaveLength(1);

    // 2. Reset failure -> 503 DOCKER_ENGINE_UNAVAILABLE, old hash & timestamp restored
    sim.failNextSftpApply(1);
    const failedReset = await call(
      "POST",
      sftpBase(orgAId, siteA1Id, `/users/${anchorId}/reset-password`),
    );
    expect(failedReset.status).toBe(503);
    expect(failedReset.body.error.code).toBe("DOCKER_ENGINE_UNAVAILABLE");
    const [anchorAfterFailedReset] = await dbClient.db
      .select()
      .from(siteSftpUsers)
      .where(eq(siteSftpUsers.id, anchorId));
    expect(anchorAfterFailedReset!.passwordHash).toBe(anchorBefore!.passwordHash);
    expect(anchorAfterFailedReset!.passwordChangedAt.getTime()).toBe(
      anchorBefore!.passwordChangedAt.getTime(),
    );

    // 3. Delete failure -> 503 DOCKER_ENGINE_UNAVAILABLE, row restored
    sim.failNextSftpApply(1);
    const failedDelete = await call("DELETE", sftpBase(orgAId, siteA1Id, `/users/${anchorId}`));
    expect(failedDelete.status).toBe(503);
    expect(failedDelete.body.error.code).toBe("DOCKER_ENGINE_UNAVAILABLE");
    const [anchorAfterFailedDelete] = await dbClient.db
      .select()
      .from(siteSftpUsers)
      .where(eq(siteSftpUsers.id, anchorId));
    expect(anchorAfterFailedDelete).toEqual(anchorBefore);

    // No successful audit rows were written for any of the failed mutations
    expect(await newAudits()).toEqual([]);

    // 4. OPERATION_AMBIGUOUS from spy -> compensated like failure, next tick() sends full desired state
    const applySpy = vi.spyOn(sim, "applySftpAccess");
    applySpy.mockRejectedValueOnce(
      new ExecutorCodedError("No reply from executor", "OPERATION_AMBIGUOUS"),
    );

    const ambiguousCreate = await call("POST", sftpBase(orgAId, siteA1Id, "/users"), {
      name: "ambig",
    });
    expect(ambiguousCreate.status).toBe(503);
    expect(ambiguousCreate.body.error.code).toBe("DOCKER_ENGINE_UNAVAILABLE");
    expect(
      await dbClient.db.select().from(siteSftpUsers).where(eq(siteSftpUsers.siteId, siteA1Id)),
    ).toHaveLength(1);

    const callsBeforeTick = applySpy.mock.calls.length;
    await app.siteSftp.tick();
    expect(applySpy).toHaveBeenCalledTimes(callsBeforeTick + 1);
    expect(applySpy.mock.calls[callsBeforeTick]![0]).toEqual({
      users: [
        {
          username: anchorBefore!.username,
          passwordHash: anchorBefore!.passwordHash,
          siteId: siteA1Id,
          serviceInstanceId: svcA1Id,
        },
      ],
    });
  });

  it("enforces authentication (401), cross-org tenancy (404), cross-site userId scoping (404), and role denials (403 + denied audit row)", async () => {
    const createSite2User = await call("POST", sftpBase(orgAId, siteA2Id, "/users"), {
      name: "site2only",
    });
    expect(createSite2User.status).toBe(201);
    const site2UserId = createSite2User.body.data.user.id as string;

    const applySpy = vi.spyOn(sim, "applySftpAccess");
    const statusSpy = vi.spyOn(sim, "getSftpStatus");
    await snapshotAudits();

    // 1. Unauthenticated -> 401 on all 4 routes
    for (const route of allFourRouteSpecs(orgAId, siteA1Id, site2UserId)) {
      const res = await httpJson(app.baseUrl!, route.method, route.path, { body: route.body });
      expect(res.status, `unauthenticated ${route.method} ${route.path}`).toBe(401);
    }

    // 2. Member of another org -> 404 on all 4 routes (both directions)
    for (const route of [
      ...allFourRouteSpecs(orgAId, siteA1Id, site2UserId),
      ...allFourRouteSpecs(orgBId, siteA1Id, site2UserId),
    ]) {
      const res = await call(route.method, route.path, route.body, ownerBToken);
      expect(res.status, `foreign org member B on ${route.method} ${route.path}`).toBe(404);
    }
    for (const route of [
      ...allFourRouteSpecs(orgBId, siteBId, site2UserId),
      ...allFourRouteSpecs(orgAId, siteBId, site2UserId),
    ]) {
      const res = await call(route.method, route.path, route.body, ownerAToken);
      expect(res.status, `foreign org member A on ${route.method} ${route.path}`).toBe(404);
    }

    // 3. User ID belonging to another site of the SAME organization -> 404 on reset and delete
    const crossSiteReset = await call(
      "POST",
      sftpBase(orgAId, siteA1Id, `/users/${site2UserId}/reset-password`),
    );
    expect(crossSiteReset.status).toBe(404);
    const crossSiteDelete = await call(
      "DELETE",
      sftpBase(orgAId, siteA1Id, `/users/${site2UserId}`),
    );
    expect(crossSiteDelete.status).toBe(404);

    // Site 2 user must still exist
    const site2List = await call("GET", sftpBase(orgAId, siteA2Id));
    expect(site2List.status).toBe(200);
    expect(site2List.body.data.users.map((u: Json) => u.id)).toEqual([site2UserId]);
    statusSpy.mockClear();

    // 4. Non-member infrastructure admin gets 404 (anti-BOLA)
    for (const route of allFourRouteSpecs(orgAId, siteA1Id, site2UserId)) {
      const res = await call(route.method, route.path, route.body, adminToken);
      expect(res.status, `non-member infra admin ${route.method} ${route.path}`).toBe(404);
    }

    // 5. Collaborator and infrastructure admin member -> 403 + denied audit row on all 4 routes
    for (const [label, tok] of [
      ["collaborator", collabToken],
      ["infrastructure_admin", infraMemberToken],
    ] as const) {
      for (const route of allFourRouteSpecs(orgAId, siteA1Id, site2UserId)) {
        const beforeCount = (await newAudits()).length;
        const res = await call(route.method, route.path, route.body, tok);
        expect(res.status, `${label} ${route.method} ${route.path}`).toBe(403);
        expect(res.body.error.code).toBe("PERMISSION_DENIED");
        const auditsNow = await newAudits();
        expect(auditsNow).toHaveLength(beforeCount + 1);
        const deniedRow = auditsNow[auditsNow.length - 1]!;
        expect(deniedRow.action).toBe("site.sftp.manage");
        expect(deniedRow.targetType).toBe("site");
        expect(deniedRow.targetId).toBe(siteA1Id);
        expect((deniedRow.details as Json)["outcome"]).toBe("denied");
      }
    }

    expect(applySpy).not.toHaveBeenCalled();
    expect(statusSpy).not.toHaveBeenCalled();
  });

  it("site.delete applies desired state without the deleted site BEFORE deleteService/purgeSite, and keeps SFTP rows if apply fails", async () => {
    // Keep an SFTP user on siteA1 so desired state remains non-empty when the disposable site is removed.
    const keepUser = await call("POST", sftpBase(orgAId, siteA1Id, "/users"), { name: "keeper" });
    expect(keepUser.status).toBe(201);
    const keeperUsername = keepUser.body.data.user.username as string;

    // Create a disposable site in Org A with an SFTP user.
    const dispName = "Disposable Site";
    const createDisp = await call(
      "POST",
      `/v1/organizations/${orgAId}/managed-sites`,
      {
        name: dispName,
        domain: `disp-${randomUUID().slice(0, 6)}.it`,
        title: dispName,
        adminUser: "admin",
        adminEmail: "admin@disp.it",
        adminPassword: "canary-Pass-123456",
      },
      ownerAToken,
      { "Idempotency-Key": randomUUID() },
    );
    expect(createDisp.status).toBe(202);
    const dispSiteId = createDisp.body.data.siteId as string;
    await app.outboxWorker.processPendingOnce();

    const dispUser = await call("POST", sftpBase(orgAId, dispSiteId, "/users"), {
      name: "dispuser",
    });
    expect(dispUser.status).toBe(201);

    // 1. Apply fails during site.delete -> operation fails, deleteService/purgeSite not called, SFTP rows remain
    sim.failNextSftpApply(1);
    const delServiceSpyFail = vi.spyOn(sim, "deleteService");
    const purgeSiteSpyFail = vi.spyOn(sim, "purgeSite");

    const delReq1 = await call(
      "DELETE",
      `/v1/organizations/${orgAId}/managed-sites/${dispSiteId}`,
      { confirmName: dispName },
      ownerAToken,
      { "Idempotency-Key": randomUUID() },
    );
    expect(delReq1.status).toBe(202);
    const op1Id = delReq1.body.data.operationId as string;

    await app.outboxWorker.processPendingOnce();

    const op1After = await call("GET", `/v1/organizations/${orgAId}/operations/${op1Id}`);
    expect(op1After.status).toBe(200);
    expect(op1After.body.data.status).toBe("failed");
    expect(delServiceSpyFail).not.toHaveBeenCalled();
    expect(purgeSiteSpyFail).not.toHaveBeenCalled();
    expect(
      await dbClient.db.select().from(siteSftpUsers).where(eq(siteSftpUsers.siteId, dispSiteId)),
    ).toHaveLength(1);

    vi.restoreAllMocks();

    // 2. Retry site.delete when apply succeeds -> applySftpAccess without dispSiteId runs BEFORE deleteService/purgeSite
    const callOrder: string[] = [];
    const origApply = sim.applySftpAccess.bind(sim);
    const origDeleteService = sim.deleteService.bind(sim);
    const origPurgeSite = sim.purgeSite.bind(sim);

    const applyOrderSpy = vi.spyOn(sim, "applySftpAccess").mockImplementation(async (req) => {
      callOrder.push("applySftpAccess");
      return origApply(req);
    });
    vi.spyOn(sim, "deleteService").mockImplementation(async (id) => {
      callOrder.push("deleteService");
      return origDeleteService(id);
    });
    vi.spyOn(sim, "purgeSite").mockImplementation(async (id) => {
      callOrder.push("purgeSite");
      return origPurgeSite(id);
    });

    const delReq2 = await call(
      "DELETE",
      `/v1/organizations/${orgAId}/managed-sites/${dispSiteId}`,
      { confirmName: dispName },
      ownerAToken,
      { "Idempotency-Key": randomUUID() },
    );
    expect(delReq2.status).toBe(202);
    const op2Id = delReq2.body.data.operationId as string;

    await app.outboxWorker.processPendingOnce();

    const op2After = await call("GET", `/v1/organizations/${orgAId}/operations/${op2Id}`);
    expect(op2After.status).toBe(200);
    expect(op2After.body.data.status).toBe("succeeded");

    const applyIdx = callOrder.indexOf("applySftpAccess");
    const delSvcIdx = callOrder.indexOf("deleteService");
    const purgeIdx = callOrder.indexOf("purgeSite");
    expect(applyIdx).toBeGreaterThanOrEqual(0);
    expect(delSvcIdx).toBeGreaterThan(applyIdx);
    expect(purgeIdx).toBeGreaterThan(applyIdx);

    expect(applyOrderSpy).toHaveBeenCalledWith({
      users: [
        expect.objectContaining({
          username: keeperUsername,
          siteId: siteA1Id,
        }),
      ],
    });

    expect(
      await dbClient.db.select().from(siteSftpUsers).where(eq(siteSftpUsers.siteId, dispSiteId)),
    ).toEqual([]);
    expect(
      await dbClient.db.select().from(siteSftpUsers).where(eq(siteSftpUsers.siteId, siteA1Id)),
    ).toHaveLength(1);
  });

  it("refuses POST /sftp/users and POST /reset-password with 409 RESOURCE_LOCKED (not_ready) when site is in maintenance or deploying, while keeping DELETE allowed", async () => {
    const seeded = await call("POST", sftpBase(orgAId, siteA1Id, "/users"), { name: "keeper" });
    expect(seeded.status).toBe(201);
    const seededId = seeded.body.data.user.id as string;
    const [seededBefore] = await dbClient.db
      .select()
      .from(siteSftpUsers)
      .where(eq(siteSftpUsers.id, seededId));

    const applySpy = vi.spyOn(sim, "applySftpAccess");
    await snapshotAudits();

    for (const status of ["maintenance", "deploying"] as const) {
      await dbClient.db.update(sites).set({ status }).where(eq(sites.id, siteA1Id));

      const createRes = await call("POST", sftpBase(orgAId, siteA1Id, "/users"), {
        name: "blocked",
      });
      expect(createRes.status).toBe(409);
      expect(createRes.body.error.code).toBe("RESOURCE_LOCKED");
      expect(createRes.body.error.details[0]?.reason).toBe("not_ready");

      const resetRes = await call(
        "POST",
        sftpBase(orgAId, siteA1Id, `/users/${seededId}/reset-password`),
      );
      expect(resetRes.status).toBe(409);
      expect(resetRes.body.error.code).toBe("RESOURCE_LOCKED");
      expect(resetRes.body.error.details[0]?.reason).toBe("not_ready");

      const rows = await dbClient.db
        .select()
        .from(siteSftpUsers)
        .where(eq(siteSftpUsers.siteId, siteA1Id));
      expect(rows).toEqual([seededBefore]);
      expect(applySpy).not.toHaveBeenCalled();
      expect(await newAudits()).toEqual([]);
    }

    // Delete remains allowed even while the site is in maintenance.
    await dbClient.db.update(sites).set({ status: "maintenance" }).where(eq(sites.id, siteA1Id));
    const deleteRes = await call("DELETE", sftpBase(orgAId, siteA1Id, `/users/${seededId}`));
    expect(deleteRes.status).toBe(204);
    expect(
      await dbClient.db.select().from(siteSftpUsers).where(eq(siteSftpUsers.siteId, siteA1Id)),
    ).toEqual([]);
    expect(applySpy).toHaveBeenCalledTimes(1);
    expect((await newAudits()).map((a) => a.action)).toEqual(["site.sftp.user.delete"]);
  });

  it("allows site.delete on a site with zero SFTP users even when applySftpAccess would fail", async () => {
    const dispName = "No Sftp Site";
    const createDisp = await call(
      "POST",
      `/v1/organizations/${orgAId}/managed-sites`,
      {
        name: dispName,
        domain: `nosftp-${randomUUID().slice(0, 6)}.it`,
        title: dispName,
        adminUser: "admin",
        adminEmail: "admin@nosftp.it",
        adminPassword: "canary-Pass-123456",
      },
      ownerAToken,
      { "Idempotency-Key": randomUUID() },
    );
    expect(createDisp.status).toBe(202);
    const dispSiteId = createDisp.body.data.siteId as string;
    await app.outboxWorker.processPendingOnce();

    sim.failNextSftpApply(1);
    const applySpy = vi.spyOn(sim, "applySftpAccess");

    const delReq = await call(
      "DELETE",
      `/v1/organizations/${orgAId}/managed-sites/${dispSiteId}`,
      { confirmName: dispName },
      ownerAToken,
      { "Idempotency-Key": randomUUID() },
    );
    expect(delReq.status).toBe(202);
    await app.outboxWorker.processPendingOnce();

    const opAfter = await call("GET", `/v1/organizations/${orgAId}/operations/${delReq.body.data.operationId}`);
    expect(opAfter.status).toBe(200);
    expect(opAfter.body.data.status).toBe("succeeded");
    expect(applySpy).not.toHaveBeenCalled();
  });

  it("site move updates the SFTP server at once without waiting for the periodic check and removes the old login", async () => {
    const keepUser = await call("POST", sftpBase(orgAId, siteA1Id, "/users"), { name: "keeper" });
    expect(keepUser.status).toBe(201);
    const keeperUsername = keepUser.body.data.user.username as string;

    const dispName = "Move Immediate Site";
    const createDisp = await call(
      "POST",
      `/v1/organizations/${orgAId}/managed-sites`,
      {
        name: dispName,
        domain: `move-now-${randomUUID().slice(0, 6)}.it`,
        title: dispName,
        adminUser: "admin",
        adminEmail: "admin@move-now.it",
        adminPassword: "canary-Pass-123456",
      },
      ownerAToken,
      { "Idempotency-Key": randomUUID() },
    );
    expect(createDisp.status).toBe(202);
    const dispSiteId = createDisp.body.data.siteId as string;
    await app.outboxWorker.processPendingOnce();

    const mover = await call("POST", sftpBase(orgAId, dispSiteId, "/users"), { name: "mover" });
    expect(mover.status).toBe(201);
    const moverUsername = mover.body.data.user.username as string;
    expect(sim.sftpApplies.at(-1)!.users.some((u) => u.siteId === dispSiteId)).toBe(true);

    const appliesBeforeMove = sim.sftpApplies.length;

    const moveReq = await call(
      "POST",
      `/v1/admin/sites/${dispSiteId}/owner`,
      { ownerOrganizationId: orgBId },
      adminToken,
      { "Idempotency-Key": randomUUID() },
    );
    expect(moveReq.status).toBe(202);
    const moveOpId = moveReq.body.data.operationId as string;

    await app.outboxWorker.processPendingOnce();

    const moveOp = await call("GET", `/v1/organizations/${orgBId}/operations/${moveOpId}`, undefined, ownerBToken);
    expect(moveOp.status).toBe(200);
    expect(moveOp.body.data.status).toBe("succeeded");

    expect(sim.sftpApplies.length).toBeGreaterThan(appliesBeforeMove);
    const lastApply = sim.sftpApplies[sim.sftpApplies.length - 1]!;
    expect(lastApply.users.some((u) => u.siteId === dispSiteId || u.username === moverUsername)).toBe(false);
    expect(lastApply.users).toEqual([
      expect.objectContaining({
        username: keeperUsername,
        siteId: siteA1Id,
      }),
    ]);

    const sftpAfterMove = await call("GET", sftpBase(orgBId, dispSiteId), undefined, ownerBToken);
    expect(sftpAfterMove.status).toBe(200);
    expect(sftpAfterMove.body.data.users).toEqual([]);
    expect(
      await dbClient.db.select().from(siteSftpUsers).where(eq(siteSftpUsers.siteId, dispSiteId)),
    ).toEqual([]);
  });

  it("site move still succeeds when the executor refuses the SFTP apply, and the periodic check retries it", async () => {
    const dispName = "Move Refused Apply Site";
    const createDisp = await call(
      "POST",
      `/v1/organizations/${orgAId}/managed-sites`,
      {
        name: dispName,
        domain: `move-refused-${randomUUID().slice(0, 6)}.it`,
        title: dispName,
        adminUser: "admin",
        adminEmail: "admin@move-refused.it",
        adminPassword: "canary-Pass-123456",
      },
      ownerAToken,
      { "Idempotency-Key": randomUUID() },
    );
    expect(createDisp.status).toBe(202);
    const dispSiteId = createDisp.body.data.siteId as string;
    await app.outboxWorker.processPendingOnce();

    const mover = await call("POST", sftpBase(orgAId, dispSiteId, "/users"), { name: "moverfail" });
    expect(mover.status).toBe(201);

    const appliesBeforeMove = sim.sftpApplies.length;
    const applySpy = vi.spyOn(sim, "applySftpAccess");
    sim.failNextSftpApply(1);

    const moveReq = await call(
      "POST",
      `/v1/admin/sites/${dispSiteId}/owner`,
      { ownerOrganizationId: orgBId },
      adminToken,
      { "Idempotency-Key": randomUUID() },
    );
    expect(moveReq.status).toBe(202);
    const moveOpId = moveReq.body.data.operationId as string;

    await app.outboxWorker.processPendingOnce();

    const moveOp = await call("GET", `/v1/organizations/${orgBId}/operations/${moveOpId}`, undefined, ownerBToken);
    expect(moveOp.status).toBe(200);
    expect(moveOp.body.data.status).toBe("succeeded");
    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(sim.sftpApplies).toHaveLength(appliesBeforeMove);

    const sftpAfterMove = await call("GET", sftpBase(orgBId, dispSiteId), undefined, ownerBToken);
    expect(sftpAfterMove.status).toBe(200);
    expect(sftpAfterMove.body.data.users).toEqual([]);

    await app.siteSftp.tick();
    expect(applySpy).toHaveBeenCalledTimes(2);
    expect(sim.sftpApplies).toHaveLength(appliesBeforeMove + 1);
    expect(sim.sftpApplies[sim.sftpApplies.length - 1]!.users.some((u) => u.siteId === dispSiteId)).toBe(false);
  });

  it("retried site move step after a crash stays harmless and updates SFTP cleanly", async () => {
    const dispName = "Move Retry Crash Site";
    const createDisp = await call(
      "POST",
      `/v1/organizations/${orgAId}/managed-sites`,
      {
        name: dispName,
        domain: `move-retry-${randomUUID().slice(0, 6)}.it`,
        title: dispName,
        adminUser: "admin",
        adminEmail: "admin@move-retry.it",
        adminPassword: "canary-Pass-123456",
      },
      ownerAToken,
      { "Idempotency-Key": randomUUID() },
    );
    expect(createDisp.status).toBe(202);
    const dispSiteId = createDisp.body.data.siteId as string;
    await app.outboxWorker.processPendingOnce();

    const mover = await call("POST", sftpBase(orgAId, dispSiteId, "/users"), { name: "crashmover" });
    expect(mover.status).toBe(201);

    sim.failNextSftpApply(1);
    sim.failNextDeploy();

    const moveReq = await call(
      "POST",
      `/v1/admin/sites/${dispSiteId}/owner`,
      { ownerOrganizationId: orgBId },
      adminToken,
      { "Idempotency-Key": randomUUID() },
    );
    expect(moveReq.status).toBe(202);
    const moveOpId = moveReq.body.data.operationId as string;

    await app.outboxWorker.processPendingOnce();

    const failedOp = await call("GET", `/v1/organizations/${orgBId}/operations/${moveOpId}`, undefined, ownerBToken);
    expect(failedOp.status).toBe(200);
    expect(failedOp.body.data.status).toBe("failed");

    // Simulate a worker crash during move_ownership after DB commit: op & step return to running and reassign retries.
    await dbClient.db
      .update(operations)
      .set({ status: "processing", errorCode: null, errorMessage: null, completedAt: null })
      .where(eq(operations.id, moveOpId));
    await dbClient.db
      .update(operationSteps)
      .set({ status: "running", completedAt: null })
      .where(and(eq(operationSteps.operationId, moveOpId), eq(operationSteps.key, "move_ownership")));
    await dbClient.db
      .update(operationSteps)
      .set({ status: "pending", completedAt: null })
      .where(and(eq(operationSteps.operationId, moveOpId), eq(operationSteps.key, "redeploy")));

    const [opRow] = await dbClient.db.select().from(operations).where(eq(operations.id, moveOpId));
    const provisioner = new SiteProvisioner(
      dbClient,
      sim,
      {
        oidcIssuer: "https://auth.local",
        oidcAudience: "hosting-panel-api",
        enableDevOidc: false,
        runtimeBackend: "linux-systemd",
        secretsMasterKey: KEY,
        jwtSigningKeyPem: null,
        autoProcessOutbox: false,
        sftpRetryIntervalMs: null,
      },
      app.siteSftp,
    );

    await expect(provisioner.reassign(opRow!, { toOrganizationId: orgBId })).resolves.toBeUndefined();
    const [retriedOp] = await dbClient.db.select().from(operations).where(eq(operations.id, moveOpId));
    expect(retriedOp!.status).toBe("succeeded");
    expect(sim.sftpApplies.at(-1)!.users.some((u) => u.siteId === dispSiteId)).toBe(false);

    // Repeating move_ownership when already synced triggers no extra executor apply.
    const appliesWhenSynced = sim.sftpApplies.length;
    await dbClient.db
      .update(operations)
      .set({ status: "processing", errorCode: null, errorMessage: null, completedAt: null })
      .where(eq(operations.id, moveOpId));
    const [reloadedOp] = await dbClient.db.select().from(operations).where(eq(operations.id, moveOpId));
    await expect(provisioner.reassign(reloadedOp!, { toOrganizationId: orgBId })).resolves.toBeUndefined();
    expect(sim.sftpApplies).toHaveLength(appliesWhenSynced);
  });
});

describe("site SFTP HTTP API on local-simulator backend", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let sim: InMemoryDockerSimulatorAdapter;
  let orgId: string;
  let siteId: string;
  let ownerToken: string;

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, {
      email: "admin-sim-sftp@x.it",
      name: "Admin",
      password: PW,
    });

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
      recoverUnknownOnStart: false,
    });

    const adminToken = await loginUser(
      app.baseUrl!,
      "admin-sim-sftp@x.it",
      PW,
      admin.totpSecretBase32,
    );
    const createdOrg = await httpJson(app.baseUrl!, "POST", "/v1/admin/customer-account", {
      token: adminToken,
      body: { organizationName: "Sim Org", ownerEmail: "owner@sim.it", ownerName: "Sim Owner" },
    });
    expect(createdOrg.status).toBe(201);
    orgId = createdOrg.body.data.organizationId as string;
    ownerToken = await loginUser(
      app.baseUrl!,
      "owner@sim.it",
      createdOrg.body.data.temporaryPassword as string,
    );

    const createSite = await httpJson(
      app.baseUrl!,
      "POST",
      `/v1/organizations/${orgId}/managed-sites`,
      {
        token: ownerToken,
        headers: { "Idempotency-Key": randomUUID() },
        body: SITE_A1,
      },
    );
    expect(createSite.status).toBe(202);
    siteId = createSite.body.data.siteId as string;
    await app.outboxWorker.processPendingOnce();
  });

  afterAll(async () => {
    await app.close();
    await dbClient.close();
  });

  it("reports sftpAvailable: false, GET /sftp answers available: false without calling executor, and create answers NOT_SUPPORTED", async () => {
    const meRes = await httpJson(app.baseUrl!, "GET", "/v1/me", { token: ownerToken });
    expect(meRes.status).toBe(200);
    expect(meRes.body.data.platformCapabilities.sftpAvailable).toBe(false);
    expect(meRes.body.data.platformCapabilities.phpMyAdminAvailable).toBe(false);

    const capRes = await httpJson(app.baseUrl!, "GET", `/v1/organizations/${orgId}/capabilities`, {
      token: ownerToken,
    });
    expect(capRes.status).toBe(200);
    expect(capRes.body.data.sftpAvailable).toBe(false);
    expect(capRes.body.data.phpMyAdminAvailable).toBe(false);

    const statusSpy = vi.spyOn(sim, "getSftpStatus");
    const applySpy = vi.spyOn(sim, "applySftpAccess");

    const getRes = await httpJson(
      app.baseUrl!,
      "GET",
      `/v1/organizations/${orgId}/managed-sites/${siteId}/sftp`,
      { token: ownerToken },
    );
    expect(getRes.status).toBe(200);
    expect(getRes.body.data).toEqual({
      available: false,
      host: null,
      port: null,
      hostKeyFingerprint: null,
      users: [],
    });

    const createRes = await httpJson(
      app.baseUrl!,
      "POST",
      `/v1/organizations/${orgId}/managed-sites/${siteId}/sftp/users`,
      { token: ownerToken, body: { name: "dev1" } },
    );
    expect(createRes.status).toBe(422);
    expect(createRes.body.error.code).toBe("NOT_SUPPORTED");

    expect(statusSpy).not.toHaveBeenCalled();
    expect(applySpy).not.toHaveBeenCalled();
  });
});

describe("createControlPlaneApp boot on DB without pre-seeded role_permissions", () => {
  let app: ControlPlaneAppHandle;

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it("seeds preset role_permissions on boot so customer_owner receives site.files.write and site.sftp.manage", async () => {
    // Passing no databaseClient exercises ownsDatabaseClient=true on a freshly migrated empty DB.
    app = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      secretsMasterKey: KEY,
      runtimeBackend: "local-simulator",
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
      domainReconcileIntervalMs: null,
      mailRelayRetryIntervalMs: null,
      sftpRetryIntervalMs: null,
      recoverUnknownOnStart: false,
    });

    const ownerPerms = await app.dbClient.db
      .select({ key: rolePermissions.permissionKey })
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, "role_customer_owner"));
    const keySet = new Set(ownerPerms.map((r) => r.key));
    expect(keySet.has("site.files.write")).toBe(true);
    expect(keySet.has("site.sftp.manage")).toBe(true);
    expect(PRESET_ROLE_PERMISSIONS.customer_owner).toContain("site.files.write");
    expect(PRESET_ROLE_PERMISSIONS.customer_owner).toContain("site.sftp.manage");

    // Verify end-to-end via HTTP that the owner can actually invoke site.files.write and site.sftp.manage.
    await setupInstallation(app.dbClient.db, SETUP);
    const admin = await createServerAdmin(app.dbClient.db, KEY, {
      email: "admin-boot@x.it",
      name: "Admin",
      password: PW,
    });
    const adminToken = await loginUser(
      app.baseUrl!,
      "admin-boot@x.it",
      PW,
      admin.totpSecretBase32,
    );
    const createdOrg = await httpJson(app.baseUrl!, "POST", "/v1/admin/customer-account", {
      token: adminToken,
      body: { organizationName: "Boot Org", ownerEmail: "owner@boot.it", ownerName: "Boot Owner" },
    });
    expect(createdOrg.status).toBe(201);
    const orgId = createdOrg.body.data.organizationId as string;
    const ownerToken = await loginUser(
      app.baseUrl!,
      "owner@boot.it",
      createdOrg.body.data.temporaryPassword as string,
    );

    const createSite = await httpJson(
      app.baseUrl!,
      "POST",
      `/v1/organizations/${orgId}/managed-sites`,
      {
        token: ownerToken,
        headers: { "Idempotency-Key": randomUUID() },
        body: SITE_A1,
      },
    );
    expect(createSite.status).toBe(202);
    const siteId = createSite.body.data.siteId as string;
    await app.outboxWorker.processPendingOnce();

    const mkdirRes = await httpJson(
      app.baseUrl!,
      "POST",
      `/v1/organizations/${orgId}/managed-sites/${siteId}/files/folders`,
      { token: ownerToken, body: { path: "boot-check" } },
    );
    expect(mkdirRes.status).toBe(204);

    const sftpRes = await httpJson(
      app.baseUrl!,
      "GET",
      `/v1/organizations/${orgId}/managed-sites/${siteId}/sftp`,
      { token: ownerToken },
    );
    expect(sftpRes.status).toBe(200);
  });
});
