import { randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  isBackupAvailable,
  isWordpressSite,
  isWordpressToolsAvailable,
  SiteWordpressLastUpdateDtoSchema,
  SiteWordpressStateDtoSchema,
  WORDPRESS_OPERATION_KINDS,
  WORDPRESS_USER_ID_PATTERN,
  wordpressJobReason,
  type ManagedSiteDto,
  type OperationKind,
  type SiteWordpressAcceptedDto,
  type SiteWordpressDto,
  type SiteWordpressPasswordResetDto,
  type SiteWordpressStateDto,
  type SiteWordpressUpdateRequest,
} from "@hosting-panel/contracts";
import {
  ACTIVE_OPERATION_LOCK_STATUSES,
  and,
  appendAuditEvent,
  asc,
  enqueueOperationTransactional,
  eq,
  getBackupSettingsPublic,
  getSiteWordpressState,
  inArray,
  insertSiteBackup,
  operations,
  operationSteps,
  serviceInstances,
  sites,
  type DatabaseClient,
  type DatabaseExecutor,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
import { assertHeavyActionAllowed } from "../backups/site-restore.service.js";
import {
  ControlPlaneError,
  extractClientIp,
  extractRawHeader,
  resolveRequestId,
} from "../common/control-plane.error.js";
import { SITE_STEP_LEASE_MS } from "../runtime/site-provisioner.js";
import {
  CONTROL_PLANE_CONFIG_TOKEN,
  DATABASE_CLIENT_TOKEN,
  DOCKER_EXECUTOR_TOKEN,
  type ControlPlaneRuntimeConfig,
} from "../tokens.js";
import { generateDatabasePassword, type SiteDatabaseActor } from "./site-databases.service.js";
import { SITE_WORDPRESS_INSPECT_STEPS, SITE_WORDPRESS_UPDATE_STEPS } from "./site-wordpress-applier.js";

type WordpressSite = Pick<ManagedSiteDto, "id" | "organizationId" | "status" | "phpVersion">;

const STEP_ORDER = ["inspect", "backup", "update", "settle"] as const;

const refusal = (code: "NOT_SUPPORTED" | "RESOURCE_LOCKED" | "VALIDATION_ERROR", reason: string, message: string) =>
  new ControlPlaneError(code, message, { details: [{ reason, message }] });

const unavailable = (reason: string) =>
  new ControlPlaneError("DOCKER_ENGINE_UNAVAILABLE", "The password could not be reset right now. Try again in a few minutes.", {
    retryable: true,
    details: [{ reason, message: reason }],
  });

const administratorUnknown = () =>
  refusal("VALIDATION_ERROR", "administrator_unknown", "This user is not an administrator of the site. Press Check now to see the current list.");

// Job reason → answer reason of a failed reset (api-wp Design, Password reset).
const RESET_REASONS: Partial<Record<string, string>> = {
  not_wordpress: "not_installed",
  broken_configuration: "config_broken",
  database_unreachable: "database_unreachable",
};

/** The WordPress tab's state, checks, updates and password reset. */
@Injectable()
export class SiteWordpressService {
  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(DOCKER_EXECUTOR_TOKEN) private readonly dockerExecutor: DockerExecutorPort,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) private readonly config: ControlPlaneRuntimeConfig,
  ) {}

  /** Stored state, last update, running WordPress operation and whether a copy is taken first. */
  public async get(site: WordpressSite): Promise<SiteWordpressDto> {
    const stored = await getSiteWordpressState(this.dbClient.db, { organizationId: site.organizationId, siteId: site.id });
    const [running] = await this.dbClient.db
      .select({ id: operations.id, kind: operations.kind, status: operations.status })
      .from(operations)
      .where(
        and(
          eq(operations.lockKey, `site:${site.id}`),
          inArray(operations.status, [...ACTIVE_OPERATION_LOCK_STATUSES]),
          inArray(operations.kind, [...WORDPRESS_OPERATION_KINDS]),
        ),
      )
      .limit(1);
    let runningOperation: SiteWordpressDto["runningOperation"] = null;
    if (running) {
      const steps = await this.dbClient.db
        .select({ key: operationSteps.key, status: operationSteps.status })
        .from(operationSteps)
        .where(eq(operationSteps.operationId, running.id))
        .orderBy(asc(operationSteps.id));
      runningOperation = {
        id: running.id,
        kind: running.kind as (typeof WORDPRESS_OPERATION_KINDS)[number],
        status: running.status,
        steps: steps
          .map((s) => ({ key: s.key as (typeof STEP_ORDER)[number], status: s.status }))
          .sort((x, y) => STEP_ORDER.indexOf(x.key) - STEP_ORDER.indexOf(y.key)),
      };
    }
    return {
      backupsConfigured: await this.backupsConfigured(),
      state: this.#state(stored?.state),
      runningOperation,
      lastUpdate: SiteWordpressLastUpdateDtoSchema.safeParse(stored?.lastUpdate).data ?? null,
    };
  }

  /** Queues a check of versions and updates. */
  public async refresh(site: WordpressSite, actor: SiteDatabaseActor, idempotencyKey: string): Promise<SiteWordpressAcceptedDto> {
    this.assertUsable(site);
    return this.#enqueue(site, actor, idempotencyKey, "site.wordpress.inspect", async (tx, operationId) => {
      await this.#audit(tx, site, actor, "site.wordpress.refresh", { outcome: "requested", operationId });
    });
  }

  /** Queues an update with a copy taken first when backups are set up. */
  public async update(
    site: WordpressSite,
    actor: SiteDatabaseActor,
    idempotencyKey: string,
    target: SiteWordpressUpdateRequest,
  ): Promise<SiteWordpressAcceptedDto> {
    this.assertUsable(site);
    if (target.scope === "plugin" || target.scope === "theme") {
      const state = await this.#storedState(site);
      const items = target.scope === "plugin" ? state?.plugins : state?.themes;
      if (!items?.some((item) => item.name === target.name)) {
        throw refusal(
          "VALIDATION_ERROR",
          "item_unknown",
          "This plugin or theme is not on the site. Press Check now to see the current list.",
        );
      }
    }
    const backupsConfigured = await this.backupsConfigured();
    return this.#enqueue(site, actor, idempotencyKey, "site.wordpress.update", async (tx, operationId, submittedAt) => {
      await assertHeavyActionAllowed(tx, site.id, actor, { id: operationId, submittedAt });
      if (backupsConfigured) {
        const [row] = await tx.select({ siteUrl: sites.wordpressUrl }).from(sites).where(eq(sites.id, site.id)).limit(1);
        await insertSiteBackup(tx, { siteId: site.id, kind: "pre_update", status: "running", operationId, siteUrl: row?.siteUrl ?? null });
      }
      await this.#audit(tx, site, actor, "site.wordpress.update", { outcome: "requested", operationId, target });
    }, { target });
  }

  /** Sets a new password for one administrator; the password is answered once and stored nowhere. */
  public async resetPassword(site: WordpressSite, actor: SiteDatabaseActor, userId: string): Promise<SiteWordpressPasswordResetDto> {
    this.assertUsable(site);
    const [busy] = await this.dbClient.db
      .select({ id: operations.id, status: operations.status })
      .from(operations)
      .where(and(eq(operations.lockKey, `site:${site.id}`), inArray(operations.status, [...ACTIVE_OPERATION_LOCK_STATUSES])))
      .limit(1);
    if (busy) {
      throw new ControlPlaneError(
        "RESOURCE_LOCKED",
        `Resource lock 'site:${site.id}' is currently held by active operation '${busy.id}' (${busy.status})`,
      );
    }
    const admin = WORDPRESS_USER_ID_PATTERN.test(userId)
      ? (await this.#storedState(site))?.administrators.find((a) => a.id === Number(userId))
      : undefined;
    if (!admin) {
      throw administratorUnknown();
    }
    const [svc] = await this.dbClient.db
      .select({ id: serviceInstances.id })
      .from(serviceInstances)
      .where(and(eq(serviceInstances.siteId, site.id), eq(serviceInstances.organizationId, site.organizationId)))
      .limit(1);
    if (!svc) {
      throw unavailable("unavailable");
    }

    const details = { userId: admin.id, login: admin.login };
    const temporaryPassword = generateDatabasePassword();
    let exitCode: number;
    try {
      ({ exitCode } = await this.dockerExecutor.runSiteJob({
        jobId: `job_${randomBytes(16).toString("hex")}_pwreset`,
        kind: "wordpress.reset-password",
        siteId: site.id,
        organizationId: site.organizationId,
        serviceInstanceId: svc.id,
        params: { phpVersion: site.phpVersion!, userId },
        resolvedSecrets: { HP_ADMIN_PASSWORD: temporaryPassword },
      }));
    } catch {
      // The end of the job was not seen: the password may have changed.
      await this.#audit(this.dbClient.db, site, actor, "site.wordpress.password_reset", { outcome: "unknown", ...details });
      throw unavailable("unavailable");
    }

    const reason = wordpressJobReason(exitCode, false, false);
    if (reason === null) {
      await this.#audit(this.dbClient.db, site, actor, "site.wordpress.password_reset", { outcome: "succeeded", ...details });
      return { temporaryPassword };
    }
    const answer = reason === "not_administrator" ? "administrator_unknown" : (RESET_REASONS[reason] ?? "unavailable");
    // Stopped at its limit or killed (124, 137): the password may have changed.
    const outcome = reason === "timed_out" ? "unknown" : "failed";
    await this.#audit(this.dbClient.db, site, actor, "site.wordpress.password_reset", { outcome, ...details, reason: answer });
    throw answer === "administrator_unknown" ? administratorUnknown() : unavailable(answer);
  }

  /** Guards of the mutating routes (also the import's), in the order of the design. */
  public assertUsable(site: WordpressSite): void {
    if (!isWordpressToolsAvailable(this.config.runtimeBackend) || !this.dockerExecutor.isRuntimeAvailable) {
      throw refusal("NOT_SUPPORTED", "wordpress_unavailable", "WordPress tools are not available on this server.");
    }
    if (!isWordpressSite(site)) {
      throw refusal("NOT_SUPPORTED", "not_wordpress", "This site does not run WordPress.");
    }
    if (site.status === "deploying" || site.status === "maintenance") {
      throw refusal("RESOURCE_LOCKED", "not_ready", "not_ready");
    }
  }

  /** Enqueues one WordPress operation and runs the request's own writes in the same transaction. */
  async #enqueue(
    site: WordpressSite,
    actor: SiteDatabaseActor,
    idempotencyKey: string,
    kind: OperationKind,
    within: (tx: DatabaseExecutor, operationId: string, submittedAt: Date) => Promise<void>,
    payload: Record<string, unknown> = {},
  ): Promise<SiteWordpressAcceptedDto> {
    const operationId = await this.dbClient.db.transaction(async (tx) => {
      const enqueued = await enqueueOperationTransactional(tx as unknown as HostingPanelDatabase, {
        organizationId: site.organizationId,
        kind,
        resourceType: "site",
        resourceId: site.id,
        requestedByUserId: actor.auth.user.id,
        idempotencyKey,
        lockKey: `site:${site.id}`,
        leaseDurationMs: SITE_STEP_LEASE_MS,
        steps: kind === "site.wordpress.update" ? SITE_WORDPRESS_UPDATE_STEPS : SITE_WORDPRESS_INSPECT_STEPS,
        outboxPayload: { siteId: site.id, ...payload },
      });
      if (!enqueued.idempotentReplay) {
        await within(tx, enqueued.operation.id, enqueued.operation.submittedAt);
      }
      return enqueued.operation.id;
    });
    return { siteId: site.id, operationId };
  }

  async #storedState(site: WordpressSite): Promise<SiteWordpressStateDto | null> {
    const stored = await getSiteWordpressState(this.dbClient.db, { organizationId: site.organizationId, siteId: site.id });
    return this.#state(stored?.state);
  }

  #state(raw: unknown): SiteWordpressStateDto | null {
    return SiteWordpressStateDtoSchema.safeParse(raw).data ?? null;
  }

  /** Whether a copy is taken before a change. */
  public async backupsConfigured(): Promise<boolean> {
    return isBackupAvailable(this.config.runtimeBackend) && (await getBackupSettingsPublic(this.dbClient.db)) !== null;
  }

  async #audit(
    db: DatabaseExecutor,
    site: WordpressSite,
    actor: SiteDatabaseActor,
    action: "site.wordpress.refresh" | "site.wordpress.update" | "site.wordpress.password_reset",
    details: Record<string, unknown>,
  ): Promise<void> {
    await appendAuditEvent(db as unknown as HostingPanelDatabase, {
      actorId: actor.auth.user.id,
      actorType: "user",
      organizationId: site.organizationId,
      action,
      targetType: "site",
      targetId: site.id,
      ipAddress: extractClientIp(actor.req),
      userAgent: extractRawHeader(actor.req.headers as Record<string, string | string[] | undefined>, "user-agent"),
      details: { requestId: resolveRequestId(actor.req), ...details },
    });
  }
}
