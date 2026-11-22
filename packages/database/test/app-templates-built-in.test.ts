import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_BUILT_IN_TEMPLATES, type AppTemplateSpec } from "@hosting-panel/contracts";
import { computeAppTemplateSpecHash } from "@hosting-panel/hosting-domain";
import {
  appTemplates,
  appTemplateVersions,
  builtInAppTemplateItems,
  createDatabaseClient,
  ensureBuiltInAppTemplates,
  eq,
  getAppTemplate,
  updateAppTemplate,
  type DatabaseClient,
} from "../src/index.js";

describe("@hosting-panel/database - built-in app templates", () => {
  it("validates and hashes both seeds", () => {
    const items = builtInAppTemplateItems();
    expect(items.map((i) => [i.templateId, i.versionId, i.slug, i.category])).toEqual([
      ["atpl_http_cache", "atv_http_cache_1", "http-cache", "web"],
      ["atpl_worker_storage", "atv_worker_storage_1", "worker-storage", "jobs"],
    ]);
    items.forEach((item, index) => {
      const t = APP_BUILT_IN_TEMPLATES[index]!;
      expect(item).toMatchObject({ name: t.name, description: t.description });
      expect(item.version).toMatchObject({ source: t.source, specVersion: 1 });
      expect(item.version.specHash).toBe(computeAppTemplateSpecHash(item.version.compiledSchema as AppTemplateSpec));
      expect(item.version.specHash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  it("throws naming the slug and the issue codes only when a seed does not validate", () => {
    expect(() => builtInAppTemplateItems([])).toThrow(/^built-in app template http-cache is invalid: IMAGE_NOT_ALLOWLISTED(,IMAGE_NOT_ALLOWLISTED)*$/);
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

    it("seeds two disabled built-in templates with one version each, twice without change, keeping an admin rename", async () => {
      await ensureBuiltInAppTemplates(db(), builtInAppTemplateItems());
      await updateAppTemplate(db(), { templateId: "atpl_http_cache", name: "Il mio sito" });
      await ensureBuiltInAppTemplates(db(), builtInAppTemplateItems());

      const templates = await db().select().from(appTemplates).orderBy(appTemplates.id);
      expect(templates.map((t) => [t.id, t.builtIn, t.enabled, t.defaultVersionId])).toEqual([
        ["atpl_http_cache", true, false, "atv_http_cache_1"],
        ["atpl_worker_storage", true, false, "atv_worker_storage_1"],
      ]);
      expect(await getAppTemplate(db(), "atpl_http_cache")).toMatchObject({ name: "Il mio sito" });
      expect(await getAppTemplate(db(), "atpl_worker_storage")).toMatchObject({ name: "Lavoro periodico con archivio" });
      for (const t of templates) {
        const versions = await db().select().from(appTemplateVersions).where(eq(appTemplateVersions.templateId, t.id));
        expect(versions.map((v) => [v.id, v.versionNumber])).toEqual([[t.defaultVersionId, 1]]);
      }
    });
  });
});
