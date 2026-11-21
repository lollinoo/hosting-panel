import {
  BUILT_IN_WORDPRESS_SOURCE,
  BUILT_IN_WORDPRESS_SPEC,
  BUILT_IN_WORDPRESS_TEMPLATE_ID,
  BUILT_IN_WORDPRESS_VERSION_ID,
  type SiteTemplateSpec,
} from "@hosting-panel/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addSiteTemplateVersion,
  archiveSiteTemplate,
  countSitesByTemplateVersion,
  countSitesOnNonBuiltInTemplateVersions,
  createDatabaseClient,
  createSiteTemplate,
  createSiteTransactional,
  ensureBuiltInSiteTemplates,
  ensureWordpressTemplate,
  eq,
  getSiteTemplate,
  getSiteTemplateForCreate,
  getSiteTemplateVersion,
  getSiteTemplateVersionById,
  hostAllocations,
  hosts,
  listCustomerSiteTemplates,
  listSiteTemplateRefs,
  listSiteTemplates,
  organizations,
  platformInstallations,
  readSiteTemplateSpec,
  SiteTemplateRepositoryError,
  siteTemplateSpecHash,
  siteTemplates,
  siteTemplateVersions,
  sites,
  sql,
  updateSiteTemplate,
  type DatabaseClient,
  type SiteTemplateRepositoryErrorCode,
} from "../src/index.js";

// Site templates repository (ADR 0033): list/get/create/add version/update/archive, the counts behind the admin catalog
// and the release downgrade gate, the boot ensure of the built-in template and the template columns of createSite.
const HEAVY: SiteTemplateSpec = {
  ...BUILT_IN_WORDPRESS_SPEC,
  service: { ...BUILT_IN_WORDPRESS_SPEC.service, limits: { cpuMilli: 500, memoryBytes: "268435456" } },
};
const WITH_PHP: SiteTemplateSpec = { ...HEAVY, php: [{ key: "memory_limit", value: "256M" }] };

async function codeOf(promise: Promise<unknown>): Promise<SiteTemplateRepositoryErrorCode | "NO_ERROR"> {
  try {
    await promise;
    return "NO_ERROR";
  } catch (err) {
    if (err instanceof SiteTemplateRepositoryError) return err.code;
    throw err;
  }
}

describe("@hosting-panel/database - site templates repository", () => {
  let client: DatabaseClient;
  const db = () => client.db;
  let siteCounter = 0;

  async function newSite(input: { siteType?: "wordpress"; templateVersionId?: string; templateParameters?: { key: string; value: string | number | boolean }[] }) {
    siteCounter += 1;
    const { site } = await createSiteTransactional(db(), {
      organizationId: "org_t",
      hostAllocationId: "al_t",
      name: `Site ${String(siteCounter)}`,
      slug: `site-${String(siteCounter)}`,
      ...input,
    });
    return site;
  }

  async function builtIn() {
    const [row] = await db().select().from(siteTemplates).where(eq(siteTemplates.id, BUILT_IN_WORDPRESS_TEMPLATE_ID));
    return row!;
  }

  beforeAll(async () => {
    client = createDatabaseClient({ mode: "pglite" });
    await client.migrate();
    await db().insert(platformInstallations).values({ id: "pin", name: "P" });
    await db().insert(hosts).values({
      id: "h1", platformInstallationId: "pin", name: "h", hostname: "h.local", ipv4Address: "10.0.0.1",
      totalCpuMilli: 4000, totalMemoryBytes: "4000000000", totalStorageBytes: "100000000000",
    });
    await db().insert(organizations).values({ id: "org_t", platformInstallationId: "pin", name: "T", slug: "t" });
    await db().insert(hostAllocations).values({ id: "al_t", hostId: "h1", organizationId: "org_t" });
    await ensureWordpressTemplate(db());
  }, 120_000);

  afterAll(async () => {
    await client.close();
  });

  it("1. ensureWordpressTemplate seeds the enabled built-in template; running the ensure again changes nothing", async () => {
    const first = await builtIn();
    expect(first).toMatchObject({
      id: BUILT_IN_WORDPRESS_TEMPLATE_ID,
      module: "wordpress",
      name: "WordPress",
      builtIn: true,
      enabled: true,
      defaultVersionId: BUILT_IN_WORDPRESS_VERSION_ID,
      archivedAt: null,
    });
    const [version] = await db().select().from(siteTemplateVersions).where(eq(siteTemplateVersions.id, BUILT_IN_WORDPRESS_VERSION_ID));
    expect(version).toMatchObject({ templateId: BUILT_IN_WORDPRESS_TEMPLATE_ID, versionNumber: 1, source: BUILT_IN_WORDPRESS_SOURCE, createdBy: null });
    expect(version?.spec).toEqual(BUILT_IN_WORDPRESS_SPEC);
    expect(version?.specHash).toBe(siteTemplateSpecHash(BUILT_IN_WORDPRESS_SPEC));
    expect(siteTemplateSpecHash(BUILT_IN_WORDPRESS_SPEC)).toMatch(/^[0-9a-f]{64}$/);

    await ensureBuiltInSiteTemplates(db());
    await ensureWordpressTemplate(db());
    expect(await builtIn()).toEqual(first);
    expect((await db().select().from(siteTemplates)).length).toBe(1);
    expect((await db().select().from(siteTemplateVersions)).length).toBe(1);
    expect(readSiteTemplateSpec(version!)).toEqual(BUILT_IN_WORDPRESS_SPEC);
  });

  it("2. the ensure never overrides an admin's choices, and repairs only a template left without a default", async () => {
    const v2 = await addSiteTemplateVersion(db(), { templateId: BUILT_IN_WORDPRESS_TEMPLATE_ID, source: "# built-in v2\n", spec: HEAVY, createdBy: null, makeDefault: true });
    await updateSiteTemplate(db(), BUILT_IN_WORDPRESS_TEMPLATE_ID, { name: "Classic WordPress", enabled: false });
    await ensureBuiltInSiteTemplates(db());
    expect(await builtIn()).toMatchObject({ name: "Classic WordPress", enabled: false, defaultVersionId: v2.version.id });

    await db().update(siteTemplates).set({ enabled: false, defaultVersionId: null }).where(eq(siteTemplates.id, BUILT_IN_WORDPRESS_TEMPLATE_ID));
    await ensureBuiltInSiteTemplates(db());
    expect(await builtIn()).toMatchObject({ enabled: true, defaultVersionId: BUILT_IN_WORDPRESS_VERSION_ID });
    await updateSiteTemplate(db(), BUILT_IN_WORDPRESS_TEMPLATE_ID, { name: "WordPress", defaultVersionId: BUILT_IN_WORDPRESS_VERSION_ID });
    expect((await db().select().from(siteTemplateVersions).where(eq(siteTemplateVersions.templateId, BUILT_IN_WORDPRESS_TEMPLATE_ID))).length).toBe(2);
  });

  it("3. createSiteTemplate stores version 1 as the default of a disabled custom template", async () => {
    const created = await createSiteTemplate(db(), { module: "wordpress", name: "Lean WordPress", description: "Small", source: "# lean\n", spec: HEAVY, createdBy: null });
    expect(created.template).toMatchObject({ module: "wordpress", name: "Lean WordPress", description: "Small", builtIn: false, enabled: false, defaultVersionId: created.version.id, archivedAt: null });
    expect(created.version).toMatchObject({ templateId: created.template.id, versionNumber: 1, source: "# lean\n", createdBy: null });
    expect(created.template.id).toMatch(/^stpl_[a-z0-9]{24}$/);
    expect(created.version.id).toMatch(/^stv_[a-z0-9]{24}$/);
    expect(created.version.specHash).toBe(siteTemplateSpecHash(HEAVY));
    const [stored] = await db().select().from(siteTemplates).where(eq(siteTemplates.id, created.template.id));
    expect(stored?.defaultVersionId).toBe(created.version.id);

    const wrongModule = { ...HEAVY, module: "drupal" } as unknown as SiteTemplateSpec;
    expect(await codeOf(createSiteTemplate(db(), { module: "wordpress", name: "Mismatch", source: "# m\n", spec: wrongModule, createdBy: null }))).toBe("MODULE_MISMATCH");
    expect(await codeOf(createSiteTemplate(db(), { module: "wordpress", name: "lean wordpress", source: "# dup\n", spec: HEAVY, createdBy: null }))).toBe("NAME_TAKEN");
    expect((await db().select().from(siteTemplates).where(eq(sql`lower(${siteTemplates.name})`, "mismatch"))).length).toBe(0);
  });

  it("4. addSiteTemplateVersion numbers versions contiguously, also under concurrency, and ignores an identical resubmit", async () => {
    const { template } = await createSiteTemplate(db(), { module: "wordpress", name: "Versioned", source: "# v1\n", spec: HEAVY, createdBy: null });
    for (let n = 2; n <= 7; n += 1) {
      const added = await addSiteTemplateVersion(db(), { templateId: template.id, source: `# v${String(n)}\n`, spec: HEAVY, createdBy: null, makeDefault: true });
      expect(added).toMatchObject({ created: true, version: { versionNumber: n }, template: { defaultVersionId: added.version.id } });
    }
    const burst = await Promise.all(
      [8, 9, 10, 11, 12].map((n) => addSiteTemplateVersion(db(), { templateId: template.id, source: `# v${String(n)}\n`, spec: HEAVY, createdBy: null, makeDefault: false })),
    );
    expect(burst.map((r) => r.version.versionNumber).sort((a, b) => a - b)).toEqual([8, 9, 10, 11, 12]);
    const latest = (await getSiteTemplate(db(), template.id))!.versions[0]!;
    expect(latest.versionNumber).toBe(12);

    const { template: afterBurst } = (await getSiteTemplate(db(), template.id))!;
    expect(afterBurst.defaultVersionId).not.toBe(latest.id);
    const same = await addSiteTemplateVersion(db(), { templateId: template.id, source: (await getSiteTemplateVersion(db(), template.id, latest.id))!.source, spec: HEAVY, createdBy: null, makeDefault: false });
    expect(same).toMatchObject({ created: false, version: { id: latest.id, versionNumber: 12 } });
    expect(same.template.defaultVersionId).toBe(afterBurst.defaultVersionId);
    const madeDefault = await addSiteTemplateVersion(db(), { templateId: template.id, source: (await getSiteTemplateVersion(db(), template.id, latest.id))!.source, spec: HEAVY, createdBy: null, makeDefault: true });
    expect(madeDefault).toMatchObject({ created: false, template: { defaultVersionId: latest.id } });
    expect((await getSiteTemplate(db(), template.id))!.versions.length).toBe(12);

    expect(await codeOf(addSiteTemplateVersion(db(), { templateId: "stpl_missing", source: "# x\n", spec: HEAVY, createdBy: null, makeDefault: true }))).toBe("NOT_FOUND");
    expect(await codeOf(addSiteTemplateVersion(db(), { templateId: template.id, source: "# x\n", spec: { ...HEAVY, module: "drupal" } as unknown as SiteTemplateSpec, createdBy: null, makeDefault: true }))).toBe("MODULE_MISMATCH");
    await archiveSiteTemplate(db(), template.id);
    expect(await codeOf(addSiteTemplateVersion(db(), { templateId: template.id, source: "# late\n", spec: HEAVY, createdBy: null, makeDefault: true }))).toBe("ARCHIVED");
  });

  it("5. updateSiteTemplate validates the default, the name and the archive state", async () => {
    const a = await createSiteTemplate(db(), { module: "wordpress", name: "Update A", description: "first", source: "# a\n", spec: HEAVY, createdBy: null });
    const b = await createSiteTemplate(db(), { module: "wordpress", name: "Update B", source: "# b\n", spec: HEAVY, createdBy: null });
    expect(await codeOf(updateSiteTemplate(db(), a.template.id, { defaultVersionId: b.version.id }))).toBe("INVALID_DEFAULT");
    expect(await codeOf(updateSiteTemplate(db(), a.template.id, { defaultVersionId: "stv_missing" }))).toBe("INVALID_DEFAULT");
    expect(await codeOf(updateSiteTemplate(db(), a.template.id, { name: "update b" }))).toBe("NAME_TAKEN");
    expect(await codeOf(updateSiteTemplate(db(), "stpl_missing", { name: "Nope" }))).toBe("NOT_FOUND");

    const v2 = await addSiteTemplateVersion(db(), { templateId: a.template.id, source: "# a2\n", spec: HEAVY, createdBy: null, makeDefault: false });
    const updated = await updateSiteTemplate(db(), a.template.id, { name: "Update A2", description: null, enabled: true, defaultVersionId: v2.version.id });
    expect(updated).toMatchObject({ name: "Update A2", description: null, enabled: true, defaultVersionId: v2.version.id });
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(a.template.updatedAt.getTime());
    expect(await updateSiteTemplate(db(), a.template.id, {})).toEqual(updated);
    expect(await updateSiteTemplate(db(), a.template.id, { name: "update a2" })).toMatchObject({ name: "update a2" });

    await archiveSiteTemplate(db(), b.template.id);
    expect(await codeOf(updateSiteTemplate(db(), b.template.id, { enabled: true }))).toBe("ARCHIVED");
    // The name of an archived template is free again.
    expect(await createSiteTemplate(db(), { module: "wordpress", name: "Update B", source: "# b\n", spec: HEAVY, createdBy: null })).toMatchObject({ template: { name: "Update B" } });
  });

  it("6. archiveSiteTemplate refuses the built-in, is idempotent and hides the template from the lists", async () => {
    expect(await codeOf(archiveSiteTemplate(db(), BUILT_IN_WORDPRESS_TEMPLATE_ID))).toBe("BUILT_IN");
    expect(await codeOf(archiveSiteTemplate(db(), "stpl_missing"))).toBe("NOT_FOUND");
    const { template } = await createSiteTemplate(db(), { module: "wordpress", name: "To archive", source: "# z\n", spec: HEAVY, createdBy: null });
    await updateSiteTemplate(db(), template.id, { enabled: true });
    const archived = await archiveSiteTemplate(db(), template.id);
    expect(archived.changed).toBe(true);
    expect(archived.template).toMatchObject({ enabled: false });
    expect(archived.template.archivedAt).toBeInstanceOf(Date);
    // A repeat reports that it changed nothing, so the caller writes no audit row.
    expect(await archiveSiteTemplate(db(), template.id)).toEqual({ template: archived.template, changed: false });
    expect((await listCustomerSiteTemplates(db())).map((r) => r.template.id)).not.toContain(template.id);
    expect((await listSiteTemplates(db())).map((r) => r.id)).not.toContain(template.id);
    expect((await listSiteTemplates(db(), { includeArchived: true })).map((r) => r.id)).toContain(template.id);
  });

  it("7. the customer list and getSiteTemplateForCreate only offer enabled, non-archived templates, the built-in first", async () => {
    const { template, version } = await createSiteTemplate(db(), { module: "wordpress", name: "AAA first by name", source: "# o\n", spec: HEAVY, createdBy: null });
    const customer = async () => (await listCustomerSiteTemplates(db())).map((r) => r.template.id);
    expect(await customer()).not.toContain(template.id);
    expect(await getSiteTemplateForCreate(db(), { templateId: template.id })).toBeNull();

    await updateSiteTemplate(db(), template.id, { enabled: true });
    const offered = await listCustomerSiteTemplates(db());
    expect(offered[0]!.template.id).toBe(BUILT_IN_WORDPRESS_TEMPLATE_ID);
    expect(offered.map((r) => r.template.id)).toContain(template.id);
    expect(offered.find((r) => r.template.id === template.id)!.version.id).toBe(version.id);
    expect(await getSiteTemplateForCreate(db(), { templateId: template.id })).toMatchObject({ template: { id: template.id }, version: { id: version.id } });
    expect(await getSiteTemplateForCreate(db(), { templateId: null })).toMatchObject({ template: { id: BUILT_IN_WORDPRESS_TEMPLATE_ID }, version: { id: BUILT_IN_WORDPRESS_VERSION_ID } });
    expect(await getSiteTemplateForCreate(db(), { templateId: "stpl_missing" })).toBeNull();

    await updateSiteTemplate(db(), BUILT_IN_WORDPRESS_TEMPLATE_ID, { enabled: false });
    expect(await getSiteTemplateForCreate(db(), { templateId: null })).toBeNull();
    expect(await customer()).not.toContain(BUILT_IN_WORDPRESS_TEMPLATE_ID);
    await updateSiteTemplate(db(), BUILT_IN_WORDPRESS_TEMPLATE_ID, { enabled: true });
    await updateSiteTemplate(db(), template.id, { enabled: false });
  });

  it("8. lists, versions and ids resolve through the repository", async () => {
    const { template, version } = await createSiteTemplate(db(), { module: "wordpress", name: "Lookup", source: "# l\n", spec: WITH_PHP, createdBy: null });
    expect(await getSiteTemplate(db(), "stpl_missing")).toBeNull();
    expect(await getSiteTemplateVersion(db(), template.id, "stv_missing")).toBeNull();
    expect(await getSiteTemplateVersion(db(), BUILT_IN_WORDPRESS_TEMPLATE_ID, version.id)).toBeNull();
    expect(await getSiteTemplateVersionById(db(), "stv_missing")).toBeNull();
    const byId = await getSiteTemplateVersionById(db(), version.id);
    expect(byId).toMatchObject({ template: { id: template.id }, version: { id: version.id } });
    expect(readSiteTemplateSpec(byId!.version)).toEqual(WITH_PHP);

    const detail = (await getSiteTemplate(db(), template.id))!;
    expect(detail.versions).toEqual([{ id: version.id, templateId: template.id, versionNumber: 1, createdAt: version.createdAt, siteCount: 0 }]);
    expect(Object.keys(detail.versions[0]!)).not.toContain("source");

    const summaries = await listSiteTemplates(db());
    expect(summaries[0]!.id).toBe(BUILT_IN_WORDPRESS_TEMPLATE_ID);
    const lower = summaries.slice(1).map((s) => s.name.toLowerCase());
    expect(lower).toEqual([...lower].sort());
    expect(summaries.find((s) => s.id === template.id)).toMatchObject({ defaultVersionNumber: 1, versionCount: 1, siteCount: 0 });
  });

  it("9. a version row that no longer matches the spec schema is CORRUPT", () => {
    expect(() => readSiteTemplateSpec({ spec: { specVersion: 2 } as unknown as SiteTemplateSpec })).toThrowError(SiteTemplateRepositoryError);
    try {
      readSiteTemplateSpec({ spec: {} as unknown as SiteTemplateSpec });
    } catch (err) {
      expect((err as SiteTemplateRepositoryError).code).toBe("CORRUPT");
    }
  });

  it("10. counts sites per effective version, folding legacy NULL rows into the built-in v1", async () => {
    const { template: customTemplate, version: custom } = await createSiteTemplate(db(), { module: "wordpress", name: "Counted", source: "# c\n", spec: HEAVY, createdBy: null });
    const before = await countSitesByTemplateVersion(db());
    const beforeNonBuiltIn = await countSitesOnNonBuiltInTemplateVersions(db());

    const legacy = await newSite({ siteType: "wordpress" });
    const onBuiltIn = await newSite({ siteType: "wordpress", templateVersionId: BUILT_IN_WORDPRESS_VERSION_ID });
    const onCustom = await newSite({ siteType: "wordpress", templateVersionId: custom.id });
    const generic = await newSite({});

    const after = await countSitesByTemplateVersion(db());
    expect(after.get(BUILT_IN_WORDPRESS_VERSION_ID)).toBe((before.get(BUILT_IN_WORDPRESS_VERSION_ID) ?? 0) + 2);
    expect(after.get(custom.id)).toBe(1);
    expect([...after.keys()].sort()).toEqual([BUILT_IN_WORDPRESS_VERSION_ID, custom.id].sort());
    expect(await countSitesOnNonBuiltInTemplateVersions(db())).toBe(beforeNonBuiltIn + 1);

    const refs = await listSiteTemplateRefs(db(), [legacy, onBuiltIn, onCustom, generic]);
    expect(refs.get(legacy.id)).toEqual({ templateId: BUILT_IN_WORDPRESS_TEMPLATE_ID, templateName: "WordPress", versionId: BUILT_IN_WORDPRESS_VERSION_ID, versionNumber: 1, defaultVersionId: BUILT_IN_WORDPRESS_VERSION_ID, defaultVersionNumber: 1 });
    expect(refs.get(onBuiltIn.id)).toEqual(refs.get(legacy.id));
    expect(refs.get(onCustom.id)).toEqual({ templateId: customTemplate.id, templateName: "Counted", versionId: custom.id, versionNumber: 1, defaultVersionId: custom.id, defaultVersionNumber: 1 });
    expect(refs.has(generic.id)).toBe(false);
    expect((await listSiteTemplateRefs(db(), [])).size).toBe(0);

    const summary = (await listSiteTemplates(db())).find((s) => s.id === customTemplate.id)!;
    expect(summary.siteCount).toBe(1);
    const builtInSummary = (await listSiteTemplates(db())).find((s) => s.id === BUILT_IN_WORDPRESS_TEMPLATE_ID)!;
    expect(builtInSummary.siteCount).toBe(after.get(BUILT_IN_WORDPRESS_VERSION_ID));
    expect(builtInSummary.defaultVersionNumber).toBe(1);
    expect((await getSiteTemplate(db(), BUILT_IN_WORDPRESS_TEMPLATE_ID))!.versions.find((v) => v.id === BUILT_IN_WORDPRESS_VERSION_ID)!.siteCount).toBe(after.get(BUILT_IN_WORDPRESS_VERSION_ID));
  });

  it("11. a site's reference reports the template's current default, not its own version", async () => {
    const { template, version } = await createSiteTemplate(db(), { module: "wordpress", name: "Moving default", source: "# m1\n", spec: HEAVY, createdBy: null });
    const site = await newSite({ siteType: "wordpress", templateVersionId: version.id });
    const v2 = await addSiteTemplateVersion(db(), { templateId: template.id, source: "# m2\n", spec: HEAVY, createdBy: null, makeDefault: true });
    expect((await listSiteTemplateRefs(db(), [site])).get(site.id)).toMatchObject({ versionId: version.id, versionNumber: 1, defaultVersionId: v2.version.id, defaultVersionNumber: 2 });
  });

  it("12. createSiteTransactional stores the template version and parameters, and leaves both NULL without them", async () => {
    const withTemplate = await newSite({ siteType: "wordpress", templateVersionId: BUILT_IN_WORDPRESS_VERSION_ID, templateParameters: [{ key: "a", value: 1 }, { key: "b", value: "x" }] });
    const [stored] = await db().select().from(sites).where(eq(sites.id, withTemplate.id));
    expect(stored).toMatchObject({ templateVersionId: BUILT_IN_WORDPRESS_VERSION_ID, templateParameters: [{ key: "a", value: 1 }, { key: "b", value: "x" }] });

    const plain = await newSite({ siteType: "wordpress" });
    const [plainStored] = await db().select().from(sites).where(eq(sites.id, plain.id));
    expect(plainStored?.templateVersionId).toBeNull();
    expect(plainStored?.templateParameters).toBeNull();

    await expect(newSite({ siteType: "wordpress", templateVersionId: "stv_missing" })).rejects.toThrow();
  });
});
