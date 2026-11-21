import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveMigrationsDirectory, siteTemplates, siteTemplateVersions, sites } from "../src/index.js";

// Site templates (ADR 0033): migration 0024 is additive (new tables, two nullable columns on sites), so the previous
// release keeps running on the migrated schema; a version is immutable; the default is a version of the same template.
const dir = resolveMigrationsDirectory();
const M0024 = "0024_site_templates.sql";
const files = readdirSync(dir)
  .filter((file) => file.endsWith(".sql"))
  .sort();
const read = (file: string) => readFileSync(path.join(dir, file), "utf8");
const HASH = "a".repeat(64);

async function migrateTo(pg: PGlite, until: string): Promise<void> {
  for (const file of files) {
    if (file >= until) break;
    await pg.exec(read(file));
  }
}

async function rows<T = Record<string, unknown>>(pg: PGlite, query: string): Promise<T[]> {
  return (await pg.query<T>(query)).rows;
}

// A 0023-era install: one organization with one managed WordPress site, written by the previous release.
const SEED_0023 = `
  INSERT INTO platform_installations (id, name) VALUES ('pi','pi');
  INSERT INTO hosts (id, platform_installation_id, name, hostname, ipv4_address, total_cpu_milli, total_memory_bytes, total_storage_bytes)
    VALUES ('h','pi','h','h.example','192.0.2.1',1000,'1','1');
  INSERT INTO organizations (id, platform_installation_id, name, slug) VALUES ('o','pi','o','o');
  INSERT INTO host_allocations (id, host_id, organization_id) VALUES ('a','h','o');
  INSERT INTO users (id, email, name) VALUES ('u_author','author@example.test','Author');
  INSERT INTO sites (id, organization_id, host_allocation_id, name, slug, php_version, site_type)
    VALUES ('s_legacy','o','a','legacy','legacy','8.4','wordpress');`;

// The statements the previous release runs against the migrated schema: none of them names a column added by 0024.
const OLD_RELEASE_WRITES = `
  INSERT INTO sites (id, organization_id, host_allocation_id, name, slug, status, php_version, site_type)
    VALUES ('s_rb','o','a','rb','rb','provisioning','8.3','wordpress');
  UPDATE sites SET status = 'ready' WHERE id = 's_rb';
  DELETE FROM sites WHERE id = 's_rb';`;

describe("0024 site_templates migration", () => {
  let pg: PGlite;
  type Column = {
    table_name: string;
    column_name: string;
    data_type: string;
    udt_name: string;
    character_maximum_length: number | null;
    numeric_precision: number | null;
    is_nullable: string;
    column_default: string | null;
  };
  type Named = { tbl: string; name: string; def: string };
  const COLUMNS = `SELECT table_name, column_name, data_type, udt_name, character_maximum_length, numeric_precision, is_nullable, column_default
    FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, column_name`;
  const CONSTRAINTS = `SELECT conrelid::regclass::text AS tbl, conname AS name, pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1, 2`;
  const INDEXES = `SELECT tablename AS tbl, indexname AS name, indexdef AS def FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1, 2`;
  const TRIGGERS = `SELECT tgrelid::regclass::text AS tbl, tgname AS name, pg_get_triggerdef(oid) AS def
    FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1, 2`;
  let colsBefore: Column[] = [];
  let colsAfter: Column[] = [];
  let consBefore: Named[] = [];
  let consAfter: Named[] = [];
  let idxBefore: Named[] = [];
  let idxAfter: Named[] = [];
  let snapshotOnce: [Column[], Named[], Named[], Named[]] = [[], [], [], []];

  beforeAll(async () => {
    pg = new PGlite();
    await migrateTo(pg, M0024);
    colsBefore = await rows<Column>(pg, COLUMNS);
    consBefore = await rows<Named>(pg, CONSTRAINTS);
    idxBefore = await rows<Named>(pg, INDEXES);
    await pg.exec(SEED_0023);
    await pg.exec(read(M0024));
    colsAfter = await rows<Column>(pg, COLUMNS);
    consAfter = await rows<Named>(pg, CONSTRAINTS);
    idxAfter = await rows<Named>(pg, INDEXES);
    snapshotOnce = [colsAfter, consAfter, idxAfter, await rows<Named>(pg, TRIGGERS)];
  }, 120_000);

  afterAll(async () => {
    await pg.close();
  });

  const key = (c: Column) => `${c.table_name}.${c.column_name}`;
  const template = (id: string, name = id, enabled = false) =>
    pg.exec(`INSERT INTO site_templates (id, module, name, enabled) VALUES ('${id}','wordpress','${name}',${String(enabled)})`);
  const version = (id: string, templateId: string, number = 1) =>
    pg.exec(`INSERT INTO site_template_versions (id, template_id, version_number, source, spec, spec_hash)
      VALUES ('${id}','${templateId}',${String(number)},'services: {}','{"specVersion":1}'::jsonb,'${HASH}')`);
  /** A template with version 1 as its default, the way the repository creates one. */
  async function withDefault(id: string, name = id) {
    await template(id, name);
    await version(`${id}_v1`, id);
    await pg.exec(`UPDATE site_templates SET default_version_id = '${id}_v1' WHERE id = '${id}'`);
  }

  describe("schema diff against the 0023 schema", () => {
    it("sees the 0023 schema as the baseline (the diff below is not vacuous)", () => {
      expect(colsBefore.length).toBeGreaterThan(100);
      expect(colsBefore.some((c) => c.table_name === "site_templates")).toBe(false);
      expect(colsAfter.some((c) => c.table_name === "site_templates")).toBe(true);
    });

    it("1. creates both tables and adds to pre-existing tables only the two nullable sites columns", () => {
      const oldTables = new Set(colsBefore.map((c) => c.table_name));
      const oldKeys = new Set(colsBefore.map(key));
      const added = colsAfter.filter((c) => oldTables.has(c.table_name) && !oldKeys.has(key(c)));
      // Pinned list: a new column on an old table needs a rollback review (nullable or DEFAULT) before it joins this list.
      expect(added.map(key).sort()).toEqual(["sites.template_parameters", "sites.template_version_id"]);
      expect(added.map((c) => [c.column_name, c.data_type, c.is_nullable, c.column_default])).toEqual([
        ["template_parameters", "jsonb", "YES", null],
        ["template_version_id", "text", "YES", null],
      ]);
      expect([...new Set(colsAfter.filter((c) => !oldTables.has(c.table_name)).map((c) => c.table_name))].sort()).toEqual([
        "site_template_versions",
        "site_templates",
      ]);
    });

    it("drops, renames, retypes, tightens or re-defaults no pre-existing column", () => {
      const after = new Map(colsAfter.map((c) => [key(c), c]));
      for (const before of colsBefore) {
        expect(after.get(key(before)), `column ${key(before)} changed or disappeared`).toEqual(before);
      }
    });

    it("keeps every pre-existing constraint and index unchanged and creates the expected new ones", () => {
      const consAfterByName = new Map(consAfter.map((c) => [`${c.tbl}.${c.name}`, c.def]));
      expect(consBefore.filter((c) => consAfterByName.get(`${c.tbl}.${c.name}`) !== c.def)).toEqual([]);
      const idxAfterByName = new Map(idxAfter.map((c) => [`${c.tbl}.${c.name}`, c.def]));
      expect(idxBefore.filter((c) => idxAfterByName.get(`${c.tbl}.${c.name}`) !== c.def)).toEqual([]);

      const newIndexes = idxAfter.filter((c) => !idxBefore.some((b) => b.tbl === c.tbl && b.name === c.name)).map((c) => `${c.tbl}.${c.name}`);
      expect(newIndexes).toEqual(
        expect.arrayContaining([
          "site_templates.uq_site_templates_name_active",
          "sites.idx_sites_template_version",
          "site_template_versions.uq_site_template_versions_number",
          "site_template_versions.uq_site_template_versions_id_template",
        ]),
      );
      const partial = idxAfter.find((c) => c.name === "idx_sites_template_version");
      expect(partial?.def).toMatch(/WHERE \(template_version_id IS NOT NULL\)/);
    });

    it("2. applied again changes nothing: columns, constraints, indexes and the single trigger stay equal", async () => {
      await pg.exec(read(M0024));
      expect(await rows<Column>(pg, COLUMNS)).toEqual(snapshotOnce[0]);
      expect(await rows<Named>(pg, CONSTRAINTS)).toEqual(snapshotOnce[1]);
      expect(await rows<Named>(pg, INDEXES)).toEqual(snapshotOnce[2]);
      const triggers = await rows<Named>(pg, TRIGGERS);
      expect(triggers).toEqual(snapshotOnce[3]);
      expect(triggers.filter((t) => t.tbl === "site_template_versions").map((t) => t.name)).toEqual([
        "trg_prevent_site_template_versions_mutation",
      ]);
    });

    it("declares in schema.ts exactly the columns the migration creates for the new tables and sites", () => {
      const declared = (table: PgTable) => getTableConfig(table).columns.map((c) => c.name).sort();
      const present = (name: string) =>
        colsAfter
          .filter((c) => c.table_name === name)
          .map((c) => c.column_name)
          .sort();
      expect(declared(siteTemplates)).toEqual(present("site_templates"));
      expect(declared(siteTemplateVersions)).toEqual(present("site_template_versions"));
      expect(declared(sites)).toEqual(present("sites"));
    });
  });

  describe("3. CHECK constraints", () => {
    it("refuses an enabled template without a default version", async () => {
      await expect(template("t_chk_en", "chk-en", true)).rejects.toThrow(/ck_site_templates_enabled_needs_default/);
    });

    it("refuses an archived template that is still enabled, accepts it once disabled", async () => {
      await withDefault("t_chk_arch");
      await pg.exec(`UPDATE site_templates SET enabled = TRUE WHERE id = 't_chk_arch'`);
      await expect(pg.exec(`UPDATE site_templates SET archived_at = NOW() WHERE id = 't_chk_arch'`)).rejects.toThrow(
        /ck_site_templates_archived_disabled/,
      );
      await pg.exec(`UPDATE site_templates SET archived_at = NOW(), enabled = FALSE WHERE id = 't_chk_arch'`);
    });

    it("refuses an archived built-in template", async () => {
      await expect(pg.exec(`INSERT INTO site_templates (id, module, name, built_in, archived_at) VALUES ('t_chk_bi','wordpress','chk-bi',TRUE,NOW())`)).rejects.toThrow(
        /ck_site_templates_built_in_not_archived/,
      );
    });

    it("refuses a module that is not a lowercase key, a name of 0 or 81 characters and a description over 500", async () => {
      for (const bad of ["Bad Key", "1wp", "", "a".repeat(33)]) {
        await expect(pg.exec(`INSERT INTO site_templates (id, module, name) VALUES ('t_mod','${bad}','m')`)).rejects.toThrow(/site_templates_module_check/);
      }
      for (const bad of ["", "n".repeat(81)]) {
        await expect(pg.exec(`INSERT INTO site_templates (id, module, name) VALUES ('t_name','wordpress','${bad}')`)).rejects.toThrow(/site_templates_name_check/);
      }
      await expect(
        pg.exec(`INSERT INTO site_templates (id, module, name, description) VALUES ('t_desc','wordpress','desc','${"d".repeat(501)}')`),
      ).rejects.toThrow(/site_templates_description_check/);
      await pg.exec(`INSERT INTO site_templates (id, module, name, description) VALUES ('t_ok_limits','wordpress','${"n".repeat(80)}','${"d".repeat(500)}')`);
    });

    it("refuses a version source over 65536 bytes or empty, a spec that is not an object, a hash that is not hex and version 0", async () => {
      await template("t_chk_ver", "chk-ver");
      const insert = (source: string, spec: string, hash: string, number: number, id = "v_probe") =>
        pg.query(
          `INSERT INTO site_template_versions (id, template_id, version_number, source, spec, spec_hash) VALUES ($5,'t_chk_ver',$1,$2,$3::jsonb,$4)`,
          [number, source, spec, hash, id],
        );
      await expect(insert("x".repeat(65537), "{}", HASH, 1)).rejects.toThrow(/site_template_versions_source_check/);
      // The limit is in bytes: 21 846 three-byte characters are 65 538 bytes.
      await expect(insert("€".repeat(21846), "{}", HASH, 1)).rejects.toThrow(/site_template_versions_source_check/);
      await expect(insert("", "{}", HASH, 1)).rejects.toThrow(/site_template_versions_source_check/);
      await expect(insert("x", "[]", HASH, 1)).rejects.toThrow(/site_template_versions_spec_check/);
      for (const bad of ["Z".repeat(64), "a".repeat(63), "A".repeat(64)]) {
        await expect(insert("x", "{}", bad, 1)).rejects.toThrow(/site_template_versions_spec_hash_check/);
      }
      await expect(insert("x", "{}", HASH, 0)).rejects.toThrow(/site_template_versions_version_number_check/);
      await insert("x".repeat(65536), "{}", HASH, 1, "v_probe_max");
    });

    it("accepts NULL and an array in sites.template_parameters and refuses an object", async () => {
      await pg.exec(`UPDATE sites SET template_parameters = '[]'::jsonb WHERE id = 's_legacy'`);
      await pg.exec(`UPDATE sites SET template_parameters = '[{"key":"a","value":1}]'::jsonb WHERE id = 's_legacy'`);
      await expect(pg.exec(`UPDATE sites SET template_parameters = '{}'::jsonb WHERE id = 's_legacy'`)).rejects.toThrow(/ck_sites_template_parameters/);
      await expect(pg.exec(`UPDATE sites SET template_parameters = '"a"'::jsonb WHERE id = 's_legacy'`)).rejects.toThrow(/ck_sites_template_parameters/);
      await pg.exec(`UPDATE sites SET template_parameters = NULL WHERE id = 's_legacy'`);
    });
  });

  describe("4. foreign keys and uniques", () => {
    it("refuses a duplicate version number of the same template but allows it on another template", async () => {
      await withDefault("t_uq_a");
      await withDefault("t_uq_b");
      await expect(version("t_uq_a_dup", "t_uq_a", 1)).rejects.toThrow(/uq_site_template_versions_number/);
      await version("t_uq_a_v2", "t_uq_a", 2);
    });

    it("refuses a default that is a version of another template (composite FK) and accepts one of its own", async () => {
      await expect(pg.exec(`UPDATE site_templates SET default_version_id = 't_uq_b_v1' WHERE id = 't_uq_a'`)).rejects.toThrow(
        /fk_site_templates_default_version/,
      );
      await pg.exec(`UPDATE site_templates SET default_version_id = 't_uq_a_v2' WHERE id = 't_uq_a'`);
      await expect(pg.exec(`UPDATE site_templates SET default_version_id = 'nope' WHERE id = 't_uq_a'`)).rejects.toThrow(
        /fk_site_templates_default_version/,
      );
    });

    it("refuses a version of an unknown template and a site pointing at an unknown version", async () => {
      await expect(version("v_orphan", "t_unknown")).rejects.toThrow(/site_template_versions_template_id_fkey/);
      await expect(pg.exec(`UPDATE sites SET template_version_id = 'stv_unknown' WHERE id = 's_legacy'`)).rejects.toThrow(/fk_sites_template_version/);
      await pg.exec(`UPDATE sites SET template_version_id = 't_uq_a_v2' WHERE id = 's_legacy'`);
      await pg.exec(`UPDATE sites SET template_version_id = NULL WHERE id = 's_legacy'`);
    });

    it("refuses to delete a template that has versions and, with the immutability trigger off, a version a site uses", async () => {
      await expect(pg.exec(`DELETE FROM site_templates WHERE id = 't_uq_b'`)).rejects.toThrow(/foreign key constraint/);
      await pg.exec(`UPDATE sites SET template_version_id = 't_uq_b_v1' WHERE id = 's_legacy'`);
      await pg.exec(`ALTER TABLE site_template_versions DISABLE TRIGGER trg_prevent_site_template_versions_mutation`);
      try {
        await expect(pg.exec(`DELETE FROM site_template_versions WHERE id = 't_uq_b_v1'`)).rejects.toThrow(/fk_sites_template_version|foreign key constraint/);
      } finally {
        await pg.exec(`ALTER TABLE site_template_versions ENABLE TRIGGER trg_prevent_site_template_versions_mutation`);
        await pg.exec(`UPDATE sites SET template_version_id = NULL WHERE id = 's_legacy'`);
      }
    });
  });

  describe("5. versions are immutable", () => {
    it("refuses an UPDATE of source, spec, spec_hash, version_number, template_id, created_at or id, and any DELETE", async () => {
      await withDefault("t_imm");
      for (const set of [
        `source = 'changed'`,
        `spec = '{"specVersion":2}'::jsonb`,
        `spec_hash = '${"b".repeat(64)}'`,
        `version_number = 9`,
        `created_at = NOW() + INTERVAL '1 day'`,
        `template_id = 't_uq_b'`,
        `id = 't_imm_renamed'`,
      ]) {
        await expect(pg.exec(`UPDATE site_template_versions SET ${set} WHERE id = 't_imm_v1'`), set).rejects.toThrow(
          /site_template_versions rows are immutable/,
        );
      }
      await expect(pg.exec(`DELETE FROM site_template_versions WHERE id = 't_imm_v1'`)).rejects.toThrow(/site_template_versions rows are immutable/);
      const [row] = await rows<{ source: string; version_number: number }>(pg, `SELECT source, version_number FROM site_template_versions WHERE id = 't_imm_v1'`);
      expect(row).toEqual({ source: "services: {}", version_number: 1 });
      // A write that changes nothing is not a change.
      await pg.exec(`UPDATE site_template_versions SET source = source WHERE id = 't_imm_v1'`);
    });

    it("allows clearing created_by, and deleting the author sets it to NULL without error", async () => {
      await pg.exec(`INSERT INTO users (id, email, name) VALUES ('u_gone','gone@example.test','Gone')`);
      await pg.exec(`UPDATE site_template_versions SET created_by = 'u_gone' WHERE id = 't_imm_v1'`);
      await pg.exec(`UPDATE site_template_versions SET created_by = NULL WHERE id = 't_imm_v1'`);
      await pg.exec(`UPDATE site_template_versions SET created_by = 'u_gone' WHERE id = 't_imm_v1'`);
      await expect(rows(pg, `SELECT created_by FROM site_template_versions WHERE id = 't_imm_v1'`)).resolves.toEqual([{ created_by: "u_gone" }]);
      await pg.exec(`DELETE FROM users WHERE id = 'u_gone'`);
      await expect(rows(pg, `SELECT created_by FROM site_template_versions WHERE id = 't_imm_v1'`)).resolves.toEqual([{ created_by: null }]);
      await expect(pg.exec(`UPDATE site_template_versions SET created_by = 'nobody' WHERE id = 't_imm_v1'`)).rejects.toThrow(/foreign key constraint/);
    });
  });

  describe("6. unique active name", () => {
    it("refuses a duplicate name ignoring case while the first is active and allows it once the first is archived", async () => {
      await template("t_name_1", "Shop Name");
      await expect(template("t_name_2", "shop name")).rejects.toThrow(/uq_site_templates_name_active/);
      await expect(template("t_name_3", "SHOP NAME")).rejects.toThrow(/uq_site_templates_name_active/);
      await pg.exec(`UPDATE site_templates SET archived_at = NOW() WHERE id = 't_name_1'`);
      await template("t_name_2", "shop name");
      await expect(template("t_name_4", "Shop Name")).rejects.toThrow(/uq_site_templates_name_active/);
    });
  });

  describe("7. rollback compatibility: the previous release keeps running on the migrated schema", () => {
    it("leaves the pre-existing site with NULL template columns", async () => {
      expect(await rows(pg, `SELECT template_version_id, template_parameters FROM sites WHERE id = 's_legacy'`)).toEqual([
        { template_version_id: null, template_parameters: null },
      ]);
    });

    it("runs the previous release's sites INSERT, UPDATE and DELETE (none names a new column)", async () => {
      await pg.exec(OLD_RELEASE_WRITES);
      await pg.exec(`INSERT INTO sites (id, organization_id, host_allocation_id, name, slug, status, php_version, site_type)
        VALUES ('s_rb2','o','a','rb2','rb2','provisioning','8.5','wordpress')`);
      expect(await rows(pg, `SELECT id, template_version_id, template_parameters FROM sites WHERE id = 's_rb2'`)).toEqual([
        { id: "s_rb2", template_version_id: null, template_parameters: null },
      ]);
      await pg.exec(`DELETE FROM sites WHERE id = 's_rb2'`);
    });

    it("runs 0024 again on a database with site rows and a pointing site without harm", async () => {
      await pg.exec(`UPDATE sites SET template_version_id = 't_uq_a_v2', template_parameters = '[{"key":"k","value":"v"}]'::jsonb WHERE id = 's_legacy'`);
      await pg.exec(read(M0024));
      expect(await rows(pg, `SELECT template_version_id, template_parameters FROM sites WHERE id = 's_legacy'`)).toEqual([
        { template_version_id: "t_uq_a_v2", template_parameters: [{ key: "k", value: "v" }] },
      ]);
    });
  });
});
