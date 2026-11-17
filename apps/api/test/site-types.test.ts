import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabaseClient,
  DEMO_IDS,
  eq,
  seedPhase1Dataset,
  sites,
  type DatabaseClient,
} from "@hosting-panel/database";
import { createControlPlaneApp } from "../src/create-app.js";
import { findApiSiteType, getApiSiteType } from "../src/site-types/index.js";
import { TEST_API_SITE_TYPE } from "./fixtures/test-site-type.js";

interface PinnedJob {
  readonly kind: string;
  readonly params: Record<string, unknown>;
  readonly resolvedSecrets?: Record<string, string>;
}
/** The runSiteJob calls of one pin fixture, by kind. */
const pinnedJobs = (file: string, kind: string): PinnedJob[] => {
  const pins = JSON.parse(readFileSync(new URL(`./fixtures/site-type-pins/${file}`, import.meta.url), "utf8")) as {
    calls: { method: string; args: PinnedJob[] }[];
  };
  return pins.calls.filter((c) => c.method === "runSiteJob" && c.args[0]?.kind === kind).map((c) => c.args[0]!);
};

const KEY = "b".repeat(64);

describe("the API's site-type module", () => {
  const wordpress = getApiSiteType("wordpress");

  it("installs WordPress with the job the pins record", () => {
    const [pinned] = pinnedJobs("provision-jobs.json", "wordpress.install");
    const fields: Record<string, string> = { title: "Site A", adminUser: "siteadmin", adminEmail: "admin@example.test" };
    const job = wordpress.install!.job({
      phpVersion: "8.3",
      siteUrl: "http://wp-a.example.test",
      database: { dbName: "wp_<site-sha12>", dbUser: "wp_<site-sha12>" },
      hasAdminSecret: true,
      field: (key) => fields[key]!,
    });
    expect({ kind: job.kind, params: job.params }).toEqual({ kind: pinned!.kind, params: pinned!.params });
    expect(Object.keys(job.secrets!).sort()).toEqual(Object.keys(pinned!.resolvedSecrets!).sort());
    expect(job.secrets).toEqual({ HP_DB_PASSWORD: "SITE_DB_PASSWORD", HP_ADMIN_PASSWORD: "WP_ADMIN_PASSWORD_INITIAL" });
    expect(wordpress.install).toMatchObject({ step: "install_wordpress", label: "Install WordPress", done: "WordPress installed" });
  });

  it("moves the address with the jobs the domains and restore pins record", () => {
    const pinned = [...pinnedJobs("domains-jobs.json", "wordpress.set-url"), ...pinnedJobs("restore-requests.json", "wordpress.set-url")];
    expect(pinned).toHaveLength(2);
    for (const p of pinned) {
      const { siteUrl, previousUrl, phpVersion } = p.params as { siteUrl: string; previousUrl: string; phpVersion: string };
      expect(wordpress.addressJob({ phpVersion }, siteUrl, previousUrl)).toEqual({ kind: p.kind, params: p.params });
    }
  });

  it("resolves only known keys and keeps the image of a PHP version", () => {
    expect(findApiSiteType(null)).toBeNull();
    expect(findApiSiteType("teststatic")).toBeNull();
    expect(findApiSiteType("wordpress")).toBe(wordpress);
    expect(wordpress.image("8.3")).toBe("wordpress:7.1.4-php8.3-apache");
    expect(TEST_API_SITE_TYPE.addressJob({ phpVersion: null }, "https://wp-a.example.test", "http://wp-a.example.test")).toBeNull();
  });
});

describe("the legacy type at start (R205 point 2.2)", () => {
  let dbClient: DatabaseClient;
  const start = async () => {
    const app = await createControlPlaneApp({
      listen: false,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      runtimeBackend: "disabled",
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
      domainReconcileIntervalMs: null,
      recoverUnknownOnStart: false,
    });
    await app.close();
  };
  const typeOf = async (id: string) =>
    (await dbClient.db.select({ t: sites.siteType, u: sites.updatedAt }).from(sites).where(eq(sites.id, id)))[0];

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await seedPhase1Dataset(dbClient.db, KEY);
    // Rows as an older release writes them after a rollback: a PHP version and no type.
    await dbClient.db.insert(sites).values([
      { id: "site_old_wp", organizationId: DEMO_IDS.organizations.acme, hostAllocationId: DEMO_IDS.allocations.acme, name: "Old", slug: "old-wp", phpVersion: "8.4" },
      { id: "site_generic", organizationId: DEMO_IDS.organizations.acme, hostAllocationId: DEMO_IDS.allocations.acme, name: "Generic", slug: "generic" },
    ]);
  });

  afterAll(async () => {
    await dbClient.close();
  });

  it("gives the legacy type to a row with a PHP version, leaves a row without one null, and a second start changes nothing", async () => {
    expect((await typeOf("site_old_wp"))?.t).toBeNull();
    await start();
    const first = await typeOf("site_old_wp");
    expect(first?.t).toBe("wordpress");
    expect((await typeOf("site_generic"))?.t).toBeNull();
    await start();
    expect(await typeOf("site_old_wp")).toEqual(first);
    expect((await typeOf("site_generic"))?.t).toBeNull();
  });
});
