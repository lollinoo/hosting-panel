import { randomBytes } from "node:crypto";
import {
  canTransitionOperation,
  isTerminalOperationStatus,
  SITE_FILES_RESULT_SCHEMAS,
  SiteWordpressLastImportDtoSchema,
  siteJobClientWaitMs,
  WordpressImportLoadResultSchema,
  type SiteWordpressLastImportDto,
  type WORDPRESS_IMPORT_STEP_KEYS,
  type WordpressImportReason,
} from "@hosting-panel/contracts";
import {
  and,
  appendAuditEvent,
  eq,
  getSiteWordpressState,
  listSiteDomains,
  operations,
  operationSteps,
  renewOperationLease,
  saveSiteWordpressLastImport,
  serviceInstances,
  settleSiteBackup,
  siteBackups,
  sites,
  transitionOperation,
  type DatabaseClient,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import type { DockerExecutorPort, SiteFilesResult } from "@hosting-panel/executor-contracts";
import { isAmbiguousError, type SiteBackupsApplier } from "../backups/site-backups-applier.js";
import { ControlPlaneError } from "../common/control-plane.error.js";
import type { ControlPlaneRuntimeConfig } from "../tokens.js";
import type { SiteWordpressApplier } from "./site-wordpress-applier.js";

export const SITE_WORDPRESS_IMPORT_STEPS = [
  { key: "check", label: "Check the two files" },
  { key: "backup", label: "Take a copy of the site" },
  { key: "unpack", label: "Unpack the site files" },
  { key: "database", label: "Load the database export" },
  { key: "switch", label: "Replace the site" },
  { key: "finish", label: "Clean up and check the site" },
] as const satisfies readonly { key: (typeof WORDPRESS_IMPORT_STEP_KEYS)[number]; label: string }[];

type ImportOperation = typeof operations.$inferSelect;
type StepKey = (typeof WORDPRESS_IMPORT_STEP_KEYS)[number];
type SiteRef = { phpVersion: string; serviceInstanceId: string; siteUrl: string };
type Outcome = Omit<SiteWordpressLastImportDto, "operationId" | "finishedAt">;
type ImportFileOp = "import.stat" | "import.unpack" | "import.switch" | "import.undo" | "import.finish";
type DbStep = "prepare" | "switch" | "finish" | "undo";

const KEYS = SITE_WORDPRESS_IMPORT_STEPS.map((s) => s.key);
const LEASE_MARGIN_MS = 60_000;
/** Client wait of each files call; the lease is renewed to this + 60 s. */
const FILE_WAIT_MS: Record<ImportFileOp, number> = {
  "import.stat": 60_000,
  "import.switch": 60_000,
  "import.unpack": 600_000,
  "import.undo": 600_000,
  "import.finish": 600_000,
};
const SECRET = "HP_IMPORT_DB_PASSWORD";

/** Helper refusals carried as the error message, mapped to their reason (R157). */
const HELPER_REASONS: Record<string, WordpressImportReason> = {
  not_a_zip: "archive_not_zip",
  dump_not_sql: "dump_not_sql",
  archive_unsafe: "archive_unsafe",
  archive_limit: "archive_limit",
  archive_not_wordpress: "archive_not_wordpress",
  disk_full: "disk_full",
  staging_unsafe: "staging_unsafe",
  files_missing: "files_missing",
};
const LOAD_REASONS: Record<number, WordpressImportReason> = {
  50: "dump_unsafe",
  51: "dump_not_sql",
  52: "dump_too_large",
  53: "dump_incomplete",
  54: "dump_not_wordpress",
  55: "dump_ambiguous",
  56: "multisite_unsupported",
  57: "dump_objects_unsupported",
  58: "dump_names_unsupported",
  59: "address_unsupported",
  60: "dump_load_failed",
  61: "dump_statement_unsupported",
  62: "dump_too_many_tables",
};
const DB_IMPORT_REASONS: Record<number, WordpressImportReason> = { 84: "dump_names_unsupported", 85: "site_objects_unsupported" };
const FINALIZE_REASONS: Record<number, WordpressImportReason> = { 25: "site_check_failed", 26: "address_rewrite_failed" };

/** Fixed sentence per reason; nothing of an executor answer ever reaches a message. */
const REASON_SENTENCES: Record<WordpressImportReason, string> = {
  files_missing: "The site files or the database export are missing. Upload both again.",
  earlier_import_unfinished: "An earlier import did not finish. Ask the server administrator to clear it first.",
  backup_failed: "The copy of the site could not be taken, so nothing was imported. Try again later.",
  interrupted: "The import was interrupted. Try again.",
  timed_out: "The import took too long. Try again, or try with smaller files.",
  unavailable: "The server could not run the import right now. Try again later.",
  other: "Something went wrong during the import. Try again, or ask the server administrator.",
  archive_not_zip: "The site files are not a ZIP file. Upload a ZIP of the WordPress folder.",
  dump_not_sql: "The database export is not an SQL file. Upload an SQL export of the database.",
  archive_unsafe: "The ZIP file holds names or links that are not allowed. Make a new ZIP of the WordPress folder.",
  archive_limit: "The ZIP file is too large or holds too many files.",
  archive_not_wordpress: "The ZIP file does not hold a WordPress site.",
  disk_full: "There is not enough disk space for the import.",
  staging_unsafe: "The upload folder of the import is not usable. Remove the uploaded files and upload them again.",
  dump_unsafe: "The database export holds statements that are not allowed.",
  dump_too_large: "The database export is too large.",
  dump_incomplete: "The database export is not complete. Export the database again.",
  dump_statement_unsupported: "The database export holds a statement that cannot be loaded.",
  dump_load_failed: "The database export could not be loaded.",
  dump_not_wordpress: "The database export does not hold a WordPress site.",
  dump_ambiguous: "The database export holds more than one WordPress site. Export only one.",
  multisite_unsupported: "WordPress multisite is not supported.",
  address_unsupported: "The address stored in the database export is not supported.",
  dump_objects_unsupported: "The database export holds triggers, routines or events, which are not supported.",
  dump_names_unsupported: "The database export uses table names that are not supported.",
  dump_too_many_tables: "The database export holds too many tables.",
  site_objects_unsupported: "The site's current database holds objects that cannot be replaced.",
  address_rewrite_failed: "The site address could not be changed to the new one.",
  site_check_failed: "The imported site did not start. Check that it runs on the site's PHP version.",
};
const OUTCOME_LEADS: Record<Exclude<Outcome["outcome"], "imported">, string> = {
  nothing_changed: "The import stopped before the site was changed. ",
  site_restored: "The import did not finish and the site was put back as it was. ",
  undo_incomplete:
    "The import did not finish and the site could not be put back completely. Restore the copy from the Backups tab, or ask the server administrator. ",
};
const UNSETTLED = "The import did not finish and the site is being put back. Check again in a few minutes.";
const OPENING = "The site was imported and is being opened to visitors again. Check again in a few minutes.";
const STOPPED = "Skipped because the import stopped";
const INTERRUPTED_STEP = "The import was interrupted";
const FINISH_INCOMPLETE = "The site was imported, but the clean-up after it did not finish. Ask the server administrator to check the site.";
const NO_COPY = "Backups are not set up on this server; no copy was taken";
const RUNNING: Record<StepKey, string> = {
  check: "Checking the two files",
  backup: "Taking a copy of the site",
  unpack: "Unpacking the site files",
  database: "Loading the database export",
  switch: "Replacing the site",
  finish: "Cleaning up and checking the site",
};
const DONE: Record<StepKey, string> = {
  check: "Both files are ready",
  backup: "Copy taken",
  unpack: "Site files unpacked",
  database: "Database export loaded",
  switch: "Site replaced",
  finish: "Site cleaned up and checked",
};

/** A failure whose reason is known; the import ends with it. */
class Failed extends Error {
  public constructor(readonly reason: WordpressImportReason) {
    super(reason);
  }
}

/** Runs the WordPress import operation of the WordPress lane. */
export class SiteWordpressImportApplier {
  public constructor(
    readonly backupsApplier: SiteBackupsApplier,
    readonly wordpressApplier: SiteWordpressApplier,
    readonly dbClient: DatabaseClient,
    readonly dockerExecutor: DockerExecutorPort,
    readonly config: ControlPlaneRuntimeConfig,
  ) {}

  /** Runs one queued import. */
  public async apply(op: ImportOperation): Promise<void> {
    const stored = await this.#stored(op);
    if (stored) {
      // The end was already written: only the status of the operation is missing.
      await this.#move(op, stored, "INTERNAL_ERROR");
      if (stored.outcome !== "imported") throw new ControlPlaneError("INTERNAL_ERROR", sentenceOf(stored));
      return;
    }
    const site = await this.#site(op).catch(async (err: unknown) => {
      await settleSiteBackup(this.dbClient.db, op.id, { status: "failed", problem: "interrupted" });
      throw err;
    });
    const importId = op.id.replace(/^op_/, "");
    const out: Outcome = {
      outcome: "nothing_changed",
      reason: null,
      backup: "skipped",
      oldAddress: null,
      leftOut: [],
      tables: null,
      line: null,
      errorNumber: null,
    };
    let at: StepKey = "check";
    try {
      await this.#step(op.id, "check", "running", RUNNING.check);
      const stat = await this.#files(op, site, "import.stat");
      if (stat.remains) throw new Failed("earlier_import_unfinished");
      if (stat.archive.state !== "complete" || stat.dump.state !== "complete") throw new Failed("files_missing");
      await this.#step(op.id, "check", "succeeded", DONE.check);

      at = "backup";
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
          out.backup = "taken";
        } catch (err) {
          if (isAmbiguousError(err)) throw err;
          // runBackupStep already failed the step and the operation.
          out.backup = "failed";
          throw new Failed("backup_failed");
        }
      }

      at = "unpack";
      await this.#step(op.id, "unpack", "running", RUNNING.unpack);
      const unpacked = await this.#files(op, site, "import.unpack", importId);
      out.leftOut = unpacked.leftOut;
      await this.#step(op.id, "unpack", "succeeded", DONE.unpack);

      at = "database";
      await this.#step(op.id, "database", "running", RUNNING.database);
      // Only in resolvedSecrets of the two calls that need it; never stored or logged.
      const password = randomBytes(32).toString("hex");
      await this.#dbImport(op, site, "prepare", importId, "prep", password);
      const load = await this.#job(op, site, "db.import-load", "load", { importId }, password);
      const parsed = WordpressImportLoadResultSchema.safeParse(load.result);
      if (load.exitCode !== 0) {
        // R157: only exits 60 and 61 carry a line and an error number.
        if ((load.exitCode === 60 || load.exitCode === 61) && parsed.success && "line" in parsed.data) {
          out.line = parsed.data.line;
          out.errorNumber = parsed.data.errorNumber;
        }
        throw new Failed(jobReason("db.import-load", null, load.exitCode));
      }
      // The schema holds the prefix and address patterns: anything else is refused before the switch.
      if (!parsed.success || !("prefix" in parsed.data)) throw new Failed("address_unsupported");
      const prefix = parsed.data.prefix;
      out.oldAddress = parsed.data.oldUrl;
      out.tables = parsed.data.tables;
      await this.#step(op.id, "database", "succeeded", DONE.database);

      at = "switch";
      await this.#step(op.id, "switch", "running", RUNNING.switch);
      await this.#files(op, site, "import.switch", importId);
      await this.#dbImport(op, site, "switch", importId, "sw");
      const fin = await this.#job(op, site, "wordpress.import-finalize", "fin", {
        phpVersion: site.phpVersion,
        tablePrefix: prefix,
        siteUrl: site.siteUrl,
        previousUrl: out.oldAddress,
      });
      if (fin.exitCode !== 0) throw new Failed(jobReason("wordpress.import-finalize", null, fin.exitCode));
      await this.#step(op.id, "switch", "succeeded", DONE.switch);
    } catch (err) {
      // R151: an unknown end is left to recovery, which never sends the call again.
      if (!(err instanceof Failed) && isAmbiguousError(err)) throw err;
      const reason = errorReason(err);
      out.reason = reason;
      await this.#step(op.id, at, "failed", REASON_SENTENCES[reason]);
      if (at !== "check" && at !== "backup") {
        const complete = await this.#undo(op, site, importId, "");
        out.outcome = !complete ? "undo_incomplete" : at === "switch" ? "site_restored" : "nothing_changed";
      }
      await this.#skipAfter(op.id, at);
      await this.#finish(op, out, "INTERNAL_ERROR");
      throw new ControlPlaneError("INTERNAL_ERROR", sentenceOf(out));
    }

    await this.#finishStep(op, site, importId, "");
    out.outcome = "imported";
    await this.#finish(op, out, "INTERNAL_ERROR");
  }

  /** Settles an import whose outcome is unknown; "pending" leaves it for the next pass. */
  public async recover(op: ImportOperation): Promise<"settled" | "pending"> {
    const stored = await this.#stored(op);
    if (stored) {
      await this.#move(op, stored, "OPERATION_INTERRUPTED");
      return "settled";
    }
    const steps = new Map(
      (await this.dbClient.db
        .select({ key: operationSteps.key, status: operationSteps.status })
        .from(operationSteps)
        .where(eq(operationSteps.operationId, op.id))).map((s) => [s.key, s.status]),
    );
    // "skipped" is left by an end that could not be written: that step never ran.
    const status = (key: StepKey) => {
      const s = steps.get(key) ?? "pending";
      return s === "skipped" ? "pending" : s;
    };
    const out: Outcome = {
      outcome: "nothing_changed",
      reason: "interrupted",
      backup: "skipped",
      oldAddress: null,
      leftOut: [],
      tables: null,
      line: null,
      errorNumber: null,
    };
    const site = await this.#site(op).catch(gone);
    const switchStarted = status("switch") !== "pending";

    if (!site) {
      // A site that is gone never comes back: end without any call.
      if (switchStarted) out.outcome = "undo_incomplete";
    } else if (["running", "unknown"].includes(steps.get("backup") ?? "")) {
      // A pending copy step was never started: nothing to settle (R164.5.2).
      const settled = await this.backupsApplier.settleBackupJob(op.id);
      if (settled === "pending") return "pending";
      // The copy ended but nothing after it ran.
      out.backup = settled === "succeeded" ? "taken" : "failed";
      if (settled !== "succeeded" && settled.code !== "OPERATION_INTERRUPTED") out.reason = "backup_failed";
    } else {
      const backup = steps.get("backup");
      out.backup = backup === "succeeded" ? "taken" : backup === "failed" ? "failed" : "skipped";
      const importId = op.id.replace(/^op_/, "");
      const tag = `_r${Date.now().toString(36)}`;
      try {
        if (status("switch") === "succeeded") {
          await this.#finishStep(op, site, importId, tag);
          out.outcome = "imported";
          out.reason = null;
        } else if (status("unpack") === "pending") {
          if (out.backup === "failed") out.reason = "backup_failed";
        } else {
          const complete = await this.#undo(op, site, importId, tag);
          out.outcome = !complete ? "undo_incomplete" : switchStarted ? "site_restored" : "nothing_changed";
        }
      } catch (err) {
        if (err instanceof ControlPlaneError && err.code === "OPERATION_AMBIGUOUS") return "pending";
        throw err;
      }
    }
    for (const key of KEYS) {
      const s = steps.get(key) ?? "pending";
      if (s === "running" || s === "unknown") await this.#step(op.id, key, "failed", INTERRUPTED_STEP);
      else if (s === "pending") await this.#step(op.id, key, "skipped", STOPPED);
    }
    await this.#finish(op, out, "OPERATION_INTERRUPTED");
    return "settled";
  }

  /** The clean-up and the check after the switch; only import.finish not settled stops the end (R162). */
  async #finishStep(op: ImportOperation, site: SiteRef, importId: string, tag: string): Promise<void> {
    await this.#step(op.id, "finish", "running", RUNNING.finish);
    try {
      await this.#files(op, site, "import.finish", importId);
    } catch {
      // Only import.finish takes the gate off: recovery repeats it until it answers success.
      await this.#step(op.id, "finish", "running", OPENING);
      throw unsettled(OPENING);
    }
    const db = await this.#dbImport(op, site, "finish", importId, `done${tag}`).then(
      () => true,
      () => false,
    );
    const checked = await this.wordpressApplier
      .inspectFor(op, { phpVersion: site.phpVersion, serviceInstanceId: site.serviceInstanceId }, `insp${tag}`)
      .then((reason) => reason === null, () => false);
    const ok = db && checked;
    await this.#step(op.id, "finish", ok ? "succeeded" : "failed", ok ? DONE.finish : FINISH_INCOMPLETE);
  }

  /** R152: the database undo, then the files undo; true when complete, throws when not settled. */
  async #undo(op: ImportOperation, site: SiteRef, importId: string, tag: string): Promise<boolean> {
    const db = await this.#job(op, site, "db.import", `undo${tag}`, { step: "undo", importId }).catch(() => {
      throw unsettled(UNSETTLED);
    });
    if (db.exitCode === 92) return false;
    if (db.exitCode !== 0) throw unsettled(UNSETTLED);
    const files = await this.#files(op, site, "import.undo", importId).catch(() => {
      throw unsettled(UNSETTLED);
    });
    return files.complete;
  }

  async #dbImport(op: ImportOperation, site: SiteRef, step: DbStep, importId: string, suffix: string, password?: string) {
    const res = await this.#job(op, site, "db.import", suffix, { step, importId }, password);
    if (res.exitCode !== 0) throw new Failed(jobReason("db.import", step, res.exitCode));
    return res;
  }

  async #job(
    op: ImportOperation,
    site: SiteRef,
    kind: "db.import" | "db.import-load" | "wordpress.import-finalize",
    suffix: string,
    params: Record<string, string>,
    password?: string,
  ) {
    await renewOperationLease(this.dbClient.db, op.id, siteJobClientWaitMs(kind) + LEASE_MARGIN_MS);
    return this.dockerExecutor.runSiteJob({
      jobId: `job_${op.id.replace(/^op_/, "")}_${suffix}`,
      kind,
      siteId: op.resourceId,
      organizationId: op.organizationId,
      serviceInstanceId: site.serviceInstanceId,
      params,
      ...(password ? { resolvedSecrets: { [SECRET]: password } } : {}),
    });
  }

  /** One files call; the answer is untrusted until its schema accepts it. */
  async #files<O extends ImportFileOp>(op: ImportOperation, site: SiteRef, fileOp: O, importId?: string): Promise<SiteFilesResult<O>> {
    await renewOperationLease(this.dbClient.db, op.id, FILE_WAIT_MS[fileOp] + LEASE_MARGIN_MS);
    const res = await this.dockerExecutor.siteFiles({
      serviceInstanceId: site.serviceInstanceId,
      op: fileOp,
      ...(importId ? { importId } : {}),
    } as Parameters<DockerExecutorPort["siteFiles"]>[0]);
    const parsed = SITE_FILES_RESULT_SCHEMAS[fileOp].safeParse(res);
    if (!parsed.success) throw new Failed("other");
    return parsed.data as SiteFilesResult<O>;
  }

  async #stored(op: ImportOperation): Promise<SiteWordpressLastImportDto | null> {
    const row = await getSiteWordpressState(this.dbClient.db, { organizationId: op.organizationId, siteId: op.resourceId });
    const known = SiteWordpressLastImportDtoSchema.safeParse(row?.lastImport);
    return known.success && known.data.operationId === op.id ? known.data : null;
  }

  async #move(op: ImportOperation, stored: Outcome, errorCode: "INTERNAL_ERROR" | "OPERATION_INTERRUPTED"): Promise<void> {
    if (stored.outcome === "imported") await this.backupsApplier.succeedOperation(op.id);
    else await this.backupsApplier.failOperation(op.id, errorCode, sentenceOf(stored));
  }

  async #site(op: ImportOperation): Promise<SiteRef> {
    const db = this.dbClient.db;
    const [site] = await db
      .select({ phpVersion: sites.phpVersion, siteUrl: sites.siteUrl })
      .from(sites)
      .where(and(eq(sites.id, op.resourceId), eq(sites.organizationId, op.organizationId)))
      .limit(1);
    const [svc] = await db
      .select({ id: serviceInstances.id })
      .from(serviceInstances)
      .where(and(eq(serviceInstances.siteId, op.resourceId), eq(serviceInstances.organizationId, op.organizationId)))
      .limit(1);
    const primary = site ? (await listSiteDomains(db, op.resourceId)).find((d) => d.isPrimary) : undefined;
    const siteUrl = site?.siteUrl ?? (primary ? `http://${primary.hostname}` : null);
    if (!site?.phpVersion || !svc || !siteUrl) {
      throw new ControlPlaneError("NOT_FOUND", `Managed site '${op.resourceId}' is incomplete`);
    }
    return { phpVersion: site.phpVersion, serviceInstanceId: svc.id, siteUrl };
  }

  async #skipAfter(opId: string, at: StepKey): Promise<void> {
    for (const key of KEYS.slice(KEYS.indexOf(at) + 1)) await this.#step(opId, key, "skipped", STOPPED);
  }

  /** Saves lastImport, writes the end audit and settles the operation and its copy row, in one transaction. */
  async #finish(op: ImportOperation, outcome: Outcome, errorCode: "INTERNAL_ERROR" | "OPERATION_INTERRUPTED"): Promise<void> {
    await this.dbClient.db.transaction(async (tx) => {
      const [site] = await tx
        .select({ id: sites.id })
        .from(sites)
        .where(and(eq(sites.id, op.resourceId), eq(sites.organizationId, op.organizationId)));
      if (site) {
        const lastImport = SiteWordpressLastImportDtoSchema.parse({
          operationId: op.id,
          finishedAt: new Date().toISOString(),
          ...outcome,
        });
        await saveSiteWordpressLastImport(tx, { organizationId: op.organizationId, siteId: op.resourceId, lastImport });
      }
      await appendAuditEvent(tx, {
        actorId: null,
        actorType: "system",
        organizationId: op.organizationId,
        action: "site.wordpress.import.finished",
        targetType: "site",
        targetId: op.resourceId,
        details: {
          operationId: op.id,
          outcome: outcome.outcome,
          reason: outcome.reason,
          backup: outcome.backup,
          tables: outcome.tables,
          // Cut, never parsed: the accepted pattern holds hosts and ports the URL parser refuses (R164.4).
          oldHost: outcome.oldAddress?.replace(/^https?:\/\//, "") ?? null,
          leftOut: outcome.leftOut,
        },
      });
      await settleSiteBackup(tx, op.id, { status: "failed", problem: "interrupted" });
      // Same moves as succeedOperation / failOperation, inside this transaction.
      const db = tx as unknown as HostingPanelDatabase;
      const [row] = await tx.select({ status: operations.status }).from(operations).where(eq(operations.id, op.id));
      if (!row || isTerminalOperationStatus(row.status)) return;
      if (outcome.outcome === "imported") {
        if (row.status !== "reconciling" && canTransitionOperation(row.status, "reconciling")) {
          await transitionOperation(db, op.id, "reconciling");
        }
        await transitionOperation(db, op.id, "succeeded", { errorCode: null, errorMessage: null });
      } else if (canTransitionOperation(row.status, "failed")) {
        await transitionOperation(db, op.id, "failed", { errorCode, errorMessage: sentenceOf(outcome) });
      }
    });
  }

  #step(opId: string, key: string, status: "running" | "succeeded" | "failed" | "skipped", message: string) {
    return this.backupsApplier.safeUpdateStep(opId, key, status, message);
  }
}

/** R157: the reason of an exit code. */
function jobReason(kind: "db.import" | "db.import-load" | "wordpress.import-finalize", step: DbStep | null, exit: number): WordpressImportReason {
  if (exit === 124 || exit === 137) return "timed_out";
  if (exit === 11) return "unavailable";
  if (kind === "db.import" && exit === 1 && (step === "prepare" || step === "switch")) return "unavailable";
  const table = kind === "db.import" ? DB_IMPORT_REASONS : kind === "db.import-load" ? LOAD_REASONS : FINALIZE_REASONS;
  return table[exit] ?? "other";
}

/** R157: the reason of a thrown error. */
function errorReason(err: unknown): WordpressImportReason {
  if (err instanceof Failed) return err.reason;
  const message = err instanceof Error ? err.message : "";
  if (Object.hasOwn(HELPER_REASONS, message)) return HELPER_REASONS[message]!;
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "OPERATION_INTERRUPTED") return "timed_out";
  if (code === "DOCKER_ENGINE_UNAVAILABLE") return "unavailable";
  return "other";
}

/** An end that settled nothing: the worker moves the operation to unknown, which keeps the site lock. */
function unsettled(message: string): ControlPlaneError {
  return Object.assign(new ControlPlaneError("OPERATION_AMBIGUOUS", message), { ambiguousOutcome: true });
}

/** Catch handler: null for a site that is gone, any other error is thrown again. */
function gone(err: unknown): null {
  if (err instanceof ControlPlaneError && err.code === "NOT_FOUND") return null;
  throw err;
}

function sentenceOf(outcome: Pick<Outcome, "outcome" | "reason">): string {
  if (outcome.outcome === "imported") return "The site was imported.";
  return OUTCOME_LEADS[outcome.outcome] + REASON_SENTENCES[outcome.reason ?? "other"];
}
