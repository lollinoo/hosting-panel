import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  SITE_TYPE_KEYS,
  MAX_SITE_DOMAINS,
  wwwPartner,
  type AddSiteDomainInput,
  type CertChallenge,
  type CertProblem,
  type SiteDomainsDto,
  type SiteDomainTlsDto,
} from "@hosting-panel/contracts";
import {
  and,
  assertNoForeignManualCoverage,
  assertNoManualCapture,
  auditEvents,
  bumpTlsDesiredGeneration,
  desc,
  domains,
  eq,
  gte,
  hostAllocations,
  hosts,
  inArray,
  insertSiteDomains,
  listSiteDomains,
  listSiteManualTls,
  not,
  operations,
  or,
  sites,
  sql,
  TlsCoverageError,
  type DatabaseClient,
  type DatabaseExecutor,
  type DomainManualTlsRow,
  type DomainRow,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
import { checkAssignment, enqueueSiteTlsOperation } from "../certificates/tls-assignment.js";
import { canonicalRequestHash } from "../common/request-hash.js";
import { lockDnsProviderRow } from "../certificates/dns-provider.service.js";
import { ControlPlaneError } from "../common/control-plane.error.js";
import { DATABASE_CLIENT_TOKEN, DOCKER_EXECUTOR_TOKEN } from "../tokens.js";
import {
  MANUAL_CHECK_MIN_INTERVAL_MS,
  certRetryAt,
  certificateUsable,
  manualCertRetryAt,
  routesPending,
} from "./domain-policy.js";
import { DomainReconcilerService } from "./domain-reconciler.service.js";
import { MailRelayService } from "../mail/mail-relay.service.js";

const CONFLICT =
  "This web address is already used by another site or by the panel. Remove it from the other site first, or ask your administrator.";
const THROTTLE_MEMORY_MS = 24 * 3600_000;
const notFound = () => new ControlPlaneError("NOT_FOUND", "Requested organization or resource was not found.");

const isUniqueViolation = (err: unknown): boolean => {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
};

/**
 * The coverage guards of the database throw `TlsCoverageError`; the public form carries the reason, and the
 * hostname only when it is the caller's own (`captures_host`). Any other error passes through unchanged.
 */
export function coverageError(err: unknown): unknown {
  if (!(err instanceof TlsCoverageError)) return err;
  if (err.code === "DOMAIN_CONFLICT") return new ControlPlaneError("DOMAIN_CONFLICT", CONFLICT);
  const message = err.reason === "captures_host" && err.hostname ? err.hostname : err.message;
  return new ControlPlaneError("CERTIFICATE_IN_USE", err.message, {
    details: [{ field: "hostname", reason: err.reason, message }],
  });
}

/** Who asked, for the assignment operation of an add that names an imported certificate. */
export interface DomainAddActor {
  readonly requestedByUserId?: string;
  readonly idempotencyKey?: string;
  /** Writes an audit row on the given transaction (the caller adds actor and request context). */
  readonly audit?: (
    tx: DatabaseExecutor,
    event: { readonly action: string; readonly targetType: string; readonly targetId: string; readonly details: Record<string, unknown> },
  ) => Promise<void>;
}

/** The names an add asks for: the hostname, plus its www partner with `includeWww`. */
export function requestedHostnames(input: AddSiteDomainInput): string[] {
  const partner = input.includeWww ? wwwPartner(input.hostname) : null;
  return partner ? [input.hostname, partner] : [input.hostname];
}

/** The `tls` block of a domain: automatic rows are all null, a manual row shows its version, the apply state and the version's last problem. */
export function domainTlsDto(row: DomainRow, manual: DomainManualTlsRow | undefined): SiteDomainTlsDto {
  if (row.certMode !== "manual") return { mode: "acme", certificateId: null, versionId: null, state: null, problem: null };
  return {
    mode: "manual",
    certificateId: manual?.certificateId ?? null,
    versionId: manual?.versionId ?? row.manualCertificateVersionId,
    state: row.certStatus === "active" ? "active" : row.certStatus === "failed" ? "failed" : "applying",
    problem: manual?.lastErrorCode ?? null,
  };
}

/**
 * Let's Encrypt limits are per name and per account (shared by the whole server), so a name removed and
 * added again keeps the request and failure history of its last 24 h, read back from the audit trail.
 * Every insert into `domains` for a managed site calls this, in the inserting transaction.
 */
export async function restoreCertificateThrottle(tx: HostingPanelDatabase, rows: readonly DomainRow[]): Promise<void> {
  if (rows.length === 0) return;
  const hostname = sql<string>`${auditEvents.details}->>'hostname'`;
  const events = await tx
    .select({ action: auditEvents.action, hostname, problem: sql<CertProblem>`${auditEvents.details}->>'problem'`, at: auditEvents.timestamp })
    .from(auditEvents)
    .where(
      and(
        inArray(auditEvents.action, ["site.certificate.requested", "site.certificate.failed"]),
        gte(auditEvents.timestamp, new Date(Date.now() - THROTTLE_MEMORY_MS)),
        inArray(hostname, rows.map((r) => r.hostname)),
      ),
    )
    .orderBy(desc(auditEvents.timestamp));
  for (const row of rows) {
    const own = events.filter((e) => e.hostname === row.hostname);
    const requested = own.find((e) => e.action === "site.certificate.requested");
    const failures = own.filter((e) => e.action === "site.certificate.failed");
    const last = failures[0];
    if (!requested && !last) continue;
    await tx
      .update(domains)
      .set({
        certRequestedAt: requested?.at ?? last?.at ?? null,
        ...(last
          ? {
              certStatus: "failed" as const,
              certProblem: last.problem,
              certAttempts: failures.length,
              certRetryAt: certRetryAt(last.at, last.problem, failures.length - 1),
            }
          : {}),
      })
      .where(eq(domains.id, row.id));
  }
}

/** Every method takes a site id already authorized for `organizationId`. */
@Injectable()
export class SiteDomainsService {
  readonly #logger = new Logger(SiteDomainsService.name);

  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(DOCKER_EXECUTOR_TOKEN) private readonly executor: DockerExecutorPort,
    @Inject(DomainReconcilerService) private readonly reconciler: DomainReconcilerService,
    @Inject(MailRelayService) private readonly mailRelay: MailRelayService,
  ) {}

  public async list(siteId: string, organizationId: string): Promise<SiteDomainsDto> {
    const db = this.dbClient.db;
    const site = await this.#site(siteId, organizationId);
    const rows = await listSiteDomains(db, siteId);
    const manual = new Map((await listSiteManualTls(db, siteId)).map((m) => [m.domainId, m]));
    const now = new Date();
    return {
      serverIpv4: site.ipv4,
      routesPending: routesPending(rows, now, site.site, await this.#acmeEnabled()),
      domains: rows.map((r) => ({
        id: r.id,
        hostname: r.hostname,
        isPrimary: r.isPrimary,
        routed: r.status === "active",
        challenge: r.certChallenge,
        dns: {
          status: r.dnsStatus,
          checkedAt: r.dnsCheckedAt?.toISOString() ?? null,
          nextCheckAt: r.dnsNextCheckAt.toISOString(),
          observedA: r.dnsObserved.a,
          observedAaaa: r.dnsObserved.aaaa,
        },
        certificate: {
          status: r.certStatus,
          problem: r.certProblem,
          expiresAt: r.certExpiresAt?.toISOString() ?? null,
          retryAt: r.certRetryAt?.toISOString() ?? null,
          trusted: r.certTrusted,
        },
        tls: domainTlsDto(r, manual.get(r.id)),
      })),
      mail: await this.mailRelay.customerView(),
    };
  }

  /** The domain row, or NOT_FOUND when it is not on this site. */
  public async findDomain(siteId: string, organizationId: string, domainId: string): Promise<DomainRow> {
    await this.#site(siteId, organizationId);
    const [row] = await this.dbClient.db
      .select()
      .from(domains)
      .where(and(eq(domains.id, domainId), eq(domains.siteId, siteId)))
      .limit(1);
    if (!row) throw notFound();
    return row;
  }

  /**
   * Admin only. A failed order starts over (not a rate limit); the 15-min gap stays, as certRequestedAt is kept.
   * `changed` is false when the domain already had this challenge.
   */
  public async setChallenge(
    siteId: string,
    organizationId: string,
    domainId: string,
    challenge: CertChallenge,
  ): Promise<{ changed: boolean; data: SiteDomainsDto }> {
    await this.#site(siteId, organizationId);
    // The domain row is locked, so the reconciler cannot move it between the read and the write.
    const changed = await this.dbClient.db.transaction(async (tx) => {
      const t = tx as unknown as HostingPanelDatabase;
      const [row] = await t
        .select()
        .from(domains)
        .where(and(eq(domains.id, domainId), eq(domains.siteId, siteId)))
        .for("update");
      if (!row) throw notFound();
      if (row.certChallenge === challenge) return false;
      if (challenge === "dns-01" && !(await lockDnsProviderRow(t))) {
        const message = "Set up a DNS provider first.";
        throw new ControlPlaneError("VALIDATION_ERROR", message, { details: [{ message, reason: "dns_provider_missing" }] });
      }
      // A manual row keeps its state: the challenge is only remembered for the return to automatic certificates.
      const reset = row.certMode !== "manual" && row.certStatus === "failed" && row.certProblem !== "rate_limited";
      await t
        .update(domains)
        .set({
          certChallenge: challenge,
          ...(reset ? { certStatus: "none" as const, certProblem: null, certRetryAt: null } : {}),
          updatedAt: new Date(),
        })
        .where(eq(domains.id, row.id));
      return true;
    });
    if (changed) await this.#reconcile(siteId, []);
    return { changed, data: await this.list(siteId, organizationId) };
  }

  /** Names already on this site are skipped, so a repeated call changes nothing. */
  public async add(
    siteId: string,
    organizationId: string,
    input: AddSiteDomainInput,
    actor: DomainAddActor = {},
  ): Promise<SiteDomainsDto> {
    const names = requestedHostnames(input);
    // The key is bound to this body: the same key with another address or certificate is IDEMPOTENCY_CONFLICT.
    const requestHash = canonicalRequestHash({ route: "tls.domain.add", siteId, hostnames: names, tlsVersionId: input.tlsVersionId });
    if (input.tlsVersionId !== undefined && actor.idempotencyKey) {
      // Checked before the assignment: a version already applying would otherwise answer CERTIFICATE_IN_USE.
      const [previous] = await this.dbClient.db
        .select({ requestHash: operations.requestHash })
        .from(operations)
        .where(and(eq(operations.organizationId, organizationId), eq(operations.idempotencyKey, actor.idempotencyKey)))
        .limit(1);
      if (previous && previous.requestHash !== requestHash) {
        throw new ControlPlaneError("IDEMPOTENCY_CONFLICT", "The idempotency key was already used for a different request.");
      }
      if (previous) return this.list(siteId, organizationId);
    }
    let inserted: DomainRow[];
    try {
      inserted = await this.#locked(siteId, organizationId, async (tx, rows) => {
        const fresh = names.filter((n) => !rows.some((r) => r.hostname === n));
        if (fresh.length === 0) return [];
        const [elsewhere] = await tx
          .select({ id: domains.id })
          .from(domains)
          .where(and(inArray(domains.hostname, fresh), not(eq(domains.siteId, siteId))))
          .limit(1);
        const [panel] = await tx
          .select({ id: hosts.id })
          .from(hosts)
          .where(or(inArray(hosts.hostname, fresh), inArray(hosts.ipv4Address, fresh)))
          .limit(1);
        if (elsewhere || panel) throw new ControlPlaneError("DOMAIN_CONFLICT", CONFLICT);
        if (rows.length + fresh.length > MAX_SITE_DOMAINS) {
          throw new ControlPlaneError("VALIDATION_ERROR", "A site can have up to 10 web addresses. Remove one first.", { details: [{ message: "A site can have up to 10 web addresses. Remove one first.", reason: "domain_limit" }] });
        }
        const routed = rows.some((r) => r.isPrimary && r.status === "active");
        // A published manual certificate must not capture the new name. On a named version the capture is the
        // point (the new name joins it below, checked as an assignment); another organisation's coverage never is.
        if (input.tlsVersionId === undefined) await assertNoManualCapture(tx, organizationId, fresh);
        else await assertNoForeignManualCoverage(tx, organizationId, fresh, "DOMAIN_CONFLICT");
        const created = await insertSiteDomains(tx, { siteId, organizationId, hostnames: fresh, routed });
        await restoreCertificateThrottle(tx, created);
        if (input.tlsVersionId !== undefined) {
          // Rows flip when the operation settles; the same transaction keeps the domain and its assignment together.
          const plan = await checkAssignment(tx, {
            organizationId,
            siteId,
            changes: created.map((r) => ({ domainId: r.id, versionId: input.tlsVersionId! })),
          });
          const { audit, ...queue } = actor;
          const enqueued = await enqueueSiteTlsOperation(tx, { organizationId, siteId, changes: plan.changes, requestHash, ...queue });
          // The assignment is audited with the domain and the operation, like the assign routes do.
          if (audit && !enqueued.idempotentReplay) {
            await audit(tx, {
              action: "site.tls_certificate.assign",
              targetType: "site",
              targetId: siteId,
              details: {
                operationId: enqueued.operation.id,
                siteId,
                domainIds: plan.changes.map((c) => c.domainId),
                versionId: input.tlsVersionId,
                fromVersionIds: [],
              },
            });
          }
        }
        return created;
      });
    } catch (err) {
      // Another site took the name between the check and the insert.
      if (isUniqueViolation(err)) throw new ControlPlaneError("DOMAIN_CONFLICT", CONFLICT);
      throw coverageError(err);
    }
    if (inserted.length > 0) await this.#reconcile(siteId, inserted.map((r) => r.id));
    return this.list(siteId, organizationId);
  }

  public async remove(siteId: string, organizationId: string, domainId: string): Promise<SiteDomainsDto> {
    await this.#locked(siteId, organizationId, async (tx, rows) => {
      const row = rows.find((r) => r.id === domainId);
      if (!row) throw notFound();
      if (rows.length === 1) throw new ControlPlaneError("VALIDATION_ERROR", "A site needs at least one web address.", { details: [{ message: "A site needs at least one web address.", reason: "last_domain" }] });
      if (row.isPrimary) {
        throw new ControlPlaneError("VALIDATION_ERROR", "Choose another main address first, then remove this one.", { details: [{ message: "Choose another main address first, then remove this one.", reason: "primary_domain" }] });
      }
      await tx.delete(domains).where(eq(domains.id, domainId));
      // The manual set shrinks: the next convergence stops serving the certificate for this name.
      if (row.certMode === "manual") await bumpTlsDesiredGeneration(tx);
    });
    await this.#reconcile(siteId, []);
    return this.list(siteId, organizationId);
  }

  public async setPrimary(siteId: string, organizationId: string, domainId: string): Promise<SiteDomainsDto> {
    await this.#locked(siteId, organizationId, async (tx, rows, site) => {
      const row = rows.find((r) => r.id === domainId);
      if (!row) throw notFound();
      if (row.isPrimary) return;
      // Never move an https site to a name without a working certificate: WordPress would go back to http.
      if (site.siteUrl?.startsWith("https://") && !certificateUsable(row, new Date())) {
        throw new ControlPlaneError(
          "VALIDATION_ERROR",
          "Wait until HTTPS is active on this address, then make it the main address.", { details: [{ message: "Wait until HTTPS is active on this address, then make it the main address.", reason: "needs_https" }] },
        );
      }
      // Clear first: the one-primary-per-site index would refuse two at once.
      await tx.update(domains).set({ isPrimary: false, updatedAt: new Date() }).where(eq(domains.siteId, siteId));
      await tx.update(domains).set({ isPrimary: true, updatedAt: new Date() }).where(eq(domains.id, domainId));
    });
    await this.#reconcile(siteId, []);
    return this.list(siteId, organizationId);
  }

  public async check(siteId: string, organizationId: string, domainId: string): Promise<SiteDomainsDto> {
    const row = await this.findDomain(siteId, organizationId, domainId);
    const now = new Date();
    if (row.dnsCheckedAt && now.getTime() - row.dnsCheckedAt.getTime() < MANUAL_CHECK_MIN_INTERVAL_MS) {
      return this.list(siteId, organizationId);
    }
    const retryAt = manualCertRetryAt(now, row);
    await this.dbClient.db
      .update(domains)
      .set({ dnsAttempts: 0, ...(retryAt ? { certRetryAt: retryAt } : {}), updatedAt: now })
      // Guarded on the state read: a certificate change in between keeps its own retry time.
      .where(and(eq(domains.id, row.id), eq(domains.certStatus, row.certStatus)));
    // Only this name is looked up now: the per-row throttle above must not open a check of every name.
    await this.#reconcile(siteId, [row.id]);
    return this.list(siteId, organizationId);
  }

  async #site(siteId: string, organizationId: string) {
    const [site] = await this.dbClient.db
      .select({ site: sites, ipv4: hosts.ipv4Address })
      .from(sites)
      .innerJoin(hostAllocations, eq(hostAllocations.id, sites.hostAllocationId))
      .innerJoin(hosts, eq(hosts.id, hostAllocations.hostId))
      .where(and(eq(sites.id, siteId), eq(sites.organizationId, organizationId), inArray(sites.siteType, [...SITE_TYPE_KEYS])))
      .limit(1);
    if (!site) throw notFound();
    return site;
  }

  /** Runs `work` with the site row locked, so concurrent edits see each other's rows. */
  async #locked<T>(
    siteId: string,
    organizationId: string,
    work: (tx: HostingPanelDatabase, rows: DomainRow[], site: typeof sites.$inferSelect) => Promise<T>,
  ): Promise<T> {
    return this.dbClient.db.transaction(async (tx) => {
      const [site] = await tx
        .select()
        .from(sites)
        .where(and(eq(sites.id, siteId), eq(sites.organizationId, organizationId), inArray(sites.siteType, [...SITE_TYPE_KEYS])))
        .for("update");
      if (!site) throw notFound();
      const t = tx as unknown as HostingPanelDatabase;
      return work(t, await listSiteDomains(t, siteId), site);
    });
  }

  /** `forceDnsIds`: the domains looked up now even when not due. */
  async #reconcile(siteId: string, forceDnsIds: readonly string[]): Promise<void> {
    try {
      await this.reconciler.reconcileSite(siteId, new Date(), { forceDnsIds });
    } catch (err) {
      // The change is committed; the background loop retries within a minute.
      this.#logger.warn(`Domain reconcile for site ${siteId} failed: ${(err as Error)?.message ?? String(err)}`);
    }
  }

  async #acmeEnabled(): Promise<boolean> {
    try {
      return (await this.executor.getCertificateStatus({ failuresSince: new Date().toISOString() })).acmeEnabled;
    } catch {
      return true; // Same default as the route plan.
    }
  }
}
