import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addAppTemplateVersion,
  appStacks,
  AppTemplateRepositoryError,
  appTemplates,
  appTemplateVersions,
  archiveAppTemplate,
  countAppStacksByTemplateVersion,
  createAppTemplate,
  createDatabaseClient,
  ensureBuiltInAppTemplates,
  eq,
  getAppTemplate,
  getAppTemplateVersion,
  getPublishedAppTemplateVersion,
  hostAllocations,
  hosts,
  listAppTemplates,
  listAppTemplateVersions,
  listPublishedAppTemplates,
  organizations,
  platformInstallations,
  updateAppTemplate,
  type AppTemplateRepositoryErrorCode,
  type DatabaseClient,
  type NewAppTemplateVersion,
} from "../src/index.js";

const SPEC = JSON.parse(
  readFileSync(new URL("../../contracts/test/fixtures/app-stack-notes-demo/spec.json", import.meta.url), "utf8"),
) as Record<string, unknown>;
const version = (source: string, specHash = "a".repeat(64), compiledSchema: Record<string, unknown> = SPEC): NewAppTemplateVersion => ({
  source,
  specVersion: 1,
  compiledSchema,
  specHash,
});

async function codeOf(promise: Promise<unknown>): Promise<AppTemplateRepositoryErrorCode | string> {
  try {
    await promise;
    return "NO_ERROR";
  } catch (err) {
    if (err instanceof AppTemplateRepositoryError) return err.code;
    return (err as { code?: string }).code ?? "OTHER";
  }
}

describe("@hosting-panel/database - app templates repository", () => {
  let client: DatabaseClient;
  const db = () => client.db;
  let counter = 0;
  const fresh = (name = "Notes", source = "# v1\n") => {
    counter += 1;
    return createAppTemplate(db(), {
      slug: `tpl-${String(counter)}`,
      name,
      description: null,
      category: "web",
      firstVersion: version(source),
      createdBy: null,
    });
  };
  const add = (templateId: string, source: string, specHash?: string) =>
    addAppTemplateVersion(db(), { templateId, version: version(source, specHash), createdBy: null });
  const versionCount = async (templateId: string) =>
    (await db().select().from(appTemplateVersions).where(eq(appTemplateVersions.templateId, templateId))).length;

  beforeAll(async () => {
    client = createDatabaseClient({ mode: "pglite" });
    await client.migrate();
    await db().insert(platformInstallations).values({ id: "pin", name: "P" });
    await db().insert(hosts).values({
      id: "h1", platformInstallationId: "pin", name: "h", hostname: "h.local", ipv4Address: "10.0.0.1",
      totalCpuMilli: 4000, totalMemoryBytes: "4000000000", totalStorageBytes: "100000000000",
    });
    await db().insert(organizations).values({ id: "org_a", platformInstallationId: "pin", name: "A", slug: "a" });
    await db().insert(hostAllocations).values({ id: "al_a", hostId: "h1", organizationId: "org_a" });
  }, 120_000);

  afterAll(async () => {
    await client.close();
  });

  it("creates a disabled template whose default is version 1", async () => {
    const { template, version: v1 } = await fresh();
    expect(template).toMatchObject({ enabled: false, builtIn: false, archivedAt: null, defaultVersionId: v1.id, category: "web" });
    expect(template.id).toMatch(/^atpl_[0-9a-f]{24}$/);
    expect(v1).toMatchObject({ templateId: template.id, versionNumber: 1, source: "# v1\n", specVersion: 1, specHash: "a".repeat(64) });
    expect(v1.id).toMatch(/^atv_[0-9a-f]{24}$/);
    expect(v1.compiledSchema).toEqual(SPEC);
    expect(await getAppTemplate(db(), template.id)).toEqual(template);
    expect(await getAppTemplate(db(), "atpl_missing")).toBeNull();
  });

  it("refuses a taken slug with SLUG_TAKEN and stores nothing", async () => {
    const { template } = await fresh();
    const before = (await listAppTemplates(db())).length;
    expect(
      await codeOf(createAppTemplate(db(), { slug: template.slug, name: "Other", description: null, category: "web", firstVersion: version("# x\n"), createdBy: null })),
    ).toBe("SLUG_TAKEN");
    expect(await listAppTemplates(db())).toHaveLength(before);
  });

  it("numbers added versions and does not store the latest source and hash twice", async () => {
    const { template } = await fresh();
    const v2 = await add(template.id, "# v2\n");
    expect(v2).toMatchObject({ created: true, version: { versionNumber: 2 } });
    expect(v2.template.defaultVersionId).not.toBe(v2.version.id);
    const again = await add(template.id, "# v2\n");
    expect(again).toMatchObject({ created: false, version: { id: v2.version.id } });
    expect((await add(template.id, "# v2\n", "b".repeat(64))).version.versionNumber).toBe(3);
    expect((await listAppTemplateVersions(db(), template.id)).map((v) => v.versionNumber)).toEqual([3, 2, 1]);
    expect(await getAppTemplateVersion(db(), { templateId: template.id, versionId: v2.version.id })).toEqual(v2.version);
    expect(await getAppTemplateVersion(db(), { templateId: "atpl_other", versionId: v2.version.id })).toBeNull();
    expect(await codeOf(add("atpl_missing", "# x\n"))).toBe("NOT_FOUND");
  });

  it("numbers two concurrent additions 2 and 3", async () => {
    const { template } = await fresh();
    const results = await Promise.all([add(template.id, "# a\n"), add(template.id, "# b\n")]);
    expect(results.map((r) => r.version.versionNumber).sort()).toEqual([2, 3]);
  });

  it("updates metadata and reports only the fields that changed", async () => {
    const { template, version: v1 } = await fresh("Before");
    const { version: v2 } = await add(template.id, "# v2\n");
    const { template: updated, changes } = await updateAppTemplate(db(), {
      templateId: template.id, name: "After", description: null, category: "jobs", enabled: true, defaultVersionId: v2.id,
    });
    expect(updated).toMatchObject({ name: "After", category: "jobs", enabled: true, defaultVersionId: v2.id });
    expect(changes).toEqual([
      { field: "name", from: "Before", to: "After" },
      { field: "category", from: "web", to: "jobs" },
      { field: "enabled", from: false, to: true },
      { field: "defaultVersionId", from: v1.id, to: v2.id },
    ]);
    const same = await updateAppTemplate(db(), { templateId: template.id, name: "After" });
    expect(same.changes).toEqual([]);
    expect(same.template.updatedAt).toEqual(updated.updatedAt);
    expect(await codeOf(updateAppTemplate(db(), { templateId: "atpl_missing", name: "X" }))).toBe("NOT_FOUND");
  });

  it("refuses a default that is a version of another template", async () => {
    const { template } = await fresh();
    const { version: foreign } = await fresh();
    expect(await codeOf(updateAppTemplate(db(), { templateId: template.id, defaultVersionId: foreign.id }))).toBe("INVALID_DEFAULT");
  });

  it("cannot enable a template without a default version", async () => {
    await db().insert(appTemplates).values({ id: "atpl_nodefault", slug: "no-default", name: "No default", category: "web" });
    expect(await codeOf(updateAppTemplate(db(), { templateId: "atpl_nodefault", enabled: true }))).toBe("INVALID_DEFAULT");
    expect((await getAppTemplate(db(), "atpl_nodefault"))?.enabled).toBe(false);
  });

  it("archives once (changed true, then false) and then refuses edits and versions", async () => {
    const { template } = await fresh();
    await updateAppTemplate(db(), { templateId: template.id, enabled: true });
    const first = await archiveAppTemplate(db(), template.id);
    expect(first.changed).toBe(true);
    expect(first.template.enabled).toBe(false);
    expect(first.template.archivedAt).toBeInstanceOf(Date);
    expect((await archiveAppTemplate(db(), template.id)).changed).toBe(false);
    expect(await codeOf(add(template.id, "# late\n"))).toBe("ARCHIVED");
    expect(await codeOf(updateAppTemplate(db(), { templateId: template.id, name: "Late" }))).toBe("ARCHIVED");
    expect(await codeOf(archiveAppTemplate(db(), "atpl_missing"))).toBe("NOT_FOUND");
  });

  it("publishes only enabled, non-archived templates, and only their default version", async () => {
    const draft = await fresh("Draft");
    const published = await fresh("Published");
    const archived = await fresh("Archived");
    const { version: v2 } = await add(published.template.id, "# v2\n");
    await updateAppTemplate(db(), { templateId: published.template.id, enabled: true });
    await updateAppTemplate(db(), { templateId: archived.template.id, enabled: true });
    await archiveAppTemplate(db(), archived.template.id);

    const ids = (await listPublishedAppTemplates(db())).map((r) => r.template.id);
    expect(ids).toContain(published.template.id);
    expect(ids).not.toContain(draft.template.id);
    expect(ids).not.toContain(archived.template.id);
    const row = (await listPublishedAppTemplates(db())).find((r) => r.template.id === published.template.id);
    expect(row?.version.id).toBe(published.version.id);

    for (const lock of [false, true]) {
      expect((await getPublishedAppTemplateVersion(db(), { templateVersionId: published.version.id, lock }))?.template.id).toBe(published.template.id);
      expect(await getPublishedAppTemplateVersion(db(), { templateVersionId: v2.id, lock })).toBeNull();
      expect(await getPublishedAppTemplateVersion(db(), { templateVersionId: draft.version.id, lock })).toBeNull();
      expect(await getPublishedAppTemplateVersion(db(), { templateVersionId: archived.version.id, lock })).toBeNull();
    }
    await db().transaction(async (tx) => {
      expect(await getPublishedAppTemplateVersion(tx, { templateVersionId: published.version.id, lock: true })).not.toBeNull();
    });
  });

  it("lists every template by lower-case name, then id", async () => {
    const names = (await listAppTemplates(db())).map((t) => t.name.toLowerCase());
    expect(names).toEqual([...names].sort());
  });

  it("counts the live stacks of each version and ignores deleted ones", async () => {
    const { template, version: v1 } = await fresh();
    const { version: v2 } = await add(template.id, "# v2\n");
    await add(template.id, "# v3\n");
    const stack = (id: string, versionId: string, deleted = false) => ({
      id, organizationId: "org_a", hostAllocationId: "al_a", templateId: template.id, templateVersionId: versionId, name: id,
      ...(deleted ? { status: "deleted" as const, deletedAt: new Date() } : {}),
    });
    await db().insert(appStacks).values([stack("stk_c1", v1.id), stack("stk_c2", v1.id), stack("stk_c3", v2.id, true)]);
    expect(await countAppStacksByTemplateVersion(db(), template.id)).toEqual([{ templateVersionId: v1.id, stacks: 2 }]);
  });

  it("seeds built-in templates once and never overwrites an admin edit", async () => {
    const items = [
      { templateId: "atpl_seed", versionId: "atv_seed_1", slug: "seed", name: "Seed", description: "d", category: "web", version: version("# seed\n") },
    ];
    await ensureBuiltInAppTemplates(db(), items);
    const seeded = await getAppTemplate(db(), "atpl_seed");
    expect(seeded).toMatchObject({ builtIn: true, enabled: false, defaultVersionId: "atv_seed_1", name: "Seed" });
    await updateAppTemplate(db(), { templateId: "atpl_seed", name: "Renamed", enabled: true });
    await ensureBuiltInAppTemplates(db(), items);
    expect(await getAppTemplate(db(), "atpl_seed")).toMatchObject({ name: "Renamed", enabled: true, defaultVersionId: "atv_seed_1" });
    expect(await versionCount("atpl_seed")).toBe(1);
    expect((await listAppTemplates(db())).filter((t) => t.id === "atpl_seed")).toHaveLength(1);
    expect(await codeOf(archiveAppTemplate(db(), "atpl_seed"))).toBe("BUILT_IN");
  });

  it("refuses a compiled schema that carries a password key or a PEM string", async () => {
    const { template } = await fresh();
    const pem = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----";
    for (const compiledSchema of [{ ...SPEC, password: "hunter2" }, { ...SPEC, note: pem }]) {
      expect(await codeOf(addAppTemplateVersion(db(), { templateId: template.id, version: version("# s\n", undefined, compiledSchema), createdBy: null }))).toBe("VALIDATION_ERROR");
      expect(
        await codeOf(createAppTemplate(db(), { slug: "secret-tpl", name: "S", description: null, category: "web", firstVersion: version("# s\n", undefined, compiledSchema), createdBy: null })),
      ).toBe("VALIDATION_ERROR");
      expect(await codeOf(ensureBuiltInAppTemplates(db(), [{ templateId: "atpl_s", versionId: "atv_s", slug: "seed-s", name: "S", description: null, category: "web", version: version("# s\n", undefined, compiledSchema) }]))).toBe("VALIDATION_ERROR");
    }
    expect(await versionCount(template.id)).toBe(1);
    expect((await listAppTemplates(db())).filter((t) => t.slug === "secret-tpl" || t.id === "atpl_s")).toEqual([]);
  });
});
