import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertSiteLimitAvailable,
  auditEvents,
  countSitesByOrganization,
  createDatabaseClient,
  createSiteTransactional,
  domains,
  eq,
  hostAllocations,
  hosts,
  moveSiteToOrganizationTransactional,
  organizations,
  platformInstallations,
  resolveMigrationsDirectory,
  SiteLimitReachedError,
  sites,
  updateOrganizationSiteLimitTransactional,
  type DatabaseClient,
} from "../src/index.js";

// Per-customer site limit: organizations.max_sites (NULL = unlimited), checked under a lock on the organizations row
// inside createSiteTransactional and moveSiteToOrganizationTransactional.
const dir = resolveMigrationsDirectory();
const M0023 = "0023_organization_site_limit.sql";
const files = readdirSync(dir)
  .filter((file) => file.endsWith(".sql"))
  .sort();
const read = (file: string) => readFileSync(path.join(dir, file), "utf8");
const KEY = "c".repeat(64);

async function migrateTo(pg: PGlite, until: string): Promise<void> {
  for (const file of files) {
    if (file >= until) break;
    await pg.exec(read(file));
  }
}

describe("0023 organization_site_limit migration", () => {
  let pg: PGlite;

  const SEED = `
    INSERT INTO platform_installations (id, name) VALUES ('pi','pi');
    INSERT INTO hosts (id, platform_installation_id, name, hostname, ipv4_address, total_cpu_milli, total_memory_bytes, total_storage_bytes)
      VALUES ('h','pi','h','h.example','192.0.2.1',1000,'1','1');
    INSERT INTO organizations (id, platform_installation_id, name, slug) VALUES ('o','pi','o','o');
    INSERT INTO host_allocations (id, host_id, organization_id) VALUES ('a','h','o');
    INSERT INTO sites (id, organization_id, host_allocation_id, name, slug) VALUES ('s1','o','a','s1','s1');`;

  beforeAll(async () => {
    pg = new PGlite();
    await migrateTo(pg, M0023);
    await pg.exec(SEED);
    await pg.exec(read(M0023));
  }, 120_000);

  afterAll(async () => {
    await pg.close();
  });

  const maxSitesOf = async (id: string) =>
    (await pg.query<{ max_sites: number | null }>(`SELECT max_sites FROM organizations WHERE id = '${id}'`)).rows[0]?.max_sites;

  it("1. adds a nullable max_sites without default, and the CHECK rejects -1 but accepts 0 and NULL", async () => {
    const column = (
      await pg.query<{ is_nullable: string; column_default: string | null; data_type: string }>(
        `SELECT is_nullable, column_default, data_type FROM information_schema.columns
         WHERE table_name = 'organizations' AND column_name = 'max_sites'`,
      )
    ).rows[0];
    expect(column).toEqual({ is_nullable: "YES", column_default: null, data_type: "integer" });
    await expect(pg.exec(`UPDATE organizations SET max_sites = -1 WHERE id = 'o'`)).rejects.toThrow(/organizations_max_sites_check/);
    await pg.exec(`UPDATE organizations SET max_sites = 0 WHERE id = 'o'`);
    expect(await maxSitesOf("o")).toBe(0);
    await pg.exec(`UPDATE organizations SET max_sites = NULL WHERE id = 'o'`);
    expect(await maxSitesOf("o")).toBeNull();
  });

  it("2. rollback compat: existing rows stay unlimited, the previous release's INSERTs still work, a second run is harmless", async () => {
    expect(await maxSitesOf("o")).toBeNull();
    // The statements the previous release runs: none names max_sites.
    await pg.exec(`
      INSERT INTO organizations (id, platform_installation_id, name, slug) VALUES ('o2','pi','o2','o2');
      INSERT INTO host_allocations (id, host_id, organization_id) VALUES ('a2','h','o2');
      INSERT INTO sites (id, organization_id, host_allocation_id, name, slug) VALUES ('s2','o2','a2','s2','s2');`);
    expect(await maxSitesOf("o2")).toBeNull();
    await pg.exec(`UPDATE organizations SET max_sites = 3 WHERE id = 'o'`);
    await pg.exec(read(M0023));
    expect(await maxSitesOf("o")).toBe(3);
    await expect(pg.exec(`UPDATE organizations SET max_sites = -1 WHERE id = 'o'`)).rejects.toThrow(/organizations_max_sites_check/);
  });
});

describe("@hosting-panel/database — site limit", () => {
  let client: DatabaseClient;
  const db = () => client.db;
  let n = 0;

  /** A fresh organization with its own host allocation, optionally with a limit. */
  async function organization(maxSites: number | null = null) {
    n += 1;
    const id = `org_sl_${String(n)}`;
    await db().insert(organizations).values({ id, platformInstallationId: "pin_sl", name: id, slug: id, maxSites });
    await db().insert(hostAllocations).values({ id: `al_${id}`, hostId: "h_sl", organizationId: id });
    return { id, allocation: `al_${id}` };
  }

  async function create(org: { id: string; allocation: string }, over: { initialDomain?: string; status?: "deploying" | "maintenance" } = {}) {
    n += 1;
    return createSiteTransactional(db(), {
      organizationId: org.id,
      hostAllocationId: org.allocation,
      name: `site ${String(n)}`,
      slug: `site-${String(n)}`,
      ...over,
    });
  }

  const countOf = async (id: string) => (await countSitesByOrganization(db(), [id])).get(id);

  beforeAll(async () => {
    client = createDatabaseClient({ mode: "pglite" });
    await client.migrate();
    await db().insert(platformInstallations).values({ id: "pin_sl", name: "P" });
    await db().insert(hosts).values({
      id: "h_sl", platformInstallationId: "pin_sl", name: "h", hostname: "h.sl.local", ipv4Address: "10.0.0.9",
      totalCpuMilli: 4000, totalMemoryBytes: "4000000000", totalStorageBytes: "100000000000",
    });
  }, 120_000);

  afterAll(async () => {
    await client.close();
  });

  it("3. NULL means unlimited", async () => {
    const org = await organization(null);
    for (let i = 0; i < 4; i += 1) await create(org);
    expect(await countOf(org.id)).toBe(4);
  });

  it("4. refuses the site past the limit with SiteLimitReachedError and leaves no site, domain or audit row", async () => {
    const org = await organization(2);
    await create(org);
    await create(org);
    const audits = async () => (await db().select().from(auditEvents).where(eq(auditEvents.organizationId, org.id))).length;
    const auditsBefore = await audits();
    const error = await create(org, { initialDomain: "third.sl.example" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SiteLimitReachedError);
    expect(error).toMatchObject({ code: "QUOTA_EXCEEDED", organizationId: org.id, maxSites: 2, usedSites: 2 });
    expect(await countOf(org.id)).toBe(2);
    expect(await db().select().from(domains).where(eq(domains.hostname, "third.sl.example"))).toHaveLength(0);
    expect(await audits()).toBe(auditsBefore);
  });

  it("5. max 0 refuses the first site", async () => {
    const org = await organization(0);
    await expect(create(org)).rejects.toMatchObject({ code: "QUOTA_EXCEEDED", maxSites: 0, usedSites: 0 });
    expect(await countOf(org.id)).toBe(0);
  });

  it("6. sites in deploying and maintenance status count", async () => {
    const org = await organization(2);
    await create(org, { status: "deploying" });
    await create(org, { status: "maintenance" });
    await expect(create(org)).rejects.toBeInstanceOf(SiteLimitReachedError);
  });

  it("7. the limit is per organization", async () => {
    const full = await organization(1);
    const other = await organization(1);
    await create(full);
    await expect(create(full)).rejects.toBeInstanceOf(SiteLimitReachedError);
    await create(other);
    expect(await countOf(other.id)).toBe(1);
  });

  it("8. lowering the limit below usage keeps the sites and refuses new ones", async () => {
    const org = await organization(null);
    await create(org);
    await create(org);
    await create(org);
    const lowered = await updateOrganizationSiteLimitTransactional(db(), { organizationId: org.id, maxSites: 1 });
    expect(lowered).toEqual({ previousMaxSites: null, maxSites: 1, usedSites: 3 });
    expect(await countOf(org.id)).toBe(3);
    await expect(create(org)).rejects.toMatchObject({ code: "QUOTA_EXCEEDED", maxSites: 1, usedSites: 3 });
    await updateOrganizationSiteLimitTransactional(db(), { organizationId: org.id, maxSites: 4 });
    await create(org);
    expect(await countOf(org.id)).toBe(4);
  });

  it("9. a move into a full organization throws and leaves the site where it was; a move into one with room works", async () => {
    const source = await organization(null);
    const full = await organization(1);
    const roomy = await organization(2);
    const unlimited = await organization(null);
    await create(full);
    const { site } = await create(source);
    const move = (to: { id: string; allocation: string }) =>
      moveSiteToOrganizationTransactional(db(), {
        siteId: site.id,
        fromOrganizationId: source.id,
        toOrganizationId: to.id,
        toHostAllocationId: to.allocation,
        masterKey: KEY,
      });
    const ownerOf = async () => (await db().select({ o: sites.organizationId }).from(sites).where(eq(sites.id, site.id)))[0]?.o;

    await expect(move(full)).rejects.toMatchObject({ code: "QUOTA_EXCEEDED", maxSites: 1, usedSites: 1 });
    expect(await ownerOf()).toBe(source.id);
    await move(roomy);
    expect(await ownerOf()).toBe(roomy.id);
    await moveSiteToOrganizationTransactional(db(), {
      siteId: site.id,
      fromOrganizationId: roomy.id,
      toOrganizationId: unlimited.id,
      toHostAllocationId: unlimited.allocation,
      masterKey: KEY,
    });
    expect(await ownerOf()).toBe(unlimited.id);
  });

  it("10. updateOrganizationSiteLimitTransactional returns the previous value and the usage; an unknown organization gives null", async () => {
    const org = await organization(5);
    await create(org);
    expect(await updateOrganizationSiteLimitTransactional(db(), { organizationId: org.id, maxSites: 7 })).toEqual({
      previousMaxSites: 5,
      maxSites: 7,
      usedSites: 1,
    });
    expect(await updateOrganizationSiteLimitTransactional(db(), { organizationId: org.id, maxSites: null })).toEqual({
      previousMaxSites: 7,
      maxSites: null,
      usedSites: 1,
    });
    const [row] = await db().select().from(organizations).where(eq(organizations.id, org.id));
    expect(row?.maxSites).toBeNull();
    expect(await updateOrganizationSiteLimitTransactional(db(), { organizationId: "org_missing", maxSites: 1 })).toBeNull();
  });

  it("11. countSitesByOrganization maps organizations without sites to 0", async () => {
    const empty = await organization(null);
    const one = await organization(null);
    await create(one);
    const counts = await countSitesByOrganization(db(), [empty.id, one.id, "org_missing"]);
    expect(counts.get(empty.id)).toBe(0);
    expect(counts.get(one.id)).toBe(1);
    expect(counts.get("org_missing")).toBe(0);
    expect((await countSitesByOrganization(db(), [])).size).toBe(0);
  });

  it("12. two parallel creates with max 1 leave exactly one site", async () => {
    const org = await organization(1);
    const results = await Promise.allSettled([create(org), create(org)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(SiteLimitReachedError);
    expect(await countOf(org.id)).toBe(1);
  });

  it("12b. the check locks the organizations row FOR NO KEY UPDATE (PGlite serialises, so the lock itself is asserted on the source)", async () => {
    const source = readFileSync(fileURLToPath(new URL("../src/site-limit.ts", import.meta.url)), "utf8");
    expect(source).toContain('.for("no key update")');
    const full = await organization(0);
    await expect(db().transaction((tx) => assertSiteLimitAvailable(tx, full.id))).rejects.toBeInstanceOf(SiteLimitReachedError);
    await expect(db().transaction((tx) => assertSiteLimitAvailable(tx, "org_missing"))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
