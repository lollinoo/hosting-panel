import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import type { DatabaseExecutor } from "./client.js";
import { domains } from "./schema.js";

export type DomainRow = typeof domains.$inferSelect;

export function listSiteDomains(db: DatabaseExecutor, siteId: string): Promise<DomainRow[]> {
  return db.select().from(domains).where(eq(domains.siteId, siteId)).orderBy(asc(domains.hostname));
}

export async function insertSiteDomains(
  db: DatabaseExecutor,
  input: { siteId: string; organizationId: string; hostnames: readonly string[]; routed: boolean },
): Promise<DomainRow[]> {
  if (input.hostnames.length === 0) return [];
  return db
    .insert(domains)
    .values(
      input.hostnames.map((hostname) => ({
        id: `dom_${randomUUID().replace(/-/g, "")}`,
        siteId: input.siteId,
        organizationId: input.organizationId,
        hostname,
        status: input.routed ? ("active" as const) : ("pending" as const),
      })),
    )
    .returning();
}
