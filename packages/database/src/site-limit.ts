import type { ErrorCode } from "@hosting-panel/contracts";
import { count, eq, inArray } from "drizzle-orm";
import type { DatabaseExecutor, HostingPanelDatabase } from "./client.js";
import { organizations, sites } from "./schema.js";

/** The organization already has as many sites as its limit allows (every `sites` row counts, whatever its status). */
export class SiteLimitReachedError extends Error {
  readonly code = "QUOTA_EXCEEDED" as const;

  constructor(
    readonly organizationId: string,
    readonly maxSites: number,
    readonly usedSites: number,
  ) {
    super(`Organization has reached its site limit (${String(usedSites)} of ${String(maxSites)}).`);
    this.name = "SiteLimitReachedError";
  }
}

export interface SiteLimitUsage {
  readonly maxSites: number | null;
  readonly usedSites: number;
}

async function countSites(db: DatabaseExecutor, organizationId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(sites).where(eq(sites.organizationId, organizationId));
  return row?.n ?? 0;
}

/**
 * Inside a transaction: locks the organizations row FOR NO KEY UPDATE (it does not conflict with the KEY SHARE lock of
 * foreign-key inserts, so other writes under the organization go on), then counts its sites. A waiter therefore sees
 * the sites the previous holder committed. Lock order: organization, then site row, then domains and TLS state.
 */
export async function lockSiteLimitUsage(tx: DatabaseExecutor, organizationId: string): Promise<SiteLimitUsage> {
  const [org] = await tx
    .select({ maxSites: organizations.maxSites })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .for("no key update");
  if (!org) {
    throw Object.assign(new Error(`Organization '${organizationId}' not found`), { code: "NOT_FOUND" satisfies ErrorCode });
  }
  return { maxSites: org.maxSites, usedSites: await countSites(tx, organizationId) };
}

/** lockSiteLimitUsage, then SiteLimitReachedError when the organization has a limit and it is used up. */
export async function assertSiteLimitAvailable(tx: DatabaseExecutor, organizationId: string): Promise<void> {
  const { maxSites, usedSites } = await lockSiteLimitUsage(tx, organizationId);
  if (maxSites !== null && usedSites >= maxSites) throw new SiteLimitReachedError(organizationId, maxSites, usedSites);
}

/** Unlocked count per organization, for read models; organizations without sites map to 0. */
export async function countSitesByOrganization(
  db: DatabaseExecutor,
  organizationIds: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map(organizationIds.map((id) => [id, 0]));
  if (organizationIds.length === 0) return counts;
  const rows = await db
    .select({ organizationId: sites.organizationId, n: count() })
    .from(sites)
    .where(inArray(sites.organizationId, [...organizationIds]))
    .groupBy(sites.organizationId);
  for (const row of rows) counts.set(row.organizationId, row.n);
  return counts;
}

/** Own transaction (a savepoint when nested): sets max_sites (null = unlimited). Unknown organization gives null. */
export async function updateOrganizationSiteLimitTransactional(
  db: HostingPanelDatabase,
  input: { readonly organizationId: string; readonly maxSites: number | null },
): Promise<{ previousMaxSites: number | null; maxSites: number | null; usedSites: number } | null> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ maxSites: organizations.maxSites })
      .from(organizations)
      .where(eq(organizations.id, input.organizationId))
      .for("no key update");
    if (!current) return null;
    await tx
      .update(organizations)
      .set({ maxSites: input.maxSites, updatedAt: new Date() })
      .where(eq(organizations.id, input.organizationId));
    return {
      previousMaxSites: current.maxSites,
      maxSites: input.maxSites,
      usedSites: await countSites(tx, input.organizationId),
    };
  });
}
