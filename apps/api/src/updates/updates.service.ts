import { Inject, Injectable } from "@nestjs/common";
import {
  SITE_TYPE_KEYS,
  HOST_JOB_KIND,
  HOST_JOB_RESULTS,
  OPERATION_TERMINAL_STATUSES,
  OS_JOBS,
  OsPackagesDtoSchema,
  PANEL_CONTAINER_APPLY_KIND,
  PANEL_CONTAINERS,
  PLATFORM_OPS_ORG_ID,
  PanelContainerSchema,
  PanelContainerStatusWireSchema,
  SITES_BEHIND_MAX,
  type OsPackagesDto,
  type PanelContainer,
  type PhpVersion,
  type SiteTemplateSpec,
  type UpdatesDto,
} from "@hosting-panel/contracts";
import {
  and,
  appendAuditEvent,
  asc,
  auditEvents,
  desc,
  enqueueOperationTransactional,
  eq,
  getSiteTemplateVersionById,
  hostAgentHeartbeats,
  inArray,
  not,
  operations,
  organizations,
  readSiteTemplateSpec,
  serviceInstances,
  sites,
  sql,
  stackRevisions,
  type DatabaseClient,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import type { HostAgentPort, HostJob } from "@hosting-panel/host-agent-contracts";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import type { AuthenticatedRequestContext } from "../auth/authz-context.service.js";
import { ensurePlatformOpsOrg } from "../backups/backup-scheduler.service.js";
import {
  ControlPlaneError,
  extractClientIp,
  extractRawHeader,
  requireIdempotencyKey,
  resolveRequestId,
} from "../common/control-plane.error.js";
import { AdminHealthService } from "../health/admin-health.service.js";
import { assertNoSiteWork, enqueueHostJob } from "../host/host-jobs.js";
import { MailRelayService } from "../mail/mail-relay.service.js";
import { findApiSiteType } from "../site-types/index.js";
import { ManagedSitesService } from "../sites/managed-sites.service.js";
import { expectedTemplateImage } from "../sites/site-template-runtime.js";
import { CONTROL_PLANE_CONFIG_TOKEN, DATABASE_CLIENT_TOKEN, HOST_AGENT_TOKEN, type ControlPlaneRuntimeConfig } from "../tokens.js";
import { PANEL_APPLY_LEASE_MS, PANEL_APPLY_STEPS } from "./panel-container-apply.js";
import { checkPanelRelease, installedPanelVersion } from "./release-version.js";

type Check = UpdatesDto["panel"]["check"];
type HostJobResult = (typeof HOST_JOB_RESULTS)[number];

const PanelContainersSnapshotSchema = z.object({ containers: z.array(PanelContainerStatusWireSchema) });
const UNAVAILABLE_MESSAGE = "The host agent did not answer. Check Health, then try again.";
const ACTIVE = not(inArray(operations.status, [...OPERATION_TERMINAL_STATUSES]));

const headersOf = (req: FastifyRequest) => req.headers as Record<string, string | string[] | undefined>;
const refused = (reason: "already_current" | "stopped", message: string) =>
  new ControlPlaneError("VALIDATION_ERROR", message, { details: [{ message, reason }] });

/** Panel, component, site image and system package updates. */
@Injectable()
export class UpdatesService {
  // Kept in memory: after a restart the page shows never_checked.
  #check: Check = { state: "never_checked", latestVersion: null, checkedAt: null };

  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) private readonly config: ControlPlaneRuntimeConfig,
    @Inject(HOST_AGENT_TOKEN) private readonly hostAgent: HostAgentPort,
    @Inject(ManagedSitesService) private readonly sites: ManagedSitesService,
    @Inject(MailRelayService) private readonly mailRelay: MailRelayService,
    @Inject(AdminHealthService) private readonly adminHealth: AdminHealthService,
  ) {}

  /** Installed and latest panel version, components and sites behind the pin. */
  public async updates(): Promise<UpdatesDto> {
    const db = this.dbClient.db;
    const [running] = await this.#activeJobs(["panel_update"]);
    const [last] = await db
      .select({ details: auditEvents.details, at: auditEvents.timestamp })
      .from(auditEvents)
      .where(eq(auditEvents.action, "admin.update.panel.end"))
      .orderBy(desc(auditEvents.timestamp), desc(auditEvents.id))
      .limit(1);
    const end = last?.details as { operationId?: unknown; result?: unknown } | undefined;
    const lastEnd = typeof end?.operationId === "string" && HOST_JOB_RESULTS.includes(end.result as HostJobResult)
      ? { operationId: end.operationId, result: end.result as HostJobResult, endedAt: last!.at.toISOString() }
      : null;

    const [heartbeat] = await db
      .select({ snapshot: hostAgentHeartbeats.telemetrySnapshot })
      .from(hostAgentHeartbeats)
      .where(eq(hostAgentHeartbeats.component, "panel_containers"))
      .orderBy(desc(hostAgentHeartbeats.lastSeenAt))
      .limit(1);
    const parsed = PanelContainersSnapshotSchema.safeParse(heartbeat?.snapshot);
    const applies = await db
      .select({ id: operations.id, component: operations.resourceId })
      .from(operations)
      .where(and(eq(operations.kind, PANEL_CONTAINER_APPLY_KIND), ACTIVE));
    const components = PANEL_CONTAINERS.map((component) => {
      const row = parsed.success ? parsed.data.containers.find((c) => c.component === component) : undefined;
      return {
        component,
        expected: row?.expected ?? null,
        imageCurrent: row?.imageCurrent ?? null,
        runningOperationId: applies.find((a) => a.component === component)?.id ?? null,
      };
    });

    const behind = await this.#sitesBehind();
    return {
      panel: { installedVersion: installedPanelVersion(), check: this.#check, running: running ? { operationId: running.id } : null, last: lastEnd },
      components,
      sites: behind.slice(0, SITES_BEHIND_MAX).map(({ image: _image, organizationId: _org, toImage: _to, ...s }) => s),
      sitesTotal: behind.length,
    };
  }

  /**
   * Sites whose current revision runs another image than their own template version renders today (a site without a
   * version: the pin of its PHP version). A version that cannot be read or rendered is never "behind": no redeploy
   * is offered that cannot be built.
   */
  async #sitesBehind() {
    const db = this.dbClient.db;
    const rows = await db
      .select({
        siteId: sites.id, siteName: sites.name, organizationId: sites.organizationId, orgName: organizations.name,
        phpVersion: sites.phpVersion, siteType: sites.siteType, desired: serviceInstances.desiredStatus,
        templateVersionId: sites.templateVersionId, templateParameters: sites.templateParameters,
        image: sql<string | null>`${stackRevisions.declarativeConfig}->>'image'`,
      })
      .from(sites)
      .innerJoin(organizations, eq(organizations.id, sites.organizationId))
      .innerJoin(serviceInstances, and(eq(serviceInstances.siteId, sites.id), eq(serviceInstances.organizationId, sites.organizationId)))
      .innerJoin(stackRevisions, eq(stackRevisions.id, serviceInstances.currentRevisionId))
      .where(inArray(sites.siteType, [...SITE_TYPE_KEYS]))
      .orderBy(asc(sites.name), asc(sites.id));
    const specs = new Map<string, SiteTemplateSpec | null>(
      await Promise.all(
        [...new Set(rows.flatMap((r) => (r.templateVersionId ? [r.templateVersionId] : [])))].map(
          async (id) => [id, await this.#templateSpec(id)] as const,
        ),
      ),
    );
    const targetImage = (r: (typeof rows)[number]): string | null => {
      if (r.templateVersionId === null) return findApiSiteType(r.siteType)?.image(r.phpVersion as PhpVersion) ?? null;
      const spec = specs.get(r.templateVersionId);
      return spec ? expectedTemplateImage(spec, { id: r.siteId, phpVersion: r.phpVersion, templateParameters: r.templateParameters }) : null;
    };
    // shortcut: filtered in memory, one row per site; move to SQL if a server ever holds many thousands of sites.
    return rows.flatMap((r) => {
      const toImage = targetImage(r);
      return toImage === null || r.image === toImage
        ? []
        : [{
            siteId: r.siteId,
            siteName: r.siteName,
            organizationName: r.organizationId === PLATFORM_OPS_ORG_ID ? null : r.orgName,
            phpVersion: r.phpVersion as PhpVersion,
            stopped: r.desired === "stopped",
            image: r.image,
            organizationId: r.organizationId,
            toImage,
          }];
    });
  }

  async #templateSpec(versionId: string): Promise<SiteTemplateSpec | null> {
    const loaded = await getSiteTemplateVersionById(this.dbClient.db, versionId);
    try {
      return loaded ? readSiteTemplateSpec(loaded.version) : null;
    } catch {
      return null;
    }
  }

  /** Asks the release source for the latest panel version and writes the check row. */
  public async checkPanel(auth: AuthenticatedRequestContext, req: FastifyRequest): Promise<UpdatesDto> {
    const result = await checkPanelRelease(installedPanelVersion());
    this.#check = { ...result, checkedAt: new Date().toISOString() };
    await ensurePlatformOpsOrg(this.dbClient.db);
    await appendAuditEvent(this.dbClient.db, {
      actorId: auth.user.id,
      actorType: "user",
      organizationId: PLATFORM_OPS_ORG_ID,
      action: "admin.update.check",
      targetType: "platform",
      targetId: null,
      ipAddress: extractClientIp(req),
      userAgent: extractRawHeader(headersOf(req), "user-agent"),
      details: { outcome: "succeeded", state: result.state, latestVersion: result.latestVersion },
    });
    return this.updates();
  }

  /** Queues the panel update job; the version comes from the server, never the browser. */
  public async applyPanel(auth: AuthenticatedRequestContext, req: FastifyRequest): Promise<{ operationId: string }> {
    return this.#hostJob(auth, req, "panel_update", "admin.update.panel", { fromVersion: installedPanelVersion() });
  }

  /** Queues one component's move to its pinned image; the mail relay goes through its own apply. */
  public async applyComponent(
    auth: AuthenticatedRequestContext,
    req: FastifyRequest,
    rawComponent: string,
  ): Promise<{ component: PanelContainer; operationId: string | null }> {
    const idempotencyKey = requireIdempotencyKey(headersOf(req));
    const component = PanelContainerSchema.parse(rawComponent);
    this.#requireRuntime();
    const part = (await this.adminHealth.health()).components.find((c) => c.component === component);
    if (part?.state === "not_in_use" || (part?.state === "down" && part.reason === "missing")) {
      throw new ControlPlaneError("PANEL_CONTAINER_ABSENT", "This container is not installed. There is nothing to update.");
    }
    const audit = (tx: HostingPanelDatabase, operationId: string | null) => appendAuditEvent(tx, {
      actorId: auth.user.id,
      actorType: "user",
      organizationId: PLATFORM_OPS_ORG_ID,
      action: "admin.update.component",
      targetType: "panel_container",
      targetId: component,
      ipAddress: extractClientIp(req),
      userAgent: extractRawHeader(headersOf(req), "user-agent"),
      details: { outcome: "succeeded", requestId: resolveRequestId(req), operationId, component },
    });
    if (component === "mail_relay") {
      // MailRelayService depends on the outbox worker, so this apply cannot be an operation; it never rejects.
      await ensurePlatformOpsOrg(this.dbClient.db);
      await audit(this.dbClient.db, null);
      void this.mailRelay.ensureApplied(true);
      return { component, operationId: null };
    }
    const operationId = await this.dbClient.db.transaction(async (tx) => {
      const t = tx as unknown as HostingPanelDatabase;
      await ensurePlatformOpsOrg(tx);
      const enqueued = await enqueueOperationTransactional(t, {
        organizationId: PLATFORM_OPS_ORG_ID,
        kind: PANEL_CONTAINER_APPLY_KIND,
        resourceType: "host",
        resourceId: component,
        requestedByUserId: auth.user.id,
        idempotencyKey,
        lockKey: `panel:container:${component}`,
        leaseDurationMs: PANEL_APPLY_LEASE_MS,
        steps: PANEL_APPLY_STEPS,
        outboxPayload: {},
      });
      if (!enqueued.idempotentReplay) {
        // It restarts the database every site uses; throwing here rolls the enqueue back (R202 3).
        if (component === "shared_database") await assertNoSiteWork(t);
        await audit(t, enqueued.operation.id);
      }
      return enqueued.operation.id;
    });
    return { component, operationId };
  }

  /** Queues one site's move to the image its template version renders (the pinned image of its PHP version without one) through the shipped deploy. */
  public async updateSiteImage(
    auth: AuthenticatedRequestContext,
    req: FastifyRequest,
    siteId: string,
  ): Promise<{ siteId: string; operationId: string }> {
    const idempotencyKey = requireIdempotencyKey(headersOf(req));
    this.#requireRuntime();
    const db = this.dbClient.db;
    const [site] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
    const type = site ? findApiSiteType(site.siteType) : null;
    if (!site || !type) throw new ControlPlaneError("NOT_FOUND", "Requested organization or resource was not found.");
    // A replay answers the first operation: the site may be current by now, and no second row is written.
    const [replay] = await db
      .select({ id: operations.id })
      .from(operations)
      .where(and(
        eq(operations.organizationId, site.organizationId), eq(operations.idempotencyKey, idempotencyKey),
        eq(operations.kind, "service.deploy"), eq(operations.lockKey, `site:${siteId}`),
      ))
      .limit(1);
    if (replay) return { siteId, operationId: replay.id };
    const row = (await this.#sitesBehind()).find((s) => s.siteId === siteId);
    if (!row) throw refused("already_current", "This site already runs the pinned image.");
    if (row.stopped) throw refused("stopped", "Start the site first, then update its image.");
    // R202 2.2: the row is written in the transaction that creates the operation, only when it is new.
    const audit = (tx: HostingPanelDatabase, operationId: string) => appendAuditEvent(tx, {
      actorId: auth.user.id,
      actorType: "user",
      organizationId: site.organizationId,
      action: "admin.update.site_image",
      targetType: "site",
      targetId: siteId,
      ipAddress: extractClientIp(req),
      userAgent: extractRawHeader(headersOf(req), "user-agent"),
      details: {
        outcome: "succeeded", requestId: resolveRequestId(req), operationId, siteId,
        organizationId: site.organizationId, fromImage: row.image, toImage: row.toImage,
      },
    });
    const { operationId } = await this.sites.changeRuntime(siteId, site.organizationId, site.phpVersion as PhpVersion, auth.user.id, idempotencyKey, audit);
    return { siteId, operationId };
  }

  /** System packages with an update, read live from the host, and the running package job. */
  public async osPackages(): Promise<OsPackagesDto> {
    this.#requireAgent();
    let read;
    try {
      read = await this.hostAgent.readOsPackages();
    } catch {
      throw new ControlPlaneError("HOST_AGENT_UNAVAILABLE", UNAVAILABLE_MESSAGE, { retryable: true });
    }
    const [running] = await this.#activeJobs(OS_JOBS);
    const parsed = OsPackagesDtoSchema.safeParse({
      packages: read.packages.map((p) => ({ name: p.name, installedVersion: p.installedVersion, newVersion: p.newVersion, origin: p.origin })),
      rebootRequired: read.rebootRequired,
      canUpgrade: read.canUpgrade,
      listsReadAt: read.listsReadAt,
      running: running ? { operationId: running.id, job: running.job } : null,
    });
    if (!parsed.success) throw new ControlPlaneError("HOST_AGENT_UNAVAILABLE", UNAVAILABLE_MESSAGE, { retryable: true });
    return parsed.data;
  }

  /** Queues a refresh of the package lists. */
  public async refreshOsPackages(auth: AuthenticatedRequestContext, req: FastifyRequest): Promise<{ operationId: string }> {
    return this.#hostJob(auth, req, "os_refresh", "admin.os_packages.refresh", {});
  }

  /** Queues the system package upgrade. */
  public async upgradeOsPackages(auth: AuthenticatedRequestContext, req: FastifyRequest): Promise<{ operationId: string }> {
    return this.#hostJob(auth, req, "os_upgrade", "admin.os_packages.upgrade", {});
  }

  #requireRuntime(): void {
    if (this.config.runtimeBackend === "disabled") throw new ControlPlaneError("NOT_SUPPORTED", "The container runtime is disabled on this server.");
  }

  #requireAgent(): void {
    if (!this.hostAgent.isRuntimeAvailable) throw new ControlPlaneError("NOT_SUPPORTED", "The host agent is disabled on this server.");
  }

  async #hostJob(
    auth: AuthenticatedRequestContext,
    req: FastifyRequest,
    job: HostJob,
    action: string,
    details: Record<string, unknown>,
  ): Promise<{ operationId: string }> {
    const idempotencyKey = requireIdempotencyKey(headersOf(req));
    this.#requireAgent();
    return enqueueHostJob(this.dbClient.db, {
      job,
      actorId: auth.user.id,
      idempotencyKey,
      audit: {
        action,
        targetType: "host",
        targetId: job,
        details: { outcome: "succeeded", requestId: resolveRequestId(req), ...details },
        ipAddress: extractClientIp(req),
        userAgent: extractRawHeader(headersOf(req), "user-agent") ?? null,
      },
    });
  }

  async #activeJobs<J extends HostJob>(jobs: readonly J[]): Promise<Array<{ id: string; job: J }>> {
    const rows = await this.dbClient.db
      .select({ id: operations.id, job: operations.resourceId })
      .from(operations)
      .where(and(eq(operations.kind, HOST_JOB_KIND), inArray(operations.resourceId, [...jobs]), ACTIVE))
      .limit(1);
    return rows as Array<{ id: string; job: J }>;
  }
}
