import { describe, expect, it, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import {
  PERMISSION_KEYS,
  SITE_FILE_ERROR_REASONS,
  SITE_FILE_REASON_CODES,
  findForbiddenPublicDtoKeys,
  findPlaintextSecretKeys,
} from "@hosting-panel/contracts";
import {
  DEMO_IDS,
  auditEvents,
  createDatabaseClient,
  ensurePresetRolesAndPermissions,
  ensureWordpressTemplate,
  eq,
  operationSteps,
  operations,
  outboxEvents,
  rolePermissions,
  seedPhase1Dataset,
  serviceInstances,
  sites,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import {
  Phase1DisabledDockerExecutor,
  type DockerExecutorPort,
  type SiteFilesRequest,
  type SiteFilesResult,
} from "@hosting-panel/executor-contracts";
import type { HostAgentPort } from "@hosting-panel/host-agent-contracts";
import { ControlPlaneError } from "../src/common/control-plane.error.js";
import type { ControlPlaneRuntimeConfig } from "../src/tokens.js";
import { AuthzContextService } from "../src/auth/authz-context.service.js";
import { OidcService } from "../src/auth/oidc.service.js";
import { OutboxWorkerService } from "../src/runtime/outbox-worker.service.js";
import { SiteProvisioner } from "../src/runtime/site-provisioner.js";
import { SiteDomainsApplier } from "../src/sites/site-domains-applier.js";
import { ManagedSitesService } from "../src/sites/managed-sites.service.js";
import {
  SiteFilesService,
  mapSiteFileExecutorError,
  type SiteFilesActor,
  type SiteFilesSiteRef,
} from "../src/sites/site-files.service.js";
import { SiteFilesApplier } from "../src/sites/site-files-applier.js";
import { SiteFilesController } from "../src/controllers/site-files.controller.js";

class MockDockerExecutor implements DockerExecutorPort {
  readonly #base: DockerExecutorPort = new Phase1DisabledDockerExecutor();
  public readonly isRuntimeAvailable: boolean;
  public readonly siteFilesSpy = vi.fn<(req: SiteFilesRequest) => Promise<unknown>>();

  public constructor(isRuntimeAvailable: boolean = true) {
    this.isRuntimeAvailable = isRuntimeAvailable;
    this.siteFilesSpy.mockImplementation(async (req) => {
      switch (req.op) {
        case "list":
          return { entries: [], truncated: false };
        case "stat":
          return {
            entry: {
              name: "",
              type: "dir",
              size: 0,
              modifiedAt: new Date(0).toISOString(),
              protected: false,
            },
          };
        case "read":
          return { dataBase64: "", size: 0, eof: true };
        case "write":
          return { received: 0 };
        case "mkdir":
        case "move":
        case "delete":
          return {};
        case "archive":
        case "extract":
          return { entries: 0 };
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

  public async siteFiles<R extends SiteFilesRequest>(
    req: R,
  ): Promise<SiteFilesResult<R["op"]>> {
    return (await this.siteFilesSpy(req)) as SiteFilesResult<R["op"]>;
  }
}

class ExecutorFailure extends Error {
  public readonly code: string;
  public readonly ambiguousOutcome?: boolean;

  public constructor(message: string, code: string, ambiguousOutcome?: boolean) {
    super(message);
    this.name = "ExecutorFailure";
    this.code = code;
    if (ambiguousOutcome !== undefined) {
      this.ambiguousOutcome = ambiguousOutcome;
    }
  }
}

function createRuntimeConfig(
  overrides?: Partial<ControlPlaneRuntimeConfig>,
): ControlPlaneRuntimeConfig {
  return {
    oidcIssuer: "https://issuer.local",
    oidcAudience: "hosting-panel-api",
    enableDevOidc: true,
    runtimeBackend: "local-simulator",
    secretsMasterKey: randomBytes(32),
    jwtSigningKeyPem: null,
    autoProcessOutbox: false,
    ...overrides,
  };
}

function createActor(id: string = DEMO_IDS.users.elena): SiteFilesActor {
  return {
    id,
    ipAddress: "127.0.0.1",
    userAgent: "vitest-unit/1.0",
    requestId: "req_unit_files",
  };
}

function createMockRequest(
  headers: Record<string, string | string[] | undefined> = {},
): FastifyRequest {
  return {
    headers,
    ip: "127.0.0.1",
    id: "req_ctrl_unit",
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as FastifyRequest;
}

describe("SiteFilesService, SiteFilesApplier, OutboxWorker & Permissions (unit)", () => {
  let dbClient: DatabaseClient;
  let executor: MockDockerExecutor;
  let config: ControlPlaneRuntimeConfig;
  let service: SiteFilesService;
  let applier: SiteFilesApplier;
  let outboxWorker: OutboxWorkerService;
  let baselineAuditIds: Set<string>;

  async function listNewAudits() {
    const rows = await dbClient.db.select().from(auditEvents);
    return rows.filter((row) => !baselineAuditIds.has(row.id));
  }

  async function snapshotAudits(): Promise<void> {
    const rows = await dbClient.db.select({ id: auditEvents.id }).from(auditEvents);
    baselineAuditIds = new Set(rows.map((r) => r.id));
  }

  const readySiteId = "site_files_unit_ready";
  const readyServiceId = "svc_files_unit_wp";
  const deployingSiteId = "site_files_unit_deploying";
  const maintenanceSiteId = "site_files_unit_maint";
  const noServiceSiteId = "site_files_unit_nosvc";

  const readySite: SiteFilesSiteRef = {
    id: readySiteId,
    organizationId: DEMO_IDS.organizations.acme,
    status: "ready",
  };

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await ensureWordpressTemplate(dbClient.db);
    await ensurePresetRolesAndPermissions(dbClient.db);
    config = createRuntimeConfig();
    await seedPhase1Dataset(dbClient.db, config.secretsMasterKey);

    await dbClient.db
      .insert(sites)
      .values([
        {
          id: readySiteId,
          organizationId: DEMO_IDS.organizations.acme,
          hostAllocationId: DEMO_IDS.allocations.acme,
          name: "Files Unit Ready Site",
          slug: "files-unit-ready",
          status: "ready",
          phpVersion: "8.3",
        },
        {
          id: deployingSiteId,
          organizationId: DEMO_IDS.organizations.acme,
          hostAllocationId: DEMO_IDS.allocations.acme,
          name: "Files Unit Deploying Site",
          slug: "files-unit-deploying",
          status: "deploying",
          phpVersion: "8.3",
        },
        {
          id: maintenanceSiteId,
          organizationId: DEMO_IDS.organizations.acme,
          hostAllocationId: DEMO_IDS.allocations.acme,
          name: "Files Unit Maintenance Site",
          slug: "files-unit-maint",
          status: "maintenance",
          phpVersion: "8.3",
        },
        {
          id: noServiceSiteId,
          organizationId: DEMO_IDS.organizations.acme,
          hostAllocationId: DEMO_IDS.allocations.acme,
          name: "Files Unit No-Service Site",
          slug: "files-unit-nosvc",
          status: "ready",
          phpVersion: "8.3",
        },
      ])
      .onConflictDoNothing();

    await dbClient.db
      .insert(serviceInstances)
      .values({
        id: readyServiceId,
        siteId: readySiteId,
        organizationId: DEMO_IDS.organizations.acme,
        serviceTemplateId: DEMO_IDS.templates.wordpress,
        name: "Files Unit Web",
        desiredStatus: "running",
      })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await dbClient.close();
  });

  beforeEach(async () => {
    executor = new MockDockerExecutor(true);
    config = createRuntimeConfig();
    service = new SiteFilesService(dbClient, executor, config);
    applier = new SiteFilesApplier(dbClient, executor, config);
    outboxWorker = new OutboxWorkerService(
      dbClient,
      executor,
      {} as unknown as HostAgentPort,
      config,
      {} as unknown as SiteProvisioner,
      {} as unknown as SiteDomainsApplier,
      applier,
    );

    await dbClient.db.delete(outboxEvents);
    await dbClient.db.delete(operationSteps);
    await dbClient.db.delete(operations);
    await snapshotAudits();
    await dbClient.db
      .update(sites)
      .set({ status: "ready" })
      .where(eq(sites.id, readySiteId));
  });

  it("ensurePresetRolesAndPermissions is idempotent and seeds site.files permissions", async () => {
    await ensurePresetRolesAndPermissions(dbClient.db);
    await ensurePresetRolesAndPermissions(dbClient.db);

    const ownerPerms = await dbClient.db
      .select({ key: rolePermissions.permissionKey })
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, DEMO_IDS.roles.customer_owner));
    const ownerSet = new Set(ownerPerms.map((p) => p.key));

    const collabPerms = await dbClient.db
      .select({ key: rolePermissions.permissionKey })
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, DEMO_IDS.roles.customer_collaborator));
    const collabSet = new Set(collabPerms.map((p) => p.key));

    const hostingPerms = await dbClient.db
      .select({ key: rolePermissions.permissionKey })
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, DEMO_IDS.roles.hosting_admin));
    const hostingSet = new Set(hostingPerms.map((p) => p.key));

    expect(PERMISSION_KEYS).toContain("site.files.read");
    expect(PERMISSION_KEYS).toContain("site.files.write");
    expect(ownerSet.has("site.files.read")).toBe(true);
    expect(ownerSet.has("site.files.write")).toBe(true);
    expect(hostingSet.has("site.files.read")).toBe(true);
    expect(hostingSet.has("site.files.write")).toBe(true);
    expect(collabSet.has("site.files.read")).toBe(false);
    expect(collabSet.has("site.files.write")).toBe(false);
  });

  describe("R2 error mapping", () => {
    it.each(SITE_FILE_ERROR_REASONS)(
      "maps known executor reason '%s' to exact code and safe details reason",
      async (reason) => {
        const expectedCode = SITE_FILE_REASON_CODES[reason];
        executor.siteFilesSpy.mockRejectedValueOnce(new ExecutorFailure(reason, expectedCode));

        let caught: unknown;
        try {
          await service.list(readySite, createActor(), { path: "" });
        } catch (err) {
          caught = err;
        }

        expect(caught).toBeInstanceOf(ControlPlaneError);
        const cpErr = caught as ControlPlaneError;
        expect(cpErr.code).toBe(expectedCode);
        expect(cpErr.details).toEqual([
          expect.objectContaining({
            reason,
            message: expect.any(String),
          }),
        ]);
        expect(cpErr.message).not.toMatch(/\/var\/|docker|container|volume/i);
      },
    );

    it("never exposes unknown executor message text, host paths, Docker names, or a reason", async () => {
      const secretLeak =
        "container wp_acme_1 failed opening /var/lib/docker/volumes/site_1/webroot/wp-config.php: EACCES";
      executor.siteFilesSpy.mockRejectedValueOnce(
        new ExecutorFailure(secretLeak, "PERMISSION_DENIED"),
      );

      let caught: unknown;
      try {
        await service.list(readySite, createActor(), { path: "" });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ControlPlaneError);
      const cpErr = caught as ControlPlaneError;
      expect(cpErr.code).toBe("PERMISSION_DENIED");
      expect(cpErr.details).toEqual([]);
      expect(cpErr.message).not.toContain("wp_acme_1");
      expect(cpErr.message).not.toContain("/var/lib/docker");
      expect(cpErr.message).not.toContain("EACCES");
      expect(cpErr.message).not.toContain("container");
    });

    it("maps uncoded unknown executor error to DOCKER_ENGINE_UNAVAILABLE with no reason", () => {
      const mapped = mapSiteFileExecutorError(new Error("connect ECONNREFUSED /run/docker.sock"));
      expect(mapped.code).toBe("DOCKER_ENGINE_UNAVAILABLE");
      expect(mapped.details).toEqual([]);
      expect(mapped.message).not.toContain("docker.sock");
      expect(mapped.message).not.toContain("ECONNREFUSED");
    });
  });

  describe("readiness and runtime gates", () => {
    it("returns RESOURCE_LOCKED with reason 'not_ready' when site is deploying, maintenance, or lacks service", async () => {
      for (const blocked of [
        { id: deployingSiteId, organizationId: DEMO_IDS.organizations.acme, status: "deploying" },
        { id: maintenanceSiteId, organizationId: DEMO_IDS.organizations.acme, status: "maintenance" },
        { id: noServiceSiteId, organizationId: DEMO_IDS.organizations.acme, status: "ready" },
      ]) {
        let caught: unknown;
        try {
          await service.list(blocked, createActor(), { path: "" });
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(ControlPlaneError);
        const cpErr = caught as ControlPlaneError;
        expect(cpErr.code).toBe("RESOURCE_LOCKED");
        expect(cpErr.details).toEqual([
          expect.objectContaining({
            reason: "not_ready",
          }),
        ]);
      }

      expect(executor.siteFilesSpy).not.toHaveBeenCalled();
    });

    it("returns NOT_SUPPORTED when executor runtime is unavailable or backend is disabled", async () => {
      const offlineExecutor = new MockDockerExecutor(false);
      const offlineService = new SiteFilesService(dbClient, offlineExecutor, config);
      await expect(
        offlineService.list(readySite, createActor(), { path: "" }),
      ).rejects.toMatchObject({ code: "NOT_SUPPORTED" });

      const disabledService = new SiteFilesService(
        dbClient,
        new MockDockerExecutor(true),
        createRuntimeConfig({ runtimeBackend: "disabled" }),
      );
      await expect(
        disabledService.list(readySite, createActor(), { path: "" }),
      ).rejects.toMatchObject({ code: "NOT_SUPPORTED" });

      expect(offlineExecutor.siteFilesSpy).not.toHaveBeenCalled();
    });
  });

  describe("sync mutations & audit events", () => {
    it("audits upload once on the final chunk only with { path, size }", async () => {
      const uploadId = "11111111-1111-4111-8111-111111111111";
      const chunkOne = Buffer.from("hello ").toString("base64");
      const chunkTwo = Buffer.from("world").toString("base64");

      executor.siteFilesSpy
        .mockResolvedValueOnce({ received: 6 })
        .mockResolvedValueOnce({ received: 11 });

      const r1 = await service.write(readySite, createActor(), {
        path: "wp-content/test.txt",
        uploadId,
        offset: 0,
        dataBase64: chunkOne,
        final: false,
        overwrite: true,
      });
      expect(r1).toEqual({ received: 6 });
      expect(await listNewAudits()).toHaveLength(0);

      const r2 = await service.write(readySite, createActor(), {
        path: "wp-content/test.txt",
        uploadId,
        offset: 6,
        dataBase64: chunkTwo,
        final: true,
        overwrite: true,
      });
      expect(r2).toEqual({ received: 11 });

      const events = await listNewAudits();
      expect(events).toHaveLength(1);
      expect(events[0]?.action).toBe("site.files.upload");
      expect(events[0]?.targetType).toBe("site");
      expect(events[0]?.targetId).toBe(readySiteId);
      expect(events[0]?.details).toMatchObject({
        path: "wp-content/test.txt",
        size: 11,
      });
    });

    it("audits mkdir, move, and delete once with capped relative paths and count", async () => {
      await service.mkdir(readySite, createActor(), { path: "wp-content/uploads/2026" });
      await service.move(readySite, createActor(), {
        from: "wp-content/a.txt",
        to: "wp-content/b.txt",
      });

      const longPath = `dir/${"a".repeat(300)}.txt`;
      const paths = [longPath, ...Array.from({ length: 24 }, (_, i) => `dir/f_${String(i)}.txt`)];
      await service.remove(readySite, createActor(), { paths });

      const events = await listNewAudits();
      const byAction = new Map(events.map((e) => [e.action, e.details as Record<string, unknown>]));

      expect(events).toHaveLength(3);
      expect(byAction.get("site.files.folder.create")).toMatchObject({
        path: "wp-content/uploads/2026",
      });
      expect(byAction.get("site.files.move")).toMatchObject({
        from: "wp-content/a.txt",
        to: "wp-content/b.txt",
      });

      const deleteDetails = byAction.get("site.files.delete");
      expect(deleteDetails).toBeDefined();
      expect(deleteDetails?.["count"]).toBe(25);
      const recordedPaths = deleteDetails?.["paths"] as string[];
      expect(recordedPaths).toHaveLength(20);
      expect(recordedPaths[0]?.length).toBeLessThanOrEqual(256);
    });
  });

  describe("async archive/extract enqueue, applier, and recovery", () => {
    it("enqueues archive and extract with Idempotency-Key, replay safety, site lock, and clean outbox payloads", async () => {
      const accepted = await service.enqueueArchive(readySite, createActor(), {
        body: { paths: ["wp-content", "index.php"], to: "backup.zip" },
        idempotencyKey: "key-arch-1",
      });
      expect(accepted.siteId).toBe(readySiteId);

      // Replay with exact same key returns same operationId without extra audit
      const replayed = await service.enqueueArchive(readySite, createActor(), {
        body: { paths: ["wp-content", "index.php"], to: "backup.zip" },
        idempotencyKey: "key-arch-1",
      });
      expect(replayed).toEqual(accepted);

      // Reusing same key for extract conflicts
      await expect(
        service.enqueueExtract(readySite, createActor(), {
          body: { path: "backup.zip", to: "restore" },
          idempotencyKey: "key-arch-1",
        }),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

      // Different key while site lock is held returns RESOURCE_LOCKED
      await expect(
        service.enqueueExtract(readySite, createActor(), {
          body: { path: "backup.zip", to: "restore" },
          idempotencyKey: "key-ext-2",
        }),
      ).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });

      const [op] = await dbClient.db
        .select()
        .from(operations)
        .where(eq(operations.id, accepted.operationId));
      expect(op?.kind).toBe("site.files.archive");
      expect(op?.lockKey).toBe(`site:${readySiteId}`);

      const evts = await dbClient.db
        .select()
        .from(outboxEvents)
        .where(eq(outboxEvents.aggregateId, readySiteId));
      const evt = evts.find(
        (e) => (e.payload as Record<string, unknown>)["operationId"] === accepted.operationId,
      );
      expect(evt).toBeDefined();
      const payload = evt?.payload as Record<string, unknown>;
      expect(findPlaintextSecretKeys(payload)).toEqual([]);
      expect(findForbiddenPublicDtoKeys(payload)).toEqual([]);

      const audits = await listNewAudits();
      expect(audits).toHaveLength(1);
      expect(audits[0]?.action).toBe("site.files.archive");
      expect(audits[0]?.details).toMatchObject({
        paths: ["wp-content", "index.php"],
        count: 2,
        to: "backup.zip",
        operationId: accepted.operationId,
      });
    });

    it("executes archive and extract successfully via OutboxWorkerService & SiteFilesApplier with entry count in step message", async () => {
      const arch = await service.enqueueArchive(readySite, createActor(), {
        body: { paths: ["wp-content"], to: "snap.zip" },
        idempotencyKey: "key-run-arch",
      });

      executor.siteFilesSpy.mockResolvedValueOnce({ entries: 42 });
      const archRun = await outboxWorker.processPendingOnce(10);
      expect(archRun).toEqual({ claimed: 1, succeeded: 1, failed: 0 });

      const [archOp] = await dbClient.db
        .select()
        .from(operations)
        .where(eq(operations.id, arch.operationId));
      expect(archOp?.status).toBe("succeeded");

      const [archStep] = await dbClient.db
        .select()
        .from(operationSteps)
        .where(eq(operationSteps.operationId, arch.operationId));
      expect(archStep?.key).toBe("archive_files");
      expect(archStep?.status).toBe("succeeded");
      expect(archStep?.message).toContain("42");

      const ext = await service.enqueueExtract(readySite, createActor(), {
        body: { path: "snap.zip", to: "restored" },
        idempotencyKey: "key-run-ext",
      });
      executor.siteFilesSpy.mockResolvedValueOnce({ entries: 17 });
      const extRun = await outboxWorker.processPendingOnce(10);
      expect(extRun).toEqual({ claimed: 1, succeeded: 1, failed: 0 });

      const [extStep] = await dbClient.db
        .select()
        .from(operationSteps)
        .where(eq(operationSteps.operationId, ext.operationId));
      expect(extStep?.key).toBe("extract_files");
      expect(extStep?.status).toBe("succeeded");
      expect(extStep?.message).toContain("17");

      expect(executor.siteFilesSpy).toHaveBeenNthCalledWith(1, {
        serviceInstanceId: readyServiceId,
        op: "archive",
        paths: ["wp-content"],
        to: "snap.zip",
      });
      expect(executor.siteFilesSpy).toHaveBeenNthCalledWith(2, {
        serviceInstanceId: readyServiceId,
        op: "extract",
        path: "snap.zip",
        to: "restored",
      });
    });

    it("settles applier refusal (ALREADY_EXISTS) and executor failure (DOCKER_ENGINE_UNAVAILABLE) safely without degrading site", async () => {
      const refusalOp = await service.enqueueArchive(readySite, createActor(), {
        body: { paths: ["index.php"], to: "existing.zip" },
        idempotencyKey: "key-refusal",
      });
      executor.siteFilesSpy.mockRejectedValueOnce(new ExecutorFailure("exists", "ALREADY_EXISTS"));

      const r1 = await outboxWorker.processPendingOnce(10);
      expect(r1).toEqual({ claimed: 1, succeeded: 0, failed: 1 });

      const [op1] = await dbClient.db
        .select()
        .from(operations)
        .where(eq(operations.id, refusalOp.operationId));
      expect(op1?.status).toBe("failed");
      expect(op1?.errorCode).toBe("ALREADY_EXISTS");

      const execFailOp = await service.enqueueExtract(readySite, createActor(), {
        body: { path: "snap.zip", to: "" },
        idempotencyKey: "key-exec-fail",
      });
      executor.siteFilesSpy.mockRejectedValueOnce(
        new ExecutorFailure(
          "dockerd unix:///var/run/docker.sock failed on container cnt_wp_1",
          "DOCKER_ENGINE_UNAVAILABLE",
        ),
      );

      const r2 = await outboxWorker.processPendingOnce(10);
      expect(r2).toEqual({ claimed: 1, succeeded: 0, failed: 1 });

      const [op2] = await dbClient.db
        .select()
        .from(operations)
        .where(eq(operations.id, execFailOp.operationId));
      expect(op2?.status).toBe("failed");
      expect(op2?.errorCode).toBe("DOCKER_ENGINE_UNAVAILABLE");
      expect(op2?.errorMessage).not.toContain("/var/run/docker.sock");
      expect(op2?.errorMessage).not.toContain("cnt_wp_1");

      const [siteAfter] = await dbClient.db
        .select()
        .from(sites)
        .where(eq(sites.id, readySiteId));
      expect(siteAfter?.status).toBe("ready");
    });

    it("recovers unknown archive/extract operations as failed without replaying executor or degrading site", async () => {
      const arch = await service.enqueueArchive(readySite, createActor(), {
        body: { paths: ["wp-content"], to: "crashed.zip" },
        idempotencyKey: "key-recover-1",
      });

      const past = new Date(Date.now() - 60_000);
      await dbClient.db
        .update(operations)
        .set({ status: "processing", leaseExpiresAt: past })
        .where(eq(operations.id, arch.operationId));
      await dbClient.db
        .update(operationSteps)
        .set({ status: "running", startedAt: past })
        .where(eq(operationSteps.operationId, arch.operationId));

      const recovery = await outboxWorker.recoverUnknownOperations(new Date());
      expect(recovery).toMatchObject({ markedUnknown: 1, convergedFailed: 1 });
      expect(executor.siteFilesSpy).not.toHaveBeenCalled();

      const [opAfter] = await dbClient.db
        .select()
        .from(operations)
        .where(eq(operations.id, arch.operationId));
      expect(opAfter?.status).toBe("failed");
      expect(opAfter?.errorCode).toBe("OPERATION_INTERRUPTED");

      const [siteAfter] = await dbClient.db
        .select()
        .from(sites)
        .where(eq(sites.id, readySiteId));
      expect(siteAfter?.status).toBe("ready");
    });

    it("parks ambiguous IPC failure as unknown and later recovers without replay or site degradation", async () => {
      const ext = await service.enqueueExtract(readySite, createActor(), {
        body: { path: "ambiguous.zip", to: "out" },
        idempotencyKey: "key-ambig-1",
      });

      executor.siteFilesSpy.mockRejectedValueOnce(
        new ExecutorFailure("IPC socket closed mid-request", "OPERATION_AMBIGUOUS", true),
      );

      const run = await outboxWorker.processPendingOnce(10);
      expect(run).toEqual({ claimed: 1, succeeded: 0, failed: 1 });

      const [opUnknown] = await dbClient.db
        .select()
        .from(operations)
        .where(eq(operations.id, ext.operationId));
      expect(opUnknown?.status).toBe("unknown");
      expect(opUnknown?.errorCode).toBe("OPERATION_AMBIGUOUS");

      executor.siteFilesSpy.mockClear();
      const recovery = await outboxWorker.recoverUnknownOperations(new Date());
      expect(recovery).toMatchObject({ markedUnknown: 0, convergedFailed: 1 });
      expect(executor.siteFilesSpy).not.toHaveBeenCalled();

      const [opRecovered] = await dbClient.db
        .select()
        .from(operations)
        .where(eq(operations.id, ext.operationId));
      expect(opRecovered?.status).toBe("failed");
      expect(opRecovered?.errorCode).toBe("OPERATION_INTERRUPTED");

      const [siteAfter] = await dbClient.db
        .select()
        .from(sites)
        .where(eq(sites.id, readySiteId));
      expect(siteAfter?.status).toBe("ready");
    });
  });

  describe("SiteFilesController gates and protected refusal handling", () => {
    it("enforces org-scoped site lookup, permissions, suspended-org read vs write, Idempotency-Key, and skips denied audit on executor protected refusal", async () => {
      const oidcStub = {} as unknown as OidcService;
      const authzService = new AuthzContextService(dbClient, oidcStub);
      let currentUserId: string = DEMO_IDS.users.elena;
      vi.spyOn(authzService, "authenticateRequest").mockImplementation(async () => {
        const [user] = await dbClient.db
          .select()
          .from(users)
          .where(eq(users.id, currentUserId))
          .limit(1);
        if (!user) throw new Error(`Missing test user ${currentUserId}`);
        const loaded = await authzService.loadPrincipalContextForUser(user);
        return {
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            userStatus: user.userStatus,
          },
          claims: {
            issuer: config.oidcIssuer,
            subject: user.id,
            audience: config.oidcAudience,
            jti: "jti_unit",
            email: user.email,
            displayName: user.name,
            rawPayload: { sub: user.id },
          },
          principal: loaded.principal,
          activeMembershipSummaries: loaded.activeMembershipSummaries,
        };
      });

      const sitesService = new ManagedSitesService(dbClient, config, executor);
      const triggerAsyncSpy = vi.spyOn(outboxWorker, "triggerAsync").mockImplementation(() => {});
      const controller = new SiteFilesController(
        authzService,
        sitesService,
        service,
        outboxWorker,
      );

      // 1. Cross-org site lookup -> 404 before permission check
      await expect(
        controller.listFiles(
          createMockRequest(),
          DEMO_IDS.organizations.beta,
          readySiteId,
          {},
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      // 2. Customer collaborator lacks site.files.read -> 403 + denied audit
      currentUserId = DEMO_IDS.users.marco;
      await expect(
        controller.listFiles(
          createMockRequest(),
          DEMO_IDS.organizations.acme,
          readySiteId,
          {},
        ),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      const deniedAudits = (await listNewAudits()).filter(
        (a) =>
          a.action === "site.files.read" &&
          (a.details as Record<string, unknown>)["outcome"] === "denied",
      );
      expect(deniedAudits).toHaveLength(1);

      // 3. Executor PERMISSION_DENIED with reason 'protected' throws without writing denied audit
      await snapshotAudits();
      currentUserId = DEMO_IDS.users.elena;
      executor.siteFilesSpy.mockRejectedValueOnce(
        new ExecutorFailure("protected", "PERMISSION_DENIED"),
      );
      await expect(
        controller.deleteFiles(
          createMockRequest(),
          DEMO_IDS.organizations.acme,
          readySiteId,
          { paths: ["wp-config.php"] },
        ),
      ).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
        details: [expect.objectContaining({ reason: "protected" })],
      });
      const auditsAfterProtected = await listNewAudits();
      expect(auditsAfterProtected).toHaveLength(0);

      // 4. Suspended org (Gamma): read passes readiness (gammaLegacy is stopped -> ready for files if service exists), write blocked with ORGANIZATION_SUSPENDED
      currentUserId = DEMO_IDS.users.giulia;
      const listRes = await controller.listFiles(
        createMockRequest(),
        DEMO_IDS.organizations.gamma,
        DEMO_IDS.sites.gammaLegacy,
        { path: "" },
      );
      expect(listRes).toEqual({ data: { entries: [], truncated: false } });
      await expect(
        controller.createFolder(
          createMockRequest(),
          DEMO_IDS.organizations.gamma,
          DEMO_IDS.sites.gammaLegacy,
          { path: "notes" },
        ),
      ).rejects.toMatchObject({ code: "ORGANIZATION_SUSPENDED" });

      // 5. Archive requires Idempotency-Key and returns { data, links } triggering outbox
      currentUserId = DEMO_IDS.users.elena;
      await expect(
        controller.archiveFiles(
          createMockRequest(),
          DEMO_IDS.organizations.acme,
          readySiteId,
          { paths: ["index.php"], to: "site.zip" },
        ),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

      const accepted = await controller.archiveFiles(
        createMockRequest({ "idempotency-key": "http-arch-key-1" }),
        DEMO_IDS.organizations.acme,
        readySiteId,
        { paths: ["index.php"], to: "site.zip" },
      );
      expect(accepted.data.siteId).toBe(readySiteId);
      expect(accepted.links.operation).toBe(
        `/v1/organizations/${DEMO_IDS.organizations.acme}/operations/${accepted.data.operationId}`,
      );
      expect(triggerAsyncSpy).toHaveBeenCalledTimes(1);

      // 6. Write accepts a full 512 KiB chunk encoded as base64 (~700 KB JSON)
      const fullChunkBase64 = Buffer.alloc(524_288, 0x61).toString("base64");
      executor.siteFilesSpy.mockResolvedValueOnce({ received: 524_288 });
      const writeRes = await controller.writeFileContent(
        createMockRequest(),
        DEMO_IDS.organizations.acme,
        readySiteId,
        {
          path: "wp-content/large.bin",
          uploadId: "22222222-2222-4222-8222-222222222222",
          offset: 0,
          dataBase64: fullChunkBase64,
          final: true,
          overwrite: true,
        },
      );
      expect(writeRes).toEqual({ data: { received: 524_288 } });
    });
  });
});
