import { Inject, Injectable } from "@nestjs/common";
import {
  SiteFileArchiveRequestSchema,
  SiteFileExtractRequestSchema,
  canTransitionOperation,
  isTerminalOperationStatus,
} from "@hosting-panel/contracts";
import {
  and,
  eq,
  operationSteps,
  operations,
  outboxEvents,
  renewOperationLease,
  sites,
  transitionOperation,
  updateOperationStepTransactional,
  type DatabaseClient,
} from "@hosting-panel/database";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
import { ControlPlaneError } from "../common/control-plane.error.js";
import { SITE_STEP_LEASE_MS } from "../runtime/site-provisioner.js";
import {
  CONTROL_PLANE_CONFIG_TOKEN,
  DATABASE_CLIENT_TOKEN,
  DOCKER_EXECUTOR_TOKEN,
  type ControlPlaneRuntimeConfig,
} from "../tokens.js";
import {
  mapSiteFileExecutorError,
  resolveSiteFilesServiceId,
} from "./site-files.service.js";

export const SITE_FILES_INTERRUPTED =
  "This file operation was interrupted before it finished.";

function parseArchivePayload(payload: Record<string, unknown>) {
  const parsed = SiteFileArchiveRequestSchema.safeParse({
    paths: payload["paths"],
    to: payload["to"],
  });
  if (!parsed.success) {
    throw new ControlPlaneError("VALIDATION_ERROR", "The archive request payload is invalid.");
  }
  return parsed.data;
}

function parseExtractPayload(payload: Record<string, unknown>) {
  const parsed = SiteFileExtractRequestSchema.safeParse({
    path: payload["path"],
    to: payload["to"],
  });
  if (!parsed.success) {
    throw new ControlPlaneError("VALIDATION_ERROR", "The extract request payload is invalid.");
  }
  return parsed.data;
}

function formatEntryCountMessage(count: number, verb: "archived" | "extracted"): string {
  const noun = count === 1 ? "item" : "items";
  return `${String(count)} ${noun} ${verb}`;
}

/**
 * Executes asynchronous archive (`site.files.archive`) and extract (`site.files.extract`)
 * operations under the site operation lock, recording safe step counts and never degrading the site.
 */
@Injectable()
export class SiteFilesApplier {
  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(DOCKER_EXECUTOR_TOKEN) private readonly executor: DockerExecutorPort,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) private readonly config: ControlPlaneRuntimeConfig,
  ) {}

  /** Applies a queued `site.files.archive` or `site.files.extract` operation via the executor IPC port. */
  public async apply(
    op: typeof operations.$inferSelect,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    const db = this.dbClient.db;
    const isArchive = op.kind === "site.files.archive";
    const stepKey = isArchive ? "archive_files" : "extract_files";

    await renewOperationLease(db, op.id, SITE_STEP_LEASE_MS);
    await updateOperationStepTransactional(
      db,
      op.id,
      stepKey,
      "running",
      isArchive ? "Creating archive" : "Extracting archive",
    );

    try {
      const eventPayload = payload ?? (await this.#loadPayload(op.id, op.resourceId));
      const [site] = await db
        .select()
        .from(sites)
        .where(and(eq(sites.id, op.resourceId), eq(sites.organizationId, op.organizationId)))
        .limit(1);

      if (!site) {
        throw new ControlPlaneError("NOT_FOUND", "The managed site was not found.");
      }

      const serviceInstanceId = await resolveSiteFilesServiceId(
        db,
        this.executor,
        this.config,
        site,
      );

      const count = isArchive
        ? await this.#runArchive(serviceInstanceId, parseArchivePayload(eventPayload))
        : await this.#runExtract(serviceInstanceId, parseExtractPayload(eventPayload));

      const message = formatEntryCountMessage(
        count,
        isArchive ? "archived" : "extracted",
      );
      await updateOperationStepTransactional(db, op.id, stepKey, "succeeded", message);
      await transitionOperation(db, op.id, "reconciling", {
        leaseDurationMs: SITE_STEP_LEASE_MS,
      });
      await transitionOperation(db, op.id, "succeeded", {
        errorCode: null,
        errorMessage: null,
      });
    } catch (err) {
      const mapped = mapSiteFileExecutorError(err);
      await this.#settleFailure(op.id, stepKey, mapped);
      throw mapped;
    }
  }

  async #runArchive(
    serviceInstanceId: string,
    input: { readonly paths: readonly string[]; readonly to: string },
  ): Promise<number> {
    const result = await this.executor.siteFiles({
      serviceInstanceId,
      op: "archive",
      paths: [...input.paths],
      to: input.to,
    });
    return result.entries;
  }

  async #runExtract(
    serviceInstanceId: string,
    input: { readonly path: string; readonly to: string },
  ): Promise<number> {
    const result = await this.executor.siteFiles({
      serviceInstanceId,
      op: "extract",
      path: input.path,
      to: input.to,
    });
    return result.entries;
  }

  async #loadPayload(
    operationId: string,
    siteId: string,
  ): Promise<Record<string, unknown>> {
    const rows = await this.dbClient.db
      .select({ payload: outboxEvents.payload })
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, siteId));
    const match = rows.find(
      (row) =>
        typeof row.payload === "object" &&
        row.payload !== null &&
        (row.payload as Record<string, unknown>)["operationId"] === operationId,
    );
    if (!match) {
      throw new ControlPlaneError(
        "VALIDATION_ERROR",
        "Missing outbox payload for file operation.",
      );
    }
    return match.payload as Record<string, unknown>;
  }

  async #settleFailure(
    operationId: string,
    stepKey: "archive_files" | "extract_files",
    mapped: ControlPlaneError,
  ): Promise<void> {
    // Ambiguous IPC outcomes must remain non-terminal so OutboxWorker moves them to `unknown`.
    if (mapped.code === "OPERATION_AMBIGUOUS") {
      return;
    }

    const db = this.dbClient.db;
    const [stepRow] = await db
      .select()
      .from(operationSteps)
      .where(
        and(eq(operationSteps.operationId, operationId), eq(operationSteps.key, stepKey)),
      )
      .limit(1);

    if (
      stepRow &&
      !["succeeded", "failed", "skipped", "cancelled"].includes(stepRow.status)
    ) {
      await updateOperationStepTransactional(
        db,
        operationId,
        stepKey,
        "failed",
        mapped.message,
      );
    }

    const [latest] = await db
      .select()
      .from(operations)
      .where(eq(operations.id, operationId))
      .limit(1);

    if (
      latest &&
      !isTerminalOperationStatus(latest.status) &&
      canTransitionOperation(latest.status, "failed")
    ) {
      await transitionOperation(db, operationId, "failed", {
        errorCode: mapped.code,
        errorMessage: mapped.message,
      });
    }
  }
}
