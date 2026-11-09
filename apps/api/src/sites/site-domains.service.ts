import { Inject, Injectable } from "@nestjs/common";
import { MAX_SITE_DOMAINS, wwwPartner, type AddSiteDomainInput, type SiteDomainsDto } from "@hosting-panel/contracts";
import {
  and,
  domains,
  eq,
  hostAllocations,
  hosts,
  inArray,
  insertSiteDomains,
  isNotNull,
  listSiteDomains,
  not,
  or,
  sites,
  type DatabaseClient,
  type DomainRow,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
import { ControlPlaneError } from "../common/control-plane.error.js";
import { DATABASE_CLIENT_TOKEN, DOCKER_EXECUTOR_TOKEN } from "../tokens.js";
import { MANUAL_CHECK_MIN_INTERVAL_MS, certificateUsable, manualCertRetryAt, routesPending } from "./domain-policy.js";
import { DomainReconcilerService } from "./domain-reconciler.service.js";

const CONFLICT = "This web address is already used by another site or by the panel.";
const notFound = () => new ControlPlaneError("NOT_FOUND", "Requested organization or resource was not found.");

const isUniqueViolation = (err: unknown): boolean => {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
};

/** The names an add asks for: the hostname, plus its www partner with `includeWww`. */
export function requestedHostnames(input: AddSiteDomainInput): string[] {
  const partner = input.includeWww ? wwwPartner(input.hostname) : null;
  return partner ? [input.hostname, partner] : [input.hostname];
}

/** Every method takes a site id already authorized for `organizationId`. */
@Injectable()
export class SiteDomainsService {
  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(DOCKER_EXECUTOR_TOKEN) private readonly executor: DockerExecutorPort,
    @Inject(DomainReconcilerService) private readonly reconciler: DomainReconcilerService,
  ) {}

  public async list(siteId: string, organizationId: string): Promise<SiteDomainsDto> {
    const db = this.dbClient.db;
    const site = await this.#site(siteId, organizationId);
    const rows = await listSiteDomains(db, siteId);
    const now = new Date();
    return {
      serverIpv4: site.ipv4,
      routesPending: routesPending(rows, now, site.site, await this.#acmeEnabled()),
      domains: rows.map((r) => ({
        id: r.id,
        hostname: r.hostname,
        isPrimary: r.isPrimary,
        routed: r.status === "active",
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
      })),
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

  /** Names already on this site are skipped, so a repeated call changes nothing. */
  public async add(siteId: string, organizationId: string, input: AddSiteDomainInput): Promise<SiteDomainsDto> {
    const names = requestedHostnames(input);
    try {
      await this.#locked(siteId, organizationId, async (tx, rows) => {
        const fresh = names.filter((n) => !rows.some((r) => r.hostname === n));
        if (fresh.length === 0) return;
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
          throw new ControlPlaneError("VALIDATION_ERROR", "A site can have up to 10 web addresses. Remove one first.");
        }
        const routed = rows.some((r) => r.isPrimary && r.status === "active");
        await insertSiteDomains(tx, { siteId, organizationId, hostnames: fresh, routed });
      });
    } catch (err) {
      // Another site took the name between the check and the insert.
      if (isUniqueViolation(err)) throw new ControlPlaneError("DOMAIN_CONFLICT", CONFLICT);
      throw err;
    }
    await this.#reconcile(siteId, true);
    return this.list(siteId, organizationId);
  }

  public async remove(siteId: string, organizationId: string, domainId: string): Promise<SiteDomainsDto> {
    await this.#locked(siteId, organizationId, async (tx, rows) => {
      const row = rows.find((r) => r.id === domainId);
      if (!row) throw notFound();
      if (rows.length === 1) throw new ControlPlaneError("VALIDATION_ERROR", "A site needs at least one web address.");
      if (row.isPrimary) {
        throw new ControlPlaneError("VALIDATION_ERROR", "Choose another main address first, then remove this one.");
      }
      await tx.delete(domains).where(eq(domains.id, domainId));
    });
    await this.#reconcile(siteId, false);
    return this.list(siteId, organizationId);
  }

  public async setPrimary(siteId: string, organizationId: string, domainId: string): Promise<SiteDomainsDto> {
    await this.#locked(siteId, organizationId, async (tx, rows, site) => {
      const row = rows.find((r) => r.id === domainId);
      if (!row) throw notFound();
      if (row.isPrimary) return;
      // Never move an https site to a name without a working certificate: WordPress would go back to http.
      if (site.wordpressUrl?.startsWith("https://") && !certificateUsable(row, new Date())) {
        throw new ControlPlaneError(
          "VALIDATION_ERROR",
          "Wait until HTTPS is active on this address, then make it the main address.",
        );
      }
      // Clear first: the one-primary-per-site index would refuse two at once.
      await tx.update(domains).set({ isPrimary: false, updatedAt: new Date() }).where(eq(domains.siteId, siteId));
      await tx.update(domains).set({ isPrimary: true, updatedAt: new Date() }).where(eq(domains.id, domainId));
    });
    await this.#reconcile(siteId, false);
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
    await this.#reconcile(siteId, true);
    return this.list(siteId, organizationId);
  }

  async #site(siteId: string, organizationId: string) {
    const [site] = await this.dbClient.db
      .select({ site: sites, ipv4: hosts.ipv4Address })
      .from(sites)
      .innerJoin(hostAllocations, eq(hostAllocations.id, sites.hostAllocationId))
      .innerJoin(hosts, eq(hosts.id, hostAllocations.hostId))
      .where(and(eq(sites.id, siteId), eq(sites.organizationId, organizationId), isNotNull(sites.phpVersion)))
      .limit(1);
    if (!site) throw notFound();
    return site;
  }

  /** Runs `work` with the site row locked, so concurrent edits see each other's rows. */
  async #locked(
    siteId: string,
    organizationId: string,
    work: (tx: HostingPanelDatabase, rows: DomainRow[], site: typeof sites.$inferSelect) => Promise<void>,
  ): Promise<void> {
    await this.dbClient.db.transaction(async (tx) => {
      const [site] = await tx
        .select()
        .from(sites)
        .where(and(eq(sites.id, siteId), eq(sites.organizationId, organizationId), isNotNull(sites.phpVersion)))
        .for("update");
      if (!site) throw notFound();
      const t = tx as unknown as HostingPanelDatabase;
      await work(t, await listSiteDomains(t, siteId), site);
    });
  }

  async #reconcile(siteId: string, forceDnsCheck: boolean): Promise<void> {
    // The change is committed; a failed pass is retried by the background loop within a minute.
    await this.reconciler.reconcileSite(siteId, new Date(), { forceDnsCheck }).catch(() => undefined);
  }

  async #acmeEnabled(): Promise<boolean> {
    try {
      return (await this.executor.getCertificateStatus({ failuresSince: new Date().toISOString() })).acmeEnabled;
    } catch {
      return true; // Same default as the route plan.
    }
  }
}
