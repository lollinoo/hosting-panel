import {
  canTransitionOperation,
  isTerminalOperationStatus,
  SiteWordpressLastUpdateDtoSchema,
  SiteWordpressStateDtoSchema,
  SiteWordpressUpdateRequestSchema,
  WordpressStateResultSchema,
  WordpressUpdateResultSchema,
  wordpressJobReason,
  type SiteWordpressLastUpdateDto,
  type SiteWordpressUpdateRequest,
  type WordpressJobReason,
  type WordpressProblem,
  type WordpressUpdateResult,
} from "@hosting-panel/contracts";
import {
  and,
  appendAuditEvent,
  eq,
  getSiteWordpressState,
  operations,
  operationSteps,
  outboxEvents,
  renewOperationLease,
  saveSiteWordpressLastUpdate,
  saveSiteWordpressState,
  serviceInstances,
  settleSiteBackup,
  siteBackups,
  sites,
  sql,
  transitionOperation,
  type DatabaseClient,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import type { DockerExecutorPort, SiteJobKind } from "@hosting-panel/executor-contracts";
import {
  isAmbiguousError,
  isTerminalStepStatus,
  type SiteBackupsApplier,
} from "../backups/site-backups-applier.js";
import { ControlPlaneError } from "../common/control-plane.error.js";
import { SITE_STEP_LEASE_MS } from "../runtime/site-provisioner.js";
import type { ControlPlaneRuntimeConfig } from "../tokens.js";

export const SITE_WORDPRESS_INTERRUPTED = "The check was interrupted. Press Check now.";

export const SITE_WORDPRESS_INSPECT_STEPS = [
  { key: "inspect", label: "Check WordPress versions and updates" },
] as const satisfies readonly { key: string; label: string }[];

export const SITE_WORDPRESS_UPDATE_STEPS = [
  { key: "backup", label: "Take a copy of the site" },
  { key: "update", label: "Update WordPress" },
  { key: "settle", label: "Check the site after the update" },
] as const satisfies readonly { key: string; label: string }[];

/** Fixed sentence per problem; nothing of a job's output ever reaches a message. */
const PROBLEM_SENTENCES: Record<WordpressProblem, string> = {
  wordpress_org_unreachable: "WordPress.org could not be reached, so nothing was updated. Try again later.",
  config_broken: "The WordPress configuration of the site could not be read. Check wp-config.php, then press Check now.",
  database_unreachable: "The site's database could not be reached. Check that the site works, then press Check now.",
  not_installed: "WordPress is not installed on this site. Nothing was changed.",
  backup_failed: "The copy of the site could not be taken, so nothing was updated. Try again later.",
  items_failed: "Some items could not be updated. Check the list below and try again.",
  item_unknown: "This plugin or theme is no longer on the site. Nothing was changed. Press Check now to see the current list.",
  outcome_unknown: "The outcome of the update is not known. Check the versions below.",
  interrupted: "The update was stopped before anything was changed. Try again.",
};
const COPY_SENTENCE = " A copy of the site from just before the update is under Backups.";
const CHECK_FAILED = "The check did not finish. Press Check now.";
const SETTLE_FAILED = "The check after the update did not finish. Press Check now.";
const NO_COPY = "Backups are not set up on this server; no copy was taken";

/** Problems a site can have that the stored state shows instead of versions. */
const SITE_PROBLEMS: Partial<Record<WordpressJobReason, WordpressProblem>> = {
  not_wordpress: "not_installed",
  broken_configuration: "config_broken",
  database_unreachable: "database_unreachable",
};
const UPDATE_PROBLEMS: Partial<Record<WordpressJobReason, WordpressProblem>> = {
  ...SITE_PROBLEMS,
  update_failed: "items_failed",
  wordpress_org_unreachable: "wordpress_org_unreachable",
  item_unknown: "item_unknown",
};

type WordpressOperation = typeof operations.$inferSelect;
type SiteRef = { phpVersion: string; serviceInstanceId: string };
type Outcome = Omit<SiteWordpressLastUpdateDto, "operationId" | "target" | "finishedAt">;

/** Runs the WordPress operations of the outbox lane: the check, and the update with its copy first. */
export class SiteWordpressApplier {
  public constructor(
    readonly backupsApplier: SiteBackupsApplier,
    readonly dbClient: DatabaseClient,
    readonly dockerExecutor: DockerExecutorPort,
    readonly config: ControlPlaneRuntimeConfig,
  ) {}

  /** Runs one queued inspect or update operation. */
  public async apply(op: WordpressOperation): Promise<void> {
    if (op.kind === "site.wordpress.inspect") {
      await this.#applyInspect(op);
    } else if (op.kind === "site.wordpress.update") {
      await this.#applyUpdate(op);
    } else {
      throw new ControlPlaneError("NOT_SUPPORTED", `Unsupported operation kind '${op.kind}'`);
    }
  }

  /** Settles an update whose outcome is unknown; "pending" leaves it for the next pass. Never resends the update. */
  public async recover(op: WordpressOperation): Promise<"settled" | "pending"> {
    const stored = await getSiteWordpressState(this.dbClient.db, { organizationId: op.organizationId, siteId: op.resourceId });
    const known = SiteWordpressLastUpdateDtoSchema.safeParse(stored?.lastUpdate);
    if (known.success && known.data.operationId === op.id) {
      // The end was already written: only the status of the operation is missing.
      const { problem, backup } = known.data;
      if (problem === null) await this.backupsApplier.succeedOperation(op.id);
      else await this.backupsApplier.failOperation(op.id, "OPERATION_INTERRUPTED", sentenceOf(problem, backup));
      return "settled";
    }
    const steps = new Map(
      (await this.dbClient.db
        .select({ key: operationSteps.key, status: operationSteps.status })
        .from(operationSteps)
        .where(eq(operationSteps.operationId, op.id))).map((s) => [s.key, s.status]),
    );
    // A target that no longer parses or a site that is gone never comes back: end without any job.
    // Any other error (a dropped connection) is thrown, so the operation stays unknown for the next pass.
    const target = await this.#target(op).catch(gone("VALIDATION_ERROR"));
    const site = await this.#site(op).catch(gone("NOT_FOUND"));
    const backupStatus = steps.get("backup") ?? "skipped";

    if (!isTerminalStepStatus(backupStatus)) {
      const settled = await this.backupsApplier.settleBackupJob(op.id);
      if (settled === "pending") {
        return "pending";
      }
      if (settled === "succeeded") {
        // The copy finished but the update never started: nothing was changed.
        return this.#interrupted(op, target, "taken", "interrupted");
      }
      const problem = settled.code === "OPERATION_INTERRUPTED" ? "interrupted" : "backup_failed";
      return this.#interrupted(op, target, "failed", problem);
    }
    const backup = backupStatus === "succeeded" ? "taken" : backupStatus === "skipped" ? "skipped" : "failed";
    // "skipped" is left by an end that could not be written after the copy: the update never ran.
    const update = steps.get("update") ?? "pending";
    if (update === "pending" || update === "skipped") {
      return this.#interrupted(op, target, backup, backup === "failed" ? "backup_failed" : "interrupted");
    }

    await this.#step(op.id, "update", "failed", PROBLEM_SENTENCES.outcome_unknown);
    if (site && target) await this.#settle(op, site, "_r");
    else await this.#step(op.id, "settle", "failed", SETTLE_FAILED);
    await this.#finish(op, target, { status: "failed", problem: "outcome_unknown", backup, items: [] }, "OPERATION_INTERRUPTED");
    return "settled";
  }

  async #applyInspect(op: WordpressOperation): Promise<void> {
    await this.#step(op.id, "inspect", "running", "Checking WordPress versions and updates");
    const reason = await this.#inspect(op, await this.#site(op), "inspect");
    if (reason === null) {
      await this.#step(op.id, "inspect", "succeeded", "WordPress versions checked");
      await this.backupsApplier.succeedOperation(op.id);
      return;
    }
    const problem = SITE_PROBLEMS[reason];
    const sentence = problem ? PROBLEM_SENTENCES[problem] : CHECK_FAILED;
    await this.#step(op.id, "inspect", "failed", sentence);
    await this.backupsApplier.failOperation(op.id, "INTERNAL_ERROR", sentence);
    throw new ControlPlaneError("INTERNAL_ERROR", sentence);
  }

  async #applyUpdate(op: WordpressOperation): Promise<void> {
    const [target, site] = await Promise.all([this.#target(op), this.#site(op)]).catch(async (err: unknown) => {
      await settleSiteBackup(this.dbClient.db, op.id, { status: "failed", problem: "interrupted" });
      throw err;
    });

    let backup: Outcome["backup"] = "skipped";
    const [copy] = await this.dbClient.db
      .select({ id: siteBackups.id })
      .from(siteBackups)
      .where(eq(siteBackups.operationId, op.id))
      .limit(1);
    if (!copy) {
      await this.#step(op.id, "backup", "skipped", NO_COPY);
    } else {
      try {
        await this.backupsApplier.runBackupStep(op);
        backup = "taken";
      } catch (err) {
        if (isAmbiguousError(err)) throw err;
        // runBackupStep already failed the step and the operation: nothing is updated.
        await this.#skipRest(op.id);
        await this.#finish(op, target, { status: "failed", problem: "backup_failed", backup: "failed", items: [] });
        throw err;
      }
    }

    await this.#step(op.id, "update", "running", "Updating WordPress");
    let problem: WordpressProblem | null = "outcome_unknown";
    let items: WordpressUpdateResult["items"] = [];
    try {
      const res = await this.#job(op, site, "wordpress.update", "update", { target: jobTarget(target) });
      const parsed = WordpressUpdateResultSchema.safeParse(res.result);
      const reason = wordpressJobReason(res.exitCode, parsed.success, true);
      problem = reason === null ? null : (UPDATE_PROBLEMS[reason] ?? "outcome_unknown");
      if (parsed.success && (reason === null || reason === "update_failed")) items = parsed.data.items;
    } catch (err) {
      // Recovery settles an update whose end was not seen; it is never sent again.
      if (isAmbiguousError(err)) throw err;
    }
    await this.#step(
      op.id,
      "update",
      problem === null ? "succeeded" : "failed",
      problem === null ? "WordPress updated" : PROBLEM_SENTENCES[problem],
    );

    await this.#settle(op, site, "");
    await this.#finish(op, target, { status: problem === null ? "succeeded" : "failed", problem, backup, items });
    if (problem !== null) {
      throw new ControlPlaneError("INTERNAL_ERROR", sentenceOf(problem, backup));
    }
  }

  /** Removes the maintenance marker and reads the state again; a failure marks only this step. */
  async #settle(op: WordpressOperation, site: SiteRef, suffix: string): Promise<void> {
    await this.#step(op.id, "settle", "running", "Checking the site after the update");
    let ok = await this.#job(op, site, "wordpress.settle", `settle${suffix}`, {}).then(
      (res) => res.exitCode === 0,
      () => false,
    );
    // The state is read again even when the marker could not be removed.
    ok = (await this.#inspect(op, site, `inspect${suffix}`).catch(() => "other")) === null && ok;
    await this.#step(op.id, "settle", ok ? "succeeded" : "failed", ok ? "Site checked after the update" : SETTLE_FAILED);
  }

  /** Runs the check job for another applier (the import's finish); same answer as #inspect. */
  public inspectFor(op: WordpressOperation, site: SiteRef, suffix: string): Promise<WordpressJobReason | null> {
    return this.#inspect(op, site, suffix);
  }

  /** Runs the check job and stores what it read; returns the failure reason or null. */
  async #inspect(op: WordpressOperation, site: SiteRef, suffix: string): Promise<WordpressJobReason | null> {
    const res = await this.#job(op, site, "wordpress.inspect", suffix, {});
    const parsed = WordpressStateResultSchema.safeParse(res.result);
    const reason = wordpressJobReason(res.exitCode, parsed.success, true);
    const checkedAt = new Date().toISOString();
    const problem = reason === null ? null : SITE_PROBLEMS[reason];
    if (parsed.success && reason === null) {
      await this.#saveState(op, { ...parsed.data, checkedAt, problem: null });
    } else if (problem) {
      await this.#saveState(op, {
        coreVersion: null,
        coreUpdate: null,
        updatesKnown: false,
        plugins: [],
        themes: [],
        administrators: [],
        checkedAt,
        problem,
      });
    }
    return reason;
  }

  async #job(
    op: WordpressOperation,
    site: SiteRef,
    kind: SiteJobKind,
    suffix: string,
    params: Record<string, string>,
  ) {
    await renewOperationLease(this.dbClient.db, op.id, SITE_STEP_LEASE_MS);
    return this.dockerExecutor.runSiteJob({
      jobId: `job_${op.id.replace(/^op_/, "")}_${suffix}`,
      kind,
      siteId: op.resourceId,
      organizationId: op.organizationId,
      serviceInstanceId: site.serviceInstanceId,
      params: { phpVersion: site.phpVersion, ...params },
    });
  }

  async #saveState(op: WordpressOperation, state: unknown): Promise<void> {
    await saveSiteWordpressState(this.dbClient.db, {
      organizationId: op.organizationId,
      siteId: op.resourceId,
      state: SiteWordpressStateDtoSchema.parse(state),
    });
  }

  async #site(op: WordpressOperation): Promise<SiteRef> {
    const db = this.dbClient.db;
    const [site] = await db
      .select({ phpVersion: sites.phpVersion })
      .from(sites)
      .where(and(eq(sites.id, op.resourceId), eq(sites.organizationId, op.organizationId)))
      .limit(1);
    const [svc] = await db
      .select({ id: serviceInstances.id })
      .from(serviceInstances)
      .where(and(eq(serviceInstances.siteId, op.resourceId), eq(serviceInstances.organizationId, op.organizationId)))
      .limit(1);
    if (!site?.phpVersion || !svc) {
      throw new ControlPlaneError("NOT_FOUND", `Managed site '${op.resourceId}' is incomplete`);
    }
    return { phpVersion: site.phpVersion, serviceInstanceId: svc.id };
  }

  /** The update request the routes stored in the outbox payload of the operation. */
  async #target(op: WordpressOperation): Promise<SiteWordpressUpdateRequest> {
    const [row] = await this.dbClient.db
      .select({ payload: outboxEvents.payload })
      .from(outboxEvents)
      .where(sql`${outboxEvents.payload}->>'operationId' = ${op.id}`)
      .limit(1);
    const parsed = SiteWordpressUpdateRequestSchema.safeParse((row?.payload as { target?: unknown } | undefined)?.target);
    if (!parsed.success) {
      throw new ControlPlaneError("VALIDATION_ERROR", "Missing or invalid update target.");
    }
    return parsed.data;
  }

  async #interrupted(
    op: WordpressOperation,
    target: SiteWordpressUpdateRequest | null,
    backup: Outcome["backup"],
    problem: WordpressProblem,
  ): Promise<"settled"> {
    await this.#skipRest(op.id);
    await this.#finish(op, target, { status: "failed", problem, backup, items: [] }, "OPERATION_INTERRUPTED");
    return "settled";
  }

  async #skipRest(opId: string): Promise<void> {
    await this.#step(opId, "update", "skipped", "Skipped because nothing could be updated");
    await this.#step(opId, "settle", "skipped", "Skipped because nothing was updated");
  }

  /** Saves lastUpdate, writes the end audit and settles the operation and its copy row, in one transaction. */
  async #finish(
    op: WordpressOperation,
    target: SiteWordpressUpdateRequest | null,
    outcome: Outcome,
    errorCode: "INTERNAL_ERROR" | "OPERATION_INTERRUPTED" = "INTERNAL_ERROR",
  ): Promise<void> {
    await this.dbClient.db.transaction(async (tx) => {
      const [site] = await tx
        .select({ id: sites.id })
        .from(sites)
        .where(and(eq(sites.id, op.resourceId), eq(sites.organizationId, op.organizationId)));
      // lastUpdate needs a readable target and a site to belong to.
      if (target && site) {
        const lastUpdate = SiteWordpressLastUpdateDtoSchema.parse({
          operationId: op.id,
          target,
          finishedAt: new Date().toISOString(),
          ...outcome,
        });
        await saveSiteWordpressLastUpdate(tx, { organizationId: op.organizationId, siteId: op.resourceId, lastUpdate });
      }
      await appendAuditEvent(tx, {
        actorId: null,
        actorType: "system",
        organizationId: op.organizationId,
        action: "site.wordpress.update.finished",
        targetType: "site",
        targetId: op.resourceId,
        details: {
          operationId: op.id,
          target,
          status: outcome.status,
          problem: outcome.problem,
          backup: outcome.backup,
          updated: outcome.items.filter((i) => i.status === "updated").length,
          failed: outcome.items.filter((i) => i.status === "failed").length,
        },
      });
      await settleSiteBackup(tx, op.id, { status: "failed", problem: "interrupted" });
      // Same moves as succeedOperation / failOperation, inside this transaction.
      const db = tx as unknown as HostingPanelDatabase;
      const [row] = await tx.select({ status: operations.status }).from(operations).where(eq(operations.id, op.id));
      if (!row || isTerminalOperationStatus(row.status)) return;
      if (outcome.problem === null) {
        if (row.status !== "reconciling" && canTransitionOperation(row.status, "reconciling")) {
          await transitionOperation(db, op.id, "reconciling");
        }
        await transitionOperation(db, op.id, "succeeded", { errorCode: null, errorMessage: null });
      } else if (canTransitionOperation(row.status, "failed")) {
        await transitionOperation(db, op.id, "failed", { errorCode, errorMessage: sentenceOf(outcome.problem, outcome.backup) });
      }
    });
  }

  #step(opId: string, key: string, status: "running" | "succeeded" | "failed" | "skipped", message: string) {
    return this.backupsApplier.safeUpdateStep(opId, key, status, message);
  }
}

function jobTarget(t: SiteWordpressUpdateRequest): string {
  return t.scope === "plugin" || t.scope === "theme" ? `${t.scope}:${t.name}` : t.scope;
}

/** Catch handler: null for the one permanent cause, any other error is thrown again. */
function gone(code: "VALIDATION_ERROR" | "NOT_FOUND") {
  return (err: unknown): null => {
    if (err instanceof ControlPlaneError && err.code === code) return null;
    throw err;
  };
}

function sentenceOf(problem: WordpressProblem, backup: Outcome["backup"]): string {
  return PROBLEM_SENTENCES[problem] + (backup === "taken" ? COPY_SENTENCE : "");
}
