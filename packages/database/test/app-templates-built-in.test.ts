import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { APP_BUILT_IN_TEMPLATES, type AppTemplateSpec } from "@hosting-panel/contracts";
import { computeAppTemplateSpecHash } from "@hosting-panel/hosting-domain";
import {
  addAppTemplateVersion,
  appTemplates,
  appTemplateVersions,
  builtInAppTemplateItems,
  createDatabaseClient,
  ensureBuiltInAppTemplates,
  eq,
  getAppTemplate,
  updateAppTemplate,
  type BuiltInAppTemplateItem,
  type DatabaseClient,
} from "../src/index.js";

const WORDPRESS = (() => {
  const item = builtInAppTemplateItems().find((i) => i.slug === "wordpress-mariadb")!;
  return { ...item, source: item.version.source };
})();
/** Version 1 as the seed carries it; read lazily so a missing one fails the tests that need it, not the whole file. */
const first = () => WORDPRESS.previousVersions![0]!;
/** The seed as the release before WordPress version 2 shipped it: version 1 is the newest and the default. */
const seededBeforeVersion2 = (): readonly BuiltInAppTemplateItem[] =>
  builtInAppTemplateItems().map((i) =>
    i.slug === "wordpress-mariadb"
      ? { ...i, versionId: first().versionId, description: first().description, version: first().version, previousVersions: [] }
      : i,
  );

/** The databases that shipped a second version: each has its first one in `previousVersions`. */
const databasesWithVersion2 = () => builtInAppTemplateItems().filter((i) => i.category === "database" && i.previousVersions !== undefined);
/** The seed as the release before the second version of the databases shipped it: version 1 is the newest and the default. */
const seededBeforeDatabaseVersion2 = (): readonly BuiltInAppTemplateItem[] =>
  builtInAppTemplateItems().map((i) => {
    const earlier = i.category === "database" ? i.previousVersions?.[0] : undefined;
    return earlier === undefined ? i : { ...i, versionId: earlier.versionId, description: earlier.description, version: earlier.version, previousVersions: [] };
  });

describe("@hosting-panel/database - built-in app templates", () => {
  it("validates and hashes the six seeds, each in the format it was written in", () => {
    const items = builtInAppTemplateItems();
    expect(items.map((i) => [i.templateId, i.versionId, i.slug, i.category])).toEqual([
      ["atpl_http_cache", "atv_http_cache_1", "http-cache", "web"],
      ["atpl_worker_storage", "atv_worker_storage_1", "worker-storage", "jobs"],
      ["atpl_wordpress_mariadb", "atv_wordpress_mariadb_2", "wordpress-mariadb", "content"],
      ["atpl_mariadb", "atv_mariadb_2", "mariadb", "database"],
      ["atpl_postgresql", "atv_postgresql_2", "postgresql", "database"],
      ["atpl_valkey", "atv_valkey_2", "valkey", "database"],
    ]);
    expect(items.map((i) => i.version.specVersion)).toEqual([1, 1, 2, 1, 1, 1]);
    items.forEach((item, index) => {
      const t = APP_BUILT_IN_TEMPLATES[index]!;
      expect(item).toMatchObject({ name: t.name, description: t.description });
      expect(item.version).toMatchObject({ source: t.source });
      expect((item.version.compiledSchema as AppTemplateSpec).schemaVersion).toBe(item.version.specVersion);
      expect(item.version.specHash).toBe(computeAppTemplateSpecHash(item.version.compiledSchema as AppTemplateSpec));
      expect(item.version.specHash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  it("carries the earlier WordPress version, validated and hashed, before the newest one", () => {
    const items = builtInAppTemplateItems();
    expect(items.filter((i) => i.previousVersions !== undefined).map((i) => i.slug)).toEqual(["wordpress-mariadb", "mariadb", "postgresql", "valkey"]);
    const item = items.find((i) => i.slug === "wordpress-mariadb")!;
    const t = APP_BUILT_IN_TEMPLATES.find((s) => s.slug === "wordpress-mariadb")!;
    expect(item.previousVersions).toHaveLength(1);
    const first = item.previousVersions![0]!;
    expect(first.versionId).toBe("atv_wordpress_mariadb_1");
    expect(first.version.source).toBe(t.previousVersions![0]!.source);
    expect(first.version.specVersion).toBe(2);
    expect(first.version.specHash).toBe("78625e4ec918338d8c20b88ce42f1ec366f065412d0b1a190ee211a886bf42eb");
    expect(first.version.specHash).toBe(computeAppTemplateSpecHash(first.version.compiledSchema as AppTemplateSpec));
    // The description each version showed in the catalog: the seed moves it with the default only when nobody edited it.
    expect(first.description).toBe((first.version.compiledSchema as AppTemplateSpec).description);
    expect(first.description).not.toBe(item.description);
    expect(item.version.specHash).not.toBe(first.version.specHash);
  });

  it("carries the earlier version of each database that has one, validated and hashed, byte for byte as the seed gives it", () => {
    const items = databasesWithVersion2();
    expect(items.map((i) => i.slug)).toEqual(["mariadb", "postgresql", "valkey"]);
    for (const item of items) {
      const t = APP_BUILT_IN_TEMPLATES.find((s) => s.slug === item.slug)!;
      expect(item.previousVersions).toHaveLength(1);
      const first = item.previousVersions![0]!;
      expect(first.versionId).toBe(t.previousVersions![0]!.versionId);
      expect(first.version.source).toBe(t.previousVersions![0]!.source);
      expect(first.version.specVersion).toBe(1);
      expect(first.version.specHash).toBe(computeAppTemplateSpecHash(first.version.compiledSchema as AppTemplateSpec));
      expect(first.version.specHash).toMatch(/^[a-f0-9]{64}$/);
      expect(first.version.source).not.toBe(item.version.source);
      expect(first.version.specHash).not.toBe(item.version.specHash);
    }
  });

  it("throws naming the slug and the issue codes only when a seed does not validate", () => {
    expect(() => builtInAppTemplateItems([])).toThrow(/^built-in app template http-cache is invalid: IMAGE_NOT_ALLOWLISTED(,IMAGE_NOT_ALLOWLISTED)*$/);
  });

  it("stores no value for the secrets the WordPress seed generates: only their rule", () => {
    const item = builtInAppTemplateItems().find((i) => i.slug === "wordpress-mariadb")!;
    const spec = item.version.compiledSchema as AppTemplateSpec;
    expect(spec.parameters.map((p) => [p.key, p.type, p.customer, "generate" in p ? p.generate : undefined])).toEqual([
      ["db_password", "secret", false, { kind: "password", length: 32 }],
      ["db_root_password", "secret", false, { kind: "password", length: 32 }],
    ]);
  });

  describe("seeded on PGlite", () => {
    let client: DatabaseClient;
    const db = () => client.db;

    beforeAll(async () => {
      client = createDatabaseClient({ mode: "pglite" });
      await client.migrate();
    }, 120_000);

    afterAll(async () => {
      await client.close();
    });

    it("seeds six disabled built-in templates, one version each but the WordPress and the database ones that have an earlier one, twice without change, keeping an admin rename", async () => {
      await ensureBuiltInAppTemplates(db(), builtInAppTemplateItems());
      await updateAppTemplate(db(), { templateId: "atpl_http_cache", name: "Il mio sito" });
      await ensureBuiltInAppTemplates(db(), builtInAppTemplateItems());

      const templates = await db().select().from(appTemplates).orderBy(appTemplates.id);
      expect(templates.map((t) => [t.id, t.builtIn, t.enabled, t.defaultVersionId])).toEqual([
        ["atpl_http_cache", true, false, "atv_http_cache_1"],
        ["atpl_mariadb", true, false, "atv_mariadb_2"],
        ["atpl_postgresql", true, false, "atv_postgresql_2"],
        ["atpl_valkey", true, false, "atv_valkey_2"],
        ["atpl_wordpress_mariadb", true, false, "atv_wordpress_mariadb_2"],
        ["atpl_worker_storage", true, false, "atv_worker_storage_1"],
      ]);
      const stored = await db().select({ id: appTemplateVersions.id, specVersion: appTemplateVersions.specVersion }).from(appTemplateVersions);
      expect(Object.fromEntries(stored.map((v) => [v.id, v.specVersion]))).toEqual({
        atv_http_cache_1: 1,
        atv_worker_storage_1: 1,
        atv_wordpress_mariadb_1: 2,
        atv_wordpress_mariadb_2: 2,
        atv_mariadb_1: 1,
        atv_mariadb_2: 1,
        atv_postgresql_1: 1,
        atv_postgresql_2: 1,
        atv_valkey_1: 1,
        atv_valkey_2: 1,
      });
      expect(await getAppTemplate(db(), "atpl_http_cache")).toMatchObject({ name: "Il mio sito" });
      expect(await getAppTemplate(db(), "atpl_worker_storage")).toMatchObject({ name: "Lavoro periodico con archivio" });
      for (const t of templates) {
        const versions = await db().select().from(appTemplateVersions).where(eq(appTemplateVersions.templateId, t.id)).orderBy(appTemplateVersions.versionNumber);
        expect(versions.map((v) => [v.id, v.versionNumber])).toEqual(
          t.id === "atpl_wordpress_mariadb"
            ? [
                ["atv_wordpress_mariadb_1", 1],
                ["atv_wordpress_mariadb_2", 2],
              ]
            : t.id === "atpl_mariadb"
              ? [
                  ["atv_mariadb_1", 1],
                  ["atv_mariadb_2", 2],
                ]
              : t.id === "atpl_postgresql"
                ? [
                    ["atv_postgresql_1", 1],
                    ["atv_postgresql_2", 2],
                  ]
                : t.id === "atpl_valkey"
                  ? [
                      ["atv_valkey_1", 1],
                      ["atv_valkey_2", 2],
                    ]
                  : [[t.defaultVersionId, 1]],
        );
      }
      expect(await getAppTemplate(db(), "atpl_wordpress_mariadb")).toMatchObject({ description: WORDPRESS.description });
    });
  });

  describe("an installation seeded before WordPress version 2 (PGlite)", () => {
    let client: DatabaseClient;
    const db = () => client.db;
    const versionsOf = (templateId: string) =>
      db().select().from(appTemplateVersions).where(eq(appTemplateVersions.templateId, templateId)).orderBy(appTemplateVersions.versionNumber);

    beforeEach(async () => {
      client = createDatabaseClient({ mode: "pglite" });
      await client.migrate();
      await ensureBuiltInAppTemplates(db(), seededBeforeVersion2());
    }, 120_000);

    afterEach(async () => {
      await client.close();
    });

    it("gets version 2 at the next start, as number 2 and the default, with its description; version 1 is not rewritten", async () => {
      const [before] = await versionsOf("atpl_wordpress_mariadb");
      expect(before).toMatchObject({ id: "atv_wordpress_mariadb_1", versionNumber: 1 });
      expect(await getAppTemplate(db(), "atpl_wordpress_mariadb")).toMatchObject({ defaultVersionId: "atv_wordpress_mariadb_1", description: first().description });
      await updateAppTemplate(db(), { templateId: "atpl_wordpress_mariadb", enabled: true });

      await ensureBuiltInAppTemplates(db(), builtInAppTemplateItems());
      const after = await versionsOf("atpl_wordpress_mariadb");
      expect(after.map((v) => [v.id, v.versionNumber, v.createdBy])).toEqual([
        ["atv_wordpress_mariadb_1", 1, null],
        ["atv_wordpress_mariadb_2", 2, null],
      ]);
      expect(after[0]).toEqual(before);
      expect(after[1]).toMatchObject({ source: WORDPRESS.source, specHash: WORDPRESS.version.specHash });
      const template = await getAppTemplate(db(), "atpl_wordpress_mariadb");
      expect(template).toMatchObject({ defaultVersionId: "atv_wordpress_mariadb_2", description: WORDPRESS.description, enabled: true, name: WORDPRESS.name });

      // A third start changes nothing.
      await ensureBuiltInAppTemplates(db(), builtInAppTemplateItems());
      expect(await versionsOf("atpl_wordpress_mariadb")).toEqual(after);
      expect(await getAppTemplate(db(), "atpl_wordpress_mariadb")).toEqual(template);
    });

    it("keeps a description the administrator wrote, while the default still moves", async () => {
      await updateAppTemplate(db(), { templateId: "atpl_wordpress_mariadb", description: "Il nostro WordPress" });
      await ensureBuiltInAppTemplates(db(), builtInAppTemplateItems());
      expect(await getAppTemplate(db(), "atpl_wordpress_mariadb")).toMatchObject({ defaultVersionId: "atv_wordpress_mariadb_2", description: "Il nostro WordPress" });
    });

    it("keeps a default the administrator chose among their own versions; version 2 takes the next number", async () => {
      const changed = await addAppTemplateVersion(db(), {
        templateId: "atpl_wordpress_mariadb",
        version: { ...first().version, source: `${first().version.source}# own\n` },
        createdBy: null,
      });
      expect(changed.version.versionNumber).toBe(2);
      await updateAppTemplate(db(), { templateId: "atpl_wordpress_mariadb", defaultVersionId: changed.version.id });

      await ensureBuiltInAppTemplates(db(), builtInAppTemplateItems());
      expect((await versionsOf("atpl_wordpress_mariadb")).map((v) => [v.id, v.versionNumber])).toEqual([
        ["atv_wordpress_mariadb_1", 1],
        [changed.version.id, 2],
        ["atv_wordpress_mariadb_2", 3],
      ]);
      expect(await getAppTemplate(db(), "atpl_wordpress_mariadb")).toMatchObject({ defaultVersionId: changed.version.id, description: first().description });
    });

    it("keeps the administrator's move back to version 1 at the next start", async () => {
      await ensureBuiltInAppTemplates(db(), builtInAppTemplateItems());
      await updateAppTemplate(db(), { templateId: "atpl_wordpress_mariadb", defaultVersionId: "atv_wordpress_mariadb_1" });
      await ensureBuiltInAppTemplates(db(), builtInAppTemplateItems());
      expect(await getAppTemplate(db(), "atpl_wordpress_mariadb")).toMatchObject({ defaultVersionId: "atv_wordpress_mariadb_1" });
      expect((await versionsOf("atpl_wordpress_mariadb")).map((v) => v.id)).toEqual(["atv_wordpress_mariadb_1", "atv_wordpress_mariadb_2"]);
    });
  });

  describe("an installation seeded before the second version of the databases (PGlite)", () => {
    let client: DatabaseClient;
    const db = () => client.db;
    const versionsOf = (templateId: string) =>
      db().select().from(appTemplateVersions).where(eq(appTemplateVersions.templateId, templateId)).orderBy(appTemplateVersions.versionNumber);

    beforeEach(async () => {
      client = createDatabaseClient({ mode: "pglite" });
      await client.migrate();
      await ensureBuiltInAppTemplates(db(), seededBeforeDatabaseVersion2());
    }, 120_000);

    afterEach(async () => {
      await client.close();
    });

    it("gets version 2 of each database at the next start, as number 2 and the default; version 1 is not rewritten; an enabled template stays enabled", async () => {
      const items = databasesWithVersion2();
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        const [before] = await versionsOf(item.templateId);
        expect(before).toMatchObject({ id: item.previousVersions![0]!.versionId, versionNumber: 1, source: item.previousVersions![0]!.version.source });
        expect(await getAppTemplate(db(), item.templateId)).toMatchObject({ defaultVersionId: before!.id, description: item.previousVersions![0]!.description });
        await updateAppTemplate(db(), { templateId: item.templateId, enabled: true });
      }

      await ensureBuiltInAppTemplates(db(), builtInAppTemplateItems());
      for (const item of items) {
        const first = item.previousVersions![0]!;
        const after = await versionsOf(item.templateId);
        expect(after.map((v) => [v.id, v.versionNumber, v.createdBy])).toEqual([
          [first.versionId, 1, null],
          [item.versionId, 2, null],
        ]);
        expect(after[0]).toMatchObject({ source: first.version.source, specHash: first.version.specHash });
        expect(after[1]).toMatchObject({ source: item.version.source, specHash: item.version.specHash });
        expect(await getAppTemplate(db(), item.templateId)).toMatchObject({
          defaultVersionId: item.versionId,
          description: item.description,
          enabled: true,
          name: item.name,
        });
      }

      // A third start changes nothing.
      const settled = await Promise.all(items.map(async (item) => [await versionsOf(item.templateId), await getAppTemplate(db(), item.templateId)] as const));
      await ensureBuiltInAppTemplates(db(), builtInAppTemplateItems());
      expect(await Promise.all(items.map(async (item) => [await versionsOf(item.templateId), await getAppTemplate(db(), item.templateId)] as const))).toEqual(settled);
    });

    it("keeps a description the administrator wrote, while the default still moves; the databases without a second version are untouched", async () => {
      const item = databasesWithVersion2()[0]!;
      await updateAppTemplate(db(), { templateId: item.templateId, description: "Il nostro database" });
      await ensureBuiltInAppTemplates(db(), builtInAppTemplateItems());
      expect(await getAppTemplate(db(), item.templateId)).toMatchObject({ defaultVersionId: item.versionId, description: "Il nostro database" });
      for (const other of builtInAppTemplateItems().filter((i) => i.category === "database" && i.previousVersions === undefined)) {
        expect((await versionsOf(other.templateId)).map((v) => [v.id, v.versionNumber])).toEqual([[other.versionId, 1]]);
      }
    });
  });
});
