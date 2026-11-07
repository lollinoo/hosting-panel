import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import {
  canTransitionOperation,
  isTerminalOperationStatus,
  type AuditActorType,
  type ErrorCode,
  type HostingMode,
  type OperationKind,
  type OperationResourceType,
  type OperationStatus,
  type ServiceDesiredStatus,
} from "@hosting-panel/contracts";
import {
  buildImmutableStackRevision,
  rebindDockerResource,
} from "@hosting-panel/hosting-domain";
import {
  evaluateHostAllocationAdmission,
  evaluateQuotaAdmission,
  validateDeclarativeServiceInput,
} from "@hosting-panel/policy-engine";
import type { DatabaseExecutor, HostingPanelDatabase } from "./client.js";
import {
  auditEvents,
  dockerResources,
  domains,
  hostAllocations,
  hosts,
  observedStates,
  operationSteps,
  operations,
  outboxEvents,
  quotaReservations,
  resourceQuotas,
  serviceInstances,
  serviceTemplates,
  sites,
  stackRevisions,
} from "./schema.js";

function generatePrefixedId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

export interface AllocateHostInput {
  readonly hostId: string;
  readonly organizationId: string;
  readonly hostingMode?: HostingMode;
  readonly actorId?: string;
  readonly initialQuotaLimits?: {
    readonly maxSites: number;
    readonly maxServices: number;
    readonly maxCpuMilli: number;
    readonly maxMemoryBytes: string;
    readonly maxStorageBytes: string;
  };
}

export async function allocateHostTransactional(
  db: HostingPanelDatabase,
  input: AllocateHostInput,
) {
  return db.transaction(async (tx) => {
    // Lock host row FOR UPDATE to prevent concurrent races
    const hostRows = await tx
      .select()
      .from(hosts)
      .where(eq(hosts.id, input.hostId))
      .for("update");

    const host = hostRows[0];
    if (!host) {
      const err = new Error(`Host '${input.hostId}' not found`);
      (err as unknown as { code: ErrorCode }).code = "NOT_FOUND";
      throw err;
    }

    // Read existing allocations for this host
    const existing = await tx
      .select()
      .from(hostAllocations)
      .where(eq(hostAllocations.hostId, input.hostId));

    // Enforce AC-F1-01 under concurrency
    const targetMode = input.hostingMode ?? host.hostingMode;
    const admission = evaluateHostAllocationAdmission(
      host,
      input.organizationId,
      existing,
      targetMode,
    );

    if (!admission.admitted) {
      const err = new Error(admission.reason);
      (err as unknown as { code: ErrorCode }).code = admission.errorCode ?? "HOST_POLICY_DENIED";
      throw err;
    }

    const allocationId = generatePrefixedId("alloc");
    const [allocation] = await tx
      .insert(hostAllocations)
      .values({
        id: allocationId,
        hostId: input.hostId,
        organizationId: input.organizationId,
        status: "active",
        hostingMode: targetMode,
        dedicatedScope: targetMode === "dedicated",
      })
      .returning();

    const quotaId = generatePrefixedId("qta");
    const limits = input.initialQuotaLimits ?? {
      maxSites: 10,
      maxServices: 20,
      maxCpuMilli: host.totalCpuMilli,
      maxMemoryBytes: host.totalMemoryBytes,
      maxStorageBytes: host.totalStorageBytes,
    };

    const [quota] = await tx
      .insert(resourceQuotas)
      .values({
        id: quotaId,
        organizationId: input.organizationId,
        hostAllocationId: allocationId,
        maxSites: limits.maxSites,
        maxServices: limits.maxServices,
        maxCpuMilli: limits.maxCpuMilli,
        maxMemoryBytes: limits.maxMemoryBytes,
        maxStorageBytes: limits.maxStorageBytes,
        usedSites: 0,
        usedServices: 0,
        usedCpuMilli: 0,
        usedMemoryBytes: "0",
        usedStorageBytes: "0",
      })
      .returning();

    await tx.insert(auditEvents).values({
      id: generatePrefixedId("aud"),
      actorId: input.actorId ?? null,
      actorType: "user",
      organizationId: input.organizationId,
      action: "allocation.create",
      targetType: "host_allocation",
      targetId: allocationId,
      details: {
        hostId: input.hostId,
        hostingMode: targetMode,
      },
    });

    return { allocation: allocation!, quota: quota! };
  });
}

export interface ReserveQuotaInput {
  readonly organizationId: string;
  readonly resourceQuotaId: string;
  readonly idempotencyKey: string;
  readonly demand: {
    readonly sites?: number;
    readonly services?: number;
    readonly cpuMilli?: number;
    readonly memoryBytes?: string;
    readonly storageBytes?: string;
  };
  readonly ttlSeconds?: number;
  readonly actorId?: string;
}

export async function reserveQuotaTransactional(
  db: HostingPanelDatabase,
  input: ReserveQuotaInput,
) {
  return db.transaction(async (tx) => {
    // Check idempotency key first
    const existingReservations = await tx
      .select()
      .from(quotaReservations)
      .where(eq(quotaReservations.idempotencyKey, input.idempotencyKey));

    if (existingReservations[0]) {
      return { reservation: existingReservations[0], idempotentReplay: true };
    }

    // Lock quota row FOR UPDATE
    const quotaRows = await tx
      .select()
      .from(resourceQuotas)
      .where(
        and(
          eq(resourceQuotas.id, input.resourceQuotaId),
          eq(resourceQuotas.organizationId, input.organizationId),
        ),
      )
      .for("update");

    const quota = quotaRows[0];
    if (!quota) {
      const err = new Error(`Resource quota '${input.resourceQuotaId}' not found`);
      (err as unknown as { code: ErrorCode }).code = "NOT_FOUND";
      throw err;
    }

    // Fetch active pending reservations
    const pending = await tx
      .select()
      .from(quotaReservations)
      .where(
        and(
          eq(quotaReservations.resourceQuotaId, input.resourceQuotaId),
          eq(quotaReservations.status, "pending"),
        ),
      );

    // Enforce AC-F1-07 concurrency check
    const admission = evaluateQuotaAdmission(quota, input.demand, pending);
    if (!admission.admitted) {
      const err = new Error(admission.message);
      (err as unknown as { code: ErrorCode }).code = admission.errorCode ?? "QUOTA_EXCEEDED";
      throw err;
    }

    const reservationId = generatePrefixedId("qres");
    const expiresAt = new Date(Date.now() + (input.ttlSeconds ?? 300) * 1000);

    const [reservation] = await tx
      .insert(quotaReservations)
      .values({
        id: reservationId,
        organizationId: input.organizationId,
        resourceQuotaId: input.resourceQuotaId,
        sites: input.demand.sites ?? 0,
        services: input.demand.services ?? 0,
        cpuMilli: input.demand.cpuMilli ?? 0,
        memoryBytes: input.demand.memoryBytes ?? "0",
        storageBytes: input.demand.storageBytes ?? "0",
        status: "pending",
        idempotencyKey: input.idempotencyKey,
        expiresAt,
      })
      .returning();

    await tx.insert(auditEvents).values({
      id: generatePrefixedId("aud"),
      actorId: input.actorId ?? null,
      actorType: "user",
      organizationId: input.organizationId,
      action: "quota.reserve",
      targetType: "quota_reservation",
      targetId: reservationId,
      details: {
        idempotencyKey: input.idempotencyKey,
        demand: input.demand,
      },
    });

    return { reservation: reservation!, idempotentReplay: false };
  });
}

export async function commitQuotaReservationTransactional(
  db: HostingPanelDatabase,
  reservationId: string,
) {
  return db.transaction(async (tx) => {
    const resRows = await tx
      .select()
      .from(quotaReservations)
      .where(eq(quotaReservations.id, reservationId))
      .for("update");

    const reservation = resRows[0];
    if (!reservation) {
      const err = new Error(`Quota reservation '${reservationId}' not found`);
      (err as unknown as { code: ErrorCode }).code = "NOT_FOUND";
      throw err;
    }

    if (reservation.status === "committed") {
      return { reservation, alreadyCommitted: true };
    }

    const quotaRows = await tx
      .select()
      .from(resourceQuotas)
      .where(eq(resourceQuotas.id, reservation.resourceQuotaId))
      .for("update");

    const quota = quotaRows[0];
    if (!quota) {
      const err = new Error(`Resource quota '${reservation.resourceQuotaId}' not found`);
      (err as unknown as { code: ErrorCode }).code = "NOT_FOUND";
      throw err;
    }

    const updatedSites = quota.usedSites + reservation.sites;
    const updatedServices = quota.usedServices + reservation.services;
    const updatedCpu = quota.usedCpuMilli + reservation.cpuMilli;
    const updatedMemory = (
      BigInt(quota.usedMemoryBytes) + BigInt(reservation.memoryBytes)
    ).toString();
    const updatedStorage = (
      BigInt(quota.usedStorageBytes) + BigInt(reservation.storageBytes)
    ).toString();

    const [updatedQuota] = await tx
      .update(resourceQuotas)
      .set({
        usedSites: updatedSites,
        usedServices: updatedServices,
        usedCpuMilli: updatedCpu,
        usedMemoryBytes: updatedMemory,
        usedStorageBytes: updatedStorage,
        updatedAt: new Date(),
      })
      .where(eq(resourceQuotas.id, quota.id))
      .returning();

    const [committedReservation] = await tx
      .update(quotaReservations)
      .set({
        status: "committed",
      })
      .where(eq(quotaReservations.id, reservationId))
      .returning();

    return { reservation: committedReservation!, quota: updatedQuota!, alreadyCommitted: false };
  });
}

export async function releaseQuotaReservationTransactional(
  db: HostingPanelDatabase,
  reservationId: string,
) {
  return db.transaction(async (tx) => {
    const resRows = await tx
      .select()
      .from(quotaReservations)
      .where(eq(quotaReservations.id, reservationId))
      .for("update");

    const reservation = resRows[0];
    if (!reservation) {
      const err = new Error(`Quota reservation '${reservationId}' not found`);
      (err as unknown as { code: ErrorCode }).code = "NOT_FOUND";
      throw err;
    }

    if (reservation.status === "released") {
      return { reservation, alreadyReleased: true };
    }

    if (reservation.status === "committed") {
      // Revert quota usage
      const quotaRows = await tx
        .select()
        .from(resourceQuotas)
        .where(eq(resourceQuotas.id, reservation.resourceQuotaId))
        .for("update");

      const quota = quotaRows[0];
      if (quota) {
        const revertSites = Math.max(0, quota.usedSites - reservation.sites);
        const revertServices = Math.max(0, quota.usedServices - reservation.services);
        const revertCpu = Math.max(0, quota.usedCpuMilli - reservation.cpuMilli);
        const memDiff = BigInt(quota.usedMemoryBytes) - BigInt(reservation.memoryBytes);
        const revertMem = memDiff > 0n ? memDiff.toString() : "0";
        const storDiff = BigInt(quota.usedStorageBytes) - BigInt(reservation.storageBytes);
        const revertStor = storDiff > 0n ? storDiff.toString() : "0";

        await tx
          .update(resourceQuotas)
          .set({
            usedSites: revertSites,
            usedServices: revertServices,
            usedCpuMilli: revertCpu,
            usedMemoryBytes: revertMem,
            usedStorageBytes: revertStor,
            updatedAt: new Date(),
          })
          .where(eq(resourceQuotas.id, quota.id));
      }
    }

    const [releasedReservation] = await tx
      .update(quotaReservations)
      .set({
        status: "released",
      })
      .where(eq(quotaReservations.id, reservationId))
      .returning();

    return { reservation: releasedReservation!, alreadyReleased: false };
  });
}

export interface CreateSiteInput {
  readonly organizationId: string;
  readonly hostAllocationId: string;
  readonly name: string;
  readonly slug: string;
  readonly initialDomain?: string;
  readonly actorId?: string;
}

export async function createSiteTransactional(
  db: HostingPanelDatabase,
  input: CreateSiteInput,
) {
  return db.transaction(async (tx) => {
    // Verify allocation belongs to organization
    const allocRows = await tx
      .select()
      .from(hostAllocations)
      .where(
        and(
          eq(hostAllocations.id, input.hostAllocationId),
          eq(hostAllocations.organizationId, input.organizationId),
        ),
      );

    if (!allocRows[0]) {
      const err = new Error(
        `Host allocation '${input.hostAllocationId}' not found for organization '${input.organizationId}'`,
      );
      (err as unknown as { code: ErrorCode }).code = "NOT_FOUND";
      throw err;
    }

    const siteId = generatePrefixedId("site");
    const [site] = await tx
      .insert(sites)
      .values({
        id: siteId,
        organizationId: input.organizationId,
        hostAllocationId: input.hostAllocationId,
        name: input.name,
        slug: input.slug,
        status: "ready",
      })
      .returning();

    let domainRecord = null;
    if (input.initialDomain) {
      const domainId = generatePrefixedId("dom");
      const [dom] = await tx
        .insert(domains)
        .values({
          id: domainId,
          siteId,
          organizationId: input.organizationId,
          hostname: input.initialDomain,
          isPrimary: true,
          status: "active",
        })
        .returning();
      domainRecord = dom;
    }

    await tx.insert(auditEvents).values({
      id: generatePrefixedId("aud"),
      actorId: input.actorId ?? null,
      actorType: "user",
      organizationId: input.organizationId,
      action: "site.create",
      targetType: "site",
      targetId: siteId,
      details: {
        slug: input.slug,
        hostAllocationId: input.hostAllocationId,
        initialDomain: input.initialDomain,
      },
    });

    return { site: site!, domain: domainRecord };
  });
}

export interface CreateServiceInput {
  readonly siteId: string;
  readonly organizationId: string;
  readonly serviceTemplateId: string;
  readonly name: string;
  readonly desiredStatus?: ServiceDesiredStatus;
  readonly configuration: Record<string, unknown>;
  readonly secretRefs?: Record<string, string>;
  readonly resourceLimits?: { cpuMilli: number; memoryBytes: string };
  readonly actorId?: string;
}

export async function createServiceWithRevisionTransactional(
  db: HostingPanelDatabase,
  input: CreateServiceInput,
) {
  return db.transaction(async (tx) => {
    // Verify site belongs to organization
    const siteRows = await tx
      .select()
      .from(sites)
      .where(and(eq(sites.id, input.siteId), eq(sites.organizationId, input.organizationId)));

    const site = siteRows[0];
    if (!site) {
      const err = new Error(`Site '${input.siteId}' not found in organization '${input.organizationId}'`);
      (err as unknown as { code: ErrorCode }).code = "NOT_FOUND";
      throw err;
    }

    // Verify template
    const tplRows = await tx
      .select()
      .from(serviceTemplates)
      .where(eq(serviceTemplates.id, input.serviceTemplateId));

    const tpl = tplRows[0];
    if (!tpl) {
      const err = new Error(`Service template '${input.serviceTemplateId}' not found`);
      (err as unknown as { code: ErrorCode }).code = "NOT_FOUND";
      throw err;
    }

    // Validate declarative input
    const validation = validateDeclarativeServiceInput(
      tpl,
      "dedicated",
      input.configuration,
      input.resourceLimits,
    );

    if (!validation.valid) {
      const err = new Error(validation.message);
      (err as unknown as { code: ErrorCode }).code = validation.errorCode ?? "VALIDATION_ERROR";
      throw err;
    }

    const serviceId = generatePrefixedId("svc");
    const desiredStatus = input.desiredStatus ?? "running";

    // Build immutable stack revision #1
    const revision = buildImmutableStackRevision({
      serviceInstanceId: serviceId,
      organizationId: input.organizationId,
      currentRevisionNumber: 0,
      declarativeConfig: input.configuration,
      secretRefs: input.secretRefs,
      resourceLimits: input.resourceLimits ?? null,
      authorId: input.actorId,
    });

    const [service] = await tx
      .insert(serviceInstances)
      .values({
        id: serviceId,
        siteId: input.siteId,
        organizationId: input.organizationId,
        serviceTemplateId: input.serviceTemplateId,
        name: input.name,
        desiredStatus,
        currentRevisionId: revision.id,
      })
      .returning();

    const [revRecord] = await tx
      .insert(stackRevisions)
      .values({
        id: revision.id,
        serviceInstanceId: serviceId,
        organizationId: input.organizationId,
        revisionNumber: revision.revisionNumber,
        specHash: revision.specHash,
        declarativeConfig: revision.declarativeConfig as Record<string, unknown>,
        secretRefs: revision.secretRefs as Record<string, string>,
        resourceLimits: revision.resourceLimits,
        authorId: revision.authorId,
      })
      .returning();

    const [observed] = await tx
      .insert(observedStates)
      .values({
        id: generatePrefixedId("obs"),
        serviceInstanceId: serviceId,
        observedStatus: desiredStatus,
        observedRevisionHash: revision.specHash,
        outOfBandModified: false,
        rawState: {},
      })
      .returning();

    const dockerRef = `cnt_${serviceId}_${revision.revisionNumber}`;
    const [dockerRes] = await tx
      .insert(dockerResources)
      .values({
        id: generatePrefixedId("dock"),
        siteId: input.siteId,
        serviceInstanceId: serviceId,
        internalDockerRef: dockerRef,
        resourceType: "container",
        status: desiredStatus,
        metadata: { image: tpl.defaultImage },
      })
      .returning();

    await tx.insert(auditEvents).values({
      id: generatePrefixedId("aud"),
      actorId: input.actorId ?? null,
      actorType: "user",
      organizationId: input.organizationId,
      action: "service.create",
      targetType: "service_instance",
      targetId: serviceId,
      details: {
        siteId: input.siteId,
        revisionId: revision.id,
      },
    });

    return {
      service: service!,
      revision: revRecord!,
      observedState: observed!,
      dockerResource: dockerRes!,
    };
  });
}

export interface AppendStackRevisionInput {
  readonly serviceInstanceId: string;
  readonly organizationId: string;
  readonly declarativeConfig: Record<string, unknown>;
  readonly secretRefs?: Record<string, string>;
  readonly resourceLimits?: { cpuMilli: number; memoryBytes: string };
  readonly authorId?: string;
}

export async function appendStackRevisionTransactional(
  db: HostingPanelDatabase,
  input: AppendStackRevisionInput,
) {
  return db.transaction(async (tx) => {
    const svcRows = await tx
      .select()
      .from(serviceInstances)
      .where(
        and(
          eq(serviceInstances.id, input.serviceInstanceId),
          eq(serviceInstances.organizationId, input.organizationId),
        ),
      )
      .for("update");

    const service = svcRows[0];
    if (!service) {
      const err = new Error(
        `Service instance '${input.serviceInstanceId}' not found in organization '${input.organizationId}'`,
      );
      (err as unknown as { code: ErrorCode }).code = "NOT_FOUND";
      throw err;
    }

    // Get current max revisionNumber
    const revRows = await tx
      .select()
      .from(stackRevisions)
      .where(eq(stackRevisions.serviceInstanceId, input.serviceInstanceId))
      .orderBy(asc(stackRevisions.revisionNumber));

    const currentMaxRev = revRows.length > 0 ? revRows[revRows.length - 1]!.revisionNumber : 0;

    const revision = buildImmutableStackRevision({
      serviceInstanceId: input.serviceInstanceId,
      organizationId: input.organizationId,
      currentRevisionNumber: currentMaxRev,
      declarativeConfig: input.declarativeConfig,
      secretRefs: input.secretRefs,
      resourceLimits: input.resourceLimits ?? null,
      authorId: input.authorId,
    });

    const [newRevRecord] = await tx
      .insert(stackRevisions)
      .values({
        id: revision.id,
        serviceInstanceId: input.serviceInstanceId,
        organizationId: input.organizationId,
        revisionNumber: revision.revisionNumber,
        specHash: revision.specHash,
        declarativeConfig: revision.declarativeConfig as Record<string, unknown>,
        secretRefs: revision.secretRefs as Record<string, string>,
        resourceLimits: revision.resourceLimits,
        authorId: revision.authorId,
      })
      .returning();

    await tx
      .update(serviceInstances)
      .set({
        currentRevisionId: revision.id,
        updatedAt: new Date(),
      })
      .where(eq(serviceInstances.id, input.serviceInstanceId));

    await tx.insert(auditEvents).values({
      id: generatePrefixedId("aud"),
      actorId: input.authorId ?? null,
      actorType: "user",
      organizationId: input.organizationId,
      action: "service.configuration.manage",
      targetType: "stack_revision",
      targetId: revision.id,
      details: {
        serviceInstanceId: input.serviceInstanceId,
        revisionNumber: revision.revisionNumber,
        specHash: revision.specHash,
      },
    });

    return newRevRecord!;
  });
}

export async function rebindDockerResourceTransactional(
  db: HostingPanelDatabase,
  serviceInstanceId: string,
  newInternalDockerRef: string,
  newStatus?: string,
) {
  return db.transaction(async (tx) => {
    const dockRows = await tx
      .select()
      .from(dockerResources)
      .where(eq(dockerResources.serviceInstanceId, serviceInstanceId))
      .for("update");

    const existing = dockRows[0];
    if (!existing) {
      const err = new Error(`Docker resource for service '${serviceInstanceId}' not found`);
      (err as unknown as { code: ErrorCode }).code = "NOT_FOUND";
      throw err;
    }

    const { updatedResource, siteIdPreserved, serviceInstanceIdPreserved } = rebindDockerResource({
      existingResource: {
        id: existing.id,
        siteId: existing.siteId,
        serviceInstanceId: existing.serviceInstanceId,
        internalDockerRef: existing.internalDockerRef,
        resourceType: existing.resourceType as "container" | "volume" | "network",
        status: existing.status,
        metadata: existing.metadata as Record<string, unknown>,
        createdAt: existing.createdAt.toISOString(),
        updatedAt: existing.updatedAt.toISOString(),
      },
      newInternalDockerRef,
      newStatus,
    });

    const [updated] = await tx
      .update(dockerResources)
      .set({
        internalDockerRef: updatedResource.internalDockerRef,
        status: updatedResource.status,
        metadata: updatedResource.metadata as Record<string, unknown>,
        updatedAt: new Date(),
      })
      .where(eq(dockerResources.id, existing.id))
      .returning();

    return {
      updatedResource: updated!,
      siteIdPreserved,
      serviceInstanceIdPreserved,
    };
  });
}

export interface EnqueueOperationInput {
  readonly organizationId: string;
  readonly kind: OperationKind;
  readonly resourceType: OperationResourceType;
  readonly resourceId: string;
  readonly requestedByUserId?: string;
  readonly idempotencyKey?: string;
  readonly lockKey?: string;
  readonly steps?: readonly { key: string; label: string }[];
}

export async function enqueueOperationTransactional(
  db: HostingPanelDatabase,
  input: EnqueueOperationInput,
) {
  return db.transaction(async (tx) => {
    const operationId = generatePrefixedId("op");

    const [operation] = await tx
      .insert(operations)
      .values({
        id: operationId,
        organizationId: input.organizationId,
        kind: input.kind,
        status: "queued",
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        requestedByUserId: input.requestedByUserId ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        lockKey: input.lockKey ?? null,
      })
      .returning();

    const createdSteps = [];
    for (const step of input.steps ?? []) {
      const stepId = generatePrefixedId("step");
      const [s] = await tx
        .insert(operationSteps)
        .values({
          id: stepId,
          operationId,
          key: step.key,
          label: step.label,
          status: "pending",
        })
        .returning();
      createdSteps.push(s);
    }

    const [outbox] = await tx
      .insert(outboxEvents)
      .values({
        id: generatePrefixedId("out"),
        eventType: `operation.queued.${input.kind}`,
        aggregateType: input.resourceType,
        aggregateId: input.resourceId,
        payload: {
          operationId,
          organizationId: input.organizationId,
          kind: input.kind,
        },
      })
      .returning();

    return { operation: operation!, steps: createdSteps, outbox: outbox! };
  });
}

export async function transitionOperation(
  db: HostingPanelDatabase,
  operationId: string,
  targetStatus: OperationStatus,
  options?: { errorCode?: ErrorCode; errorMessage?: string },
) {
  return db.transaction(async (tx) => {
    const opRows = await tx
      .select()
      .from(operations)
      .where(eq(operations.id, operationId))
      .for("update");

    const op = opRows[0];
    if (!op) {
      throw new Error(`Operation '${operationId}' not found`);
    }

    if (!canTransitionOperation(op.status, targetStatus)) {
      throw new Error(
        `Invalid operation status transition from '${op.status}' to '${targetStatus}'`,
      );
    }

    const isTerminal = isTerminalOperationStatus(targetStatus);
    const now = new Date();

    const [updated] = await tx
      .update(operations)
      .set({
        status: targetStatus,
        startedAt: op.startedAt ?? (targetStatus === "processing" ? now : null),
        completedAt: isTerminal ? now : null,
        errorCode: options?.errorCode ?? op.errorCode,
        errorMessage: options?.errorMessage ?? op.errorMessage,
        updatedAt: now,
      })
      .where(eq(operations.id, operationId))
      .returning();

    return updated!;
  });
}

export async function claimPendingOutboxEvents(
  db: HostingPanelDatabase,
  batchSize: number = 10,
) {
  return db.transaction(async (tx) => {
    const pending = await tx
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.status, "pending"))
      .orderBy(asc(outboxEvents.createdAt))
      .limit(batchSize)
      .for("update");

    return pending;
  });
}

export interface AppendAuditEventInput {
  readonly actorId?: string | null;
  readonly actorType?: AuditActorType;
  readonly organizationId?: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId?: string | null;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
  readonly details?: Record<string, unknown>;
}

export async function appendAuditEvent(
  executor: DatabaseExecutor,
  input: AppendAuditEventInput,
) {
  const [event] = await executor
    .insert(auditEvents)
    .values({
      id: generatePrefixedId("aud"),
      actorId: input.actorId ?? null,
      actorType: input.actorType ?? "user",
      organizationId: input.organizationId ?? null,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      details: input.details ?? {},
    })
    .returning();

  return event;
}
