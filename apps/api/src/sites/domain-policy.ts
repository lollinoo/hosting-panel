import { createHash } from "node:crypto";
import type { CertProblem, DnsStatus, SiteHostRoute } from "@hosting-panel/contracts";
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

export type DnsEvaluation = Exclude<DnsStatus, "unchecked" | "lookup_failed">;

export function evaluateDns(
  observed: { a: readonly string[]; aaaa: readonly string[] },
  serverIpv4: string,
): DnsEvaluation {
  if (observed.a.length === 0) return "not_found";
  if (observed.a.some((ip) => ip !== serverIpv4)) return "points_elsewhere";
  if (observed.aaaa.length > 0) return "ipv6_conflict";
  return "ok";
}

const MIN = 60_000;
const after = (now: Date, minutes: number): Date => new Date(now.getTime() + minutes * MIN);

/** `attempts` is the count BEFORE this failure is recorded; the caller increments afterwards. */
export function nextDnsCheckAt(now: Date, status: DnsStatus, attempts: number): Date {
  if (status === "ok") return after(now, 360);
  return after(now, [1, 2, 5, 10, 30, 60][attempts] ?? 360);
}

/** `attempts` is the count BEFORE this failure is recorded; the caller increments afterwards. */
export function certRetryAt(now: Date, problem: CertProblem, attempts: number): Date {
  if (problem === "rate_limited") return after(now, 1440);
  return after(now, [15, 60, 180, 360][attempts] ?? 1440);
}

/** A `requested` host with no certificate and no reported failure after this long counts as failed `other`. */
export const CERT_REQUEST_TIMEOUT_MS = 10 * MIN;
export const MANUAL_CHECK_MIN_INTERVAL_MS = 10_000;
export const MANUAL_CERT_RETRY_GAP_MS = 15 * MIN;

/** The earlier retry time "Check now" may set, or null for no change. */
export function manualCertRetryAt(
  now: Date,
  row: Pick<DomainRow, "certStatus" | "certProblem" | "certRequestedAt" | "certRetryAt">,
): Date | null {
  if (row.certStatus !== "failed" || row.certProblem === "rate_limited") return null;
  const earliest = Math.max(
    now.getTime(),
    (row.certRequestedAt?.getTime() ?? 0) + MANUAL_CERT_RETRY_GAP_MS,
  );
  const t = row.certRetryAt ? Math.min(earliest, row.certRetryAt.getTime()) : earliest;
  return new Date(t);
}
