import { Inject, Injectable, Optional } from "@nestjs/common";
import {
  ERROR_CODES,
  WORDPRESS_IMPORT_KIND,
  WORDPRESS_OPERATION_KINDS,
  canTransitionOperation,
  isTerminalOperationStatus,
  redactSensitiveString,
  type ErrorCode,
  type OperationKind,
  type OperationStepStatus,
} from "@hosting-panel/contracts";
import {
  and,
  appendAuditEvent,
  asc,
  claimPendingOutboxEvents,
  completeOutboxEvent,
  eq,
  failOutboxEvent,
  inArray,
  isNull,
  latestSiteOperation,
  lte,
  markExpiredOperationsUnknownTransactional,
  operationSteps,
  operations,
  or,
  outboxEvents,
  rebindDockerResourceTransactional,
  recordObservedStateReconciliationTransactional,
  renewOperationLease,
  serviceInstances,
  settleOperation,
  sites,
  sql,
  stackRevisions,
  transitionOperation,
  updateOperationStepTransactional,
  type ClaimPendingOutboxFilter,
  type DatabaseClient,
} from "@hosting-panel/database";
import type { DockerExecutionResult, DockerExecutorPort } from "@hosting-panel/executor-contracts";
import {
  createApprovedHostMaintenanceCommand,
  createApprovedHostSecurityCommand,
  type HostAgentPort,
} from "@hosting-panel/host-agent-contracts";
import {
  ControlPlaneError,
  sanitizePublicErrorMessage,
} from "../common/control-plane.error.js";
import {
  CONTROL_PLANE_CONFIG_TOKEN,
  DATABASE_CLIENT_TOKEN,
  DOCKER_EXECUTOR_TOKEN,
  HOST_AGENT_TOKEN,
  type ControlPlaneRuntimeConfig,
} from "../tokens.js";
import { buildApprovedServiceSpec, recordDeployedState } from "./service-spec.js";
import { executePanelContainerRestart, recoverPanelContainerRestart } from "../health/panel-restart.js";
import { SITE_DOMAINS_INTERRUPTED, SiteDomainsApplier } from "../sites/site-domains-applier.js";
import { SITE_FILES_INTERRUPTED, SiteFilesApplier } from "../sites/site-files-applier.js";
import { SITE_BACKUPS_INTERRUPTED, SiteBackupsApplier } from "../backups/site-backups-applier.js";
import { SITE_WORDPRESS_INTERRUPTED, SiteWordpressApplier } from "../sites/site-wordpress-applier.js";
import { SiteWordpressImportApplier } from "../sites/site-wordpress-import-applier.js";
import { SiteProvisioner, isAmbiguousFailure } from "./site-provisioner.js";

const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);
const DEPLOY_LEASE_MS = 6 * 60_000;
const SITE_ACTION_FAILED = "This action did not finish. Try again in a few minutes.";
const SITE_STEP_TEXT: Readonly<Record<string, string>> = {
  validate_spec: "Request checked",
  dispatch_ipc: "Change applied",
  reconcile_state: "Site is up to date",
};
const SITE_OPERATION_KINDS: ReadonlySet<OperationKind> = new Set([
  "site.provision",
  "site.delete",
  "site.reassign",
]);
const FILE_ARCHIVE_OPERATION_KINDS: readonly OperationKind[] = [
  "site.files.archive",
  "site.files.extract",
];
// The import runs in the WordPress lane: its copy step is the update's own.
const WORDPRESS_LANE_KINDS = [...WORDPRESS_OPERATION_KINDS, WORDPRESS_IMPORT_KIND] as const satisfies readonly OperationKind[];
export const BACKUP_OPERATION_KINDS = [
  "site.backups.create",
  "site.backups.prune",
  "site.backups.restore",
  "site.backups.download",
  "panel.backups.create",
] as const satisfies readonly OperationKind[];

interface OutboxLaneState {
  readonly filter: ClaimPendingOutboxFilter;
  activePromise: Promise<OutboxProcessResult> | null;
  scheduledImmediate: NodeJS.Immediate | null;
  pendingTrigger: boolean;
}

export interface OutboxProcessResult {
  readonly claimed: number;
  readonly succeeded: number;
  readonly failed: number;
}

export interface UnknownRecoveryResult {
  readonly markedUnknown: number;
  readonly convergedSucceeded: number;
  readonly convergedFailed: number;
  /** Operations whose recovery threw this pass; they stay unknown. Present only when not empty. */
  readonly recoveryErrors?: readonly RecoveryError[];
}

type RecoveryError = { readonly kind: string; readonly operationId: string; readonly errorCode: ErrorCode };

function extractErrorCode(err: unknown, fallback: ErrorCode = "INTERNAL_ERROR"): ErrorCode {
  if (
    err !== null &&
    typeof err === "object" &&
    "code" in err &&
    typeof (err as { code?: unknown }).code === "string" &&
    ERROR_CODE_SET.has((err as { code: string }).code)
  ) {
    return (err as { code: ErrorCode }).code;
  }
  return fallback;
}

function extractRestartCount(obs: unknown): number {
  if (
    obs !== null &&
    typeof obs === "object" &&
    "restartCount" in obs &&
    typeof (obs as { restartCount?: unknown }).restartCount === "number"
  ) {
    return (obs as { restartCount: number }).restartCount;
  }
  return 0;
}

@Injectable()
export class OutboxWorkerService {
  #stopped = false;
  #pollTimer: NodeJS.Timeout | null = null;
  #activeRecoveryPromise: Promise<UnknownRecoveryResult> | null = null;
  readonly #mainLane: OutboxLaneState = {
    filter: {
      excludeKinds: [
        ...FILE_ARCHIVE_OPERATION_KINDS,
        ...BACKUP_OPERATION_KINDS,
        ...WORDPRESS_LANE_KINDS,
      ],
    },
    activePromise: null,
    scheduledImmediate: null,
    pendingTrigger: false,
  };
  readonly #fileLane: OutboxLaneState = {
    filter: { includeKinds: FILE_ARCHIVE_OPERATION_KINDS },
    activePromise: null,
    scheduledImmediate: null,
    pendingTrigger: false,
  };
  readonly #backupLane: OutboxLaneState = {
    filter: { includeKinds: BACKUP_OPERATION_KINDS },
    activePromise: null,
    scheduledImmediate: null,
    pendingTrigger: false,
  };
  readonly #wordpressLane: OutboxLaneState = {
    filter: { includeKinds: WORDPRESS_LANE_KINDS },
    activePromise: null,
    scheduledImmediate: null,
    pendingTrigger: false,
  };

  readonly #backupsApplier: SiteBackupsApplier;
  readonly #wordpressApplier: SiteWordpressApplier;
  readonly #wordpressImportApplier: SiteWordpressImportApplier;

  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(DOCKER_EXECUTOR_TOKEN) private readonly dockerExecutor: DockerExecutorPort,
    @Inject(HOST_AGENT_TOKEN) private readonly hostAgent: HostAgentPort,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) private readonly config: ControlPlaneRuntimeConfig,
    @Inject(SiteProvisioner) private readonly siteProvisioner: SiteProvisioner,
    @Inject(SiteDomainsApplier) private readonly siteDomainsApplier: SiteDomainsApplier,
    @Inject(SiteFilesApplier) private readonly siteFilesApplier: SiteFilesApplier,
    @Optional() @Inject(SiteBackupsApplier) siteBackupsApplier?: SiteBackupsApplier,
  ) {
    this.#backupsApplier =
      siteBackupsApplier ?? new SiteBackupsApplier(dbClient, dockerExecutor, config);
    this.#wordpressApplier = new SiteWordpressApplier(
      this.#backupsApplier,
      dbClient,
      dockerExecutor,
      config,
    );
    this.#wordpressImportApplier = new SiteWordpressImportApplier(
      this.#backupsApplier,
      this.#wordpressApplier,
      dbClient,
      dockerExecutor,
      config,
    );
  }

  public startBackgroundLoop(): void {
    const intervalMs = this.config.outboxPollIntervalMs;
    if (this.#stopped || this.#pollTimer || !intervalMs || intervalMs <= 0) {
      return;
    }

    this.#pollTimer = setInterval(() => {
      if (this.#stopped) {
        return;
      }
      void this.recoverUnknownOperations().catch(() => undefined);
      void this.processPendingOnce().catch(() => undefined);
    }, intervalMs);
    this.#pollTimer.unref();
  }

  public triggerAsync(): void {
    if (this.#stopped || !this.config.autoProcessOutbox) {
      return;
    }

    this.#triggerLane(this.#mainLane);
    this.#triggerLane(this.#fileLane);
    this.#triggerLane(this.#backupLane);
    this.#triggerLane(this.#wordpressLane);
  }

  public async stop(): Promise<void> {
    this.#stopped = true;

    for (const lane of [this.#mainLane, this.#fileLane, this.#backupLane, this.#wordpressLane]) {
      lane.pendingTrigger = false;
      if (lane.scheduledImmediate !== null) {
        clearImmediate(lane.scheduledImmediate);
        lane.scheduledImmediate = null;
      }
    }

    if (this.#pollTimer !== null) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = null;
    }

    await Promise.all([
      this.#mainLane.activePromise?.catch(() => undefined),
      this.#fileLane.activePromise?.catch(() => undefined),
      this.#backupLane.activePromise?.catch(() => undefined),
      this.#wordpressLane.activePromise?.catch(() => undefined),
      this.#activeRecoveryPromise?.catch(() => undefined),
    ]);
  }

  #triggerLane(lane: OutboxLaneState): void {
    if (lane.activePromise !== null) {
      lane.pendingTrigger = true;
      return;
    }

    if (lane.scheduledImmediate !== null) {
      return;
    }

    lane.scheduledImmediate = setImmediate(() => {
      lane.scheduledImmediate = null;
      if (this.#stopped) {
        return;
      }
      void this.#drainLane(lane);
    });
  }

  async #drainLane(lane: OutboxLaneState): Promise<void> {
    do {
      lane.pendingTrigger = false;
      await this.#runLane(lane, 10).catch(() => undefined);
    } while (lane.pendingTrigger && !this.#stopped);
  }

  async #runLane(lane: OutboxLaneState, batchSize: number): Promise<OutboxProcessResult> {
    if (lane.activePromise !== null) {
      return lane.activePromise;
    }

    const promise = this.#executeBatch(batchSize, lane.filter);
    lane.activePromise = promise;
    try {
      return await promise;
    } finally {
      if (lane.activePromise === promise) {
        lane.activePromise = null;
      }
    }
  }

  public async processPendingOnce(batchSize: number = 10): Promise<OutboxProcessResult> {
    const results = await Promise.all([
      this.#runLane(this.#mainLane, batchSize),
      this.#runLane(this.#fileLane, batchSize),
      this.#runLane(this.#backupLane, batchSize),
      this.#runLane(this.#wordpressLane, batchSize),
    ]);
    return {
      claimed: results.reduce((n, r) => n + r.claimed, 0),
      succeeded: results.reduce((n, r) => n + r.succeeded, 0),
      failed: results.reduce((n, r) => n + r.failed, 0),
    };
  }

  async #executeBatch(
    batchSize: number,
    filter: ClaimPendingOutboxFilter,
  ): Promise<OutboxProcessResult> {
    const db = this.dbClient.db;
    const claimedEvents = await claimPendingOutboxEvents(db, batchSize, undefined, filter);
    if (claimedEvents.length === 0) {
      return { claimed: 0, succeeded: 0, failed: 0 };
    }

    let succeeded = 0;
    let failed = 0;

    for (const event of claimedEvents) {
      if (this.#stopped) {
        break;
      }

      const outcome = await this.#processSingleEvent(event);
      if (outcome === "succeeded") {
        succeeded += 1;
      } else if (outcome === "failed") {
        failed += 1;
      }
    }

    return {
      claimed: claimedEvents.length,
      succeeded,
      failed,
    };
  }

  async #processSingleEvent(
    event: typeof outboxEvents.$inferSelect,
  ): Promise<"succeeded" | "failed" | "skipped"> {
    const db = this.dbClient.db;
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const operationId =
      typeof payload["operationId"] === "string" && payload["operationId"].length > 0
        ? payload["operationId"]
        : null;

    if (!operationId) {
      await failOutboxEvent(db, event.id, "Missing operationId in outbox event payload");
      return "failed";
    }

    const [op] = await db
      .select()
      .from(operations)
      .where(eq(operations.id, operationId))
      .limit(1);

    if (!op) {
      await failOutboxEvent(db, event.id, `Operation '${operationId}' not found`);
      return "failed";
    }

    if (op.status !== "queued") {
      await completeOutboxEvent(db, event.id);
      return "skipped";
    }

    // Operations on a managed site are shown to customers: fixed friendly step texts only.
    const siteOp = op.lockKey?.startsWith("site:") === true;
    if (siteOp) this.#siteOperationIds.add(op.id);
    try {
      await transitionOperation(db, op.id, "processing");
      await this.#safeUpdateStep(
        op.id,
        "validate_spec",
        "running",
        "Validating declarative specification and security policy",
      );

      if (op.kind === "service.deploy") {
        await this.#executeServiceDeploy(op);
      } else if (op.kind === "service.restart" || op.kind === "service.stop") {
        await this.#executeServiceLifecycleAction(op, op.kind);
      } else if (op.kind === "panel.container.restart") {
        await executePanelContainerRestart(db, this.dockerExecutor, op);
      } else if (op.kind === "host.maintenance") {
        await this.#executeHostMaintenance(op, payload);
      } else if (op.kind === "host.security") {
        await this.#executeHostSecurity(op, payload);
      } else if (op.kind === "site.provision") {
        await this.siteProvisioner.provision(op, payload);
      } else if (op.kind === "site.delete") {
        await this.siteProvisioner.remove(op);
      } else if (op.kind === "site.reassign") {
        await this.siteProvisioner.reassign(op, payload);
      } else if (op.kind === "site.domains") {
        await this.siteDomainsApplier.apply(op);
      } else if (op.kind === "site.files.archive" || op.kind === "site.files.extract") {
        await this.siteFilesApplier.apply(op, payload);
      } else if ((BACKUP_OPERATION_KINDS as readonly string[]).includes(op.kind)) {
        await this.#backupsApplier.apply(op);
      } else if (op.kind === WORDPRESS_IMPORT_KIND) {
        await this.#wordpressImportApplier.apply(op);
      } else if ((WORDPRESS_OPERATION_KINDS as readonly string[]).includes(op.kind)) {
        await this.#wordpressApplier.apply(op);
      } else {
        throw new ControlPlaneError(
          "NOT_SUPPORTED",
          `Unsupported operation kind '${op.kind}'`,
        );
      }

      await completeOutboxEvent(db, event.id);
      return "succeeded";
    } catch (err) {
      const errorCode = extractErrorCode(err, "INTERNAL_ERROR");
      const explicitAmbiguous = isAmbiguousFailure(err);
      const rawMessage = err instanceof Error ? err.message : "Operation execution failed";
      const sanitizedMessage = sanitizePublicErrorMessage(rawMessage).slice(0, 1024);

      const [latestOp] = await db
        .select()
        .from(operations)
        .where(eq(operations.id, op.id))
        .limit(1);

      const postDispatchReconcileInterrupted =
        latestOp?.status === "reconciling" && errorCode === "DOCKER_ENGINE_UNAVAILABLE";

      if (
        (explicitAmbiguous || postDispatchReconcileInterrupted) &&
        latestOp &&
        !isTerminalOperationStatus(latestOp.status) &&
        canTransitionOperation(latestOp.status, "unknown")
      ) {
        await this.#markRunningStepsUnknown(op.id, sanitizedMessage);
        await transitionOperation(db, op.id, "unknown", {
          errorCode: "OPERATION_AMBIGUOUS",
          errorMessage: sanitizedMessage,
          leaseExpiresAt: null,
        });
        // Park outbox event without automatic mutating replay (TH-08 / AC-F2-07)
        await failOutboxEvent(db, event.id, sanitizedMessage);
        await appendAuditEvent(db, {
          actorId: null,
          actorType: "system",
          organizationId: op.organizationId,
          action: "operation.ambiguous",
          targetType: "operation",
          targetId: op.id,
          details: {
            kind: op.kind,
            resourceType: op.resourceType,
            resourceId: op.resourceId,
            errorCode: "OPERATION_AMBIGUOUS",
            reason: sanitizedMessage,
          },
        });
        return "failed";
      }

      const stepMessage = siteOp ? SITE_ACTION_FAILED : sanitizedMessage;
      await this.#failRemainingSteps(op.id, stepMessage);

      if (
        latestOp &&
        !isTerminalOperationStatus(latestOp.status) &&
        canTransitionOperation(latestOp.status, "failed")
      ) {
        // A stop that failed for sure before the runtime accepted it left the container running (R195 1.1).
        const stopNotDone =
          op.kind === "service.stop" && !explicitAmbiguous && ["queued", "processing"].includes(latestOp.status);
        await settleOperation(db, op.id, { status: "failed", errorCode, errorMessage: stepMessage }, async (tx) => {
          if (!stopNotDone) return;
          await tx
            .update(serviceInstances)
            .set({ desiredStatus: "running", updatedAt: new Date() })
            .where(eq(serviceInstances.id, op.resourceId));
        });
      }

      await failOutboxEvent(db, event.id, sanitizedMessage);
      return "failed";
    } finally {
      this.#siteOperationIds.delete(op.id);
    }
  }

  async #executeServiceDeploy(op: typeof operations.$inferSelect): Promise<void> {
    if (!this.dockerExecutor.isRuntimeAvailable) {
      throw new ControlPlaneError(
        "NOT_SUPPORTED",
        "Docker executor runtime is unavailable",
      );
    }

    const db = this.dbClient.db;
    const spec = await buildApprovedServiceSpec(db, this.config, {
      organizationId: op.organizationId,
      serviceInstanceId: op.resourceId,
    });
    const revisionNumber = spec.revisionNumber ?? 0;

    await this.#safeUpdateStep(
      op.id,
      "validate_spec",
      "succeeded",
      `Validated revision #${String(revisionNumber)} specification`,
    );
    await this.#safeUpdateStep(
      op.id,
      "dispatch_ipc",
      "running",
      "Dispatching signed deploy request to docker-executor",
    );

    // An image pull can outlive the 60 s claim lease.
    await renewOperationLease(db, op.id, DEPLOY_LEASE_MS);
    const execResult = await this.dockerExecutor.deployService(spec);

    await transitionOperation(db, op.id, "accepted");
    await this.#safeUpdateStep(
      op.id,
      "dispatch_ipc",
      "succeeded",
      "Runtime accepted container deployment",
    );

    await transitionOperation(db, op.id, "reconciling", { leaseDurationMs: DEPLOY_LEASE_MS });
    await this.#safeUpdateStep(
      op.id,
      "reconcile_state",
      "running",
      "Verifying observed container state",
    );

    const observedStatus = await recordDeployedState(db, this.dockerExecutor, spec, execResult);

    await this.#safeUpdateStep(
      op.id,
      "reconcile_state",
      "succeeded",
      `Service state converged (${observedStatus})`,
    );
    await settleOperation(db, op.id, { status: "succeeded" }, async (tx) => {
      await appendAuditEvent(tx, {
        actorId: null,
        actorType: "system",
        organizationId: op.organizationId,
        action: "service.deploy.succeeded",
        targetType: "service_instance",
        targetId: spec.serviceInstanceId,
        details: {
          operationId: op.id,
          siteId: spec.siteId,
          revisionNumber,
          specHash: spec.specHash,
        },
      });
    });
  }

  async #executeServiceLifecycleAction(
    op: typeof operations.$inferSelect,
    kind: "service.restart" | "service.stop",
  ): Promise<void> {
    if (!this.dockerExecutor.isRuntimeAvailable) {
      throw new ControlPlaneError(
        "NOT_SUPPORTED",
        "Docker executor runtime is unavailable",
      );
    }

    const db = this.dbClient.db;
    const [svc] = await db
      .select()
      .from(serviceInstances)
      .where(
        and(
          eq(serviceInstances.id, op.resourceId),
          eq(serviceInstances.organizationId, op.organizationId),
        ),
      )
      .limit(1);

    if (!svc) {
      throw new ControlPlaneError(
        "NOT_FOUND",
        `Service instance '${op.resourceId}' not found`,
      );
    }

    const [rev] = svc.currentRevisionId
      ? await db
          .select()
          .from(stackRevisions)
          .where(eq(stackRevisions.id, svc.currentRevisionId))
          .limit(1)
      : [undefined];

    await this.#safeUpdateStep(
      op.id,
      "validate_spec",
      "succeeded",
      "Service lifecycle action validated",
    );
    await this.#safeUpdateStep(
      op.id,
      "dispatch_ipc",
      "running",
      `Dispatching ${kind} over signed IPC`,
    );

    let gone = false;
    const execResult =
      kind === "service.restart"
        ? await this.#restartOrRecreate(op, svc)
        : await this.dockerExecutor.stopService(svc.id).catch((err: unknown): DockerExecutionResult => {
            // D8: a container that is gone is already stopped; it is recorded missing and nothing is created.
            if (extractErrorCode(err) !== "NOT_FOUND") throw err;
            gone = true;
            return { operationId: op.id, status: "succeeded" };
          });

    await transitionOperation(db, op.id, "accepted");
    await this.#safeUpdateStep(
      op.id,
      "dispatch_ipc",
      "succeeded",
      `Runtime ${kind} completed`,
    );

    await transitionOperation(db, op.id, "reconciling", { leaseDurationMs: DEPLOY_LEASE_MS });
    await this.#safeUpdateStep(
      op.id,
      "reconcile_state",
      "running",
      "Reconciling observed container state",
    );

    const obs = await this.dockerExecutor.getObservedState(svc.id);
    const expectedFallbackStatus = kind === "service.stop" ? "stopped" : "running";
    const observedStatus = gone
      ? "missing"
      : obs?.observedStatus ?? execResult.containerStatus ?? expectedFallbackStatus;
    const dockerRef =
      execResult.internalDockerRef ??
      (obs as { internalDockerRef?: string } | null)?.internalDockerRef;

    if (dockerRef) {
      await rebindDockerResourceTransactional(db, svc.id, dockerRef, observedStatus);
    }

    await recordObservedStateReconciliationTransactional(db, {
      serviceInstanceId: svc.id,
      observedStatus,
      observedRevisionHash: obs?.observedRevisionHash ?? rev?.specHash ?? null,
      outOfBandModified: Boolean(obs?.outOfBandModified),
      rawState: {
        restartCount: extractRestartCount(obs),
      },
      observedAt: obs?.observedAt ? new Date(obs.observedAt) : new Date(),
    });

    await this.#safeUpdateStep(
      op.id,
      "reconcile_state",
      "succeeded",
      `Service state converged (${observedStatus})`,
    );
    await settleOperation(db, op.id, { status: "succeeded" });
  }

  /** D8: a restart of a gone container creates it again from the stored revision, only after a set-up that succeeded. */
  async #restartOrRecreate(
    op: typeof operations.$inferSelect,
    svc: typeof serviceInstances.$inferSelect,
  ): Promise<DockerExecutionResult> {
    try {
      return await this.dockerExecutor.restartService(svc.id);
    } catch (err) {
      if (extractErrorCode(err) !== "NOT_FOUND") throw err;
      const db = this.dbClient.db;
      const provision = await latestSiteOperation(db, { siteId: svc.siteId, kind: "site.provision" });
      // A site whose delete ever started is not rebuilt, even when the delete failed halfway (R195 1.2).
      if (provision?.status !== "succeeded" || (await latestSiteOperation(db, { siteId: svc.siteId, kind: "site.delete" }))) throw err;
      const spec = await buildApprovedServiceSpec(db, this.config, {
        organizationId: op.organizationId,
        serviceInstanceId: svc.id,
      });
      await renewOperationLease(db, op.id, DEPLOY_LEASE_MS);
      const result = await this.dockerExecutor.deployService(spec);
      await recordDeployedState(db, this.dockerExecutor, spec, result);
      return result;
    }
  }

  async #executeHostMaintenance(
    op: typeof operations.$inferSelect,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.hostAgent.isRuntimeAvailable) {
      throw new ControlPlaneError(
        "NOT_SUPPORTED",
        "Host agent runtime is unavailable",
      );
    }

    const db = this.dbClient.db;
    const hostAction =
      typeof payload["hostAction"] === "string" ? payload["hostAction"] : "";
    const reason =
      typeof payload["reason"] === "string" && payload["reason"].length > 0
        ? payload["reason"]
        : undefined;

    const command = createApprovedHostMaintenanceCommand({
      hostId: op.resourceId,
      action: hostAction,
      reason,
    });

    await this.#safeUpdateStep(
      op.id,
      "validate_spec",
      "succeeded",
      `Allowlisted maintenance action '${command.action}' validated`,
    );
    await this.#safeUpdateStep(
      op.id,
      "dispatch_ipc",
      "running",
      "Dispatching signed maintenance request to host-agent",
    );

    const result = await this.hostAgent.executeMaintenance(command);

    await transitionOperation(db, op.id, "accepted");
    if (result.status === "failed") {
      throw new ControlPlaneError(
        "INTERNAL_ERROR",
        result.output
          ? redactSensitiveString(result.output.slice(0, 500))
          : "Host maintenance execution reported failure",
      );
    }

    await this.#safeUpdateStep(
      op.id,
      "dispatch_ipc",
      "succeeded",
      `Maintenance action '${command.action}' completed`,
    );
    await this.#safeUpdateStep(
      op.id,
      "reconcile_state",
      "succeeded",
      result.output
        ? redactSensitiveString(result.output.slice(0, 500))
        : "Host maintenance verified",
    );
    await settleOperation(db, op.id, { status: "succeeded" });
  }

  async #executeHostSecurity(
    op: typeof operations.$inferSelect,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.hostAgent.isRuntimeAvailable) {
      throw new ControlPlaneError(
        "NOT_SUPPORTED",
        "Host agent runtime is unavailable",
      );
    }

    const db = this.dbClient.db;
    const policyRef =
      typeof payload["policyRef"] === "string" ? payload["policyRef"] : "";
    const reason =
      typeof payload["reason"] === "string" && payload["reason"].length > 0
        ? payload["reason"]
        : undefined;

    const command = createApprovedHostSecurityCommand({
      hostId: op.resourceId,
      policyRef,
      reason,
    });

    await this.#safeUpdateStep(
      op.id,
      "validate_spec",
      "succeeded",
      `Allowlisted security policy '${command.policyRef}' validated`,
    );
    await this.#safeUpdateStep(
      op.id,
      "dispatch_ipc",
      "running",
      "Dispatching signed security policy request to host-agent",
    );

    const result = await this.hostAgent.executeSecurityPolicy(command);

    await transitionOperation(db, op.id, "accepted");
    if (result.status === "failed") {
      throw new ControlPlaneError(
        "INTERNAL_ERROR",
        result.output
          ? redactSensitiveString(result.output.slice(0, 500))
          : "Host security policy execution reported failure",
      );
    }

    await this.#safeUpdateStep(
      op.id,
      "dispatch_ipc",
      "succeeded",
      `Security policy '${command.policyRef}' completed`,
    );
    await this.#safeUpdateStep(
      op.id,
      "reconcile_state",
      "succeeded",
      result.output
        ? redactSensitiveString(result.output.slice(0, 500))
        : "Host security posture verified",
    );
    await settleOperation(db, op.id, { status: "succeeded" });
  }

  /**
   * Read-only crash recovery for ambiguous in-flight operations (TH-08 / AC-F2-07).
   * NEVER invokes mutating deployService / restartService / stopService / executeMaintenance / executeSecurityPolicy.
   */
  public async recoverUnknownOperations(
    now: Date = new Date(),
  ): Promise<UnknownRecoveryResult> {
    if (this.#activeRecoveryPromise !== null) {
      return this.#activeRecoveryPromise;
    }

    const promise = this.#executeUnknownRecovery(now);
    this.#activeRecoveryPromise = promise;
    try {
      return await promise;
    } finally {
      this.#activeRecoveryPromise = null;
    }
  }

  async #executeUnknownRecovery(now: Date): Promise<UnknownRecoveryResult> {
    const db = this.dbClient.db;
    // Requeue stale claims left by a stopped worker while the operation is still queued.
    await db.transaction(async (tx) => {
      const staleEvents = await tx
        .select({ id: outboxEvents.id })
        .from(outboxEvents)
        .innerJoin(
          operations,
          eq(operations.id, sql`${outboxEvents.payload}->>'operationId'`),
        )
        .where(
          and(
            eq(outboxEvents.status, "processing"),
            eq(operations.status, "queued"),
            or(isNull(operations.leaseExpiresAt), lte(operations.leaseExpiresAt, now)),
          ),
        )
        .for("update");

      if (staleEvents.length > 0) {
        await tx
          .update(outboxEvents)
          .set({ status: "pending", lockedAt: null })
          .where(
            inArray(
              outboxEvents.id,
              staleEvents.map((row) => row.id),
            ),
          );
      }
    });

    const newlyMarked = await markExpiredOperationsUnknownTransactional(db, now);

    const unknownOps = await db
      .select()
      .from(operations)
      .where(eq(operations.status, "unknown"))
      .orderBy(asc(operations.submittedAt));

    let convergedSucceeded = 0;
    let convergedFailed = 0;
    const recoveryErrors: RecoveryError[] = [];

    for (const op of unknownOps) {
      try {
        if (op.kind === "site.domains") {
          // Only routes changed: the site keeps its status and the reconciler re-enqueues.
          await this.#convergeUnknownToFailed(op, SITE_DOMAINS_INTERRUPTED);
          convergedFailed += 1;
        } else if (op.kind === "site.files.archive" || op.kind === "site.files.extract") {
          // File archive/extract operations never leave the site degraded and are never blindly replayed.
          await this.#convergeUnknownToFailed(op, SITE_FILES_INTERRUPTED);
          convergedFailed += 1;
        } else if (op.kind === "site.wordpress.inspect") {
          // A check changes nothing on the site: fail it and let the customer ask again.
          await this.#convergeUnknownToFailed(op, SITE_WORDPRESS_INTERRUPTED);
          convergedFailed += 1;
        } else if (
          (BACKUP_OPERATION_KINDS as readonly string[]).includes(op.kind) ||
          op.kind === "site.wordpress.update" ||
          op.kind === WORDPRESS_IMPORT_KIND
        ) {
          // Backup, update and import recovery never replay a change; the applier settles what it can.
          const outcome =
            op.kind === "site.wordpress.update"
              ? await this.#wordpressApplier.recover(op)
              : op.kind === WORDPRESS_IMPORT_KIND
                ? await this.#wordpressImportApplier.recover(op)
                : await this.#backupsApplier.recover(op);
          if (outcome === "pending") {
            continue;
          }
          const [settled] = await db
            .select({
              status: operations.status,
              errorCode: operations.errorCode,
              errorMessage: operations.errorMessage,
            })
            .from(operations)
            .where(eq(operations.id, op.id))
            .limit(1);
          if (settled?.status === "succeeded") {
            await this.#settleAssociatedOutboxEvents(op.id, "succeeded");
            await appendAuditEvent(db, {
              actorId: null,
              actorType: "system",
              organizationId: op.organizationId,
              action: "operation.recovered.succeeded",
              targetType: "operation",
              targetId: op.id,
              details: {
                kind: op.kind,
                resourceType: op.resourceType,
                resourceId: op.resourceId,
              },
            });
            convergedSucceeded += 1;
          } else {
            const reason = settled?.errorMessage ?? SITE_BACKUPS_INTERRUPTED;
            const errorCode = settled?.errorCode ?? "OPERATION_INTERRUPTED";
            await this.#settleAssociatedOutboxEvents(op.id, "failed", reason);
            await appendAuditEvent(db, {
              actorId: null,
              actorType: "system",
              organizationId: op.organizationId,
              action: "operation.recovered.failed",
              targetType: "operation",
              targetId: op.id,
              details: {
                kind: op.kind,
                resourceType: op.resourceType,
                resourceId: op.resourceId,
                errorCode,
                reason,
              },
            });
            convergedFailed += 1;
          }
        } else if (SITE_OPERATION_KINDS.has(op.kind)) {
          // Site steps are not safely replayable mid-way: fail and let the customer retry.
          await this.#convergeUnknownToFailed(op, "This operation was interrupted before it finished.");
          await db
            .update(sites)
            .set({ status: "degraded", updatedAt: now })
            .where(eq(sites.id, op.resourceId));
          convergedFailed += 1;
        } else if (
          op.kind === "service.deploy" ||
          op.kind === "service.restart" ||
          op.kind === "service.stop"
        ) {
          if (!this.dockerExecutor.isRuntimeAvailable) {
            await this.#convergeUnknownToFailed(
              op,
              "Operation interrupted while Docker executor runtime was unavailable; read-only recovery could not verify target state",
            );
            convergedFailed += 1;
            continue;
          }

          const [svc] = await db
            .select()
            .from(serviceInstances)
            .where(eq(serviceInstances.id, op.resourceId))
            .limit(1);

          const [currentRev] =
            svc?.currentRevisionId
              ? await db
                  .select()
                  .from(stackRevisions)
                  .where(eq(stackRevisions.id, svc.currentRevisionId))
                  .limit(1)
              : [undefined];

          // Strictly read-only inspection (AC-F2-07)
          let obs: Awaited<ReturnType<DockerExecutorPort["getObservedState"]>>;
          try {
            obs = await this.dockerExecutor.getObservedState(op.resourceId);
          } catch {
            // Executor IPC temporarily unreachable; preserve 'unknown' status and lockKey
            continue;
          }

          const targetMatched =
            op.kind === "service.stop"
              ? obs !== null && obs.observedStatus === "stopped"
              : obs !== null &&
                obs.observedStatus === "running" &&
                Boolean(currentRev?.specHash) &&
                obs.observedRevisionHash === currentRev?.specHash &&
                !obs.outOfBandModified;

          if (targetMatched && obs !== null) {
            if (svc) {
              await recordObservedStateReconciliationTransactional(db, {
                serviceInstanceId: svc.id,
                observedStatus: obs.observedStatus,
                observedRevisionHash: obs.observedRevisionHash ?? null,
                outOfBandModified: Boolean(obs.outOfBandModified),
                rawState: {
                  restartCount: extractRestartCount(obs),
                  recoveredFromUnknown: true,
                },
                observedAt: obs.observedAt ? new Date(obs.observedAt) : now,
              });
            }

            await this.#settleNonTerminalSteps(
              op.id,
              "succeeded",
              "Verified via read-only crash recovery reconciliation (TH-08)",
            );

            await settleOperation(db, op.id, { status: "succeeded" }, async (tx) => {
              await appendAuditEvent(tx, {
                actorId: null,
                actorType: "system",
                organizationId: op.organizationId,
                action: "operation.recovered.succeeded",
                targetType: "operation",
                targetId: op.id,
                details: {
                  kind: op.kind,
                  resourceType: op.resourceType,
                  resourceId: op.resourceId,
                },
              });
            });

            await this.#settleAssociatedOutboxEvents(op.id, "succeeded");

            convergedSucceeded += 1;
          } else {
            const mismatchDetail =
              obs === null
                ? "target container was absent during read-only recovery"
                : `observed container status '${obs.observedStatus}' (hash=${String(obs.observedRevisionHash)}) did not match desired target`;
            await this.#convergeUnknownToFailed(
              op,
              `Operation interrupted before convergence: ${mismatchDetail} (TH-08)`,
              op.kind === "service.stop" && obs?.observedStatus === "running",
            );
            convergedFailed += 1;
          }
        } else if (op.kind === "panel.container.restart") {
          // Docker may have finished the restart; Health shows the truth, the operation says interrupted.
          await this.#settleNonTerminalSteps(op.id, "failed", "The restart was interrupted.");
          await recoverPanelContainerRestart(db, op);
          await this.#settleAssociatedOutboxEvents(op.id, "failed", "The restart was interrupted.");
          convergedFailed += 1;
        } else {
          await this.#convergeUnknownToFailed(
            op,
            `Host operation '${op.kind}' was interrupted in flight; automatic replay is prohibited (TH-08)`,
          );
          convergedFailed += 1;
        }
      } catch (err) {
        // One recovery that throws leaves its operation as it is and never blocks the next (R141).
        recoveryErrors.push({ kind: op.kind, operationId: op.id, errorCode: extractErrorCode(err) });
      }
    }

    return {
      markedUnknown: newlyMarked.length,
      convergedSucceeded,
      convergedFailed,
      ...(recoveryErrors.length > 0 ? { recoveryErrors } : {}),
    };
  }

  async #convergeUnknownToFailed(
    op: typeof operations.$inferSelect,
    reasonMessage: string,
    stopNotDone = false,
  ): Promise<void> {
    const db = this.dbClient.db;
    const sanitizedReason = redactSensitiveString(reasonMessage);

    await this.#settleNonTerminalSteps(op.id, "failed", sanitizedReason);

    await db.transaction(async (tx) => {
      const t = tx as unknown as typeof db;
      await transitionOperation(t, op.id, "failed", {
        errorCode: "OPERATION_INTERRUPTED",
        errorMessage: sanitizedReason,
      });
      // The container still runs after a Stop left in doubt: it is wanted running again (R196 1.1).
      if (!stopNotDone) return;
      await t
        .update(serviceInstances)
        .set({ desiredStatus: "running", updatedAt: new Date() })
        .where(eq(serviceInstances.id, op.resourceId));
    });

    await this.#settleAssociatedOutboxEvents(op.id, "failed", sanitizedReason);

    await appendAuditEvent(db, {
      actorId: null,
      actorType: "system",
      organizationId: op.organizationId,
      action: "operation.recovered.failed",
      targetType: "operation",
      targetId: op.id,
      details: {
        kind: op.kind,
        resourceType: op.resourceType,
        resourceId: op.resourceId,
        errorCode: "OPERATION_INTERRUPTED",
        reason: sanitizedReason,
      },
    });
  }

  async #settleAssociatedOutboxEvents(
    operationId: string,
    outcome: "succeeded" | "failed",
    errorMessage?: string,
  ): Promise<void> {
    const db = this.dbClient.db;
    const candidateEvents = await db
      .select()
      .from(outboxEvents)
      .where(inArray(outboxEvents.status, ["pending", "processing"]));

    for (const evt of candidateEvents) {
      const payload = (evt.payload ?? {}) as Record<string, unknown>;
      if (payload["operationId"] === operationId) {
        if (outcome === "succeeded") {
          await completeOutboxEvent(db, evt.id);
        } else {
          await failOutboxEvent(
            db,
            evt.id,
            errorMessage ?? "Operation converged to failed during recovery",
          );
        }
      }
    }
  }

  readonly #siteOperationIds = new Set<string>();

  async #safeUpdateStep(
    operationId: string,
    stepKey: string,
    status: OperationStepStatus,
    message?: string,
  ): Promise<void> {
    if (this.#siteOperationIds.has(operationId)) {
      message =
        status === "succeeded"
          ? (SITE_STEP_TEXT[stepKey] ?? "Done")
          : status === "running"
            ? "In progress"
            : "Could not finish this step";
    }
    try {
      await updateOperationStepTransactional(
        this.dbClient.db,
        operationId,
        stepKey,
        status,
        message,
      );
    } catch {
      // Ignore if operation was enqueued without this optional step key
    }
  }

  async #markRunningStepsUnknown(operationId: string, message: string): Promise<void> {
    const db = this.dbClient.db;
    const steps = await db
      .select()
      .from(operationSteps)
      .where(eq(operationSteps.operationId, operationId))
      .orderBy(asc(operationSteps.id));

    for (const step of steps) {
      if (step.status === "running") {
        await updateOperationStepTransactional(
          db,
          operationId,
          step.key,
          "unknown",
          message,
        );
      }
    }
  }

  async #failRemainingSteps(operationId: string, message: string): Promise<void> {
    const db = this.dbClient.db;
    const steps = await db
      .select()
      .from(operationSteps)
      .where(eq(operationSteps.operationId, operationId))
      .orderBy(asc(operationSteps.id));

    for (const step of steps) {
      if (step.status === "running" || step.status === "unknown") {
        await updateOperationStepTransactional(
          db,
          operationId,
          step.key,
          "failed",
          message,
        );
      } else if (step.status === "pending") {
        await updateOperationStepTransactional(
          db,
          operationId,
          step.key,
          "skipped",
          "Skipped due to prior step failure",
        );
      }
    }
  }

  async #settleNonTerminalSteps(
    operationId: string,
    targetStatus: "succeeded" | "failed",
    message: string,
  ): Promise<void> {
    const db = this.dbClient.db;
    const steps = await db
      .select()
      .from(operationSteps)
      .where(eq(operationSteps.operationId, operationId))
      .orderBy(asc(operationSteps.id));

    for (const step of steps) {
      if (
        step.status === "pending" ||
        step.status === "running" ||
        step.status === "unknown"
      ) {
        await updateOperationStepTransactional(
          db,
          operationId,
          step.key,
          targetStatus,
          message,
        );
      }
    }
  }
}
