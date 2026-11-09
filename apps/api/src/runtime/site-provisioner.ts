import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  canTransitionOperation,
  isTerminalOperationStatus,
  redactSensitiveString,
} from "@hosting-panel/contracts";
import {
  and,
  appendAuditEvent,
  deleteEncryptedSecretTransactional,
  domains,
  encryptedSecrets,
  eq,
  hostAllocations,
  latestSiteOperation,
  listSiteDatabases,
  moveSiteToOrganizationTransactional,
  operationSteps,
  operations,
  renewOperationLease,
  resolveDecryptedSecretRefs,
  serviceInstances,
  sites,
  transitionOperation,
  updateOperationStepTransactional,
  type DatabaseClient,
} from "@hosting-panel/database";
import type { DockerExecutorPort, SiteJobRequest } from "@hosting-panel/executor-contracts";
import { ControlPlaneError } from "../common/control-plane.error.js";
import {
  CONTROL_PLANE_CONFIG_TOKEN,
  DATABASE_CLIENT_TOKEN,
  DOCKER_EXECUTOR_TOKEN,
  type ControlPlaneRuntimeConfig,
} from "../tokens.js";
import { routePlanHash } from "../sites/domain-policy.js";
import { buildApprovedServiceSpec, recordDeployedState } from "./service-spec.js";

/** The claim sets a 60 s lease; one site job may take up to 510 s, so each step renews it first. */
export const SITE_STEP_LEASE_MS = 12 * 60_000;

export const SITE_PROVISION_STEPS = [
  { key: "create_database", label: "Prepare the database" },
  { key: "deploy_site", label: "Start the site" },
  { key: "install_wordpress", label: "Install WordPress" },
  { key: "publish_site", label: "Publish the site" },
  { key: "finish", label: "Finish" },
] as const;

export const SITE_DELETE_STEPS = [
  { key: "drop_database", label: "Remove the database" },
  { key: "remove_site", label: "Remove the site" },
  { key: "finish", label: "Finish" },
] as const;

export const SITE_REASSIGN_STEPS = [
  { key: "move_ownership", label: "Change the owner" },
  { key: "redeploy", label: "Restart the site" },
] as const;

type SiteProvisionStep = (typeof SITE_PROVISION_STEPS)[number]["key"];
type SiteDeleteStep = (typeof SITE_DELETE_STEPS)[number]["key"];
type SiteReassignStep = (typeof SITE_REASSIGN_STEPS)[number]["key"];

const REASSIGN_STEP_DONE: Readonly<Record<SiteReassignStep, string>> = {
  move_ownership: "Owner changed",
  redeploy: "Site restarted",
};
export const SITE_REASSIGN_FAILED = "The owner change did not finish";

const DELETE_STEP_DONE: Readonly<Record<SiteDeleteStep, string>> = {
  drop_database: "Database removed",
  remove_site: "Site removed",
  finish: "Your site was deleted",
};
export const SITE_DELETE_FAILED = "Site could not be deleted";

// Step and operation messages are shown to every org member: fixed texts only.
const STEP_DONE: Readonly<Record<SiteProvisionStep, string>> = {
  create_database: "Database ready",
  deploy_site: "Site started",
  install_wordpress: "WordPress installed",
  publish_site: "Site published",
  finish: "Your site is ready",
};
const STEP_RUNNING = "In progress";
const STEP_FAILED = "Could not finish this step";
const STEP_SKIPPED = "Skipped due to prior step failure";
export const SITE_SETUP_FAILED = "Site setup did not finish";

/** Database name and user of a site's WordPress database. */
export function siteDatabaseIdentifier(siteId: string): string {
  return `wp_${createHash("sha256").update(siteId).digest("hex").slice(0, 12)}`;
}

export class SiteJobFailedError extends Error {
  public constructor(
    public readonly exitCode: number,
    public readonly outputTail: string,
  ) {
    super(`Site job exited with code ${String(exitCode)}`);
  }
}

@Injectable()
export class SiteProvisioner {
  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(DOCKER_EXECUTOR_TOKEN) private readonly executor: DockerExecutorPort,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) private readonly config: ControlPlaneRuntimeConfig,
  ) {}

  /** Runs the site.provision steps; on failure settles the operation and the site, then rethrows. */
  public async provision(
    op: typeof operations.$inferSelect,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const db = this.dbClient.db;
    const organizationId = op.organizationId;
    const siteId = op.resourceId;
    let current: SiteProvisionStep = "create_database";

    const step = async (key: SiteProvisionStep, work: () => Promise<void>): Promise<void> => {
      current = key;
      await renewOperationLease(db, op.id, SITE_STEP_LEASE_MS);
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
      const [siteDb] = await listSiteDatabases(db, { organizationId, siteId });
      const [primary] = await db
        .select()
        .from(domains)
        .where(and(eq(domains.siteId, siteId), eq(domains.isPrimary, true)))
        .limit(1);
      if (!site?.phpVersion || !svc || !siteDb || !primary) {
        throw new ControlPlaneError("NOT_FOUND", `Managed site '${siteId}' is incomplete`);
      }

      const jobId = (suffix: string) => `job_${op.id.replace(/^op_/, "")}_${suffix}`;
      const dbParams = { dbName: siteDb.dbName, dbUser: siteDb.dbUser };
      const deploy = async () => {
        const spec = await buildApprovedServiceSpec(db, this.config, {
          organizationId,
          serviceInstanceId: svc.id,
        });
        await recordDeployedState(db, this.executor, spec, await this.executor.deployService(spec));
        return spec;
      };

      await step("create_database", async () => {
        await this.#runJob({
          jobId: jobId("db"),
          kind: "db.provision",
          siteId,
          organizationId,
          params: dbParams,
          resolvedSecrets: await this.#secrets(op, { HP_DB_PASSWORD: "SITE_DB_PASSWORD" }),
        });
      });

      await step("deploy_site", async () => {
        await deploy();
      });

      await step("install_wordpress", async () => {
        if (await this.#installedByEarlierAttempt(siteId)) return;
        const [adminSecret] = await db
          .select({ id: encryptedSecrets.id })
          .from(encryptedSecrets)
          .where(and(eq(encryptedSecrets.siteId, siteId), eq(encryptedSecrets.secretKey, "WP_ADMIN_PASSWORD_INITIAL")))
          .limit(1);
        await this.#runJob({
          jobId: jobId("wp"),
          kind: "wordpress.install",
          siteId,
          organizationId,
          serviceInstanceId: svc.id,
          params: {
            ...dbParams,
            phpVersion: site.phpVersion!,
            siteUrl: `http://${primary.hostname}`,
            title: stringField(payload, "title"),
            adminUser: stringField(payload, "adminUser"),
            adminEmail: stringField(payload, "adminEmail"),
          },
          resolvedSecrets: await this.#secrets(op, {
            HP_DB_PASSWORD: "SITE_DB_PASSWORD",
            ...(adminSecret ? { HP_ADMIN_PASSWORD: "WP_ADMIN_PASSWORD_INITIAL" } : {}),
          }),
        });
      });

      await step("publish_site", async () => {
        await db
          .update(domains)
          .set({ status: "active", updatedAt: new Date() })
          .where(eq(domains.siteId, siteId));
        const hosts = (await deploy()).hostRoutes ?? [];
        // A retry never moves an address already switched to https back to http.
        const wordpressUrl = site.wordpressUrl ?? `http://${primary.hostname}`;
        await db
          .update(sites)
          .set({
            appliedRoutes: [...hosts],
            appliedRoutesHash: routePlanHash(hosts, wordpressUrl),
            wordpressUrl,
            updatedAt: new Date(),
          })
          .where(eq(sites.id, siteId));
      });

      // Every executor step is done; what is left is bookkeeping (processing cannot go straight to succeeded).
      await transitionOperation(db, op.id, "reconciling", { leaseDurationMs: SITE_STEP_LEASE_MS });
      await step("finish", async () => {
        const adminSecrets = await db
          .select({ id: encryptedSecrets.id })
          .from(encryptedSecrets)
          .where(and(eq(encryptedSecrets.siteId, siteId), eq(encryptedSecrets.secretKey, "WP_ADMIN_PASSWORD_INITIAL")));
        for (const secret of adminSecrets) {
          await deleteEncryptedSecretTransactional(db, { organizationId, secretId: secret.id, actorId: null });
        }
        await db.update(sites).set({ status: "ready", updatedAt: new Date() }).where(eq(sites.id, siteId));
      });

      await transitionOperation(db, op.id, "succeeded", { errorCode: null, errorMessage: null });
      await appendAuditEvent(db, {
        actorId: null,
        actorType: "system",
        organizationId,
        action: "site.provision.succeeded",
        targetType: "site",
        targetId: siteId,
        details: { operationId: op.id },
      });
    } catch (err) {
      await this.#settleFailure(op, current, err, SITE_SETUP_FAILED, "site.provision.failed");
      throw err;
    }
  }

  /**
   * Runs site.delete. Databases go first, so a drop failure leaves the site still serving;
   * every row is kept on failure and the delete can be requested again.
   */
  public async remove(op: typeof operations.$inferSelect): Promise<void> {
    const db = this.dbClient.db;
    const organizationId = op.organizationId;
    const siteId = op.resourceId;
    let current: SiteDeleteStep = "drop_database";

    const step = async (key: SiteDeleteStep, work: () => Promise<void>): Promise<void> => {
      current = key;
      await renewOperationLease(db, op.id, SITE_STEP_LEASE_MS);
      await updateOperationStepTransactional(db, op.id, key, "running", STEP_RUNNING);
      await work();
      await updateOperationStepTransactional(db, op.id, key, "succeeded", DELETE_STEP_DONE[key]);
    };

    try {
      const siteDbs = await listSiteDatabases(db, { organizationId, siteId });
      const services = await db
        .select()
        .from(serviceInstances)
        .where(and(eq(serviceInstances.siteId, siteId), eq(serviceInstances.organizationId, organizationId)));

      await step("drop_database", async () => {
        for (const [i, siteDb] of siteDbs.entries()) {
          await this.#runJob({
            jobId: `job_${op.id.replace(/^op_/, "")}_drop${String(i)}`,
            kind: "db.drop",
            siteId,
            organizationId,
            params: { dbName: siteDb.dbName, dbUser: siteDb.dbUser },
          });
        }
      });

      await step("remove_site", async () => {
        for (const svc of services) await this.executor.deleteService(svc.id);
        await this.executor.purgeSite(siteId);
      });

      // Every executor step is done; what is left is bookkeeping (processing cannot go straight to succeeded).
      await transitionOperation(db, op.id, "reconciling", { leaseDurationMs: SITE_STEP_LEASE_MS });
      await step("finish", async () => {
        await db.delete(sites).where(and(eq(sites.id, siteId), eq(sites.organizationId, organizationId)));
      });

      await transitionOperation(db, op.id, "succeeded", { errorCode: null, errorMessage: null });
      await appendAuditEvent(db, {
        actorId: null,
        actorType: "system",
        organizationId,
        action: "site.delete.succeeded",
        targetType: "site",
        targetId: siteId,
        details: { operationId: op.id },
      });
    } catch (err) {
      await this.#settleFailure(op, current, err, SITE_DELETE_FAILED, "site.delete.failed");
      throw err;
    }
  }

  /**
   * Runs site.reassign: moves the site, its secrets and its operations (this one included) to the
   * target org, then redeploys so the running site carries the new owner. Every update after the
   * move uses the target org; the payload's stamped organizationId is never read.
   */
  public async reassign(op: typeof operations.$inferSelect, payload: Record<string, unknown>): Promise<void> {
    const db = this.dbClient.db;
    const siteId = op.resourceId;
    const to = stringField(payload, "toOrganizationId");
    let owner = op.organizationId;
    let current: SiteReassignStep = "move_ownership";

    const step = async (key: SiteReassignStep, work: () => Promise<void>): Promise<void> => {
      current = key;
      await renewOperationLease(db, op.id, SITE_STEP_LEASE_MS);
      await updateOperationStepTransactional(db, op.id, key, "running", STEP_RUNNING);
      await work();
      await updateOperationStepTransactional(db, op.id, key, "succeeded", REASSIGN_STEP_DONE[key]);
    };

    try {
      const [site] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
      if (!site) throw new ControlPlaneError("NOT_FOUND", `Site '${siteId}' not found`);
      const from = site.organizationId;
      owner = from;

      const [moveStep] = await db
        .select({ status: operationSteps.status })
        .from(operationSteps)
        .where(and(eq(operationSteps.operationId, op.id), eq(operationSteps.key, "move_ownership")))
        .limit(1);
      // "skipped" at enqueue: the same owner change is re-issued to finish a half-done move.
      if (moveStep?.status !== "skipped") {
        await step("move_ownership", async () => {
          if (from === to) return;
          const [allocation] = await db
            .select({ id: hostAllocations.id })
            .from(hostAllocations)
            .where(and(eq(hostAllocations.organizationId, to), eq(hostAllocations.status, "active")))
            .limit(1);
          if (!allocation) throw new ControlPlaneError("NOT_FOUND", `Organization '${to}' has no active allocation`);
          await moveSiteToOrganizationTransactional(db, {
            siteId,
            fromOrganizationId: from,
            toOrganizationId: to,
            toHostAllocationId: allocation.id,
            masterKey: this.config.secretsMasterKey.toString("hex"),
          });
          owner = to;
        });
      } else if (from !== to) {
        throw new ControlPlaneError("VALIDATION_ERROR", `Site '${siteId}' is not owned by '${to}'`);
      }

      await step("redeploy", async () => {
        const services = await db
          .select({ id: serviceInstances.id })
          .from(serviceInstances)
          .where(and(eq(serviceInstances.siteId, siteId), eq(serviceInstances.organizationId, to)));
        for (const svc of services) {
          const spec = await buildApprovedServiceSpec(db, this.config, { organizationId: to, serviceInstanceId: svc.id });
          await recordDeployedState(db, this.executor, spec, await this.executor.deployService(spec));
        }
      });

      await transitionOperation(db, op.id, "reconciling", { leaseDurationMs: SITE_STEP_LEASE_MS });
      // A failed setup stays degraded, so its Try again survives the owner change.
      if ((await latestSiteOperation(db, { siteId, kind: "site.provision" }))?.status === "succeeded") {
        await db
          .update(sites)
          .set({ status: "ready", updatedAt: new Date() })
          .where(and(eq(sites.id, siteId), eq(sites.status, "degraded")));
      }
      await transitionOperation(db, op.id, "succeeded", { errorCode: null, errorMessage: null });
      await appendAuditEvent(db, {
        actorId: null,
        actorType: "system",
        organizationId: to,
        action: "admin.site.reassign.succeeded",
        targetType: "site",
        targetId: siteId,
        details: { operationId: op.id, from, to },
      });
    } catch (err) {
      await this.#settleFailure({ ...op, organizationId: owner }, current, err, SITE_REASSIGN_FAILED, "admin.site.reassign.failed");
      throw err;
    }
  }

  async #runJob(req: SiteJobRequest): Promise<void> {
    const result = await this.executor.runSiteJob(req);
    if (result.exitCode !== 0) {
      throw new SiteJobFailedError(result.exitCode, result.outputTail);
    }
  }

  async #secrets(
    op: typeof operations.$inferSelect,
    refs: Record<string, string>,
  ): Promise<Readonly<Record<string, string>>> {
    return resolveDecryptedSecretRefs(this.dbClient.db, {
      organizationId: op.organizationId,
      siteId: op.resourceId,
      secretRefs: refs,
      masterKey: this.config.secretsMasterKey,
    });
  }

  /** A retry after a later step failed finds WordPress installed and skips the job. */
  async #installedByEarlierAttempt(siteId: string): Promise<boolean> {
    const rows = await this.dbClient.db
      .select({ id: operationSteps.id })
      .from(operationSteps)
      .innerJoin(operations, eq(operationSteps.operationId, operations.id))
      .where(
        and(
          eq(operations.resourceId, siteId),
          eq(operations.kind, "site.provision"),
          eq(operationSteps.key, "install_wordpress"),
          eq(operationSteps.status, "succeeded"),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async #settleFailure(
    op: typeof operations.$inferSelect,
    failedStep: SiteProvisionStep | SiteDeleteStep | SiteReassignStep,
    err: unknown,
    publicMessage: string,
    auditAction: string,
  ): Promise<void> {
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
        errorMessage: publicMessage,
      });
    }
    await db.update(sites).set({ status: "degraded", updatedAt: new Date() }).where(eq(sites.id, op.resourceId));

    // Raw job output is admin-only: customers lack audit.read.
    const jobFailure = err instanceof SiteJobFailedError ? err : null;
    await appendAuditEvent(db, {
      actorId: null,
      actorType: "system",
      organizationId: op.organizationId,
      action: auditAction,
      targetType: "site",
      targetId: op.resourceId,
      details: {
        operationId: op.id,
        step: failedStep,
        exitCode: jobFailure?.exitCode ?? null,
        outputTail: jobFailure
          ? jobFailure.outputTail
          : redactSensitiveString(err instanceof Error ? err.message : String(err)).slice(0, 4096),
      },
    });
  }
}

function stringField(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string") {
    throw new ControlPlaneError("VALIDATION_ERROR", `Provision payload is missing '${key}'`);
  }
  return value;
}
