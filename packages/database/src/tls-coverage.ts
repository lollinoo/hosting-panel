import { findManualCaptures, traefikNameMatches } from "@hosting-panel/contracts";
import { eq, inArray, ne } from "drizzle-orm";
import type { DatabaseExecutor } from "./client.js";
import { domains, tlsCertificateVersions } from "./schema.js";
import { lockTlsPublishState, TlsRepositoryError } from "./tls-certificates-repository.js";

// HCP-SPEC-004 (ADR-0031, T5): a manual certificate must never cover a hostname of another organization, and must
// not silently capture a host of its own organization that is not assigned to it. Every writer that adds a panel
// hostname (site create, domain add, site move) runs these guards. Lock order, always: site row -> TLS publish
// state row; the guards take the second lock, so call them after the site row is locked (or created).

/** Same text as a domain add that collides with another site: it never names the certificate or its owner. */
const FOREIGN_COVERAGE_MESSAGE =
  "This web address is already used by another site or by the panel. Remove it from the other site first, or ask your administrator.";

export type TlsCoverageReason = "foreign_coverage" | "captures_host" | "manual_domain";

/** A guard refusal; `hostname` is set only for the caller's own hostname (`captures_host`). */
export class TlsCoverageError extends TlsRepositoryError {
  readonly reason: TlsCoverageReason;
  readonly hostname?: string;

  constructor(code: "DOMAIN_CONFLICT" | "CERTIFICATE_IN_USE", reason: TlsCoverageReason, message: string, hostname?: string) {
    super(code, message);
    this.name = "TlsCoverageError";
    this.reason = reason;
    if (hostname !== undefined) this.hostname = hostname;
  }
}

interface PublishedEntry {
  readonly versionId: string;
  readonly names: readonly string[];
}

/** Versions the proxy serves or is about to serve (`applying|active`), split by owner relative to `organizationId`. */
async function publishedManualEntries(
  tx: DatabaseExecutor,
  organizationId: string,
): Promise<{ own: PublishedEntry[]; foreign: PublishedEntry[] }> {
  const rows = await tx
    .select({
      versionId: tlsCertificateVersions.id,
      organizationId: tlsCertificateVersions.organizationId,
      names: tlsCertificateVersions.sanDns,
    })
    .from(tlsCertificateVersions)
    .where(inArray(tlsCertificateVersions.status, ["applying", "active"]));
  const own: PublishedEntry[] = [];
  const foreign: PublishedEntry[] = [];
  for (const row of rows) (row.organizationId === organizationId ? own : foreign).push({ versionId: row.versionId, names: row.names });
  return { own, foreign };
}

// No ACME certificate exists yet for a host being added, so the capture check runs against an empty ACME set.
const captured = (hostname: string, entries: readonly PublishedEntry[]): boolean =>
  entries.length > 0 && findManualCaptures(hostname.toLowerCase(), entries, []).length > 0;

/**
 * Takes the TLS lock, then refuses when a published manual version of ANOTHER organization covers any hostname.
 * `code` is DOMAIN_CONFLICT for a new domain or site (no detail leaks) and CERTIFICATE_IN_USE for a site move.
 */
export async function assertNoForeignManualCoverage(
  tx: DatabaseExecutor,
  organizationId: string,
  hostnames: readonly string[],
  code: "DOMAIN_CONFLICT" | "CERTIFICATE_IN_USE",
): Promise<void> {
  await lockTlsPublishState(tx);
  if (hostnames.length === 0) return;
  const { foreign } = await publishedManualEntries(tx, organizationId);
  if (hostnames.some((host) => captured(host, foreign))) {
    throw new TlsCoverageError(code, "foreign_coverage", FOREIGN_COVERAGE_MESSAGE);
  }
}

/**
 * Takes the TLS lock, then refuses a new panel hostname that a published manual version would capture: of another
 * organization -> DOMAIN_CONFLICT (generic text); of the same organization -> CERTIFICATE_IN_USE `captures_host`
 * carrying the caller's own hostname.
 */
export async function assertNoManualCapture(
  tx: DatabaseExecutor,
  organizationId: string,
  hostnames: readonly string[],
): Promise<void> {
  await lockTlsPublishState(tx);
  if (hostnames.length === 0) return;
  const { own, foreign } = await publishedManualEntries(tx, organizationId);
  if (hostnames.some((host) => captured(host, foreign))) {
    throw new TlsCoverageError("DOMAIN_CONFLICT", "foreign_coverage", FOREIGN_COVERAGE_MESSAGE);
  }
  const hostname = hostnames.find((host) => captured(host, own));
  if (hostname !== undefined) {
    throw new TlsCoverageError(
      "CERTIFICATE_IN_USE",
      "captures_host",
      "An imported certificate already covers this web address. Assign that certificate to it instead.",
      hostname,
    );
  }
}

/**
 * True when any panel domain (any status) of an organization other than `organizationId` is covered by one of
 * `sanDns` (the names of a version about to be published). No lock: the caller holds the TLS lock.
 */
export async function foreignHostnamesCoveredBy(
  tx: DatabaseExecutor,
  organizationId: string,
  sanDns: readonly string[],
): Promise<boolean> {
  if (sanDns.length === 0) return false;
  const rows = await tx.select({ hostname: domains.hostname }).from(domains).where(ne(domains.organizationId, organizationId));
  return rows.some((row) => sanDns.some((name) => traefikNameMatches(row.hostname.toLowerCase(), name.toLowerCase())));
}

/**
 * Site-move pre-step (T9), run after the site row is locked: refuses while a domain of the site is in manual mode
 * and while a published manual version of any organization (the destination's own included) covers a hostname of the
 * site (CERTIFICATE_IN_USE). The site's domain rows are locked so an assignment settling meanwhile waits for the move.
 */
export async function assertSiteMovable(
  tx: DatabaseExecutor,
  input: { readonly siteId: string; readonly toOrganizationId: string },
): Promise<void> {
  const siteDomains = await tx
    .select({ hostname: domains.hostname, certMode: domains.certMode, versionId: domains.manualCertificateVersionId })
    .from(domains)
    .where(eq(domains.siteId, input.siteId))
    .for("update");
  if (siteDomains.some((d) => d.certMode === "manual" || d.versionId !== null)) {
    throw new TlsCoverageError(
      "CERTIFICATE_IN_USE",
      "manual_domain",
      "A domain of this site uses an imported certificate. Switch it back to the automatic certificate before moving the site.",
    );
  }
  const hostnames = siteDomains.map((d) => d.hostname);
  await assertNoForeignManualCoverage(tx, input.toOrganizationId, hostnames, "CERTIFICATE_IN_USE");
  // The destination's own published wildcard would capture the moved hosts too: they are not assigned to it.
  const { own } = await publishedManualEntries(tx, input.toOrganizationId);
  const hostname = hostnames.find((host) => captured(host, own));
  if (hostname !== undefined) {
    throw new TlsCoverageError(
      "CERTIFICATE_IN_USE",
      "captures_host",
      "An imported certificate of the new owner already covers this web address. Switch it off first, or use a narrower certificate.",
      hostname,
    );
  }
}
