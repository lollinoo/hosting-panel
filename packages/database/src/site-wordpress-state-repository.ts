import { and, eq } from "drizzle-orm";
import type { DatabaseExecutor } from "./client.js";
import { siteWordpressState } from "./schema.js";

type SiteKey = {
  organizationId: string;
  siteId: string;
};

/** Stored WordPress state and last update of one site; the API parses both with its DTO schemas. */
export async function getSiteWordpressState(
  db: DatabaseExecutor,
  k: SiteKey,
): Promise<{ state: unknown; lastUpdate: unknown } | null> {
  const [row] = await db
    .select({ state: siteWordpressState.state, lastUpdate: siteWordpressState.lastUpdate })
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
