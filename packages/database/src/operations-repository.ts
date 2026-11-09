import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  canTransitionOperation,
  findForbiddenPublicDtoKeys,
  findPlaintextSecretKeys,
  isTerminalOperationStatus,
  type AuditActorType,
  type DomainStatus,
  type ErrorCode,
  type HostingMode,
  type OperationKind,
  type OperationResourceType,
  type OperationStatus,
  type PhpVersion,
  type ServiceDesiredStatus,
  type SiteStatus,
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
  readonly status?: SiteStatus;
  readonly phpVersion?: PhpVersion | null;
  readonly initialDomainStatus?: DomainStatus;
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
        status: input.status ?? "ready",
        phpVersion: input.phpVersion ?? null,
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
          status: input.initialDomainStatus ?? "active",
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

export const ACTIVE_OPERATION_LOCK_STATUSES = [
  "queued",
  "processing",
  "accepted",
  "reconciling",
  "unknown",
] as const satisfies readonly OperationStatus[];

export const DEFAULT_OPERATION_LEASE_DURATION_MS = 60_000;

function createRepoError(message: string, code: ErrorCode): Error {
  const err = new Error(message);
  (err as unknown as { code: ErrorCode }).code = code;
  return err;
}

function extractPgUniqueConstraintText(err: unknown): string | null {
  const top = err as {
    code?: string;
    constraint?: string;
    message?: string;
    cause?: unknown;
  } | null;
  const cause = (top?.cause ?? null) as {
    code?: string;
    constraint?: string;
    message?: string;
  } | null;

  const pgCode = cause?.code ?? top?.code ?? "";
  const combined = [
    top?.constraint ?? "",
    cause?.constraint ?? "",
    top?.message ?? "",
    cause?.message ?? "",
  ].join(" ");

  if (pgCode === "23505" || /duplicate key value violates unique constraint/i.test(combined)) {
    return combined;
  }
  return null;
}

export interface EnqueueOperationInput {
  readonly organizationId: string;
  readonly kind: OperationKind;
  readonly resourceType: OperationResourceType;
  readonly resourceId: string;
  readonly requestedByUserId?: string;
  readonly idempotencyKey?: string;
  readonly lockKey?: string;
  readonly leaseDurationMs?: number;
  readonly leaseExpiresAt?: Date | null;
  readonly outboxPayload?: Record<string, unknown>;
  readonly steps?: readonly { key: string; label: string }[];
}

export async function enqueueOperationTransactional(
  db: HostingPanelDatabase,
  input: EnqueueOperationInput,
) {
  return db.transaction(async (tx) => {
    // 1. Idempotent replay check per (organizationId, idempotencyKey)
    if (input.idempotencyKey) {
      const existingOps = await tx
        .select()
        .from(operations)
        .where(
          and(
            eq(operations.organizationId, input.organizationId),
            eq(operations.idempotencyKey, input.idempotencyKey),
          ),
        );

      const existingOp = existingOps[0];
      if (existingOp) {
        if (
          existingOp.kind !== input.kind ||
          existingOp.resourceType !== input.resourceType ||
          existingOp.resourceId !== input.resourceId
        ) {
          throw createRepoError(
            `Idempotency key '${input.idempotencyKey}' was already used for a different operation target`,
            "IDEMPOTENCY_CONFLICT",
          );
        }

        const existingSteps = await tx
          .select()
          .from(operationSteps)
          .where(eq(operationSteps.operationId, existingOp.id))
          .orderBy(asc(operationSteps.id));

        return {
          operation: existingOp,
          steps: existingSteps,
          outbox: null,
          idempotentReplay: true,
        };
      }
    }

    // 2. Active lockKey contention check (AC-F2-06)
    if (input.lockKey) {
      const conflictingOps = await tx
        .select({ id: operations.id, status: operations.status })
        .from(operations)
        .where(
          and(
            eq(operations.lockKey, input.lockKey),
            inArray(operations.status, [...ACTIVE_OPERATION_LOCK_STATUSES]),
          ),
        );

      if (conflictingOps[0]) {
        throw createRepoError(
          `Resource lock '${input.lockKey}' is currently held by active operation '${conflictingOps[0].id}' (${conflictingOps[0].status})`,
          "RESOURCE_LOCKED",
        );
      }
    }

    const operationId = generatePrefixedId("op");
    const now = new Date();
    const leaseExpiresAt =
      input.leaseExpiresAt !== undefined
        ? input.leaseExpiresAt
        : new Date(now.getTime() + (input.leaseDurationMs ?? DEFAULT_OPERATION_LEASE_DURATION_MS));

    // 3. Enforce zero secrets or forbidden internal references in outbox_events.payload
    const outboxPayload: Record<string, unknown> = {
      ...(input.outboxPayload ?? {}),
      operationId,
      organizationId: input.organizationId,
      kind: input.kind,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
    };

    const secretViolations = findPlaintextSecretKeys(outboxPayload);
    const forbiddenViolations = findForbiddenPublicDtoKeys(outboxPayload);
    if (secretViolations.length > 0 || forbiddenViolations.length > 0) {
      throw createRepoError(
        `Outbox payload must never contain secrets or forbidden internal keys (${[
          ...secretViolations,
          ...forbiddenViolations,
        ].join(", ")})`,
        "VALIDATION_ERROR",
      );
    }

    let operation;
    try {
      const inserted = await tx
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
          leaseExpiresAt,
          submittedAt: now,
          updatedAt: now,
        })
        .returning();
      operation = inserted[0];
    } catch (err) {
      const uniqueText = extractPgUniqueConstraintText(err);
      if (uniqueText !== null) {
        if (uniqueText.includes("uq_operations_active_lock")) {
          throw createRepoError(
            `Resource lock '${String(input.lockKey)}' is already held by an active operation`,
            "RESOURCE_LOCKED",
          );
        }
        if (uniqueText.includes("uq_operations_org_idempotency")) {
          throw createRepoError(
            `Idempotency conflict for key '${String(input.idempotencyKey)}'`,
            "IDEMPOTENCY_CONFLICT",
          );
        }
      }
      throw err;
    }

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
      if (s) {
        createdSteps.push(s);
      }
    }

    const [outbox] = await tx
      .insert(outboxEvents)
      .values({
        id: generatePrefixedId("out"),
        eventType: `operation.queued.${input.kind}`,
        aggregateType: input.resourceType,
        aggregateId: input.resourceId,
        payload: outboxPayload,
      })
      .returning();

    return {
      operation: operation!,
      steps: createdSteps,
      outbox: outbox!,
      idempotentReplay: false,
    };
  });
}

export async function transitionOperation(
  db: HostingPanelDatabase,
  operationId: string,
  targetStatus: OperationStatus,
  options?: {
    errorCode?: ErrorCode | null;
    errorMessage?: string | null;
    leaseDurationMs?: number;
    leaseExpiresAt?: Date | null;
  },
) {
  return db.transaction(async (tx) => {
    const opRows = await tx
      .select()
      .from(operations)
      .where(eq(operations.id, operationId))
      .for("update");

    const op = opRows[0];
    if (!op) {
      throw createRepoError(`Operation '${operationId}' not found`, "NOT_FOUND");
    }

    if (!canTransitionOperation(op.status, targetStatus)) {
      throw createRepoError(
        `Invalid operation status transition from '${op.status}' to '${targetStatus}'`,
        "VALIDATION_ERROR",
      );
    }

    const isTerminal = isTerminalOperationStatus(targetStatus);
    const now = new Date();

    let nextLeaseExpiresAt: Date | null = op.leaseExpiresAt;
    if (isTerminal) {
      nextLeaseExpiresAt = null;
    } else if (options?.leaseExpiresAt !== undefined) {
      nextLeaseExpiresAt = options.leaseExpiresAt;
    } else if (options?.leaseDurationMs !== undefined) {
      nextLeaseExpiresAt = new Date(now.getTime() + options.leaseDurationMs);
    } else if (targetStatus === "processing" || targetStatus === "accepted") {
      nextLeaseExpiresAt = new Date(now.getTime() + DEFAULT_OPERATION_LEASE_DURATION_MS);
    }

    const [updated] = await tx
      .update(operations)
      .set({
        status: targetStatus,
        startedAt: op.startedAt ?? (targetStatus === "processing" ? now : null),
        completedAt: isTerminal ? now : null,
        leaseExpiresAt: nextLeaseExpiresAt,
        errorCode: options?.errorCode !== undefined ? options.errorCode : op.errorCode,
        errorMessage: options?.errorMessage !== undefined ? options.errorMessage : op.errorMessage,
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
  leaseDurationMs: number = DEFAULT_OPERATION_LEASE_DURATION_MS,
) {
  return db.transaction(async (tx) => {
    const pending = await tx
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.status, "pending"))
      .orderBy(asc(outboxEvents.createdAt))
      .limit(batchSize)
      .for("update", { skipLocked: true });

    if (pending.length === 0) {
      return [];
    }

    const now = new Date();
    const claimedIds = pending.map((row) => row.id);

    const updated = await tx
      .update(outboxEvents)
      .set({
        status: "processing",
        lockedAt: now,
      })
      .where(inArray(outboxEvents.id, claimedIds))
      .returning();

    const queuedOpIds: string[] = [];
    for (const row of pending) {
      const payload = row.payload as Record<string, unknown> | null;
      if (payload && typeof payload.operationId === "string" && payload.operationId.length > 0) {
        queuedOpIds.push(payload.operationId);
      }
    }

    if (queuedOpIds.length > 0 && leaseDurationMs > 0) {
      await tx
        .update(operations)
        .set({
          leaseExpiresAt: new Date(now.getTime() + leaseDurationMs),
          updatedAt: now,
        })
        .where(and(inArray(operations.id, queuedOpIds), eq(operations.status, "queued")));
    }

    const byId = new Map(updated.map((row) => [row.id, row]));
    return claimedIds
      .map((id) => byId.get(id))
      .filter((row): row is NonNullable<typeof row> => row !== undefined);
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

export * from "./phase2-repository.js";

