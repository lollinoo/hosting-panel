import {
  MANUAL_TLS_PUBLISH_MAX_HOSTS_PER_ENTRY,
  OPERATION_TERMINAL_STATUSES,
  TLS_VALIDITY_MARGIN_MS,
  planManualCertificates,
  traefikNameMatches,
  type CertChallenge,
  type ManualSniEntry,
  type SniCertificate,
  type SniViolation,
} from "@hosting-panel/contracts";
import {
  and,
  domains,
  enqueueOperationTransactional,
  eq,
  gte,
  hosts,
  inArray,
  listAppStackHostnames,
  lockTlsPublishState,
  not,
  operations,
  outboxEvents,
  sites,
  sql,
  tlsCertificateVersions,
  type DatabaseExecutor,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import { ControlPlaneError } from "../common/control-plane.error.js";

// HCP-SPEC-004 D6/A3/A5: the synchronous half of "assign an imported certificate to domains" (or hand a domain back
// to ACME). `checkAssignment` refuses what can be refused from the database alone; the executor re-decides at
// publish time from the real acme.json. `enqueueSiteTlsOperation` queues the `site.tls.apply` run. Both run in the
// caller's transaction. Lock order, always: site row -> TLS publish state row. Nothing here reads key material, and
// no refusal text carries a hostname except the caller's own (details `message` of CERTIFICATE_HOSTNAME_MISMATCH
// and CERTIFICATE_IN_USE/captures_host).

export const TLS_APPLY_STEPS = [
  { key: "stage", label: "Send the certificate to the server" },
  { key: "publish", label: "Start serving the certificate" },
  { key: "routes", label: "Update the web addresses" },
] as const;

/** Server-wide cap of non-terminal `site.tls.apply` operations (D5). */
export const TLS_APPLY_MAX_ACTIVE = 2;
/** Per-organisation cap: one tenant cannot hold both server slots. */
export const TLS_APPLY_MAX_PER_ORGANIZATION = 1;
export const TLS_APPLY_RETRY_AFTER_MS = 30_000;
/** Administrator-confirmed ACME eviction: at most one per server per window (A7). */
export const TLS_EVICT_WINDOW_MS = 15 * 60_000;

const NOT_FOUND_MESSAGE = "Requested organization or resource was not found.";
// Same text as a domain add that collides with another site: it never names the certificate or its owner.
const FOREIGN_COVERAGE_MESSAGE =
  "This web address is already used by another site or by the panel. Remove it from the other site first, or ask your administrator.";

/** One requested change: the domain moves to the manual `versionId`, or back to ACME when it is null. */
export interface TlsChange {
  readonly domainId: string;
  readonly versionId: string | null;
}

export interface AssignmentInput {
  readonly organizationId: string;
  readonly siteId: string;
  readonly changes: readonly TlsChange[];
  /**
   * The changes may name domains of any site of the organisation (a rotation or an assignment that spans sites):
   * every involved site is locked, in id order. The caller has already checked `site.certificates.manage` on each.
   */
  readonly crossSite?: boolean;
  /** The administrator confirmed a cold ACME cleanup: eviction-induced captures are checked, not ignored. */
  readonly evictAcme?: boolean;
  /** Injectable clock for the 24 h margin. */
  readonly now?: Date;
}

export interface AssignmentDomainChange {
  readonly domainId: string;
  readonly siteId: string;
  readonly hostname: string;
  /** The manual version the domain serves now; null while it uses ACME. */
  readonly fromVersionId: string | null;
  readonly versionId: string | null;
}

export interface AssignmentPlan {
  /** True when every requested change already holds: answer 202 without an operation. */
  readonly noop: boolean;
  /** Only the changes that alter a domain, in request order. Empty when `noop`. */
  readonly changes: readonly TlsChange[];
  readonly domains: readonly AssignmentDomainChange[];
  /** Distinct manual versions the changed domains serve now. */
  readonly fromVersionIds: readonly string[];
  /** Assigned hosts whose ACME certificate (DB approximation) outranks the manual one: eviction would be needed. */
  readonly evictAcmeHosts: readonly string[];
  /** Other names of the ACME entries that would be evicted; they stay ACME and must not be captured. */
  readonly collateralHosts: readonly string[];
}

const notFound = (): ControlPlaneError => new ControlPlaneError("NOT_FOUND", NOT_FOUND_MESSAGE);

const lc = (value: string): string => value.toLowerCase();

/**
 * Validates `changes` against the database and the SNI model. Throws ControlPlaneError:
 * NOT_FOUND (site, domain or version outside the organization), VALIDATION_ERROR `domain_not_active`,
 * CERTIFICATE_HOSTNAME_MISMATCH `not_covered`, CERTIFICATE_EXPIRED `expired|expires_within_24h`,
 * DOMAIN_CONFLICT (a name of the version covers a host of another organization or the panel),
 * CERTIFICATE_SNI_MISMATCH `manual_overlap`, CERTIFICATE_IN_USE `captures_host`.
 * Takes the site row and then the TLS publish state row `FOR UPDATE` (the lock every site.domains writer holds).
 */
export async function checkAssignment(tx: DatabaseExecutor, input: AssignmentInput): Promise<AssignmentPlan> {
  const now = input.now ?? new Date();
  const { organizationId, siteId } = input;

  const requested = new Map<string, string | null>();
  for (const change of input.changes) {
    if (requested.has(change.domainId) && requested.get(change.domainId) !== change.versionId) {
      throw new ControlPlaneError("VALIDATION_ERROR", "A domain can only be changed once per request.", {
        details: [{ field: "changes", message: "A domain can only be changed once per request." }],
      });
    }
    requested.set(change.domainId, change.versionId);
  }

  // Sites to lock: the requesting one, plus (cross-site) the sites of the named domains of this organisation. Always
  // in id order, so two requests spanning the same sites cannot deadlock; the TLS state row comes after.
  const siteIds = new Set([siteId]);
  if (input.crossSite === true && requested.size > 0) {
    const named = await tx
      .select({ siteId: domains.siteId })
      .from(domains)
      .where(and(inArray(domains.id, [...requested.keys()]), eq(domains.organizationId, organizationId)));
    for (const row of named) siteIds.add(row.siteId);
  }
  const lockedSites = await tx
    .select({ id: sites.id })
    .from(sites)
    .where(and(inArray(sites.id, [...siteIds]), eq(sites.organizationId, organizationId)))
    .orderBy(sites.id)
    .for("update");
  if (!lockedSites.some((s) => s.id === siteId)) throw notFound();
  await lockTlsPublishState(tx);

  // Every panel domain: the SNI model needs the whole fleet (cross-tenant coverage, ACME approximation, guards).
  const allDomains = await tx
    .select({
      id: domains.id,
      hostname: domains.hostname,
      organizationId: domains.organizationId,
      siteId: domains.siteId,
      status: domains.status,
      certMode: domains.certMode,
      certStatus: domains.certStatus,
      manualVersionId: domains.manualCertificateVersionId,
    })
    .from(domains);
  const byId = new Map(allDomains.map((d) => [d.id, d]));
  const own = (domainId: string) => {
    const row = byId.get(domainId);
    return row && (input.crossSite === true || row.siteId === siteId) && row.organizationId === organizationId ? row : undefined;
  };
  for (const domainId of requested.keys()) if (!own(domainId)) throw notFound();

  const wantedVersionIds = [...new Set([...requested.values()].filter((v): v is string => v !== null))];
  const versions = wantedVersionIds.length
    ? await tx
        .select({
          id: tlsCertificateVersions.id,
          sanDns: tlsCertificateVersions.sanDns,
          notAfter: tlsCertificateVersions.notAfter,
        })
        .from(tlsCertificateVersions)
        .where(
          and(inArray(tlsCertificateVersions.id, wantedVersionIds), eq(tlsCertificateVersions.organizationId, organizationId)),
        )
    : [];
  const versionById = new Map(versions.map((v) => [v.id, v]));
  for (const id of wantedVersionIds) if (!versionById.has(id)) throw notFound();

  const changed: AssignmentDomainChange[] = [];
  for (const [domainId, versionId] of requested) {
    const domain = own(domainId)!;
    const fromVersionId = domain.certMode === "manual" ? domain.manualVersionId : null;
    if (versionId === fromVersionId) continue; // already in that state
    if (versionId !== null) {
      const version = versionById.get(versionId)!;
      if (domain.status !== "active") {
        throw new ControlPlaneError("VALIDATION_ERROR", "This web address is not active yet.", {
          details: [{ field: "domainIds", reason: "domain_not_active", message: "This web address is not active yet." }],
        });
      }
      if (!version.sanDns.some((name) => traefikNameMatches(domain.hostname, name))) {
        throw new ControlPlaneError("CERTIFICATE_HOSTNAME_MISMATCH", "The certificate does not cover this web address.", {
          details: [{ field: "domainIds", reason: "not_covered", message: domain.hostname }],
        });
      }
      const left = version.notAfter.getTime() - now.getTime();
      if (left < TLS_VALIDITY_MARGIN_MS) {
        const reason = left <= 0 ? "expired" : "expires_within_24h";
        throw new ControlPlaneError(
          "CERTIFICATE_EXPIRED",
          left <= 0 ? "The certificate has expired." : "The certificate expires within 24 hours.",
          { details: [{ field: "versionId", reason, message: "The certificate cannot be used." }] },
        );
      }
    }
    changed.push({ domainId, siteId: domain.siteId, hostname: lc(domain.hostname), fromVersionId, versionId });
  }
  if (changed.length === 0) {
    return { noop: true, changes: [], domains: [], fromVersionIds: [], evictAcmeHosts: [], collateralHosts: [] };
  }

  // Cross-tenant (D7): no name of an assigned version may match a panel host of another organization or the panel.
  const panelHosts = await tx.select({ hostname: hosts.hostname }).from(hosts);
  // Application web addresses (ADR-0035): ACME-only, never assignable, but no manual certificate may cover them.
  const stackHosts = await listAppStackHostnames(tx);
  const assignedVersions = [...new Set(changed.flatMap((c) => (c.versionId === null ? [] : [c.versionId])))];
  for (const versionId of assignedVersions) {
    const names = versionById.get(versionId)!.sanDns;
    const foreign = [
      ...allDomains.filter((d) => d.organizationId !== organizationId),
      ...stackHosts.filter((h) => h.organizationId !== organizationId),
      ...panelHosts,
    ].some((h) => names.some((name) => traefikNameMatches(h.hostname, name)));
    if (foreign) throw new ControlPlaneError("DOMAIN_CONFLICT", FOREIGN_COVERAGE_MESSAGE);
  }

  // A3: the SNI plan for the manual set after the change (domain rows flip only at settle, so the overlay is ours).
  const overlay = new Map(changed.map((c) => [c.domainId, c.versionId]));
  const assignedAfter = new Map<string, string[]>(); // versionId -> hostnames
  const acmeAfterActive: string[] = []; // routed ACME-mode hosts after the change: they must stay off manual
  for (const d of allDomains) {
    const after = overlay.has(d.id) ? overlay.get(d.id)! : d.certMode === "manual" ? d.manualVersionId : null;
    if (after !== null) assignedAfter.set(after, [...(assignedAfter.get(after) ?? []), lc(d.hostname)]);
    else if (d.status === "active") acmeAfterActive.push(lc(d.hostname));
  }
  // The executor takes at most MANUAL_TLS_PUBLISH_MAX_HOSTS_PER_ENTRY hosts per version: refuse here, not as a late
  // generic apply failure. Closest catalogued reason: too_many_sans (a certificate that would serve too many names).
  if ([...assignedAfter.values()].some((hostnames) => new Set(hostnames).size > MANUAL_TLS_PUBLISH_MAX_HOSTS_PER_ENTRY)) {
    throw new ControlPlaneError("VALIDATION_ERROR", "This certificate would serve too many web addresses.", {
      details: [{ field: "domainIds", reason: "too_many_sans", message: "Too many web addresses for one certificate." }],
    });
  }
  const entryVersionIds = [...assignedAfter.keys()];
  const entryVersions = entryVersionIds.length
    ? await tx
        .select({ id: tlsCertificateVersions.id, sanDns: tlsCertificateVersions.sanDns })
        .from(tlsCertificateVersions)
        .where(inArray(tlsCertificateVersions.id, entryVersionIds))
    : [];
  const entries: ManualSniEntry[] = entryVersions.map((v) => ({
    versionId: v.id,
    names: v.sanDns,
    assignedHosts: assignedAfter.get(v.id) ?? [],
  }));
  // DB approximation of acme.json: an ACME-mode domain with an issued certificate has an exact-host entry. Taken
  // before the change, so a host leaving ACME still counts (its entry stays until an administrator evicts it).
  const acme: SniCertificate[] = allDomains
    .filter((d) => d.certMode === "acme" && d.certStatus === "active")
    .map((d) => ({ id: d.id, source: "acme", names: [lc(d.hostname)] }));
  const plan = planManualCertificates({
    entries,
    acme,
    guardHosts: [
      ...acmeAfterActive,
      ...stackHosts.filter((h) => h.status === "active").map((h) => lc(h.hostname)),
      ...panelHosts.map((h) => lc(h.hostname)),
    ],
  });

  const evictAcmeHosts = [
    ...new Set(plan.violations.filter((v) => v.kind === "acme_eviction_required").map((v) => lc(v.hostname))),
  ].sort();
  const collateral = new Set(plan.collateralHosts);
  // Without the administrator's confirmation nothing is evicted, so captures that only exist after an eviction are
  // not real; the executor refuses the publish itself when the real acme.json needs the cleanup.
  const blocking = plan.violations.filter(
    (v) => v.kind !== "acme_eviction_required" && !(input.evictAcme !== true && v.kind === "captures_host" && collateral.has(lc(v.hostname))),
  );
  refuseViolations(blocking, allDomains, organizationId);

  return {
    noop: false,
    changes: changed.map((c) => ({ domainId: c.domainId, versionId: c.versionId })),
    domains: changed,
    fromVersionIds: [...new Set(changed.flatMap((c) => (c.fromVersionId === null ? [] : [c.fromVersionId])))],
    evictAcmeHosts,
    collateralHosts: [...plan.collateralHosts],
  };
}

function refuseViolations(
  violations: readonly SniViolation[],
  allDomains: readonly { readonly hostname: string; readonly organizationId: string }[],
  organizationId: string,
): void {
  const overlap = violations.find((v) => v.kind === "manual_overlap");
  if (overlap) {
    throw new ControlPlaneError(
      "CERTIFICATE_SNI_MISMATCH",
      "Another imported certificate would be served for the same web address. Use one certificate for these web addresses.",
      { details: [{ field: "domainIds", reason: "manual_overlap", message: "Certificates overlap." }] },
    );
  }
  const capture = violations.find((v) => v.kind === "captures_host");
  if (capture) {
    const host = lc(capture.hostname);
    const owner = allDomains.find((d) => lc(d.hostname) === host);
    if (owner?.organizationId === organizationId) {
      throw new ControlPlaneError(
        "CERTIFICATE_IN_USE",
        "This certificate would also be served for another of your web addresses. Assign it to that address too, or use a narrower certificate.",
        { details: [{ field: "domainIds", reason: "captures_host", message: owner.hostname }] },
      );
    }
    throw new ControlPlaneError("DOMAIN_CONFLICT", FOREIGN_COVERAGE_MESSAGE);
  }
}

export interface EnqueueTlsInput {
  readonly organizationId: string;
  readonly siteId: string;
  /** The effective changes of `checkAssignment` (never empty). */
  readonly changes: readonly TlsChange[];
  readonly requestedByUserId?: string;
  readonly idempotencyKey?: string;
  readonly requestHash?: string;
  readonly evictAcme?: boolean;
  /** Admin ACME branch: the challenge to record for the domains going back to ACME. */
  readonly challenge?: CertChallenge;
  readonly now?: Date;
}

/**
 * Queues `site.tls.apply` under the site lock in the caller's transaction (ids-only payload) and moves the target
 * versions `pending|inactive|failed -> applying`. Refuses with RATE_LIMITED when two `site.tls.apply` operations are
 * already non-terminal on the server or one on the organisation (retryAfterMs 30 s) or an `evictAcme` run started in the last 15 minutes; the
 * counts are read under the TLS lock row. Another operation holding `site:<id>` is RESOURCE_LOCKED (from the
 * repository). A replay of an Idempotency-Key skips the caps and the version update and returns the stored operation.
 */
export async function enqueueSiteTlsOperation(tx: DatabaseExecutor, input: EnqueueTlsInput) {
  if (input.changes.length === 0) throw new Error("enqueueSiteTlsOperation needs at least one change.");
  const now = input.now ?? new Date();
  await lockTlsPublishState(tx);

  const replayed =
    input.idempotencyKey === undefined
      ? false
      : (
          await tx
            .select({ id: operations.id })
            .from(operations)
            .where(and(eq(operations.organizationId, input.organizationId), eq(operations.idempotencyKey, input.idempotencyKey)))
            .limit(1)
        ).length > 0;

  if (!replayed) {
    const [active] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(operations)
      .where(
        and(
          eq(operations.kind, "site.tls.apply"),
          sql`${operations.status} NOT IN (${sql.join(OPERATION_TERMINAL_STATUSES.map((s) => sql`${s}`), sql`, `)})`,
        ),
      );
    const [ofOrganization] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(operations)
      .where(
        and(
          eq(operations.kind, "site.tls.apply"),
          eq(operations.organizationId, input.organizationId),
          // The requesting site's own run is the site lock's business (RESOURCE_LOCKED), not this cap's.
          not(eq(operations.resourceId, input.siteId)),
          sql`${operations.status} NOT IN (${sql.join(OPERATION_TERMINAL_STATUSES.map((s) => sql`${s}`), sql`, `)})`,
        ),
      );
    if ((active?.count ?? 0) >= TLS_APPLY_MAX_ACTIVE || (ofOrganization?.count ?? 0) >= TLS_APPLY_MAX_PER_ORGANIZATION) {
      throw new ControlPlaneError("RATE_LIMITED", "Other certificate changes are in progress. Try again in a moment.", {
        retryable: true,
        retryAfterMs: TLS_APPLY_RETRY_AFTER_MS,
      });
    }
    if (input.evictAcme === true) {
      const since = new Date(now.getTime() - TLS_EVICT_WINDOW_MS);
      const [oldest] = await tx
        .select({ at: sql<Date>`min(${outboxEvents.createdAt})` })
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.eventType, "operation.queued.site.tls.apply"),
            sql`${outboxEvents.payload}->>'evictAcme' = 'true'`,
            gte(outboxEvents.createdAt, since),
          ),
        );
      if (oldest?.at) {
        const retryAfterMs = Math.max(1_000, new Date(oldest.at).getTime() + TLS_EVICT_WINDOW_MS - now.getTime());
        throw new ControlPlaneError("RATE_LIMITED", "A certificate cleanup was started recently. Try again later.", {
          retryable: true,
          retryAfterMs,
        });
      }
    }
  }

  const enqueued = await enqueueOperationTransactional(tx as unknown as HostingPanelDatabase, {
    organizationId: input.organizationId,
    kind: "site.tls.apply",
    resourceType: "site",
    resourceId: input.siteId,
    ...(input.requestedByUserId ? { requestedByUserId: input.requestedByUserId } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    ...(input.requestHash ? { requestHash: input.requestHash } : {}),
    lockKey: `site:${input.siteId}`,
    steps: TLS_APPLY_STEPS,
    outboxPayload: {
      siteId: input.siteId,
      changes: input.changes.map((c) => ({ domainId: c.domainId, versionId: c.versionId })),
      ...(input.evictAcme === true ? { evictAcme: true } : {}),
      ...(input.challenge ? { challenge: input.challenge } : {}),
    },
  });

  if (!enqueued.idempotentReplay) {
    const versionIds = [...new Set(input.changes.flatMap((c) => (c.versionId === null ? [] : [c.versionId])))];
    if (versionIds.length > 0) {
      await tx
        .update(tlsCertificateVersions)
        .set({ status: "applying", lastErrorCode: null })
        .where(
          and(
            inArray(tlsCertificateVersions.id, versionIds),
            inArray(tlsCertificateVersions.status, ["pending", "inactive", "failed"]),
          ),
        );
    }
  }
  return enqueued;
}
