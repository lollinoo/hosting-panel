import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  type ErrorCode,
  ERROR_CODES,
  isSftpAvailable,
  SFTP_USERNAME_PATTERN,
  SITE_SFTP_MAX_USERS,
  type SiteSftpDto,
  type SiteSftpPasswordResetDto,
  type SiteSftpUserCreatedDto,
  type SiteSftpUserDto,
} from "@hosting-panel/contracts";
import {
  and,
  type DatabaseClient,
  deleteSiteSftpUser,
  deleteSiteSftpUsersForSite,
  eq,
  getSiteSftpUser,
  hostAllocations,
  hosts,
  insertSiteSftpUser,
  listSftpDesiredState,
  listSiteSftpUsers,
  sites,
  type SftpDesiredUser,
  type SiteSftpUserRow,
  updateSiteSftpUserPassword,
} from "@hosting-panel/database";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
import { ControlPlaneError } from "../common/control-plane.error.js";
import {
  CONTROL_PLANE_CONFIG_TOKEN,
  type ControlPlaneRuntimeConfig,
  DATABASE_CLIENT_TOKEN,
  DOCKER_EXECUTOR_TOKEN,
} from "../tokens.js";
import { sha512Crypt } from "./sha512-crypt.js";
import { siteFileReasonError } from "./site-files.service.js";

/** Minimal site reference required for site-scoped SFTP operations. */
export interface SiteRef {
  readonly id: string;
  readonly organizationId: string;
  readonly status: string;
}

const FORCED_APPLY_EVERY_TICKS = 10;
const GENERATED_PASSWORD_BYTES = 18;
const SFTP_MUTATION_QUEUE_WAIT_MS = 8_000;
const SAFE_ERROR_CODES = new Set<string>(ERROR_CODES);

/** Deterministic per-site OS username prefix surviving organization reassignment. */
export function sftpUsernamePrefix(siteId: string): string {
  return `s${createHash("sha256").update(siteId).digest("hex").slice(0, 8)}`;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function fingerprintDesiredState(users: readonly SftpDesiredUser[]): string {
  const canonical = [...users]
    .sort(
      (a, b) =>
        compareText(a.username, b.username) ||
        compareText(a.siteId, b.siteId) ||
        compareText(a.serviceInstanceId, b.serviceInstanceId),
    )
    .map((u) => [u.username, u.passwordHash, u.siteId, u.serviceInstanceId]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toUserDto(row: SiteSftpUserRow): SiteSftpUserDto {
  return {
    id: row.id,
    username: row.username,
    createdAt: toIsoString(row.createdAt),
    passwordChangedAt: toIsoString(row.passwordChangedAt),
  };
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    return false;
  }
  const rec = err as { code?: unknown; cause?: unknown };
  if (rec.code === "23505") {
    return true;
  }
  if (typeof rec.cause === "object" && rec.cause !== null) {
    return (rec.cause as { code?: unknown }).code === "23505";
  }
  return false;
}

function extractSafeErrorCode(err: unknown): ErrorCode {
  if (err instanceof ControlPlaneError) {
    return err.code;
  }
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && SAFE_ERROR_CODES.has(code)) {
      return code as ErrorCode;
    }
  }
  return "DOCKER_ENGINE_UNAVAILABLE";
}

function sftpApplyUnavailableError(): ControlPlaneError {
  return new ControlPlaneError(
    "DOCKER_ENGINE_UNAVAILABLE",
    "SFTP configuration could not be applied on the host.",
    { retryable: true },
  );
}

/**
 * Manages per-site SFTP accounts, desired-state synchronization to the host agent,
 * compensating DB rollback on apply failures, and background retry reconciliation.
 */
@Injectable()
export class SiteSftpService {
  #serial: Promise<void> = Promise.resolve();
  #running: Promise<void> | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #ticks = 0;
  #stopped = false;
  #dirty = false;
  #appliedFingerprint: string | null = null;

  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(DOCKER_EXECUTOR_TOKEN) private readonly dockerExecutor: DockerExecutorPort,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) private readonly config: ControlPlaneRuntimeConfig,
  ) {}

  /** Returns true when the configured runtime backend supports SFTP management. */
  public isAvailable(): boolean {
    return isSftpAvailable(this.config.runtimeBackend);
  }

  /** Returns site SFTP endpoint status and non-secret user accounts for a managed site. */
  public async get(site: SiteRef): Promise<SiteSftpDto> {
    if (!this.isAvailable()) {
      return {
        available: false,
        host: null,
        port: null,
        hostKeyFingerprint: null,
        users: [],
      };
    }

    const [host, rows, status] = await Promise.all([
      this.#hostIpv4(site),
      listSiteSftpUsers(this.dbClient.db, {
        organizationId: site.organizationId,
        siteId: site.id,
      }),
      this.#readSftpStatusSafely(),
    ]);

    return {
      available: true,
      host,
      port: status.port,
      hostKeyFingerprint: status.hostKeyFingerprint,
      users: rows.map(toUserDto),
    };
  }

  /**
   * Creates an SFTP user for a site, returning the generated password once while storing
   * only its SHA-512 crypt hash and compensating DB state if host apply fails.
   */
  public async createUser(site: SiteRef, name: string): Promise<SiteSftpUserCreatedDto> {
    this.#assertAvailable();
    const username = `${sftpUsernamePrefix(site.id)}_${name}`;
    if (!/^[a-z0-9]{1,16}$/.test(name) || !SFTP_USERNAME_PATTERN.test(username)) {
      throw new ControlPlaneError("VALIDATION_ERROR", "SFTP username suffix is invalid.", {
        details: [
          {
            field: "name",
            reason: "invalid_format",
            message: "Must be 1-16 lowercase alphanumeric characters.",
          },
        ],
      });
    }

    return this.#queue(async () => {
      await this.#assertSiteReady(site);

      const existingUsers = await listSiteSftpUsers(this.dbClient.db, {
        organizationId: site.organizationId,
        siteId: site.id,
      });
      if (existingUsers.length >= SITE_SFTP_MAX_USERS) {
        throw new ControlPlaneError(
          "QUOTA_EXCEEDED",
          `Maximum of ${SITE_SFTP_MAX_USERS} SFTP users per site reached.`,
          {
            details: [
              {
                reason: "sftp_user_limit",
                message: `Maximum of ${SITE_SFTP_MAX_USERS} SFTP users per site reached.`,
              },
            ],
          },
        );
      }

      const temporaryPassword = randomBytes(GENERATED_PASSWORD_BYTES).toString("base64url");
      const passwordHash = sha512Crypt(temporaryPassword);
      const now = new Date();
      const userId = randomUUID();

      let created: SiteSftpUserRow;
      try {
        created = await insertSiteSftpUser(this.dbClient.db, {
          id: userId,
          organizationId: site.organizationId,
          siteId: site.id,
          username,
          passwordHash,
          createdAt: now,
          passwordChangedAt: now,
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ControlPlaneError(
            "ALREADY_EXISTS",
            "An SFTP user with that name already exists.",
            {
              details: [
                {
                  field: "name",
                  reason: "exists",
                  message: "An SFTP user with that name already exists.",
                },
              ],
            },
          );
        }
        throw new ControlPlaneError("INTERNAL_ERROR", "Failed to save SFTP user.");
      }

      try {
        const desired = await listSftpDesiredState(this.dbClient.db);
        await this.#applyAndRecord(desired);
      } catch {
        this.#dirty = true;
        try {
          await deleteSiteSftpUser(this.dbClient.db, {
            organizationId: site.organizationId,
            siteId: site.id,
            userId: created.id,
          });
        } catch {
          console.warn(JSON.stringify({ event: "sftp_compensation_failed", action: "create" }));
        }
        throw sftpApplyUnavailableError();
      }

      return {
        user: toUserDto(created),
        temporaryPassword,
      };
    }, SFTP_MUTATION_QUEUE_WAIT_MS);
  }

  /**
   * Generates a new password for an SFTP user and compensates back to the previous hash
   * and timestamp if host apply fails or returns an ambiguous outcome.
   */
  public async resetPassword(
    site: SiteRef,
    userId: string,
  ): Promise<SiteSftpPasswordResetDto & { username: string }> {
    this.#assertAvailable();

    return this.#queue(async () => {
      await this.#assertSiteReady(site);

      const existing = await getSiteSftpUser(this.dbClient.db, {
        organizationId: site.organizationId,
        siteId: site.id,
        userId,
      });
      if (!existing) {
        throw new ControlPlaneError("NOT_FOUND", "SFTP user not found.");
      }

      const temporaryPassword = randomBytes(GENERATED_PASSWORD_BYTES).toString("base64url");
      const passwordHash = sha512Crypt(temporaryPassword);
      const passwordChangedAt = new Date();

      let updated: boolean;
      try {
        updated = await updateSiteSftpUserPassword(this.dbClient.db, {
          organizationId: site.organizationId,
          siteId: site.id,
          userId,
          passwordHash,
          passwordChangedAt,
        });
      } catch {
        throw new ControlPlaneError("INTERNAL_ERROR", "Failed to update SFTP password.");
      }
      if (!updated) {
        throw new ControlPlaneError("NOT_FOUND", "SFTP user not found.");
      }

      try {
        const desired = await listSftpDesiredState(this.dbClient.db);
        await this.#applyAndRecord(desired);
      } catch {
        this.#dirty = true;
        try {
          await updateSiteSftpUserPassword(this.dbClient.db, {
            organizationId: existing.organizationId,
            siteId: existing.siteId,
            userId: existing.id,
            passwordHash: existing.passwordHash,
            passwordChangedAt: existing.passwordChangedAt,
          });
        } catch {
          console.warn(
            JSON.stringify({ event: "sftp_compensation_failed", action: "password_reset" }),
          );
        }
        throw sftpApplyUnavailableError();
      }

      return {
        temporaryPassword,
        username: existing.username,
      };
    }, SFTP_MUTATION_QUEUE_WAIT_MS);
  }

  /**
   * Deletes an SFTP user from a site and re-inserts the prior record on host apply failure.
   */
  public async deleteUser(site: SiteRef, userId: string): Promise<{ username: string }> {
    this.#assertAvailable();

    return this.#queue(async () => {
      const existing = await getSiteSftpUser(this.dbClient.db, {
        organizationId: site.organizationId,
        siteId: site.id,
        userId,
      });
      if (!existing) {
        throw new ControlPlaneError("NOT_FOUND", "SFTP user not found.");
      }

      const deleted = await deleteSiteSftpUser(this.dbClient.db, {
        organizationId: site.organizationId,
        siteId: site.id,
        userId,
      });
      if (!deleted) {
        throw new ControlPlaneError("NOT_FOUND", "SFTP user not found.");
      }

      try {
        const desired = await listSftpDesiredState(this.dbClient.db);
        await this.#applyAndRecord(desired);
      } catch {
        this.#dirty = true;
        try {
          await insertSiteSftpUser(this.dbClient.db, {
            id: existing.id,
            organizationId: existing.organizationId,
            siteId: existing.siteId,
            username: existing.username,
            passwordHash: existing.passwordHash,
            createdAt: existing.createdAt,
            passwordChangedAt: existing.passwordChangedAt,
          });
        } catch {
          console.warn(JSON.stringify({ event: "sftp_compensation_failed", action: "delete" }));
        }
        throw sftpApplyUnavailableError();
      }

      return { username: existing.username };
    }, SFTP_MUTATION_QUEUE_WAIT_MS);
  }

  /**
   * Removes SFTP configuration for a site before deleting its database rows so failed host
   * updates fail site deletion instead of orphaning OS/SSHD access.
   */
  public async removeSite(organizationId: string, siteId: string): Promise<void> {
    return this.#queue(async () => {
      if (!this.isAvailable()) {
        await deleteSiteSftpUsersForSite(this.dbClient.db, { organizationId, siteId });
        return;
      }

      const existingUsers = await listSiteSftpUsers(this.dbClient.db, { organizationId, siteId });
      if (existingUsers.length === 0) {
        return;
      }

      const desired = await listSftpDesiredState(this.dbClient.db, { excludeSiteId: siteId });
      try {
        await this.#applyAndRecord(desired);
      } catch {
        this.#dirty = true;
        throw sftpApplyUnavailableError();
      }

      await deleteSiteSftpUsersForSite(this.dbClient.db, { organizationId, siteId });
    });
  }

  /** Applies the current database SFTP desired state if dirty, changed, or forced. */
  public async ensureApplied(force = false): Promise<void> {
    if (!this.isAvailable()) {
      return;
    }

    await this.#queue(async () => {
      const desired = await listSftpDesiredState(this.dbClient.db);
      const fingerprint = fingerprintDesiredState(desired);
      if (!force && !this.#dirty && fingerprint === this.#appliedFingerprint) {
        return;
      }
      try {
        await this.#applyAndRecord(desired, fingerprint);
      } catch (err) {
        this.#dirty = true;
        const code = extractSafeErrorCode(err);
        throw new ControlPlaneError(code, "SFTP configuration could not be applied on the host.", {
          retryable: true,
        });
      }
    });
  }

  /** Starts the periodic background reconciliation loop when an interval is configured. */
  public startBackgroundLoop(): void {
    if (!this.isAvailable() || this.#stopped || this.#timer) {
      return;
    }
    const intervalMs = this.config.sftpRetryIntervalMs;
    if (intervalMs === null || intervalMs === undefined || intervalMs <= 0) {
      return;
    }
    void this.tick();
    this.#timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.#timer.unref();
  }

  /** Runs a single reconciliation tick, forcing an apply on every tenth tick. */
  public tick(): Promise<void> {
    if (this.#stopped) {
      return Promise.resolve();
    }
    const run = (this.#running ?? Promise.resolve()).then(async () => {
      if (this.#stopped) {
        return;
      }
      this.#ticks += 1;
      const force = this.#ticks % FORCED_APPLY_EVERY_TICKS === 0;
      try {
        await this.ensureApplied(force);
      } catch (err) {
        console.warn(
          JSON.stringify({
            event: "sftp_apply_failed",
            code: extractSafeErrorCode(err),
          }),
        );
      }
    });
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.#running = settled;
    return settled;
  }

  /** Resolves when any in-flight tick and queued operations have completed. */
  public async idle(): Promise<void> {
    while (this.#running) {
      const current = this.#running;
      await current;
      if (this.#running === current) {
        this.#running = null;
      }
    }
    await this.#serial;
  }

  /** Stops the background loop and waits for queued work to finish. */
  public async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.idle();
  }

  #assertAvailable(): void {
    if (!this.isAvailable()) {
      throw new ControlPlaneError(
        "NOT_SUPPORTED",
        "Site SFTP management requires the linux-systemd runtime backend.",
      );
    }
  }

  async #assertSiteReady(site: SiteRef): Promise<void> {
    const [current] = await this.dbClient.db
      .select({ status: sites.status })
      .from(sites)
      .where(and(eq(sites.id, site.id), eq(sites.organizationId, site.organizationId)))
      .limit(1);
    if (!current) {
      throw new ControlPlaneError(
        "NOT_FOUND",
        "Requested organization or resource was not found.",
      );
    }
    if (current.status === "deploying" || current.status === "maintenance") {
      throw siteFileReasonError("not_ready");
    }
  }

  async #applyAndRecord(
    desired: readonly SftpDesiredUser[],
    precomputedFingerprint?: string,
  ): Promise<void> {
    const result = await this.dockerExecutor.applySftpAccess({
      users: desired.map((u) => ({
        username: u.username,
        passwordHash: u.passwordHash,
        siteId: u.siteId,
        serviceInstanceId: u.serviceInstanceId,
      })),
    });
    if (!result || typeof result.applied !== "number" || !Number.isInteger(result.applied)) {
      throw sftpApplyUnavailableError();
    }
    this.#appliedFingerprint = precomputedFingerprint ?? fingerprintDesiredState(desired);
    this.#dirty = false;
  }

  async #hostIpv4(site: SiteRef): Promise<string | null> {
    const rows = await this.dbClient.db
      .select({ ipv4: hosts.ipv4Address })
      .from(sites)
      .innerJoin(hostAllocations, eq(sites.hostAllocationId, hostAllocations.id))
      .innerJoin(hosts, eq(hostAllocations.hostId, hosts.id))
      .where(and(eq(sites.id, site.id), eq(sites.organizationId, site.organizationId)))
      .limit(1);
    return rows[0]?.ipv4 ?? null;
  }

  async #readSftpStatusSafely(): Promise<{
    readonly port: number | null;
    readonly hostKeyFingerprint: string | null;
  }> {
    try {
      const status = await this.dockerExecutor.getSftpStatus();
      return {
        port: typeof status?.port === "number" ? status.port : null,
        hostKeyFingerprint:
          typeof status?.hostKeyFingerprint === "string" ? status.hostKeyFingerprint : null,
      };
    } catch {
      return { port: null, hostKeyFingerprint: null };
    }
  }

  async #queue<T>(fn: () => Promise<T>, maxWaitMs?: number): Promise<T> {
    const queuedAt = Date.now();
    const run = () => {
      if (maxWaitMs !== undefined && Date.now() - queuedAt > maxWaitMs) {
        throw sftpApplyUnavailableError();
      }
      return fn();
    };
    const next = this.#serial.then(run, run);
    this.#serial = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
