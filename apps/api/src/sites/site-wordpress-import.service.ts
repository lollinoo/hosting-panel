import { Inject, Injectable } from "@nestjs/common";
import {
  isWordpressSite,
  isWordpressToolsAvailable,
  SiteWordpressLastImportDtoSchema,
  WORDPRESS_IMPORT_KIND,
  WORDPRESS_IMPORT_STEP_KEYS,
  type ManagedSiteDto,
  type SiteWordpressAcceptedDto,
  type SiteWordpressImportChunkRequest,
  type SiteWordpressImportDto,
  type SiteWordpressImportSlotDto,
  type WordpressImportSlot,
} from "@hosting-panel/contracts";
import {
  ACTIVE_OPERATION_LOCK_STATUSES,
  and,
  appendAuditEvent,
  asc,
  enqueueOperationTransactional,
  eq,
  getSiteWordpressState,
  inArray,
  insertSiteBackup,
  operations,
  operationSteps,
  sites,
  type DatabaseClient,
  type DatabaseExecutor,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import type { DockerExecutorPort, SiteFilesRequest, SiteFilesResult } from "@hosting-panel/executor-contracts";
import { assertHeavyActionAllowed } from "../backups/site-restore.service.js";
import { ControlPlaneError, extractClientIp, extractRawHeader, resolveRequestId } from "../common/control-plane.error.js";
import { SITE_STEP_LEASE_MS } from "../runtime/site-provisioner.js";
import {
  CONTROL_PLANE_CONFIG_TOKEN,
  DATABASE_CLIENT_TOKEN,
  DOCKER_EXECUTOR_TOKEN,
  type ControlPlaneRuntimeConfig,
} from "../tokens.js";
import type { SiteDatabaseActor } from "./site-databases.service.js";
import { mapSiteFileExecutorError, resolveSiteFilesServiceId } from "./site-files.service.js";
import { SITE_WORDPRESS_IMPORT_STEPS } from "./site-wordpress-import-applier.js";
import { SiteWordpressService } from "./site-wordpress.service.js";

type ImportRefusal = "import_running" | "files_incomplete" | "earlier_import_unfinished";

const REFUSALS: Readonly<Record<ImportRefusal, string>> = {
  import_running: "An import of this site is running. Wait until it ends, then try again.",
  files_incomplete: "Both files are needed first. Upload the site files and the database export, then start the import.",
  earlier_import_unfinished: "An earlier import of this site was not finished. Restore a copy from Backups, then try again.",
};

const refusal = (reason: ImportRefusal) =>
  new ControlPlaneError("RESOURCE_LOCKED", REFUSALS[reason], { details: [{ reason, message: REFUSALS[reason] }] });

const AUDIT_PATH_MAX_CHARS = 256;

/** The import's two uploaded files, its state and its start. */
@Injectable()
export class SiteWordpressImportService {
  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) readonly dbClient: DatabaseClient,
    @Inject(DOCKER_EXECUTOR_TOKEN) readonly dockerExecutor: DockerExecutorPort,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) readonly config: ControlPlaneRuntimeConfig,
    @Inject(SiteWordpressService) readonly wordpressService: SiteWordpressService,
  ) {}

  /** The two slots, the running import and the outcome of the last one. */
  public async get(site: ManagedSiteDto): Promise<SiteWordpressImportDto> {
    const available =
      isWordpressToolsAvailable(this.config.runtimeBackend) && this.dockerExecutor.isRuntimeAvailable && isWordpressSite(site);
    // A failed or unanswered stat still lets the tab render (slots: null).
    const stat = available ? await this.#files(site, { op: "import.stat" }).catch(() => null) : null;
    const stored = await getSiteWordpressState(this.dbClient.db, { organizationId: site.organizationId, siteId: site.id });
    return {
      available,
      backupsConfigured: await this.wordpressService.backupsConfigured(),
      slots: stat ? { archive: stat.archive, dump: stat.dump } : null,
      earlierImportUnfinished: stat?.remains ?? false,
      runningOperation: await this.#running(site),
      lastImport: SiteWordpressLastImportDtoSchema.safeParse(stored?.lastImport).data ?? null,
    };
  }

  /** Writes one chunk of a slot. */
  public async putChunk(
    site: ManagedSiteDto,
    slot: WordpressImportSlot,
    body: SiteWordpressImportChunkRequest,
    actor: SiteDatabaseActor,
  ): Promise<{ received: number }> {
    await this.#assertChangeable(site);
    const result = await this.#files(site, { op: "import.put", slot, ...body });
    if (body.final) {
      await this.#audit(this.dbClient.db, site, actor, "file_uploaded", { slot, size: result.received });
    }
    return result;
  }

  /** Takes a file the customer put on the site (SFTP) into a slot. */
  public async pick(site: ManagedSiteDto, slot: WordpressImportSlot, path: string, actor: SiteDatabaseActor): Promise<SiteWordpressImportSlotDto> {
    await this.#assertChangeable(site);
    const { size } = await this.#files(site, { op: "import.take", slot, path });
    await this.#audit(this.dbClient.db, site, actor, "file_picked", { slot, path: path.slice(0, AUDIT_PATH_MAX_CHARS) });
    return { state: "complete", size, uploadId: null };
  }

  /** Removes both slots. */
  public async discard(site: ManagedSiteDto, actor: SiteDatabaseActor): Promise<void> {
    await this.#assertChangeable(site);
    await this.#files(site, { op: "import.discard" });
    await this.#audit(this.dbClient.db, site, actor, "files_discarded", {});
  }

  /** Queues the import, with a copy first when backups are set up (as `SiteWordpressService.update`). */
  public async start(site: ManagedSiteDto, idempotencyKey: string, actor: SiteDatabaseActor): Promise<SiteWordpressAcceptedDto> {
    this.wordpressService.assertUsable(site);
    // A replay answers its operation even while it runs or after it emptied the slots.
    const [replay] = await this.dbClient.db
      .select({ id: operations.id })
      .from(operations)
      .where(
        and(
          eq(operations.organizationId, site.organizationId),
          eq(operations.idempotencyKey, idempotencyKey),
          eq(operations.kind, WORDPRESS_IMPORT_KIND),
          eq(operations.resourceId, site.id),
        ),
      )
      .limit(1);
    if (replay) {
      return { siteId: site.id, operationId: replay.id };
    }
    await this.#assertNoImport(site);
    const stat = await this.#files(site, { op: "import.stat" });
    if (stat.remains) {
      throw refusal("earlier_import_unfinished");
    }
    if (stat.archive.state !== "complete" || stat.dump.state !== "complete") {
      throw refusal("files_incomplete");
    }
    const backupsConfigured = await this.wordpressService.backupsConfigured();
    const operationId = await this.dbClient.db.transaction(async (tx) => {
      const enqueued = await enqueueOperationTransactional(tx as unknown as HostingPanelDatabase, {
        organizationId: site.organizationId,
        kind: WORDPRESS_IMPORT_KIND,
        resourceType: "site",
        resourceId: site.id,
        requestedByUserId: actor.auth.user.id,
        idempotencyKey,
        lockKey: `site:${site.id}`,
        leaseDurationMs: SITE_STEP_LEASE_MS,
        steps: SITE_WORDPRESS_IMPORT_STEPS,
        outboxPayload: { siteId: site.id },
      });
      const { id, submittedAt } = enqueued.operation;
      if (!enqueued.idempotentReplay) {
        await assertHeavyActionAllowed(tx, site.id, actor, { id, submittedAt });
        if (backupsConfigured) {
          const [row] = await tx.select({ siteUrl: sites.wordpressUrl }).from(sites).where(eq(sites.id, site.id)).limit(1);
          await insertSiteBackup(tx, { siteId: site.id, kind: "pre_update", status: "running", operationId: id, siteUrl: row?.siteUrl ?? null });
        }
        await this.#audit(tx, site, actor, "requested", { operationId: id, backup: backupsConfigured ? "taken" : "skipped" });
      }
      return id;
    });
    return { siteId: site.id, operationId };
  }

  /** The shipped WordPress guards, then no import of this site may be active. */
  async #assertChangeable(site: ManagedSiteDto): Promise<void> {
    this.wordpressService.assertUsable(site);
    await this.#assertNoImport(site);
  }

  async #assertNoImport(site: ManagedSiteDto): Promise<void> {
    if (await this.#running(site)) {
      throw refusal("import_running");
    }
  }

  /** The active import of this site with its steps in order, or null. */
  async #running(site: ManagedSiteDto): Promise<SiteWordpressImportDto["runningOperation"]> {
    const [running] = await this.dbClient.db
      .select({ id: operations.id, status: operations.status })
      .from(operations)
      .where(
        and(
          eq(operations.lockKey, `site:${site.id}`),
          inArray(operations.status, [...ACTIVE_OPERATION_LOCK_STATUSES]),
          eq(operations.kind, WORDPRESS_IMPORT_KIND),
        ),
      )
      .limit(1);
    if (!running) {
      return null;
    }
    const steps = await this.dbClient.db
      .select({ key: operationSteps.key, status: operationSteps.status })
      .from(operationSteps)
      .where(eq(operationSteps.operationId, running.id))
      .orderBy(asc(operationSteps.id));
    const order = (key: string) => WORDPRESS_IMPORT_STEP_KEYS.indexOf(key as (typeof WORDPRESS_IMPORT_STEP_KEYS)[number]);
    return {
      id: running.id,
      kind: WORDPRESS_IMPORT_KIND,
      status: running.status,
      steps: steps
        .map((s) => ({ key: s.key as (typeof WORDPRESS_IMPORT_STEP_KEYS)[number], status: s.status }))
        .sort((x, y) => order(x.key) - order(y.key)),
    };
  }

  /** One `import.*` call on the site's files, with executor errors mapped to the file manager's closed answers. */
  async #files<R extends Omit<SiteFilesRequest, "serviceInstanceId">>(
    site: ManagedSiteDto,
    req: R,
  ): Promise<SiteFilesResult<R["op"]>> {
    const serviceInstanceId = await resolveSiteFilesServiceId(this.dbClient.db, this.dockerExecutor, this.config, site);
    try {
      return await this.dockerExecutor.siteFiles({ ...req, serviceInstanceId } as SiteFilesRequest & { op: R["op"] });
    } catch (err) {
      throw mapSiteFileExecutorError(err);
    }
  }

  async #audit(
    db: DatabaseExecutor,
    site: ManagedSiteDto,
    actor: SiteDatabaseActor,
    event: "file_uploaded" | "file_picked" | "files_discarded" | "requested",
    details: Record<string, unknown>,
  ): Promise<void> {
    await appendAuditEvent(db as unknown as HostingPanelDatabase, {
      actorId: actor.auth.user.id,
      actorType: "user",
      organizationId: site.organizationId,
      action: `site.wordpress.import.${event}`,
      targetType: "site",
      targetId: site.id,
      ipAddress: extractClientIp(actor.req),
      userAgent: extractRawHeader(actor.req.headers as Record<string, string | string[] | undefined>, "user-agent"),
      details: { requestId: resolveRequestId(actor.req), ...details },
    });
  }
}
