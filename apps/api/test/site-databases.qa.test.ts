import http from "node:http";
import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import {
  auditEvents,
  createDatabaseClient,
  encryptedSecrets,
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
  serviceInstances,
  siteDatabases,
  stackRevisions,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import {
  type ErrorCode,
  mysqlNativePasswordHash,
  SITE_DATABASE_USERS_MAX,
  SITE_DATABASES_MAX,
  siteDatabaseFullName,
  siteDatabasePrefix,
} from "@hosting-panel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiExceptionFilter } from "../src/common/api-exception.filter.js";
import { hashPassword } from "../src/auth/password.js";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";

const KEY = Buffer.alloc(32, 9);
const PW = "correct-horse-qa-battery";
const SETUP = { installationName: "QA Test", hostHostname: "qa-panel.test", hostIpv4: "10.0.0.10" };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

function siteBody(suffix: string) {
  return {
    name: `Site ${suffix}`,
    domain: `site-${suffix}.test`,
    title: `Title ${suffix}`,
    adminUser: "admin",
    adminEmail: `admin@${suffix}.test`,
    adminPassword: "qa-wp-Pass-123456",
  };
}

/** Sends a raw HTTP path without client-side URL dot-segment normalization. */
function rawRequest(
  baseUrl: string,
  method: string,
  rawPath: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Json; text: string }> {
  const url = new URL(baseUrl);
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (payload !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(payload));
    }
    const req = http.request(
      { hostname: url.hostname, port: Number(url.port), path: rawPath, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: Json = {};
          if (text) {
            try {
              body = JSON.parse(text) as Json;
            } catch {
              body = {};
            }
          }
          resolve({ status: res.statusCode ?? 0, body, text });
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

describe("site databases & phpMyAdmin QA (simulator API)", () => {
  let dbClient: DatabaseClient;
  let sim: InMemoryDockerSimulatorAdapter;
  let app: ControlPlaneAppHandle;
  let adminToken: string;
  let orgA: string;
  let ownerAToken: string;
  let collabAToken: string;
  let orgB: string;
  let siteA: string;
  let siteA2: string;
  let siteB: string;
  let execSpy: ReturnType<typeof vi.spyOn>;

  async function login(email: string, password: string, totpSecret?: string): Promise<string> {
    const res = await fetch(`${app.baseUrl!}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        ...(totpSecret ? { totpCode: totpCodeAt(totpSecret, Math.floor(Date.now() / 30_000)) } : {}),
      }),
    });
    const json = (await res.json()) as Json;
    return json.data.accessToken as string;
  }

  async function api(
    method: string,
    path: string,
    body?: unknown,
    token: string = ownerAToken,
    headers?: Record<string, string>,
  ): Promise<{ status: number; body: Json; text: string }> {
    return rawRequest(app.baseUrl!, method, path, { token, body, headers });
  }

  async function provisionSite(orgId: string, token: string, suffix: string): Promise<string> {
    const res = await api(
      "POST",
      `/v1/organizations/${orgId}/managed-sites`,
      siteBody(suffix),
      token,
      { "Idempotency-Key": randomUUID() },
    );
    expect(res.status, res.text).toBe(202);
    await app.outboxWorker.processPendingOnce();
    return res.body.data.siteId as string;
  }

  const dbBase = (o: string, s: string) => `/v1/organizations/${o}/managed-sites/${s}/databases`;
  const userBase = (o: string, s: string) => `/v1/organizations/${o}/managed-sites/${s}/database-users`;

  async function allAuditRows() {
    return dbClient.db.select().from(auditEvents);
  }

  beforeEach(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, {
      email: "admin@qa.test",
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
    adminToken = await login("admin@qa.test", PW, admin.totpSecretBase32);

    const aRes = await api(
      "POST",
      "/v1/admin/customer-account",
      { organizationName: "Org Alpha", ownerEmail: "alpha@qa.test", ownerName: "Alpha" },
      adminToken,
    );
    expect(aRes.status).toBe(201);
    orgA = aRes.body.data.organizationId as string;
    ownerAToken = await login("alpha@qa.test", aRes.body.data.temporaryPassword as string);

    const [installation] = await dbClient.db.select().from(platformInstallations);
    const [host] = await dbClient.db.select().from(hosts);
    orgB = `org_${randomUUID()}`;
    const ownerBId = randomUUID();
    const ownerBMemId = randomUUID();
    await dbClient.db.insert(organizations).values({
      id: orgB,
      platformInstallationId: installation!.id,
      name: "Org Beta",
      slug: `org-beta-${randomUUID().slice(0, 6)}`,
      status: "active",
    });
    await dbClient.db.insert(hostAllocations).values({
      id: randomUUID(),
      hostId: host!.id,
      organizationId: orgB,
      status: "active",
      hostingMode: "shared",
      dedicatedScope: false,
    });
    await dbClient.db.insert(users).values({
      id: ownerBId,
      email: "beta@qa.test",
      name: "Beta",
      userStatus: "active",
      passwordHash: await hashPassword(PW),
      mustChangePassword: false,
    });
    await dbClient.db.insert(memberships).values({
      id: ownerBMemId,
      organizationId: orgB,
      userId: ownerBId,
      status: "active",
    });
    await dbClient.db.insert(membershipRoles).values({
      id: randomUUID(),
      membershipId: ownerBMemId,
      roleId: "role_customer_owner",
      scopeType: "organization",
    });
    const ownerBToken = await login("beta@qa.test", PW);

    const collabId = randomUUID();
    const membershipId = randomUUID();
    await dbClient.db.insert(users).values({
      id: collabId,
      email: "collab@qa.test",
      name: "Collab",
      userStatus: "active",
      passwordHash: await hashPassword(PW),
      mustChangePassword: false,
    });
    await dbClient.db.insert(memberships).values({
      id: membershipId,
      organizationId: orgA,
      userId: collabId,
      status: "active",
    });
    await dbClient.db.insert(membershipRoles).values({
      id: randomUUID(),
      membershipId,
      roleId: "role_customer_collaborator",
      scopeType: "organization",
    });
    collabAToken = await login("collab@qa.test", PW);

    siteA = await provisionSite(orgA, ownerAToken, "a1");
    siteA2 = await provisionSite(orgA, ownerAToken, "a2");
    siteB = await provisionSite(orgB, ownerBToken, "b1");

    execSpy = vi.spyOn(sim, "siteDatabases");
    execSpy.mockClear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    await dbClient.close();
  });

  it("refuses SQL-like and hostile names in every body field and every path segment with 400/404 and zero executor calls", async () => {
    const prefix = siteDatabasePrefix(siteA);
    const validDb = `${prefix}_good`;
    const validUser = `${prefix}_usr`;
    expect((await api("POST", dbBase(orgA, siteA), { name: "good" })).status).toBe(201);
    expect((await api("POST", userBase(orgA, siteA), { name: "usr" })).status).toBe(201);
    execSpy.mockClear();

    const hostileBodies = [
      "a' OR '1'='1",
      "a`b",
      "a;DROP TABLE users",
      "a%b",
      "../etc",
      "a%2Fb",
      "a\u0000b",
      "a".repeat(200),
      "BAD_SQL';--",
      "",
      "   ",
    ];
    for (const bad of hostileBodies) {
      for (const route of [dbBase(orgA, siteA), userBase(orgA, siteA)]) {
        const res = await api("POST", route, { name: bad });
        expect([400, 404]).toContain(res.status);
      }
      const pmaBadBody = await api("POST", `${dbBase(orgA, siteA)}/phpmyadmin`, { name: bad });
      expect([400, 422]).toContain(pmaBadBody.status);
    }

    // Uppercase in POST body suffix is trimmed+lowercased by schema and never forwarded in uppercase
    const upperSuffixRes = await api("POST", dbBase(orgA, siteA), { name: "Shop" });
    expect(upperSuffixRes.status).toBe(201);
    expect(upperSuffixRes.body.data.database.name).toBe(`${prefix}_shop`);
    execSpy.mockClear();

    const hostilePathSegments = [
      "bad'quote",
      "bad`tick",
      "bad;semi",
      "bad%pct",
      "../escape",
      "..%2Fescape",
      "foo%2Fbar",
      "bad%00nul",
      "x".repeat(65),
      "x".repeat(200),
      `${prefix}_UPPER`,
    ];

    for (const seg of hostilePathSegments) {
      const encoded = seg.includes("%") || seg.includes("..") ? seg : encodeURIComponent(seg);
      const calls: Array<[string, string, unknown?]> = [
        ["GET", dbBase(encoded, siteA)],
        ["GET", dbBase(orgA, encoded)],
        ["POST", dbBase(encoded, siteA), { name: "safe" }],
        ["POST", dbBase(orgA, encoded), { name: "safe" }],
        ["DELETE", `${dbBase(orgA, siteA)}/${encoded}`],
        ["GET", `${dbBase(orgA, siteA)}/phpmyadmin`.replace(orgA, encoded)],
        ["POST", `${dbBase(orgA, siteA)}/phpmyadmin`.replace(siteA, encoded), {}],
        ["POST", userBase(encoded, siteA), { name: "safeu" }],
        ["POST", userBase(orgA, encoded), { name: "safeu" }],
        ["DELETE", `${userBase(orgA, siteA)}/${encoded}`],
        ["POST", `${userBase(orgA, siteA)}/${encoded}/reset-password`],
        ["PUT", `${userBase(orgA, siteA)}/${encoded}/grants/${validDb}`],
        ["PUT", `${userBase(orgA, siteA)}/${validUser}/grants/${encoded}`],
        ["DELETE", `${userBase(orgA, siteA)}/${encoded}/grants/${validDb}`],
        ["DELETE", `${userBase(orgA, siteA)}/${validUser}/grants/${encoded}`],
      ];
      const expectedStatuses = seg.length > 100 ? [400, 404, 414] : [400, 404];
      for (const [method, path, body] of calls) {
        const res = await api(method, path, body);
        expect(expectedStatuses, `${method} ${path} (seg=${seg}) -> ${res.status} ${res.text}`).toContain(res.status);
      }
    }
    const olderRouteNul = await api("GET", `/v1/organizations/${orgA}/managed-sites/bad%00`);
    expect(olderRouteNul.status, olderRouteNul.text).toBe(404);
    expect(olderRouteNul.body.error.code).toBe("NOT_FOUND");
    expect(execSpy).not.toHaveBeenCalled();
  });

  it("maps SQLSTATE 22021 to 404 only for %00 in the request path and to 400 VALIDATION_ERROR for body or query NUL", async () => {
    // 1) %00 in path before '?' -> 404 NOT_FOUND
    const pathNulRes = await api("GET", `/v1/organizations/${orgA}/managed-sites/bad%00?ok=1`);
    expect(pathNulRes.status, pathNulRes.text).toBe(404);
    expect(pathNulRes.body.error.code).toBe("NOT_FOUND");

    // 2) NUL in body field (e.g. creating a site with name "a\u0000b") -> 400 VALIDATION_ERROR, never 404 or 500
    const bodyNulRes = await api(
      "POST",
      `/v1/organizations/${orgA}/managed-sites`,
      { ...siteBody("nul-body"), name: "a\u0000b" },
      ownerAToken,
      { "Idempotency-Key": randomUUID() },
    );
    expect(bodyNulRes.status, bodyNulRes.text).toBe(400);
    expect(bodyNulRes.body.error.code).toBe("VALIDATION_ERROR");
    expect(bodyNulRes.body.error.message).toMatch(/character.*not allowed/i);

    // 3) %00 in query string (path clean) with SQLSTATE 22021 -> 400 VALIDATION_ERROR
    const filter = new ApiExceptionFilter();
    let capturedStatus = 0;
    let capturedEnvelope: Json = {};
    const fakeReply = {
      sent: false,
      raw: { headersSent: false },
      header: () => fakeReply,
      status: (s: number) => {
        capturedStatus = s;
        return fakeReply;
      },
      send: (env: Json) => {
        capturedEnvelope = env;
      },
    };
    const fakeHost = {
      switchToHttp: () => ({
        getRequest: () => ({
          url: `/v1/organizations/${orgA}/managed-sites?search=a%00b`,
          raw: { url: `/v1/organizations/${orgA}/managed-sites?search=a%00b` },
          headers: {},
        }),
        getResponse: () => fakeReply,
      }),
    };
    const pg22021 = Object.assign(new Error("invalid byte sequence for encoding \"UTF8\": 0x00"), {
      code: "22021",
    });
    filter.catch(pg22021, fakeHost as never);
    expect(capturedStatus).toBe(400);
    expect(capturedEnvelope.error.code).toBe("VALIDATION_ERROR");
    expect(capturedEnvelope.error.message).toMatch(/character.*not allowed/i);
  });

  it("never treats fixed databases/phpmyadmin path as a database name across methods, and refuses pma on simulator with 422 NOT_SUPPORTED", async () => {
    for (const method of ["DELETE", "PUT", "PATCH"]) {
      const res = await api(method, `${dbBase(orgA, siteA)}/phpmyadmin`);
      expect(res.status).toBe(404);
    }

    for (const method of ["GET", "POST"]) {
      const res = await api(method, `${dbBase(orgA, siteA)}/phpmyadmin`, method === "POST" ? {} : undefined);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("NOT_SUPPORTED");
    }

    const list = await api("GET", dbBase(orgA, siteA));
    expect(list.status).toBe(200);
    expect(list.body.data.phpMyAdminAvailable).toBe(false);
    expect(execSpy).toHaveBeenCalledTimes(1); // only list called simulator
  });

  it("isolates sites within same org and across orgs with 404 and zero executor calls", async () => {
    const prefixA2 = siteDatabasePrefix(siteA2);
    const prefixB = siteDatabasePrefix(siteB);
    const prefixA = siteDatabasePrefix(siteA);

    const aExtraDb = (await api("POST", dbBase(orgA, siteA), { name: "mine" })).body.data.database.name as string;
    const aExtraUser = (await api("POST", userBase(orgA, siteA), { name: "myusr" })).body.data.user.name as string;
    await api("POST", dbBase(orgA, siteA2), { name: "sibling" });
    await api("POST", userBase(orgA, siteA2), { name: "sibusr" });
    execSpy.mockClear();

    const foreignNames = [
      { db: `${prefixA2}_sibling`, usr: `${prefixA2}_sibusr`, prim: prefixA2 },
      { db: `${prefixB}_other`, usr: `${prefixB}_otheru`, prim: prefixB },
    ];

    for (const f of foreignNames) {
      expect((await api("DELETE", `${dbBase(orgA, siteA)}/${f.db}`)).status).toBe(404);
      expect((await api("DELETE", `${dbBase(orgA, siteA)}/${f.prim}`)).status).toBe(404);
      expect((await api("DELETE", `${userBase(orgA, siteA)}/${f.usr}`)).status).toBe(404);
      expect((await api("POST", `${userBase(orgA, siteA)}/${f.usr}/reset-password`)).status).toBe(404);
      expect((await api("PUT", `${userBase(orgA, siteA)}/${f.usr}/grants/${aExtraDb}`)).status).toBe(404);
      expect((await api("PUT", `${userBase(orgA, siteA)}/${aExtraUser}/grants/${f.db}`)).status).toBe(404);
      expect((await api("DELETE", `${userBase(orgA, siteA)}/${f.usr}/grants/${aExtraDb}`)).status).toBe(404);
      expect((await api("DELETE", `${userBase(orgA, siteA)}/${aExtraUser}/grants/${f.db}`)).status).toBe(404);
    }

    // Another organization's site returns 404 on every route and method
    const foreignRoutes: Array<[string, string, unknown?]> = [
      ["GET", dbBase(orgA, siteB)],
      ["POST", dbBase(orgA, siteB), { name: "x" }],
      ["DELETE", `${dbBase(orgA, siteB)}/${prefixB}_x`],
      ["GET", `${dbBase(orgA, siteB)}/phpmyadmin`],
      ["POST", `${dbBase(orgA, siteB)}/phpmyadmin`, {}],
      ["POST", userBase(orgA, siteB), { name: "u" }],
      ["DELETE", `${userBase(orgA, siteB)}/${prefixB}_u`],
      ["POST", `${userBase(orgA, siteB)}/${prefixB}_u/reset-password`],
      ["PUT", `${userBase(orgA, siteB)}/${prefixB}_u/grants/${prefixB}_x`],
      ["DELETE", `${userBase(orgA, siteB)}/${prefixB}_u/grants/${prefixB}_x`],
      ["GET", dbBase(orgB, siteB)],
      ["POST", dbBase(orgB, siteB), { name: "x" }],
      ["GET", `${dbBase(orgB, siteB)}/phpmyadmin`],
      ["POST", `${dbBase(orgB, siteB)}/phpmyadmin`, {}],
    ];
    for (const [method, path, body] of foreignRoutes) {
      const res = await api(method, path, body, ownerAToken);
      expect(res.status).toBe(404);
    }

    expect(aExtraDb).toBe(`${prefixA}_mine`);
    expect(execSpy).not.toHaveBeenCalled();
  });

  it("denies roles without site.databases.manage on all 10 routes with 403 and denied audit rows", async () => {
    const prefix = siteDatabasePrefix(siteA);
    const dbName = siteDatabaseFullName(prefix, "c1");
    const usrName = siteDatabaseFullName(prefix, "u1");
    await api("POST", dbBase(orgA, siteA), { name: "c1" });
    await api("POST", userBase(orgA, siteA), { name: "u1" });
    execSpy.mockClear();
    const auditsBefore = (await allAuditRows()).length;

    const routes: Array<[string, string, unknown?]> = [
      ["GET", dbBase(orgA, siteA)],
      ["GET", `${dbBase(orgA, siteA)}/phpmyadmin`],
      ["POST", dbBase(orgA, siteA), { name: "denied" }],
      ["DELETE", `${dbBase(orgA, siteA)}/${dbName}`],
      ["POST", userBase(orgA, siteA), { name: "denied" }],
      ["DELETE", `${userBase(orgA, siteA)}/${usrName}`],
      ["POST", `${userBase(orgA, siteA)}/${usrName}/reset-password`],
      ["PUT", `${userBase(orgA, siteA)}/${usrName}/grants/${dbName}`],
      ["DELETE", `${userBase(orgA, siteA)}/${usrName}/grants/${dbName}`],
      ["POST", `${dbBase(orgA, siteA)}/phpmyadmin`, {}],
    ];

    for (const [method, path, body] of routes) {
      const res = await api(method, path, body, collabAToken);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("PERMISSION_DENIED");
    }

    expect(execSpy).not.toHaveBeenCalled();
    const auditsAfter = await allAuditRows();
    const added = auditsAfter.slice(auditsBefore);
    expect(added).toHaveLength(routes.length);
    for (const row of added) {
      expect(row.action).toBe("site.databases.manage");
      expect((row.details as Json).outcome).toBe("denied");
    }
  });

  it("writes one names-only audit event per successful change and zero secrets across logs, DB tables, and list responses", async () => {
    const prefix = siteDatabasePrefix(siteA);
    const logs: string[] = [];
    const record = (...args: unknown[]) => logs.push(args.map((a) => String(a)).join(" "));
    for (const m of ["log", "warn", "error", "debug", "verbose"] as const) {
      vi.spyOn(Logger.prototype, m).mockImplementation((...args: unknown[]) => {
        record(...args);
      });
    }
    for (const m of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        record(...args);
      });
    }
    const origStdout = process.stdout.write.bind(process.stdout);
    const origStderr = process.stderr.write.bind(process.stderr);
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      logs.push(chunk.toString());
      return origStdout(chunk);
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      logs.push(chunk.toString());
      return origStderr(chunk);
    }) as typeof process.stderr.write);

    const beforeCount = (await allAuditRows()).length;

    const cDb = await api("POST", dbBase(orgA, siteA), { name: "shop" });
    expect(cDb.status).toBe(201);
    const dbName = cDb.body.data.database.name as string;

    const cUser = await api("POST", userBase(orgA, siteA), { name: "reader" });
    expect(cUser.status).toBe(201);
    const userName = cUser.body.data.user.name as string;
    const pwCreate = cUser.body.data.temporaryPassword as string;
    expect(typeof pwCreate).toBe("string");
    expect(pwCreate.length).toBeGreaterThanOrEqual(24);
    expect(cUser.text.split(pwCreate).length - 1).toBe(1);

    const grant = await api("PUT", `${userBase(orgA, siteA)}/${userName}/grants/${dbName}`);
    expect(grant.status).toBe(204);

    const reset = await api("POST", `${userBase(orgA, siteA)}/${userName}/reset-password`);
    expect(reset.status).toBe(200);
    const pwReset = reset.body.data.temporaryPassword as string;
    expect(typeof pwReset).toBe("string");
    expect(pwReset.length).toBeGreaterThanOrEqual(24);
    expect(pwReset).not.toBe(pwCreate);
    expect(reset.text.split(pwReset).length - 1).toBe(1);

    const list = await api("GET", dbBase(orgA, siteA));
    expect(list.status).toBe(200);
    expect(list.text).not.toContain("temporaryPassword");
    expect(list.text).not.toContain("passwordHash");
    expect(list.text).not.toContain(pwCreate);
    expect(list.text).not.toContain(pwReset);

    const revoke = await api("DELETE", `${userBase(orgA, siteA)}/${userName}/grants/${dbName}`);
    expect(revoke.status).toBe(204);
    const delUser = await api("DELETE", `${userBase(orgA, siteA)}/${userName}`);
    expect(delUser.status).toBe(204);
    const delDb = await api("DELETE", `${dbBase(orgA, siteA)}/${dbName}`);
    expect(delDb.status).toBe(204);

    const newAudits = (await allAuditRows()).slice(beforeCount);
    expect(newAudits.map((r) => r.action)).toEqual([
      "site.database.create",
      "site.database.user.create",
      "site.database.grant",
      "site.database.user.password_reset",
      "site.database.revoke",
      "site.database.user.delete",
      "site.database.delete",
    ]);

    const needNotAppear = [
      pwCreate,
      mysqlNativePasswordHash(pwCreate),
      pwReset,
      mysqlNativePasswordHash(pwReset),
    ];

    const tableDumps = JSON.stringify([
      newAudits,
      await dbClient.db.select().from(operations),
      await dbClient.db.select().from(operationSteps),
      await dbClient.db.select().from(outboxEvents),
      await dbClient.db.select().from(stackRevisions),
      await dbClient.db.select().from(serviceInstances),
      await dbClient.db.select().from(encryptedSecrets),
      await dbClient.db.select().from(siteDatabases),
    ]);
    const joinedLogs = logs.join("\n");
    for (const secret of needNotAppear) {
      expect(joinedLogs).not.toContain(secret);
      expect(tableDumps).not.toContain(secret);
    }
    expect(`${prefix}_shop`).toBe(dbName);
  });

  it("enforces quota on concurrent creates at 9 of 10 for both databases and users", async () => {
    for (let i = 1; i <= SITE_DATABASES_MAX - 1; i += 1) {
      expect((await api("POST", dbBase(orgA, siteA), { name: `d${i}` })).status).toBe(201);
    }
    for (let i = 1; i <= SITE_DATABASE_USERS_MAX - 1; i += 1) {
      expect((await api("POST", userBase(orgA, siteA), { name: `u${i}` })).status).toBe(201);
    }

    const dbRace = await Promise.all([
      api("POST", dbBase(orgA, siteA), { name: "race1" }),
      api("POST", dbBase(orgA, siteA), { name: "race2" }),
    ]);
    expect(dbRace.map((r) => r.status).sort()).toEqual([201, 409]);
    const dbDenied = dbRace.find((r) => r.status === 409)!;
    expect(dbDenied.body.error.code).toBe("QUOTA_EXCEEDED");

    const userRace = await Promise.all([
      api("POST", userBase(orgA, siteA), { name: "urace1" }),
      api("POST", userBase(orgA, siteA), { name: "urace2" }),
    ]);
    expect(userRace.map((r) => r.status).sort()).toEqual([201, 409]);
    const userDenied = userRace.find((r) => r.status === 409)!;
    expect(userDenied.body.error.code).toBe("QUOTA_EXCEEDED");

    const finalState = await api("GET", dbBase(orgA, siteA));
    expect(finalState.status).toBe(200);
    expect(finalState.body.data.databases.filter((d: Json) => !d.primary)).toHaveLength(SITE_DATABASES_MAX);
    expect(finalState.body.data.users.filter((u: Json) => !u.primary)).toHaveLength(SITE_DATABASE_USERS_MAX);
  });

  it("maps simulator failures across routes including retryable 503 for ambiguous/engine failures and writes no success audit", async () => {
    const prefix = siteDatabasePrefix(siteA);
    const dbName = `${prefix}_errdb`;
    const userName = `${prefix}_errusr`;
    expect((await api("POST", dbBase(orgA, siteA), { name: "errdb" })).status).toBe(201);
    expect((await api("POST", userBase(orgA, siteA), { name: "errusr" })).status).toBe(201);

    const failureCases: Array<{
      execCode: ErrorCode;
      expectedStatus: number;
      expectedApiCode: string;
      expectedRetryable: boolean;
    }> = [
      { execCode: "OPERATION_AMBIGUOUS", expectedStatus: 503, expectedApiCode: "DOCKER_ENGINE_UNAVAILABLE", expectedRetryable: true },
      { execCode: "DOCKER_ENGINE_UNAVAILABLE", expectedStatus: 503, expectedApiCode: "DOCKER_ENGINE_UNAVAILABLE", expectedRetryable: true },
      { execCode: "INTERNAL_ERROR", expectedStatus: 503, expectedApiCode: "DOCKER_ENGINE_UNAVAILABLE", expectedRetryable: true },
      { execCode: "RESOURCE_LOCKED", expectedStatus: 409, expectedApiCode: "RESOURCE_LOCKED", expectedRetryable: true },
      { execCode: "ALREADY_EXISTS", expectedStatus: 409, expectedApiCode: "ALREADY_EXISTS", expectedRetryable: false },
      { execCode: "QUOTA_EXCEEDED", expectedStatus: 409, expectedApiCode: "QUOTA_EXCEEDED", expectedRetryable: false },
      { execCode: "NOT_FOUND", expectedStatus: 404, expectedApiCode: "NOT_FOUND", expectedRetryable: false },
      { execCode: "VALIDATION_ERROR", expectedStatus: 400, expectedApiCode: "VALIDATION_ERROR", expectedRetryable: false },
    ];

    const routeCalls: Array<[string, string, unknown?]> = [
      ["GET", dbBase(orgA, siteA)],
      ["POST", dbBase(orgA, siteA), { name: "f1" }],
      ["DELETE", `${dbBase(orgA, siteA)}/${dbName}`],
      ["POST", userBase(orgA, siteA), { name: "fu1" }],
      ["DELETE", `${userBase(orgA, siteA)}/${userName}`],
      ["POST", `${userBase(orgA, siteA)}/${userName}/reset-password`],
      ["PUT", `${userBase(orgA, siteA)}/${userName}/grants/${dbName}`],
      ["DELETE", `${userBase(orgA, siteA)}/${userName}/grants/${dbName}`],
    ];

    const auditsBefore = (await allAuditRows()).length;
    for (const [method, path, body] of routeCalls) {
      for (const c of failureCases) {
        sim.databases.failNext(c.execCode);
        const res = await api(method, path, body);
        expect(res.status).toBe(c.expectedStatus);
        expect(res.body.error.code).toBe(c.expectedApiCode);
        expect(res.body.error.retryable).toBe(c.expectedRetryable);
      }
    }

    sim.setEngineReachable(false);
    for (const [method, path, body] of routeCalls) {
      const res = await api(method, path, body);
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("DOCKER_ENGINE_UNAVAILABLE");
      expect(res.body.error.retryable).toBe(true);
    }
    sim.setEngineReachable(true);

    expect((await allAuditRows()).length).toBe(auditsBefore);
  });

  it("refuses suspended organization on every route with 403 ORGANIZATION_SUSPENDED and zero executor calls", async () => {
    const prefix = siteDatabasePrefix(siteA);
    const dbName = `${prefix}_sdb`;
    const userName = `${prefix}_susr`;
    expect((await api("POST", dbBase(orgA, siteA), { name: "sdb" })).status).toBe(201);
    expect((await api("POST", userBase(orgA, siteA), { name: "susr" })).status).toBe(201);
    await dbClient.db.update(organizations).set({ status: "suspended" }).where(eq(organizations.id, orgA));
    execSpy.mockClear();

    const routes: Array<[string, string, unknown?]> = [
      ["GET", dbBase(orgA, siteA)],
      ["GET", `${dbBase(orgA, siteA)}/phpmyadmin`],
      ["POST", `${dbBase(orgA, siteA)}/phpmyadmin`, {}],
      ["POST", dbBase(orgA, siteA), { name: "nope" }],
      ["DELETE", `${dbBase(orgA, siteA)}/${dbName}`],
      ["POST", userBase(orgA, siteA), { name: "nope" }],
      ["DELETE", `${userBase(orgA, siteA)}/${userName}`],
      ["POST", `${userBase(orgA, siteA)}/${userName}/reset-password`],
      ["PUT", `${userBase(orgA, siteA)}/${userName}/grants/${dbName}`],
      ["DELETE", `${userBase(orgA, siteA)}/${userName}/grants/${dbName}`],
    ];

    for (const [method, path, body] of routes) {
      const res = await api(method, path, body);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("ORGANIZATION_SUSPENDED");
    }
    expect(execSpy).not.toHaveBeenCalled();
  });
});
