import { randomBytes, randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  PLATFORM_OPS_ORG_ID,
  resolveWordpressImage,
  type AdminSitesListDto,
  type CertificateAlertDto,
  type CertProblem,
  resolveWordpressRuntime,
  type CreateManagedSiteInput,
  type ManagedSiteDto,
  type PhpVersion,
  type SiteActionInput,
  type SiteLogLineDto,
  wwwPartner,
} from "@hosting-panel/contracts";
import {
  WORDPRESS_TEMPLATE_ID,
  allocateHostTransactional,
  and,
  appendStackRevisionTransactional,
  asc,
  createServiceWithRevisionTransactional,
  createSiteTransactional,
  desc,
  domains,
  enqueueOperationTransactional,
  eq,
  hostAllocations,
  hosts,
  inArray,
  insertSiteDatabase,
  insertSiteDomains,
  isNotNull,
  latestSiteOperation,
  listSiteDomains,
  membershipRoles,
  memberships,
  not,
  operations,
  or,
  organizations,
  outboxEvents,
  serviceInstances,
  sites,
  sql,
  stackRevisions,
  updateOperationStepTransactional,
  upsertEncryptedSecretTransactional,
  users,
  type DatabaseClient,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
import { ControlPlaneError } from "../common/control-plane.error.js";
import {
  SITE_DELETE_STEPS,
  SITE_PROVISION_STEPS,
  SITE_REASSIGN_STEPS,
  siteDatabaseIdentifier,
} from "../runtime/site-provisioner.js";
import {
  CONTROL_PLANE_CONFIG_TOKEN,
  DATABASE_CLIENT_TOKEN,
  DOCKER_EXECUTOR_TOKEN,
  type ControlPlaneRuntimeConfig,
} from "../tokens.js";
import { restoreCertificateThrottle } from "./site-domains.service.js";

const SERVICE_STEPS = [
  { key: "validate_spec", label: "Check the request" },
  { key: "dispatch_ipc", label: "Apply the change" },
  { key: "reconcile_state", label: "Check the site" },
] as const;

const ALERT_WINDOW_MS = 14 * 24 * 3600_000;
const NOT_ISSUED_PROBLEMS: ReadonlySet<CertProblem | null> = new Set(["port_80_blocked", "caa_blocked", "other"]);

const isUniqueViolation = (err: unknown): boolean => {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
};

export interface ManagedSiteAccepted {
  readonly siteId: string;
  readonly operationId: string;
}

function slugify(name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "site";
  return `${base}-${randomBytes(3).toString("hex")}`;
}

@Injectable()
export class ManagedSitesService {
  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN)
    private readonly config: ControlPlaneRuntimeConfig,
    @Inject(DOCKER_EXECUTOR_TOKEN)
    private readonly executor: DockerExecutorPort,
  ) {}

  public async create(input: {
    organizationId: string;
    body: CreateManagedSiteInput;
    actorId: string;
    idempotencyKey: string;
  }): Promise<ManagedSiteAccepted> {
    const { organizationId, body, actorId, idempotencyKey } = input;
    const db = this.dbClient.db;

    // Replay before the domain check, or a network retry would turn into a 409.
    const replay = await this.#replay(organizationId, idempotencyKey);
    if (replay) return replay;

    const partner = body.includeWww ? wwwPartner(body.domain) : null;
    const names = partner ? [body.domain, partner] : [body.domain];
    const [usedDomain] = await db
      .select({ id: domains.id })
      .from(domains)
      .where(inArray(domains.hostname, names))
      .limit(1);
    const [panelHost] = await db
      .select({ id: hosts.id })
      .from(hosts)
      .where(
        or(inArray(hosts.hostname, names), inArray(hosts.ipv4Address, names)),
      )
      .limit(1);
    if (usedDomain || panelHost) {
      throw new ControlPlaneError(
        "DOMAIN_CONFLICT",
        "This web address is already used by another site or by the panel. Remove it from the other site first, or ask your administrator.",
      );
    }

    const [allocation] = await db
      .select()
      .from(hostAllocations)
      .where(
        and(
          eq(hostAllocations.organizationId, organizationId),
          eq(hostAllocations.status, "active"),
        ),
      )
      .limit(1);
    if (!allocation) {
      throw new ControlPlaneError(
        "NOT_FOUND",
        "This account has no server to host the site yet.",
      );
    }

    const runtime = resolveWordpressRuntime(body.phpVersion);
    const masterKey = this.config.secretsMasterKey;

    try {
      return await db.transaction(async (tx) => {
        // The repository helpers open their own transaction; nested they become savepoints.
        const t = tx as unknown as HostingPanelDatabase;
        const { site } = await createSiteTransactional(t, {
          organizationId,
          hostAllocationId: allocation.id,
          name: body.name,
          slug: slugify(body.name),
          initialDomain: body.domain,
          initialDomainStatus: "pending",
          status: "deploying",
          phpVersion: body.phpVersion,
          actorId,
        });

        if (partner) {
          await insertSiteDomains(t, { siteId: site.id, organizationId, hostnames: [partner], routed: false });
        }
        await restoreCertificateThrottle(t, await listSiteDomains(t, site.id));

        await createServiceWithRevisionTransactional(t, {
          siteId: site.id,
          organizationId,
          serviceTemplateId: WORDPRESS_TEMPLATE_ID,
          name: "web",
          // No WORDPRESS_* env: the image would write its own wp-config.php, which the install job refuses.
          configuration: {
            image: runtime.image,
            internalPort: runtime.internalPort,
            exposeHttp: true,
            volumeMounts: [
              {
                volumeSuffix: runtime.volumeSuffix,
                containerPath: runtime.contentPath,
              },
            ],
          },
          resourceLimits: { ...runtime.resourceLimits },
          actorId,
        });

        const dbPassword = await upsertEncryptedSecretTransactional(t, {
          organizationId,
          siteId: site.id,
          secretKey: "SITE_DB_PASSWORD",
          value: randomBytes(32).toString("hex"),
          masterKey,
          actorId,
        });
        await upsertEncryptedSecretTransactional(t, {
          organizationId,
          siteId: site.id,
          secretKey: "WP_ADMIN_PASSWORD_INITIAL",
          value: body.adminPassword,
          masterKey,
          actorId,
        });

        const identifier = siteDatabaseIdentifier(site.id);
        await insertSiteDatabase(tx, {
          id: `sdb_${randomUUID().replace(/-/g, "")}`,
          organizationId,
          siteId: site.id,
          dbName: identifier,
          dbUser: identifier,
          passwordSecretId: dbPassword.id,
        });

        const operationId = await this.#enqueueProvision(t, {
          organizationId,
          siteId: site.id,
          actorId,
          idempotencyKey,
          payload: {
            title: body.title,
            adminUser: body.adminUser,
            adminEmail: body.adminEmail,
          },
        });
        return { siteId: site.id, operationId };
      });
    } catch (err) {
      // A concurrent create passed the check above and committed first: the same key replays it.
      if (isUniqueViolation(err)) {
        const twin = await this.#replay(organizationId, idempotencyKey);
        if (twin) return twin;
        throw new ControlPlaneError(
          "DOMAIN_CONFLICT",
          "This web address is already used by another site or by the panel. Remove it from the other site first, or ask your administrator.",
        );
      }
      throw err;
    }
  }

  public async get(
    siteId: string,
    organizationId: string,
  ): Promise<ManagedSiteDto> {
    const site = await this.#loadSite(siteId, organizationId);
    const [primary] = await this.dbClient.db
      .select({ hostname: domains.hostname })
      .from(domains)
      .where(and(eq(domains.siteId, site.id), eq(domains.isPrimary, true)))
      .limit(1);
    return {
      id: site.id,
      organizationId: site.organizationId,
      hostAllocationId: site.hostAllocationId,
      name: site.name,
      slug: site.slug,
      status: site.status,
      phpVersion: site.phpVersion,
      primaryDomain: primary?.hostname ?? null,
      createdAt: site.createdAt.toISOString(),
      updatedAt: site.updatedAt.toISOString(),
    };
  }

  public async act(
    siteId: string,
    organizationId: string,
    action: SiteActionInput["action"],
    actorId: string,
    idempotencyKey?: string,
  ): Promise<ManagedSiteAccepted> {
    const site = await this.#loadSite(siteId, organizationId);
    if (action !== "retry") {
      return this.#power(site, action, actorId, idempotencyKey);
    }
    const replay = idempotencyKey
      ? await this.#replay(organizationId, idempotencyKey, siteId)
      : null;
    if (replay) return replay;

    const db = this.dbClient.db;
    const latest = await latestSiteOperation(db, {
      siteId,
      kind: "site.provision",
    });
    if (site.status !== "degraded" || latest?.status !== "failed") {
      throw new ControlPlaneError(
        "VALIDATION_ERROR",
        "There is nothing to retry.",
      );
    }

    const [event] = await db
      .select({ payload: outboxEvents.payload })
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.aggregateId, siteId),
          eq(outboxEvents.eventType, "operation.queued.site.provision"),
        ),
      )
      .orderBy(desc(outboxEvents.createdAt))
      .limit(1);
    const previous = (event?.payload ?? {}) as Record<string, unknown>;

    return db.transaction(async (tx) => {
      const t = tx as unknown as HostingPanelDatabase;
      const operationId = await this.#enqueueProvision(t, {
        organizationId,
        siteId,
        actorId,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        payload: {
          title: previous["title"],
          adminUser: previous["adminUser"],
          adminEmail: previous["adminEmail"],
        },
      });
      await tx
        .update(sites)
        .set({ status: "deploying", updatedAt: new Date() })
        .where(eq(sites.id, siteId));
      return { siteId, operationId };
    });
  }

  /** start, stop and restart all enqueue the existing service operations under the site lock. */
  async #power(
    site: typeof sites.$inferSelect,
    action: "start" | "stop" | "restart",
    actorId: string,
    idempotencyKey?: string,
  ): Promise<ManagedSiteAccepted> {
    const svc = await this.#webService(site);
    return this.dbClient.db.transaction(async (tx) => {
      const t = tx as unknown as HostingPanelDatabase;
      const enqueued = await enqueueOperationTransactional(t, {
        organizationId: site.organizationId,
        kind: action === "stop" ? "service.stop" : "service.restart",
        resourceType: "service",
        resourceId: svc.id,
        requestedByUserId: actorId,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        lockKey: `site:${site.id}`,
        steps: SERVICE_STEPS,
      });
      if (!enqueued.idempotentReplay && action !== "restart") {
        await tx
          .update(serviceInstances)
          .set({
            desiredStatus: action === "stop" ? "stopped" : "running",
            updatedAt: new Date(),
          })
          .where(eq(serviceInstances.id, svc.id));
      }
      return { siteId: site.id, operationId: enqueued.operation.id };
    });
  }

  /** New revision with the image of the chosen PHP version, then a redeploy; the volume survives. */
  public async changeRuntime(
    siteId: string,
    organizationId: string,
    phpVersion: PhpVersion,
    actorId: string,
    idempotencyKey?: string,
  ): Promise<ManagedSiteAccepted> {
    const site = await this.#loadSite(siteId, organizationId);
    const svc = await this.#webService(site);
    const [current] = svc.currentRevisionId
      ? await this.dbClient.db
          .select()
          .from(stackRevisions)
          .where(eq(stackRevisions.id, svc.currentRevisionId))
          .limit(1)
      : [];
    if (!current) {
      throw new ControlPlaneError(
        "NOT_FOUND",
        "Requested organization or resource was not found.",
      );
    }

    return this.dbClient.db.transaction(async (tx) => {
      const t = tx as unknown as HostingPanelDatabase;
      // Enqueue first: a held site lock aborts the whole transaction before any revision is written.
      const enqueued = await enqueueOperationTransactional(t, {
        organizationId,
        kind: "service.deploy",
        resourceType: "service",
        resourceId: svc.id,
        requestedByUserId: actorId,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        lockKey: `site:${siteId}`,
        steps: SERVICE_STEPS,
      });
      if (!enqueued.idempotentReplay) {
        await appendStackRevisionTransactional(t, {
          serviceInstanceId: svc.id,
          organizationId,
          declarativeConfig: {
            ...(current.declarativeConfig as Record<string, unknown>),
            image: resolveWordpressImage(phpVersion),
          },
          secretRefs: current.secretRefs as Record<string, string>,
          ...(current.resourceLimits
            ? {
                resourceLimits: current.resourceLimits as {
                  cpuMilli: number;
                  memoryBytes: string;
                },
              }
            : {}),
          authorId: actorId,
        });
        await tx
          .update(sites)
          .set({ phpVersion, updatedAt: new Date() })
          .where(eq(sites.id, siteId));
      }
      return { siteId, operationId: enqueued.operation.id };
    });
  }

  public async remove(
    siteId: string,
    organizationId: string,
    confirmName: string,
    actorId: string,
    idempotencyKey?: string,
  ): Promise<ManagedSiteAccepted> {
    const site = await this.#loadSite(siteId, organizationId);
    if (confirmName.trim() !== site.name) {
      throw new ControlPlaneError(
        "VALIDATION_ERROR",
        "Type the exact name of the site to delete it.",
        {
          details: [
            {
              field: "confirmName",
              message: "Type the exact name of the site to delete it.",
            },
          ],
        },
      );
    }
    return this.dbClient.db.transaction(async (tx) => {
      const t = tx as unknown as HostingPanelDatabase;
      const enqueued = await enqueueOperationTransactional(t, {
        organizationId,
        kind: "site.delete",
        resourceType: "site",
        resourceId: siteId,
        requestedByUserId: actorId,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        lockKey: `site:${siteId}`,
        steps: SITE_DELETE_STEPS,
      });
      if (!enqueued.idempotentReplay) {
        await tx
          .update(sites)
          .set({ status: "maintenance", updatedAt: new Date() })
          .where(eq(sites.id, siteId));
      }
      return { siteId, operationId: enqueued.operation.id };
    });
  }

  public async logs(
    siteId: string,
    organizationId: string,
    rawTail: number,
  ): Promise<SiteLogLineDto[]> {
    const site = await this.#loadSite(siteId, organizationId);
    const svc = await this.#webService(site);
    const tail = Math.min(
      500,
      Math.max(1, Number.isFinite(rawTail) ? Math.trunc(rawTail) : 200),
    );
    const unavailable = new ControlPlaneError(
      "DOCKER_ENGINE_UNAVAILABLE",
      "The logs are not available right now. Try again in a few minutes.",
    );
    if (!this.executor.isRuntimeAvailable) throw unavailable;
    try {
      const lines = await this.executor.getServiceLogs(svc.id, tail);
      return lines.map((l) => ({ at: l.at, stream: l.stream, text: l.text }));
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code === "NOT_SUPPORTED" || code === "DOCKER_ENGINE_UNAVAILABLE")
        throw unavailable;
      throw err;
    }
  }

  /** The platform-ops allocation that holds unassigned sites; org and allocation are created on first use. */
  public async ensureAdminHoldingAllocation(): Promise<string> {
    return this.dbClient.db.transaction(async (tx) => {
      // The host row lock serializes concurrent first uses, so only one allocation is created.
      const [host] = await tx.select().from(hosts).limit(1).for("update");
      if (!host) throw new ControlPlaneError("NOT_FOUND", "Installation has not been set up.");
      const [existing] = await tx
        .select({ id: hostAllocations.id })
        .from(hostAllocations)
        .where(and(eq(hostAllocations.organizationId, PLATFORM_OPS_ORG_ID), eq(hostAllocations.status, "active")))
        .limit(1);
      if (existing) return existing.id;
      await tx
        .insert(organizations)
        .values({
          id: PLATFORM_OPS_ORG_ID,
          platformInstallationId: host.platformInstallationId,
          name: "Platform Infrastructure Operations",
          slug: "platform-ops",
          status: "active",
        })
        .onConflictDoNothing();
      const { allocation } = await allocateHostTransactional(tx as unknown as HostingPanelDatabase, {
        hostId: host.id,
        organizationId: PLATFORM_OPS_ORG_ID,
        hostingMode: "dedicated",
      });
      return allocation!.id;
    });
  }

  /** Admin owner choice → target org: null is platform-ops ("unassigned"), else a customer with an active allocation. */
  public async resolveOwner(ownerOrganizationId: string | null): Promise<string> {
    if (ownerOrganizationId === null) {
      await this.ensureAdminHoldingAllocation();
      return PLATFORM_OPS_ORG_ID;
    }
    if (ownerOrganizationId === PLATFORM_OPS_ORG_ID) {
      throw new ControlPlaneError("VALIDATION_ERROR", "Choose a customer, or leave the site unassigned.", {
        details: [{ field: "ownerOrganizationId", message: "Choose a customer, or leave the site unassigned." }],
      });
    }
    const [allocation] = await this.dbClient.db
      .select({ id: hostAllocations.id })
      .from(hostAllocations)
      .where(and(eq(hostAllocations.organizationId, ownerOrganizationId), eq(hostAllocations.status, "active")))
      .limit(1);
    if (!allocation) throw new ControlPlaneError("NOT_FOUND", "This customer was not found. Pick one from the list.");
    return ownerOrganizationId;
  }

  /** The organization that currently holds a managed site (admin routes are not org-scoped). */
  public async ownerOf(siteId: string): Promise<string> {
    const [site] = await this.dbClient.db
      .select({ organizationId: sites.organizationId })
      .from(sites)
      .where(and(eq(sites.id, siteId), isNotNull(sites.phpVersion)))
      .limit(1);
    if (!site) throw new ControlPlaneError("NOT_FOUND", "Requested organization or resource was not found.");
    return site.organizationId;
  }

  public async listAll(): Promise<AdminSitesListDto> {
    const db = this.dbClient.db;
    const rows = await db
      .select({ site: sites, orgName: organizations.name, primaryDomain: domains.hostname })
      .from(sites)
      .innerJoin(organizations, eq(organizations.id, sites.organizationId))
      .leftJoin(domains, and(eq(domains.siteId, sites.id), eq(domains.isPrimary, true)))
      .where(isNotNull(sites.phpVersion))
      .orderBy(asc(sites.name), asc(sites.id));
    const customers = await db
      .selectDistinct({ organizationId: organizations.id, name: organizations.name, ownerEmail: users.email })
      .from(hostAllocations)
      .innerJoin(organizations, eq(organizations.id, hostAllocations.organizationId))
      .innerJoin(memberships, eq(memberships.organizationId, organizations.id))
      .innerJoin(
        membershipRoles,
        and(eq(membershipRoles.membershipId, memberships.id), eq(membershipRoles.roleId, "role_customer_owner")),
      )
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(hostAllocations.status, "active"), not(eq(organizations.id, PLATFORM_OPS_ORG_ID))))
      .orderBy(asc(organizations.name), asc(organizations.id));
    return {
      sites: rows.map(({ site, orgName, primaryDomain }) => ({
        id: site.id,
        organizationId: site.organizationId,
        hostAllocationId: site.hostAllocationId,
        name: site.name,
        slug: site.slug,
        status: site.status,
        phpVersion: site.phpVersion,
        primaryDomain: primaryDomain ?? null,
        owner: site.organizationId === PLATFORM_OPS_ORG_ID ? null : { organizationId: site.organizationId, name: orgName },
        createdAt: site.createdAt.toISOString(),
        updatedAt: site.updatedAt.toISOString(),
      })),
      customers,
      certificateAlerts: await this.#certificateAlerts(),
    };
  }

  async #certificateAlerts(): Promise<CertificateAlertDto[]> {
    const db = this.dbClient.db;
    const now = Date.now();
    const soon = (at: Date | null) => at !== null && at.getTime() < now + ALERT_WINDOW_MS;
    const rows = await db
      .select({ d: domains, siteName: sites.name })
      .from(domains)
      .innerJoin(sites, eq(sites.id, domains.siteId))
      .where(or(eq(domains.certStatus, "active"), eq(domains.certStatus, "failed"), isNotNull(domains.certProblem)))
      .orderBy(asc(sites.name), asc(domains.hostname));
    const alerts: CertificateAlertDto[] = [];
    for (const { d, siteName } of rows) {
      const kind =
        d.certStatus === "active"
          ? soon(d.certExpiresAt) || d.certProblem !== null
            ? "expiring" // a problem on an active certificate means its renewal is failing
            : null
          : (d.certStatus === "failed" && d.certAttempts >= 2) || NOT_ISSUED_PROBLEMS.has(d.certProblem)
            ? "not_issued"
            : null;
      if (kind) {
        alerts.push({
          kind,
          siteId: d.siteId,
          siteName,
          hostname: d.hostname,
          expiresAt: d.certExpiresAt?.toISOString() ?? null,
          problem: d.certProblem,
        });
      }
    }
    const [host] = await db.select({ hostname: hosts.hostname }).from(hosts).limit(1);
    if (host && this.executor.isRuntimeAvailable) {
      try {
        const report = await this.executor.getCertificateStatus({ failuresSince: new Date(now).toISOString() });
        const panel = report.certificates.find((c) => c.hostname === host.hostname);
        if (panel && soon(new Date(panel.notAfter))) {
          alerts.push({ kind: "panel_expiring", siteId: null, siteName: null, hostname: host.hostname, expiresAt: new Date(panel.notAfter).toISOString(), problem: null });
        }
      } catch {
        // The executor is unavailable: the site alerts above still show.
      }
    }
    return alerts;
  }

  /**
   * Enqueues site.reassign to an already resolved target org. The same owner is refused unless the
   * latest owner change failed: then only the redeploy runs, to finish a half-done move.
   */
  public async reassign(
    siteId: string,
    toOrganizationId: string,
    actorId: string,
    idempotencyKey?: string,
  ): Promise<ManagedSiteAccepted> {
    const from = await this.ownerOf(siteId);
    let redeployOnly = false;
    if (from === toOrganizationId) {
      const latest = await latestSiteOperation(this.dbClient.db, { siteId, kind: "site.reassign" });
      if (latest?.status !== "failed") {
        throw new ControlPlaneError("VALIDATION_ERROR", "The site already belongs to this customer.");
      }
      redeployOnly = true;
    }
    return this.dbClient.db.transaction(async (tx) => {
      const t = tx as unknown as HostingPanelDatabase;
      const enqueued = await enqueueOperationTransactional(t, {
        organizationId: from,
        kind: "site.reassign",
        resourceType: "site",
        resourceId: siteId,
        requestedByUserId: actorId,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        lockKey: `site:${siteId}`,
        steps: SITE_REASSIGN_STEPS,
        outboxPayload: { fromOrganizationId: from, toOrganizationId },
      });
      if (!enqueued.idempotentReplay && redeployOnly) {
        await updateOperationStepTransactional(t, enqueued.operation.id, "move_ownership", "skipped", "Already done");
      }
      return { siteId, operationId: enqueued.operation.id };
    });
  }

  /** Admin "Try again": a failed owner change newer than the setup is re-issued; otherwise the setup is retried. */
  public async adminRetry(siteId: string, actorId: string, idempotencyKey?: string): Promise<ManagedSiteAccepted> {
    const db = this.dbClient.db;
    const owner = await this.ownerOf(siteId);
    const reassign = await latestSiteOperation(db, { siteId, kind: "site.reassign" });
    const provision = await latestSiteOperation(db, { siteId, kind: "site.provision" });
    if (reassign?.status === "failed" && (!provision || reassign.submittedAt >= provision.submittedAt)) {
      const [event] = await db
        .select({ payload: outboxEvents.payload })
        .from(outboxEvents)
        .where(sql`${outboxEvents.payload}->>'operationId' = ${reassign.id}`)
        .limit(1);
      // toOrganizationId is the requested owner, not the stamped (pre-move) organizationId.
      const target = (event?.payload as Record<string, unknown> | undefined)?.["toOrganizationId"];
      if (typeof target !== "string") throw new ControlPlaneError("VALIDATION_ERROR", "There is nothing to retry.");
      const to = await this.resolveOwner(target === PLATFORM_OPS_ORG_ID ? null : target);
      return this.reassign(siteId, to, actorId, idempotencyKey);
    }
    return this.act(siteId, owner, "retry", actorId, idempotencyKey);
  }

  async #webService(site: typeof sites.$inferSelect) {
    const [svc] = await this.dbClient.db
      .select()
      .from(serviceInstances)
      .where(
        and(
          eq(serviceInstances.siteId, site.id),
          eq(serviceInstances.organizationId, site.organizationId),
        ),
      )
      .limit(1);
    if (!svc) {
      throw new ControlPlaneError(
        "NOT_FOUND",
        "Requested organization or resource was not found.",
      );
    }
    return svc;
  }

  /** The site.provision already accepted under this key, if any. */
  async #replay(
    organizationId: string,
    idempotencyKey: string,
    siteId?: string,
  ): Promise<ManagedSiteAccepted | null> {
    const [previous] = await this.dbClient.db
      .select()
      .from(operations)
      .where(
        and(
          eq(operations.organizationId, organizationId),
          eq(operations.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    if (!previous) return null;
    if (
      previous.kind !== "site.provision" ||
      (siteId !== undefined && previous.resourceId !== siteId)
    ) {
      throw new ControlPlaneError(
        "IDEMPOTENCY_CONFLICT",
        "This Idempotency-Key was already used for another request.",
      );
    }
    return { siteId: previous.resourceId, operationId: previous.id };
  }

  async #enqueueProvision(
    db: HostingPanelDatabase,
    input: {
      organizationId: string;
      siteId: string;
      actorId: string;
      idempotencyKey?: string;
      payload: Record<string, unknown>;
    },
  ): Promise<string> {
    const enqueued = await enqueueOperationTransactional(db, {
      organizationId: input.organizationId,
      kind: "site.provision",
      resourceType: "site",
      resourceId: input.siteId,
      requestedByUserId: input.actorId,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      lockKey: `site:${input.siteId}`,
      steps: SITE_PROVISION_STEPS,
      // Not secrets: the enqueue check rejects secret keys anyway.
      outboxPayload: input.payload,
    });
    return enqueued.operation.id;
  }

  async #loadSite(siteId: string, organizationId: string) {
    const [site] = await this.dbClient.db
      .select()
      .from(sites)
      .where(
        and(eq(sites.id, siteId), eq(sites.organizationId, organizationId)),
      )
      .limit(1);
    if (!site) {
      throw new ControlPlaneError(
        "NOT_FOUND",
        "Requested organization or resource was not found.",
      );
    }
    return site;
  }
}
