// Per-organization application stack limit (organizations.max_app_stacks, NULL = unlimited) and the resource-quota charge
// of the desired revision. Lock order: organization row FOR NO KEY UPDATE, then the resource_quotas row FOR UPDATE.

import type { ErrorCode } from "@hosting-panel/contracts";
import { and, asc, count, eq, inArray, isNull } from "drizzle-orm";
import type { DatabaseExecutor, HostingPanelDatabase } from "./client.js";
import { appStacks, organizations, resourceQuotas } from "./schema.js";

export type AppStackQuotaField = "appStacks" | "components" | "cpuMilli" | "memoryBytes";

export class AppStackQuotaError extends Error {
  readonly code = "QUOTA_EXCEEDED" as const;
  readonly reason = "STACK_QUOTA_EXCEEDED" as const;

  constructor(
    readonly field: AppStackQuotaField,
    readonly used: number,
    readonly limit: number,
  ) {
    super(`Application stack quota exceeded for ${field} (${String(used)} of ${String(limit)}).`);
    this.name = "AppStackQuotaError";
  }
}

export interface AppStackLimitUsage {
  readonly maxAppStacks: number | null;
  readonly usedAppStacks: number;
}

interface AppStackQuotaTotals {
  readonly componentCount: number;
  readonly cpuMilli: number;
  readonly memoryBytes: number;
}

async function countLiveAppStacks(db: DatabaseExecutor, organizationId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(appStacks)
    .where(and(eq(appStacks.organizationId, organizationId), isNull(appStacks.deletedAt)));
  return row?.n ?? 0;
}

/** Inside a transaction: locks the organizations row FOR NO KEY UPDATE, then counts its live (not deleted) stacks. */
export async function lockAppStackLimitUsage(tx: DatabaseExecutor, organizationId: string): Promise<AppStackLimitUsage> {
  const [org] = await tx
    .select({ maxAppStacks: organizations.maxAppStacks })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .for("no key update");
  if (!org) {
    throw Object.assign(new Error(`Organization '${organizationId}' not found`), { code: "NOT_FOUND" satisfies ErrorCode });
  }
  return { maxAppStacks: org.maxAppStacks, usedAppStacks: await countLiveAppStacks(tx, organizationId) };
}

/** Unlocked live-stack count per organization, for read models; organizations without stacks map to 0. */
export async function countAppStacksByOrganization(
  db: DatabaseExecutor,
  organizationIds: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map(organizationIds.map((id) => [id, 0]));
  if (organizationIds.length === 0) return counts;
  const rows = await db
    .select({ organizationId: appStacks.organizationId, n: count() })
    .from(appStacks)
    .where(and(inArray(appStacks.organizationId, [...organizationIds]), isNull(appStacks.deletedAt)))
    .groupBy(appStacks.organizationId);
  for (const row of rows) counts.set(row.organizationId, row.n);
  return counts;
}

/** Own transaction (a savepoint when nested): sets max_app_stacks (null = unlimited). Unknown organization gives null. */
export async function updateOrganizationAppStackLimitTransactional(
  db: HostingPanelDatabase,
  input: { readonly organizationId: string; readonly maxAppStacks: number | null },
): Promise<{ previousMaxAppStacks: number | null; maxAppStacks: number | null; usedAppStacks: number } | null> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ maxAppStacks: organizations.maxAppStacks })
      .from(organizations)
      .where(eq(organizations.id, input.organizationId))
      .for("no key update");
    if (!current) return null;
    await tx
      .update(organizations)
      .set({ maxAppStacks: input.maxAppStacks, updatedAt: new Date() })
      .where(eq(organizations.id, input.organizationId));
    return {
      previousMaxAppStacks: current.maxAppStacks,
      maxAppStacks: input.maxAppStacks,
      usedAppStacks: await countLiveAppStacks(tx, input.organizationId),
    };
  });
}

/**
 * Inside the stack writer's transaction, after the stack row lock: applies next − previous to the organization's
 * resource_quotas row (FOR UPDATE), refusing a positive delta that would pass a maximum. The row is looked up only on the
 * first charge (no quota id and no previous revision) and its id recorded on the stack; a stack charged nothing then is
 * never charged. `next: null` releases the previous totals and clears the stack's quota id.
 */
export async function chargeAppStackQuota(
  tx: DatabaseExecutor,
  input: {
    readonly organizationId: string;
    readonly stackId: string;
    readonly hostAllocationId: string;
    readonly resourceQuotaId: string | null;
    readonly previous: AppStackQuotaTotals | null;
    readonly next: AppStackQuotaTotals | null;
  },
): Promise<{ resourceQuotaId: string | null }> {
  const { organizationId, stackId, previous, next } = input;
  const first = input.resourceQuotaId === null && previous === null && next !== null;
  if (input.resourceQuotaId === null && !first) return { resourceQuotaId: null };
  const [quota] = await tx
    .select()
    .from(resourceQuotas)
    .where(
      input.resourceQuotaId === null
        ? and(eq(resourceQuotas.organizationId, organizationId), eq(resourceQuotas.hostAllocationId, input.hostAllocationId))
        : and(eq(resourceQuotas.organizationId, organizationId), eq(resourceQuotas.id, input.resourceQuotaId)),
    )
    .orderBy(asc(resourceQuotas.id))
    .limit(1)
    .for("update");
  if (!quota) return { resourceQuotaId: null };

  const components = (next?.componentCount ?? 0) - (previous?.componentCount ?? 0);
  const cpuMilli = (next?.cpuMilli ?? 0) - (previous?.cpuMilli ?? 0);
  const memoryBytes = BigInt(next?.memoryBytes ?? 0) - BigInt(previous?.memoryBytes ?? 0);
  const usedMemory = BigInt(quota.usedMemoryBytes);
  const maxMemory = BigInt(quota.maxMemoryBytes);
  if (components > 0 && quota.usedServices + components > quota.maxServices) {
    throw new AppStackQuotaError("components", quota.usedServices, quota.maxServices);
  }
  if (cpuMilli > 0 && quota.usedCpuMilli + cpuMilli > quota.maxCpuMilli) {
    throw new AppStackQuotaError("cpuMilli", quota.usedCpuMilli, quota.maxCpuMilli);
  }
  if (memoryBytes > 0n && usedMemory + memoryBytes > maxMemory) {
    throw new AppStackQuotaError("memoryBytes", Number(usedMemory), Number(maxMemory));
  }

  const memory = usedMemory + memoryBytes;
  await tx
    .update(resourceQuotas)
    .set({
      usedServices: Math.max(0, quota.usedServices + components),
      usedCpuMilli: Math.max(0, quota.usedCpuMilli + cpuMilli),
      usedMemoryBytes: (memory > 0n ? memory : 0n).toString(),
      updatedAt: new Date(),
    })
    .where(eq(resourceQuotas.id, quota.id));
  const resourceQuotaId = next === null ? null : quota.id;
  if (resourceQuotaId !== input.resourceQuotaId) {
    await tx
      .update(appStacks)
      .set({ resourceQuotaId })
      .where(and(eq(appStacks.id, stackId), eq(appStacks.organizationId, organizationId)));
  }
  return { resourceQuotaId };
}
