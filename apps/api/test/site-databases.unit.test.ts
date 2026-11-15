import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyRequest } from "fastify";
import {
  ERROR_CODE_HTTP_STATUS,
  MYSQL_NATIVE_PASSWORD_HASH_PATTERN,
  SITE_DATABASES_MAX,
  SITE_DATABASE_USERS_MAX,
  SiteDatabaseCreatedDtoSchema,
  SiteDatabasePasswordResetDtoSchema,
  SiteDatabaseSignOnDtoSchema,
  SiteDatabaseUserCreatedDtoSchema,
  SiteDatabasesDtoSchema,
  findForbiddenPublicDtoKeys,
  mysqlNativePasswordHash,
  siteDatabasePrefix,
  siteDatabaseSignOnUser,
} from "@hosting-panel/contracts";
import {
  DEMO_IDS,
  auditEvents,
  createDatabaseClient,
  ensurePresetRolesAndPermissions,
  ensureWordpressTemplate,
  seedPhase1Dataset,
  sites,
  type DatabaseClient,
} from "@hosting-panel/database";
import {
  Phase1DisabledDockerExecutor,
  type DockerExecutorPort,
  type SiteDatabasesRequest,
  type SiteDatabasesResult,
} from "@hosting-panel/executor-contracts";
import { ZodError } from "zod";
import {
  AuthzContextService,
  type AuthenticatedRequestContext,
} from "../src/auth/authz-context.service.js";
import type { OidcService } from "../src/auth/oidc.service.js";
import { ControlPlaneError } from "../src/common/control-plane.error.js";
import { SiteDatabasesController } from "../src/controllers/site-databases.controller.js";
import type { ManagedSitesService } from "../src/sites/managed-sites.service.js";
import {
  SiteDatabasesService,
  databasesUnavailableError,
  generateDatabasePassword,
  mapSiteDatabaseExecutorError,
  type SiteDatabaseActor,
} from "../src/sites/site-databases.service.js";
import type { SiteRef } from "../src/sites/site-sftp.service.js";
import type { ControlPlaneRuntimeConfig } from "../src/tokens.js";

class MockDockerExecutor implements DockerExecutorPort {
  readonly #base: DockerExecutorPort = new Phase1DisabledDockerExecutor();
  public readonly isRuntimeAvailable: boolean;
  public readonly siteDatabasesSpy = vi.fn<(req: SiteDatabasesRequest) => Promise<unknown>>();

  public constructor(isRuntimeAvailable: boolean = true) {
    this.isRuntimeAvailable = isRuntimeAvailable;
    this.siteDatabasesSpy.mockImplementation(async (req) => {
      switch (req.op) {
        case "list":
          return { databases: [], users: [] };
        case "phpMyAdminSignOn":
          return { username: siteDatabaseSignOnUser(req.siteId) };
        default:
          return {};
      }
    });
  }

  public deployService: DockerExecutorPort["deployService"] = (spec) => this.#base.deployService(spec);
  public restartService: DockerExecutorPort["restartService"] = (id) => this.#base.restartService(id);
  public stopService: DockerExecutorPort["stopService"] = (id) => this.#base.stopService(id);
  public deleteService: DockerExecutorPort["deleteService"] = (id) => this.#base.deleteService(id);
  public getObservedState: DockerExecutorPort["getObservedState"] = (id) => this.#base.getObservedState(id);
  public runSiteJob: DockerExecutorPort["runSiteJob"] = (req) => this.#base.runSiteJob(req);
  public purgeSite: DockerExecutorPort["purgeSite"] = (siteId) => this.#base.purgeSite(siteId);
  public getServiceLogs: DockerExecutorPort["getServiceLogs"] = (id, tail) =>
    this.#base.getServiceLogs(id, tail);
  public applySiteRoutes: DockerExecutorPort["applySiteRoutes"] = (req) =>
    this.#base.applySiteRoutes(req);
  public getCertificateStatus: DockerExecutorPort["getCertificateStatus"] = (req) =>
    this.#base.getCertificateStatus(req);
  public applyMailRelay: DockerExecutorPort["applyMailRelay"] = (req) => this.#base.applyMailRelay(req);
  public getMailRelayStatus: DockerExecutorPort["getMailRelayStatus"] = (req) =>
    this.#base.getMailRelayStatus(req);
  public sendTestMail: DockerExecutorPort["sendTestMail"] = (req) => this.#base.sendTestMail(req);
  public siteFiles: DockerExecutorPort["siteFiles"] = (req) => this.#base.siteFiles(req);

  public async siteDatabases<R extends SiteDatabasesRequest>(
    req: R,
  ): Promise<SiteDatabasesResult<R["op"]>> {
    return (await this.siteDatabasesSpy(req)) as SiteDatabasesResult<R["op"]>;
  }

  public applySftpAccess: DockerExecutorPort["applySftpAccess"] = (req) =>
    this.#base.applySftpAccess(req);
  public getSftpStatus: DockerExecutorPort["getSftpStatus"] = () =>
    this.#base.getSftpStatus();
  public backups: DockerExecutorPort["backups"] = (req) => this.#base.backups(req);
}

function createRuntimeConfig(
  overrides?: Partial<ControlPlaneRuntimeConfig>,
): ControlPlaneRuntimeConfig {
  return {
    oidcIssuer: "https://issuer.local",
    oidcAudience: "hosting-panel-api",
    enableDevOidc: true,
    runtimeBackend: "linux-systemd",
    secretsMasterKey: randomBytes(32),
    jwtSigningKeyPem: null,
    autoProcessOutbox: false,
    ...overrides,
  };
}

function createMockRequest(): FastifyRequest {
  return {
    headers: { "user-agent": "vitest-unit/1.0" },
    ip: "127.0.0.1",
    id: "req_unit_db",
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as FastifyRequest;
}

function createMockActor(userId: string = DEMO_IDS.users.elena): SiteDatabaseActor {
  const auth = {
    user: {
      id: userId,
      email: "elena@acme.it",
      name: "Elena",
      userStatus: "active",
    },
    claims: {
      subject: userId,
      email: "elena@acme.it",
      issuer: "https://issuer.local",
      audience: "hosting-panel-api",
      jti: "jti_unit",
    },
    principal: {
      userId,
      email: "elena@acme.it",
      userStatus: "active",
      globalRoles: [],
      hostingAdminOrgIds: [],
      memberships: [],
      supportGrants: [],
    },
    activeMembershipSummaries: [],
  } as unknown as AuthenticatedRequestContext;
  return { auth, req: createMockRequest() };
}

describe("SiteDatabases unit tests (passwords, error mapping, name checks, service)", () => {
  let dbClient: DatabaseClient;
  let authz: AuthzContextService;
  let executor: MockDockerExecutor;
  let service: SiteDatabasesService;
  let baselineAuditIds: Set<string>;

  const readySiteId = "site_db_unit_ready";
  const deployingSiteId = "site_db_unit_deploying";
  const maintenanceSiteId = "site_db_unit_maint";
  const readyPrefix = siteDatabasePrefix(readySiteId);
  const otherSitePrefix = siteDatabasePrefix("site_db_unit_other");

  const readySite: SiteRef = {
    id: readySiteId,
    organizationId: DEMO_IDS.organizations.acme,
    status: "ready",
  };
  const deployingSite: SiteRef = {
    id: deployingSiteId,
    organizationId: DEMO_IDS.organizations.acme,
    status: "deploying",
  };
  const maintenanceSite: SiteRef = {
    id: maintenanceSiteId,
    organizationId: DEMO_IDS.organizations.acme,
    status: "maintenance",
  };

  async function snapshotAudits(): Promise<void> {
    const rows = await dbClient.db.select({ id: auditEvents.id }).from(auditEvents);
    baselineAuditIds = new Set(rows.map((r) => r.id));
  }

  async function listNewAudits() {
    const rows = await dbClient.db.select().from(auditEvents);
    return rows.filter((r) => !baselineAuditIds.has(r.id));
  }

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await ensureWordpressTemplate(dbClient.db);
    await ensurePresetRolesAndPermissions(dbClient.db);
    const config = createRuntimeConfig();
    await seedPhase1Dataset(dbClient.db, config.secretsMasterKey);

    await dbClient.db
      .insert(sites)
      .values([
        {
          id: readySiteId,
          organizationId: DEMO_IDS.organizations.acme,
          hostAllocationId: DEMO_IDS.allocations.acme,
          name: "DB Unit Ready",
          slug: "db-unit-ready",
          status: "ready",
          phpVersion: "8.3",
        },
        {
          id: deployingSiteId,
          organizationId: DEMO_IDS.organizations.acme,
          hostAllocationId: DEMO_IDS.allocations.acme,
          name: "DB Unit Deploying",
          slug: "db-unit-deploying",
          status: "deploying",
          phpVersion: "8.3",
        },
        {
          id: maintenanceSiteId,
          organizationId: DEMO_IDS.organizations.acme,
          hostAllocationId: DEMO_IDS.allocations.acme,
          name: "DB Unit Maint",
          slug: "db-unit-maint",
          status: "maintenance",
          phpVersion: "8.3",
        },
      ])
      .onConflictDoNothing();

    authz = new AuthzContextService(dbClient, {} as OidcService);
  });

  afterAll(async () => {
    await dbClient.close();
  });

  beforeEach(async () => {
    executor = new MockDockerExecutor(true);
    service = new SiteDatabasesService(dbClient, executor, createRuntimeConfig(), authz);
    await snapshotAudits();
  });

  describe("generateDatabasePassword", () => {
    it("produces 24-character [A-Za-z0-9] strings and 1000 distinct values", () => {
      const seen = new Set<string>();
      for (let i = 0; i < 1000; i += 1) {
        const pw = generateDatabasePassword();
        expect(pw).toMatch(/^[A-Za-z0-9]{24}$/);
        seen.add(pw);
      }
      expect(seen.size).toBe(1000);
    });
  });

  describe("mapSiteDatabaseExecutorError", () => {
    it("preserves ControlPlaneError untouched", () => {
      const original = new ControlPlaneError("QUOTA_EXCEEDED", "Custom message");
      expect(mapSiteDatabaseExecutorError(original)).toBe(original);
    });

    it.each([
      ["VALIDATION_ERROR", 400],
      ["ALREADY_EXISTS", 409],
      ["NOT_FOUND", 404],
      ["QUOTA_EXCEEDED", 409],
      ["RESOURCE_LOCKED", 409],
      ["NOT_SUPPORTED", 422],
    ] as const)("maps executor %s -> HTTP %d with sanitized fixed message", (code, expectedStatus) => {
      const raw = Object.assign(
        new Error(`SQL ERROR *0123456789ABCDEF0123456789ABCDEF01234567 /var/run/docker.sock`),
        { code },
      );
      const mapped = mapSiteDatabaseExecutorError(raw);
      expect(mapped).toBeInstanceOf(ControlPlaneError);
      expect(mapped.code).toBe(code);
      expect(ERROR_CODE_HTTP_STATUS[mapped.code]).toBe(expectedStatus);
      expect(mapped.message).not.toContain("/var/run/docker.sock");
      expect(mapped.message).not.toContain("0123456789ABCDEF");
    });

    it("maps ambiguous/unclear outcomes to retryable 503 DOCKER_ENGINE_UNAVAILABLE", () => {
      const ambiguousFlag = Object.assign(new Error("Dropped socket"), {
        code: "ALREADY_EXISTS",
        ambiguousOutcome: true,
      });
      const ambiguousCode = Object.assign(new Error("Timeout"), {
        code: "OPERATION_AMBIGUOUS",
      });
      const both = Object.assign(new Error("Timeout"), {
        code: "OPERATION_AMBIGUOUS",
        ambiguousOutcome: true,
      });

      for (const err of [ambiguousFlag, ambiguousCode, both]) {
        const mapped = mapSiteDatabaseExecutorError(err);
        expect(mapped.code).toBe("DOCKER_ENGINE_UNAVAILABLE");
        expect(ERROR_CODE_HTTP_STATUS[mapped.code]).toBe(503);
        expect(mapped.retryable).toBe(true);
      }
    });

    it("maps DOCKER_ENGINE_UNAVAILABLE, INTERNAL_ERROR, unknown codes, and non-errors to retryable 503", () => {
      const cases: unknown[] = [
        Object.assign(new Error("down"), { code: "DOCKER_ENGINE_UNAVAILABLE" }),
        Object.assign(new Error("sql crash"), { code: "INTERNAL_ERROR" }),
        Object.assign(new Error("denied"), { code: "HOST_POLICY_DENIED" }),
        Object.assign(new Error("weird"), { code: "SOME_UNKNOWN_CODE" }),
        new Error("plain error"),
        "string error",
        null,
        undefined,
      ];

      for (const err of cases) {
        const mapped = mapSiteDatabaseExecutorError(err);
        expect(mapped.code).toBe("DOCKER_ENGINE_UNAVAILABLE");
        expect(ERROR_CODE_HTTP_STATUS[mapped.code]).toBe(503);
        expect(mapped.retryable).toBe(true);
      }

      const unavail = databasesUnavailableError();
      expect(unavail.code).toBe("DOCKER_ENGINE_UNAVAILABLE");
      expect(unavail.retryable).toBe(true);
    });
  });

  describe("name checks and primary protection (no executor call)", () => {
    const actor = createMockActor();
    const pmaName = siteDatabaseSignOnUser(readySiteId);

    it("rejects pma_..., foreign site names, phpmyadmin, and malformed names with 404 before calling executor", async () => {
      const badNames = [
        pmaName,
        `${otherSitePrefix}_shop`,
        otherSitePrefix,
        "phpmyadmin",
        `${readyPrefix}_`,
        `${readyPrefix}_Upper`,
        `${readyPrefix}_a;drop`,
        `${readyPrefix}_%`,
        `${readyPrefix}_${"a".repeat(17)}`,
        `${readyPrefix}x`,
      ];

      for (const bad of badNames) {
        await expect(service.deleteDatabase(readySite, actor, bad)).rejects.toMatchObject({
          code: "NOT_FOUND",
        });
        await expect(service.deleteUser(readySite, actor, bad)).rejects.toMatchObject({
          code: "NOT_FOUND",
        });
        await expect(service.resetUserPassword(readySite, actor, bad)).rejects.toMatchObject({
          code: "NOT_FOUND",
        });
        await expect(
          service.grant(readySite, actor, `${readyPrefix}_ok`, bad),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(
          service.grant(readySite, actor, bad, `${readyPrefix}_ok`),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(
          service.revoke(readySite, actor, `${readyPrefix}_ok`, bad),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(
          service.revoke(readySite, actor, bad, `${readyPrefix}_ok`),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
      }

      expect(executor.siteDatabasesSpy).not.toHaveBeenCalled();
    });

    it("rejects path names over 64 chars or empty with ZodError (400) before calling executor", async () => {
      const overlong = "a".repeat(65);
      await expect(service.deleteDatabase(readySite, actor, overlong)).rejects.toBeInstanceOf(
        ZodError,
      );
      await expect(service.deleteUser(readySite, actor, "")).rejects.toBeInstanceOf(ZodError);
      expect(executor.siteDatabasesSpy).not.toHaveBeenCalled();
    });

    it("refuses mutations on the site's own database and user with 400 VALIDATION_ERROR reason=protected", async () => {
      const customDb = `${readyPrefix}_shop`;
      const checks = [
        service.deleteDatabase(readySite, actor, readyPrefix),
        service.deleteUser(readySite, actor, readyPrefix),
        service.resetUserPassword(readySite, actor, readyPrefix),
        service.grant(readySite, actor, readyPrefix, customDb),
        service.grant(readySite, actor, readyPrefix, readyPrefix),
        service.revoke(readySite, actor, readyPrefix, customDb),
        service.revoke(readySite, actor, readyPrefix, readyPrefix),
      ];

      for (const promise of checks) {
        await expect(promise).rejects.toMatchObject({
          code: "VALIDATION_ERROR",
          details: [expect.objectContaining({ reason: "protected" })],
        });
      }

      expect(executor.siteDatabasesSpy).not.toHaveBeenCalled();
    });

    it("allows granting and revoking a custom user on the site's own (primary) database", async () => {
      const customUser = `${readyPrefix}_app`;
      await expect(service.grant(readySite, actor, customUser, readyPrefix)).resolves.toBeUndefined();
      await expect(service.revoke(readySite, actor, customUser, readyPrefix)).resolves.toBeUndefined();
      expect(executor.siteDatabasesSpy).toHaveBeenNthCalledWith(1, {
        siteId: readySiteId,
        op: "grant",
        user: customUser,
        database: readyPrefix,
      });
      expect(executor.siteDatabasesSpy).toHaveBeenNthCalledWith(2, {
        siteId: readySiteId,
        op: "revoke",
        user: customUser,
        database: readyPrefix,
      });
    });

    it("DELETE /databases/phpmyadmin through the controller rejects with 404 before calling executor", async () => {
      const controller = new SiteDatabasesController(
        {
          authenticateRequest: vi.fn().mockResolvedValue(actor.auth),
          requireOrgPermission: vi.fn().mockResolvedValue({ allowed: true }),
        } as unknown as AuthzContextService,
        {
          get: vi.fn().mockResolvedValue({
            id: readySite.id,
            organizationId: readySite.organizationId,
            status: readySite.status,
          }),
        } as unknown as ManagedSitesService,
        service,
      );

      await expect(
        controller.deleteDatabase(
          actor.req,
          readySite.organizationId,
          readySite.id,
          "phpmyadmin",
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(executor.siteDatabasesSpy).not.toHaveBeenCalled();
    });
  });

  describe("R26 no pre-create list, hashing, sorting, and capability gating", () => {
    const actor = createMockActor();

    it("createDatabase calls executor once (no list) and validates DTO", async () => {
      const res = await service.createDatabase(readySite, actor, " Shop ");
      expect(SiteDatabaseCreatedDtoSchema.parse(res)).toEqual({
        database: { name: `${readyPrefix}_shop`, primary: false, sizeBytes: 0 },
      });
      expect(executor.siteDatabasesSpy).toHaveBeenCalledTimes(1);
      expect(executor.siteDatabasesSpy).toHaveBeenCalledWith({
        siteId: readySiteId,
        op: "createDatabase",
        database: `${readyPrefix}_shop`,
      });
    });

    it("createUser and resetUserPassword call executor once with mysql_native_password hash and never leak password or hash", async () => {
      const created = await service.createUser(readySite, actor, "worker");
      expect(SiteDatabaseUserCreatedDtoSchema.parse(created)).toEqual({
        user: { name: `${readyPrefix}_worker`, primary: false, databases: [] },
        temporaryPassword: created.temporaryPassword,
      });
      expect(created.temporaryPassword).toMatch(/^[A-Za-z0-9]{24}$/);
      expect(findForbiddenPublicDtoKeys(created)).toEqual([]);

      expect(executor.siteDatabasesSpy).toHaveBeenCalledTimes(1);
      const createCall = executor.siteDatabasesSpy.mock.calls[0]![0];
      expect(createCall).toEqual({
        siteId: readySiteId,
        op: "createUser",
        user: `${readyPrefix}_worker`,
        passwordHash: mysqlNativePasswordHash(created.temporaryPassword),
      });
      if ("passwordHash" in createCall) {
        expect(createCall.passwordHash).toMatch(MYSQL_NATIVE_PASSWORD_HASH_PATTERN);
        expect(createCall.passwordHash).not.toBe(created.temporaryPassword);
      }

      const reset = await service.resetUserPassword(readySite, actor, `${readyPrefix}_worker`);
      expect(SiteDatabasePasswordResetDtoSchema.parse(reset)).toEqual({
        temporaryPassword: reset.temporaryPassword,
      });
      expect(reset.temporaryPassword).not.toBe(created.temporaryPassword);

      const resetCall = executor.siteDatabasesSpy.mock.calls[1]![0];
      expect(resetCall).toEqual({
        siteId: readySiteId,
        op: "setUserPassword",
        user: `${readyPrefix}_worker`,
        passwordHash: mysqlNativePasswordHash(reset.temporaryPassword),
      });

      const audits = await listNewAudits();
      const auditText = JSON.stringify(audits);
      expect(auditText).not.toContain(created.temporaryPassword);
      expect(auditText).not.toContain(reset.temporaryPassword);
      expect(auditText).not.toContain(mysqlNativePasswordHash(created.temporaryPassword));
      expect(auditText).not.toContain(mysqlNativePasswordHash(reset.temporaryPassword));
    });

    it("list sorts primary first then lexicographically, whitelists keys, and rejects invalid shapes with 503", async () => {
      executor.siteDatabasesSpy.mockResolvedValueOnce({
        databases: [
          { name: `${readyPrefix}_z`, primary: false, sizeBytes: 100, secretExtra: "leak" },
          { name: `${readyPrefix}_a`, primary: false, sizeBytes: 200 },
          { name: readyPrefix, primary: true, sizeBytes: 4096 },
        ],
        users: [
          {
            name: `${readyPrefix}_zuser`,
            primary: false,
            databases: [`${readyPrefix}_z`, `${readyPrefix}_a`],
            passwordHash: "*1234",
          },
          { name: readyPrefix, primary: true, databases: [readyPrefix] },
          { name: `${readyPrefix}_auser`, primary: false, databases: [] },
        ],
      });

      const dto = await service.list(readySite);
      expect(SiteDatabasesDtoSchema.parse(dto)).toEqual({
        prefix: readyPrefix,
        databases: [
          { name: readyPrefix, primary: true, sizeBytes: 4096 },
          { name: `${readyPrefix}_a`, primary: false, sizeBytes: 200 },
          { name: `${readyPrefix}_z`, primary: false, sizeBytes: 100 },
        ],
        users: [
          { name: readyPrefix, primary: true, databases: [readyPrefix] },
          { name: `${readyPrefix}_auser`, primary: false, databases: [] },
          {
            name: `${readyPrefix}_zuser`,
            primary: false,
            databases: [`${readyPrefix}_a`, `${readyPrefix}_z`],
          },
        ],
        limits: { databases: SITE_DATABASES_MAX, users: SITE_DATABASE_USERS_MAX },
        phpMyAdminAvailable: true,
      });

      executor.siteDatabasesSpy.mockResolvedValueOnce({ unexpected: true });
      await expect(service.list(readySite)).rejects.toMatchObject({
        code: "DOCKER_ENGINE_UNAVAILABLE",
        retryable: true,
      });
    });

    it("gates phpMyAdmin on local-simulator and disabled backends, and rejects malformed signOn username with 503", async () => {
      const simService = new SiteDatabasesService(
        dbClient,
        executor,
        createRuntimeConfig({ runtimeBackend: "local-simulator" }),
        authz,
      );
      expect(simService.isPhpMyAdminAvailable()).toBe(false);
      await expect(simService.phpMyAdminSignOn(readySite, actor)).rejects.toMatchObject({
        code: "NOT_SUPPORTED",
      });
      await expect(simService.assertPhpMyAdminAccess(readySite)).rejects.toMatchObject({
        code: "NOT_SUPPORTED",
      });
      expect(executor.siteDatabasesSpy).not.toHaveBeenCalled();

      executor.siteDatabasesSpy.mockResolvedValueOnce({ username: "not_pma_user" });
      await expect(service.phpMyAdminSignOn(readySite, actor)).rejects.toMatchObject({
        code: "DOCKER_ENGINE_UNAVAILABLE",
        retryable: true,
      });
      expect(await listNewAudits()).toEqual([]);

      executor.siteDatabasesSpy.mockResolvedValueOnce({
        username: siteDatabaseSignOnUser(readySiteId),
      });
      const signOn = await service.phpMyAdminSignOn(readySite, actor);
      expect(SiteDatabaseSignOnDtoSchema.parse(signOn)).toEqual({
        username: siteDatabaseSignOnUser(readySiteId),
        temporaryPassword: signOn.temporaryPassword,
      });
    });

    it("enforces site state locks on create/reset/grant/phpMyAdmin while keeping list/delete/revoke allowed", async () => {
      const notReadyMessage = "Site databases are not available until the site finishes updating.";
      for (const busySite of [deployingSite, maintenanceSite]) {
        await expect(service.createDatabase(busySite, actor, "shop")).rejects.toMatchObject({
          code: "RESOURCE_LOCKED",
          message: notReadyMessage,
          details: [expect.objectContaining({ reason: "not_ready", message: notReadyMessage })],
        });
        await expect(service.createUser(busySite, actor, "app")).rejects.toMatchObject({
          code: "RESOURCE_LOCKED",
          message: notReadyMessage,
          details: [expect.objectContaining({ reason: "not_ready", message: notReadyMessage })],
        });
        await expect(
          service.resetUserPassword(busySite, actor, `${siteDatabasePrefix(busySite.id)}_app`),
        ).rejects.toMatchObject({
          code: "RESOURCE_LOCKED",
          message: notReadyMessage,
          details: [expect.objectContaining({ reason: "not_ready", message: notReadyMessage })],
        });
        await expect(
          service.grant(
            busySite,
            actor,
            `${siteDatabasePrefix(busySite.id)}_app`,
            `${siteDatabasePrefix(busySite.id)}_shop`,
          ),
        ).rejects.toMatchObject({
          code: "RESOURCE_LOCKED",
          message: notReadyMessage,
          details: [expect.objectContaining({ reason: "not_ready", message: notReadyMessage })],
        });
        await expect(service.phpMyAdminSignOn(busySite, actor)).rejects.toMatchObject({
          code: "RESOURCE_LOCKED",
          message: notReadyMessage,
          details: [expect.objectContaining({ reason: "not_ready", message: notReadyMessage })],
        });
        await expect(service.assertPhpMyAdminAccess(busySite)).rejects.toMatchObject({
          code: "RESOURCE_LOCKED",
          message: notReadyMessage,
          details: [expect.objectContaining({ reason: "not_ready", message: notReadyMessage })],
        });

        await expect(service.list(busySite)).resolves.toMatchObject({
          prefix: siteDatabasePrefix(busySite.id),
        });
        await expect(
          service.deleteDatabase(busySite, actor, `${siteDatabasePrefix(busySite.id)}_shop`),
        ).resolves.toBeUndefined();
        await expect(
          service.deleteUser(busySite, actor, `${siteDatabasePrefix(busySite.id)}_app`),
        ).resolves.toBeUndefined();
        await expect(
          service.revoke(
            busySite,
            actor,
            `${siteDatabasePrefix(busySite.id)}_app`,
            `${siteDatabasePrefix(busySite.id)}_shop`,
          ),
        ).resolves.toBeUndefined();
      }
    });
  });
});
