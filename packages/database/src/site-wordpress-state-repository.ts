import { and, eq } from "drizzle-orm";
import type { DatabaseExecutor } from "./client.js";
import { siteWordpressState } from "./schema.js";

type SiteKey = {
  organizationId: string;
  siteId: string;
};

/** Stored WordPress state, last update and last import of one site; the API parses each with its DTO schema. */
export async function getSiteWordpressState(
  db: DatabaseExecutor,
  k: SiteKey,
): Promise<{ state: unknown; lastUpdate: unknown; lastImport: unknown } | null> {
  const [row] = await db
    .select({
      state: siteWordpressState.state,
      lastUpdate: siteWordpressState.lastUpdate,
      lastImport: siteWordpressState.lastImport,
    })
    .from(siteWordpressState)
    .where(and(eq(siteWordpressState.organizationId, k.organizationId), eq(siteWordpressState.siteId, k.siteId)))
    .limit(1);
  return row ?? null;
}

/** Replaces the stored state of a site, leaving its last update untouched. */
export async function saveSiteWordpressState(
  db: DatabaseExecutor,
  k: SiteKey & { state: unknown },
): Promise<void> {
  await db
    .insert(siteWordpressState)
    .values({ siteId: k.siteId, organizationId: k.organizationId, state: k.state })
    .onConflictDoUpdate({
      target: siteWordpressState.siteId,
      set: { state: k.state, updatedAt: new Date() },
      setWhere: eq(siteWordpressState.organizationId, k.organizationId),
    });
}

/** Replaces the last update of a site, leaving its stored state untouched. */
export async function saveSiteWordpressLastUpdate(
  db: DatabaseExecutor,
  k: SiteKey & { lastUpdate: unknown },
): Promise<void> {
  await db
    .insert(siteWordpressState)
    .values({ siteId: k.siteId, organizationId: k.organizationId, lastUpdate: k.lastUpdate })
    .onConflictDoUpdate({
      target: siteWordpressState.siteId,
      set: { lastUpdate: k.lastUpdate, updatedAt: new Date() },
      setWhere: eq(siteWordpressState.organizationId, k.organizationId),
    });
}

/** Replaces the last import of a site, leaving its state and last update untouched. */
export async function saveSiteWordpressLastImport(
  db: DatabaseExecutor,
  k: SiteKey & { lastImport: unknown },
): Promise<void> {
  await db
    .insert(siteWordpressState)
    .values({ siteId: k.siteId, organizationId: k.organizationId, lastImport: k.lastImport })
    .onConflictDoUpdate({
      target: siteWordpressState.siteId,
      set: { lastImport: k.lastImport, updatedAt: new Date() },
      setWhere: eq(siteWordpressState.organizationId, k.organizationId),
    });
}
