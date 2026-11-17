import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  type ErrorCode,
  MYSQL_NATIVE_PASSWORD_HASH_PATTERN,
  PRESET_ROLE_PERMISSIONS,
  SITE_DATABASES_MAX,
  SITE_DATABASE_USERS_MAX,
  SiteDatabaseCreatedDtoSchema,
  SiteDatabasePasswordResetDtoSchema,
  SiteDatabaseSignOnDtoSchema,
  SiteDatabaseUserCreatedDtoSchema,
  SiteDatabasesDtoSchema,
  isSiteDatabaseName,
  mysqlNativePasswordHash,
  siteDatabasePrefix,
  siteDatabaseSignOnUser,
} from "@hosting-panel/contracts";
import {
  and,
  auditEvents,
  createDatabaseClient,
  ensurePresetRolesAndPermissions,
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
  resolveDecryptedSecretRefs,
  rolePermissions,
  sites,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import {
  ExecutorCodedError,
  InMemoryDockerSimulatorAdapter,
} from "@hosting-panel/docker-executor";
import type {
  DockerExecutorPort,
  SiteDatabasesRequest,
  SiteDatabasesResult,
  SiteJobRequest,
} from "@hosting-panel/executor-contracts";
import { InMemoryHostSimulatorAdapter } from "@hosting-panel/host-agent";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../src/auth/password.js";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";

const KEY = Buffer.alloc(32, 9);
const PW = "correct horse battery";
const SETUP = { installationName: "Test DB", hostHostname: "panel.test", hostIpv4: "10.0.0.1" };
const SITE_A1 = {
  name: "Trattoria Roma",
  domain: "trattoria.it",
  title: "Trattoria Roma",
  adminUser: "admin",
  adminEmail: "admin@trattoria.it",
  adminPassword: "canary-Pass-123456",
};
const SITE_A2 = {
  name: "Pizzeria Napoli",
  domain: "pizzeria.it",
  title: "Pizzeria Napoli",
  adminUser: "admin",
  adminEmail: "admin@pizzeria.it",
  adminPassword: "canary-Pass-123456",
};
const SITE_B = {
  name: "Caffe Milano",
  domain: "caffemilano.it",
  title: "Caffe Milano",
  adminUser: "admin",
  adminEmail: "admin@caffemilano.it",
  adminPassword: "canary-Pass-123456",
};

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

interface HttpResult {
  readonly status: number;
  readonly body: Json;
  readonly raw: string;
}

interface FakeSiteDbState {
  readonly databases: Map<string, { primary: boolean; sizeBytes: number }>;
  readonly users: Map<string, { primary: boolean; passwordHash: string; grants: Set<string> }>;
  signOn: { username: string; passwordHash: string } | null;
}

class FakeDatabasesDockerExecutor implements DockerExecutorPort {
  public readonly sim: InMemoryDockerSimulatorAdapter;
  public readonly sites = new Map<string, FakeSiteDbState>();
  public readonly dbCalls: SiteDatabasesRequest[] = [];
  public readonly jobs: SiteJobRequest[] = [];
  public failDropAllWithNotSupportedForSite = new Set<string>();
  public failNextDropAllForSite = new Map<string, ErrorCode>();
  public failNextListForSite = new Map<string, ErrorCode>();
  public failNextSetUserPasswordForSite = new Map<string, ErrorCode>();
  /** One-shot exit code of a site job, by "siteId kind". */
  public nextJobExit = new Map<string, number>();

  public constructor() {
    this.sim = new InMemoryDockerSimulatorAdapter();
  }

  public get isRuntimeAvailable(): boolean {
    return this.sim.isRuntimeAvailable;
  }

  public deployService: DockerExecutorPort["deployService"] = (spec) => this.sim.deployService(spec);
  public restartService: DockerExecutorPort["restartService"] = (id) => this.sim.restartService(id);
  public stopService: DockerExecutorPort["stopService"] = (id) => this.sim.stopService(id);
  public deleteService: DockerExecutorPort["deleteService"] = (id) => this.sim.deleteService(id);
  public getObservedState: DockerExecutorPort["getObservedState"] = (id) =>
    this.sim.getObservedState(id);
  public purgeSite: DockerExecutorPort["purgeSite"] = (siteId) => this.sim.purgeSite(siteId);
  public getServiceLogs: DockerExecutorPort["getServiceLogs"] = (id, tail) =>
    this.sim.getServiceLogs(id, tail);
  public applySiteRoutes: DockerExecutorPort["applySiteRoutes"] = (req) =>
    this.sim.applySiteRoutes(req);
  public getCertificateStatus: DockerExecutorPort["getCertificateStatus"] = (req) =>
    this.sim.getCertificateStatus(req);
  public applyMailRelay: DockerExecutorPort["applyMailRelay"] = (req) =>
    this.sim.applyMailRelay(req);
  public getMailRelayStatus: DockerExecutorPort["getMailRelayStatus"] = (req) =>
    this.sim.getMailRelayStatus(req);
  public sendTestMail: DockerExecutorPort["sendTestMail"] = (req) => this.sim.sendTestMail(req);
  public sendPanelMail: DockerExecutorPort["sendPanelMail"] = (req) => this.sim.sendPanelMail(req);
  public getPanelContainers: DockerExecutorPort["getPanelContainers"] = () => this.sim.getPanelContainers();
  public getPanelContainerLogs: DockerExecutorPort["getPanelContainerLogs"] = (req) => this.sim.getPanelContainerLogs(req);
  public openTerminal: DockerExecutorPort["openTerminal"] = (req) => this.sim.openTerminal(req);
  public writeTerminal: DockerExecutorPort["writeTerminal"] = (req) => this.sim.writeTerminal(req);
  public readTerminal: DockerExecutorPort["readTerminal"] = (req) => this.sim.readTerminal(req);
  public closeTerminal: DockerExecutorPort["closeTerminal"] = (req) => this.sim.closeTerminal(req);
  public listTerminals: DockerExecutorPort["listTerminals"] = () => this.sim.listTerminals();
  public restartPanelContainer: DockerExecutorPort["restartPanelContainer"] = (req) => this.sim.restartPanelContainer(req);
  public applyPanelContainerPin: DockerExecutorPort["applyPanelContainerPin"] = (c) => this.sim.applyPanelContainerPin(c);
  public siteFiles: DockerExecutorPort["siteFiles"] = (req) => this.sim.siteFiles(req);
  public applySftpAccess: DockerExecutorPort["applySftpAccess"] = (req) =>
    this.sim.applySftpAccess(req);
  public getSftpStatus: DockerExecutorPort["getSftpStatus"] = () => this.sim.getSftpStatus();
  public backups: DockerExecutorPort["backups"] = (req) => this.sim.backups(req);

  public async runSiteJob(req: SiteJobRequest) {
    this.jobs.push(req);
    const forced = this.nextJobExit.get(`${req.siteId} ${req.kind}`);
    if (forced !== undefined) {
      this.nextJobExit.delete(`${req.siteId} ${req.kind}`);
      return { jobId: req.jobId, exitCode: forced, outputTail: "" };
    }
    const res = await this.sim.runSiteJob(req);
    if (res.exitCode === 0 && req.kind === "db.provision") {
      this.seedPrimary(req.siteId);
    } else if (res.exitCode === 0 && req.kind === "db.drop") {
      const state = this.sites.get(req.siteId);
      const primary = siteDatabasePrefix(req.siteId);
      state?.databases.delete(primary);
      state?.users.delete(primary);
    }
    return res;
  }

  public seedPrimary(siteId: string): void {
    const state = this.#ensureSite(siteId);
    const primary = siteDatabasePrefix(siteId);
    state.databases.set(primary, { primary: true, sizeBytes: 16_384 });
    state.users.set(primary, {
      primary: true,
      passwordHash: `*${"A".repeat(40)}`,
      grants: new Set([primary]),
    });
  }

  public resetCustomForSite(siteId: string): void {
    this.sites.delete(siteId);
    this.seedPrimary(siteId);
  }

  public verifyUserPassword(siteId: string, user: string, password: string): boolean {
    const entry = this.sites.get(siteId)?.users.get(user);
    return entry !== undefined && entry.passwordHash === mysqlNativePasswordHash(password);
  }

  public async siteDatabases<R extends SiteDatabasesRequest>(
    req: R,
  ): Promise<SiteDatabasesResult<R["op"]>> {
    this.dbCalls.push(req);
    const prefix = siteDatabasePrefix(req.siteId);

    switch (req.op) {
      case "list": {
        const failListCode = this.failNextListForSite.get(req.siteId);
        if (failListCode !== undefined) {
          this.failNextListForSite.delete(req.siteId);
          throw new ExecutorCodedError("List failed", failListCode);
        }
        const state = this.#ensureSite(req.siteId);
        const databases = [...state.databases.entries()].map(([name, info]) => ({
          name,
          primary: info.primary,
          sizeBytes: info.sizeBytes,
        }));
        const usersList = [...state.users.entries()].map(([name, info]) => ({
          name,
          primary: info.primary,
          databases: [...info.grants],
        }));
        return { databases, users: usersList } as SiteDatabasesResult<R["op"]>;
      }
      case "createDatabase": {
        this.#assertOwned(prefix, req.database);
        const state = this.#ensureSite(req.siteId);
        if (state.databases.has(req.database)) {
          throw new ExecutorCodedError("Database already exists", "ALREADY_EXISTS");
        }
        const customCount = [...state.databases.values()].filter((d) => !d.primary).length;
        if (customCount >= SITE_DATABASES_MAX) {
          throw new ExecutorCodedError("Database limit reached", "QUOTA_EXCEEDED");
        }
        state.databases.set(req.database, { primary: false, sizeBytes: 0 });
        return {} as SiteDatabasesResult<R["op"]>;
      }
      case "deleteDatabase": {
        this.#assertOwned(prefix, req.database);
        const state = this.#ensureSite(req.siteId);
        if (!state.databases.has(req.database)) {
          throw new ExecutorCodedError("Database not found", "NOT_FOUND");
        }
        state.databases.delete(req.database);
        for (const u of state.users.values()) {
          u.grants.delete(req.database);
        }
        return {} as SiteDatabasesResult<R["op"]>;
      }
      case "createUser": {
        this.#assertOwned(prefix, req.user);
        const state = this.#ensureSite(req.siteId);
        if (state.users.has(req.user)) {
          throw new ExecutorCodedError("User already exists", "ALREADY_EXISTS");
        }
        const customCount = [...state.users.values()].filter((u) => !u.primary).length;
        if (customCount >= SITE_DATABASE_USERS_MAX) {
          throw new ExecutorCodedError("User limit reached", "QUOTA_EXCEEDED");
        }
        state.users.set(req.user, {
          primary: false,
          passwordHash: req.passwordHash,
          grants: new Set(),
        });
        return {} as SiteDatabasesResult<R["op"]>;
      }
      case "setUserPassword": {
        const failPwCode = this.failNextSetUserPasswordForSite.get(req.siteId);
        if (failPwCode !== undefined) {
          this.failNextSetUserPasswordForSite.delete(req.siteId);
          throw new ExecutorCodedError("Password update failed", failPwCode);
        }
        this.#assertOwned(prefix, req.user);
        const state = this.#ensureSite(req.siteId);
        const user = state.users.get(req.user);
        if (!user) {
          throw new ExecutorCodedError("User not found", "NOT_FOUND");
        }
        user.passwordHash = req.passwordHash;
        return {} as SiteDatabasesResult<R["op"]>;
      }
      case "deleteUser": {
        this.#assertOwned(prefix, req.user);
        const state = this.#ensureSite(req.siteId);
        if (!state.users.delete(req.user)) {
          throw new ExecutorCodedError("User not found", "NOT_FOUND");
        }
        return {} as SiteDatabasesResult<R["op"]>;
      }
      case "grant": {
        this.#assertOwned(prefix, req.user);
        this.#assertOwned(prefix, req.database);
        const state = this.#ensureSite(req.siteId);
        const user = state.users.get(req.user);
        if (!user || !state.databases.has(req.database)) {
          throw new ExecutorCodedError("User or database not found", "NOT_FOUND");
        }
        user.grants.add(req.database);
        return {} as SiteDatabasesResult<R["op"]>;
      }
      case "revoke": {
        this.#assertOwned(prefix, req.user);
        this.#assertOwned(prefix, req.database);
        const state = this.#ensureSite(req.siteId);
        const user = state.users.get(req.user);
        if (!user) {
          throw new ExecutorCodedError("User not found", "NOT_FOUND");
        }
        user.grants.delete(req.database);
        return {} as SiteDatabasesResult<R["op"]>;
      }
      case "phpMyAdminSignOn": {
        const state = this.#ensureSite(req.siteId);
        const username = siteDatabaseSignOnUser(req.siteId);
        state.signOn = { username, passwordHash: req.passwordHash };
        return { username } as SiteDatabasesResult<R["op"]>;
      }
      case "dropAll": {
        if (this.failDropAllWithNotSupportedForSite.has(req.siteId)) {
          throw new ExecutorCodedError("Not supported", "NOT_SUPPORTED");
        }
        const failDropCode = this.failNextDropAllForSite.get(req.siteId);
        if (failDropCode !== undefined) {
          this.failNextDropAllForSite.delete(req.siteId);
          throw new ExecutorCodedError("Database server unavailable", failDropCode);
        }
        this.sites.delete(req.siteId);
        return {} as SiteDatabasesResult<R["op"]>;
      }
    }
  }

  #ensureSite(siteId: string): FakeSiteDbState {
    let state = this.sites.get(siteId);
    if (!state) {
      state = { databases: new Map(), users: new Map(), signOn: null };
      this.sites.set(siteId, state);
    }
    return state;
  }

  #assertOwned(prefix: string, name: string): void {
    if (!isSiteDatabaseName(prefix, name)) {
      throw new ExecutorCodedError("Name outside site prefix", "NOT_FOUND");
    }
  }
}

function assertNoHashOrForbiddenKey(value: unknown, rawText: string): void {
  expect(rawText).not.toMatch(/\*[0-9A-F]{40}/);
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        expect(k).not.toBe("passwordHash");
        expect(k).not.toBe("password_hash");
        expect(k).not.toBe("password");
        walk(v);
      }
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
  return { status: res.status, body: parsed, raw };
}

describe("site databases HTTP API integration (linux-systemd)", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let fakeExec: FakeDatabasesDockerExecutor;
  let hostSim: InMemoryHostSimulatorAdapter;

  let orgAId: string;
  let orgBId: string;
  let siteA1Id: string;
  let siteA2Id: string;
  let siteBId: string;
  let prefixA1: string;
  let prefixA2: string;

  let ownerAToken: string;
  let ownerBToken: string;
  let adminToken: string;
  let infraMemberToken: string;
  let collabToken: string;
  let baselineAuditIds: Set<string>;

  const dbBase = (orgId: string, siteId: string, tail = "") =>
    `/v1/organizations/${orgId}/managed-sites/${siteId}${tail}`;

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

  function allTenRouteSpecs(orgId: string, siteId: string) {
    const prefix = siteDatabasePrefix(siteId);
    const dbName = `${prefix}_probe`;
    const userName = `${prefix}_probe`;
    return [
      { method: "GET", path: dbBase(orgId, siteId, "/databases"), body: undefined },
      { method: "POST", path: dbBase(orgId, siteId, "/databases"), body: { name: "probe" } },
      { method: "DELETE", path: dbBase(orgId, siteId, `/databases/${dbName}`), body: undefined },
      { method: "POST", path: dbBase(orgId, siteId, "/database-users"), body: { name: "probe" } },
      {
        method: "POST",
        path: dbBase(orgId, siteId, `/database-users/${userName}/reset-password`),
        body: undefined,
      },
      {
        method: "DELETE",
        path: dbBase(orgId, siteId, `/database-users/${userName}`),
        body: undefined,
      },
      {
        method: "PUT",
        path: dbBase(orgId, siteId, `/database-users/${userName}/grants/${dbName}`),
        body: undefined,
      },
      {
        method: "DELETE",
        path: dbBase(orgId, siteId, `/database-users/${userName}/grants/${dbName}`),
        body: undefined,
      },
      { method: "POST", path: dbBase(orgId, siteId, "/databases/phpmyadmin"), body: undefined },
      { method: "GET", path: dbBase(orgId, siteId, "/databases/phpmyadmin"), body: undefined },
    ] as const;
  }

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, {
      email: "admin-db@x.it",
      name: "Admin",
      password: PW,
    });

    fakeExec = new FakeDatabasesDockerExecutor();
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
      dockerExecutor: fakeExec,
      hostAgent: hostSim,
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
      domainReconcileIntervalMs: null,
      mailRelayRetryIntervalMs: null,
      sftpRetryIntervalMs: null,
      recoverUnknownOnStart: false,
    });

    adminToken = await loginUser(app.baseUrl!, "admin-db@x.it", PW, admin.totpSecretBase32);

    const createdA = await call(
      "POST",
      "/v1/admin/customer-account",
      { organizationName: "Trattoria Org", ownerEmail: "mario-db@trattoria.it", ownerName: "Mario" },
      adminToken,
    );
    expect(createdA.status).toBe(201);
    orgAId = createdA.body.data.organizationId as string;
    ownerAToken = await loginUser(
      app.baseUrl!,
      "mario-db@trattoria.it",
      createdA.body.data.temporaryPassword as string,
    );

    const [inst] = await dbClient.db.select().from(platformInstallations).limit(1);
    const hostBId = `hst_${randomUUID()}`;
    await dbClient.db.insert(hosts).values({
      id: hostBId,
      platformInstallationId: inst!.id,
      name: "panel-b-db.test",
      hostname: "panel-b-db.test",
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
      name: "Caffe Milano Org",
      slug: "caffe-milano-db-org",
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
      email: "luigi-db@caffemilano.it",
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
    ownerBToken = await loginUser(app.baseUrl!, "luigi-db@caffemilano.it", PW);

    const collabId = `usr_${randomUUID()}`;
    const collabMemId = `mem_${randomUUID()}`;
    await dbClient.db.insert(users).values({
      id: collabId,
      email: "collab-db@trattoria.it",
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
    collabToken = await loginUser(app.baseUrl!, "collab-db@trattoria.it", PW);

    const infraMemAdmin = await createServerAdmin(dbClient.db, KEY, {
      email: "infra-member-db@trattoria.it",
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
      "infra-member-db@trattoria.it",
      PW,
      infraMemAdmin.totpSecretBase32,
    );

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
    prefixA1 = siteDatabasePrefix(siteA1Id);
    prefixA2 = siteDatabasePrefix(siteA2Id);
  });

  afterAll(async () => {
    await app.close();
    await dbClient.close();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await dbClient.db
      .update(organizations)
      .set({ status: "active" })
      .where(eq(organizations.id, orgAId));
    await dbClient.db.update(sites).set({ status: "ready" }).where(eq(sites.id, siteA1Id));
    await dbClient.db.update(sites).set({ status: "ready" }).where(eq(sites.id, siteA2Id));
    fakeExec.resetCustomForSite(siteA1Id);
    fakeExec.resetCustomForSite(siteA2Id);
    fakeExec.resetCustomForSite(siteBId);
    fakeExec.dbCalls.length = 0;
    fakeExec.failDropAllWithNotSupportedForSite.clear();
    fakeExec.failNextDropAllForSite.clear();
    fakeExec.failNextListForSite.clear();
    fakeExec.failNextSetUserPasswordForSite.clear();
    await snapshotAudits();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exercises all 10 routes end-to-end with schema validation, hash-only executor IPC, zero secret leaks, and names-only audits", async () => {
    const execSpy = vi.spyOn(fakeExec, "siteDatabases");
    const generatedPasswords: string[] = [];

    // 1. GET /databases (no audit)
    const initialList = await call("GET", dbBase(orgAId, siteA1Id, "/databases"));
    expect(initialList.status).toBe(200);
    expect(SiteDatabasesDtoSchema.parse(initialList.body.data)).toEqual({
      prefix: prefixA1,
      databases: [{ name: prefixA1, primary: true, sizeBytes: 16_384 }],
      users: [{ name: prefixA1, primary: true, databases: [prefixA1] }],
      limits: { databases: SITE_DATABASES_MAX, users: SITE_DATABASE_USERS_MAX },
      phpMyAdminAvailable: true,
    });

    // 2. POST /databases (trims & lowercases suffix)
    const createdDb = await call("POST", dbBase(orgAId, siteA1Id, "/databases"), {
      name: " Shop ",
    });
    expect(createdDb.status).toBe(201);
    const dbName = `${prefixA1}_shop`;
    expect(SiteDatabaseCreatedDtoSchema.parse(createdDb.body.data)).toEqual({
      database: { name: dbName, primary: false, sizeBytes: 0 },
    });

    // 3. POST /database-users (24-char temporaryPassword returned once; hash sent to executor)
    const createdUser = await call("POST", dbBase(orgAId, siteA1Id, "/database-users"), {
      name: "App1",
    });
    expect(createdUser.status).toBe(201);
    const userDto = SiteDatabaseUserCreatedDtoSchema.parse(createdUser.body.data);
    const userName = `${prefixA1}_app1`;
    expect(userDto.user).toEqual({ name: userName, primary: false, databases: [] });
    expect(userDto.temporaryPassword).toMatch(/^[A-Za-z0-9]{24}$/);
    generatedPasswords.push(userDto.temporaryPassword);

    const createCall = execSpy.mock.calls.find((c) => c[0].op === "createUser")?.[0];
    expect(createCall).toBeDefined();
    if (createCall && "passwordHash" in createCall) {
      expect(createCall.passwordHash).toMatch(MYSQL_NATIVE_PASSWORD_HASH_PATTERN);
      expect(createCall.passwordHash).toBe(mysqlNativePasswordHash(userDto.temporaryPassword));
      expect(createCall.passwordHash).not.toBe(userDto.temporaryPassword);
    }

    // 4. PUT /database-users/:name/grants/:database (custom db and primary db)
    const grantCustom = await call(
      "PUT",
      dbBase(orgAId, siteA1Id, `/database-users/${userName}/grants/${dbName}`),
    );
    expect(grantCustom.status).toBe(204);
    expect(grantCustom.raw).toBe("");

    const grantPrimary = await call(
      "PUT",
      dbBase(orgAId, siteA1Id, `/database-users/${userName}/grants/${prefixA1}`),
    );
    expect(grantPrimary.status).toBe(204);

    // 5. POST /database-users/:name/reset-password
    const resetRes = await call(
      "POST",
      dbBase(orgAId, siteA1Id, `/database-users/${userName}/reset-password`),
    );
    expect(resetRes.status).toBe(200);
    const resetDto = SiteDatabasePasswordResetDtoSchema.parse(resetRes.body.data);
    expect(resetDto.temporaryPassword).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(resetDto.temporaryPassword).not.toBe(userDto.temporaryPassword);
    generatedPasswords.push(resetDto.temporaryPassword);

    const resetCall = execSpy.mock.calls.find((c) => c[0].op === "setUserPassword")?.[0];
    expect(resetCall).toBeDefined();
    if (resetCall && "passwordHash" in resetCall) {
      expect(resetCall.passwordHash).toMatch(MYSQL_NATIVE_PASSWORD_HASH_PATTERN);
      expect(resetCall.passwordHash).toBe(mysqlNativePasswordHash(resetDto.temporaryPassword));
    }

    // 6. GET /databases shows sorted entries and grants, zero secrets
    const midList = await call("GET", dbBase(orgAId, siteA1Id, "/databases"));
    expect(midList.status).toBe(200);
    const midDto = SiteDatabasesDtoSchema.parse(midList.body.data);
    expect(midDto.databases.map((d) => d.name)).toEqual([prefixA1, dbName]);
    expect(midDto.users).toEqual([
      { name: prefixA1, primary: true, databases: [prefixA1] },
      { name: userName, primary: false, databases: [prefixA1, dbName] },
    ]);

    // 7. POST /databases/phpmyadmin & GET /databases/phpmyadmin (GET writes NO audit row)
    const pmaPost = await call("POST", dbBase(orgAId, siteA1Id, "/databases/phpmyadmin"));
    expect(pmaPost.status).toBe(200);
    const pmaDto = SiteDatabaseSignOnDtoSchema.parse(pmaPost.body.data);
    expect(pmaDto.username).toBe(siteDatabaseSignOnUser(siteA1Id));
    expect(pmaDto.temporaryPassword).toMatch(/^[A-Za-z0-9]{24}$/);
    generatedPasswords.push(pmaDto.temporaryPassword);

    const pmaCall = execSpy.mock.calls.find((c) => c[0].op === "phpMyAdminSignOn")?.[0];
    expect(pmaCall).toBeDefined();
    if (pmaCall && "passwordHash" in pmaCall) {
      expect(pmaCall.passwordHash).toMatch(MYSQL_NATIVE_PASSWORD_HASH_PATTERN);
      expect(pmaCall.passwordHash).toBe(mysqlNativePasswordHash(pmaDto.temporaryPassword));
    }

    const auditsBeforePmaGet = (await newAudits()).length;
    const execCallsBeforePmaGet = execSpy.mock.calls.length;
    const pmaGet = await call("GET", dbBase(orgAId, siteA1Id, "/databases/phpmyadmin"));
    expect(pmaGet.status).toBe(204);
    expect(pmaGet.raw).toBe("");
    expect((await newAudits()).length).toBe(auditsBeforePmaGet);
    expect(execSpy.mock.calls.length).toBe(execCallsBeforePmaGet);

    // 8. DELETE revoke, DELETE user, DELETE database
    const revokeRes = await call(
      "DELETE",
      dbBase(orgAId, siteA1Id, `/database-users/${userName}/grants/${dbName}`),
    );
    expect(revokeRes.status).toBe(204);
    expect(revokeRes.raw).toBe("");

    const delUserRes = await call(
      "DELETE",
      dbBase(orgAId, siteA1Id, `/database-users/${userName}`),
    );
    expect(delUserRes.status).toBe(204);

    const delDbRes = await call("DELETE", dbBase(orgAId, siteA1Id, `/databases/${dbName}`));
    expect(delDbRes.status).toBe(204);

    // 9. Audit rows hold names only and exact actions
    const audits = await newAudits();
    expect(audits.map((a) => ({ action: a.action, details: a.details }))).toEqual([
      { action: "site.database.create", details: expect.objectContaining({ database: dbName }) },
      { action: "site.database.user.create", details: expect.objectContaining({ user: userName }) },
      {
        action: "site.database.grant",
        details: expect.objectContaining({ user: userName, database: dbName }),
      },
      {
        action: "site.database.grant",
        details: expect.objectContaining({ user: userName, database: prefixA1 }),
      },
      {
        action: "site.database.user.password_reset",
        details: expect.objectContaining({ user: userName }),
      },
      {
        action: "site.database.phpmyadmin.open",
        details: expect.objectContaining({ username: pmaDto.username }),
      },
      {
        action: "site.database.revoke",
        details: expect.objectContaining({ user: userName, database: dbName }),
      },
      { action: "site.database.user.delete", details: expect.objectContaining({ user: userName }) },
      { action: "site.database.delete", details: expect.objectContaining({ database: dbName }) },
    ]);

    // 10. Clear passwords and hashes never appear in DB tables or list output
    const dbDump = JSON.stringify([
      await dbClient.db.select().from(auditEvents),
      await dbClient.db.select().from(outboxEvents),
      await dbClient.db.select().from(operations),
      midList.raw,
    ]);
    for (const pw of generatedPasswords) {
      expect(dbDump).not.toContain(pw);
      expect(dbDump).not.toContain(mysqlNativePasswordHash(pw));
    }
  });

  it("enforces 401 unauthenticated, 404 cross-org tenancy & non-member admin, and 403 + denied audit for collaborator & infra member with zero executor calls", async () => {
    const execSpy = vi.spyOn(fakeExec, "siteDatabases");

    for (const route of allTenRouteSpecs(orgAId, siteA1Id)) {
      const res = await httpJson(app.baseUrl!, route.method, route.path, { body: route.body });
      expect(res.status, `401 ${route.method} ${route.path}`).toBe(401);
    }

    for (const route of [
      ...allTenRouteSpecs(orgAId, siteA1Id),
      ...allTenRouteSpecs(orgBId, siteA1Id),
    ]) {
      const res = await call(route.method, route.path, route.body, ownerBToken);
      expect(res.status, `404 orgB on ${route.method} ${route.path}`).toBe(404);
    }
    for (const route of allTenRouteSpecs(orgBId, siteBId)) {
      const res = await call(route.method, route.path, route.body, ownerAToken);
      expect(res.status, `404 orgA on ${route.method} ${route.path}`).toBe(404);
    }

    for (const route of allTenRouteSpecs(orgAId, siteA1Id)) {
      const res = await call(route.method, route.path, route.body, adminToken);
      expect(res.status, `404 non-member admin ${route.method} ${route.path}`).toBe(404);
    }

    for (const [label, tok] of [
      ["customer_collaborator", collabToken],
      ["infrastructure_admin", infraMemberToken],
    ] as const) {
      for (const route of allTenRouteSpecs(orgAId, siteA1Id)) {
        const beforeCount = (await newAudits()).length;
        const res = await call(route.method, route.path, route.body, tok);
        expect(res.status, `403 ${label} ${route.method} ${route.path}`).toBe(403);
        expect(res.body.error.code).toBe("PERMISSION_DENIED");
        const auditsNow = await newAudits();
        expect(auditsNow).toHaveLength(beforeCount + 1);
        const deniedRow = auditsNow.at(-1)!;
        expect(deniedRow.action).toBe("site.databases.manage");
        expect(deniedRow.targetType).toBe("site");
        expect(deniedRow.targetId).toBe(siteA1Id);
        expect((deniedRow.details as Json)["outcome"]).toBe("denied");
      }
    }

    expect(execSpy).not.toHaveBeenCalled();
  });

  it("blocks all 10 routes when organization is suspended with 403 ORGANIZATION_SUSPENDED and zero executor calls", async () => {
    const execSpy = vi.spyOn(fakeExec, "siteDatabases");
    await dbClient.db
      .update(organizations)
      .set({ status: "suspended" })
      .where(eq(organizations.id, orgAId));

    for (const route of allTenRouteSpecs(orgAId, siteA1Id)) {
      const res = await call(route.method, route.path, route.body, ownerAToken);
      expect(res.status, `suspended ${route.method} ${route.path}`).toBe(403);
      expect(res.body.error.code).toBe("ORGANIZATION_SUSPENDED");
    }

    expect(execSpy).not.toHaveBeenCalled();
  });

  it("locks create/reset/grant/phpMyAdmin in deploying and maintenance with 409 RESOURCE_LOCKED (not_ready) while keeping GET /databases, deletes, and revoke allowed", async () => {
    await call("POST", dbBase(orgAId, siteA1Id, "/databases"), { name: "keepdb" });
    await call("POST", dbBase(orgAId, siteA1Id, "/database-users"), { name: "keepusr" });
    const dbName = `${prefixA1}_keepdb`;
    const userName = `${prefixA1}_keepusr`;
    await call("PUT", dbBase(orgAId, siteA1Id, `/database-users/${userName}/grants/${dbName}`));

    const execSpy = vi.spyOn(fakeExec, "siteDatabases");
    await snapshotAudits();

    for (const status of ["deploying", "maintenance"] as const) {
      await dbClient.db.update(sites).set({ status }).where(eq(sites.id, siteA1Id));

      const lockedCalls = [
        call("POST", dbBase(orgAId, siteA1Id, "/databases"), { name: "blocked" }),
        call("POST", dbBase(orgAId, siteA1Id, "/database-users"), { name: "blocked" }),
        call(
          "POST",
          dbBase(orgAId, siteA1Id, `/database-users/${userName}/reset-password`),
        ),
        call(
          "PUT",
          dbBase(orgAId, siteA1Id, `/database-users/${userName}/grants/${dbName}`),
        ),
        call("POST", dbBase(orgAId, siteA1Id, "/databases/phpmyadmin")),
        call("GET", dbBase(orgAId, siteA1Id, "/databases/phpmyadmin")),
      ];

      for (const res of await Promise.all(lockedCalls)) {
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe("RESOURCE_LOCKED");
        expect(res.body.error.details[0]?.reason).toBe("not_ready");
      }

      const listWhileBusy = await call("GET", dbBase(orgAId, siteA1Id, "/databases"));
      expect(listWhileBusy.status).toBe(200);
    }

    expect(execSpy.mock.calls.every((c) => c[0].op === "list")).toBe(true);
    expect(await newAudits()).toEqual([]);

    // Delete & revoke stay allowed in maintenance
    const revokeRes = await call(
      "DELETE",
      dbBase(orgAId, siteA1Id, `/database-users/${userName}/grants/${dbName}`),
    );
    expect(revokeRes.status).toBe(204);
    const delUserRes = await call(
      "DELETE",
      dbBase(orgAId, siteA1Id, `/database-users/${userName}`),
    );
    expect(delUserRes.status).toBe(204);
    const delDbRes = await call("DELETE", dbBase(orgAId, siteA1Id, `/databases/${dbName}`));
    expect(delDbRes.status).toBe(204);
  });

  it("refuses mutations on the site's own database and user with 400 VALIDATION_ERROR reason=protected, and refuses pma_..., foreign names, and DELETE /databases/phpmyadmin with 404 before executor", async () => {
    await call("POST", dbBase(orgAId, siteA1Id, "/databases"), { name: "extra" });
    const customDb = `${prefixA1}_extra`;
    const execSpy = vi.spyOn(fakeExec, "siteDatabases");

    const protectedCalls = [
      call("DELETE", dbBase(orgAId, siteA1Id, `/databases/${prefixA1}`)),
      call("DELETE", dbBase(orgAId, siteA1Id, `/database-users/${prefixA1}`)),
      call("POST", dbBase(orgAId, siteA1Id, `/database-users/${prefixA1}/reset-password`)),
      call("PUT", dbBase(orgAId, siteA1Id, `/database-users/${prefixA1}/grants/${customDb}`)),
      call("DELETE", dbBase(orgAId, siteA1Id, `/database-users/${prefixA1}/grants/${customDb}`)),
    ];
    for (const res of await Promise.all(protectedCalls)) {
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(res.body.error.details[0]?.reason).toBe("protected");
    }

    const pmaUser = siteDatabaseSignOnUser(siteA1Id);
    const foreignDb = `${prefixA2}_shop`;
    const notFoundCalls = [
      call("DELETE", dbBase(orgAId, siteA1Id, "/databases/phpmyadmin")),
      call("DELETE", dbBase(orgAId, siteA1Id, `/databases/${pmaUser}`)),
      call("DELETE", dbBase(orgAId, siteA1Id, `/databases/${foreignDb}`)),
      call("DELETE", dbBase(orgAId, siteA1Id, `/databases/${prefixA1}_a;drop`)),
      call("DELETE", dbBase(orgAId, siteA1Id, `/database-users/${pmaUser}`)),
      call("DELETE", dbBase(orgAId, siteA1Id, `/database-users/${foreignDb}`)),
      call("POST", dbBase(orgAId, siteA1Id, `/database-users/${pmaUser}/reset-password`)),
      call("PUT", dbBase(orgAId, siteA1Id, `/database-users/${pmaUser}/grants/${customDb}`)),
      call("DELETE", dbBase(orgAId, siteA1Id, `/database-users/${pmaUser}/grants/${foreignDb}`)),
    ];
    for (const res of await Promise.all(notFoundCalls)) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    }

    const badBodies = [
      call("POST", dbBase(orgAId, siteA1Id, "/databases"), { name: "a;drop" }),
      call("POST", dbBase(orgAId, siteA1Id, "/databases"), { name: "shop", extra: 1 }),
      call("POST", dbBase(orgAId, siteA1Id, "/databases"), {}),
      call("POST", dbBase(orgAId, siteA1Id, "/database-users"), { name: "_bad" }),
    ];
    for (const res of await Promise.all(badBodies)) {
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    }

    expect(execSpy).not.toHaveBeenCalled();
  });

  it("passes executor QUOTA_EXCEEDED and ALREADY_EXISTS as 409 (primary not counted toward 10) and maps unclear/unknown executor failures to retryable 503", async () => {
    for (let i = 1; i <= 10; i += 1) {
      const dbRes = await call("POST", dbBase(orgAId, siteA1Id, "/databases"), { name: `d${i}` });
      expect(dbRes.status).toBe(201);
      const usrRes = await call("POST", dbBase(orgAId, siteA1Id, "/database-users"), {
        name: `u${i}`,
      });
      expect(usrRes.status).toBe(201);
    }

    await snapshotAudits();

    const dbDup = await call("POST", dbBase(orgAId, siteA1Id, "/databases"), { name: "d1" });
    expect(dbDup.status).toBe(409);
    expect(dbDup.body.error.code).toBe("ALREADY_EXISTS");

    const dbQuota = await call("POST", dbBase(orgAId, siteA1Id, "/databases"), { name: "d11" });
    expect(dbQuota.status).toBe(409);
    expect(dbQuota.body.error.code).toBe("QUOTA_EXCEEDED");

    const usrDup = await call("POST", dbBase(orgAId, siteA1Id, "/database-users"), { name: "u1" });
    expect(usrDup.status).toBe(409);
    expect(usrDup.body.error.code).toBe("ALREADY_EXISTS");

    const usrQuota = await call("POST", dbBase(orgAId, siteA1Id, "/database-users"), {
      name: "u11",
    });
    expect(usrQuota.status).toBe(409);
    expect(usrQuota.body.error.code).toBe("QUOTA_EXCEEDED");

    const execSpy = vi.spyOn(fakeExec, "siteDatabases");
    execSpy.mockRejectedValueOnce(
      Object.assign(new Error("Dropped socket *0123456789ABCDEF0123456789ABCDEF01234567"), {
        code: "OPERATION_AMBIGUOUS",
        ambiguousOutcome: true,
      }),
    );
    const ambigRes = await call("DELETE", dbBase(orgAId, siteA1Id, `/databases/${prefixA1}_d1`));
    expect(ambigRes.status).toBe(503);
    expect(ambigRes.body.error.code).toBe("DOCKER_ENGINE_UNAVAILABLE");
    expect(ambigRes.body.error.retryable).toBe(true);
    expect(ambigRes.raw).not.toContain("0123456789ABCDEF");

    expect(await newAudits()).toEqual([]);
  });

  it("site deletion calls dropAll once, and a NOT_SUPPORTED from dropAll does not fail deletion", async () => {
    const createSite = async (slugSuffix: string) => {
      const res = await call(
        "POST",
        `/v1/organizations/${orgAId}/managed-sites`,
        {
          name: `Temp ${slugSuffix}`,
          domain: `temp-${slugSuffix}.it`,
          title: `Temp ${slugSuffix}`,
          adminUser: "admin",
          adminEmail: `admin@${slugSuffix}.it`,
          adminPassword: "canary-Pass-123456",
        },
        ownerAToken,
        { "Idempotency-Key": randomUUID() },
      );
      expect(res.status).toBe(202);
      await app.outboxWorker.processPendingOnce();
      return res.body.data.siteId as string;
    };

    const disp1 = await createSite(randomUUID().slice(0, 6));
    const disp1Db = await call("POST", dbBase(orgAId, disp1, "/databases"), { name: "shop" });
    expect(disp1Db.status).toBe(201);
    expect(fakeExec.sites.has(disp1)).toBe(true);

    fakeExec.dbCalls.length = 0;
    const del1 = await call(
      "DELETE",
      `/v1/organizations/${orgAId}/managed-sites/${disp1}`,
      { confirmName: (await call("GET", `/v1/organizations/${orgAId}/managed-sites/${disp1}`)).body.data.name },
      ownerAToken,
      { "Idempotency-Key": randomUUID() },
    );
    expect(del1.status).toBe(202);
    await app.outboxWorker.processPendingOnce();

    const op1 = await call("GET", `/v1/organizations/${orgAId}/operations/${del1.body.data.operationId}`);
    expect(op1.body.data.status).toBe("succeeded");
    expect(fakeExec.dbCalls.filter((c) => c.siteId === disp1 && c.op === "dropAll")).toHaveLength(1);
    expect(fakeExec.sites.has(disp1)).toBe(false);

    // Second site: dropAll rejects with NOT_SUPPORTED -> site deletion still succeeds
    const disp2 = await createSite(randomUUID().slice(0, 6));
    fakeExec.failDropAllWithNotSupportedForSite.add(disp2);
    fakeExec.dbCalls.length = 0;

    const del2 = await call(
      "DELETE",
      `/v1/organizations/${orgAId}/managed-sites/${disp2}`,
      { confirmName: (await call("GET", `/v1/organizations/${orgAId}/managed-sites/${disp2}`)).body.data.name },
      ownerAToken,
      { "Idempotency-Key": randomUUID() },
    );
    expect(del2.status).toBe(202);
    await app.outboxWorker.processPendingOnce();

    const op2 = await call("GET", `/v1/organizations/${orgAId}/operations/${del2.body.data.operationId}`);
    expect(op2.body.data.status).toBe("succeeded");
    expect(fakeExec.dbCalls.filter((c) => c.siteId === disp2 && c.op === "dropAll")).toHaveLength(1);
  });

  it("failing dropAll with DOCKER_ENGINE_UNAVAILABLE stops site deletion, marks site degraded, and second delete succeeds", async () => {
    const slug = randomUUID().slice(0, 6);
    const created = await call(
      "POST",
      `/v1/organizations/${orgAId}/managed-sites`,
      {
        name: `Drop Fail ${slug}`,
        domain: `drop-fail-${slug}.it`,
        title: `Drop Fail ${slug}`,
        adminUser: "admin",
        adminEmail: `admin@${slug}.it`,
        adminPassword: "canary-Pass-123456",
      },
      ownerAToken,
      { "Idempotency-Key": randomUUID() },
    );
    expect(created.status).toBe(202);
    await app.outboxWorker.processPendingOnce();
    const disp3 = created.body.data.siteId as string;

    expect((await call("POST", dbBase(orgAId, disp3, "/databases"), { name: "shop" })).status).toBe(201);
    fakeExec.failNextDropAllForSite.set(disp3, "DOCKER_ENGINE_UNAVAILABLE");

    const siteInfo = await call("GET", `/v1/organizations/${orgAId}/managed-sites/${disp3}`);
    const siteName = siteInfo.body.data.name as string;

    const del1 = await call(
      "DELETE",
      `/v1/organizations/${orgAId}/managed-sites/${disp3}`,
      { confirmName: siteName },
      ownerAToken,
      { "Idempotency-Key": randomUUID() },
    );
    expect(del1.status).toBe(202);
    await app.outboxWorker.processPendingOnce();

    const op1 = await call("GET", `/v1/organizations/${orgAId}/operations/${del1.body.data.operationId}`);
    expect(op1.body.data.status).toBe("failed");

    const stillPresent = await call("GET", `/v1/organizations/${orgAId}/managed-sites/${disp3}`);
    expect(stillPresent.status).toBe(200);
    expect(stillPresent.body.data.status).toBe("degraded");
    expect(fakeExec.sites.has(disp3)).toBe(true);

    const del2 = await call(
      "DELETE",
      `/v1/organizations/${orgAId}/managed-sites/${disp3}`,
      { confirmName: siteName },
      ownerAToken,
      { "Idempotency-Key": randomUUID() },
    );
    expect(del2.status).toBe(202);
    await app.outboxWorker.processPendingOnce();

    const op2 = await call("GET", `/v1/organizations/${orgAId}/operations/${del2.body.data.operationId}`);
    expect(op2.body.data.status).toBe("succeeded");
    expect((await call("GET", `/v1/organizations/${orgAId}/managed-sites/${disp3}`)).status).toBe(404);
    expect(fakeExec.sites.has(disp3)).toBe(false);
  });

  it("moving a site gives the site's own account and every extra account a new password, keeping databases and grants (C1)", async () => {
    const slug = randomUUID().slice(0, 6);
    const created = await call(
      "POST",
      `/v1/organizations/${orgAId}/managed-sites`,
      {
        name: `Move Rotate ${slug}`,
        domain: `move-rotate-${slug}.it`,
        title: `Move Rotate ${slug}`,
        adminUser: "admin",
        adminEmail: `admin@${slug}.it`,
        adminPassword: "canary-Pass-123456",
      },
      ownerAToken,
      { "Idempotency-Key": randomUUID() },
    );
    expect(created.status).toBe(202);
    await app.outboxWorker.processPendingOnce();
    const moveSiteId = created.body.data.siteId as string;
    const prefix = siteDatabasePrefix(moveSiteId);

    const dbRes = await call("POST", dbBase(orgAId, moveSiteId, "/databases"), { name: "shop" });
    expect(dbRes.status).toBe(201);
    const shopDb = dbRes.body.data.database.name as string;

    const u1Res = await call("POST", dbBase(orgAId, moveSiteId, "/database-users"), { name: "app1" });
    expect(u1Res.status).toBe(201);
    const user1 = u1Res.body.data.user.name as string;
    const pw1 = u1Res.body.data.temporaryPassword as string;

    const u2Res = await call("POST", dbBase(orgAId, moveSiteId, "/database-users"), { name: "app2" });
    expect(u2Res.status).toBe(201);
    const user2 = u2Res.body.data.user.name as string;
    const pw2 = u2Res.body.data.temporaryPassword as string;

    expect((await call("PUT", dbBase(orgAId, moveSiteId, `/database-users/${user1}/grants/${shopDb}`))).status).toBe(204);
    expect((await call("PUT", dbBase(orgAId, moveSiteId, `/database-users/${user1}/grants/${prefix}`))).status).toBe(204);

    expect(fakeExec.verifyUserPassword(moveSiteId, user1, pw1)).toBe(true);
    expect(fakeExec.verifyUserPassword(moveSiteId, user2, pw2)).toBe(true);
    const sitePassword = async (organizationId: string) =>
      (await resolveDecryptedSecretRefs(dbClient.db, {
        organizationId,
        siteId: moveSiteId,
        secretRefs: { P: "SITE_DB_PASSWORD" },
        masterKey: KEY,
      })).P!;
    const pwBefore = await sitePassword(orgAId);
    expect(pwBefore).toMatch(/^[0-9a-f]{64}$/);
    fakeExec.dbCalls.length = 0;
    fakeExec.jobs.length = 0;
    const logged: unknown[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void logged.push(args)),
    );

    const moveRes = await call(
      "POST",
      `/v1/admin/sites/${moveSiteId}/owner`,
      { ownerOrganizationId: orgBId },
      adminToken,
      { "Idempotency-Key": randomUUID() },
    );
    expect(moveRes.status).toBe(202);
    await app.outboxWorker.processPendingOnce();

    const moveOp = await call(
      "GET",
      `/v1/organizations/${orgBId}/operations/${moveRes.body.data.operationId}`,
      undefined,
      ownerBToken,
    );
    expect(moveOp.status).toBe(200);
    expect(moveOp.body.data.status).toBe("succeeded");
    for (const spy of spies) spy.mockRestore();

    // The stored password changed; the site's config job wrote it before db.provision set it.
    const pwAfter = await sitePassword(orgBId);
    expect(pwAfter).toMatch(/^[0-9a-f]{64}$/);
    expect(pwAfter).not.toBe(pwBefore);
    const siteJobs = fakeExec.jobs.filter((j) => j.siteId === moveSiteId);
    expect(siteJobs.map((j) => j.kind)).toEqual(["wordpress.settle", "db.provision"]);
    for (const j of siteJobs) {
      expect(j.organizationId).toBe(orgBId);
      expect(j.resolvedSecrets).toEqual({ HP_DB_PASSWORD: pwAfter });
    }
    expect(siteJobs[1]!.params).toEqual({ dbName: prefix, dbUser: prefix });

    const siteCalls = fakeExec.dbCalls.filter((c) => c.siteId === moveSiteId);
    expect(siteCalls.some((c) => c.op === "list")).toBe(true);
    const pwCalls = siteCalls.filter(
      (c): c is Extract<SiteDatabasesRequest, { op: "setUserPassword" }> => c.op === "setUserPassword",
    );
    expect(pwCalls.map((c) => c.user).sort()).toEqual([user1, user2].sort());
    for (const c of pwCalls) {
      expect(c.user).not.toBe(prefix);
      expect(c.passwordHash).toMatch(MYSQL_NATIVE_PASSWORD_HASH_PATTERN);
    }

    expect(fakeExec.verifyUserPassword(moveSiteId, user1, pw1)).toBe(false);
    expect(fakeExec.verifyUserPassword(moveSiteId, user2, pw2)).toBe(false);

    const listAfter = await call(
      "GET",
      dbBase(orgBId, moveSiteId, "/databases"),
      undefined,
      ownerBToken,
    );
    expect(listAfter.status).toBe(200);
    expect(listAfter.body.data.databases.map((d: Json) => d.name)).toEqual([prefix, shopDb]);
    expect(listAfter.body.data.users).toEqual([
      { name: prefix, primary: true, databases: [prefix] },
      { name: user1, primary: false, databases: [prefix, shopDb] },
      { name: user2, primary: false, databases: [] },
    ]);

    const tableDump = JSON.stringify([
      await dbClient.db.select().from(auditEvents),
      await dbClient.db.select().from(operations),
      await dbClient.db.select().from(outboxEvents),
    ]);
    for (const c of pwCalls) {
      expect(tableDump).not.toContain(c.passwordHash);
    }
    const logDump = JSON.stringify(logged);
    for (const pw of [pwBefore, pwAfter]) {
      expect(tableDump).not.toContain(pw);
      expect(logDump).not.toContain(pw);
    }
  });

  it("failing setUserPassword fails the site move, and retrying completes it and rotates passwords", async () => {
    const slug = randomUUID().slice(0, 6);
    const created = await call(
      "POST",
      `/v1/organizations/${orgAId}/managed-sites`,
      {
        name: `Move Fail ${slug}`,
        domain: `move-fail-${slug}.it`,
        title: `Move Fail ${slug}`,
        adminUser: "admin",
        adminEmail: `admin@${slug}.it`,
        adminPassword: "canary-Pass-123456",
      },
      ownerAToken,
      { "Idempotency-Key": randomUUID() },
    );
    expect(created.status).toBe(202);
    await app.outboxWorker.processPendingOnce();
    const failMoveSiteId = created.body.data.siteId as string;

    const uRes = await call("POST", dbBase(orgAId, failMoveSiteId, "/database-users"), { name: "app1" });
    expect(uRes.status).toBe(201);
    const user1 = uRes.body.data.user.name as string;
    const pw1 = uRes.body.data.temporaryPassword as string;

    fakeExec.failNextSetUserPasswordForSite.set(failMoveSiteId, "DOCKER_ENGINE_UNAVAILABLE");

    const moveRes = await call(
      "POST",
      `/v1/admin/sites/${failMoveSiteId}/owner`,
      { ownerOrganizationId: orgBId },
      adminToken,
      { "Idempotency-Key": randomUUID() },
    );
    expect(moveRes.status).toBe(202);
    await app.outboxWorker.processPendingOnce();

    const failedOp = await call(
      "GET",
      `/v1/organizations/${orgBId}/operations/${moveRes.body.data.operationId}`,
      undefined,
      ownerBToken,
    );
    expect(failedOp.status).toBe(200);
    expect(failedOp.body.data.status).toBe("failed");

    const degradedSite = await call(
      "GET",
      `/v1/organizations/${orgBId}/managed-sites/${failMoveSiteId}`,
      undefined,
      ownerBToken,
    );
    expect(degradedSite.status).toBe(200);
    expect(degradedSite.body.data.status).toBe("degraded");
    expect(fakeExec.verifyUserPassword(failMoveSiteId, user1, pw1)).toBe(true);

    const retryRes = await call(
      "POST",
      `/v1/admin/sites/${failMoveSiteId}/actions`,
      { action: "retry" },
      adminToken,
      { "Idempotency-Key": randomUUID() },
    );
    expect(retryRes.status).toBe(202);
    await app.outboxWorker.processPendingOnce();

    const retryOp = await call(
      "GET",
      `/v1/organizations/${orgBId}/operations/${retryRes.body.data.operationId}`,
      undefined,
      ownerBToken,
    );
    expect(retryOp.status).toBe(200);
    expect(retryOp.body.data.status).toBe("succeeded");
    expect(fakeExec.verifyUserPassword(failMoveSiteId, user1, pw1)).toBe(false);
  });

  it("a site configuration the job cannot rewrite fails the move before MariaDB changes, and a retry completes it (C1)", async () => {
    const slug = randomUUID().slice(0, 6);
    const created = await call(
      "POST",
      `/v1/organizations/${orgAId}/managed-sites`,
      {
        name: `Move Cfg ${slug}`,
        domain: `move-cfg-${slug}.example.test`,
        title: `Move Cfg ${slug}`,
        adminUser: "admin",
        adminEmail: `admin@${slug}.example.test`,
        adminPassword: "canary-Pass-123456",
      },
      ownerAToken,
      { "Idempotency-Key": randomUUID() },
    );
    expect(created.status).toBe(202);
    await app.outboxWorker.processPendingOnce();
    const siteId = created.body.data.siteId as string;
    const uRes = await call("POST", dbBase(orgAId, siteId, "/database-users"), { name: "app1" });
    expect(uRes.status).toBe(201);
    const user1 = uRes.body.data.user.name as string;
    const pw1 = uRes.body.data.temporaryPassword as string;

    const storedPassword = async (organizationId: string) =>
      (await resolveDecryptedSecretRefs(dbClient.db, {
        organizationId,
        siteId,
        secretRefs: { P: "SITE_DB_PASSWORD" },
        masterKey: KEY,
      })).P!;
    const pwBefore = await storedPassword(orgAId);
    fakeExec.jobs.length = 0;
    fakeExec.nextJobExit.set(`${siteId} wordpress.settle`, 20);
    const moveRes = await call(
      "POST",
      `/v1/admin/sites/${siteId}/owner`,
      { ownerOrganizationId: orgBId },
      adminToken,
      { "Idempotency-Key": randomUUID() },
    );
    expect(moveRes.status).toBe(202);
    await app.outboxWorker.processPendingOnce();
    const failedOp = await call("GET", `/v1/organizations/${orgBId}/operations/${moveRes.body.data.operationId}`, undefined, ownerBToken);
    expect(failedOp.body.data.status).toBe("failed");
    expect(failedOp.body.data.errorMessage).toBe("The owner change did not finish");
    // Nothing of MariaDB changed: no db.provision, and the extra account keeps its password.
    expect(fakeExec.jobs.filter((j) => j.siteId === siteId).map((j) => j.kind)).toEqual(["wordpress.settle"]);
    expect(fakeExec.verifyUserPassword(siteId, user1, pw1)).toBe(true);
    // The stored password is still the one the site and MariaDB hold.
    expect(await storedPassword(orgBId)).toBe(pwBefore);

    const retryRes = await call("POST", `/v1/admin/sites/${siteId}/actions`, { action: "retry" }, adminToken, {
      "Idempotency-Key": randomUUID(),
    });
    expect(retryRes.status).toBe(202);
    await app.outboxWorker.processPendingOnce();
    const retryOp = await call("GET", `/v1/organizations/${orgBId}/operations/${retryRes.body.data.operationId}`, undefined, ownerBToken);
    expect(retryOp.body.data.status).toBe("succeeded");
    expect(fakeExec.jobs.filter((j) => j.siteId === siteId).map((j) => j.kind)).toEqual([
      "wordpress.settle",
      "wordpress.settle",
      "db.provision",
    ]);
    expect(fakeExec.verifyUserPassword(siteId, user1, pw1)).toBe(false);
    // The retry stored exactly what its job wrote into the site.
    const writes = fakeExec.jobs.filter((j) => j.siteId === siteId && j.kind === "wordpress.settle");
    expect(await storedPassword(orgBId)).toBe(writes[1]?.resolvedSecrets?.["HP_DB_PASSWORD"]);
    expect(writes[1]?.resolvedSecrets?.["HP_DB_PASSWORD"]).not.toBe(pwBefore);
  });

  it("a failed password job of a move keeps the stored database password (C1)", async () => {
    const slug = randomUUID().slice(0, 6);
    const created = await call(
      "POST",
      `/v1/organizations/${orgAId}/managed-sites`,
      {
        name: `Move Job ${slug}`,
        domain: `move-job-${slug}.example.test`,
        title: `Move Job ${slug}`,
        adminUser: "admin",
        adminEmail: `admin@${slug}.example.test`,
        adminPassword: "canary-Pass-123456",
      },
      ownerAToken,
      { "Idempotency-Key": randomUUID() },
    );
    expect(created.status).toBe(202);
    await app.outboxWorker.processPendingOnce();
    const siteId = created.body.data.siteId as string;
    const storedPassword = async (organizationId: string) =>
      (await resolveDecryptedSecretRefs(dbClient.db, {
        organizationId,
        siteId,
        secretRefs: { P: "SITE_DB_PASSWORD" },
        masterKey: KEY,
      })).P!;
    const pwBefore = await storedPassword(orgAId);

    fakeExec.jobs.length = 0;
    fakeExec.nextJobExit.set(`${siteId} wordpress.settle`, 1);
    const moveRes = await call(
      "POST",
      `/v1/admin/sites/${siteId}/owner`,
      { ownerOrganizationId: orgBId },
      adminToken,
      { "Idempotency-Key": randomUUID() },
    );
    expect(moveRes.status).toBe(202);
    await app.outboxWorker.processPendingOnce();
    const failedOp = await call("GET", `/v1/organizations/${orgBId}/operations/${moveRes.body.data.operationId}`, undefined, ownerBToken);
    expect(failedOp.body.data.status).toBe("failed");
    expect(fakeExec.jobs.filter((j) => j.siteId === siteId).map((j) => j.kind)).toEqual(["wordpress.settle"]);
    // The job got a new password, which was never stored.
    const offered = fakeExec.jobs[0]?.resolvedSecrets?.["HP_DB_PASSWORD"];
    expect(offered).toMatch(/^[0-9a-f]{64}$/);
    expect(offered).not.toBe(pwBefore);
    expect(await storedPassword(orgBId)).toBe(pwBefore);
    const dump = JSON.stringify([
      await dbClient.db.select().from(operations),
      await dbClient.db.select().from(operationSteps),
      await dbClient.db.select().from(auditEvents),
      await dbClient.db.select().from(outboxEvents),
    ]);
    expect(dump).not.toContain(offered);
  });

  it("ignores NOT_SUPPORTED from list or setUserPassword during site move", async () => {
    const slug = randomUUID().slice(0, 6);
    const created = await call(
      "POST",
      `/v1/organizations/${orgAId}/managed-sites`,
      {
        name: `Move NotSup ${slug}`,
        domain: `move-notsup-${slug}.it`,
        title: `Move NotSup ${slug}`,
        adminUser: "admin",
        adminEmail: `admin@${slug}.it`,
        adminPassword: "canary-Pass-123456",
      },
      ownerAToken,
      { "Idempotency-Key": randomUUID() },
    );
    expect(created.status).toBe(202);
    await app.outboxWorker.processPendingOnce();
    const siteId = created.body.data.siteId as string;

    expect((await call("POST", dbBase(orgAId, siteId, "/database-users"), { name: "app1" })).status).toBe(201);

    fakeExec.failNextListForSite.set(siteId, "NOT_SUPPORTED");
    const moveToB = await call(
      "POST",
      `/v1/admin/sites/${siteId}/owner`,
      { ownerOrganizationId: orgBId },
      adminToken,
      { "Idempotency-Key": randomUUID() },
    );
    expect(moveToB.status).toBe(202);
    await app.outboxWorker.processPendingOnce();
    const opB = await call(
      "GET",
      `/v1/organizations/${orgBId}/operations/${moveToB.body.data.operationId}`,
      undefined,
      ownerBToken,
    );
    expect(opB.body.data.status).toBe("succeeded");

    fakeExec.failNextSetUserPasswordForSite.set(siteId, "NOT_SUPPORTED");
    const moveBackToA = await call(
      "POST",
      `/v1/admin/sites/${siteId}/owner`,
      { ownerOrganizationId: orgAId },
      adminToken,
      { "Idempotency-Key": randomUUID() },
    );
    expect(moveBackToA.status).toBe(202);
    await app.outboxWorker.processPendingOnce();
    const opA = await call(
      "GET",
      `/v1/organizations/${orgAId}/operations/${moveBackToA.body.data.operationId}`,
      undefined,
      ownerAToken,
    );
    expect(opA.body.data.status).toBe("succeeded");
  });
});

describe("site databases on local-simulator backend", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let fakeExec: FakeDatabasesDockerExecutor;
  let orgId: string;
  let siteId: string;
  let ownerToken: string;

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, {
      email: "admin-sim-db@x.it",
      name: "Admin",
      password: PW,
    });

    fakeExec = new FakeDatabasesDockerExecutor();
    app = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      runtimeBackend: "local-simulator",
      dockerExecutor: fakeExec,
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
      "admin-sim-db@x.it",
      PW,
      admin.totpSecretBase32,
    );
    const createdOrg = await httpJson(app.baseUrl!, "POST", "/v1/admin/customer-account", {
      token: adminToken,
      body: { organizationName: "Sim DB Org", ownerEmail: "owner-db@sim.it", ownerName: "Sim" },
    });
    orgId = createdOrg.body.data.organizationId as string;
    ownerToken = await loginUser(
      app.baseUrl!,
      "owner-db@sim.it",
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
    siteId = createSite.body.data.siteId as string;
    await app.outboxWorker.processPendingOnce();
  });

  afterAll(async () => {
    await app.close();
    await dbClient.close();
  });

  it("reports phpMyAdminAvailable: false and refuses POST/GET /databases/phpmyadmin with 422 NOT_SUPPORTED without calling executor", async () => {
    const execSpy = vi.spyOn(fakeExec, "siteDatabases");

    const listRes = await httpJson(
      app.baseUrl!,
      "GET",
      `/v1/organizations/${orgId}/managed-sites/${siteId}/databases`,
      { token: ownerToken },
    );
    expect(listRes.status).toBe(200);
    expect(SiteDatabasesDtoSchema.parse(listRes.body.data).phpMyAdminAvailable).toBe(false);

    execSpy.mockClear();

    const pmaPost = await httpJson(
      app.baseUrl!,
      "POST",
      `/v1/organizations/${orgId}/managed-sites/${siteId}/databases/phpmyadmin`,
      { token: ownerToken },
    );
    expect(pmaPost.status).toBe(422);
    expect(pmaPost.body.error.code).toBe("NOT_SUPPORTED");

    const pmaGet = await httpJson(
      app.baseUrl!,
      "GET",
      `/v1/organizations/${orgId}/managed-sites/${siteId}/databases/phpmyadmin`,
      { token: ownerToken },
    );
    expect(pmaGet.status).toBe(422);
    expect(pmaGet.body.error.code).toBe("NOT_SUPPORTED");

    expect(execSpy).not.toHaveBeenCalled();
  });
});

describe("createControlPlaneApp boot restores site.databases.manage to customer_owner", () => {
  let app: ControlPlaneAppHandle;

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it("seeds site.databases.manage on boot and restores it after deleting from role_permissions", async () => {
    const bootExecutor = new FakeDatabasesDockerExecutor();
    app = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      secretsMasterKey: KEY,
      runtimeBackend: "local-simulator",
      dockerExecutor: bootExecutor,
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
      domainReconcileIntervalMs: null,
      mailRelayRetryIntervalMs: null,
      sftpRetryIntervalMs: null,
      recoverUnknownOnStart: false,
    });

    const checkHasPerm = async (): Promise<boolean> => {
      const rows = await app.dbClient.db
        .select({ key: rolePermissions.permissionKey })
        .from(rolePermissions)
        .where(eq(rolePermissions.roleId, "role_customer_owner"));
      return rows.some((r) => r.key === "site.databases.manage");
    };

    expect(await checkHasPerm()).toBe(true);
    expect(PRESET_ROLE_PERMISSIONS.customer_owner).toContain("site.databases.manage");

    await setupInstallation(app.dbClient.db, SETUP);
    const admin = await createServerAdmin(app.dbClient.db, KEY, {
      email: "admin-boot-db@x.it",
      name: "Admin",
      password: PW,
    });
    const adminToken = await loginUser(
      app.baseUrl!,
      "admin-boot-db@x.it",
      PW,
      admin.totpSecretBase32,
    );
    const createdOrg = await httpJson(app.baseUrl!, "POST", "/v1/admin/customer-account", {
      token: adminToken,
      body: { organizationName: "Boot DB Org", ownerEmail: "owner@bootdb.it", ownerName: "Owner" },
    });
    const orgId = createdOrg.body.data.organizationId as string;
    const ownerToken = await loginUser(
      app.baseUrl!,
      "owner@bootdb.it",
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
    const siteId = createSite.body.data.siteId as string;
    await app.outboxWorker.processPendingOnce();

    // Simulate pre-M2 DB missing site.databases.manage, then re-run boot seeding.
    await app.dbClient.db
      .delete(rolePermissions)
      .where(
        and(
          eq(rolePermissions.roleId, "role_customer_owner"),
          eq(rolePermissions.permissionKey, "site.databases.manage"),
        ),
      );
    expect(await checkHasPerm()).toBe(false);

    const deniedBeforeSeed = await httpJson(
      app.baseUrl!,
      "GET",
      `/v1/organizations/${orgId}/managed-sites/${siteId}/databases`,
      { token: ownerToken },
    );
    expect(deniedBeforeSeed.status).toBe(403);
    expect(deniedBeforeSeed.body.error.code).toBe("PERMISSION_DENIED");

    await ensurePresetRolesAndPermissions(app.dbClient.db);
    expect(await checkHasPerm()).toBe(true);

    const okAfterSeed = await httpJson(
      app.baseUrl!,
      "GET",
      `/v1/organizations/${orgId}/managed-sites/${siteId}/databases`,
      { token: ownerToken },
    );
    expect(okAfterSeed.status).toBe(200);
  });
});
