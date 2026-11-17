import { randomInt } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  type ErrorCode,
  isPhpMyAdminAvailable,
  mysqlNativePasswordHash,
  SITE_DATABASE_SIGNON_USER_PATTERN,
  SITE_DATABASE_SUFFIX_PATTERN,
  SITE_DATABASE_USERS_MAX,
  SITE_DATABASES_MAX,
  type SiteDatabaseCreatedDto,
  type SiteDatabaseDto,
  type SiteDatabasePasswordResetDto,
  type SiteDatabasesDto,
  SiteDatabasesDtoSchema,
  type SiteDatabaseSignOnDto,
  SiteDatabaseSuffixSchema,
  type SiteDatabaseUserCreatedDto,
  type SiteDatabaseUserDto,
  siteDatabaseFullName,
  siteDatabasePrefix,
  isSiteDatabaseName,
} from "@hosting-panel/contracts";
import { and, type DatabaseClient, eq, sites } from "@hosting-panel/database";
import type {
  DockerExecutorPort,
  SiteDatabasesRequest,
  SiteDatabasesResult,
} from "@hosting-panel/executor-contracts";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import {
  type AuthenticatedRequestContext,
  AuthzContextService,
} from "../auth/authz-context.service.js";
import { ControlPlaneError } from "../common/control-plane.error.js";
import {
  CONTROL_PLANE_CONFIG_TOKEN,
  type ControlPlaneRuntimeConfig,
  DATABASE_CLIENT_TOKEN,
  DOCKER_EXECUTOR_TOKEN,
} from "../tokens.js";
import type { SiteRef } from "./site-sftp.service.js";

export type { SiteRef };

/** Authenticated caller context required by site database mutations for audit recording. */
export interface SiteDatabaseActor {
  readonly auth: AuthenticatedRequestContext;
  readonly req: FastifyRequest;
}

type SiteDatabaseAuditAction =
  | "site.database.create"
  | "site.database.delete"
  | "site.database.user.create"
  | "site.database.user.password_reset"
  | "site.database.user.delete"
  | "site.database.grant"
  | "site.database.revoke"
  | "site.database.phpmyadmin.open";

const PASSWORD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const GENERATED_PASSWORD_LENGTH = 24;
const PathNameSchema = z.string().min(1).max(64);

const PASS_CODES = new Set<ErrorCode>([
  "VALIDATION_ERROR",
  "ALREADY_EXISTS",
  "NOT_FOUND",
  "QUOTA_EXCEEDED",
  "RESOURCE_LOCKED",
  "NOT_SUPPORTED",
]);

const SAFE_ERROR_MESSAGES: Partial<Readonly<Record<ErrorCode, string>>> = {
  VALIDATION_ERROR: "This name cannot be used.",
  ALREADY_EXISTS: "This name is already used on this site.",
  NOT_FOUND: "Requested organization or resource was not found.",
  QUOTA_EXCEEDED: "This site has reached its database limit.",
  RESOURCE_LOCKED: "Another change is in progress.",
  NOT_SUPPORTED: "Not available on this server.",
};

/** Generates a 24-character [A-Za-z0-9] password (~143 bits of entropy). */
export function generateDatabasePassword(): string {
  return Array.from(
    { length: GENERATED_PASSWORD_LENGTH },
    () => PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)]!,
  ).join("");
}

/** Builds a retryable 503 error for unavailable or unclear database operations. */
export function databasesUnavailableError(): ControlPlaneError {
  return new ControlPlaneError(
    "DOCKER_ENGINE_UNAVAILABLE",
    "Databases could not be updated right now.",
    { retryable: true },
  );
}

/** Maps executor/IPC failures to the D12 code set; ambiguous or unknown errors become retryable 503. */
export function mapSiteDatabaseExecutorError(err: unknown): ControlPlaneError {
  if (err instanceof ControlPlaneError) {
    return err;
  }
  const rec =
    typeof err === "object" && err !== null
      ? (err as { code?: unknown; ambiguousOutcome?: unknown })
      : {};
  if (
    rec.ambiguousOutcome !== true &&
    typeof rec.code === "string" &&
    PASS_CODES.has(rec.code as ErrorCode)
  ) {
    const code = rec.code as ErrorCode;
    return new ControlPlaneError(code, SAFE_ERROR_MESSAGES[code]!);
  }
  return databasesUnavailableError();
}

function protectedError(): ControlPlaneError {
  return new ControlPlaneError(
    "VALIDATION_ERROR",
    "The site's own database and user are managed by the platform.",
    {
      details: [{ message: "protected", reason: "protected" }],
    },
  );
}

function notFound(): ControlPlaneError {
  return new ControlPlaneError("NOT_FOUND", SAFE_ERROR_MESSAGES.NOT_FOUND!);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePrimaryFirst<T extends { readonly primary: boolean; readonly name: string }>(
  a: T,
  b: T,
): number {
  if (a.primary !== b.primary) {
    return a.primary ? -1 : 1;
  }
  return compareText(a.name, b.name);
}

/**
 * Domain service for site MariaDB databases, database users, grants, and phpMyAdmin sign-on.
 * Methods accept `(site, actor, ...)` and write success audits directly so future admin views inherit them.
 */
@Injectable()
export class SiteDatabasesService {
  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(DOCKER_EXECUTOR_TOKEN) private readonly dockerExecutor: DockerExecutorPort,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) private readonly config: ControlPlaneRuntimeConfig,
    @Inject(AuthzContextService) private readonly authz: AuthzContextService,
  ) {}

  /** Returns true when phpMyAdmin sign-on is supported on the active runtime backend. */
  public isPhpMyAdminAvailable(): boolean {
    return isPhpMyAdminAvailable(this.config.runtimeBackend);
  }

  /** Lists MariaDB databases and users belonging to a site, sorted primary-first then by name. */
  public async list(site: SiteRef): Promise<SiteDatabasesDto> {
    const raw = await this.#call({ siteId: site.id, op: "list" });
    if (
      !raw ||
      typeof raw !== "object" ||
      !("databases" in raw) ||
      !Array.isArray(raw.databases) ||
      !("users" in raw) ||
      !Array.isArray(raw.users)
    ) {
      throw databasesUnavailableError();
    }

    const databases: SiteDatabaseDto[] = raw.databases
      .map((entry) => ({
        name: entry.name,
        primary: Boolean(entry.primary),
        sizeBytes: entry.sizeBytes,
      }))
      .sort(comparePrimaryFirst);

    const users: SiteDatabaseUserDto[] = raw.users
      .map((entry) => ({
        name: entry.name,
        primary: Boolean(entry.primary),
        databases: [...entry.databases].sort(compareText),
      }))
      .sort(comparePrimaryFirst);

    const parsed = SiteDatabasesDtoSchema.safeParse({
      prefix: siteDatabasePrefix(site.id),
      databases,
      users,
      limits: {
        databases: SITE_DATABASES_MAX,
        users: SITE_DATABASE_USERS_MAX,
      },
      phpMyAdminAvailable: this.isPhpMyAdminAvailable(),
    });
    if (!parsed.success) {
      throw databasesUnavailableError();
    }
    return parsed.data;
  }

  /** Creates a custom database named `<prefix>_<suffix>` and records an audit event. */
  public async createDatabase(
    site: SiteRef,
    actor: SiteDatabaseActor,
    suffix: string,
  ): Promise<SiteDatabaseCreatedDto> {
    const cleanSuffix = this.#parseSuffix(suffix);
    await this.#assertSiteReady(site);
    const name = siteDatabaseFullName(siteDatabasePrefix(site.id), cleanSuffix);

    await this.#call({
      siteId: site.id,
      op: "createDatabase",
      database: name,
    });
    await this.#audit(site, actor, "site.database.create", { database: name });
    return {
      database: {
        name,
        primary: false,
        sizeBytes: 0,
      },
    };
  }

  /** Deletes a custom database belonging to a site; refuses the site's primary database. */
  public async deleteDatabase(
    site: SiteRef,
    actor: SiteDatabaseActor,
    name: string,
  ): Promise<void> {
    const validatedName = PathNameSchema.parse(name);
    const prefix = siteDatabasePrefix(site.id);
    this.#assertOwnedName(prefix, validatedName);
    this.#assertNotProtected(prefix, validatedName);

    await this.#call({
      siteId: site.id,
      op: "deleteDatabase",
      database: validatedName,
    });
    await this.#audit(site, actor, "site.database.delete", { database: validatedName });
  }

  /** Creates a custom database user with a generated password returned once and never stored. */
  public async createUser(
    site: SiteRef,
    actor: SiteDatabaseActor,
    suffix: string,
  ): Promise<SiteDatabaseUserCreatedDto> {
    const cleanSuffix = this.#parseSuffix(suffix);
    await this.#assertSiteReady(site);
    const name = siteDatabaseFullName(siteDatabasePrefix(site.id), cleanSuffix);
    const temporaryPassword = generateDatabasePassword();
    const passwordHash = mysqlNativePasswordHash(temporaryPassword);

    await this.#call({
      siteId: site.id,
      op: "createUser",
      user: name,
      passwordHash,
    });
    await this.#audit(site, actor, "site.database.user.create", { user: name });
    return {
      user: {
        name,
        primary: false,
        databases: [],
      },
      temporaryPassword,
    };
  }

  /** Rotates a custom database user's password and returns the new password once. */
  public async resetUserPassword(
    site: SiteRef,
    actor: SiteDatabaseActor,
    name: string,
  ): Promise<SiteDatabasePasswordResetDto> {
    const validatedName = PathNameSchema.parse(name);
    await this.#assertSiteReady(site);
    const prefix = siteDatabasePrefix(site.id);
    this.#assertOwnedName(prefix, validatedName);
    this.#assertNotProtected(prefix, validatedName);

    const temporaryPassword = generateDatabasePassword();
    const passwordHash = mysqlNativePasswordHash(temporaryPassword);

    await this.#call({
      siteId: site.id,
      op: "setUserPassword",
      user: validatedName,
      passwordHash,
    });
    await this.#audit(site, actor, "site.database.user.password_reset", { user: validatedName });
    return { temporaryPassword };
  }

  /** Deletes a custom database user belonging to a site; refuses the site's primary user. */
  public async deleteUser(
    site: SiteRef,
    actor: SiteDatabaseActor,
    name: string,
  ): Promise<void> {
    const validatedName = PathNameSchema.parse(name);
    const prefix = siteDatabasePrefix(site.id);
    this.#assertOwnedName(prefix, validatedName);
    this.#assertNotProtected(prefix, validatedName);

    await this.#call({
      siteId: site.id,
      op: "deleteUser",
      user: validatedName,
    });
    await this.#audit(site, actor, "site.database.user.delete", { user: validatedName });
  }

  /** Grants a custom database user access to any database owned by the same site. */
  public async grant(
    site: SiteRef,
    actor: SiteDatabaseActor,
    user: string,
    database: string,
  ): Promise<void> {
    const validatedUser = PathNameSchema.parse(user);
    const validatedDatabase = PathNameSchema.parse(database);
    await this.#assertSiteReady(site);
    const prefix = siteDatabasePrefix(site.id);
    this.#assertOwnedName(prefix, validatedUser);
    this.#assertOwnedName(prefix, validatedDatabase);
    this.#assertNotProtected(prefix, validatedUser);

    await this.#call({
      siteId: site.id,
      op: "grant",
      user: validatedUser,
      database: validatedDatabase,
    });
    await this.#audit(site, actor, "site.database.grant", {
      user: validatedUser,
      database: validatedDatabase,
    });
  }

  /** Revokes a custom database user's access to a database owned by the same site. */
  public async revoke(
    site: SiteRef,
    actor: SiteDatabaseActor,
    user: string,
    database: string,
  ): Promise<void> {
    const validatedUser = PathNameSchema.parse(user);
    const validatedDatabase = PathNameSchema.parse(database);
    const prefix = siteDatabasePrefix(site.id);
    this.#assertOwnedName(prefix, validatedUser);
    this.#assertOwnedName(prefix, validatedDatabase);
    this.#assertNotProtected(prefix, validatedUser);

    await this.#call({
      siteId: site.id,
      op: "revoke",
      user: validatedUser,
      database: validatedDatabase,
    });
    await this.#audit(site, actor, "site.database.revoke", {
      user: validatedUser,
      database: validatedDatabase,
    });
  }

  /**
   * Provisions the per-site phpMyAdmin sign-on credential with a fresh temporary password.
   * Consumed by the web BFF only so the password never reaches the browser.
   */
  public async phpMyAdminSignOn(
    site: SiteRef,
    actor: SiteDatabaseActor,
  ): Promise<SiteDatabaseSignOnDto> {
    this.#assertPhpMyAdminAvailable();
    await this.#assertSiteReady(site);

    const temporaryPassword = generateDatabasePassword();
    const passwordHash = mysqlNativePasswordHash(temporaryPassword);
    const result = await this.#call({
      siteId: site.id,
      op: "phpMyAdminSignOn",
      passwordHash,
    });

    if (
      !result ||
      typeof result !== "object" ||
      !("username" in result) ||
      typeof result.username !== "string" ||
      !SITE_DATABASE_SIGNON_USER_PATTERN.test(result.username)
    ) {
      throw databasesUnavailableError();
    }

    await this.#audit(site, actor, "site.database.phpmyadmin.open", {
      username: result.username,
    });
    return {
      username: result.username,
      temporaryPassword,
    };
  }

  /** Verifies phpMyAdmin availability and site readiness for the BFF forwarder without auditing. */
  public async assertPhpMyAdminAccess(site: SiteRef): Promise<void> {
    this.#assertPhpMyAdminAvailable();
    await this.#assertSiteReady(site);
  }

  #parseSuffix(suffix: string): string {
    const parsed = SiteDatabaseSuffixSchema.parse(suffix);
    // Double-check against the pattern in case a schema transform is ever altered.
    if (!SITE_DATABASE_SUFFIX_PATTERN.test(parsed)) {
      throw new ControlPlaneError("VALIDATION_ERROR", SAFE_ERROR_MESSAGES.VALIDATION_ERROR!);
    }
    return parsed;
  }

  #assertPhpMyAdminAvailable(): void {
    if (!this.isPhpMyAdminAvailable()) {
      throw new ControlPlaneError("NOT_SUPPORTED", SAFE_ERROR_MESSAGES.NOT_SUPPORTED!);
    }
  }

  #assertOwnedName(prefix: string, name: string): void {
    if (!isSiteDatabaseName(prefix, name)) {
      throw notFound();
    }
  }

  #assertNotProtected(prefix: string, name: string): void {
    if (name === prefix) {
      throw protectedError();
    }
  }

  async #assertSiteReady(site: SiteRef): Promise<void> {
    const [current] = await this.dbClient.db
      .select({ status: sites.status })
      .from(sites)
      .where(and(eq(sites.id, site.id), eq(sites.organizationId, site.organizationId)))
      .limit(1);
    if (!current) {
      throw notFound();
    }
    if (current.status === "deploying" || current.status === "maintenance") {
      const message = "Site databases are not available until the site finishes updating.";
      throw new ControlPlaneError("RESOURCE_LOCKED", message, {
        details: [{ reason: "not_ready", message }],
      });
    }
  }

  async #call<R extends SiteDatabasesRequest>(
    req: R,
  ): Promise<SiteDatabasesResult<R["op"]>> {
    if (this.config.runtimeBackend === "disabled" || !this.dockerExecutor.isRuntimeAvailable) {
      throw new ControlPlaneError("NOT_SUPPORTED", SAFE_ERROR_MESSAGES.NOT_SUPPORTED!);
    }
    try {
      return await this.dockerExecutor.siteDatabases(req);
    } catch (err) {
      throw mapSiteDatabaseExecutorError(err);
    }
  }

  async #audit(
    site: SiteRef,
    actor: SiteDatabaseActor,
    action: SiteDatabaseAuditAction,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.authz.recordAudit(actor.auth, actor.req, {
      organizationId: site.organizationId,
      action,
      targetType: "site",
      targetId: site.id,
      details,
    });
  }
}
