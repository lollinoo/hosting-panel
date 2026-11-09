import { Inject, Injectable } from "@nestjs/common";
import {
  canTransitionOperation,
  isTerminalOperationStatus,
  redactSensitiveString,
  type SiteHostRoute,
} from "@hosting-panel/contracts";
import {
  and,
  appendAuditEvent,
  enqueueOperationTransactional,
  eq,
  latestSiteOperation,
  listSiteDomains,
  operationSteps,
  operations,
  renewOperationLease,
  serviceInstances,
  sites,
  transitionOperation,
  updateOperationStepTransactional,
  type DatabaseClient,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
import { ControlPlaneError } from "../common/control-plane.error.js";
import { buildApprovedServiceSpec } from "../runtime/service-spec.js";
import { SITE_STEP_LEASE_MS, SiteJobFailedError } from "../runtime/site-provisioner.js";
import {
  CONTROL_PLANE_CONFIG_TOKEN,
  DATABASE_CLIENT_TOKEN,
  DOCKER_EXECUTOR_TOKEN,
  type ControlPlaneRuntimeConfig,
} from "../tokens.js";
import { SITE_DOMAINS_STEPS, buildSiteHostRoutes, desiredWordpressUrl, routePlanHash } from "./domain-policy.js";

type SiteDomainsStep = (typeof SITE_DOMAINS_STEPS)[number]["key"];

// Shown to every org member: fixed texts only.
const STEP_DONE: Readonly<Record<SiteDomainsStep, string>> = {
  prepare: "Ready for the change",
  update_address: "Site address updated",
  publish: "Web addresses published",
};
const STEP_RUNNING = "In progress";
const STEP_NOTHING = "Nothing to change";
const STEP_FAILED = "Could not finish this step";
const STEP_SKIPPED = "Skipped due to prior step failure";
export const SITE_DOMAINS_FAILED = "The web address change did not finish. We'll try again shortly.";
export const SITE_DOMAINS_INTERRUPTED = "This change was interrupted. We'll try again shortly.";

/** Queues a site.domains run under the site lock, so it never overlaps any other site operation. */
export function enqueueSiteDomainsOperation(
  db: HostingPanelDatabase,
  input: { organizationId: string; siteId: string; requestedByUserId?: string; idempotencyKey?: string },
) {
  return enqueueOperationTransactional(db, {
    organizationId: input.organizationId,
    kind: "site.domains",
    resourceType: "site",
    resourceId: input.siteId,
    ...(input.requestedByUserId ? { requestedByUserId: input.requestedByUserId } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    lockKey: `site:${input.siteId}`,
    steps: SITE_DOMAINS_STEPS,
  });
}

@Injectable()
export class SiteDomainsApplier {
  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(DOCKER_EXECUTOR_TOKEN) private readonly executor: DockerExecutorPort,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) private readonly config: ControlPlaneRuntimeConfig,
  ) {}

  /**
   * Publishes the site's route plan. When WordPress must change address, every host first serves
   * without redirects, then the address switches, then the final plan goes out: no redirect loop.
   * On failure the site keeps its status; the reconciler re-enqueues.
   */
  public async apply(op: typeof operations.$inferSelect): Promise<void> {
    const db = this.dbClient.db;
    const { organizationId, resourceId: siteId } = op;
    let current: SiteDomainsStep = "prepare";

    const step = async (key: SiteDomainsStep, work: (() => Promise<void>) | null): Promise<void> => {
      current = key;
      await renewOperationLease(db, op.id, SITE_STEP_LEASE_MS);
      if (!work) {
        await updateOperationStepTransactional(db, op.id, key, "skipped", STEP_NOTHING);
        return;
      }
      await updateOperationStepTransactional(db, op.id, key, "running", STEP_RUNNING);
      await work();
      await updateOperationStepTransactional(db, op.id, key, "succeeded", STEP_DONE[key]);
    };

    try {
      const [site] = await db
        .select()
        .from(sites)
        .where(and(eq(sites.id, siteId), eq(sites.organizationId, organizationId)))
        .limit(1);
      const [svc] = await db
        .select()
        .from(serviceInstances)
        .where(and(eq(serviceInstances.siteId, siteId), eq(serviceInstances.organizationId, organizationId)))
        .limit(1);
      if (!site?.phpVersion || !svc) {
        throw new ControlPlaneError("NOT_FOUND", `Managed site '${siteId}' is incomplete`);
      }

      const now = new Date();
      const rows = await listSiteDomains(db, siteId);
      const spec = await buildApprovedServiceSpec(db, this.config, { organizationId, serviceInstanceId: svc.id });
      const { acmeEnabled } = await this.executor.getCertificateStatus({ failuresSince: now.toISOString() });
      const primary = rows.find((r) => r.isPrimary && r.status === "active");
      const currentUrl = site.wordpressUrl ?? (primary ? `http://${primary.hostname}` : null);
      const wanted = desiredWordpressUrl(rows, now, currentUrl, acmeEnabled);
      const wpInstalled = (await latestSiteOperation(db, { siteId, kind: "site.provision" }))?.status === "succeeded";
      const switchUrl = wpInstalled && wanted !== null && currentUrl !== null && wanted !== currentUrl;
      const publish = (hosts: readonly SiteHostRoute[]) =>
        this.executor.applySiteRoutes({
          siteId,
          serviceInstanceId: svc.id,
          containerName: spec.containerName,
          internalPort: spec.internalPort ?? 80,
          hosts,
        });

      await step(
        "prepare",
        switchUrl ? () => publish(buildSiteHostRoutes(rows, now, { transition: true, acmeEnabled })) : null,
      );

      await step(
        "update_address",
        switchUrl
          ? async () => {
              const result = await this.executor.runSiteJob({
                jobId: `job_${op.id.replace(/^op_/, "")}_url`,
                kind: "wordpress.set-url",
                siteId,
                organizationId,
                serviceInstanceId: svc.id,
                params: { phpVersion: site.phpVersion!, siteUrl: wanted, previousUrl: currentUrl },
              });
              if (result.exitCode !== 0) throw new SiteJobFailedError(result.exitCode, result.outputTail);
            }
          : null,
      );

      await step("publish", async () => {
        const final = buildSiteHostRoutes(rows, now, { acmeEnabled });
        await publish(final);
        // Every executor call is done; what is left is bookkeeping (processing cannot go straight to succeeded).
        await transitionOperation(db, op.id, "reconciling", { leaseDurationMs: SITE_STEP_LEASE_MS });
        await db
          .update(sites)
          .set({
            appliedRoutes: final,
            appliedRoutesHash: routePlanHash(final, wanted),
            ...(switchUrl ? { wordpressUrl: wanted } : {}),
            updatedAt: new Date(),
          })
          .where(eq(sites.id, siteId));
      });

      await transitionOperation(db, op.id, "succeeded", { errorCode: null, errorMessage: null });
      await appendAuditEvent(db, {
        actorId: null,
        actorType: "system",
        organizationId,
        action: "site.domains.applied",
        targetType: "site",
        targetId: siteId,
        details: { operationId: op.id, wordpressUrl: switchUrl ? wanted : null },
      });
    } catch (err) {
      await this.#settleFailure(op, current, err);
      throw err;
    }
  }

  async #settleFailure(op: typeof operations.$inferSelect, failedStep: SiteDomainsStep, err: unknown): Promise<void> {
    const db = this.dbClient.db;
    const steps = await db.select().from(operationSteps).where(eq(operationSteps.operationId, op.id));
    for (const s of steps) {
      if (s.key === failedStep && !["succeeded", "failed", "skipped", "cancelled"].includes(s.status)) {
        await updateOperationStepTransactional(db, op.id, s.key, "failed", STEP_FAILED);
      } else if (s.status === "pending") {
        await updateOperationStepTransactional(db, op.id, s.key, "skipped", STEP_SKIPPED);
      }
    }
    const [latest] = await db.select().from(operations).where(eq(operations.id, op.id)).limit(1);
    if (latest && !isTerminalOperationStatus(latest.status) && canTransitionOperation(latest.status, "failed")) {
      await transitionOperation(db, op.id, "failed", {
        errorCode: err instanceof ControlPlaneError ? err.code : "INTERNAL_ERROR",
        errorMessage: SITE_DOMAINS_FAILED,
      });
    }
    // Raw job output is admin-only (customers lack audit.read), redacted and capped at 1 KiB.
    const jobFailure = err instanceof SiteJobFailedError ? err : null;
    const raw = jobFailure ? jobFailure.outputTail : err instanceof Error ? err.message : String(err);
    await appendAuditEvent(db, {
      actorId: null,
      actorType: "system",
      organizationId: op.organizationId,
      action: "site.domains.failed",
      targetType: "site",
      targetId: op.resourceId,
      details: {
        operationId: op.id,
        step: failedStep,
        exitCode: jobFailure?.exitCode ?? null,
        outputTail: redactSensitiveString(raw).slice(0, 1024),
      },
    });
  }
}
