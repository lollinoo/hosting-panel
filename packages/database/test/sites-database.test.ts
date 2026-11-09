import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabaseClient,
  createSiteTransactional,
  domains,
  encryptSecretAesGcm,
  encryptedSecrets,
  ensurePresetRolesAndPermissions,
  permissions,
  resourceGrants,
  users,
  ensureWordpressTemplate,
  eq,
  hostAllocations,
  hosts,
  insertSiteDatabase,
  latestSiteOperation,
  listSiteDatabases,
  moveSiteToOrganizationTransactional,
  operations,
  organizations,
  platformInstallations,
  renewOperationLease,
  resolveDecryptedSecretRefs,
  serviceInstances,
  serviceTemplates,
  sites,
  sql,
  stackRevisions,
  type DatabaseClient,
} from "../src/index.js";

const KEY = "a".repeat(64);

describe("@hosting-panel/database — 0004 sites and databases", () => {
  let client: DatabaseClient;
  const db = () => client.db;

  beforeAll(async () => {
    client = createDatabaseClient({ mode: "pglite" });
    await client.migrate();
    await db().insert(platformInstallations).values({ id: "pin", name: "P" });
    await db().insert(hosts).values({
      id: "h1", platformInstallationId: "pin", name: "h", hostname: "h.local", ipv4Address: "10.0.0.1",
      totalCpuMilli: 4000, totalMemoryBytes: "4000000000", totalStorageBytes: "100000000000",
    });
    for (const o of ["A", "B"]) {
      await db().insert(organizations).values({ id: `org_${o}`, platformInstallationId: "pin", name: o, slug: o.toLowerCase() });
      await db().insert(hostAllocations).values({ id: `al_${o}`, hostId: "h1", organizationId: `org_${o}` });
    }
  });

  afterAll(async () => {
    await client.close();
  });

  it("migration 0004 adds php_version and site_databases", async () => {
    const base = { organizationId: "org_A", hostAllocationId: "al_A" };
    const { site } = await createSiteTransactional(db(), { ...base, name: "ok", slug: "ok", phpVersion: "8.4" });
    expect(site.phpVersion).toBe("8.4");
    await expect(
      db().execute(sql`UPDATE sites SET php_version = '7.4' WHERE id = ${site.id}`),
    ).rejects.toThrow();
    expect(await listSiteDatabases(db(), { organizationId: "org_A", siteId: site.id })).toEqual([]);
  });

  it("ensureWordpressTemplate is idempotent", async () => {
    await ensureWordpressTemplate(db());
    await ensureWordpressTemplate(db());
    const rows = await db().select().from(serviceTemplates).where(eq(serviceTemplates.category, "site"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.defaultImage).toBe("wordpress:7.1.4-php8.4-apache");
  });

  it("createSiteTransactional honours status, phpVersion and initialDomainStatus", async () => {
    const { site, domain } = await createSiteTransactional(db(), {
      organizationId: "org_A", hostAllocationId: "al_A", name: "p", slug: "p",
      status: "deploying", phpVersion: "8.5", initialDomain: "p.example.com", initialDomainStatus: "pending",
    });
    expect(site.status).toBe("deploying");
    expect(site.phpVersion).toBe("8.5");
    expect(domain?.status).toBe("pending");
  });

  it("renewOperationLease extends a processing op and ignores a terminal one", async () => {
    const mk = (id: string, status: "processing" | "succeeded") =>
      db().insert(operations).values({
        id, organizationId: "org_A", kind: "site.provision", status, resourceType: "site", resourceId: "x",
        leaseExpiresAt: status === "processing" ? new Date(Date.now() + 1000) : null,
      });
    await mk("op_live", "processing");
    await mk("op_done", "succeeded");
    await renewOperationLease(db(), "op_live", 12 * 60_000);
    await renewOperationLease(db(), "op_done", 12 * 60_000);
    const [live] = await db().select().from(operations).where(eq(operations.id, "op_live"));
    const [done] = await db().select().from(operations).where(eq(operations.id, "op_done"));
    expect(live!.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 11 * 60_000);
    expect(done!.leaseExpiresAt).toBeNull();
  });

  describe("moving a site", () => {
    let siteId: string;
    beforeAll(async () => {
      const { site } = await createSiteTransactional(db(), {
        organizationId: "org_A", hostAllocationId: "al_A", name: "mv", slug: "mv", phpVersion: "8.4", initialDomain: "mv.example.com",
      });
      siteId = site.id;
      await db().insert(serviceInstances).values({ id: "svc_mv", siteId, organizationId: "org_A", serviceTemplateId: "tpl_site_wordpress", name: "wp" });
      await db().insert(stackRevisions).values({
        id: "rev_mv", serviceInstanceId: "svc_mv", organizationId: "org_A", revisionNumber: 1, specHash: "h", declarativeConfig: {},
      });
      const env = encryptSecretAesGcm({ plaintext: "canary-db-1", masterKey: KEY, organizationId: "org_A", siteId, secretKey: "SITE_DB_PASSWORD" });
      await db().insert(encryptedSecrets).values({
        id: "sec_mv", organizationId: "org_A", siteId, secretKey: "SITE_DB_PASSWORD",
        ciphertextBase64: env.ciphertextBase64, ivBase64: env.ivBase64, authTagBase64: env.authTagBase64,
      });
      await insertSiteDatabase(db(), { id: "sdb_mv", organizationId: "org_A", siteId, dbName: "wp_mv", dbUser: "wp_mv", passwordSecretId: "sec_mv" });
      await ensurePresetRolesAndPermissions(db());
      const [perm] = await db().select().from(permissions).limit(1);
      await db().insert(users).values({ id: "u_grant", email: "g@x.io", name: "G" });
      await db().insert(resourceGrants).values(
        [siteId, "svc_mv", "other_resource"].map((resourceId) => ({
          id: `grant_${resourceId}`, organizationId: "org_A", principalUserId: "u_grant", resourceId, permission: perm!.key,
        })),
      );
      await db().insert(operations).values([
        { id: "op_prov", organizationId: "org_A", kind: "site.provision", status: "succeeded", resourceType: "site", resourceId: siteId },
        { id: "op_run", organizationId: "org_A", kind: "site.reassign", status: "processing", resourceType: "site", resourceId: siteId },
      ]);
    });

    it("wrong organization throws NOT_FOUND and changes nothing", async () => {
      await expect(
        moveSiteToOrganizationTransactional(db(), { siteId, fromOrganizationId: "org_B", toOrganizationId: "org_B", toHostAllocationId: "al_B", masterKey: KEY }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      const [s] = await db().select().from(sites).where(eq(sites.id, siteId));
      expect(s?.organizationId).toBe("org_A");
    });

    it("cascades to children, re-encrypts secrets and moves operations (including a running one)", async () => {
      await moveSiteToOrganizationTransactional(db(), { siteId, fromOrganizationId: "org_A", toOrganizationId: "org_B", toHostAllocationId: "al_B", masterKey: KEY });
      const orgOf = async (t: typeof domains | typeof serviceInstances | typeof stackRevisions | typeof encryptedSecrets) =>
        (await db().select({ o: t.organizationId }).from(t as typeof domains).where(
          t === stackRevisions ? eq(stackRevisions.id, "rev_mv") as never : eq((t as typeof domains).siteId, siteId),
        )).map((r) => r.o);
      expect(await orgOf(domains)).toEqual(["org_B"]);
      expect(await orgOf(serviceInstances)).toEqual(["org_B"]);
      expect(await orgOf(stackRevisions)).toEqual(["org_B"]);
      expect(await orgOf(encryptedSecrets)).toEqual(["org_B"]);
      expect((await listSiteDatabases(db(), { organizationId: "org_B", siteId })).map((r) => r.id)).toEqual(["sdb_mv"]);
      expect(await listSiteDatabases(db(), { organizationId: "org_A", siteId })).toEqual([]);
      const [s] = await db().select().from(sites).where(eq(sites.id, siteId));
      expect(s?.hostAllocationId).toBe("al_B");

      const resolve = (organizationId: string) =>
        resolveDecryptedSecretRefs(db(), { organizationId, siteId, secretRefs: { SITE_DB_PASSWORD: "SITE_DB_PASSWORD" }, masterKey: KEY });
      expect((await resolve("org_B")).SITE_DB_PASSWORD).toBe("canary-db-1");
      await expect(resolve("org_A")).rejects.toMatchObject({ code: "NOT_FOUND" });

      for (const id of ["op_prov", "op_run"]) {
        const [op] = await db().select().from(operations).where(eq(operations.id, id));
        expect(op?.organizationId).toBe("org_B");
      }
      expect((await db().select().from(resourceGrants)).map((g) => g.resourceId)).toEqual(["other_resource"]);
      const [running] = await db().select().from(operations).where(eq(operations.id, "op_run"));
      expect(running?.status).toBe("processing");
      expect((await latestSiteOperation(db(), { siteId, kind: "site.reassign" }))?.id).toBe("op_run");
    });
  });
});
