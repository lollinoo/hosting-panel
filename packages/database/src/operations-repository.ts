import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  type AuditEventDto,
  type AuditEventOutcome,
  type AuditMetadata,
  AuditMetadataSchema,
  canTransitionOperation,
  type ErrorCode,
  isTerminalOperationStatus,
  type OperationDto,
  type OperationKind,
  type OperationResourceType,
  type OperationStatus,
  type OperationStepStatus,
} from "@hosting-panel/contracts";
import type { DatabaseExecutor, HostingPanelDatabase } from "./client.js";
import {
  type AuditEventRow,
  auditEvents,
  hostingResources,
  type OperationRow,
  type OperationStepRow,
  operationSteps,
  operations,
  type OutboxEventRow,
  outboxEvents,
} from "./schema.js";

function generatePrefixedId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

function canonicalizeJsonValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }

  if (typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }

  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }

  if (Array.isArray(value)) {
    const serializedItems = value.map((item) => canonicalizeJsonValue(item));
    return `[${serializedItems.join(",")}]`;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sortedKeys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    const entries = sortedKeys.map(
      (key) => `${JSON.stringify(key)}:${canonicalizeJsonValue(record[key])}`,
    );
    return `{${entries.join(",")}}`;
  }

  return JSON.stringify(String(value));
}

export function computeRequestHash(payload: unknown): string {
  const normalizedPayload = payload === undefined ? {} : payload;
  const canonicalJson = canonicalizeJsonValue(normalizedPayload);
  return createHash("sha256").update(canonicalJson, "utf8").digest("hex");
}

export interface OperationWithSteps extends OperationRow {
  readonly steps: readonly OperationStepRow[];
}

export function mapOperationToDto(operation: OperationWithSteps): OperationDto {
  return {
    id: operation.id,
    organizationId: operation.organizationId,
    kind: operation.kind,
    status: operation.status,
    resourceType: operation.resourceType,
    resourceId: operation.resourceId,
    requestedByUserId: operation.requestedByUserId,
    errorCode: operation.errorCode,
    errorMessage: operation.errorMessage,
    submittedAt: operation.submittedAt.toISOString(),
    startedAt: operation.startedAt ? operation.startedAt.toISOString() : null,
    completedAt: operation.completedAt ? operation.completedAt.toISOString() : null,
    updatedAt: operation.updatedAt.toISOString(),
    steps: operation.steps.map((step) => ({
      id: step.id,
      key: step.key,
      label: step.label,
      status: step.status,
      message: step.message,
      startedAt: step.startedAt ? step.startedAt.toISOString() : null,
      completedAt: step.completedAt ? step.completedAt.toISOString() : null,
    })),
  };
}

export function mapAuditEventToDto(row: AuditEventRow): AuditEventDto {
  return {
    id: row.id,
    organizationId: row.organizationId,
    actorUserId: row.actorUserId,
    actorEmail: row.actorEmail,
    impersonatedByUserId: row.impersonatedByUserId,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    outcome: row.outcome,
    requestId: row.requestId,
    ipAddress: row.ipAddress,
    metadata: AuditMetadataSchema.parse(row.metadataJson),
    occurredAt: row.occurredAt.toISOString(),
  };
}

export interface AppendAuditEventInput {
  readonly id?: string;
  readonly organizationId: string | null;
  readonly actorUserId: string | null;
  readonly actorEmail?: string | null;
  readonly impersonatedByUserId?: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly outcome: AuditEventOutcome;
  readonly requestId: string;
  readonly ipAddress?: string | null;
  readonly metadata?: AuditMetadata;
  readonly occurredAt?: Date;
}

export async function appendAuditEvent(
  db: DatabaseExecutor,
  input: AppendAuditEventInput,
): Promise<AuditEventRow> {
  const validatedMetadata = AuditMetadataSchema.parse(input.metadata ?? {});
  const [inserted] = await db
    .insert(auditEvents)
    .values({
      id: input.id ?? generatePrefixedId("aud"),
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      actorEmail: input.actorEmail ?? null,
      impersonatedByUserId: input.impersonatedByUserId ?? null,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      outcome: input.outcome,
      requestId: input.requestId,
      ipAddress: input.ipAddress ?? null,
      metadataJson: validatedMetadata,
      occurredAt: input.occurredAt ?? new Date(),
    })
    .returning();

  if (!inserted) {
    throw new Error("Failed to insert audit event row.");
  }

  return inserted;
}

async function loadStepsForOperation(
  db: DatabaseExecutor,
  operationId: string,
): Promise<OperationStepRow[]> {
  return db
    .select()
    .from(operationSteps)
    .where(eq(operationSteps.operationId, operationId))
    .orderBy(asc(operationSteps.stepOrder), asc(operationSteps.id));
}

export async function getOperationWithSteps(
  db: DatabaseExecutor,
  organizationId: string,
  operationId: string,
): Promise<OperationWithSteps | null> {
  const [operation] = await db
    .select()
    .from(operations)
    .where(and(eq(operations.id, operationId), eq(operations.organizationId, organizationId)))
    .limit(1);

  if (!operation) {
    return null;
  }

  const steps = await loadStepsForOperation(db, operation.id);
  return {
    ...operation,
    steps,
  };
}

export interface EnqueueOperationInput {
  readonly operationId?: string;
  readonly organizationId: string;
  readonly resourceType: OperationResourceType;
  readonly resourceId: string;
  readonly kind: OperationKind;
  readonly requestedByUserId: string | null;
  readonly actorEmail?: string | null;
  readonly impersonatedByUserId?: string | null;
  readonly idempotencyKey: string;
  readonly payload?: Record<string, unknown>;
  readonly requestId?: string;
  readonly ipAddress?: string | null;
  readonly eventType?: string;
  readonly auditMetadata?: AuditMetadata;
  readonly now?: Date;
}

export type EnqueueOperationResult =
  | {
      readonly ok: true;
      readonly deduplicated: false;
      readonly operation: OperationWithSteps;
      readonly outboxEventId: string;
    }
  | {
      readonly ok: true;
      readonly deduplicated: true;
      readonly operation: OperationWithSteps;
    }
  | {
      readonly ok: false;
      readonly deduplicated: false;
      readonly errorCode: "IDEMPOTENCY_CONFLICT" | "RESOURCE_LOCKED" | "NOT_FOUND";
      readonly message: string;
      readonly conflictingOperationId?: string;
    };

function requiresHostingResourceLock(resourceType: OperationResourceType): boolean {
  return resourceType === "application" || resourceType === "database";
}

export async function enqueueOperationTransactional(
  db: HostingPanelDatabase,
  input: EnqueueOperationInput,
): Promise<EnqueueOperationResult> {
  const payload = input.payload ?? {};
  const requestHash = computeRequestHash(payload);
  const now = input.now ?? new Date();
  const requestId = input.requestId ?? generatePrefixedId("req");
  const validatedAuditMetadata = AuditMetadataSchema.parse(
    input.auditMetadata ?? {
      kind: input.kind,
      resourceType: input.resourceType,
    },
  );

  return db.transaction(async (tx): Promise<EnqueueOperationResult> => {
    const [existing] = await tx
      .select()
      .from(operations)
      .where(
        and(
          eq(operations.organizationId, input.organizationId),
          eq(operations.kind, input.kind),
          eq(operations.idempotencyKey, input.idempotencyKey),
        ),
      )
      .for("update");

    if (existing) {
      if (existing.requestHash === requestHash) {
        const existingSteps = await loadStepsForOperation(tx, existing.id);
        return {
          ok: true,
          deduplicated: true,
          operation: {
            ...existing,
            steps: existingSteps,
          },
        };
      }

      return {
        ok: false,
        deduplicated: false,
        errorCode: "IDEMPOTENCY_CONFLICT",
        message:
          "Idempotency-Key has already been used for this operation kind with a different request payload.",
        conflictingOperationId: existing.id,
      };
    }

    const shouldLockResource = requiresHostingResourceLock(input.resourceType);

    if (shouldLockResource) {
      const [resource] = await tx
        .select()
        .from(hostingResources)
        .where(
          and(
            eq(hostingResources.id, input.resourceId),
            eq(hostingResources.organizationId, input.organizationId),
          ),
        )
        .for("update");

      if (!resource) {
        return {
          ok: false,
          deduplicated: false,
          errorCode: "NOT_FOUND",
          message: `Target ${input.resourceType} '${input.resourceId}' was not found in organization '${input.organizationId}'.`,
        };
      }

      if (resource.lockedByOperationId !== null) {
        return {
          ok: false,
          deduplicated: false,
          errorCode: "RESOURCE_LOCKED",
          message: `Resource '${input.resourceId}' is currently locked by active operation '${resource.lockedByOperationId}'.`,
          conflictingOperationId: resource.lockedByOperationId,
        };
      }
    }

    const operationId = input.operationId ?? generatePrefixedId("op");

    const [insertedOperation] = await tx
      .insert(operations)
      .values({
        id: operationId,
        organizationId: input.organizationId,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        kind: input.kind,
        status: "queued",
        requestedByUserId: input.requestedByUserId,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        payloadJson: payload,
        providerOperationId: null,
        errorCode: null,
        errorMessage: null,
        submittedAt: now,
        startedAt: null,
        completedAt: null,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [operations.organizationId, operations.kind, operations.idempotencyKey],
      })
      .returning();

    if (!insertedOperation) {
      const [racedExisting] = await tx
        .select()
        .from(operations)
        .where(
          and(
            eq(operations.organizationId, input.organizationId),
            eq(operations.kind, input.kind),
            eq(operations.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);

      if (racedExisting && racedExisting.requestHash === requestHash) {
        const steps = await loadStepsForOperation(tx, racedExisting.id);
        return {
          ok: true,
          deduplicated: true,
          operation: {
            ...racedExisting,
            steps,
          },
        };
      }

      return {
        ok: false,
        deduplicated: false,
        errorCode: "IDEMPOTENCY_CONFLICT",
        message:
          "Idempotency-Key has already been used for this operation kind with a different request payload.",
        ...(racedExisting ? { conflictingOperationId: racedExisting.id } : {}),
      };
    }

    const insertedSteps = await tx
      .insert(operationSteps)
      .values([
        {
          id: generatePrefixedId("step"),
          operationId,
          stepOrder: 1,
          key: "queued",
          label: "Operazione accodata",
          status: "succeeded",
          message: "Richiesta registrata nella coda transazionale.",
          startedAt: now,
          completedAt: now,
        },
        {
          id: generatePrefixedId("step"),
          operationId,
          stepOrder: 2,
          key: "provider_dispatch",
          label: "Invio al provider",
          status: "pending",
          message: null,
          startedAt: null,
          completedAt: null,
        },
        {
          id: generatePrefixedId("step"),
          operationId,
          stepOrder: 3,
          key: "reconcile_health",
          label: "Verifica stato e salute",
          status: "pending",
          message: null,
          startedAt: null,
          completedAt: null,
        },
      ])
      .returning();

    const outboxEventId = generatePrefixedId("out");
    await tx.insert(outboxEvents).values({
      id: outboxEventId,
      organizationId: input.organizationId,
      operationId,
      eventType: input.eventType ?? input.kind,
      payloadJson: {
        operationId,
        organizationId: input.organizationId,
        kind: input.kind,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        payload,
      },
      publishedAt: null,
      attempts: 0,
      createdAt: now,
    });

    if (shouldLockResource) {
      await tx
        .update(hostingResources)
        .set({
          lockedByOperationId: operationId,
          updatedAt: now,
        })
        .where(
          and(
            eq(hostingResources.id, input.resourceId),
            eq(hostingResources.organizationId, input.organizationId),
          ),
        );
    }

    await appendAuditEvent(tx, {
      organizationId: input.organizationId,
      actorUserId: input.requestedByUserId,
      actorEmail: input.actorEmail ?? null,
      impersonatedByUserId: input.impersonatedByUserId ?? null,
      action: input.kind,
      targetType: input.resourceType,
      targetId: input.resourceId,
      outcome: "allowed",
      requestId,
      ipAddress: input.ipAddress ?? null,
      metadata: validatedAuditMetadata,
      occurredAt: now,
    });

    const sortedSteps = [...insertedSteps].sort((a, b) => a.stepOrder - b.stepOrder);

    return {
      ok: true,
      deduplicated: false,
      operation: {
        ...insertedOperation,
        steps: sortedSteps,
      },
      outboxEventId,
    };
  });
}

export async function claimPendingOutboxEvents(
  db: HostingPanelDatabase,
  limit = 10,
  now: Date = new Date(),
): Promise<OutboxEventRow[]> {
  if (limit <= 0) {
    return [];
  }

  return db.transaction(async (tx) => {
    const pending = await tx
      .select({ id: outboxEvents.id })
      .from(outboxEvents)
      .where(isNull(outboxEvents.publishedAt))
      .orderBy(asc(outboxEvents.createdAt), asc(outboxEvents.id))
      .limit(limit)
      .for("update", { skipLocked: true });

    if (pending.length === 0) {
      return [];
    }

    const pendingIds = pending.map((row) => row.id);
    const claimed = await tx
      .update(outboxEvents)
      .set({
        publishedAt: now,
        attempts: sql`${outboxEvents.attempts} + 1`,
      })
      .where(inArray(outboxEvents.id, pendingIds))
      .returning();

    const orderIndex = new Map(pendingIds.map((id, idx) => [id, idx]));
    return [...claimed].sort(
      (left, right) => (orderIndex.get(left.id) ?? 0) - (orderIndex.get(right.id) ?? 0),
    );
  });
}

export async function requeueOutboxEvent(
  db: DatabaseExecutor,
  outboxEventId: string,
): Promise<void> {
  await db
    .update(outboxEvents)
    .set({ publishedAt: null })
    .where(eq(outboxEvents.id, outboxEventId));
}

export class OperationNotFoundError extends Error {
  public readonly code = "NOT_FOUND" as const;
  public readonly operationId: string;

  constructor(operationId: string) {
    super(`Operation '${operationId}' was not found.`);
    this.name = "OperationNotFoundError";
    this.operationId = operationId;
  }
}

export class InvalidOperationTransitionError extends Error {
  public readonly code = "INVALID_OPERATION_TRANSITION" as const;
  public readonly operationId: string;
  public readonly fromStatus: OperationStatus;
  public readonly toStatus: OperationStatus;

  constructor(operationId: string, fromStatus: OperationStatus, toStatus: OperationStatus) {
    super(
      `Invalid operation state transition for '${operationId}': '${fromStatus}' -> '${toStatus}'.`,
    );
    this.name = "InvalidOperationTransitionError";
    this.operationId = operationId;
    this.fromStatus = fromStatus;
    this.toStatus = toStatus;
  }
}

export interface OperationStepUpdateInput {
  readonly key: string;
  readonly label?: string;
  readonly status: OperationStepStatus;
  readonly message?: string | null;
  readonly startedAt?: Date | null;
  readonly completedAt?: Date | null;
}

export interface TransitionOperationInput {
  readonly operationId: string;
  readonly organizationId?: string;
  readonly toStatus: OperationStatus;
  readonly providerOperationId?: string | null;
  readonly errorCode?: ErrorCode | null;
  readonly errorMessage?: string | null;
  readonly step?: OperationStepUpdateInput;
  readonly steps?: readonly OperationStepUpdateInput[];
  readonly now?: Date;
}

function isTerminalStepStatus(status: OperationStepStatus): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "skipped"
  );
}

export async function transitionOperation(
  db: HostingPanelDatabase,
  input: TransitionOperationInput,
): Promise<OperationWithSteps> {
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    const whereClause = input.organizationId
      ? and(
          eq(operations.id, input.operationId),
          eq(operations.organizationId, input.organizationId),
        )
      : eq(operations.id, input.operationId);

    const [current] = await tx.select().from(operations).where(whereClause).for("update");

    if (!current) {
      throw new OperationNotFoundError(input.operationId);
    }

    if (!canTransitionOperation(current.status, input.toStatus)) {
      throw new InvalidOperationTransitionError(current.id, current.status, input.toStatus);
    }

    const enteringTerminal = isTerminalOperationStatus(input.toStatus);
    const nextStartedAt =
      current.startedAt ?? (input.toStatus !== "queued" ? now : null);
    const nextCompletedAt = enteringTerminal ? now : current.completedAt;

    const [updatedOperation] = await tx
      .update(operations)
      .set({
        status: input.toStatus,
        providerOperationId:
          input.providerOperationId !== undefined
            ? input.providerOperationId
            : current.providerOperationId,
        errorCode: input.errorCode !== undefined ? input.errorCode : current.errorCode,
        errorMessage:
          input.errorMessage !== undefined ? input.errorMessage : current.errorMessage,
        startedAt: nextStartedAt,
        completedAt: nextCompletedAt,
        updatedAt: now,
      })
      .where(eq(operations.id, current.id))
      .returning();

    if (!updatedOperation) {
      throw new OperationNotFoundError(current.id);
    }

    const stepUpdates: OperationStepUpdateInput[] = [
      ...(input.step ? [input.step] : []),
      ...(input.steps ?? []),
    ];

    if (stepUpdates.length > 0) {
      const existingSteps = await loadStepsForOperation(tx, current.id);
      const byKey = new Map(existingSteps.map((step) => [step.key, step]));
      let maxStepOrder = existingSteps.reduce(
        (max, step) => (step.stepOrder > max ? step.stepOrder : max),
        0,
      );

      for (const stepUpdate of stepUpdates) {
        const existingStep = byKey.get(stepUpdate.key);

        if (existingStep) {
          const startedAt =
            stepUpdate.startedAt !== undefined
              ? stepUpdate.startedAt
              : existingStep.startedAt ??
                (stepUpdate.status !== "pending" ? now : null);
          const completedAt =
            stepUpdate.completedAt !== undefined
              ? stepUpdate.completedAt
              : isTerminalStepStatus(stepUpdate.status)
                ? now
                : existingStep.completedAt;

          const [updatedStep] = await tx
            .update(operationSteps)
            .set({
              label: stepUpdate.label ?? existingStep.label,
              status: stepUpdate.status,
              message:
                stepUpdate.message !== undefined ? stepUpdate.message : existingStep.message,
              startedAt,
              completedAt,
            })
            .where(eq(operationSteps.id, existingStep.id))
            .returning();

          if (updatedStep) {
            byKey.set(updatedStep.key, updatedStep);
          }
        } else {
          maxStepOrder += 1;
          const startedAt =
            stepUpdate.startedAt !== undefined
              ? stepUpdate.startedAt
              : stepUpdate.status !== "pending"
                ? now
                : null;
          const completedAt =
            stepUpdate.completedAt !== undefined
              ? stepUpdate.completedAt
              : isTerminalStepStatus(stepUpdate.status)
                ? now
                : null;

          const [insertedStep] = await tx
            .insert(operationSteps)
            .values({
              id: generatePrefixedId("step"),
              operationId: current.id,
              stepOrder: maxStepOrder,
              key: stepUpdate.key,
              label: stepUpdate.label ?? stepUpdate.key,
              status: stepUpdate.status,
              message: stepUpdate.message ?? null,
              startedAt,
              completedAt,
            })
            .returning();

          if (insertedStep) {
            byKey.set(insertedStep.key, insertedStep);
          }
        }
      }
    }

    if (enteringTerminal && requiresHostingResourceLock(current.resourceType)) {
      await tx
        .update(hostingResources)
        .set({
          lockedByOperationId: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(hostingResources.id, current.resourceId),
            eq(hostingResources.organizationId, current.organizationId),
            eq(hostingResources.lockedByOperationId, current.id),
          ),
        );
    }

    const finalSteps = await loadStepsForOperation(tx, current.id);

    return {
      ...updatedOperation,
      steps: finalSteps,
    };
  });
}
