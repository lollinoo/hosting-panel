import { Inject, Injectable } from "@nestjs/common";
import { isTerminalOperationStatus, redactSensitiveString, type CertProblem, type DnsStatus } from "@hosting-panel/contracts";
import {
  and,
  appendAuditEvent,
  domains,
  eq,
  hostAllocations,
  hosts,
  inArray,
  isNotNull,
  latestSiteOperation,
  listSiteDomains,
  not,
  sites,
  type DatabaseClient,
  type DomainRow,
} from "@hosting-panel/database";
import type { CertificateStatusReport, DockerExecutorPort } from "@hosting-panel/executor-contracts";
import { OutboxWorkerService } from "../runtime/outbox-worker.service.js";
import {
  CONTROL_PLANE_CONFIG_TOKEN,
  DATABASE_CLIENT_TOKEN,
  DNS_LOOKUP_TOKEN,
  DOCKER_EXECUTOR_TOKEN,
  type ControlPlaneRuntimeConfig,
} from "../tokens.js";
import type { DnsLookup } from "./dns-check.js";
import { CERT_REQUEST_TIMEOUT_MS, MANUAL_CERT_RETRY_GAP_MS, certRetryAt, evaluateDns, nextDnsCheckAt, routesPending } from "./domain-policy.js";
import { enqueueSiteDomainsOperation } from "./site-domains-applier.js";

const FAILURE_WINDOW_MS = 10 * 60_000;
const FAILED_APPLY_BACKOFF_MS = 10 * 60_000;

interface ManagedSite {
  readonly id: string;
  readonly organizationId: string;
  readonly ipv4: string;
  /** Deploying or in maintenance: only failed orders are classified, nothing else moves. */
  readonly busy: boolean;
}

/**
 * Every 60 s: DNS checks, certificate state from the proxy's store, and a route apply when the
 * plan changed. Both entry points share one promise chain, so two runs never touch the same rows.
 */
@Injectable()
export class DomainReconcilerService {
  #stopped = false;
  #timer: NodeJS.Timeout | null = null;
  #serial: Promise<unknown> = Promise.resolve();
  // shortcut: in memory, so after a restart a renewal failure logged <10 min before a renewal can
  // raise the problem again until the next certificate; upgrade with a stored serial + seen-at column.
  readonly #certSeenAt = new Map<string, number>();

  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(DOCKER_EXECUTOR_TOKEN) private readonly executor: DockerExecutorPort,
    @Inject(DNS_LOOKUP_TOKEN) private readonly dns: DnsLookup,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) private readonly config: ControlPlaneRuntimeConfig,
    @Inject(OutboxWorkerService) private readonly outboxWorker: OutboxWorkerService,
  ) {}

  public startBackgroundLoop(): void {
    const intervalMs = this.config.domainReconcileIntervalMs;
    if (this.#stopped || this.#timer || !intervalMs || intervalMs <= 0) return;
    this.#timer = setInterval(() => {
      if (!this.#stopped) void this.reconcileOnce().catch(() => undefined);
    }, intervalMs);
    this.#timer.unref();
  }

  public async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.#serial;
  }

  public reconcileOnce(now = new Date()): Promise<void> {
    return this.#queue(() => this.#run(null, now, () => false));
  }

  /** `forceDnsIds` looks those domains up now even when not due; `forceDnsCheck` does it for every domain. */
  public reconcileSite(
    siteId: string,
    now: Date,
    opts: { forceDnsCheck?: boolean; forceDnsIds?: readonly string[] } = {},
  ): Promise<void> {
    const force = (id: string) => opts.forceDnsCheck === true || (opts.forceDnsIds?.includes(id) ?? false);
    return this.#queue(() => this.#run(siteId, now, force));
  }

  #queue(work: () => Promise<void>): Promise<void> {
    const run = this.#serial.then(work);
    this.#serial = run.catch(() => undefined);
    return run;
  }

  async #run(onlySiteId: string | null, now: Date, forceDns: (domainId: string) => boolean): Promise<void> {
    if (this.config.runtimeBackend === "disabled") return;
    const db = this.dbClient.db;
    const rows = await db
      .select({ id: sites.id, organizationId: sites.organizationId, ipv4: hosts.ipv4Address, status: sites.status })
      .from(sites)
      .innerJoin(hostAllocations, eq(hostAllocations.id, sites.hostAllocationId))
      .innerJoin(hosts, eq(hosts.id, hostAllocations.hostId))
      .where(
        and(
          isNotNull(sites.phpVersion),
          ...(onlySiteId ? [eq(sites.id, onlySiteId)] : []),
        ),
      );
    const managed: ManagedSite[] = rows.map(({ status, ...r }) => ({ ...r, busy: status === "deploying" || status === "maintenance" }));
    if (managed.length === 0) return;

    for (const site of managed.filter((s) => !s.busy)) {
      if (onlySiteId) await this.#checkDns(site, now, forceDns);
      else await this.#checkDns(site, now, forceDns).catch(() => undefined);
    }

    const requestedAt = (
      await db
        .select({ at: domains.certRequestedAt })
        .from(domains)
        .where(and(inArray(domains.siteId, managed.map((s) => s.id)), eq(domains.certStatus, "requested")))
    )
      .map((r) => r.at?.getTime())
      .filter((t): t is number => t !== undefined);
    const failuresSince = new Date(requestedAt.length > 0 ? Math.min(...requestedAt) : now.getTime() - FAILURE_WINDOW_MS);
    let report: CertificateStatusReport;
    try {
      report = await this.executor.getCertificateStatus({ failuresSince: failuresSince.toISOString() });
    } catch {
      return; // Steps 3 and 4 wait for the next pass.
    }

    let enqueued = false;
    for (const site of managed) {
      const work = async () => {
        await this.#updateCertificates(site, now, report);
        if (site.busy) return;
        enqueued = (await this.#applyIfChanged(site, now, report.acmeEnabled)) || enqueued;
      };
      if (onlySiteId) await work();
      else await work().catch(() => undefined);
    }
    if (enqueued) this.outboxWorker.triggerAsync();
  }

  async #checkDns(site: ManagedSite, now: Date, force: (domainId: string) => boolean): Promise<void> {
    const db = this.dbClient.db;
    for (const row of await listSiteDomains(db, site.id)) {
      if (!force(row.id) && row.dnsNextCheckAt > now) continue;
      let observed = { a: [] as string[], aaaa: [] as string[] };
      let status: DnsStatus;
      try {
        observed = await this.dns.lookup(row.hostname);
        status = evaluateDns(observed, site.ipv4);
      } catch {
        status = "lookup_failed";
      }
      await db
        .update(domains)
        .set({
          dnsStatus: status,
          dnsObserved: observed,
          dnsCheckedAt: now,
          dnsAttempts: status === "ok" ? 0 : row.dnsAttempts + 1,
          dnsNextCheckAt: nextDnsCheckAt(now, status, row.dnsAttempts),
          updatedAt: now,
        })
        .where(eq(domains.id, row.id));
    }
  }

  async #updateCertificates(site: ManagedSite, now: Date, report: CertificateStatusReport): Promise<void> {
    // CP-01: an unreadable or half-written store never moves a certificate state.
    if (!report.readable) return;
    const stored = new Map(report.certificates.map((c) => [c.hostname, c]));

    for (const row of await listSiteDomains(this.dbClient.db, site.id)) {
      const cert = stored.get(row.hostname);
      // A busy site's failing name must lose its resolver, or every proxy reload re-orders it.
      if (site.busy && (row.certStatus !== "requested" || cert)) continue;
      const failures = report.failures
        .filter((f) => f.hostname === row.hostname)
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

      if (cert) {
        const expiresAt = new Date(cert.notAfter);
        // A new certificate always brings a new expiry: that stands in for the serial, which is not stored.
        const isNew = row.certStatus !== "active" || row.certExpiresAt?.getTime() !== expiresAt.getTime();
        if (isNew) {
          const ok = await this.#transition(row, {
            certStatus: "active",
            certExpiresAt: expiresAt,
            certTrusted: report.trusted,
            certProblem: null,
            certAttempts: 0,
            certRetryAt: null,
          }, now);
          if (ok) {
            this.#certSeenAt.set(row.id, now.getTime());
            await this.#audit(site, "site.certificate.issued", {
              hostname: row.hostname,
              serialNumber: cert.serialNumber,
              expiresAt: expiresAt.toISOString(),
            });
          }
          continue;
        }
        const seenAt = this.#certSeenAt.get(row.id) ?? 0;
        const renewFailure = failures.find((f) => f.kind === "renew" && Date.parse(f.at) > seenAt);
        const problem = renewFailure?.problem ?? row.certProblem;
        if (problem !== row.certProblem || report.trusted !== row.certTrusted) {
          await this.#transition(row, { certProblem: problem, certTrusted: report.trusted }, now);
        }
        continue;
      }

      if (row.certStatus === "active") {
        // The store lost it (e.g. a CA switch): Traefik re-obtains it under the same resolver.
        await this.#transition(row, { certStatus: "requested", certRequestedAt: now }, now);
        continue;
      }

      if (row.certStatus === "requested") {
        const since = row.certRequestedAt?.getTime() ?? 0;
        const failure = failures.find((f) => Date.parse(f.at) >= since);
        if (failure) {
          await this.#fail(site, row, failure.problem, failure.detail, now);
        } else if (
          now.getTime() - since >= CERT_REQUEST_TIMEOUT_MS &&
          // CP-01: a row whose real certificate is still valid keeps its resolver (a missing store reads as empty).
          !(row.certExpiresAt !== null && row.certExpiresAt > now)
        ) {
          await this.#fail(site, row, "other", "No certificate and no reported failure within 10 minutes", now);
        } else if (row.dnsStatus !== "ok" && row.certExpiresAt === null) {
          // Only a fresh request is DNS-gated; a re-request of a lost certificate (expiry kept) stays.
          await this.#transition(row, { certStatus: "none" }, now);
        }
        continue;
      }

      const due = row.certStatus === "none" || (row.certRetryAt !== null && row.certRetryAt <= now);
      // At most one order per 15 min, even when DNS flaps and requested→none is followed by "Check now".
      const gapOk = !row.certRequestedAt || now.getTime() >= row.certRequestedAt.getTime() + MANUAL_CERT_RETRY_GAP_MS;
      if (due && gapOk && row.dnsStatus === "ok" && row.status === "active" && report.acmeEnabled) {
        // certExpiresAt null marks a fresh request (see the DNS gate above).
        const ok = await this.#transition(row, { certStatus: "requested", certRequestedAt: now, certExpiresAt: null }, now);
        if (ok) await this.#audit(site, "site.certificate.requested", { hostname: row.hostname });
      }
    }
  }

  async #fail(site: ManagedSite, row: DomainRow, problem: CertProblem, detail: string, now: Date): Promise<void> {
    // Never earlier than a retry already scheduled; only "Check now" may bring it forward.
    const retryAt = Math.max(certRetryAt(now, problem, row.certAttempts).getTime(), row.certRetryAt?.getTime() ?? 0);
    const ok = await this.#transition(row, {
      certStatus: "failed",
      certProblem: problem,
      certAttempts: row.certAttempts + 1,
      certRetryAt: new Date(retryAt),
    }, now);
    // Raw ACME text is admin-only (customers lack audit.read), redacted and capped at 1 KiB.
    if (ok) {
      await this.#audit(site, "site.certificate.failed", {
        hostname: row.hostname,
        problem,
        detail: redactSensitiveString(detail).slice(0, 1024),
      });
    }
  }

  /** Guarded on the state we read: zero rows means another writer won, and the change is dropped. */
  async #transition(row: DomainRow, set: Partial<typeof domains.$inferInsert>, now: Date): Promise<boolean> {
    const updated = await this.dbClient.db
      .update(domains)
      .set({ ...set, updatedAt: now })
      .where(and(eq(domains.id, row.id), eq(domains.certStatus, row.certStatus)))
      .returning({ id: domains.id });
    return updated.length > 0;
  }

  #audit(site: ManagedSite, action: string, details: Record<string, unknown>) {
    return appendAuditEvent(this.dbClient.db, {
      actorId: null,
      actorType: "system",
      organizationId: site.organizationId,
      action,
      targetType: "site",
      targetId: site.id,
      details,
    });
  }

  /** Returns true when a site.domains run was queued. */
  async #applyIfChanged(site: ManagedSite, now: Date, acmeEnabled: boolean): Promise<boolean> {
    const db = this.dbClient.db;
    const [current] = await db.select().from(sites).where(eq(sites.id, site.id)).limit(1);
    if (!current || !routesPending(await listSiteDomains(db, site.id), now, current, acmeEnabled)) return false;
    const last = await latestSiteOperation(db, { siteId: site.id, kind: "site.domains" });
    if (last && !isTerminalOperationStatus(last.status)) return false;
    const lastEnded = last?.completedAt ?? last?.updatedAt;
    if (last?.status === "failed" && lastEnded && now.getTime() - lastEnded.getTime() < FAILED_APPLY_BACKOFF_MS) {
      return false;
    }
    try {
      await enqueueSiteDomainsOperation(db, { organizationId: site.organizationId, siteId: site.id });
      return true;
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === "RESOURCE_LOCKED") return false; // The next pass retries.
      throw err;
    }
  }
}
