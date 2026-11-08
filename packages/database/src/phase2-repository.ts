import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import {
  SECRET_KEY_PATTERN,
  canTransitionOperation,
  redactSensitiveString,
  redactSensitiveValue,
  type EncryptedSecretMetadataDto,
  type ErrorCode,
  type HostDaemonComponent,
  type HostDaemonHeartbeatDto,
  type HostDaemonStatus,
  type OperationStepStatus,
} from "@hosting-panel/contracts";
import {
  evaluateServiceDrift,
  type DriftEvaluationResult,
} from "@hosting-panel/hosting-domain";
import type { DatabaseExecutor, HostingPanelDatabase } from "./client.js";
import {
  auditEvents,
  encryptedSecrets,
  hostAgentHeartbeats,
  hosts,
  observedStates,
  operationSteps,
  operations,
  outboxEvents,
  serviceInstances,
  sites,
  stackRevisions,
} from "./schema.js";
import { decryptSecretAesGcm, encryptSecretAesGcm } from "./secrets-crypto.js";

function generatePrefixedId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

function createRepoError(message: string, code: ErrorCode): Error {
  const err = new Error(message);
  (err as unknown as { code: ErrorCode }).code = code;
  return err;
}

const TERMINAL_STEP_STATUSES: ReadonlySet<OperationStepStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
]);

export async function completeOutboxEvent(
  executor: DatabaseExecutor,
  outboxEventId: string,
) {
  const now = new Date();
  const [updated] = await executor
    .update(outboxEvents)
    .set({
      status: "published",
      publishedAt: now,
      lockedAt: null,
      lastError: null,
    })
    .where(eq(outboxEvents.id, outboxEventId))
    .returning();

  if (!updated) {
    throw createRepoError(`Outbox event '${outboxEventId}' not found`, "NOT_FOUND");
  }
  return updated;
}

export async function failOutboxEvent(
  executor: DatabaseExecutor,
  outboxEventId: string,
  errorMessage: string,
) {
  const sanitizedError = redactSensitiveString(errorMessage || "Outbox execution failed");
  const [updated] = await executor
    .update(outboxEvents)
    .set({
      status: "failed",
      retryCount: sql`${outboxEvents.retryCount} + 1`,
      lastError: sanitizedError,
      lockedAt: null,
    })
    .where(eq(outboxEvents.id, outboxEventId))
    .returning();

  if (!updated) {
    throw createRepoError(`Outbox event '${outboxEventId}' not found`, "NOT_FOUND");
  }
  return updated;
}

export async function updateOperationStepTransactional(
  db: HostingPanelDatabase,
  operationId: string,
  stepKey: string,
  status: OperationStepStatus,
  message?: string | null,
) {
  return db.transaction(async (tx) => {
    const stepRows = await tx
      .select()
      .from(operationSteps)
      .where(and(eq(operationSteps.operationId, operationId), eq(operationSteps.key, stepKey)))
      .for("update");

    const existing = stepRows[0];
    if (!existing) {
      throw createRepoError(
        `Operation step '${stepKey}' not found for operation '${operationId}'`,
        "NOT_FOUND",
      );
    }

    const now = new Date();
    const isTerminal = TERMINAL_STEP_STATUSES.has(status);
    const startedAt =
      existing.startedAt ?? (status === "running" || isTerminal ? now : null);
    const completedAt = isTerminal ? now : existing.completedAt;
    const sanitizedMessage =
      message === undefined
        ? existing.message
        : message === null
          ? null
          : redactSensitiveString(message);

    const [updatedStep] = await tx
      .update(operationSteps)
      .set({
        status,
        message: sanitizedMessage,
        startedAt,
        completedAt,
      })
      .where(eq(operationSteps.id, existing.id))
      .returning();

    await tx
      .update(operations)
      .set({ updatedAt: now })
      .where(eq(operations.id, operationId));

    return updatedStep!;
  });
}

export async function markExpiredOperationsUnknownTransactional(
  db: HostingPanelDatabase,
  now: Date = new Date(),
) {
  return db.transaction(async (tx) => {
    const expiredRows = await tx
      .select()
      .from(operations)
      .where(
        and(
          inArray(operations.status, ["processing", "accepted"]),
          isNotNull(operations.leaseExpiresAt),
          lte(operations.leaseExpiresAt, now),
        ),
      )
      .for("update");

    if (expiredRows.length === 0) {
      return [];
    }

    const transitioned = [];
    for (const op of expiredRows) {
      if (!canTransitionOperation(op.status, "unknown")) {
        continue;
      }

      // Transition to 'unknown' while preserving lockKey active (HCP-SPEC-003 §7.2 / TH-08)
      const [updatedOp] = await tx
        .update(operations)
        .set({
          status: "unknown",
          errorCode: op.errorCode ?? "OPERATION_AMBIGUOUS",
          errorMessage:
            op.errorMessage ??
            "Operation lease expired while in flight; awaiting read-only reconciliation (TH-08)",
          updatedAt: now,
        })
        .where(eq(operations.id, op.id))
        .returning();

      await tx
        .update(operationSteps)
        .set({
          status: "unknown",
          message: "Lease expired before completion; awaiting reconciliation",
        })
        .where(
          and(
            eq(operationSteps.operationId, op.id),
            eq(operationSteps.status, "running"),
          ),
        );

      await tx.insert(auditEvents).values({
        id: generatePrefixedId("aud"),
        actorId: null,
        actorType: "system",
        organizationId: op.organizationId,
        action: "operation.marked_unknown",
        targetType: "operation",
        targetId: op.id,
        details: {
          previousStatus: op.status,
          lockKey: op.lockKey,
          resourceType: op.resourceType,
          resourceId: op.resourceId,
        },
      });

      if (updatedOp) {
        transitioned.push(updatedOp);
      }
    }

    return transitioned;
  });
}

export interface UnlockOperationBreakGlassInput {
  readonly operationId: string;
  readonly reason: string;
  readonly actorId?: string | null;
}

export async function unlockOperationBreakGlassTransactional(
  db: HostingPanelDatabase,
  input: UnlockOperationBreakGlassInput,
) {
  const trimmedReason = input.reason?.trim() ?? "";
  if (trimmedReason.length === 0) {
    throw createRepoError(
      "Break-glass operation unlock requires a mandatory non-empty reason",
      "VALIDATION_ERROR",
    );
  }

  return db.transaction(async (tx) => {
    const opRows = await tx
      .select()
      .from(operations)
      .where(eq(operations.id, input.operationId))
      .for("update");

    const op = opRows[0];
    if (!op) {
      throw createRepoError(`Operation '${input.operationId}' not found`, "NOT_FOUND");
    }

    if (op.status !== "unknown") {
      throw createRepoError(
        `Break-glass unlock is only permitted for operations in 'unknown' status (current: '${op.status}')`,
        "VALIDATION_ERROR",
      );
    }

    const now = new Date();
    const sanitizedReason = redactSensitiveString(trimmedReason);

    const [updatedOp] = await tx
      .update(operations)
      .set({
        status: "failed",
        errorCode: "OPERATION_INTERRUPTED",
        errorMessage: `Break-glass unlock: ${sanitizedReason}`,
        leaseExpiresAt: null,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(operations.id, op.id))
      .returning();

    await tx
      .update(operationSteps)
      .set({
        status: "failed",
        message: "Interrupted by break-glass unlock",
        completedAt: now,
      })
      .where(
        and(
          eq(operationSteps.operationId, op.id),
          inArray(operationSteps.status, ["pending", "running", "unknown"]),
        ),
      );

    const [auditEvent] = await tx
      .insert(auditEvents)
      .values({
        id: generatePrefixedId("aud"),
        actorId: input.actorId ?? null,
        actorType: "system",
        organizationId: op.organizationId,
        action: "breakglass.operation.unlock",
        targetType: "operation",
        targetId: op.id,
        details: {
          reason: sanitizedReason,
          previousStatus: op.status,
          lockKey: op.lockKey,
          resourceType: op.resourceType,
          resourceId: op.resourceId,
        },
      })
      .returning();

    return {
      operation: updatedOp!,
      auditEvent: auditEvent!,
    };
  });
}

// Encrypted Secrets Repository (AES-256-GCM + AAD, write-only metadata DTOs)
export interface UpsertEncryptedSecretInputRepo {
  readonly organizationId: string;
  readonly siteId?: string | null;
  readonly secretKey: string;
  readonly value?: string;
  readonly plaintextValue?: string;
  readonly masterKey: string | Buffer | Uint8Array;
  readonly keyVersion?: string;
  readonly actorId?: string | null;
}

function toSecretMetadataDto(row: {
  id: string;
  organizationId: string;
  siteId: string | null;
  secretKey: string;
  keyVersion: string;
  version: number;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): EncryptedSecretMetadataDto {
  return Object.freeze({
    id: row.id,
    organizationId: row.organizationId,
    siteId: row.siteId,
    secretKey: row.secretKey,
    keyVersion: row.keyVersion,
    version: row.version,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

export async function upsertEncryptedSecretTransactional(
  db: HostingPanelDatabase,
  input: UpsertEncryptedSecretInputRepo,
): Promise<EncryptedSecretMetadataDto> {
  if (!SECRET_KEY_PATTERN.test(input.secretKey)) {
    throw createRepoError(
      `Invalid secretKey '${input.secretKey}': must match ${String(SECRET_KEY_PATTERN)}`,
      "VALIDATION_ERROR",
    );
  }

  const plaintext = input.value ?? input.plaintextValue ?? "";
  if (plaintext.length < 1 || plaintext.length > 16384) {
    throw createRepoError(
      "Secret value must be between 1 and 16384 characters",
      "VALIDATION_ERROR",
    );
  }

  const normalizedSiteId = input.siteId && input.siteId.trim().length > 0 ? input.siteId : null;

  return db.transaction(async (tx) => {
    if (normalizedSiteId !== null) {
      const siteRows = await tx
        .select({ id: sites.id })
        .from(sites)
        .where(
          and(
            eq(sites.id, normalizedSiteId),
            eq(sites.organizationId, input.organizationId),
          ),
        );

      if (!siteRows[0]) {
        throw createRepoError(
          `Site '${normalizedSiteId}' not found in organization '${input.organizationId}'`,
          "NOT_FOUND",
        );
      }
    }

    const envelope = encryptSecretAesGcm({
      plaintext,
      masterKey: input.masterKey,
      organizationId: input.organizationId,
      siteId: normalizedSiteId,
      secretKey: input.secretKey,
      keyVersion: input.keyVersion,
    });

    const scopeCondition =
      normalizedSiteId === null
        ? and(
            eq(encryptedSecrets.organizationId, input.organizationId),
            isNull(encryptedSecrets.siteId),
            eq(encryptedSecrets.secretKey, input.secretKey),
          )
        : and(
            eq(encryptedSecrets.organizationId, input.organizationId),
            eq(encryptedSecrets.siteId, normalizedSiteId),
            eq(encryptedSecrets.secretKey, input.secretKey),
          );

    const existingRows = await tx
      .select()
      .from(encryptedSecrets)
      .where(scopeCondition)
      .for("update");

    const now = new Date();
    const existing = existingRows[0];

    if (existing) {
      const nextVersion = existing.version + 1;
      const [updated] = await tx
        .update(encryptedSecrets)
        .set({
          ciphertextBase64: envelope.ciphertextBase64,
          ivBase64: envelope.ivBase64,
          authTagBase64: envelope.authTagBase64,
          keyVersion: envelope.keyVersion,
          version: nextVersion,
          updatedAt: now,
        })
        .where(eq(encryptedSecrets.id, existing.id))
        .returning();

      await tx.insert(auditEvents).values({
        id: generatePrefixedId("aud"),
        actorId: input.actorId ?? null,
        actorType: input.actorId ? "user" : "system",
        organizationId: input.organizationId,
        action: "secret.rotate",
        targetType: "encrypted_secret",
        targetId: existing.id,
        details: {
          secretKey: input.secretKey,
          siteId: normalizedSiteId,
          version: nextVersion,
          keyVersion: envelope.keyVersion,
        },
      });

      return toSecretMetadataDto(updated!);
    }

    const secretId = generatePrefixedId("sec");
    const [inserted] = await tx
      .insert(encryptedSecrets)
      .values({
        id: secretId,
        organizationId: input.organizationId,
        siteId: normalizedSiteId,
        secretKey: input.secretKey,
        ciphertextBase64: envelope.ciphertextBase64,
        ivBase64: envelope.ivBase64,
        authTagBase64: envelope.authTagBase64,
        keyVersion: envelope.keyVersion,
        version: 1,
        createdByUserId: input.actorId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    await tx.insert(auditEvents).values({
      id: generatePrefixedId("aud"),
      actorId: input.actorId ?? null,
      actorType: input.actorId ? "user" : "system",
      organizationId: input.organizationId,
      action: "secret.create",
      targetType: "encrypted_secret",
      targetId: secretId,
      details: {
        secretKey: input.secretKey,
        siteId: normalizedSiteId,
        version: 1,
        keyVersion: envelope.keyVersion,
      },
    });

    return toSecretMetadataDto(inserted!);
  });
}

export interface ListEncryptedSecretsMetadataInput {
  readonly organizationId: string;
  readonly siteId?: string | null;
  readonly includeOrganizationScope?: boolean;
}

export async function listEncryptedSecretsMetadata(
  executor: DatabaseExecutor,
  input: ListEncryptedSecretsMetadataInput,
): Promise<EncryptedSecretMetadataDto[]> {
  let whereClause = eq(encryptedSecrets.organizationId, input.organizationId);

  if (input.siteId !== undefined) {
    if (input.siteId === null) {
      whereClause = and(
        eq(encryptedSecrets.organizationId, input.organizationId),
        isNull(encryptedSecrets.siteId),
      )!;
    } else if (input.includeOrganizationScope) {
      whereClause = and(
        eq(encryptedSecrets.organizationId, input.organizationId),
        or(eq(encryptedSecrets.siteId, input.siteId), isNull(encryptedSecrets.siteId)),
      )!;
    } else {
      whereClause = and(
        eq(encryptedSecrets.organizationId, input.organizationId),
        eq(encryptedSecrets.siteId, input.siteId),
      )!;
    }
  }

  const rows = await executor
    .select({
      id: encryptedSecrets.id,
      organizationId: encryptedSecrets.organizationId,
      siteId: encryptedSecrets.siteId,
      secretKey: encryptedSecrets.secretKey,
      keyVersion: encryptedSecrets.keyVersion,
      version: encryptedSecrets.version,
      createdByUserId: encryptedSecrets.createdByUserId,
      createdAt: encryptedSecrets.createdAt,
      updatedAt: encryptedSecrets.updatedAt,
    })
    .from(encryptedSecrets)
    .where(whereClause)
    .orderBy(asc(encryptedSecrets.secretKey), asc(encryptedSecrets.id));

  return rows.map((row) => toSecretMetadataDto(row));
}

export interface DeleteEncryptedSecretInput {
  readonly organizationId: string;
  readonly secretId: string;
  readonly actorId?: string | null;
}

export async function deleteEncryptedSecretTransactional(
  db: HostingPanelDatabase,
  input: DeleteEncryptedSecretInput,
) {
  return db.transaction(async (tx) => {
    const deletedRows = await tx
      .delete(encryptedSecrets)
      .where(
        and(
          eq(encryptedSecrets.id, input.secretId),
          eq(encryptedSecrets.organizationId, input.organizationId),
        ),
      )
      .returning({
        id: encryptedSecrets.id,
        secretKey: encryptedSecrets.secretKey,
        siteId: encryptedSecrets.siteId,
      });

    const deleted = deletedRows[0];
    if (!deleted) {
      throw createRepoError(
        `Encrypted secret '${input.secretId}' not found`,
        "NOT_FOUND",
      );
    }

    await tx.insert(auditEvents).values({
      id: generatePrefixedId("aud"),
      actorId: input.actorId ?? null,
      actorType: input.actorId ? "user" : "system",
      organizationId: input.organizationId,
      action: "secret.delete",
      targetType: "encrypted_secret",
      targetId: deleted.id,
      details: {
        secretKey: deleted.secretKey,
        siteId: deleted.siteId,
      },
    });

    return { deletedId: deleted.id };
  });
}

export interface ResolveDecryptedSecretRefsInput {
  readonly organizationId: string;
  readonly siteId?: string | null;
  readonly secretRefs: Readonly<Record<string, string>>;
  readonly masterKey: string | Buffer | Uint8Array;
}

export async function resolveDecryptedSecretRefs(
  executor: DatabaseExecutor,
  input: ResolveDecryptedSecretRefsInput,
): Promise<Readonly<Record<string, string>>> {
  const entries = Object.entries(input.secretRefs);
  if (entries.length === 0) {
    return Object.freeze({});
  }

  for (const [envVarName] of entries) {
    if (!SECRET_KEY_PATTERN.test(envVarName)) {
      throw createRepoError(
        `Invalid secret target environment key '${envVarName}'`,
        "VALIDATION_ERROR",
      );
    }
  }

  const normalizedSiteId = input.siteId && input.siteId.trim().length > 0 ? input.siteId : null;
  const scopeFilter =
    normalizedSiteId === null
      ? and(
          eq(encryptedSecrets.organizationId, input.organizationId),
          isNull(encryptedSecrets.siteId),
        )
      : and(
          eq(encryptedSecrets.organizationId, input.organizationId),
          or(eq(encryptedSecrets.siteId, normalizedSiteId), isNull(encryptedSecrets.siteId)),
        );

  const scopedRows = await executor.select().from(encryptedSecrets).where(scopeFilter);

  const byId = new Map(scopedRows.map((row) => [row.id, row]));
  const bySiteKey = new Map<string, (typeof scopedRows)[number]>();
  const byOrgKey = new Map<string, (typeof scopedRows)[number]>();

  for (const row of scopedRows) {
    if (row.siteId !== null) {
      bySiteKey.set(row.secretKey, row);
    } else {
      byOrgKey.set(row.secretKey, row);
    }
  }

  const resolved: Record<string, string> = {};
  for (const [envVarName, ref] of entries) {
    const matched =
      byId.get(ref) ??
      bySiteKey.get(ref) ??
      byOrgKey.get(ref) ??
      (ref.startsWith("vault://")
        ? (bySiteKey.get(envVarName) ?? byOrgKey.get(envVarName))
        : undefined);
    if (!matched) {
      throw createRepoError(
        `Referenced secret '${ref}' for '${envVarName}' not found in tenant/site scope`,
        "NOT_FOUND",
      );
    }

    resolved[envVarName] = decryptSecretAesGcm({
      ciphertextBase64: matched.ciphertextBase64,
      ivBase64: matched.ivBase64,
      authTagBase64: matched.authTagBase64,
      masterKey: input.masterKey,
      organizationId: matched.organizationId,
      siteId: matched.siteId,
      secretKey: matched.secretKey,
    });
  }

  return Object.freeze(resolved);
}

// Host Agent Heartbeats
export interface UpsertHostAgentHeartbeatInput {
  readonly hostId: string;
  readonly component: HostDaemonComponent;
  readonly status: HostDaemonStatus;
  readonly version: string;
  readonly telemetrySnapshot?: Record<string, unknown>;
  readonly lastSeenAt?: Date;
}

function toHeartbeatDto(row: {
  hostId: string;
  component: HostDaemonComponent;
  status: HostDaemonStatus;
  version: string;
  lastSeenAt: Date;
  telemetrySnapshot: unknown;
}): HostDaemonHeartbeatDto {
  return Object.freeze({
    hostId: row.hostId,
    component: row.component,
    status: row.status,
    version: row.version,
    lastSeenAt: row.lastSeenAt.toISOString(),
    telemetrySnapshot: (row.telemetrySnapshot ?? {}) as Record<string, unknown>,
  });
}

export async function upsertHostAgentHeartbeat(
  executor: DatabaseExecutor,
  input: UpsertHostAgentHeartbeatInput,
): Promise<HostDaemonHeartbeatDto> {
  const hostRows = await executor
    .select({ id: hosts.id })
    .from(hosts)
    .where(eq(hosts.id, input.hostId));

  if (!hostRows[0]) {
    throw createRepoError(`Host '${input.hostId}' not found`, "NOT_FOUND");
  }

  const now = new Date();
  const lastSeenAt = input.lastSeenAt ?? now;
  const sanitizedSnapshot = redactSensitiveValue(input.telemetrySnapshot ?? {});

  const [upserted] = await executor
    .insert(hostAgentHeartbeats)
    .values({
      id: generatePrefixedId("hb"),
      hostId: input.hostId,
      component: input.component,
      status: input.status,
      version: input.version,
      lastSeenAt,
      telemetrySnapshot: sanitizedSnapshot,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [hostAgentHeartbeats.hostId, hostAgentHeartbeats.component],
      set: {
        status: input.status,
        version: input.version,
        lastSeenAt,
        telemetrySnapshot: sanitizedSnapshot,
        updatedAt: now,
      },
    })
    .returning();

  return toHeartbeatDto(upserted!);
}

export async function listHostAgentHeartbeats(
  executor: DatabaseExecutor,
  hostId?: string,
): Promise<HostDaemonHeartbeatDto[]> {
  const query = hostId
    ? executor
        .select()
        .from(hostAgentHeartbeats)
        .where(eq(hostAgentHeartbeats.hostId, hostId))
        .orderBy(asc(hostAgentHeartbeats.component))
    : executor
        .select()
        .from(hostAgentHeartbeats)
        .orderBy(asc(hostAgentHeartbeats.hostId), asc(hostAgentHeartbeats.component));

  const rows = await query;
  return rows.map((row) => toHeartbeatDto(row));
}

// Observe-Only Drift Reconciliation (HCP-SPEC-003 §7.3 & AC-F2-08)
export interface RecordObservedStateReconciliationInput {
  readonly serviceInstanceId: string;
  readonly observedStatus: string;
  readonly observedRevisionHash?: string | null;
  readonly outOfBandModified?: boolean;
  readonly rawState?: Record<string, unknown>;
  readonly observedAt?: Date;
}

export async function recordObservedStateReconciliationTransactional(
  db: HostingPanelDatabase,
  input: RecordObservedStateReconciliationInput,
): Promise<{
  readonly observedState: typeof observedStates.$inferSelect;
  readonly drift: DriftEvaluationResult;
  readonly newlyDrifted: boolean;
  readonly auditEvent: typeof auditEvents.$inferSelect | null;
}> {
  return db.transaction(async (tx) => {
    const svcRows = await tx
      .select()
      .from(serviceInstances)
      .where(eq(serviceInstances.id, input.serviceInstanceId));

    const service = svcRows[0];
    if (!service) {
      throw createRepoError(
        `Service instance '${input.serviceInstanceId}' not found`,
        "NOT_FOUND",
      );
    }

    let desiredSpecHash: string;
    if (service.currentRevisionId) {
      const revRows = await tx
        .select({ specHash: stackRevisions.specHash })
        .from(stackRevisions)
        .where(eq(stackRevisions.id, service.currentRevisionId));
      desiredSpecHash = revRows[0]?.specHash ?? "";
    } else {
      const latestRevRows = await tx
        .select({ specHash: stackRevisions.specHash })
        .from(stackRevisions)
        .where(eq(stackRevisions.serviceInstanceId, service.id))
        .orderBy(desc(stackRevisions.revisionNumber))
        .limit(1);
      desiredSpecHash = latestRevRows[0]?.specHash ?? "";
    }

    const existingObsRows = await tx
      .select()
      .from(observedStates)
      .where(eq(observedStates.serviceInstanceId, service.id))
      .for("update");

    const existingObs = existingObsRows[0];
    const observedAt = input.observedAt ?? new Date();

    const previousDrift: DriftEvaluationResult = existingObs
      ? evaluateServiceDrift(
          service.desiredStatus,
          desiredSpecHash,
          {
            observedStatus: existingObs.observedStatus,
            observedRevisionHash: existingObs.observedRevisionHash,
            outOfBandModified: existingObs.outOfBandModified,
            observedAt: existingObs.observedAt,
          },
          { now: observedAt },
        )
      : {
          driftStatus: "unknown",
          stale: true,
          requiresOperatorReview: false,
          reason: "NO_OBSERVED_STATE",
        };

    const normalizedObservedHash = input.observedRevisionHash ?? null;
    const effectiveOutOfBand =
      Boolean(input.outOfBandModified) ||
      (input.observedStatus === "running" &&
        desiredSpecHash.length > 0 &&
        normalizedObservedHash === null);

    const nextDrift = evaluateServiceDrift(
      service.desiredStatus,
      desiredSpecHash,
      {
        observedStatus: input.observedStatus,
        observedRevisionHash: normalizedObservedHash,
        outOfBandModified: effectiveOutOfBand,
        observedAt,
      },
      { now: observedAt },
    );

    const sanitizedRawState = redactSensitiveValue(input.rawState ?? {});
    const now = new Date();

    let savedObserved: typeof observedStates.$inferSelect;
    if (existingObs) {
      const [updated] = await tx
        .update(observedStates)
        .set({
          observedStatus: input.observedStatus,
          observedRevisionHash: normalizedObservedHash,
          outOfBandModified: effectiveOutOfBand,
          rawState: sanitizedRawState,
          observedAt,
          updatedAt: now,
        })
        .where(eq(observedStates.id, existingObs.id))
        .returning();
      savedObserved = updated!;
    } else {
      const [inserted] = await tx
        .insert(observedStates)
        .values({
          id: generatePrefixedId("obs"),
          serviceInstanceId: service.id,
          observedStatus: input.observedStatus,
          observedRevisionHash: normalizedObservedHash,
          outOfBandModified: effectiveOutOfBand,
          rawState: sanitizedRawState,
          observedAt,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      savedObserved = inserted!;
    }

    const newlyDrifted =
      nextDrift.driftStatus === "drifted" && previousDrift.driftStatus !== "drifted";

    let auditEvent: typeof auditEvents.$inferSelect | null = null;
    if (newlyDrifted) {
      const [insertedAudit] = await tx
        .insert(auditEvents)
        .values({
          id: generatePrefixedId("aud"),
          actorId: null,
          actorType: "system",
          organizationId: service.organizationId,
          action: "service.drift.detected",
          targetType: "service_instance",
          targetId: service.id,
          details: {
            siteId: service.siteId,
            desiredStatus: service.desiredStatus,
            observedStatus: input.observedStatus,
            desiredSpecHash,
            observedRevisionHash: normalizedObservedHash,
            outOfBandModified: effectiveOutOfBand,
            reason: nextDrift.reason,
          },
        })
        .returning();
      auditEvent = insertedAudit ?? null;
    }

    return {
      observedState: savedObserved,
      drift: nextDrift,
      newlyDrifted,
      auditEvent,
    };
  });
}
