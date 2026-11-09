import { createHash } from "node:crypto";
import type { SiteHostRoute } from "@hosting-panel/contracts";
import type { DomainRow } from "@hosting-panel/database";

export const SITE_DOMAINS_STEPS = [
  { key: "prepare", label: "Prepare the change" },
  { key: "update_address", label: "Update your site's address" },
  { key: "publish", label: "Publish the web addresses" },
] as const;

export interface RoutePlanOptions {
  /** Every host serves and nothing redirects: safe while WordPress switches address. */
  readonly transition?: boolean;
  /** False when the proxy has no certificate resolver: plain http only. */
  readonly acmeEnabled?: boolean;
}

/** A certificate is in the store and not expired. */
export function certificateUsable(row: DomainRow, now: Date): boolean {
  return row.certStatus === "active" && row.certExpiresAt !== null && row.certExpiresAt > now;
}

const hasTls = (row: DomainRow): boolean => row.certStatus === "active" || row.certStatus === "requested";

/** The routes of a site's routed domains; non-primary names redirect to the primary. */
export function buildSiteHostRoutes(
  rows: readonly DomainRow[],
  now: Date,
  opts: RoutePlanOptions = {},
): SiteHostRoute[] {
  const acme = opts.acmeEnabled ?? true;
  const routed = rows.filter((r) => r.status === "active");
  const primary = routed.find((r) => r.isPrimary);
  const target = primary ? `${acme && hasTls(primary) ? "https" : "http"}://${primary.hostname}` : null;
  return routed.map((row) => ({
    hostname: row.hostname,
    tls: acme && hasTls(row),
    httpsRedirect: acme && !opts.transition && certificateUsable(row, now),
    redirectTo: opts.transition || row.isPrimary ? null : target,
  }));
}

/** The address WordPress should have. Never moves an https site back to http. */
export function desiredWordpressUrl(
  rows: readonly DomainRow[],
  now: Date,
  currentUrl: string | null,
  acmeEnabled = true,
): string | null {
  const primary = rows.find((r) => r.isPrimary && r.status === "active");
  if (!primary) return null;
  const https = currentUrl?.startsWith("https://") === true || (acmeEnabled && certificateUsable(primary, now));
  return `${https ? "https" : "http"}://${primary.hostname}`;
}

export function routePlanHash(hosts: readonly SiteHostRoute[], wordpressUrl: string | null): string {
  // Fixed key order and host order: JSONB round trips reorder object keys.
  const canonical = [...hosts]
    .sort((a, b) => a.hostname.localeCompare(b.hostname))
    .map((h) => [h.hostname, h.tls, h.httpsRedirect, h.redirectTo]);
  return createHash("sha256").update(JSON.stringify({ hosts: canonical, wordpressUrl })).digest("hex");
}
