import { Inject, Injectable } from "@nestjs/common";
import {
  ERROR_CODES,
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
  markExpiredOperationsUnknownTransactional,
  operationSteps,
  operations,
  outboxEvents,
  rebindDockerResourceTransactional,
  recordObservedStateReconciliationTransactional,
  renewOperationLease,
  serviceInstances,
  sites,
  stackRevisions,
  transitionOperation,
  updateOperationStepTransactional,
  type DatabaseClient,
} from "@hosting-panel/database";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
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
import { SITE_DOMAINS_INTERRUPTED, SiteDomainsApplier } from "../sites/site-domains-applier.js";
import { SiteProvisioner } from "./site-provisioner.js";

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

export interface OutboxProcessResult {
  readonly claimed: number;
  readonly succeeded: number;
  readonly failed: number;
}

export interface UnknownRecoveryResult {
  readonly markedUnknown: number;
  readonly convergedSucceeded: number;
  readonly convergedFailed: number;
}

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
  #scheduledImmediate: NodeJS.Immediate | null = null;
  #pollTimer: NodeJS.Timeout | null = null;
  #activeRunPromise: Promise<OutboxProcessResult> | null = null;
  #activeRecoveryPromise: Promise<UnknownRecoveryResult> | null = null;
  #pendingTrigger = false;

  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(DOCKER_EXECUTOR_TOKEN) private readonly dockerExecutor: DockerExecutorPort,
    @Inject(HOST_AGENT_TOKEN) private readonly hostAgent: HostAgentPort,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) private readonly config: ControlPlaneRuntimeConfig,
    @Inject(SiteProvisioner) private readonly siteProvisioner: SiteProvisioner,
    @Inject(SiteDomainsApplier) private readonly siteDomainsApplier: SiteDomainsApplier,
  ) {}

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

    if (this.#activeRunPromise !== null) {
      this.#pendingTrigger = true;
      return;
    }

    if (this.#scheduledImmediate !== null) {
      return;
    }

    this.#scheduledImmediate = setImmediate(() => {
      this.#scheduledImmediate = null;
      if (this.#stopped) {
        return;
      }
      void this.#drainPendingTriggers();
    });
  }

  public async stop(): Promise<void> {
    this.#stopped = true;
    this.#pendingTrigger = false;

    if (this.#scheduledImmediate !== null) {
      clearImmediate(this.#scheduledImmediate);
      this.#scheduledImmediate = null;
    }

    if (this.#pollTimer !== null) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = null;
    }

    if (this.#activeRunPromise !== null) {
      await this.#activeRunPromise.catch(() => undefined);
    }

    if (this.#activeRecoveryPromise !== null) {
      await this.#activeRecoveryPromise.catch(() => undefined);
    }
  }

  async #drainPendingTriggers(): Promise<void> {
    do {
      this.#pendingTrigger = false;
      await this.processPendingOnce().catch(() => undefined);
    } while (this.#pendingTrigger && !this.#stopped);
  }

  public async processPendingOnce(batchSize: number = 10): Promise<OutboxProcessResult> {
    if (this.#activeRunPromise !== null) {
      return this.#activeRunPromise;
    }

    const promise = this.#executeBatch(batchSize);
    this.#activeRunPromise = promise;
    try {
      return await promise;
    } finally {
      this.#activeRunPromise = null;
    }
  }

  async #executeBatch(batchSize: number): Promise<OutboxProcessResult> {
    const db = this.dbClient.db;
    const claimedEvents = await claimPendingOutboxEvents(db, batchSize);
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
      const explicitAmbiguous =
        errorCode === "OPERATION_AMBIGUOUS" ||
        Boolean(
          err !== null &&
            typeof err === "object" &&
            (err as { ambiguousOutcome?: unknown }).ambiguousOutcome === true,
        );
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
        await transitionOperation(db, op.id, "failed", {
          errorCode,
          errorMessage: stepMessage,
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

    await transitionOperation(db, op.id, "reconciling");
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
    await transitionOperation(db, op.id, "succeeded", {
      errorCode: null,
      errorMessage: null,
    });

    await appendAuditEvent(db, {
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

    const execResult =
      kind === "service.restart"
        ? await this.dockerExecutor.restartService(svc.id)
        : await this.dockerExecutor.stopService(svc.id);

    await transitionOperation(db, op.id, "accepted");
    await this.#safeUpdateStep(
      op.id,
      "dispatch_ipc",
      "succeeded",
      `Runtime ${kind} completed`,
    );

    await transitionOperation(db, op.id, "reconciling");
    await this.#safeUpdateStep(
      op.id,
      "reconcile_state",
      "running",
      "Reconciling observed container state",
    );

    const obs = await this.dockerExecutor.getObservedState(svc.id);
    const expectedFallbackStatus = kind === "service.stop" ? "stopped" : "running";
    const observedStatus =
      obs?.observedStatus ?? execResult.containerStatus ?? expectedFallbackStatus;
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
    await transitionOperation(db, op.id, "succeeded", {
      errorCode: null,
      errorMessage: null,
    });
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
    await transitionOperation(db, op.id, "reconciling");
    await this.#safeUpdateStep(
      op.id,
      "reconcile_state",
      "succeeded",
      result.output
        ? redactSensitiveString(result.output.slice(0, 500))
        : "Host maintenance verified",
    );
    await transitionOperation(db, op.id, "succeeded", {
      errorCode: null,
      errorMessage: null,
    });
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
    await transitionOperation(db, op.id, "reconciling");
    await this.#safeUpdateStep(
      op.id,
      "reconcile_state",
      "succeeded",
      result.output
        ? redactSensitiveString(result.output.slice(0, 500))
        : "Host security posture verified",
    );
    await transitionOperation(db, op.id, "succeeded", {
      errorCode: null,
      errorMessage: null,
    });
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
    const newlyMarked = await markExpiredOperationsUnknownTransactional(db, now);

    const unknownOps = await db
      .select()
      .from(operations)
      .where(eq(operations.status, "unknown"))
      .orderBy(asc(operations.submittedAt));

    let convergedSucceeded = 0;
    let convergedFailed = 0;

    for (const op of unknownOps) {
      if (op.kind === "site.domains") {
        // Only routes changed: the site keeps its status and the reconciler re-enqueues.
        await this.#convergeUnknownToFailed(op, SITE_DOMAINS_INTERRUPTED);
        convergedFailed += 1;
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
          await transitionOperation(db, op.id, "reconciling", {
            errorCode: null,
            errorMessage: null,
          });

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

          await transitionOperation(db, op.id, "succeeded", {
            errorCode: null,
            errorMessage: null,
          });

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
          const mismatchDetail =
            obs === null
              ? "target container was absent during read-only recovery"
              : `observed container status '${obs.observedStatus}' (hash=${String(obs.observedRevisionHash)}) did not match desired target`;
          await this.#convergeUnknownToFailed(
            op,
            `Operation interrupted before convergence: ${mismatchDetail} (TH-08)`,
          );
          convergedFailed += 1;
        }
      } else {
        await this.#convergeUnknownToFailed(
          op,
          `Host operation '${op.kind}' was interrupted in flight; automatic replay is prohibited (TH-08)`,
        );
        convergedFailed += 1;
      }
    }

    return {
      markedUnknown: newlyMarked.length,
      convergedSucceeded,
      convergedFailed,
    };
  }

  async #convergeUnknownToFailed(
    op: typeof operations.$inferSelect,
    reasonMessage: string,
  ): Promise<void> {
    const db = this.dbClient.db;
    const sanitizedReason = redactSensitiveString(reasonMessage);

    await this.#settleNonTerminalSteps(op.id, "failed", sanitizedReason);

    await transitionOperation(db, op.id, "failed", {
      errorCode: "OPERATION_INTERRUPTED",
      errorMessage: sanitizedReason,
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
