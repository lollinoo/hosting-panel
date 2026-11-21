import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { DatabaseExecutor } from "./client.js";
import { domains, tlsCertificateVersions } from "./schema.js";

export type DomainRow = typeof domains.$inferSelect;

/** What a manual domain shows of its certificate version: the owning certificate and the last apply problem. */
export type DomainManualTlsRow = {
  domainId: string;
  certificateId: string;
  versionId: string;
  lastErrorCode: typeof tlsCertificateVersions.$inferSelect.lastErrorCode;
};

export function listSiteDomains(db: DatabaseExecutor, siteId: string): Promise<DomainRow[]> {
  return db.select().from(domains).where(eq(domains.siteId, siteId)).orderBy(asc(domains.hostname));
}

/** One row per manual domain of the site; the composite FK on `domains` guarantees the version exists in the same organization. */
export function listSiteManualTls(db: DatabaseExecutor, siteId: string): Promise<DomainManualTlsRow[]> {
  return db
    .select({
      domainId: domains.id,
      certificateId: tlsCertificateVersions.certificateId,
      versionId: tlsCertificateVersions.id,
      lastErrorCode: tlsCertificateVersions.lastErrorCode,
    })
    .from(domains)
    .innerJoin(tlsCertificateVersions, eq(tlsCertificateVersions.id, domains.manualCertificateVersionId))
    .where(and(eq(domains.siteId, siteId), eq(domains.certMode, "manual")));
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
