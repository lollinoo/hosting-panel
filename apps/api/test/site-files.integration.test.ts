import { randomUUID } from "node:crypto";
import {
  PRESET_ROLE_PERMISSIONS,
  SITE_FILE_BATCH_MAX,
  SITE_FILE_CHUNK_BYTES,
  SITE_FILE_PATH_MAX,
  SITE_FILE_SEGMENT_MAX_BYTES,
} from "@hosting-panel/contracts";
import {
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
  resourceGrants,
  rolePermissions,
  serviceInstances,
  sites,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import {
  ExecutorCodedError,
  InMemoryDockerSimulatorAdapter,
} from "@hosting-panel/docker-executor";
import { Phase1DisabledDockerExecutor } from "@hosting-panel/executor-contracts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../src/auth/password.js";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";

const KEY = Buffer.alloc(32, 7);
const PW = "correct horse battery";
const SETUP = { installationName: "Test", hostHostname: "panel.test", hostIpv4: "10.0.0.1" };
const SITE_A = {
  name: "Hotel Bella",
  domain: "hotel.it",
  title: "Hotel Bella Vista",
  adminUser: "admin",
  adminEmail: "admin@hotel.it",
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

function makeSimZip(
  entries: ReadonlyArray<{
    readonly p: string;
    readonly d?: string;
    readonly link?: string;
    readonly s?: number;
  }>,
): Buffer {
  return Buffer.concat([
    Buffer.from("HPSIMZIP\n", "utf8"),
    Buffer.from(JSON.stringify(entries), "utf8"),
  ]);
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
    readonly token: string;
    readonly body?: unknown;
    readonly headers?: Record<string, string>;
  },
): Promise<HttpResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.token}`,
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
  return {
    status: res.status,
    body: raw ? (JSON.parse(raw) as Json) : {},
    raw,
  };
}

describe("site files HTTP API integration", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let sim: InMemoryDockerSimulatorAdapter;
  let orgAId: string;
  let orgBId: string;
  let siteAId: string;
  let siteBId: string;
  let svcAId: string;
  let ownerAToken: string;
  let ownerBToken: string;
  let adminToken: string;
  let collabNoFilesToken: string;
  let collabReadOnlyToken: string;
  let baselineAuditIds: Set<string>;

  const filesBase = (orgId: string, siteId: string, tail = "") =>
    `/v1/organizations/${orgId}/managed-sites/${siteId}/files${tail}`;
  const domainsBase = (orgId: string, siteId: string, tail = "") =>
    `/v1/organizations/${orgId}/managed-sites/${siteId}/domains${tail}`;

  const call = (
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
    token: string = ownerAToken,
  ) => httpJson(app.baseUrl!, method, path, { token, body, headers });

  const uploadChunks = async (
    path: string,
    data: Buffer,
    options: {
      readonly chunkSize?: number;
      readonly overwrite?: boolean;
      readonly uploadId?: string;
      readonly replayIndex?: number;
      readonly orgId?: string;
      readonly siteId?: string;
      readonly token?: string;
    } = {},
  ): Promise<HttpResult[]> => {
    const chunkSize = options.chunkSize ?? 250_000;
    const overwrite = options.overwrite ?? false;
    const uploadId = options.uploadId ?? `upl_${randomUUID().replace(/-/g, "")}`;
    const orgId = options.orgId ?? orgAId;
    const siteId = options.siteId ?? siteAId;
    const token = options.token ?? ownerAToken;
    const responses: HttpResult[] = [];

    if (data.length === 0) {
      const res = await call(
        "PUT",
        filesBase(orgId, siteId, "/content"),
        { path, uploadId, offset: 0, dataBase64: "", final: true, overwrite },
        undefined,
        token,
      );
      responses.push(res);
      return responses;
    }

    let offset = 0;
    let chunkIndex = 0;
    while (offset < data.length) {
      const nextEnd = Math.min(data.length, offset + chunkSize);
      const slice = data.subarray(offset, nextEnd);
      const isFinal = nextEnd >= data.length;
      const payload = {
        path,
        uploadId,
        offset,
        dataBase64: slice.toString("base64"),
        final: isFinal,
        overwrite,
      };
      const res = await call("PUT", filesBase(orgId, siteId, "/content"), payload, undefined, token);
      responses.push(res);
      if (options.replayIndex === chunkIndex && !isFinal) {
        const replayRes = await call(
          "PUT",
          filesBase(orgId, siteId, "/content"),
          payload,
          undefined,
          token,
        );
        responses.push(replayRes);
      }
      offset = nextEnd;
      chunkIndex += 1;
    }
    return responses;
  };

  async function newAudits() {
    const rows = await dbClient.db.select().from(auditEvents);
    return rows.filter((r) => !baselineAuditIds.has(r.id));
  }

  async function snapshotAudits() {
    const rows = await dbClient.db.select({ id: auditEvents.id }).from(auditEvents);
    baselineAuditIds = new Set(rows.map((r) => r.id));
  }

  function allEightRouteSpecs(orgId: string, siteId: string) {
    return [
      { kind: "read" as const, method: "GET", path: filesBase(orgId, siteId, "?path="), body: undefined, headers: undefined },
      { kind: "read" as const, method: "GET", path: filesBase(orgId, siteId, "/content?path=index.php&offset=0&length=64"), body: undefined, headers: undefined },
      {
        kind: "write" as const,
        method: "PUT",
        path: filesBase(orgId, siteId, "/content"),
        body: {
          path: "probe.txt",
          uploadId: "upl_0123456789abcdef",
          offset: 0,
          dataBase64: Buffer.from("x").toString("base64"),
          final: true,
          overwrite: true,
        },
        headers: undefined,
      },
      { kind: "write" as const, method: "POST", path: filesBase(orgId, siteId, "/folders"), body: { path: "probe-dir" }, headers: undefined },
      { kind: "write" as const, method: "POST", path: filesBase(orgId, siteId, "/move"), body: { from: "index.php", to: "index2.php" }, headers: undefined },
      { kind: "write" as const, method: "POST", path: filesBase(orgId, siteId, "/delete"), body: { paths: ["probe.txt"] }, headers: undefined },
      {
        kind: "write" as const,
        method: "POST",
        path: filesBase(orgId, siteId, "/archive"),
        body: { paths: ["index.php"], to: "probe.zip" },
        headers: { "Idempotency-Key": randomUUID() },
      },
      {
        kind: "write" as const,
        method: "POST",
        path: filesBase(orgId, siteId, "/extract"),
        body: { path: "probe.zip", to: "probe-out" },
        headers: { "Idempotency-Key": randomUUID() },
      },
    ];
  }

  function assertNoInternalLeaks(payload: unknown, rawSecrets: readonly string[] = []) {
    const text = typeof payload === "string" ? payload : JSON.stringify(payload);
    expect(text).not.toContain(svcAId);
    expect(text).not.toContain("hp_vol_");
    expect(text).not.toContain("hp_files_");
    expect(text).not.toContain("/var/lib");
    expect(text).not.toContain("/var/www/html");
    for (const secret of rawSecrets) {
      expect(text).not.toContain(secret);
    }
  }

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, {
      email: "admin@x.it",
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
      recoverUnknownOnStart: false,
    });

    adminToken = await loginUser(app.baseUrl!, "admin@x.it", PW, admin.totpSecretBase32);

    // Organization A + owner
    const createdA = await call(
      "POST",
      "/v1/admin/customer-account",
      { organizationName: "Hotel Mario", ownerEmail: "mario@hotel.it", ownerName: "Mario" },
      undefined,
      adminToken,
    );
    expect(createdA.status).toBe(201);
    orgAId = createdA.body.data.organizationId as string;
    ownerAToken = await loginUser(
      app.baseUrl!,
      "mario@hotel.it",
      createdA.body.data.temporaryPassword as string,
    );

    // Organization B + dedicated second host + owner
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
      slug: "bar-sport-org",
    });
    await dbClient.db.insert(hostAllocations).values({
      id: `alloc_${randomUUID()}`,
      hostId: hostBId,
      organizationId: orgBId,
      status: "active",
    });
    const ownerBUserId = `usr_${randomUUID()}`;
    const ownerBMembershipId = `mem_${randomUUID()}`;
    await dbClient.db.insert(users).values({
      id: ownerBUserId,
      email: "luigi@barsport.it",
      name: "Luigi",
      passwordHash: await hashPassword(PW),
    });
    await dbClient.db.insert(memberships).values({
      id: ownerBMembershipId,
      organizationId: orgBId,
      userId: ownerBUserId,
    });
    await dbClient.db.insert(membershipRoles).values({
      id: `mrl_${randomUUID()}`,
      membershipId: ownerBMembershipId,
      roleId: "role_customer_owner",
    });
    ownerBToken = await loginUser(app.baseUrl!, "luigi@barsport.it", PW);

    // Deploy ready site A (org A) and ready site B (org B)
    const createA = await call(
      "POST",
      `/v1/organizations/${orgAId}/managed-sites`,
      SITE_A,
      { "Idempotency-Key": randomUUID() },
      ownerAToken,
    );
    expect(createA.status).toBe(202);
    siteAId = createA.body.data.siteId as string;

    const createB = await call(
      "POST",
      `/v1/organizations/${orgBId}/managed-sites`,
      SITE_B,
      { "Idempotency-Key": randomUUID() },
      ownerBToken,
    );
    expect(createB.status).toBe(202);
    siteBId = createB.body.data.siteId as string;

    await app.outboxWorker.processPendingOnce();
    const [svcA] = await dbClient.db
      .select()
      .from(serviceInstances)
      .where(eq(serviceInstances.siteId, siteAId));
    svcAId = svcA!.id;

    // Collaborator without file permissions
    const collabId = `usr_${randomUUID()}`;
    const collabMemId = `mem_${randomUUID()}`;
    await dbClient.db.insert(users).values({
      id: collabId,
      email: "collab@hotel.it",
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
    collabNoFilesToken = await loginUser(app.baseUrl!, "collab@hotel.it", PW);

    // Collaborator granted site.files.read only
    const readerId = `usr_${randomUUID()}`;
    const readerMemId = `mem_${randomUUID()}`;
    await dbClient.db.insert(users).values({
      id: readerId,
      email: "reader@hotel.it",
      name: "Reader",
      passwordHash: await hashPassword(PW),
    });
    await dbClient.db
      .insert(memberships)
      .values({ id: readerMemId, organizationId: orgAId, userId: readerId });
    await dbClient.db.insert(membershipRoles).values({
      id: `mrl_${randomUUID()}`,
      membershipId: readerMemId,
      roleId: "role_customer_collaborator",
    });
    await dbClient.db.insert(resourceGrants).values({
      id: `rg_${randomUUID()}`,
      organizationId: orgAId,
      principalUserId: readerId,
      resourceId: siteAId,
      permission: "site.files.read",
    });
    collabReadOnlyToken = await loginUser(app.baseUrl!, "reader@hotel.it", PW);
  });

  afterAll(async () => {
    await app.close();
    await dbClient.close();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    sim.setEngineReachable(true);
    sim.files.drop(svcAId);
    sim.files.create(svcAId);
    await dbClient.db
      .update(organizations)
      .set({ status: "active" })
      .where(eq(organizations.id, orgAId));
    await dbClient.db
      .update(sites)
      .set({ status: "ready" })
      .where(eq(sites.id, siteAId));
    await dbClient.db.delete(outboxEvents);
    await dbClient.db.delete(operationSteps);
    await dbClient.db.delete(operations);
    await snapshotAudits();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("happy path: list, mkdir, 3-chunk upload with replay, byte-for-byte chunked read, move, delete, and empty file", async () => {
    const rootList = await call("GET", filesBase(orgAId, siteAId, "?path="));
    expect(rootList.status).toBe(200);
    expect(rootList.body.data.truncated).toBe(false);
    expect(rootList.body.data.entries.map((e: Json) => e.name)).toEqual(
      expect.arrayContaining(["wp-content", "index.php", "wp-config.php"]),
    );

    const mkdirRes = await call("POST", filesBase(orgAId, siteAId, "/folders"), { path: "uploads" });
    expect(mkdirRes.status).toBe(204);

    // Three chunks (250 KiB, 250 KiB with replay, remaining 100 KiB)
    const payload = Buffer.alloc(600_000);
    for (let i = 0; i < payload.length; i += 1) {
      payload[i] = (i * 31 + 7) & 0xff;
    }
    const uploadResponses = await uploadChunks("uploads/data.bin", payload, {
      chunkSize: 250_000,
      replayIndex: 1,
    });
    expect(uploadResponses.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(uploadResponses.map((r) => r.body.data.received)).toEqual([
      250_000,
      500_000,
      500_000,
      600_000,
    ]);

    // Also verify a full max-size 512 KiB chunk fits under Fastify's body limit
    const maxChunk = Buffer.alloc(SITE_FILE_CHUNK_BYTES, 0x42);
    const maxChunkRes = await uploadChunks("uploads/full-chunk.bin", maxChunk, {
      chunkSize: SITE_FILE_CHUNK_BYTES,
    });
    expect(maxChunkRes[0]!.status).toBe(200);
    expect(maxChunkRes[0]!.body.data.received).toBe(SITE_FILE_CHUNK_BYTES);

    const dirList = await call("GET", filesBase(orgAId, siteAId, "?path=uploads"));
    expect(dirList.status).toBe(200);
    const dataEntry = dirList.body.data.entries.find((e: Json) => e.name === "data.bin");
    expect(dataEntry).toMatchObject({ name: "data.bin", kind: "file", size: 600_000 });

    // Read back in chunks byte-for-byte
    const readChunks: Buffer[] = [];
    let readOffset = 0;
    let eof = false;
    while (!eof) {
      const readRes = await call(
        "GET",
        filesBase(
          orgAId,
          siteAId,
          `/content?path=${encodeURIComponent("uploads/data.bin")}&offset=${readOffset}&length=200000`,
        ),
      );
      expect(readRes.status).toBe(200);
      expect(readRes.body.data.size).toBe(600_000);
      const buf = Buffer.from(readRes.body.data.dataBase64 as string, "base64");
      readChunks.push(buf);
      readOffset += buf.length;
      eof = readRes.body.data.eof as boolean;
    }
    expect(Buffer.concat(readChunks).equals(payload)).toBe(true);

    // Move / rename
    const moveRes = await call("POST", filesBase(orgAId, siteAId, "/move"), {
      from: "uploads/data.bin",
      to: "uploads/renamed.bin",
    });
    expect(moveRes.status).toBe(204);
    const afterMove = await call("GET", filesBase(orgAId, siteAId, "?path=uploads"));
    expect(afterMove.body.data.entries.map((e: Json) => e.name)).toContain("renamed.bin");
    expect(afterMove.body.data.entries.map((e: Json) => e.name)).not.toContain("data.bin");

    // Delete
    const delRes = await call("POST", filesBase(orgAId, siteAId, "/delete"), {
      paths: ["uploads/renamed.bin", "uploads/full-chunk.bin", "uploads"],
    });
    expect(delRes.status).toBe(204);
    const afterDel = await call("GET", filesBase(orgAId, siteAId, "?path="));
    expect(afterDel.body.data.entries.map((e: Json) => e.name)).not.toContain("uploads");

    // Empty file (single empty final chunk)
    const emptyRes = await uploadChunks("empty.txt", Buffer.alloc(0));
    expect(emptyRes).toHaveLength(1);
    expect(emptyRes[0]!.status).toBe(200);
    expect(emptyRes[0]!.body.data.received).toBe(0);
    const emptyList = await call("GET", filesBase(orgAId, siteAId, "?path="));
    expect(emptyList.body.data.entries.find((e: Json) => e.name === "empty.txt")).toMatchObject({
      kind: "file",
      size: 0,
    });
    const emptyRead = await call("GET", filesBase(orgAId, siteAId, "/content?path=empty.txt"));
    expect(emptyRead.status).toBe(200);
    expect(emptyRead.body.data).toEqual({ dataBase64: "", size: 0, eof: true });
  });

  it("tenancy: all 8 routes against another org's site or an unknown site answer 404 with zero executor calls", async () => {
    const spy = vi.spyOn(sim, "siteFiles");

    for (const route of allEightRouteSpecs(orgAId, siteBId)) {
      const res = await call(route.method, route.path, route.body, route.headers, ownerAToken);
      expect(res.status, `${route.method} ${route.path} with foreign siteId`).toBe(404);
    }

    for (const route of allEightRouteSpecs(orgBId, siteBId)) {
      const res = await call(route.method, route.path, route.body, route.headers, ownerAToken);
      expect(res.status, `${route.method} ${route.path} with foreign orgId`).toBe(404);
    }

    for (const route of allEightRouteSpecs(orgAId, "site_unknown_does_not_exist")) {
      const res = await call(route.method, route.path, route.body, route.headers, ownerAToken);
      expect(res.status, `${route.method} ${route.path} with unknown siteId`).toBe(404);
    }

    expect(spy).not.toHaveBeenCalled();
  });

  it("permissions: role matrix, member denials write denied audit rows, read-only grant, and server admin parity with domains", async () => {
    // Verify preset role permissions seeded on boot
    expect(PRESET_ROLE_PERMISSIONS.customer_collaborator).not.toContain("site.files.read");
    expect(PRESET_ROLE_PERMISSIONS.customer_collaborator).not.toContain("site.files.write");
    expect(PRESET_ROLE_PERMISSIONS.infrastructure_admin).not.toContain("site.files.read");
    expect(PRESET_ROLE_PERMISSIONS.infrastructure_admin).not.toContain("site.files.write");
    expect(PRESET_ROLE_PERMISSIONS.customer_owner).toContain("site.files.read");
    expect(PRESET_ROLE_PERMISSIONS.customer_owner).toContain("site.files.write");
    expect(PRESET_ROLE_PERMISSIONS.hosting_admin).toContain("site.files.read");
    expect(PRESET_ROLE_PERMISSIONS.hosting_admin).toContain("site.files.write");

    const dbPerms = await dbClient.db.select().from(rolePermissions);
    const byRole = (roleId: string) =>
      new Set(dbPerms.filter((r) => r.roleId === roleId).map((r) => r.permissionKey));
    expect(byRole("role_customer_owner").has("site.files.read")).toBe(true);
    expect(byRole("role_customer_owner").has("site.files.write")).toBe(true);
    expect(byRole("role_hosting_admin").has("site.files.read")).toBe(true);
    expect(byRole("role_hosting_admin").has("site.files.write")).toBe(true);
    expect(byRole("role_customer_collaborator").has("site.files.read")).toBe(false);
    expect(byRole("role_customer_collaborator").has("site.files.write")).toBe(false);
    expect(byRole("role_infrastructure_admin").has("site.files.read")).toBe(false);
    expect(byRole("role_infrastructure_admin").has("site.files.write")).toBe(false);

    const spy = vi.spyOn(sim, "siteFiles");

    // Member without site.files.read gets 403 on all 8 routes + 8 denied audit rows
    await snapshotAudits();
    for (const route of allEightRouteSpecs(orgAId, siteAId)) {
      const res = await call(
        route.method,
        route.path,
        route.body,
        route.headers,
        collabNoFilesToken,
      );
      expect(res.status, `collab without read on ${route.method} ${route.path}`).toBe(403);
      expect(res.body.error.code).toBe("PERMISSION_DENIED");
    }
    expect(spy).not.toHaveBeenCalled();

    const noReadAudits = await newAudits();
    expect(noReadAudits).toHaveLength(8);
    expect(noReadAudits.map((a) => a.action)).toEqual([
      "site.files.read",
      "site.files.read",
      "site.files.write",
      "site.files.write",
      "site.files.write",
      "site.files.write",
      "site.files.write",
      "site.files.write",
    ]);
    for (const row of noReadAudits) {
      expect(row.targetType).toBe("site");
      expect(row.targetId).toBe(siteAId);
      expect((row.details as Json)["outcome"]).toBe("denied");
    }

    // Member with site.files.read (and without site.files.write) can GET, gets 403 on all 6 mutations
    await snapshotAudits();
    const routes = allEightRouteSpecs(orgAId, siteAId);
    for (const route of routes.filter((r) => r.kind === "read")) {
      const res = await call(
        route.method,
        route.path,
        route.body,
        route.headers,
        collabReadOnlyToken,
      );
      expect(res.status).toBe(200);
    }
    spy.mockClear();
    for (const route of routes.filter((r) => r.kind === "write")) {
      const res = await call(
        route.method,
        route.path,
        route.body,
        route.headers,
        collabReadOnlyToken,
      );
      expect(res.status, `read-only member on ${route.method} ${route.path}`).toBe(403);
      expect(res.body.error.code).toBe("PERMISSION_DENIED");
    }
    expect(spy).not.toHaveBeenCalled();

    const writeDeniedAudits = await newAudits();
    expect(writeDeniedAudits).toHaveLength(6);
    for (const row of writeDeniedAudits) {
      expect(row.action).toBe("site.files.write");
      expect(row.targetType).toBe("site");
      expect(row.targetId).toBe(siteAId);
      expect((row.details as Json)["outcome"]).toBe("denied");
    }

    // Server administrator on customer routes must match domains routes behaviour
    const domainGet = await call(
      "GET",
      domainsBase(orgAId, siteAId),
      undefined,
      undefined,
      adminToken,
    );
    const domainPost = await call(
      "POST",
      domainsBase(orgAId, siteAId),
      { hostname: "admin-probe.it" },
      undefined,
      adminToken,
    );
    expect([403, 404]).toContain(domainGet.status);
    expect([403, 404]).toContain(domainPost.status);

    for (const route of allEightRouteSpecs(orgAId, siteAId)) {
      const res = await call(route.method, route.path, route.body, route.headers, adminToken);
      const expectedStatus = route.kind === "read" ? domainGet.status : domainPost.status;
      expect(res.status, `server admin on ${route.method} ${route.path}`).toBe(expectedStatus);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("suspended organization: reads succeed and every mutation is refused the same way as domains", async () => {
    await dbClient.db
      .update(organizations)
      .set({ status: "suspended" })
      .where(eq(organizations.id, orgAId));

    const domainRead = await call("GET", domainsBase(orgAId, siteAId));
    expect(domainRead.status).toBe(200);
    const domainWrite = await call("POST", domainsBase(orgAId, siteAId), {
      hostname: "suspended-probe.it",
    });
    expect(domainWrite.status).toBe(403);
    expect(domainWrite.body.error.code).toBe("ORGANIZATION_SUSPENDED");

    const spy = vi.spyOn(sim, "siteFiles");
    const routes = allEightRouteSpecs(orgAId, siteAId);
    for (const route of routes.filter((r) => r.kind === "read")) {
      const res = await call(route.method, route.path, route.body, route.headers);
      expect(res.status).toBe(200);
    }
    spy.mockClear();

    for (const route of routes.filter((r) => r.kind === "write")) {
      const res = await call(route.method, route.path, route.body, route.headers);
      expect(res.status, `suspended org on ${route.method} ${route.path}`).toBe(domainWrite.status);
      expect(res.body.error.code).toBe(domainWrite.body.error.code);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("validation at the edge: rejects invalid paths, upload fields, batches, and non-zip targets with 400 VALIDATION_ERROR and zero executor calls", async () => {
    const spy = vi.spyOn(sim, "siteFiles");
    const validUploadId = "upl_0123456789abcdef";
    const validB64 = Buffer.from("ok").toString("base64");

    const badPaths = [
      "a/../b",
      "..",
      "/index.php",
      "a\u0000b",
      "a\nb",
      "a\x7fb",
      ".htpanel-upload-123",
      "wp-content/.htpanel-tmp",
      "a".repeat(SITE_FILE_PATH_MAX + 1),
      "a".repeat(SITE_FILE_SEGMENT_MAX_BYTES + 1),
      "é".repeat(128), // 256 UTF-8 bytes
    ];

    for (const badPath of badPaths) {
      const listRes = await call(
        "GET",
        filesBase(orgAId, siteAId, `?path=${encodeURIComponent(badPath)}`),
      );
      expect(listRes.status, `GET /files badPath=${JSON.stringify(badPath)}`).toBe(400);
      expect(listRes.body.error.code).toBe("VALIDATION_ERROR");

      const mkdirRes = await call("POST", filesBase(orgAId, siteAId, "/folders"), {
        path: badPath,
      });
      expect(mkdirRes.status, `POST /files/folders badPath=${JSON.stringify(badPath)}`).toBe(400);
      expect(mkdirRes.body.error.code).toBe("VALIDATION_ERROR");
    }

    const badRequests: Array<{
      readonly label: string;
      readonly method: string;
      readonly path: string;
      readonly body?: unknown;
      readonly headers?: Record<string, string>;
    }> = [
      {
        label: "bad uploadId (short)",
        method: "PUT",
        path: filesBase(orgAId, siteAId, "/content"),
        body: { path: "f.txt", uploadId: "short", offset: 0, dataBase64: validB64, final: true, overwrite: true },
      },
      {
        label: "bad uploadId (chars)",
        method: "PUT",
        path: filesBase(orgAId, siteAId, "/content"),
        body: { path: "f.txt", uploadId: "bad!upload@id#123456", offset: 0, dataBase64: validB64, final: true, overwrite: true },
      },
      {
        label: "negative offset on write",
        method: "PUT",
        path: filesBase(orgAId, siteAId, "/content"),
        body: { path: "f.txt", uploadId: validUploadId, offset: -1, dataBase64: validB64, final: true, overwrite: true },
      },
      {
        label: "negative offset on read",
        method: "GET",
        path: filesBase(orgAId, siteAId, "/content?path=index.php&offset=-1&length=10"),
      },
      {
        label: "chunk over 512 KiB",
        method: "PUT",
        path: filesBase(orgAId, siteAId, "/content"),
        body: {
          path: "f.txt",
          uploadId: validUploadId,
          offset: 0,
          dataBase64: Buffer.alloc(SITE_FILE_CHUNK_BYTES + 1, 0x41).toString("base64"),
          final: true,
          overwrite: true,
        },
      },
      {
        label: "bad base64 alphabet",
        method: "PUT",
        path: filesBase(orgAId, siteAId, "/content"),
        body: { path: "f.txt", uploadId: validUploadId, offset: 0, dataBase64: "not-valid!", final: true, overwrite: true },
      },
      {
        label: "bad base64 length",
        method: "PUT",
        path: filesBase(orgAId, siteAId, "/content"),
        body: { path: "f.txt", uploadId: validUploadId, offset: 0, dataBase64: "abc", final: true, overwrite: true },
      },
      {
        label: "empty paths on delete",
        method: "POST",
        path: filesBase(orgAId, siteAId, "/delete"),
        body: { paths: [] },
      },
      {
        label: "101 paths on delete",
        method: "POST",
        path: filesBase(orgAId, siteAId, "/delete"),
        body: { paths: Array.from({ length: SITE_FILE_BATCH_MAX + 1 }, (_, i) => `f${i}.txt`) },
      },
      {
        label: "empty paths on archive",
        method: "POST",
        path: filesBase(orgAId, siteAId, "/archive"),
        body: { paths: [], to: "out.zip" },
        headers: { "Idempotency-Key": randomUUID() },
      },
      {
        label: "101 paths on archive",
        method: "POST",
        path: filesBase(orgAId, siteAId, "/archive"),
        body: {
          paths: Array.from({ length: SITE_FILE_BATCH_MAX + 1 }, (_, i) => `f${i}.txt`),
          to: "out.zip",
        },
        headers: { "Idempotency-Key": randomUUID() },
      },
      {
        label: "archive target not ending in .zip",
        method: "POST",
        path: filesBase(orgAId, siteAId, "/archive"),
        body: { paths: ["index.php"], to: "out.tar.gz" },
        headers: { "Idempotency-Key": randomUUID() },
      },
      {
        label: "extract path not ending in .zip",
        method: "POST",
        path: filesBase(orgAId, siteAId, "/extract"),
        body: { path: "out.tar.gz", to: "dest" },
        headers: { "Idempotency-Key": randomUUID() },
      },
      {
        label: "move into itself",
        method: "POST",
        path: filesBase(orgAId, siteAId, "/move"),
        body: { from: "wp-content", to: "wp-content/sub" },
      },
    ];

    for (const reqSpec of badRequests) {
      const res = await call(reqSpec.method, reqSpec.path, reqSpec.body, reqSpec.headers);
      expect(res.status, reqSpec.label).toBe(400);
      expect(res.body.error.code, reqSpec.label).toBe("VALIDATION_ERROR");
    }

    expect(spy).not.toHaveBeenCalled();
  });

  it("refusals from the files layer map codes and details[0].reason, with NO denied audit row for protected entries", async () => {
    // exists -> 409 ALREADY_EXISTS
    const existsMkdir = await call("POST", filesBase(orgAId, siteAId, "/folders"), {
      path: "wp-content/themes",
    });
    expect(existsMkdir.status).toBe(409);
    expect(existsMkdir.body.error.code).toBe("ALREADY_EXISTS");
    expect(existsMkdir.body.error.details[0]?.reason).toBe("exists");

    const existsWrite = await uploadChunks("index.php", Buffer.from("hi"), { overwrite: false });
    expect(existsWrite[0]!.status).toBe(409);
    expect(existsWrite[0]!.body.error.code).toBe("ALREADY_EXISTS");
    expect(existsWrite[0]!.body.error.details[0]?.reason).toBe("exists");

    const existsMove = await call("POST", filesBase(orgAId, siteAId, "/move"), {
      from: "index.php",
      to: "wp-config.php",
    });
    expect(existsMove.status).toBe(409);
    expect(existsMove.body.error.code).toBe("ALREADY_EXISTS");
    expect(existsMove.body.error.details[0]?.reason).toBe("exists");

    // not_found -> 404 NOT_FOUND
    const notFoundList = await call("GET", filesBase(orgAId, siteAId, "?path=no-such-folder"));
    expect(notFoundList.status).toBe(404);
    expect(notFoundList.body.error.code).toBe("NOT_FOUND");
    expect(notFoundList.body.error.details[0]?.reason).toBe("not_found");

    const notFoundRead = await call(
      "GET",
      filesBase(orgAId, siteAId, "/content?path=no-such-file.txt"),
    );
    expect(notFoundRead.status).toBe(404);
    expect(notFoundRead.body.error.code).toBe("NOT_FOUND");
    expect(notFoundRead.body.error.details[0]?.reason).toBe("not_found");

    // protected -> 403 PERMISSION_DENIED with reason 'protected' and NO audit row (neither denied nor succeeded)
    await snapshotAudits();
    const protectedWrite = await uploadChunks(
      "wp-content/mu-plugins/hp-mail.php",
      Buffer.from("hacked"),
      { overwrite: true },
    );
    expect(protectedWrite[0]!.status).toBe(403);
    expect(protectedWrite[0]!.body.error.code).toBe("PERMISSION_DENIED");
    expect(protectedWrite[0]!.body.error.details[0]?.reason).toBe("protected");

    const protectedDel = await call("POST", filesBase(orgAId, siteAId, "/delete"), {
      paths: ["wp-content/mu-plugins"],
    });
    expect(protectedDel.status).toBe(403);
    expect(protectedDel.body.error.code).toBe("PERMISSION_DENIED");
    expect(protectedDel.body.error.details[0]?.reason).toBe("protected");
    expect(await newAudits()).toHaveLength(0);

    // upload_mismatch -> 400 VALIDATION_ERROR
    const mismatchWrite = await call("PUT", filesBase(orgAId, siteAId, "/content"), {
      path: "mismatch.bin",
      uploadId: "upl_mismatch_0123456",
      offset: 64,
      dataBase64: Buffer.from("abc").toString("base64"),
      final: true,
      overwrite: true,
    });
    expect(mismatchWrite.status).toBe(400);
    expect(mismatchWrite.body.error.code).toBe("VALIDATION_ERROR");
    expect(mismatchWrite.body.error.details[0]?.reason).toBe("upload_mismatch");

    // is_a_directory -> 400 VALIDATION_ERROR
    const isDirRead = await call("GET", filesBase(orgAId, siteAId, "/content?path=wp-content"));
    expect(isDirRead.status).toBe(400);
    expect(isDirRead.body.error.code).toBe("VALIDATION_ERROR");
    expect(isDirRead.body.error.details[0]?.reason).toBe("is_a_directory");

    // not_a_directory -> 400 VALIDATION_ERROR
    const notDirList = await call("GET", filesBase(orgAId, siteAId, "?path=index.php"));
    expect(notDirList.status).toBe(400);
    expect(notDirList.body.error.code).toBe("VALIDATION_ERROR");
    expect(notDirList.body.error.details[0]?.reason).toBe("not_a_directory");
  });

  it("site not ready (deploying or no deployed service) returns 409 RESOURCE_LOCKED with reason not_ready", async () => {
    const spy = vi.spyOn(sim, "siteFiles");

    // 1. Site still deploying (do not run outboxWorker)
    const createDeploying = await call(
      "POST",
      `/v1/organizations/${orgAId}/managed-sites`,
      { ...SITE_A, name: "Deploying Site", domain: "deploying-files.it" },
      { "Idempotency-Key": randomUUID() },
    );
    expect(createDeploying.status).toBe(202);
    const deployingSiteId = createDeploying.body.data.siteId as string;

    const deployingGet = await call("GET", filesBase(orgAId, deployingSiteId, "?path="));
    expect(deployingGet.status).toBe(409);
    expect(deployingGet.body.error.code).toBe("RESOURCE_LOCKED");
    expect(deployingGet.body.error.details[0]?.reason).toBe("not_ready");

    const deployingMkdir = await call("POST", filesBase(orgAId, deployingSiteId, "/folders"), {
      path: "x",
    });
    expect(deployingMkdir.status).toBe(409);
    expect(deployingMkdir.body.error.code).toBe("RESOURCE_LOCKED");
    expect(deployingMkdir.body.error.details[0]?.reason).toBe("not_ready");

    // 2. Site marked ready in DB but with no service_instances row
    const noSvcSiteId = `site_nosvc_${randomUUID()}`;
    const [alloc] = await dbClient.db
      .select()
      .from(hostAllocations)
      .where(eq(hostAllocations.organizationId, orgAId))
      .limit(1);
    await dbClient.db.insert(sites).values({
      id: noSvcSiteId,
      organizationId: orgAId,
      hostAllocationId: alloc!.id,
      name: "No Service Site",
      slug: `no-svc-${randomUUID().slice(0, 6)}`,
      status: "ready",
      phpVersion: "8.4",
    });

    const noSvcGet = await call("GET", filesBase(orgAId, noSvcSiteId, "?path="));
    expect(noSvcGet.status).toBe(409);
    expect(noSvcGet.body.error.code).toBe("RESOURCE_LOCKED");
    expect(noSvcGet.body.error.details[0]?.reason).toBe("not_ready");

    const noSvcArchive = await call(
      "POST",
      filesBase(orgAId, noSvcSiteId, "/archive"),
      { paths: ["index.php"], to: "out.zip" },
      { "Idempotency-Key": randomUUID() },
    );
    expect(noSvcArchive.status).toBe(409);
    expect(noSvcArchive.body.error.code).toBe("RESOURCE_LOCKED");
    expect(noSvcArchive.body.error.details[0]?.reason).toBe("not_ready");

    expect(spy).not.toHaveBeenCalled();
  });

  it("audit: one row per mutation with designed event names, one upload row on final chunk, and zero file content or base64", async () => {
    const canaryText = "CANARY_SECRET_BODY_DO_NOT_AUDIT_987654321";
    const canaryBuf = Buffer.from(canaryText, "utf8");
    const canaryB64 = canaryBuf.toString("base64");
    const chunkA = canaryBuf.subarray(0, 12);
    const chunkB = canaryBuf.subarray(12, 24);
    const chunkC = canaryBuf.subarray(24);
    const uploadId = `upl_${randomUUID().replace(/-/g, "")}`;

    await snapshotAudits();
    // Chunks 0 and 1 (non-final) must write zero audit rows
    expect(
      (
        await call("PUT", filesBase(orgAId, siteAId, "/content"), {
          path: "secret.txt",
          uploadId,
          offset: 0,
          dataBase64: chunkA.toString("base64"),
          final: false,
          overwrite: false,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call("PUT", filesBase(orgAId, siteAId, "/content"), {
          path: "secret.txt",
          uploadId,
          offset: chunkA.length,
          dataBase64: chunkB.toString("base64"),
          final: false,
          overwrite: false,
        })
      ).status,
    ).toBe(200);
    expect(await newAudits()).toHaveLength(0);

    // Final chunk writes exactly 1 audit row
    expect(
      (
        await call("PUT", filesBase(orgAId, siteAId, "/content"), {
          path: "secret.txt",
          uploadId,
          offset: chunkA.length + chunkB.length,
          dataBase64: chunkC.toString("base64"),
          final: true,
          overwrite: false,
        })
      ).status,
    ).toBe(200);
    const uploadAudits = await newAudits();
    expect(uploadAudits).toHaveLength(1);
    expect(uploadAudits[0]!.action).toBe("site.files.upload");
    expect(uploadAudits[0]!.details).toMatchObject({
      path: "secret.txt",
      size: canaryBuf.length,
    });

    await snapshotAudits();
    expect(
      (await call("POST", filesBase(orgAId, siteAId, "/folders"), { path: "audit-dir" })).status,
    ).toBe(204);
    const mkdirAudits = await newAudits();
    expect(mkdirAudits).toHaveLength(1);
    expect(mkdirAudits[0]!.action).toBe("site.files.folder.create");
    expect(mkdirAudits[0]!.details).toMatchObject({ path: "audit-dir" });

    await snapshotAudits();
    expect(
      (
        await call("POST", filesBase(orgAId, siteAId, "/move"), {
          from: "secret.txt",
          to: "audit-dir/secret.txt",
        })
      ).status,
    ).toBe(204);
    const moveAudits = await newAudits();
    expect(moveAudits).toHaveLength(1);
    expect(moveAudits[0]!.action).toBe("site.files.move");
    expect(moveAudits[0]!.details).toMatchObject({
      from: "secret.txt",
      to: "audit-dir/secret.txt",
    });

    await snapshotAudits();
    const archRes = await call(
      "POST",
      filesBase(orgAId, siteAId, "/archive"),
      { paths: ["audit-dir"], to: "audit.zip" },
      { "Idempotency-Key": randomUUID() },
    );
    expect(archRes.status).toBe(202);
    const archOpId = archRes.body.data.operationId as string;
    const archAudits = await newAudits();
    expect(archAudits).toHaveLength(1);
    expect(archAudits[0]!.action).toBe("site.files.archive");
    expect(archAudits[0]!.details).toMatchObject({
      paths: ["audit-dir"],
      count: 1,
      to: "audit.zip",
      operationId: archOpId,
    });
    await app.outboxWorker.processPendingOnce();

    await snapshotAudits();
    const extRes = await call(
      "POST",
      filesBase(orgAId, siteAId, "/extract"),
      { path: "audit.zip", to: "audit-extracted" },
      { "Idempotency-Key": randomUUID() },
    );
    expect(extRes.status).toBe(202);
    const extOpId = extRes.body.data.operationId as string;
    const extAudits = await newAudits();
    expect(extAudits).toHaveLength(1);
    expect(extAudits[0]!.action).toBe("site.files.extract");
    expect(extAudits[0]!.details).toMatchObject({
      path: "audit.zip",
      to: "audit-extracted",
      operationId: extOpId,
    });
    await app.outboxWorker.processPendingOnce();

    await snapshotAudits();
    expect(
      (
        await call("POST", filesBase(orgAId, siteAId, "/delete"), {
          paths: ["audit-dir", "audit.zip", "audit-extracted"],
        })
      ).status,
    ).toBe(204);
    const delAudits = await newAudits();
    expect(delAudits).toHaveLength(1);
    expect(delAudits[0]!.action).toBe("site.files.delete");
    expect(delAudits[0]!.details).toMatchObject({
      paths: ["audit-dir", "audit.zip", "audit-extracted"],
      count: 3,
    });

    // Verify audit caps paths at 20 and truncates individual paths to 256 chars
    const longFolder = "d".repeat(250);
    expect(
      (await call("POST", filesBase(orgAId, siteAId, "/folders"), { path: longFolder })).status,
    ).toBe(204);
    const manyPaths = Array.from({ length: 22 }, (_, i) => `${longFolder}/file-${String(i).padStart(2, "0")}.txt`);
    for (const p of manyPaths) {
      expect((await uploadChunks(p, Buffer.from("x")))[0]!.status).toBe(200);
    }
    await snapshotAudits();
    expect((await call("POST", filesBase(orgAId, siteAId, "/delete"), { paths: manyPaths })).status).toBe(204);
    const cappedDelAudits = await newAudits();
    expect(cappedDelAudits).toHaveLength(1);
    const cappedDetails = cappedDelAudits[0]!.details as Json;
    expect(cappedDetails["count"]).toBe(22);
    expect(cappedDetails["paths"]).toHaveLength(20);
    expect((cappedDetails["paths"] as string[]).every((p) => p.length <= 256)).toBe(true);

    // Verify no audit row in the DB holds file content or base64
    const allAudits = await dbClient.db.select().from(auditEvents);
    const serialized = JSON.stringify(allAudits);
    expect(serialized).not.toContain(canaryText);
    expect(serialized).not.toContain(canaryB64);
    expect(serialized).not.toContain(chunkA.toString("base64"));
  });

  it("leaks: neither HTTP responses nor audit rows expose serviceInstanceId, Docker names, host paths, or raw executor text", async () => {
    await snapshotAudits();
    const rawExecutorMsg = `raw fail on ${svcAId} hp_vol_${svcAId}_html hp_files_${svcAId} /var/lib/hosting-panel /var/www/html/wp-config.php`;

    // 1. Mapped R2 reason error exposes reason, never leaks
    vi.spyOn(sim, "siteFiles").mockRejectedValueOnce(new ExecutorCodedError("exists", "ALREADY_EXISTS"));
    const mappedRes = await call("POST", filesBase(orgAId, siteAId, "/folders"), { path: "any" });
    expect(mappedRes.status).toBe(409);
    expect(mappedRes.body.error.code).toBe("ALREADY_EXISTS");
    expect(mappedRes.body.error.details[0]?.reason).toBe("exists");
    assertNoInternalLeaks(mappedRes.raw);

    // 2. Unmapped raw executor message strips details and never leaks raw text
    vi.spyOn(sim, "siteFiles").mockRejectedValueOnce(
      new ExecutorCodedError(rawExecutorMsg, "DOCKER_ENGINE_UNAVAILABLE"),
    );
    const unmappedRes = await call("GET", filesBase(orgAId, siteAId, "?path="));
    expect(unmappedRes.status).toBe(503);
    expect(unmappedRes.body.error.code).toBe("DOCKER_ENGINE_UNAVAILABLE");
    expect(unmappedRes.body.error.details).toEqual([]);
    assertNoInternalLeaks(unmappedRes.raw, [rawExecutorMsg]);

    // 3. Unmapped async executor failure never leaks into operation DTO or audit rows
    const archRes = await call(
      "POST",
      filesBase(orgAId, siteAId, "/archive"),
      { paths: ["index.php"], to: "leak-test.zip" },
      { "Idempotency-Key": randomUUID() },
    );
    expect(archRes.status).toBe(202);
    const opId = archRes.body.data.operationId as string;

    vi.spyOn(sim, "siteFiles").mockRejectedValueOnce(
      new ExecutorCodedError(rawExecutorMsg, "DOCKER_ENGINE_UNAVAILABLE"),
    );
    await app.outboxWorker.processPendingOnce();

    const opRes = await call("GET", `/v1/organizations/${orgAId}/operations/${opId}`);
    expect(opRes.status).toBe(200);
    expect(opRes.body.data.status).toBe("failed");
    assertNoInternalLeaks(opRes.raw, [rawExecutorMsg]);

    const audits = await newAudits();
    assertNoInternalLeaks(audits, [rawExecutorMsg]);
  });

  it("zip and unzip: Idempotency-Key rules, async archive & extract into new folder with entry count", async () => {
    // Missing Idempotency-Key is refused on archive and extract
    const missingArch = await call("POST", filesBase(orgAId, siteAId, "/archive"), {
      paths: ["index.php"],
      to: "bundle.zip",
    });
    expect(missingArch.status).toBe(400);
    expect(missingArch.body.error.code).toBe("VALIDATION_ERROR");

    const missingExt = await call("POST", filesBase(orgAId, siteAId, "/extract"), {
      path: "bundle.zip",
      to: "restored",
    });
    expect(missingExt.status).toBe(400);
    expect(missingExt.body.error.code).toBe("VALIDATION_ERROR");

    // Seed two files inside a folder
    expect(
      (await call("POST", filesBase(orgAId, siteAId, "/folders"), { path: "pack" })).status,
    ).toBe(204);
    const file1 = Buffer.from("alpha file content", "utf8");
    const file2 = Buffer.from("beta file content", "utf8");
    expect((await uploadChunks("pack/a.txt", file1))[0]!.status).toBe(200);
    expect((await uploadChunks("pack/b.txt", file2))[0]!.status).toBe(200);

    // Same Idempotency-Key twice gives the same operationId
    const idempKey = randomUUID();
    const firstArch = await call(
      "POST",
      filesBase(orgAId, siteAId, "/archive"),
      { paths: ["pack"], to: "pack.zip" },
      { "Idempotency-Key": idempKey },
    );
    expect(firstArch.status).toBe(202);
    const opId = firstArch.body.data.operationId as string;
    expect(firstArch.body.links.operation).toBe(`/v1/organizations/${orgAId}/operations/${opId}`);

    const replayArch = await call(
      "POST",
      filesBase(orgAId, siteAId, "/archive"),
      { paths: ["pack"], to: "pack.zip" },
      { "Idempotency-Key": idempKey },
    );
    expect(replayArch.status).toBe(202);
    expect(replayArch.body.data.operationId).toBe(opId);

    // Reusing the same key for extract conflicts
    const conflictExt = await call(
      "POST",
      filesBase(orgAId, siteAId, "/extract"),
      { path: "pack.zip", to: "restored" },
      { "Idempotency-Key": idempKey },
    );
    expect(conflictExt.status).toBe(409);
    expect(conflictExt.body.error.code).toBe("IDEMPOTENCY_CONFLICT");

    await app.outboxWorker.processPendingOnce();

    const archOpRes = await call("GET", `/v1/organizations/${orgAId}/operations/${opId}`);
    expect(archOpRes.status).toBe(200);
    expect(archOpRes.body.data.kind).toBe("site.files.archive");
    expect(archOpRes.body.data.status).toBe("succeeded");
    const archStep = archOpRes.body.data.steps.find((s: Json) => s.key === "archive_files");
    expect(archStep.status).toBe("succeeded");
    expect(archStep.message).toContain("3"); // pack/, pack/a.txt, pack/b.txt

    const rootAfterArch = await call("GET", filesBase(orgAId, siteAId, "?path="));
    const zipEntry = rootAfterArch.body.data.entries.find((e: Json) => e.name === "pack.zip");
    expect(zipEntry).toBeDefined();
    expect(zipEntry.size).toBeGreaterThan(0);

    // Delete original folder, then extract into a brand-new folder 'restored'
    expect(
      (await call("POST", filesBase(orgAId, siteAId, "/delete"), { paths: ["pack"] })).status,
    ).toBe(204);

    const extRes = await call(
      "POST",
      filesBase(orgAId, siteAId, "/extract"),
      { path: "pack.zip", to: "restored" },
      { "Idempotency-Key": randomUUID() },
    );
    expect(extRes.status).toBe(202);
    const extOpId = extRes.body.data.operationId as string;
    await app.outboxWorker.processPendingOnce();

    const extOpRes = await call("GET", `/v1/organizations/${orgAId}/operations/${extOpId}`);
    expect(extOpRes.status).toBe(200);
    expect(extOpRes.body.data.kind).toBe("site.files.extract");
    expect(extOpRes.body.data.status).toBe("succeeded");
    const extStep = extOpRes.body.data.steps.find((s: Json) => s.key === "extract_files");
    expect(extStep.status).toBe("succeeded");
    expect(extStep.message).toContain("3");

    const restoredReadA = await call(
      "GET",
      filesBase(orgAId, siteAId, "/content?path=restored/pack/a.txt"),
    );
    expect(restoredReadA.status).toBe(200);
    expect(Buffer.from(restoredReadA.body.data.dataBase64 as string, "base64").equals(file1)).toBe(
      true,
    );
    const restoredReadB = await call(
      "GET",
      filesBase(orgAId, siteAId, "/content?path=restored/pack/b.txt"),
    );
    expect(restoredReadB.status).toBe(200);
    expect(Buffer.from(restoredReadB.body.data.dataBase64 as string, "base64").equals(file2)).toBe(
      true,
    );
  });

  it("extract of an archive with an unsafe entry fails safely without degrading the site or extracting anything", async () => {
    const unsafeZip = makeSimZip([
      { p: "good.txt", d: Buffer.from("should not extract").toString("base64") },
      { p: "../escape.txt", d: Buffer.from("evil").toString("base64") },
    ]);
    expect((await uploadChunks("unsafe-traversal.zip", unsafeZip))[0]!.status).toBe(200);

    const symlinkZip = makeSimZip([
      { p: "good.txt", d: Buffer.from("should not extract").toString("base64") },
      { p: "sym", link: "/etc/passwd" },
    ]);
    expect((await uploadChunks("unsafe-symlink.zip", symlinkZip))[0]!.status).toBe(200);

    for (const [zipPath, destFolder] of [
      ["unsafe-traversal.zip", "dest-traversal"],
      ["unsafe-symlink.zip", "dest-symlink"],
    ] as const) {
      const extRes = await call(
        "POST",
        filesBase(orgAId, siteAId, "/extract"),
        { path: zipPath, to: destFolder },
        { "Idempotency-Key": randomUUID() },
      );
      expect(extRes.status).toBe(202);
      const opId = extRes.body.data.operationId as string;

      await app.outboxWorker.processPendingOnce();

      const opRes = await call("GET", `/v1/organizations/${orgAId}/operations/${opId}`);
      expect(opRes.status).toBe(200);
      expect(opRes.body.data.status).toBe("failed");
      expect(opRes.body.data.errorCode).toBe("VALIDATION_ERROR");
      expect(opRes.body.data.errorMessage).toBe("The archive contains unsafe file entries.");
      assertNoInternalLeaks(opRes.raw);

      // Site is NOT degraded
      const siteRes = await call("GET", `/v1/organizations/${orgAId}/managed-sites/${siteAId}`);
      expect(siteRes.status).toBe(200);
      expect(siteRes.body.data.status).toBe("ready");

      // Nothing was extracted (destination folder was not created)
      const destList = await call("GET", filesBase(orgAId, siteAId, `?path=${destFolder}`));
      expect(destList.status).toBe(404);
    }
  });

  it("site lock contention: second async file operation while one holds the site lock is refused with 409 RESOURCE_LOCKED, while sync ops stay allowed", async () => {
    const first = await call(
      "POST",
      filesBase(orgAId, siteAId, "/archive"),
      { paths: ["index.php"], to: "first.zip" },
      { "Idempotency-Key": randomUUID() },
    );
    expect(first.status).toBe(202);

    // Second archive/extract while lock site:<siteId> is held is refused with 409 RESOURCE_LOCKED
    const secondArch = await call(
      "POST",
      filesBase(orgAId, siteAId, "/archive"),
      { paths: ["wp-config.php"], to: "second.zip" },
      { "Idempotency-Key": randomUUID() },
    );
    expect(secondArch.status).toBe(409);
    expect(secondArch.body.error.code).toBe("RESOURCE_LOCKED");

    const secondExt = await call(
      "POST",
      filesBase(orgAId, siteAId, "/extract"),
      { path: "first.zip", to: "dest" },
      { "Idempotency-Key": randomUUID() },
    );
    expect(secondExt.status).toBe(409);
    expect(secondExt.body.error.code).toBe("RESOURCE_LOCKED");

    // Sync reads and writes are allowed while an archive operation holds the site lock
    expect((await call("GET", filesBase(orgAId, siteAId, "?path="))).status).toBe(200);
    expect(
      (await uploadChunks("during-archive.txt", Buffer.from("concurrent sync write")))[0]!.status,
    ).toBe(200);

    // After first operation finishes, a new async operation succeeds
    await app.outboxWorker.processPendingOnce();
    const afterFirst = await call(
      "POST",
      filesBase(orgAId, siteAId, "/extract"),
      { path: "first.zip", to: "dest" },
      { "Idempotency-Key": randomUUID() },
    );
    expect(afterFirst.status).toBe(202);
  });

  it("recovery of an interrupted file operation marks it failed without degrading the site", async () => {
    // 1. Ambiguous IPC failure moves operation to 'unknown', then recoverUnknownOperations marks it 'failed'
    const archRes = await call(
      "POST",
      filesBase(orgAId, siteAId, "/archive"),
      { paths: ["index.php"], to: "interrupted.zip" },
      { "Idempotency-Key": randomUUID() },
    );
    expect(archRes.status).toBe(202);
    const opId1 = archRes.body.data.operationId as string;

    vi.spyOn(sim, "siteFiles").mockRejectedValueOnce(
      Object.assign(new Error("IPC connection lost"), {
        code: "OPERATION_AMBIGUOUS",
        ambiguousOutcome: true,
      }),
    );
    await app.outboxWorker.processPendingOnce();

    const unknownOp = await call("GET", `/v1/organizations/${orgAId}/operations/${opId1}`);
    expect(unknownOp.body.data.status).toBe("unknown");

    const rec1 = await app.outboxWorker.recoverUnknownOperations();
    expect(rec1.convergedFailed).toBeGreaterThanOrEqual(1);

    const failedOp1 = await call("GET", `/v1/organizations/${orgAId}/operations/${opId1}`);
    expect(failedOp1.body.data.status).toBe("failed");
    expect(failedOp1.body.data.errorCode).toBe("OPERATION_INTERRUPTED");
    assertNoInternalLeaks(failedOp1.raw);

    const [siteRow1] = await dbClient.db.select().from(sites).where(eq(sites.id, siteAId));
    expect(siteRow1!.status).toBe("ready");

    // 2. Expired lease while processing is marked unknown and recovered to failed without degrading the site
    const extRes = await call(
      "POST",
      filesBase(orgAId, siteAId, "/extract"),
      { path: "interrupted.zip", to: "recovered-dest" },
      { "Idempotency-Key": randomUUID() },
    );
    expect(extRes.status).toBe(202);
    const opId2 = extRes.body.data.operationId as string;

    await dbClient.db
      .update(operations)
      .set({ status: "processing", leaseExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(operations.id, opId2));

    const rec2 = await app.outboxWorker.recoverUnknownOperations(new Date());
    expect(rec2.markedUnknown).toBeGreaterThanOrEqual(1);
    expect(rec2.convergedFailed).toBeGreaterThanOrEqual(1);

    const failedOp2 = await call("GET", `/v1/organizations/${orgAId}/operations/${opId2}`);
    expect(failedOp2.body.data.status).toBe("failed");
    const [siteRow2] = await dbClient.db.select().from(sites).where(eq(sites.id, siteAId));
    expect(siteRow2!.status).toBe("ready");
  });

  it("validation at the edge (POST files/folders ../x) puts the reason word in details[0].message and Zod issue code in details[0].reason", async () => {
    const res = await call("POST", filesBase(orgAId, siteAId, "/folders"), { path: "../x" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.details[0]).toEqual({
      field: "path",
      message: "invalid_path",
      reason: "custom",
    });
  });

  it("archive to protected folder wp-content/mu-plugins/x.zip fails with PERMISSION_DENIED without degrading the site or writing a denied audit row", async () => {
    await snapshotAudits();
    const archRes = await call(
      "POST",
      filesBase(orgAId, siteAId, "/archive"),
      { paths: ["index.php"], to: "wp-content/mu-plugins/x.zip" },
      { "Idempotency-Key": randomUUID() },
    );
    expect(archRes.status).toBe(202);
    const opId = archRes.body.data.operationId as string;

    await app.outboxWorker.processPendingOnce();

    const opRes = await call("GET", `/v1/organizations/${orgAId}/operations/${opId}`);
    expect(opRes.status).toBe(200);
    expect(opRes.body.data.status).toBe("failed");
    expect(opRes.body.data.errorCode).toBe("PERMISSION_DENIED");
    expect(opRes.body.data.errorMessage).toBe("This file or folder is protected and cannot be modified.");
    assertNoInternalLeaks(opRes.raw);

    const siteRes = await call("GET", `/v1/organizations/${orgAId}/managed-sites/${siteAId}`);
    expect(siteRes.status).toBe(200);
    expect(siteRes.body.data.status).toBe("ready");

    const audits = await newAudits();
    expect(audits.filter((a) => (a.details as Json)["outcome"] === "denied")).toHaveLength(0);
  });

  it("outbox lanes: an in-flight archive does not block another organization's operation from finishing", async () => {
    const origSiteFiles = sim.siteFiles.bind(sim);
    let signalArchiveEntered!: () => void;
    const archiveEntered = new Promise<void>((resolve) => {
      signalArchiveEntered = resolve;
    });
    let releaseArchive!: () => void;
    const archiveGate = new Promise<void>((resolve) => {
      releaseArchive = resolve;
    });

    const spy = vi.spyOn(sim, "siteFiles").mockImplementation(async (req) => {
      if (req.op === "archive") {
        signalArchiveEntered();
        await archiveGate;
      }
      return origSiteFiles(req);
    });

    let firstRun: Promise<unknown> | undefined;
    let secondTick: Promise<unknown> | undefined;
    try {
      const archRes = await call(
        "POST",
        filesBase(orgAId, siteAId, "/archive"),
        { paths: ["index.php"], to: "blocking-lane.zip" },
        { "Idempotency-Key": randomUUID() },
      );
      expect(archRes.status).toBe(202);
      const archOpId = archRes.body.data.operationId as string;

      firstRun = app.outboxWorker.processPendingOnce();
      await archiveEntered;

      // Queue an operation for Organization B while Org A's archive is still running
      const orgBCreate = await call(
        "POST",
        `/v1/organizations/${orgBId}/managed-sites`,
        { ...SITE_B, name: "Bar Sport Two", domain: `barsport-two-${randomUUID().slice(0, 6)}.it` },
        { "Idempotency-Key": randomUUID() },
        ownerBToken,
      );
      expect(orgBCreate.status).toBe(202);
      const orgBOpId = orgBCreate.body.data.operationId as string;

      // Simulate a worker tick: file lane is busy, main lane starts and finishes Org B's operation
      secondTick = app.outboxWorker.processPendingOnce();

      await vi.waitFor(async () => {
        const orgBOp = await call(
          "GET",
          `/v1/organizations/${orgBId}/operations/${orgBOpId}`,
          undefined,
          undefined,
          ownerBToken,
        );
        expect(orgBOp.status).toBe(200);
        expect(orgBOp.body.data.status).toBe("succeeded");
      });

      // Org A's archive must still be in-flight (processing) while Org B's op already succeeded
      const archWhileRunning = await call("GET", `/v1/organizations/${orgAId}/operations/${archOpId}`);
      expect(archWhileRunning.status).toBe(200);
      expect(archWhileRunning.body.data.status).toBe("processing");
      expect(spy).toHaveBeenCalledTimes(1);

      releaseArchive();
      await Promise.all([firstRun, secondTick]);

      const archAfter = await call("GET", `/v1/organizations/${orgAId}/operations/${archOpId}`);
      expect(archAfter.status).toBe(200);
      expect(archAfter.body.data.status).toBe("succeeded");
    } finally {
      releaseArchive();
      await Promise.allSettled([firstRun, secondTick].filter(Boolean));
    }
  });

  it("outbox lanes: two file operations of two different sites still execute sequentially", async () => {
    const [svcB] = await dbClient.db
      .select()
      .from(serviceInstances)
      .where(eq(serviceInstances.siteId, siteBId));
    expect(svcB).toBeDefined();
    sim.files.drop(svcB!.id);
    sim.files.create(svcB!.id);

    const origSiteFiles = sim.siteFiles.bind(sim);
    let activeCount = 0;
    let maxConcurrent = 0;
    const startedServiceIds: string[] = [];
    let signalFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      signalFirstEntered = resolve;
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    vi.spyOn(sim, "siteFiles").mockImplementation(async (req) => {
      activeCount += 1;
      maxConcurrent = Math.max(maxConcurrent, activeCount);
      startedServiceIds.push(req.serviceInstanceId);
      try {
        if (startedServiceIds.length === 1) {
          signalFirstEntered();
          await firstGate;
        }
        return await origSiteFiles(req);
      } finally {
        activeCount -= 1;
      }
    });

    let run1: Promise<unknown> | undefined;
    let run2: Promise<unknown> | undefined;
    try {
      const archA = await call(
        "POST",
        filesBase(orgAId, siteAId, "/archive"),
        { paths: ["index.php"], to: "seq-a.zip" },
        { "Idempotency-Key": randomUUID() },
      );
      expect(archA.status).toBe(202);
      const opAId = archA.body.data.operationId as string;

      const archB = await call(
        "POST",
        filesBase(orgBId, siteBId, "/archive"),
        { paths: ["index.php"], to: "seq-b.zip" },
        { "Idempotency-Key": randomUUID() },
        ownerBToken,
      );
      expect(archB.status).toBe(202);
      const opBId = archB.body.data.operationId as string;

      run1 = app.outboxWorker.processPendingOnce();
      await firstEntered;

      // Another worker tick while the first file op is still running must not start the second file op concurrently
      run2 = app.outboxWorker.processPendingOnce();
      await new Promise((r) => setTimeout(r, 40));

      expect(activeCount).toBe(1);
      expect(startedServiceIds).toHaveLength(1);
      const opBWhileWaiting = await call(
        "GET",
        `/v1/organizations/${orgBId}/operations/${opBId}`,
        undefined,
        undefined,
        ownerBToken,
      );
      expect(opBWhileWaiting.status).toBe(200);
      expect(opBWhileWaiting.body.data.status).toBe("queued");

      releaseFirst();
      await Promise.all([run1, run2]);

      expect(maxConcurrent).toBe(1);
      expect(startedServiceIds).toHaveLength(2);
      expect(startedServiceIds).toEqual([svcAId, svcB!.id]);

      const opAAfter = await call("GET", `/v1/organizations/${orgAId}/operations/${opAId}`);
      expect(opAAfter.body.data.status).toBe("succeeded");
      const opBAfter = await call(
        "GET",
        `/v1/organizations/${orgBId}/operations/${opBId}`,
        undefined,
        undefined,
        ownerBToken,
      );
      expect(opBAfter.body.data.status).toBe("succeeded");
    } finally {
      releaseFirst();
      await Promise.allSettled([run1, run2].filter(Boolean));
    }
  });
});

describe("site files HTTP API when runtime is disabled", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let orgId: string;
  let siteId: string;
  let token: string;

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, {
      email: "admin-disabled@x.it",
      name: "Admin",
      password: PW,
    });
    app = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      runtimeBackend: "disabled",
      dockerExecutor: new Phase1DisabledDockerExecutor(),
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
      domainReconcileIntervalMs: null,
      mailRelayRetryIntervalMs: null,
      recoverUnknownOnStart: false,
    });

    const adminToken = await loginUser(
      app.baseUrl!,
      "admin-disabled@x.it",
      PW,
      admin.totpSecretBase32,
    );
    const created = await httpJson(app.baseUrl!, "POST", "/v1/admin/customer-account", {
      token: adminToken,
      body: { organizationName: "Disabled Org", ownerEmail: "owner@disabled.it", ownerName: "Owner" },
    });
    expect(created.status).toBe(201);
    orgId = created.body.data.organizationId as string;
    token = await loginUser(
      app.baseUrl!,
      "owner@disabled.it",
      created.body.data.temporaryPassword as string,
    );

    const [alloc] = await dbClient.db
      .select()
      .from(hostAllocations)
      .where(eq(hostAllocations.organizationId, orgId))
      .limit(1);
    siteId = `site_disabled_${randomUUID()}`;
    await dbClient.db.insert(sites).values({
      id: siteId,
      organizationId: orgId,
      hostAllocationId: alloc!.id,
      name: "Static Ready Site",
      slug: "static-ready-site",
      status: "ready",
      phpVersion: "8.4",
    });
  });

  afterAll(async () => {
    await app.close();
    await dbClient.close();
  });

  it("all files routes return 422 NOT_SUPPORTED when runtime backend is disabled", async () => {
    const base = `/v1/organizations/${orgId}/managed-sites/${siteId}/files`;
    const calls = [
      httpJson(app.baseUrl!, "GET", `${base}?path=`, { token }),
      httpJson(app.baseUrl!, "GET", `${base}/content?path=index.php`, { token }),
      httpJson(app.baseUrl!, "PUT", `${base}/content`, {
        token,
        body: {
          path: "a.txt",
          uploadId: "upl_0123456789abcdef",
          offset: 0,
          dataBase64: Buffer.from("hi").toString("base64"),
          final: true,
          overwrite: true,
        },
      }),
      httpJson(app.baseUrl!, "POST", `${base}/folders`, { token, body: { path: "dir" } }),
      httpJson(app.baseUrl!, "POST", `${base}/move`, {
        token,
        body: { from: "a.txt", to: "b.txt" },
      }),
      httpJson(app.baseUrl!, "POST", `${base}/delete`, { token, body: { paths: ["a.txt"] } }),
      httpJson(app.baseUrl!, "POST", `${base}/archive`, {
        token,
        headers: { "Idempotency-Key": randomUUID() },
        body: { paths: ["a.txt"], to: "a.zip" },
      }),
      httpJson(app.baseUrl!, "POST", `${base}/extract`, {
        token,
        headers: { "Idempotency-Key": randomUUID() },
        body: { path: "a.zip", to: "out" },
      }),
    ];

    const results = await Promise.all(calls);
    for (const res of results) {
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("NOT_SUPPORTED");
    }
  });
});
