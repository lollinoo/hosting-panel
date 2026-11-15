import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyRequest } from "fastify";
import {
  SHA512_CRYPT_HASH_PATTERN,
  SFTP_USERNAME_PATTERN,
  SftpAccessApplyIpcRequestSchema,
  SiteSftpDtoSchema,
  SiteSftpPasswordResetDtoSchema,
  SiteSftpUserCreatedDtoSchema,
  findForbiddenPublicDtoKeys,
} from "@hosting-panel/contracts";
import type {
  DatabaseClient,
  SftpDesiredUser,
  SiteSftpUserRow,
  SiteSftpUserSecretRow,
} from "@hosting-panel/database";
import {
  Phase1DisabledDockerExecutor,
  type DockerExecutorPort,
} from "@hosting-panel/executor-contracts";
import { ZodError } from "zod";
import { AuthzContextService } from "../src/auth/authz-context.service.js";
import type { OidcService } from "../src/auth/oidc.service.js";
import { ControlPlaneError } from "../src/common/control-plane.error.js";
import { SiteSftpController } from "../src/controllers/site-sftp.controller.js";
import type { ManagedSitesService } from "../src/sites/managed-sites.service.js";
import {
  SiteSftpService,
  sftpUsernamePrefix,
  type SiteRef,
} from "../src/sites/site-sftp.service.js";
import type { ControlPlaneRuntimeConfig } from "../src/tokens.js";

interface FakeAuditRow {
  readonly actorId: string | null;
  readonly organizationId: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly details: Record<string, unknown>;
}

const repoState = vi.hoisted(() => {
  const users = new Map<string, SiteSftpUserSecretRow>();
  const serviceBySite = new Map<string, string>();
  const suspendedOrgs = new Set<string>();
  const audits: FakeAuditRow[] = [];
  let hostIpv4: string | null = "203.0.113.10";
  let siteStatus: string | null = "ready";
  let extraDesiredKeys: Record<string, unknown> | null = null;
  let desiredOrderReversed = false;
  let forceUniqueViolationOnInsert = false;
  let forceDbErrorWithHashOnInsert = false;

  const reset = () => {
    users.clear();
    serviceBySite.clear();
    suspendedOrgs.clear();
    audits.length = 0;
    hostIpv4 = "203.0.113.10";
    siteStatus = "ready";
    extraDesiredKeys = null;
    desiredOrderReversed = false;
    forceUniqueViolationOnInsert = false;
    forceDbErrorWithHashOnInsert = false;
  };

  return {
    users,
    serviceBySite,
    suspendedOrgs,
    audits,
    get hostIpv4() {
      return hostIpv4;
    },
    set hostIpv4(val: string | null) {
      hostIpv4 = val;
    },
    get siteStatus() {
      return siteStatus;
    },
    set siteStatus(val: string | null) {
      siteStatus = val;
    },
    get extraDesiredKeys() {
      return extraDesiredKeys;
    },
    set extraDesiredKeys(val: Record<string, unknown> | null) {
      extraDesiredKeys = val;
    },
    get desiredOrderReversed() {
      return desiredOrderReversed;
    },
    set desiredOrderReversed(val: boolean) {
      desiredOrderReversed = val;
    },
    get forceUniqueViolationOnInsert() {
      return forceUniqueViolationOnInsert;
    },
    set forceUniqueViolationOnInsert(val: boolean) {
      forceUniqueViolationOnInsert = val;
    },
    get forceDbErrorWithHashOnInsert() {
      return forceDbErrorWithHashOnInsert;
    },
    set forceDbErrorWithHashOnInsert(val: boolean) {
      forceDbErrorWithHashOnInsert = val;
    },
    reset,
  };
});

vi.mock("@hosting-panel/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hosting-panel/database")>();

  const toPublic = (row: SiteSftpUserSecretRow): SiteSftpUserRow => ({
    id: row.id,
    organizationId: row.organizationId,
    siteId: row.siteId,
    username: row.username,
    createdAt: new Date(row.createdAt),
    passwordChangedAt: new Date(row.passwordChangedAt),
  });

  return {
    ...actual,
    listSiteSftpUsers: vi.fn(
      async (
        _db: unknown,
        k: { organizationId: string; siteId: string },
      ): Promise<SiteSftpUserRow[]> => {
        return [...repoState.users.values()]
          .filter((u) => u.organizationId === k.organizationId && u.siteId === k.siteId)
          .sort((a, b) => (a.username < b.username ? -1 : a.username > b.username ? 1 : 0))
          .map(toPublic);
      },
    ),
    getSiteSftpUser: vi.fn(
      async (
        _db: unknown,
        k: { organizationId: string; siteId: string; userId: string },
      ): Promise<SiteSftpUserSecretRow | null> => {
        const found = repoState.users.get(k.userId);
        if (!found || found.organizationId !== k.organizationId || found.siteId !== k.siteId) {
          return null;
        }
        return {
          ...found,
          createdAt: new Date(found.createdAt),
          passwordChangedAt: new Date(found.passwordChangedAt),
        };
      },
    ),
    insertSiteSftpUser: vi.fn(
      async (
        _db: unknown,
        row: {
          id: string;
          organizationId: string;
          siteId: string;
          username: string;
          passwordHash: string;
          createdAt?: Date;
          passwordChangedAt?: Date;
        },
      ): Promise<SiteSftpUserRow> => {
        if (repoState.forceDbErrorWithHashOnInsert) {
          throw new Error(`Failed query params: ${row.username}, ${row.passwordHash}`);
        }
        if (
          repoState.forceUniqueViolationOnInsert ||
          [...repoState.users.values()].some((u) => u.username === row.username)
        ) {
          const pgErr = Object.assign(new Error("duplicate key value violates unique constraint"), {
            code: "23505",
          });
          throw Object.assign(new Error("DrizzleQueryError"), { cause: pgErr });
        }
        const now = new Date();
        const stored: SiteSftpUserSecretRow = {
          id: row.id,
          organizationId: row.organizationId,
          siteId: row.siteId,
          username: row.username,
          passwordHash: row.passwordHash,
          createdAt: row.createdAt ? new Date(row.createdAt) : now,
          passwordChangedAt: row.passwordChangedAt ? new Date(row.passwordChangedAt) : now,
        };
        repoState.users.set(stored.id, stored);
        return toPublic(stored);
      },
    ),
    updateSiteSftpUserPassword: vi.fn(
      async (
        _db: unknown,
        k: {
          organizationId: string;
          siteId: string;
          userId: string;
          passwordHash: string;
          passwordChangedAt: Date;
        },
      ): Promise<boolean> => {
        const found = repoState.users.get(k.userId);
        if (!found || found.organizationId !== k.organizationId || found.siteId !== k.siteId) {
          return false;
        }
        repoState.users.set(k.userId, {
          ...found,
          passwordHash: k.passwordHash,
          passwordChangedAt: new Date(k.passwordChangedAt),
        });
        return true;
      },
    ),
    deleteSiteSftpUser: vi.fn(
      async (
        _db: unknown,
        k: { organizationId: string; siteId: string; userId: string },
      ): Promise<boolean> => {
        const found = repoState.users.get(k.userId);
        if (!found || found.organizationId !== k.organizationId || found.siteId !== k.siteId) {
          return false;
        }
        repoState.users.delete(k.userId);
        return true;
      },
    ),
    deleteSiteSftpUsersForSite: vi.fn(
      async (_db: unknown, k: { organizationId: string; siteId: string }): Promise<number> => {
        let count = 0;
        for (const [id, row] of repoState.users.entries()) {
          if (row.organizationId === k.organizationId && row.siteId === k.siteId) {
            repoState.users.delete(id);
            count += 1;
          }
        }
        return count;
      },
    ),
    listSftpDesiredState: vi.fn(
      async (_db: unknown, opts?: { excludeSiteId?: string }): Promise<SftpDesiredUser[]> => {
        const list: SftpDesiredUser[] = [];
        for (const row of repoState.users.values()) {
          if (opts?.excludeSiteId && row.siteId === opts.excludeSiteId) {
            continue;
          }
          if (repoState.suspendedOrgs.has(row.organizationId)) {
            continue;
          }
          const svcId = repoState.serviceBySite.get(row.siteId);
          if (!svcId) {
            continue;
          }
          list.push({
            username: row.username,
            passwordHash: row.passwordHash,
            siteId: row.siteId,
            serviceInstanceId: svcId,
            ...(repoState.extraDesiredKeys ?? {}),
          } as SftpDesiredUser);
        }
        list.sort((a, b) => (a.username < b.username ? -1 : a.username > b.username ? 1 : 0));
        if (repoState.desiredOrderReversed) {
          list.reverse();
        }
        return list;
      },
    ),
    appendAuditEvent: vi.fn(async (_db: unknown, input: FakeAuditRow) => {
      repoState.audits.push({
        actorId: input.actorId ?? null,
        organizationId: input.organizationId ?? null,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        details: (input.details ?? {}) as Record<string, unknown>,
      });
    }),
  };
});

class FakeDockerExecutor implements DockerExecutorPort {
  readonly #base: DockerExecutorPort = new Phase1DisabledDockerExecutor();
  public readonly isRuntimeAvailable = true;
  public readonly applySpy = vi.fn<DockerExecutorPort["applySftpAccess"]>();
  public readonly statusSpy = vi.fn<DockerExecutorPort["getSftpStatus"]>();

  public constructor() {
    this.applySpy.mockImplementation(async (req) => ({ applied: req.users.length }));
    this.statusSpy.mockResolvedValue({
      running: true,
      port: 2222,
      hostKeyFingerprint: "SHA256:DpQ/0ofF8CkAqPsHW7jwFQRyQl9a/6hX0T+BCi463zM",
    });
  }

  public deployService: DockerExecutorPort["deployService"] = (spec) =>
    this.#base.deployService(spec);
  public restartService: DockerExecutorPort["restartService"] = (id) =>
    this.#base.restartService(id);
  public stopService: DockerExecutorPort["stopService"] = (id) => this.#base.stopService(id);
  public deleteService: DockerExecutorPort["deleteService"] = (id) => this.#base.deleteService(id);
  public getObservedState: DockerExecutorPort["getObservedState"] = (id) =>
    this.#base.getObservedState(id);
  public runSiteJob: DockerExecutorPort["runSiteJob"] = (req) => this.#base.runSiteJob(req);
  public purgeSite: DockerExecutorPort["purgeSite"] = (siteId) => this.#base.purgeSite(siteId);
  public getServiceLogs: DockerExecutorPort["getServiceLogs"] = (id, tail) =>
    this.#base.getServiceLogs(id, tail);
  public applySiteRoutes: DockerExecutorPort["applySiteRoutes"] = (req) =>
    this.#base.applySiteRoutes(req);
  public getCertificateStatus: DockerExecutorPort["getCertificateStatus"] = (req) =>
    this.#base.getCertificateStatus(req);
  public applyMailRelay: DockerExecutorPort["applyMailRelay"] = (req) =>
    this.#base.applyMailRelay(req);
  public getMailRelayStatus: DockerExecutorPort["getMailRelayStatus"] = (req) =>
    this.#base.getMailRelayStatus(req);
  public sendTestMail: DockerExecutorPort["sendTestMail"] = (req) => this.#base.sendTestMail(req);
  public siteFiles: DockerExecutorPort["siteFiles"] = (req) => this.#base.siteFiles(req);
  public siteDatabases: DockerExecutorPort["siteDatabases"] = (req) =>
    this.#base.siteDatabases(req);

  public applySftpAccess: DockerExecutorPort["applySftpAccess"] = (req) => this.applySpy(req);
  public getSftpStatus: DockerExecutorPort["getSftpStatus"] = () => this.statusSpy();
  public backups: DockerExecutorPort["backups"] = (req) => this.#base.backups(req);
}

function createFakeDbClient(): DatabaseClient {
  const select = (cols?: Record<string, unknown>) => {
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      limit: async () => {
        if (cols && "status" in cols) {
          return repoState.siteStatus !== null ? [{ status: repoState.siteStatus }] : [];
        }
        return repoState.hostIpv4 !== null ? [{ ipv4: repoState.hostIpv4 }] : [];
      },
    };
    return chain;
  };

  return {
    mode: "pglite",
    db: {
      select,
    } as unknown as DatabaseClient["db"],
    migrate: async () => [],
    close: async () => undefined,
  };
}

function createConfig(
  overrides?: Partial<ControlPlaneRuntimeConfig>,
): ControlPlaneRuntimeConfig {
  return {
    oidcIssuer: "https://auth.local",
    oidcAudience: "hosting-panel-api",
    enableDevOidc: false,
    runtimeBackend: "linux-systemd",
    secretsMasterKey: Buffer.alloc(32, 1),
    jwtSigningKeyPem: null,
    autoProcessOutbox: false,
    sftpRetryIntervalMs: null,
    ...overrides,
  };
}

function createMockRequest(): FastifyRequest {
  return {
    headers: { "user-agent": "vitest/1.0" },
    ip: "127.0.0.1",
    id: "req_sftp_unit",
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as FastifyRequest;
}

describe("SiteSftpService & SiteSftpController (unit)", () => {
  const siteA: SiteRef = {
    id: "site_alpha_1",
    organizationId: "org_alpha",
    status: "ready",
  };
  const siteB: SiteRef = {
    id: "site_beta_2",
    organizationId: "org_beta",
    status: "ready",
  };

  let executor: FakeDockerExecutor;
  let dbClient: DatabaseClient;
  let service: SiteSftpService;

  beforeEach(() => {
    repoState.reset();
    repoState.serviceBySite.set(siteA.id, "svc_alpha_1");
    repoState.serviceBySite.set(siteB.id, "svc_beta_2");
    executor = new FakeDockerExecutor();
    dbClient = createFakeDbClient();
    service = new SiteSftpService(dbClient, executor, createConfig());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reports availability strictly from runtimeBackend === 'linux-systemd' and gates mutations", async () => {
    expect(service.isAvailable()).toBe(true);

    for (const backend of ["local-simulator", "disabled"] as const) {
      const unavailable = new SiteSftpService(
        dbClient,
        executor,
        createConfig({ runtimeBackend: backend }),
      );
      expect(unavailable.isAvailable()).toBe(false);

      const status = await unavailable.get(siteA);
      expect(status).toEqual({
        available: false,
        host: null,
        port: null,
        hostKeyFingerprint: null,
        users: [],
      });
      expect(executor.statusSpy).not.toHaveBeenCalled();

      await expect(unavailable.createUser(siteA, "dev1")).rejects.toMatchObject({
        code: "NOT_SUPPORTED",
      });
      await expect(unavailable.resetPassword(siteA, "usr_1")).rejects.toMatchObject({
        code: "NOT_SUPPORTED",
      });
      await expect(unavailable.deleteUser(siteA, "usr_1")).rejects.toMatchObject({
        code: "NOT_SUPPORTED",
      });
      expect(executor.applySpy).not.toHaveBeenCalled();
    }
  });

  it("builds deterministic login names, generates 24-char passwords, stores only $6$ hashes, and sends full desired state", async () => {
    const expectedPrefix = `s${createHash("sha256").update(siteA.id).digest("hex").slice(0, 8)}`;
    expect(sftpUsernamePrefix(siteA.id)).toBe(expectedPrefix);

    const otherSiteCreated = await service.createUser(siteB, "ops");
    const created = await service.createUser(siteA, "dev1");

    expect(created.user.username).toBe(`${expectedPrefix}_dev1`);
    expect(SFTP_USERNAME_PATTERN.test(created.user.username)).toBe(true);
    expect(created.temporaryPassword).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(SiteSftpUserCreatedDtoSchema.parse(created)).toEqual(created);
    expect(findForbiddenPublicDtoKeys(created)).toEqual([]);

    const stored = repoState.users.get(created.user.id);
    expect(stored).toBeDefined();
    expect(stored?.passwordHash.startsWith("$6$")).toBe(true);
    expect(SHA512_CRYPT_HASH_PATTERN.test(stored!.passwordHash)).toBe(true);
    expect(stored?.passwordHash).not.toContain(created.temporaryPassword);

    expect(executor.applySpy).toHaveBeenCalledTimes(2);
    const secondPayload = executor.applySpy.mock.calls[1]?.[0];
    expect(secondPayload?.users).toEqual([
      {
        username: created.user.username,
        passwordHash: stored!.passwordHash,
        siteId: siteA.id,
        serviceInstanceId: "svc_alpha_1",
      },
      {
        username: otherSiteCreated.user.username,
        passwordHash: repoState.users.get(otherSiteCreated.user.id)!.passwordHash,
        siteId: siteB.id,
        serviceInstanceId: "svc_beta_2",
      },
    ]);
  });

  it("enforces the 10-user limit per site (QUOTA_EXCEEDED: sftp_user_limit), username pattern, and duplicate username (ALREADY_EXISTS)", async () => {
    await expect(service.createUser(siteA, "bad_name")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });

    for (let i = 0; i < 10; i += 1) {
      await service.createUser(siteA, `u${i}`);
    }

    let limitErr: unknown;
    try {
      await service.createUser(siteA, "u10");
    } catch (err) {
      limitErr = err;
    }
    expect(limitErr).toBeInstanceOf(ControlPlaneError);
    expect((limitErr as ControlPlaneError).code).toBe("QUOTA_EXCEEDED");
    expect((limitErr as ControlPlaneError).details).toEqual([
      expect.objectContaining({ reason: "sftp_user_limit" }),
    ]);

    // Other site is unaffected by siteA's 10-user limit
    const siteBUser = await service.createUser(siteB, "u0");
    expect(siteBUser.user.username).toBe(`${sftpUsernamePrefix(siteB.id)}_u0`);

    // Duplicate name on siteB -> ALREADY_EXISTS
    let dupErr: unknown;
    try {
      await service.createUser(siteB, "u0");
    } catch (err) {
      dupErr = err;
    }
    expect(dupErr).toBeInstanceOf(ControlPlaneError);
    expect((dupErr as ControlPlaneError).code).toBe("ALREADY_EXISTS");
    expect((dupErr as ControlPlaneError).details).toEqual([
      expect.objectContaining({ reason: "exists" }),
    ]);
  });

  it("serializes concurrent mutations through one in-process queue so the 10-user limit cannot race", async () => {
    for (let i = 0; i < 9; i += 1) {
      await service.createUser(siteA, `u${i}`);
    }

    let enteredFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const order: string[] = [];

    executor.applySpy.mockImplementationOnce(async (req) => {
      order.push("apply-1-start");
      enteredFirst();
      await firstGate;
      order.push("apply-1-end");
      return { applied: req.users.length };
    });

    const p1 = service.createUser(siteA, "ninth");
    const p2 = service.createUser(siteA, "eleventh");

    await firstEntered;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(executor.applySpy).toHaveBeenCalledTimes(10);

    releaseFirst();
    const [r1, r2] = await Promise.allSettled([p1, p2]);
    expect(r1.status).toBe("fulfilled");
    expect(r2.status).toBe("rejected");
    expect((r2 as PromiseRejectedResult).reason).toMatchObject({ code: "QUOTA_EXCEEDED" });
    expect(order).toEqual(["apply-1-start", "apply-1-end"]);
  });

  it("compensates create, reset, and delete on apply failure or OPERATION_AMBIGUOUS, marks dirty, never replays blindly, and throws retryable DOCKER_ENGINE_UNAVAILABLE", async () => {
    const created = await service.createUser(siteA, "alice");
    const initialRow = { ...repoState.users.get(created.user.id)! };

    // 1. Create fails with OPERATION_AMBIGUOUS -> row deleted, dirty set, 1 apply attempt
    executor.applySpy.mockClear();
    executor.applySpy.mockRejectedValueOnce(
      Object.assign(new Error("Timed out waiting for response"), {
        code: "OPERATION_AMBIGUOUS",
        ambiguousOutcome: true,
      }),
    );

    let createErr: unknown;
    try {
      await service.createUser(siteA, "bob");
    } catch (err) {
      createErr = err;
    }
    expect(createErr).toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE", retryable: true });
    expect(executor.applySpy).toHaveBeenCalledTimes(1);
    expect(repoState.users.size).toBe(1);
    expect(repoState.users.get(created.user.id)).toEqual(initialRow);

    // Tick heals dirty flag once executor recovers
    await service.tick();
    expect(executor.applySpy).toHaveBeenCalledTimes(2);

    // 2. Reset fails -> old hash and passwordChangedAt restored, dirty set
    executor.applySpy.mockClear();
    executor.applySpy.mockRejectedValueOnce(
      Object.assign(new Error("docker engine down"), { code: "DOCKER_ENGINE_UNAVAILABLE" }),
    );
    let resetErr: unknown;
    try {
      await service.resetPassword(siteA, created.user.id);
    } catch (err) {
      resetErr = err;
    }
    expect(resetErr).toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE", retryable: true });
    expect(executor.applySpy).toHaveBeenCalledTimes(1);
    expect(repoState.users.get(created.user.id)).toEqual(initialRow);

    await service.tick();
    expect(executor.applySpy).toHaveBeenCalledTimes(2);

    // 3. Delete fails with OPERATION_AMBIGUOUS -> row re-inserted identically, dirty set
    executor.applySpy.mockClear();
    executor.applySpy.mockRejectedValueOnce(
      Object.assign(new Error("socket dropped"), { code: "OPERATION_AMBIGUOUS" }),
    );
    let deleteErr: unknown;
    try {
      await service.deleteUser(siteA, created.user.id);
    } catch (err) {
      deleteErr = err;
    }
    expect(deleteErr).toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE", retryable: true });
    expect(executor.applySpy).toHaveBeenCalledTimes(1);
    expect(repoState.users.get(created.user.id)).toEqual(initialRow);

    // Next tick re-applies because dirty is set, then subsequent tick is a no-op
    executor.applySpy.mockClear();
    await service.tick();
    expect(executor.applySpy).toHaveBeenCalledTimes(1);
    await service.tick();
    expect(executor.applySpy).toHaveBeenCalledTimes(1);
  });

  it("resets password and deletes user on success, and throws NOT_FOUND for unknown or cross-site userId", async () => {
    const created = await service.createUser(siteA, "alice");
    const oldHash = repoState.users.get(created.user.id)!.passwordHash;
    const oldChangedAt = repoState.users.get(created.user.id)!.passwordChangedAt;

    await expect(service.resetPassword(siteB, created.user.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(service.deleteUser(siteB, created.user.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    const resetResult = await service.resetPassword(siteA, created.user.id);
    expect(resetResult.username).toBe(created.user.username);
    expect(resetResult.temporaryPassword).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(SiteSftpPasswordResetDtoSchema.parse({ temporaryPassword: resetResult.temporaryPassword })).toEqual({
      temporaryPassword: resetResult.temporaryPassword,
    });

    const updatedRow = repoState.users.get(created.user.id)!;
    expect(updatedRow.passwordHash).not.toBe(oldHash);
    expect(updatedRow.passwordHash.startsWith("$6$")).toBe(true);
    expect(updatedRow.passwordChangedAt.getTime()).toBeGreaterThanOrEqual(oldChangedAt.getTime());

    const deleted = await service.deleteUser(siteA, created.user.id);
    expect(deleted).toEqual({ username: created.user.username });
    expect(repoState.users.has(created.user.id)).toBe(false);
    expect(executor.applySpy).toHaveBeenLastCalledWith({ users: [] });
  });

  it("background loop applies at start, on fingerprint change, when dirty, every 10th tick, and never crashes on failures", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const looped = new SiteSftpService(
      dbClient,
      executor,
      createConfig({ sftpRetryIntervalMs: 1_000 }),
    );

    // Tick 1 at start: fails once, logs only code, does not crash
    executor.applySpy.mockRejectedValueOnce(
      Object.assign(new Error("secret $6$hash should not log"), { code: "DOCKER_ENGINE_UNAVAILABLE" }),
    );
    looped.startBackgroundLoop();
    await looped.idle();
    expect(executor.applySpy).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(String(warn.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(logged).toEqual({ event: "sftp_apply_failed", code: "DOCKER_ENGINE_UNAVAILABLE" });

    // Tick 2: retries because dirty / unapplied
    await vi.advanceTimersByTimeAsync(1_000);
    await looped.idle();
    expect(executor.applySpy).toHaveBeenCalledTimes(2);

    // Ticks 3..9: desired state unchanged & clean -> skipped even if repository order differs
    repoState.desiredOrderReversed = true;
    for (let i = 3; i <= 9; i += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      await looped.idle();
    }
    expect(executor.applySpy).toHaveBeenCalledTimes(2);

    // Tick 10: forced re-apply
    await vi.advanceTimersByTimeAsync(1_000);
    await looped.idle();
    expect(executor.applySpy).toHaveBeenCalledTimes(3);

    // Out-of-band DB change alters fingerprint -> tick 11 re-applies
    repoState.users.set("sftp_oob", {
      id: "sftp_oob",
      organizationId: siteA.organizationId,
      siteId: siteA.id,
      username: `${sftpUsernamePrefix(siteA.id)}_oob`,
      passwordHash:
        "$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1",
      createdAt: new Date(),
      passwordChangedAt: new Date(),
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await looped.idle();
    expect(executor.applySpy).toHaveBeenCalledTimes(4);

    await looped.stop();
  });

  it("handles removeSite in all three cases: success after apply, unavailable deletes directly, failure keeps rows", async () => {
    const uA = await service.createUser(siteA, "one");
    const uB = await service.createUser(siteB, "two");
    executor.applySpy.mockClear();

    // Case 1: apply fails -> throws DOCKER_ENGINE_UNAVAILABLE and rows stay
    executor.applySpy.mockRejectedValueOnce(new Error("engine down"));
    await expect(service.removeSite(siteA.organizationId, siteA.id)).rejects.toMatchObject({
      code: "DOCKER_ENGINE_UNAVAILABLE",
      retryable: true,
    });
    expect(repoState.users.has(uA.user.id)).toBe(true);

    // Case 2: available & apply succeeds -> apply without siteA runs BEFORE rows are deleted
    let rowsDuringApply: boolean | undefined;
    executor.applySpy.mockImplementationOnce(async (req) => {
      rowsDuringApply = repoState.users.has(uA.user.id);
      return { applied: req.users.length };
    });
    await service.removeSite(siteA.organizationId, siteA.id);
    expect(rowsDuringApply).toBe(true);
    expect(repoState.users.has(uA.user.id)).toBe(false);
    expect(repoState.users.has(uB.user.id)).toBe(true);
    expect(executor.applySpy).toHaveBeenLastCalledWith({
      users: [
        {
          username: uB.user.username,
          passwordHash: repoState.users.get(uB.user.id)!.passwordHash,
          siteId: siteB.id,
          serviceInstanceId: "svc_beta_2",
        },
      ],
    });

    // Case 3: unavailable -> deletes rows without calling applySftpAccess
    executor.applySpy.mockClear();
    const disabledService = new SiteSftpService(
      dbClient,
      executor,
      createConfig({ runtimeBackend: "local-simulator" }),
    );
    await disabledService.removeSite(siteB.organizationId, siteB.id);
    expect(executor.applySpy).not.toHaveBeenCalled();
    expect(repoState.users.has(uB.user.id)).toBe(false);
  });

  it("GET returns host IPv4, port/fingerprint from status, falls back to null when getSftpStatus fails, and never returns hashes", async () => {
    const created = await service.createUser(siteA, "reader");

    const ok = await service.get(siteA);
    expect(SiteSftpDtoSchema.parse(ok)).toEqual({
      available: true,
      host: "203.0.113.10",
      port: 2222,
      hostKeyFingerprint: "SHA256:DpQ/0ofF8CkAqPsHW7jwFQRyQl9a/6hX0T+BCi463zM",
      users: [created.user],
    });
    expect(findForbiddenPublicDtoKeys(ok)).toEqual([]);
    expect("passwordHash" in ok.users[0]!).toBe(false);

    executor.statusSpy.mockRejectedValueOnce(new Error("status timeout"));
    const degraded = await service.get(siteA);
    expect(degraded).toEqual({
      available: true,
      host: "203.0.113.10",
      port: null,
      hostKeyFingerprint: null,
      users: [created.user],
    });
  });

  it("never leaks passwords or $6$ hashes in audit payloads or thrown errors", async () => {
    repoState.forceDbErrorWithHashOnInsert = true;
    let dbErr: unknown;
    try {
      await service.createUser(siteA, "leaktest");
    } catch (err) {
      dbErr = err;
    }
    expect(dbErr).toBeInstanceOf(ControlPlaneError);
    expect((dbErr as Error).message).not.toContain("$6$");
    repoState.forceDbErrorWithHashOnInsert = false;

    const authzStub = {
      authenticateRequest: vi.fn(async () => ({
        user: { id: "usr_owner", email: "o@x.test", name: "Owner", userStatus: "active" },
        claims: {},
        principal: {},
        activeMembershipSummaries: [],
      })),
      requireOrgPermission: vi.fn(async () => ({ allowed: true })),
      recordAudit: vi.fn(async (_auth, _req, input) => {
        repoState.audits.push({
          actorId: "usr_owner",
          organizationId: input.organizationId ?? null,
          action: input.action,
          targetType: input.targetType,
          targetId: input.targetId ?? null,
          details: input.details ?? {},
        });
      }),
    } as unknown as AuthzContextService;

    const sitesStub = {
      get: vi.fn(async (siteId: string, orgId: string) => {
        if (siteId !== siteA.id || orgId !== siteA.organizationId) {
          throw new ControlPlaneError(
            "NOT_FOUND",
            "Requested organization or resource was not found.",
          );
        }
        return {
          id: siteA.id,
          organizationId: siteA.organizationId,
          status: "ready",
        };
      }),
    } as unknown as ManagedSitesService;

    const controller = new SiteSftpController(authzStub, sitesStub, service);

    // Cross-tenant -> 404 before permission check
    await expect(
      controller.getSftp(createMockRequest(), "org_beta", siteA.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(authzStub.requireOrgPermission).not.toHaveBeenCalled();

    // GET checks site.sftp.manage
    const getRes = await controller.getSftp(createMockRequest(), siteA.organizationId, siteA.id);
    expect(getRes.data.available).toBe(true);
    expect(authzStub.requireOrgPermission).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        organizationId: siteA.organizationId,
        permission: "site.sftp.manage",
        targetType: "site",
        targetId: siteA.id,
      }),
    );

    // Invalid body schema -> ZodError
    await expect(
      controller.createUser(createMockRequest(), siteA.organizationId, siteA.id, {
        name: "bad_name",
      }),
    ).rejects.toBeInstanceOf(ZodError);

    // Create + Reset + Delete audit payloads contain only { userId, username }, never password or hash
    const createdRes = await controller.createUser(
      createMockRequest(),
      siteA.organizationId,
      siteA.id,
      { name: " Dev1 " },
    );
    const createdPw = createdRes.data.temporaryPassword;
    const createdHash = repoState.users.get(createdRes.data.user.id)!.passwordHash;

    const resetRes = await controller.resetPassword(
      createMockRequest(),
      siteA.organizationId,
      siteA.id,
      createdRes.data.user.id,
    );
    const resetPw = resetRes.data.temporaryPassword;
    const resetHash = repoState.users.get(createdRes.data.user.id)!.passwordHash;

    await controller.deleteUser(
      createMockRequest(),
      siteA.organizationId,
      siteA.id,
      createdRes.data.user.id,
    );

    expect(repoState.audits).toEqual([
      {
        actorId: "usr_owner",
        organizationId: siteA.organizationId,
        action: "site.sftp.user.create",
        targetType: "site",
        targetId: siteA.id,
        details: { userId: createdRes.data.user.id, username: createdRes.data.user.username },
      },
      {
        actorId: "usr_owner",
        organizationId: siteA.organizationId,
        action: "site.sftp.user.password_reset",
        targetType: "site",
        targetId: siteA.id,
        details: { userId: createdRes.data.user.id, username: createdRes.data.user.username },
      },
      {
        actorId: "usr_owner",
        organizationId: siteA.organizationId,
        action: "site.sftp.user.delete",
        targetType: "site",
        targetId: siteA.id,
        details: { userId: createdRes.data.user.id, username: createdRes.data.user.username },
      },
    ]);

    const serializedAudits = JSON.stringify(repoState.audits);
    expect(serializedAudits).not.toContain(createdPw);
    expect(serializedAudits).not.toContain(resetPw);
    expect(serializedAudits).not.toContain(createdHash);
    expect(serializedAudits).not.toContain(resetHash);
    expect(serializedAudits).not.toContain("$6$");

    // Denied attempt delegates to AuthzContextService.requireOrgPermission -> recordDeniedAudit
    const realAuthz = new AuthzContextService(dbClient, {} as OidcService);
    vi.spyOn(realAuthz, "authenticateRequest").mockResolvedValue({
      user: { id: "usr_collab", email: "c@x.test", name: "Collab", userStatus: "active" },
      claims: {
        issuer: "https://auth.local",
        subject: "usr_collab",
        audience: "hosting-panel-api",
        jti: "jti_1",
        rawPayload: { sub: "usr_collab" },
      },
      principal: {
        userId: "usr_collab",
        email: "c@x.test",
        userStatus: "active",
        globalRoles: [],
        hostingAdminOrgIds: [],
        memberships: [
          {
            membershipId: "mem_1",
            organizationId: siteA.organizationId,
            organizationStatus: "active",
            membershipStatus: "active",
            roleBindings: [
              {
                roleName: "customer_collaborator",
                permissions: [{ permission: "organization.read", effect: "allow" }],
                scopeType: "organization",
                scopeResourceId: null,
              },
            ],
            resourceGrants: [],
          },
        ],
        supportGrants: [],
      },
      activeMembershipSummaries: [],
    });
    repoState.audits.length = 0;
    const guardedController = new SiteSftpController(realAuthz, sitesStub, service);
    await expect(
      guardedController.getSftp(createMockRequest(), siteA.organizationId, siteA.id),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(repoState.audits).toEqual([
      expect.objectContaining({
        actorId: "usr_collab",
        organizationId: siteA.organizationId,
        action: "site.sftp.manage",
        targetType: "site",
        targetId: siteA.id,
        details: expect.objectContaining({ outcome: "denied" }),
      }),
    ]);
  });

  it("refuses createUser and resetPassword when site is maintenance, deploying, or missing (404), while keeping deleteUser allowed", async () => {
    const existing = await service.createUser(siteA, "existing");
    const existingHash = repoState.users.get(existing.user.id)!.passwordHash;
    executor.applySpy.mockClear();

    for (const badStatus of ["maintenance", "deploying"] as const) {
      repoState.siteStatus = badStatus;
      let createErr: unknown;
      try {
        await service.createUser(siteA, "blocked");
      } catch (err) {
        createErr = err;
      }
      expect(createErr).toBeInstanceOf(ControlPlaneError);
      expect((createErr as ControlPlaneError).code).toBe("RESOURCE_LOCKED");
      expect((createErr as ControlPlaneError).details).toEqual([
        expect.objectContaining({ reason: "not_ready" }),
      ]);

      let resetErr: unknown;
      try {
        await service.resetPassword(siteA, existing.user.id);
      } catch (err) {
        resetErr = err;
      }
      expect(resetErr).toBeInstanceOf(ControlPlaneError);
      expect((resetErr as ControlPlaneError).code).toBe("RESOURCE_LOCKED");
      expect((resetErr as ControlPlaneError).details).toEqual([
        expect.objectContaining({ reason: "not_ready" }),
      ]);
      expect(repoState.users.get(existing.user.id)!.passwordHash).toBe(existingHash);
    }

    repoState.siteStatus = null;
    await expect(service.createUser(siteA, "missing")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(service.resetPassword(siteA, existing.user.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(repoState.users.size).toBe(1);
    expect(executor.applySpy).not.toHaveBeenCalled();

    // Re-read inside #queue: site becomes maintenance while first apply is in flight.
    repoState.siteStatus = "ready";
    let releaseInFlight!: () => void;
    const inFlightGate = new Promise<void>((resolve) => {
      releaseInFlight = resolve;
    });
    executor.applySpy.mockImplementationOnce(async (req) => {
      await inFlightGate;
      return { applied: req.users.length };
    });
    const pFirst = service.createUser(siteA, "first");
    await Promise.resolve();
    await Promise.resolve();
    const pQueued = service.createUser(siteA, "queued");
    repoState.siteStatus = "maintenance";
    releaseInFlight();
    await expect(pFirst).resolves.toBeDefined();
    await expect(pQueued).rejects.toMatchObject({
      code: "RESOURCE_LOCKED",
      details: [expect.objectContaining({ reason: "not_ready" })],
    });
    expect(repoState.users.size).toBe(2);
    expect(executor.applySpy).toHaveBeenCalledTimes(1);

    // Delete stays allowed in every status (including maintenance).
    repoState.siteStatus = "maintenance";
    await expect(service.deleteUser(siteA, existing.user.id)).resolves.toEqual({
      username: existing.user.username,
    });
    expect(repoState.users.size).toBe(1);
    expect(executor.applySpy).toHaveBeenCalledTimes(2);
  });

  it("removeSite resolves without calling applySftpAccess when the site has no SFTP users, even when apply rejects", async () => {
    executor.applySpy.mockRejectedValueOnce(new Error("HOST_POLICY_DENIED"));
    await expect(service.removeSite(siteA.organizationId, siteA.id)).resolves.toBeUndefined();
    expect(executor.applySpy).not.toHaveBeenCalled();
  });

  it("next tick calls applySftpAccess with the exact changed desired list when organization status changes", async () => {
    const userA = await service.createUser(siteA, "alpha");
    const userB = await service.createUser(siteB, "beta");
    const hashA = repoState.users.get(userA.user.id)!.passwordHash;
    const hashB = repoState.users.get(userB.user.id)!.passwordHash;
    executor.applySpy.mockClear();

    await service.tick();
    expect(executor.applySpy).not.toHaveBeenCalled();

    // Org alpha suspended -> userA omitted from desired state
    repoState.suspendedOrgs.add(siteA.organizationId);
    await service.tick();
    expect(executor.applySpy).toHaveBeenCalledTimes(1);
    expect(executor.applySpy).toHaveBeenLastCalledWith({
      users: [
        {
          username: userB.user.username,
          passwordHash: hashB,
          siteId: siteB.id,
          serviceInstanceId: "svc_beta_2",
        },
      ],
    });

    // Org alpha reactivated -> userA restored on next tick
    repoState.suspendedOrgs.delete(siteA.organizationId);
    await service.tick();
    expect(executor.applySpy).toHaveBeenCalledTimes(2);
    expect(executor.applySpy).toHaveBeenLastCalledWith({
      users: expect.arrayContaining([
        {
          username: userA.user.username,
          passwordHash: hashA,
          siteId: siteA.id,
          serviceInstanceId: "svc_alpha_1",
        },
        {
          username: userB.user.username,
          passwordHash: hashB,
          siteId: siteB.id,
          serviceInstanceId: "svc_beta_2",
        },
      ]),
    });
  });

  it("rejects queued create, reset, and delete with retryable DOCKER_ENGINE_UNAVAILABLE after > 8 s queue wait without touching DB or executor, while tick and removeSite are not limited", async () => {
    vi.useFakeTimers();
    const seed = await service.createUser(siteB, "seed");
    executor.applySpy.mockClear();

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    executor.applySpy.mockImplementationOnce(async (req) => {
      await firstGate;
      return { applied: req.users.length };
    });

    const p1 = service.createUser(siteA, "first");
    await Promise.resolve();
    await Promise.resolve();

    const p2Create = service.createUser(siteA, "second");
    const p3Reset = service.resetPassword(siteB, seed.user.id);
    const p4Delete = service.deleteUser(siteB, seed.user.id);

    await vi.advanceTimersByTimeAsync(9_000);
    releaseFirst();

    await expect(p1).resolves.toMatchObject({ user: { username: expect.stringContaining("_first") } });
    await expect(p2Create).rejects.toMatchObject({
      code: "DOCKER_ENGINE_UNAVAILABLE",
      retryable: true,
    });
    await expect(p3Reset).rejects.toMatchObject({
      code: "DOCKER_ENGINE_UNAVAILABLE",
      retryable: true,
    });
    await expect(p4Delete).rejects.toMatchObject({
      code: "DOCKER_ENGINE_UNAVAILABLE",
      retryable: true,
    });

    expect(executor.applySpy).toHaveBeenCalledTimes(1);
    expect(repoState.users.size).toBe(2);
    expect(repoState.users.has(seed.user.id)).toBe(true);

    // Tick and removeSite are not limited by the 8 s wait check even behind a 9 s apply.
    let releaseTickBlocker!: () => void;
    const tickBlocker = new Promise<void>((resolve) => {
      releaseTickBlocker = resolve;
    });
    executor.applySpy.mockImplementationOnce(async (req) => {
      await tickBlocker;
      return { applied: req.users.length };
    });

    const pSlow = service.createUser(siteA, "slow");
    await Promise.resolve();
    await Promise.resolve();

    const pRemove = service.removeSite(siteB.organizationId, siteB.id);
    const pTick = service.tick();

    await vi.advanceTimersByTimeAsync(9_000);
    releaseTickBlocker();

    await expect(pSlow).resolves.toBeDefined();
    await expect(pRemove).resolves.toBeUndefined();
    await expect(pTick).resolves.toBeUndefined();
    expect(repoState.users.has(seed.user.id)).toBe(false);
  });

  it("sends strictly { users: [{ username, passwordHash, siteId, serviceInstanceId }] } with no extra keys", async () => {
    repoState.extraDesiredKeys = { organizationId: "org_alpha", extra: true };
    await service.createUser(siteA, "strict");

    expect(executor.applySpy).toHaveBeenCalledTimes(1);
    const sent = executor.applySpy.mock.calls[0]![0];
    expect(Object.keys(sent)).toEqual(["users"]);
    expect(sent.users).toHaveLength(1);
    expect(Object.keys(sent.users[0]!).sort()).toEqual([
      "passwordHash",
      "serviceInstanceId",
      "siteId",
      "username",
    ]);
    expect(SftpAccessApplyIpcRequestSchema.parse(sent)).toEqual(sent);
  });
});
