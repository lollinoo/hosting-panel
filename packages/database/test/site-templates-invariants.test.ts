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
  updateSiteTemplate,
  type DatabaseClient,
  type SiteTemplateRepositoryErrorCode,
} from "../src/index.js";

// Site templates (ADR 0033): invariants and races the happy-path repository tests do not reach. pglite serialises the
// statements of one connection, so the Promise.all cases prove the locking and conflict handling under interleaving.
const SPEC: SiteTemplateSpec = {
  ...BUILT_IN_WORDPRESS_SPEC,
  service: { ...BUILT_IN_WORDPRESS_SPEC.service, limits: { cpuMilli: 500, memoryBytes: "268435456" } },
};

async function codeOf(promise: Promise<unknown>): Promise<SiteTemplateRepositoryErrorCode | "NO_ERROR" | "OTHER"> {
  try {
    await promise;
    return "NO_ERROR";
  } catch (err) {
    return err instanceof SiteTemplateRepositoryError ? err.code : "OTHER";
  }
}

/** Every message of an error and its causes: drizzle wraps the driver error. */
async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    const messages: string[] = [];
    for (let current: unknown = err; current instanceof Error; current = current.cause) messages.push(current.message);
    return messages.join(" | ");
  }
  return "NO_ERROR";
}

describe("@hosting-panel/database - site templates invariants", () => {
  let client: DatabaseClient;
  const db = () => client.db;
  let counter = 0;
  const fresh = (name: string, source = "# v1\n") => createSiteTemplate(db(), { module: "wordpress", name, source, spec: SPEC, createdBy: null });
  const add = (templateId: string, source: string, makeDefault = false) =>
    addSiteTemplateVersion(db(), { templateId, source, spec: SPEC, createdBy: null, makeDefault });
  const numbers = async (templateId: string) =>
    (await db().select({ n: siteTemplateVersions.versionNumber }).from(siteTemplateVersions).where(eq(siteTemplateVersions.templateId, templateId))).map((r) => r.n).sort((a, b) => a - b);

  async function newSite(input: { siteType?: "wordpress"; templateVersionId?: string }) {
    counter += 1;
    const { site } = await createSiteTransactional(db(), {
      organizationId: "org_q",
      hostAllocationId: "al_q",
      name: `Site ${String(counter)}`,
      slug: `site-q-${String(counter)}`,
      ...input,
    });
    return site;
  }

  beforeAll(async () => {
    client = createDatabaseClient({ mode: "pglite" });
    await client.migrate();
    await db().insert(platformInstallations).values({ id: "pin", name: "P" });
    await db().insert(hosts).values({
      id: "h1", platformInstallationId: "pin", name: "h", hostname: "h.local", ipv4Address: "10.0.0.1",
      totalCpuMilli: 4000, totalMemoryBytes: "4000000000", totalStorageBytes: "100000000000",
    });
    await db().insert(organizations).values({ id: "org_q", platformInstallationId: "pin", name: "Q", slug: "q" });
    await db().insert(hostAllocations).values({ id: "al_q", hostId: "h1", organizationId: "org_q" });
    await ensureWordpressTemplate(db());
  }, 120_000);

  afterAll(async () => {
    await client.close();
  });

  describe("version numbers and immutability", () => {
    it("concurrent additions of the same source on one template store it once and all return the same version", async () => {
      const { template } = await fresh("Same source burst");
      const burst = await Promise.all([1, 2, 3, 4].map(() => add(template.id, "# shared\n")));
      expect(burst.filter((r) => r.created)).toHaveLength(1);
      expect(new Set(burst.map((r) => r.version.id)).size).toBe(1);
      expect(burst[0]!.version.versionNumber).toBe(2);
      expect(await numbers(template.id)).toEqual([1, 2]);
    });

    it("concurrent additions to two templates number each template independently from 2", async () => {
      const a = await fresh("Race A");
      const b = await fresh("Race B");
      const results = await Promise.all(
        [a, b, a, b, a, b].map(({ template }, i) => add(template.id, `# ${template.id}-${String(i)}\n`)),
      );
      expect(results.every((r) => r.created)).toBe(true);
      expect(await numbers(a.template.id)).toEqual([1, 2, 3, 4]);
      expect(await numbers(b.template.id)).toEqual([1, 2, 3, 4]);
    });

    it("a refused addition (module mismatch, archived, unknown template) leaves no gap in the numbering", async () => {
      const { template } = await fresh("No gaps");
      expect(await codeOf(addSiteTemplateVersion(db(), { templateId: template.id, source: "# bad\n", spec: { ...SPEC, module: "drupal" } as unknown as SiteTemplateSpec, createdBy: null, makeDefault: true }))).toBe("MODULE_MISMATCH");
      expect((await add(template.id, "# ok\n")).version.versionNumber).toBe(2);
      await archiveSiteTemplate(db(), template.id);
      expect(await codeOf(add(template.id, "# late\n"))).toBe("ARCHIVED");
      expect(await codeOf(add("stpl_missing", "# x\n"))).toBe("NOT_FOUND");
      expect(await numbers(template.id)).toEqual([1, 2]);
    });

    it("an addition racing the archive either lands before it or is refused with ARCHIVED, never after", async () => {
      const { template } = await fresh("Add vs archive");
      const settled = await Promise.allSettled([add(template.id, "# racing\n", true), archiveSiteTemplate(db(), template.id)]);
      const addResult = settled[0];
      if (addResult.status === "rejected") expect((addResult.reason as SiteTemplateRepositoryError).code).toBe("ARCHIVED");
      const [row] = await db().select().from(siteTemplates).where(eq(siteTemplates.id, template.id));
      expect(row).toMatchObject({ enabled: false });
      expect(row!.archivedAt).toBeInstanceOf(Date);
      expect(await codeOf(add(template.id, "# after\n"))).toBe("ARCHIVED");
      expect(await numbers(template.id)).toEqual(addResult.status === "fulfilled" ? [1, 2] : [1]);
    });

    it("no repository operation rewrites a stored version, and the stored hash survives the JSONB round trip", async () => {
      const { template } = await fresh("Untouched versions");
      await add(template.id, "# v2\n", true);
      const snapshot = async () => db().select().from(siteTemplateVersions).orderBy(siteTemplateVersions.id);
      const before = await snapshot();
      await ensureBuiltInSiteTemplates(db());
      await updateSiteTemplate(db(), template.id, { name: "Untouched versions renamed", enabled: true });
      await add(template.id, "# v2\n", true);
      await archiveSiteTemplate(db(), template.id);
      expect(await snapshot()).toEqual(before);
      for (const row of before) expect(siteTemplateSpecHash(readSiteTemplateSpec(row))).toBe(row.specHash);
    });

    it("the database refuses to rewrite or delete a version through the table API", async () => {
      const { version } = await fresh("Table API");
      expect(await failure(db().update(siteTemplateVersions).set({ source: "# tampered\n" }).where(eq(siteTemplateVersions.id, version.id)))).toMatch(/immutable/);
      expect(await failure(db().update(siteTemplateVersions).set({ versionNumber: 99 }).where(eq(siteTemplateVersions.id, version.id)))).toMatch(/immutable/);
      expect(await failure(db().delete(siteTemplateVersions).where(eq(siteTemplateVersions.id, version.id)))).toMatch(/immutable/);
      expect((await getSiteTemplateVersionById(db(), version.id))!.version).toEqual(version);
    });
  });

  describe("names", () => {
    it("concurrent creations with the same name in different case: one wins, the others get NAME_TAKEN and leave no rows", async () => {
      const versionsBefore = (await db().select().from(siteTemplateVersions)).length;
      const codes = await Promise.all(["Burst Name", "burst name", "BURST NAME"].map((name) => codeOf(fresh(name))));
      expect(codes.filter((c) => c === "NO_ERROR")).toHaveLength(1);
      expect(codes.filter((c) => c === "NAME_TAKEN")).toHaveLength(2);
      expect((await db().select().from(siteTemplates)).filter((t) => t.name.toLowerCase() === "burst name")).toHaveLength(1);
      expect((await db().select().from(siteTemplateVersions)).length).toBe(versionsBefore + 1);
    });

    it("two templates renamed to the same name concurrently: one wins, the other is NAME_TAKEN and keeps its name", async () => {
      const a = await fresh("Rename race A");
      const b = await fresh("Rename race B");
      const codes = await Promise.all([a, b].map(({ template }) => codeOf(updateSiteTemplate(db(), template.id, { name: "Rename Target" }))));
      expect([...codes].sort()).toEqual(["NAME_TAKEN", "NO_ERROR"]);
      const names = [a, b].map(({ template }) => template.id);
      const stored = await db().select().from(siteTemplates);
      const loser = stored.filter((t) => names.includes(t.id) && t.name !== "Rename Target");
      expect(loser).toHaveLength(1);
      expect(loser[0]!.name).toMatch(/^Rename race [AB]$/);
    });

    it("the name of an archived template is free for a new one, and archived duplicates can coexist", async () => {
      const first = await fresh("Recycled");
      await archiveSiteTemplate(db(), first.template.id);
      const second = await fresh("recycled");
      await archiveSiteTemplate(db(), second.template.id);
      expect(await codeOf(fresh("RECYCLED"))).toBe("NO_ERROR");
      expect(await codeOf(fresh("recycled"))).toBe("NAME_TAKEN");
    });

    it("compares names byte-wise apart from case: surrounding whitespace makes a distinct name (the DTO trims upstream)", async () => {
      await fresh("Padded");
      expect(await codeOf(fresh("Padded "))).toBe("NO_ERROR");
      expect(await codeOf(fresh("padded"))).toBe("NAME_TAKEN");
    });

    it("a name or description outside the length bounds is a plain database error, not NAME_TAKEN, and stores nothing", async () => {
      const versionsBefore = (await db().select().from(siteTemplateVersions)).length;
      expect(await codeOf(fresh("x".repeat(81)))).toBe("OTHER");
      expect(await codeOf(fresh(""))).toBe("OTHER");
      expect(await codeOf(createSiteTemplate(db(), { module: "wordpress", name: "Long description", description: "d".repeat(501), source: "# d\n", spec: SPEC, createdBy: null }))).toBe("OTHER");
      expect((await db().select().from(siteTemplateVersions)).length).toBe(versionsBefore);
    });
  });

  describe("enable, archive and default", () => {
    it("enabling a template that has no default version fails with INVALID_DEFAULT and changes nothing", async () => {
      await db().insert(siteTemplates).values({ id: "stpl_nodefault", module: "wordpress", name: "No default" });
      expect(await codeOf(updateSiteTemplate(db(), "stpl_nodefault", { enabled: true }))).toBe("INVALID_DEFAULT");
      const [row] = await db().select().from(siteTemplates).where(eq(siteTemplates.id, "stpl_nodefault"));
      expect(row).toMatchObject({ enabled: false, defaultVersionId: null });
      const v = await add("stpl_nodefault", "# first\n");
      expect(await updateSiteTemplate(db(), "stpl_nodefault", { enabled: true, defaultVersionId: v.version.id })).toMatchObject({ enabled: true, defaultVersionId: v.version.id });
    });

    it("an archived template refuses every update field (name, description, enabled, default) with ARCHIVED", async () => {
      const { template, version } = await fresh("Archived frozen");
      await archiveSiteTemplate(db(), template.id);
      for (const patch of [{ name: "Thawed" }, { description: "d" }, { enabled: true }, { enabled: false }, { defaultVersionId: version.id }]) {
        expect(await codeOf(updateSiteTemplate(db(), template.id, patch)), JSON.stringify(patch)).toBe("ARCHIVED");
      }
      const [row] = await db().select().from(siteTemplates).where(eq(siteTemplates.id, template.id));
      expect(row).toMatchObject({ name: "Archived frozen", enabled: false });
    });

    it("a default of another template, of an unknown id or an empty id is refused and the stored default is kept", async () => {
      const a = await fresh("Default owner A");
      const b = await fresh("Default owner B");
      for (const defaultVersionId of [b.version.id, "stv_missing", ""]) {
        expect(await codeOf(updateSiteTemplate(db(), a.template.id, { defaultVersionId, enabled: true })), defaultVersionId).toBe("INVALID_DEFAULT");
      }
      const [row] = await db().select().from(siteTemplates).where(eq(siteTemplates.id, a.template.id));
      expect(row).toMatchObject({ defaultVersionId: a.version.id, enabled: false });
    });

    it("the database also refuses a default of another template when written around the repository", async () => {
      const a = await fresh("FK owner A");
      const b = await fresh("FK owner B");
      expect(await failure(db().update(siteTemplates).set({ defaultVersionId: b.version.id }).where(eq(siteTemplates.id, a.template.id)))).toMatch(/fk_site_templates_default_version|foreign key/);
    });

    it("an archived template stays resolvable for its sites but is no longer offered or creatable", async () => {
      const { template, version } = await fresh("Archived with sites");
      await updateSiteTemplate(db(), template.id, { enabled: true });
      const site = await newSite({ siteType: "wordpress", templateVersionId: version.id });
      await archiveSiteTemplate(db(), template.id);
      expect(await getSiteTemplateForCreate(db(), { templateId: template.id })).toBeNull();
      expect((await listCustomerSiteTemplates(db())).map((r) => r.template.id)).not.toContain(template.id);
      expect((await listSiteTemplateRefs(db(), [site])).get(site.id)).toMatchObject({ templateId: template.id, versionId: version.id, versionNumber: 1 });
      expect((await countSitesByTemplateVersion(db())).get(version.id)).toBe(1);
      expect((await getSiteTemplateVersionById(db(), version.id))?.template.archivedAt).toBeInstanceOf(Date);
      expect((await listSiteTemplates(db(), { includeArchived: true })).find((t) => t.id === template.id)?.siteCount).toBe(1);
    });
  });

  describe("customer listing", () => {
    it("offers the default version, not the latest, and follows a default change", async () => {
      const { template, version } = await fresh("Default not latest");
      await updateSiteTemplate(db(), template.id, { enabled: true });
      const v2 = await add(template.id, "# v2\n");
      const offered = async () => (await listCustomerSiteTemplates(db())).find((r) => r.template.id === template.id)?.version.id;
      expect(await offered()).toBe(version.id);
      await updateSiteTemplate(db(), template.id, { defaultVersionId: v2.version.id });
      expect(await offered()).toBe(v2.version.id);
      expect((await getSiteTemplateForCreate(db(), { templateId: template.id }))?.version.id).toBe(v2.version.id);
    });

    it("never lists a disabled template, and disabling hides it again", async () => {
      const { template } = await fresh("Toggled");
      const listed = async () => (await listCustomerSiteTemplates(db())).some((r) => r.template.id === template.id);
      expect(await listed()).toBe(false);
      await updateSiteTemplate(db(), template.id, { enabled: true });
      expect(await listed()).toBe(true);
      await updateSiteTemplate(db(), template.id, { enabled: false });
      expect(await listed()).toBe(false);
      expect(await getSiteTemplateForCreate(db(), { templateId: template.id })).toBeNull();
    });
  });

  describe("sites and versions", () => {
    it("a site cannot be pointed at an unknown version, on insert or on update", async () => {
      expect(await failure(newSite({ siteType: "wordpress", templateVersionId: "stv_missing" }))).toMatch(/fk_sites_template_version|foreign key/);
      const site = await newSite({ siteType: "wordpress", templateVersionId: BUILT_IN_WORDPRESS_VERSION_ID });
      expect(await failure(db().update(sites).set({ templateVersionId: "stv_missing" }).where(eq(sites.id, site.id)))).toMatch(/fk_sites_template_version|foreign key/);
      expect(await failure(db().update(sites).set({ templateParameters: { a: 1 } as never }).where(eq(sites.id, site.id)))).toMatch(/ck_sites_template_parameters|check constraint/);
      const [row] = await db().select().from(sites).where(eq(sites.id, site.id));
      expect(row?.templateVersionId).toBe(BUILT_IN_WORDPRESS_VERSION_ID);
    });

    it("a version a site runs cannot be deleted even through the table API, and the template stays intact", async () => {
      const { template, version } = await fresh("In use");
      await newSite({ siteType: "wordpress", templateVersionId: version.id });
      expect(await failure(db().delete(siteTemplateVersions).where(eq(siteTemplateVersions.id, version.id)))).toMatch(/immutable/);
      expect(await failure(db().delete(siteTemplates).where(eq(siteTemplates.id, template.id)))).toMatch(/foreign key|violates/);
      expect((await getSiteTemplate(db(), template.id))?.versions).toHaveLength(1);
    });

    it("counts sites per version across several versions without leaking between versions or templates", async () => {
      const a = await fresh("Counts A");
      const b = await fresh("Counts B");
      const a2 = await add(a.template.id, "# a2\n");
      await newSite({ siteType: "wordpress", templateVersionId: a.version.id });
      await newSite({ siteType: "wordpress", templateVersionId: a.version.id });
      await newSite({ siteType: "wordpress", templateVersionId: a2.version.id });
      await newSite({ siteType: "wordpress", templateVersionId: b.version.id });
      const counts = await countSitesByTemplateVersion(db());
      expect([a.version.id, a2.version.id, b.version.id].map((id) => counts.get(id))).toEqual([2, 1, 1]);
      const detail = (await getSiteTemplate(db(), a.template.id))!;
      expect(detail.versions.map((v) => [v.versionNumber, v.siteCount])).toEqual([[2, 1], [1, 2]]);
      expect((await listSiteTemplates(db())).find((t) => t.id === a.template.id)).toMatchObject({ siteCount: 3, versionCount: 2 });
      expect((await listSiteTemplates(db())).find((t) => t.id === b.template.id)?.siteCount).toBe(1);
    });

    it("a site without a site type is not counted per version, yet a custom version on it still trips the downgrade gate", async () => {
      const { version } = await fresh("Typeless");
      const gateBefore = await countSitesOnNonBuiltInTemplateVersions(db());
      await newSite({ templateVersionId: version.id });
      expect((await countSitesByTemplateVersion(db())).has(version.id)).toBe(false);
      expect(await countSitesOnNonBuiltInTemplateVersions(db())).toBe(gateBefore + 1);
    });

    it("folds legacy NULL rows into built-in v1 even after the built-in default moved on, and never rewrites them", async () => {
      const legacy = await newSite({ siteType: "wordpress" });
      const v2 = await add(BUILT_IN_WORDPRESS_TEMPLATE_ID, "# built-in v2\n", true);
      await ensureBuiltInSiteTemplates(db());
      expect((await listSiteTemplateRefs(db(), [legacy])).get(legacy.id)).toMatchObject({
        versionId: BUILT_IN_WORDPRESS_VERSION_ID, versionNumber: 1, defaultVersionId: v2.version.id, defaultVersionNumber: 2,
      });
      const [row] = await db().select().from(sites).where(eq(sites.id, legacy.id));
      expect(row?.templateVersionId).toBeNull();
      expect((await countSitesByTemplateVersion(db())).get(v2.version.id)).toBeUndefined();
    });

    it("listSiteTemplateRefs omits sites it cannot resolve and answers shared versions once per site", async () => {
      const { template, version } = await fresh("Refs");
      const one = await newSite({ siteType: "wordpress", templateVersionId: version.id });
      const two = await newSite({ siteType: "wordpress", templateVersionId: version.id });
      const refs = await listSiteTemplateRefs(db(), [
        one,
        two,
        { id: "s_unknown_type", siteType: "drupal", templateVersionId: null },
        { id: "s_no_type", siteType: null, templateVersionId: null },
        { id: "s_dangling", siteType: "wordpress", templateVersionId: "stv_missing" },
      ]);
      expect([...refs.keys()].sort()).toEqual([one.id, two.id].sort());
      expect(refs.get(one.id)).toEqual(refs.get(two.id));
      expect(refs.get(one.id)?.templateId).toBe(template.id);
    });
  });

  describe("built-in ensure", () => {
    it("concurrent boots on an empty database create one enabled built-in template with one version", async () => {
      const other = createDatabaseClient({ mode: "pglite" });
      try {
        await other.migrate();
        await Promise.all([1, 2, 3, 4, 5].map(() => ensureBuiltInSiteTemplates(other.db)));
        expect(await other.db.select().from(siteTemplates)).toMatchObject([
          { id: BUILT_IN_WORDPRESS_TEMPLATE_ID, builtIn: true, enabled: true, defaultVersionId: BUILT_IN_WORDPRESS_VERSION_ID, archivedAt: null },
        ]);
        const versions = await other.db.select().from(siteTemplateVersions);
        expect(versions).toHaveLength(1);
        expect(versions[0]).toMatchObject({ id: BUILT_IN_WORDPRESS_VERSION_ID, versionNumber: 1, source: BUILT_IN_WORDPRESS_SOURCE });
        expect(versions[0]?.specHash).toBe(siteTemplateSpecHash(BUILT_IN_WORDPRESS_SPEC));
      } finally {
        await other.close();
      }
    });

    it("concurrent boots keep an admin's rename, disable and newer default, and leave other templates and sites alone", async () => {
      const custom = await fresh("Bystander");
      const site = await newSite({ siteType: "wordpress" });
      const v2 = await add(BUILT_IN_WORDPRESS_TEMPLATE_ID, "# built-in v2 again\n", true);
      await updateSiteTemplate(db(), BUILT_IN_WORDPRESS_TEMPLATE_ID, { name: "Renamed built-in", enabled: false });
      const tableBefore = async () => ({
        templates: await db().select().from(siteTemplates).orderBy(siteTemplates.id),
        site: (await db().select().from(sites).where(eq(sites.id, site.id)))[0],
      });
      const before = await tableBefore();
      await Promise.all([1, 2, 3, 4, 5].map(() => ensureBuiltInSiteTemplates(db())));
      expect(await tableBefore()).toEqual(before);
      const builtIn = before.templates.find((t) => t.id === BUILT_IN_WORDPRESS_TEMPLATE_ID);
      expect(builtIn).toMatchObject({ name: "Renamed built-in", enabled: false, defaultVersionId: v2.version.id });
      expect(before.templates.find((t) => t.id === custom.template.id)).toEqual(custom.template);
      expect(await getSiteTemplateForCreate(db(), { templateId: null })).toBeNull();
    });
  });
});
