import { randomBytes, randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  resolveWordpressImage,
  resolveWordpressRuntime,
  type CreateManagedSiteInput,
  type ManagedSiteDto,
  type PhpVersion,
  type SiteActionInput,
  type SiteLogLineDto,
} from "@hosting-panel/contracts";
import {
  WORDPRESS_TEMPLATE_ID,
  and,
  appendStackRevisionTransactional,
  createServiceWithRevisionTransactional,
  createSiteTransactional,
  desc,
  domains,
  enqueueOperationTransactional,
  eq,
  hostAllocations,
  hosts,
  insertSiteDatabase,
  latestSiteOperation,
  operations,
  or,
  outboxEvents,
  serviceInstances,
  sites,
  stackRevisions,
  upsertEncryptedSecretTransactional,
  type DatabaseClient,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
import { ControlPlaneError } from "../common/control-plane.error.js";
import {
  SITE_DELETE_STEPS,
  SITE_PROVISION_STEPS,
  siteDatabaseIdentifier,
} from "../runtime/site-provisioner.js";
import {
  CONTROL_PLANE_CONFIG_TOKEN,
  DATABASE_CLIENT_TOKEN,
  DOCKER_EXECUTOR_TOKEN,
  type ControlPlaneRuntimeConfig,
} from "../tokens.js";

const SERVICE_STEPS = [
  { key: "validate_spec", label: "Validate declarative specification" },
  { key: "dispatch_ipc", label: "Dispatch signed request to docker-executor" },
  { key: "reconcile_state", label: "Reconcile observed container state" },
] as const;

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

    const [usedDomain] = await db
      .select({ id: domains.id })
      .from(domains)
      .where(eq(domains.hostname, body.domain))
      .limit(1);
    const [panelHost] = await db
      .select({ id: hosts.id })
      .from(hosts)
      .where(
        or(eq(hosts.hostname, body.domain), eq(hosts.ipv4Address, body.domain)),
      )
      .limit(1);
    if (usedDomain || panelHost) {
      throw new ControlPlaneError(
        "DOMAIN_CONFLICT",
        "This web address is already used by another site or by the panel.",
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
      // A concurrent create passed the check above and committed first.
      if (isUniqueViolation(err)) {
        throw new ControlPlaneError(
          "DOMAIN_CONFLICT",
          "This web address is already used by another site or by the panel.",
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
