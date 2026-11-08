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
  listSiteDatabases,
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

type SiteProvisionStep = (typeof SITE_PROVISION_STEPS)[number]["key"];

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

class SiteJobFailedError extends Error {
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

      await step("deploy_site", deploy);

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
          .where(eq(domains.id, primary.id));
        await deploy();
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
      await this.#settleFailure(op, current, err);
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
    failedStep: SiteProvisionStep,
    err: unknown,
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
        errorMessage: SITE_SETUP_FAILED,
      });
    }
    await db.update(sites).set({ status: "degraded", updatedAt: new Date() }).where(eq(sites.id, op.resourceId));

    // Raw job output is admin-only: customers lack audit.read.
    const jobFailure = err instanceof SiteJobFailedError ? err : null;
    await appendAuditEvent(db, {
      actorId: null,
      actorType: "system",
      organizationId: op.organizationId,
      action: "site.provision.failed",
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
