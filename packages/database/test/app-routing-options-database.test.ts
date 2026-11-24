import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { APP_ROUTE_PASSWORD_HASH_PATTERN, APP_ROUTE_USERNAME_PATTERN, MAX_APP_ROUTE_PATHS } from "@hosting-panel/contracts";
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appStackDomains, resolveMigrationsDirectory } from "../src/index.js";

// Routing options of an application address (ADR-0037): migration 0026 adds to app_stack_domains (five columns,
// one unique, one foreign key on the table itself, five CHECKs) and one nullable column to app_stacks. A redirect stays inside its application, a verifier
// has the one accepted shape, and an address that redirects carries neither protection nor path rules.
const dir = resolveMigrationsDirectory();
const M0026 = "0026_app_routing_options.sql";
const files = readdirSync(dir)
  .filter((file) => file.endsWith(".sql"))
  .sort();
const read = (file: string) => readFileSync(path.join(dir, file), "utf8");
const VERIFIER = "$apr1$r31.....$HqJZimcKQFAMYayBlzkrA/";
const RULE = '{"pathPrefix":"/api","componentKey":"web","port":8080,"stripPrefix":true}';

async function rows<T = Record<string, unknown>>(pg: PGlite, query: string): Promise<T[]> {
  return (await pg.query<T>(query)).rows;
}

// A 0025-era install: two applications of one customer and one of another, each with web addresses.
const SEED_0025 = `
  INSERT INTO platform_installations (id, name) VALUES ('pi','pi');
  INSERT INTO hosts (id, platform_installation_id, name, hostname, ipv4_address, total_cpu_milli, total_memory_bytes, total_storage_bytes)
    VALUES ('h','pi','h','panel.example','192.0.2.1',1000,'1','1');
  INSERT INTO organizations (id, platform_installation_id, name, slug) VALUES ('o','pi','o','o'),('o2','pi','o2','o2');
  INSERT INTO host_allocations (id, host_id, organization_id) VALUES ('a','h','o'),('a2','h','o2');
  INSERT INTO app_templates (id, slug, name, category) VALUES ('atpl_a','alpha','Alpha','web');
  INSERT INTO app_template_versions (id, template_id, version_number, source, spec_version, compiled_schema, spec_hash)
    VALUES ('atv_a1','atpl_a',1,'x',1,'{}','${"a".repeat(64)}');
  INSERT INTO app_stacks (id, organization_id, host_allocation_id, template_id, template_version_id, name)
    VALUES ('stk_a','o','a','atpl_a','atv_a1','Stack A'),('stk_b','o','a','atpl_a','atv_a1','Stack B'),('stk_c','o2','a2','atpl_a','atv_a1','Stack C');
  INSERT INTO app_stack_components (stack_id, organization_id, component_key) VALUES ('stk_a','o','web'),('stk_b','o','web'),('stk_c','o2','web');
  INSERT INTO app_stack_domains (id, stack_id, organization_id, component_key, internal_port, hostname)
    VALUES ('sdom_a1','stk_a','o','web',8080,'a1.example'),('sdom_a2','stk_a','o','web',8080,'a2.example'),
           ('sdom_b1','stk_b','o','web',8080,'b1.example'),('sdom_c1','stk_c','o2','web',8080,'c1.example');`;

describe("0026 app_routing_options migration", () => {
  let pg: PGlite;
  type Column = { table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null };
  type Named = { tbl: string; name: string; def: string };
  const COLUMNS = `SELECT table_name, column_name, data_type, is_nullable, column_default
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
  let trgBefore: Named[] = [];
  let trgAfter: Named[] = [];

  beforeAll(async () => {
    pg = new PGlite();
    for (const file of files) {
      if (file >= M0026) break;
      await pg.exec(read(file));
    }
    colsBefore = await rows<Column>(pg, COLUMNS);
    consBefore = await rows<Named>(pg, CONSTRAINTS);
    idxBefore = await rows<Named>(pg, INDEXES);
    trgBefore = await rows<Named>(pg, TRIGGERS);
    await pg.exec(SEED_0025);
    await pg.exec(read(M0026));
    colsAfter = await rows<Column>(pg, COLUMNS);
    consAfter = await rows<Named>(pg, CONSTRAINTS);
    idxAfter = await rows<Named>(pg, INDEXES);
    trgAfter = await rows<Named>(pg, TRIGGERS);
  }, 120_000);

  afterAll(async () => {
    await pg.close();
  });

  /** Runs the statements and rolls them back, so a probe never leaves a row changed. */
  async function probe(statements: string): Promise<void> {
    await pg.exec("BEGIN");
    try {
      await pg.exec(statements);
    } finally {
      await pg.exec("ROLLBACK");
    }
  }
  const set = (assignment: string, id = "sdom_a1") => `UPDATE app_stack_domains SET ${assignment} WHERE id = '${id}'`;
  const key = (c: Column) => `${c.table_name}.${c.column_name}`;
  const qualified = (c: Named) => `${c.tbl}.${c.name}`;

  describe("1. schema diff against the 0025 schema", () => {
    it("adds five columns to app_stack_domains, the fingerprint of the published addresses to app_stacks, and nothing else", () => {
      expect(colsBefore.some((c) => c.table_name === "app_stack_domains")).toBe(true);
      const oldKeys = new Set(colsBefore.map(key));
      expect(colsAfter.filter((c) => !oldKeys.has(key(c))).map((c) => [key(c), c.data_type, c.is_nullable, c.column_default])).toEqual([
        ["app_stack_domains.access_password_hash", "text", "YES", null],
        ["app_stack_domains.access_username", "text", "YES", null],
        ["app_stack_domains.compression", "boolean", "NO", "false"],
        ["app_stack_domains.path_routes", "jsonb", "NO", "'[]'::jsonb"],
        ["app_stack_domains.redirect_to_domain_id", "text", "YES", null],
        ["app_stacks.applied_addresses_hash", "text", "YES", null],
      ]);
    });

    it("drops, renames, retypes, tightens or re-defaults no pre-existing column", () => {
      const after = new Map(colsAfter.map((c) => [key(c), c]));
      for (const before of colsBefore) {
        expect(after.get(key(before)), `column ${key(before)} changed or disappeared`).toEqual(before);
      }
    });

    it("keeps every pre-existing constraint, index and trigger, and adds its constraints and one index on the table only", () => {
      for (const [before, after] of [
        [consBefore, consAfter],
        [idxBefore, idxAfter],
        [trgBefore, trgAfter],
      ] as const) {
        const byName = new Map(after.map((c) => [qualified(c), c.def]));
        expect(before.filter((c) => byName.get(qualified(c)) !== c.def)).toEqual([]);
      }
      const added = (before: Named[], after: Named[]) => after.filter((c) => !before.some((b) => qualified(b) === qualified(c))).map(qualified);
      // The first two are the NOT NULL of the two new columns that have a default.
      expect(added(consBefore, consAfter)).toEqual([
        "app_stack_domains.app_stack_domains_compression_not_null",
        "app_stack_domains.app_stack_domains_path_routes_not_null",
        "app_stack_domains.ck_app_stack_domains_access_pair",
        "app_stack_domains.ck_app_stack_domains_access_shape",
        "app_stack_domains.ck_app_stack_domains_path_routes",
        "app_stack_domains.ck_app_stack_domains_redirect_alone",
        "app_stack_domains.ck_app_stack_domains_redirect_not_self",
        "app_stack_domains.fk_app_stack_domains_redirect",
        "app_stack_domains.uq_app_stack_domains_stack_id",
      ]);
      expect(added(idxBefore, idxAfter)).toEqual(["app_stack_domains.uq_app_stack_domains_stack_id"]);
      expect(added(trgBefore, trgAfter)).toEqual([]);
    });

    it("ties a redirect to an address of the same application, and clears only the redirect when that address goes", () => {
      expect(consAfter.find((c) => c.name === "fk_app_stack_domains_redirect")?.def).toBe(
        "FOREIGN KEY (stack_id, redirect_to_domain_id) REFERENCES app_stack_domains(stack_id, id) ON DELETE SET NULL (redirect_to_domain_id)",
      );
    });
  });

  describe("2. re-apply", () => {
    it("applied again on a database with options changes no column, constraint, index or trigger, and no row", async () => {
      await pg.exec(
        `${set(`compression = TRUE, access_username = 'team', access_password_hash = '${VERIFIER}', path_routes = '[${RULE}]'::jsonb`)};
         ${set("redirect_to_domain_id = 'sdom_a1'", "sdom_a2")};`,
      );
      const options = "SELECT id, redirect_to_domain_id, compression, access_username, access_password_hash, path_routes FROM app_stack_domains ORDER BY id";
      const before = await rows(pg, options);
      await pg.exec(read(M0026));
      expect(await rows<Column>(pg, COLUMNS)).toEqual(colsAfter);
      expect(await rows<Named>(pg, CONSTRAINTS)).toEqual(consAfter);
      expect(await rows<Named>(pg, INDEXES)).toEqual(idxAfter);
      expect(await rows<Named>(pg, TRIGGERS)).toEqual(trgAfter);
      expect(await rows(pg, options)).toEqual(before);
      await pg.exec(`${set("redirect_to_domain_id = NULL", "sdom_a2")}; ${set("compression = FALSE, access_username = NULL, access_password_hash = NULL, path_routes = '[]'::jsonb")};`);
    });
  });

  describe("3. schema.ts matches the database", () => {
    const config = getTableConfig(appStackDomains);

    it("declares exactly the columns of app_stack_domains", () => {
      const present = colsAfter.filter((c) => c.table_name === "app_stack_domains").map((c) => c.column_name);
      expect(config.columns.map((c) => c.name).sort()).toEqual(present.sort());
    });

    it("names the unique and the foreign key the migration creates, on the same columns", () => {
      const unique = config.uniqueConstraints.find((u) => u.getName() === "uq_app_stack_domains_stack_id");
      expect(unique?.columns.map((c) => c.name)).toEqual(["stack_id", "id"]);
      const foreign = config.foreignKeys.find((f) => f.getName() === "fk_app_stack_domains_redirect");
      expect(foreign?.reference().columns.map((c) => c.name)).toEqual(["stack_id", "redirect_to_domain_id"]);
      expect(foreign?.reference().foreignColumns.map((c) => c.name)).toEqual(["stack_id", "id"]);
    });

    it("uses in its CHECKs the patterns and the limit of the contracts", () => {
      const def = (name: string) => consAfter.find((c) => c.name === name)!.def;
      // SQL writes "$" as "[$]"; the rest of each pattern is the same text.
      const sql = (pattern: RegExp) => pattern.source.replaceAll("\\$", "[$]");
      expect(def("ck_app_stack_domains_access_shape")).toContain(`'${sql(APP_ROUTE_USERNAME_PATTERN)}'`);
      expect(def("ck_app_stack_domains_access_shape")).toContain(`'${sql(APP_ROUTE_PASSWORD_HASH_PATTERN)}'`);
      expect(def("ck_app_stack_domains_path_routes")).toContain(`<= ${String(MAX_APP_ROUTE_PATHS)}`);
    });
  });

  describe("4. constraints", () => {
    const CASES: [string, string, string, string][] = [
      ["a plain password as verifier", "access_username = 'team', access_password_hash = 'correct horse battery'", "23514", "ck_app_stack_domains_access_shape"],
      ["a verifier of another scheme", "access_username = 'team', access_password_hash = '$2y$05$abcdefghijklmnopqrstuuJ1Xx0u1vE8yYb7lqXK0cQeW0oN7yT6e'", "23514", "ck_app_stack_domains_access_shape"],
      ["a verifier with a line after it", `access_username = 'team', access_password_hash = E'${VERIFIER}\\nx'`, "23514", "ck_app_stack_domains_access_shape"],
      ["a user name with a colon", `access_username = 'a:b', access_password_hash = '${VERIFIER}'`, "23514", "ck_app_stack_domains_access_shape"],
      ["an empty user name", `access_username = '', access_password_hash = '${VERIFIER}'`, "23514", "ck_app_stack_domains_access_shape"],
      ["a user name without a verifier", "access_username = 'team'", "23514", "ck_app_stack_domains_access_pair"],
      ["a verifier without a user name", `access_password_hash = '${VERIFIER}'`, "23514", "ck_app_stack_domains_access_pair"],
      ["a redirect to itself", "redirect_to_domain_id = 'sdom_a1'", "23514", "ck_app_stack_domains_redirect_not_self"],
      ["a redirect to an address of another application", "redirect_to_domain_id = 'sdom_b1'", "23503", "fk_app_stack_domains_redirect"],
      ["a redirect to an address of another customer", "redirect_to_domain_id = 'sdom_c1'", "23503", "fk_app_stack_domains_redirect"],
      ["a redirect to nothing", "redirect_to_domain_id = 'sdom_missing'", "23503", "fk_app_stack_domains_redirect"],
      ["a redirect with protection", `redirect_to_domain_id = 'sdom_a2', access_username = 'team', access_password_hash = '${VERIFIER}'`, "23514", "ck_app_stack_domains_redirect_alone"],
      ["a redirect with a path rule", `redirect_to_domain_id = 'sdom_a2', path_routes = '[${RULE}]'::jsonb`, "23514", "ck_app_stack_domains_redirect_alone"],
      ["path rules that are not a list", `path_routes = '${RULE}'::jsonb`, "23514", "ck_app_stack_domains_path_routes"],
      ["path rules that are a text", `path_routes = '"x"'::jsonb`, "23514", "ck_app_stack_domains_path_routes"],
      ["one path rule too many", `path_routes = '[${Array.from({ length: MAX_APP_ROUTE_PATHS + 1 }, () => RULE).join(",")}]'::jsonb`, "23514", "ck_app_stack_domains_path_routes"],
    ];
    it.each(CASES)("refuses %s", async (_name, assignment, code, constraint) => {
      const refusal = await probe(set(assignment)).catch((e: unknown) => e);
      expect(refusal).toMatchObject({ code });
      expect(String((refusal as Error).message)).toContain(`"${constraint}"`);
    });

    it("accepts every option at its limit, and a redirect with compression", async () => {
      const four = Array.from({ length: MAX_APP_ROUTE_PATHS }, () => RULE).join(",");
      await probe(set(`compression = TRUE, access_username = 'a', access_password_hash = '${VERIFIER}', path_routes = '[${four}]'::jsonb`));
      await probe(set(`access_username = '${"u".repeat(32)}', access_password_hash = '${VERIFIER}'`));
      await probe(set("redirect_to_domain_id = 'sdom_a2', compression = TRUE"));
    });

    it("removing the destination clears the redirect and leaves the rest of the row", async () => {
      await pg.exec(`${set("redirect_to_domain_id = 'sdom_a2', compression = TRUE")}; DELETE FROM app_stack_domains WHERE id = 'sdom_a2';`);
      expect(await rows(pg, "SELECT id, stack_id, redirect_to_domain_id, compression FROM app_stack_domains WHERE stack_id = 'stk_a'")).toEqual([
        { id: "sdom_a1", stack_id: "stk_a", redirect_to_domain_id: null, compression: true },
      ]);
    });

    it("an address cannot change application while another one redirects to it", async () => {
      await pg.exec(`INSERT INTO app_stack_domains (id, stack_id, organization_id, component_key, internal_port, hostname)
        VALUES ('sdom_a3','stk_a','o','web',8080,'a3.example'); ${set("redirect_to_domain_id = 'sdom_a3'")};`);
      await expect(probe("UPDATE app_stack_domains SET stack_id = 'stk_b' WHERE id = 'sdom_a3'")).rejects.toMatchObject({ code: "23503" });
    });
  });
});
