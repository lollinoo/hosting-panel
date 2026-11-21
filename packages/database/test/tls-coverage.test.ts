import type { TlsVersionStatus } from "@hosting-panel/contracts";
import { getTableName } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  assertNoForeignManualCoverage,
  assertNoManualCapture,
  createDatabaseClient,
  createSiteTransactional,
  domains,
  eq,
  foreignHostnamesCoveredBy,
  hostAllocations,
  hosts,
  insertTlsCertificateWithVersion,
  moveSiteToOrganizationTransactional,
  organizations,
  platformInstallations,
  sites,
  tlsCertificates,
  tlsCertificateVersions,
  TlsCoverageError,
  type DatabaseClient,
  type HostingPanelDatabase,
} from "../src/index.js";

// HCP-SPEC-004 TLS-04: a published manual certificate never covers a hostname of another organization and never
// silently captures an own host; site create / domain add / site move all go through these guards.
const MASTER_KEY = "e".repeat(64);
const orgA = "org_cov_a";
const orgB = "org_cov_b";

describe("@hosting-panel/database — manual certificate coverage guards", () => {
  let client: DatabaseClient;
  const db = (): HostingPanelDatabase => client.db;
  let counter = 0;
  let slugCounter = 0;

  /** Imports a certificate version for `org` and forces its lifecycle status (the material stays immutable). */
  async function certificate(org: string, sanDns: string[], status: TlsVersionStatus = "active", siteId: string | null = null) {
    counter += 1;
    const created = await insertTlsCertificateWithVersion(db(), {
      organizationId: org,
      name: `cert ${String(counter)}`,
      createdForSiteId: siteId,
      createdByUserId: null,
      masterKey: MASTER_KEY,
      version: {
        leafPem: "-----BEGIN CERTIFICATE-----\nLEAF\n-----END CERTIFICATE-----\n",
        chainPem: "",
        privateKeyPem: "-----BEGIN PRIVATE KEY-----\nKEY\n-----END PRIVATE KEY-----\n",
        subject: "CN=test",
        issuer: "CN=Test CA",
        serialNumber: String(counter),
        fingerprintSha256: counter.toString(16).padStart(64, "0"),
        notBefore: new Date("2026-11-01T00:00:00.000Z"),
        notAfter: new Date("2027-11-01T00:00:00.000Z"),
        sanDns,
        keyType: "ec",
        keyBits: 256,
      },
    });
    await db().update(tlsCertificateVersions).set({ status }).where(eq(tlsCertificateVersions.id, created.versionId));
    return created;
  }

  async function site(org: string, alloc: string, initialDomain?: string) {
    slugCounter += 1;
    return createSiteTransactional(db(), {
      organizationId: org,
      hostAllocationId: alloc,
      name: `Site ${String(slugCounter)}`,
      slug: `cov-site-${String(slugCounter)}`,
      phpVersion: "8.4",
      siteType: "wordpress",
      ...(initialDomain === undefined ? {} : { initialDomain }),
    });
  }

  const inTx = <T>(fn: (tx: Parameters<Parameters<HostingPanelDatabase["transaction"]>[0]>[0]) => Promise<T>) =>
    db().transaction(fn);

  beforeAll(async () => {
    client = createDatabaseClient({ mode: "pglite" });
    await client.migrate();
    await db().insert(platformInstallations).values({ id: "pin_cov", name: "Platform" });
    await db().insert(hosts).values({
      id: "hst_cov",
      platformInstallationId: "pin_cov",
      name: "cov-host",
      hostname: "cov-host.local",
      ipv4Address: "10.0.0.40",
      totalCpuMilli: 4000,
      totalMemoryBytes: "4000000000",
      totalStorageBytes: "100000000000",
    });
    for (const [orgId, alloc, slug] of [
      [orgA, "alloc_cov_a", "cov-a"],
      [orgB, "alloc_cov_b", "cov-b"],
    ] as const) {
      await db().insert(organizations).values({ id: orgId, platformInstallationId: "pin_cov", name: slug, slug });
      await db().insert(hostAllocations).values({ id: alloc, hostId: "hst_cov", organizationId: orgId, status: "active" });
    }
  }, 120_000);

  afterEach(async () => {
    await db().update(domains).set({ certMode: "acme", manualCertificateVersionId: null });
    await db().delete(tlsCertificates);
  });

  afterAll(async () => {
    await client.close();
  });

  describe("assertNoForeignManualCoverage", () => {
    it("refuses a hostname covered by a published version of another organization, with the requested code", async () => {
      await certificate(orgB, ["*.shared.example"], "active");
      for (const code of ["DOMAIN_CONFLICT", "CERTIFICATE_IN_USE"] as const) {
        const refusal = await inTx((tx) => assertNoForeignManualCoverage(tx, orgA, ["shop.shared.example"], code)).catch(
          (e: unknown) => e,
        );
        expect(refusal).toBeInstanceOf(TlsCoverageError);
        expect(refusal).toMatchObject({ code, reason: "foreign_coverage" });
        // The text never names the hostname, the certificate or the other tenant.
        expect(JSON.stringify({ ...(refusal as object), message: (refusal as Error).message })).not.toMatch(
          /shared\.example|cert \d|org_cov/,
        );
      }
    });

    it("counts only applying and active versions", async () => {
      for (const status of ["pending", "inactive", "failed"] as const) {
        await certificate(orgB, ["*.shared.example"], status);
      }
      await expect(
        inTx((tx) => assertNoForeignManualCoverage(tx, orgA, ["shop.shared.example"], "DOMAIN_CONFLICT")),
      ).resolves.toBeUndefined();
      await certificate(orgB, ["exact.shared.example"], "applying");
      await expect(
        inTx((tx) => assertNoForeignManualCoverage(tx, orgA, ["exact.shared.example"], "DOMAIN_CONFLICT")),
      ).rejects.toMatchObject({ code: "DOMAIN_CONFLICT" });
    });

    it("follows Traefik matching: one wildcard level only, not the apex, case-insensitive", async () => {
      await certificate(orgB, ["*.shared.example"], "active");
      const check = (host: string) =>
        inTx((tx) => assertNoForeignManualCoverage(tx, orgA, [host], "DOMAIN_CONFLICT"));
      await expect(check("shared.example")).resolves.toBeUndefined();
      await expect(check("a.b.shared.example")).resolves.toBeUndefined();
      await expect(check("other.example")).resolves.toBeUndefined();
      await expect(check("SHOP.Shared.Example")).rejects.toMatchObject({ code: "DOMAIN_CONFLICT" });
    });

    it("ignores versions of the same organization and accepts an empty list", async () => {
      await certificate(orgA, ["*.mine.example"], "active");
      await expect(
        inTx((tx) => assertNoForeignManualCoverage(tx, orgA, ["shop.mine.example"], "DOMAIN_CONFLICT")),
      ).resolves.toBeUndefined();
      await expect(inTx((tx) => assertNoForeignManualCoverage(tx, orgA, [], "DOMAIN_CONFLICT"))).resolves.toBeUndefined();
    });
  });

  describe("assertNoManualCapture", () => {
    it("another organization's coverage is DOMAIN_CONFLICT, an own certificate is CERTIFICATE_IN_USE captures_host", async () => {
      await certificate(orgB, ["*.foreign.example"], "active");
      await certificate(orgA, ["*.mine.example"], "applying");
      await expect(inTx((tx) => assertNoManualCapture(tx, orgA, ["x.foreign.example"]))).rejects.toMatchObject({
        code: "DOMAIN_CONFLICT",
        reason: "foreign_coverage",
      });
      const own = await inTx((tx) => assertNoManualCapture(tx, orgA, ["fresh.example", "new.mine.example"])).catch(
        (e: unknown) => e,
      );
      expect(own).toBeInstanceOf(TlsCoverageError);
      expect(own).toMatchObject({ code: "CERTIFICATE_IN_USE", reason: "captures_host", hostname: "new.mine.example" });
    });

    it("foreign coverage wins over an own capture of the same host", async () => {
      await certificate(orgA, ["*.both.example"], "active");
      await certificate(orgB, ["*.both.example"], "active");
      await expect(inTx((tx) => assertNoManualCapture(tx, orgA, ["x.both.example"]))).rejects.toMatchObject({
        code: "DOMAIN_CONFLICT",
      });
    });

    it("lets through uncovered hosts, the apex of a wildcard and unpublished versions", async () => {
      await certificate(orgA, ["*.mine.example"], "active");
      await certificate(orgB, ["*.foreign.example"], "inactive");
      await expect(
        inTx((tx) => assertNoManualCapture(tx, orgA, ["mine.example", "a.b.mine.example", "x.foreign.example", "other.test"])),
      ).resolves.toBeUndefined();
      await expect(inTx((tx) => assertNoManualCapture(tx, orgA, []))).resolves.toBeUndefined();
    });
  });

  describe("foreignHostnamesCoveredBy", () => {
    it("is true when a domain of another organization (any status) is covered by the names", async () => {
      const b = await site(orgB, "alloc_cov_b", "app.fh.example");
      await db().update(domains).set({ status: "pending" }).where(eq(domains.siteId, b.site.id));
      expect(await foreignHostnamesCoveredBy(db(), orgA, ["*.fh.example"])).toBe(true);
      expect(await foreignHostnamesCoveredBy(db(), orgA, ["app.fh.example"])).toBe(true);
      expect(await foreignHostnamesCoveredBy(db(), orgB, ["*.fh.example"])).toBe(false);
      expect(await foreignHostnamesCoveredBy(db(), orgA, ["fh.example", "*.other.example", "*.x.fh.example"])).toBe(false);
      expect(await foreignHostnamesCoveredBy(db(), orgA, [])).toBe(false);
    });
  });

  describe("createSiteTransactional", () => {
    it("refuses an initial domain captured by a manual certificate and rolls the site back", async () => {
      await certificate(orgA, ["*.cs.example"], "active");
      await certificate(orgB, ["*.csf.example"], "active");
      const before = (await db().select().from(sites)).length;
      await expect(site(orgA, "alloc_cov_a", "new.cs.example")).rejects.toMatchObject({
        code: "CERTIFICATE_IN_USE",
        reason: "captures_host",
        hostname: "new.cs.example",
      });
      await expect(site(orgA, "alloc_cov_a", "new.csf.example")).rejects.toMatchObject({ code: "DOMAIN_CONFLICT" });
      expect((await db().select().from(sites)).length).toBe(before);
      expect(await db().select().from(domains).where(eq(domains.hostname, "new.cs.example"))).toHaveLength(0);
    });

    it("creates the site when the host is not covered, or when there is no initial domain", async () => {
      await certificate(orgA, ["*.cs.example"], "active");
      const created = await site(orgA, "alloc_cov_a", "cs.example");
      expect(created.domain?.hostname).toBe("cs.example");
      expect((await site(orgA, "alloc_cov_a")).domain).toBeNull();
    });
  });

  describe("moveSiteToOrganizationTransactional", () => {
    const move = (siteId: string, from = orgA, to = orgB) =>
      moveSiteToOrganizationTransactional(db(), {
        siteId,
        fromOrganizationId: from,
        toOrganizationId: to,
        toHostAllocationId: to === orgB ? "alloc_cov_b" : "alloc_cov_a",
        masterKey: MASTER_KEY,
      });
    const organizationOf = async (siteId: string) =>
      (await db().select({ o: sites.organizationId }).from(sites).where(eq(sites.id, siteId)))[0]?.o;

    it("refuses a site with a manual domain (CERTIFICATE_IN_USE) and changes nothing", async () => {
      const s = await site(orgA, "alloc_cov_a", "manual.mv.example");
      const cert = await certificate(orgA, ["manual.mv.example"], "active", s.site.id);
      await db()
        .update(domains)
        .set({ certMode: "manual", manualCertificateVersionId: cert.versionId })
        .where(eq(domains.siteId, s.site.id));
      await expect(move(s.site.id)).rejects.toMatchObject({ code: "CERTIFICATE_IN_USE", reason: "manual_domain" });
      expect(await organizationOf(s.site.id)).toBe(orgA);
      const [row] = await db().select().from(tlsCertificates).where(eq(tlsCertificates.id, cert.certificateId));
      expect(row?.createdForSiteId).toBe(s.site.id);
    });

    it("refuses when a manual certificate of another organization covers a hostname, then moves once it is gone", async () => {
      const s = await site(orgA, "alloc_cov_a", "shop.mvf.example");
      const own = await certificate(orgA, ["*.mvf.example"], "active", s.site.id);
      // Moving to B leaves the wildcard of A covering a host of B: refused, and created_for_site_id stays.
      await expect(move(s.site.id)).rejects.toMatchObject({ code: "CERTIFICATE_IN_USE", reason: "foreign_coverage" });
      expect(await organizationOf(s.site.id)).toBe(orgA);
      const [still] = await db().select().from(tlsCertificates).where(eq(tlsCertificates.id, own.certificateId));
      expect(still?.createdForSiteId).toBe(s.site.id);

      await db().update(tlsCertificateVersions).set({ status: "inactive" }).where(eq(tlsCertificateVersions.id, own.versionId));
      await move(s.site.id);
      expect(await organizationOf(s.site.id)).toBe(orgB);
    });

    it("clears tls_certificates.created_for_site_id and keeps the certificate in its organization", async () => {
      const s = await site(orgA, "alloc_cov_a", "plain.mvc.example");
      const other = await site(orgA, "alloc_cov_a", "other.mvc.example");
      const made = await certificate(orgA, ["plain.mvc.example"], "pending", s.site.id);
      const unrelated = await certificate(orgA, ["other.mvc.example"], "pending", other.site.id);
      await move(s.site.id);
      expect(await organizationOf(s.site.id)).toBe(orgB);
      const [moved] = await db().select().from(tlsCertificates).where(eq(tlsCertificates.id, made.certificateId));
      expect(moved).toMatchObject({ createdForSiteId: null, organizationId: orgA });
      const [kept] = await db().select().from(tlsCertificates).where(eq(tlsCertificates.id, unrelated.certificateId));
      expect(kept?.createdForSiteId).toBe(other.site.id);
      const [domain] = await db().select().from(domains).where(eq(domains.siteId, s.site.id));
      expect(domain?.organizationId).toBe(orgB);
    });

    it("refuses when a published wildcard of the DESTINATION organization would capture the moved host", async () => {
      const s = await site(orgA, "alloc_cov_a", "shop.mvd.example");
      // B's own wildcard is loaded: after the move it would be served for a host B never assigned to it.
      const wild = await certificate(orgB, ["*.mvd.example"], "active");
      await expect(move(s.site.id)).rejects.toMatchObject({ code: "CERTIFICATE_IN_USE", reason: "captures_host" });
      expect(await organizationOf(s.site.id)).toBe(orgA);
      await db().update(tlsCertificateVersions).set({ status: "inactive" }).where(eq(tlsCertificateVersions.id, wild.versionId));
      await move(s.site.id);
      expect(await organizationOf(s.site.id)).toBe(orgB);
    });

    it("ignores unpublished versions of other organizations", async () => {
      const s = await site(orgA, "alloc_cov_a", "shop.mvu.example");
      await certificate(orgA, ["*.mvu.example"], "pending");
      await certificate(orgB, ["*.mvu.example"], "failed");
      await move(s.site.id);
      expect(await organizationOf(s.site.id)).toBe(orgB);
    });
  });

  describe("lock order", () => {
    /** Records, in order, the tables a transaction row-locks (`FOR UPDATE`) or inserts into / updates. */
    function recordLocks(log: string[]): HostingPanelDatabase {
      const wrapBuilder = (builder: object, table: () => string): object =>
        new Proxy(builder, {
          get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver) as unknown;
            if (prop === "then") return (value as (...a: unknown[]) => unknown).bind(target);
            if (typeof value !== "function") return value;
            return (...args: unknown[]) => {
              let current = table();
              if (prop === "from") current = getTableName(args[0] as Parameters<typeof getTableName>[0]);
              if (prop === "for") log.push(`lock:${current}`);
              const result = (value as (...a: unknown[]) => unknown).apply(target, args);
              return result && typeof result === "object" ? wrapBuilder(result, () => current) : result;
            };
          },
        });
      const wrapTx = (tx: object): object =>
        new Proxy(tx, {
          get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver) as unknown;
            if (typeof value !== "function") return value;
            return (...args: unknown[]) => {
              if (prop === "insert" || prop === "update") log.push(`${String(prop)}:${getTableName(args[0] as Parameters<typeof getTableName>[0])}`);
              const result = (value as (...a: unknown[]) => unknown).apply(target, args);
              return result && typeof result === "object" ? wrapBuilder(result, () => "") : result;
            };
          },
        });
      return new Proxy(db(), {
        get(target, prop, receiver) {
          if (prop === "transaction") {
            return (cb: (tx: object) => Promise<unknown>) => target.transaction((tx) => cb(wrapTx(tx)));
          }
          return Reflect.get(target, prop, receiver) as unknown;
        },
      });
    }

    it("a site move locks the site row before the TLS publish state", async () => {
      const s = await site(orgA, "alloc_cov_a", "lo.move.example");
      const log: string[] = [];
      await moveSiteToOrganizationTransactional(recordLocks(log), {
        siteId: s.site.id,
        fromOrganizationId: orgA,
        toOrganizationId: orgB,
        toHostAllocationId: "alloc_cov_b",
        masterKey: MASTER_KEY,
      });
      const siteLock = log.indexOf("lock:sites");
      const tlsLock = log.indexOf("lock:tls_publish_state");
      expect(siteLock).toBeGreaterThanOrEqual(0);
      expect(tlsLock).toBeGreaterThan(siteLock);
      // The row-locking domain read follows the TLS lock, and the site UPDATE comes last.
      expect(log.indexOf("lock:domains")).toBeGreaterThan(-1);
      expect(log.indexOf("update:sites")).toBeGreaterThan(tlsLock);
    });

    it("a site create inserts the site before it takes the TLS lock", async () => {
      const log: string[] = [];
      await createSiteTransactional(recordLocks(log), {
        organizationId: orgA,
        hostAllocationId: "alloc_cov_a",
        name: "Lock order",
        slug: "cov-lock-order",
        phpVersion: "8.4",
        siteType: "wordpress",
        initialDomain: "lo.create.example",
      });
      const insertSite = log.indexOf("insert:sites");
      const tlsLock = log.indexOf("lock:tls_publish_state");
      expect(insertSite).toBeGreaterThanOrEqual(0);
      expect(tlsLock).toBeGreaterThan(insertSite);
      expect(log.indexOf("insert:domains")).toBeGreaterThan(tlsLock);
    });
  });
});
