import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
  APP_STACK_ID_PATTERN,
  APP_STACK_KEY_PATTERN,
  APP_TEMPLATE_CATEGORY_PATTERN,
  APP_TEMPLATE_PARAMETER_KEY_PATTERN,
} from "@hosting-panel/contracts";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appStackComponents,
  appStackDeployments,
  appStackDomains,
  appStackParameters,
  appStackRevisions,
  appStacks,
  appStackSecrets,
  appStackVolumes,
  appTemplates,
  appTemplateVersions,
  organizations,
  resolveMigrationsDirectory,
} from "../src/index.js";

// Application stacks (ADR-0035): migration 0025 is additive (ten new tables, one nullable column on organizations, a
// hostname-claim trigger on domains), versions, revisions and live secret versions are immutable, every tenant child
// belongs to its stack's organization, and one hostname has one owner across sites, stacks and the panel host.
const dir = resolveMigrationsDirectory();
const M0025 = "0025_app_stacks.sql";
const files = readdirSync(dir)
  .filter((file) => file.endsWith(".sql"))
  .sort();
const read = (file: string) => readFileSync(path.join(dir, file), "utf8");
const HASH = `'${"a".repeat(64)}'`;

async function migrateTo(pg: PGlite, until: string): Promise<void> {
  for (const file of files) {
    if (file >= until) break;
    await pg.exec(read(file));
  }
}

async function rows<T = Record<string, unknown>>(pg: PGlite, query: string): Promise<T[]> {
  return (await pg.query<T>(query)).rows;
}

// A 0024-era install: two organizations with an allocation each, a site with a domain in the first, a user.
const SEED_0024 = `
  INSERT INTO platform_installations (id, name) VALUES ('pi','pi');
  INSERT INTO hosts (id, platform_installation_id, name, hostname, ipv4_address, total_cpu_milli, total_memory_bytes, total_storage_bytes)
    VALUES ('h','pi','h','panel.example','192.0.2.1',1000,'1','1');
  INSERT INTO organizations (id, platform_installation_id, name, slug) VALUES ('o','pi','o','o'),('o2','pi','o2','o2');
  INSERT INTO host_allocations (id, host_id, organization_id) VALUES ('a','h','o'),('a2','h','o2');
  INSERT INTO users (id, email, name) VALUES ('u_author','author@example.test','Author');
  INSERT INTO sites (id, organization_id, host_allocation_id, name, slug) VALUES ('s1','o','a','s1','s1');
  INSERT INTO domains (id, site_id, organization_id, hostname) VALUES ('d_site','s1','o','site.example');`;

// Two published-shape templates, one stack per organization with a revision and a "web" component.
const FIXTURES = `
  INSERT INTO app_templates (id, slug, name, category) VALUES ('atpl_a','alpha','Alpha','web'),('atpl_b','beta','Beta','jobs');
  INSERT INTO app_template_versions (id, template_id, version_number, source, spec_version, compiled_schema, spec_hash)
    VALUES ('atv_a1','atpl_a',1,'x',1,'{}',${HASH}),('atv_b1','atpl_b',1,'x',1,'{}',${HASH});
  INSERT INTO app_stacks (id, organization_id, host_allocation_id, template_id, template_version_id, name)
    VALUES ('stk_a','o','a','atpl_a','atv_a1','Stack A'),('stk_b','o2','a2','atpl_b','atv_b1','Stack B');
  INSERT INTO app_stack_revisions (id, stack_id, organization_id, revision_number, template_version_id, plan, plan_hash,
      component_count, cpu_milli, memory_bytes)
    VALUES ('srev_a1','stk_a','o',1,'atv_a1','{}',${HASH},1,100,1),('srev_b1','stk_b','o2',1,'atv_b1','{}',${HASH},1,100,1);
  INSERT INTO app_stack_components (stack_id, organization_id, component_key) VALUES ('stk_a','o','web'),('stk_b','o2','web');`;

const NEW_TABLES = [
  "app_stack_components",
  "app_stack_deployments",
  "app_stack_domains",
  "app_stack_parameters",
  "app_stack_revisions",
  "app_stack_secrets",
  "app_stack_volumes",
  "app_stacks",
  "app_template_versions",
  "app_templates",
];

/** A valid row per new table (SQL literals); a case overrides some columns. */
const BASE: Record<string, Record<string, string>> = {
  app_templates: { id: "'atpl_p'", slug: "'probe'", name: "'Probe'", category: "'web-cache'" },
  app_template_versions: {
    id: "'atv_p'",
    template_id: "'atpl_a'",
    version_number: "9",
    source: "'x'",
    spec_version: "1",
    compiled_schema: "'{}'",
    spec_hash: HASH,
  },
  app_stacks: {
    id: "'stk_p'",
    organization_id: "'o'",
    host_allocation_id: "'a'",
    template_id: "'atpl_a'",
    template_version_id: "'atv_a1'",
    name: "'Probe'",
  },
  app_stack_parameters: { stack_id: "'stk_a'", organization_id: "'o'", parameter_key: "'probe'", public_value: `'"v"'` },
  app_stack_secrets: {
    id: "'ssec_p'",
    stack_id: "'stk_a'",
    organization_id: "'o'",
    parameter_key: "'probe'",
    version: "9",
    ciphertext_base64: "'c'",
    iv_base64: "'i'",
    auth_tag_base64: "'t'",
  },
  app_stack_revisions: {
    id: "'srev_p'",
    stack_id: "'stk_a'",
    organization_id: "'o'",
    revision_number: "9",
    template_version_id: "'atv_a1'",
    plan: "'{}'",
    plan_hash: HASH,
    component_count: "8",
    cpu_milli: "0",
    memory_bytes: "0",
  },
  app_stack_components: { stack_id: "'stk_a'", organization_id: "'o'", component_key: "'probe-1'" },
  app_stack_volumes: { stack_id: "'stk_a'", organization_id: "'o'", volume_key: "'data'" },
  app_stack_domains: {
    id: "'sdom_p'",
    stack_id: "'stk_a'",
    organization_id: "'o'",
    component_key: "'web'",
    internal_port: "8080",
    hostname: "'probe.example'",
  },
  app_stack_deployments: { id: "'sdep_p'", stack_id: "'stk_a'", organization_id: "'o'", operation_id: "'op_p'" },
};

function insert(table: string, over: Record<string, string> = {}): string {
  const row = { ...BASE[table], ...over };
  return `INSERT INTO ${table} (${Object.keys(row).join(", ")}) VALUES (${Object.values(row).join(", ")})`;
}

const long = (n: number) => `'${"x".repeat(n)}'`;
const named = (name: string) => new RegExp(`"${name}"`);

describe("0025 app_stacks migration", () => {
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
  let trgBefore: Named[] = [];
  let trgAfter: Named[] = [];

  beforeAll(async () => {
    pg = new PGlite();
    await migrateTo(pg, M0025);
    colsBefore = await rows<Column>(pg, COLUMNS);
    consBefore = await rows<Named>(pg, CONSTRAINTS);
    idxBefore = await rows<Named>(pg, INDEXES);
    trgBefore = await rows<Named>(pg, TRIGGERS);
    await pg.exec(SEED_0024);
    await pg.exec(read(M0025));
    colsAfter = await rows<Column>(pg, COLUMNS);
    consAfter = await rows<Named>(pg, CONSTRAINTS);
    idxAfter = await rows<Named>(pg, INDEXES);
    trgAfter = await rows<Named>(pg, TRIGGERS);
    await pg.exec(FIXTURES);
  }, 120_000);

  afterAll(async () => {
    await pg.close();
  });

  /** Runs the statements and rolls them back, so a probe never leaves a row behind. */
  async function probe(statements: string): Promise<void> {
    await pg.exec("BEGIN");
    try {
      await pg.exec(statements);
    } finally {
      await pg.exec("ROLLBACK");
    }
  }

  const key = (c: { table_name: string; column_name: string }) => `${c.table_name}.${c.column_name}`;
  const qualified = (c: { tbl: string; name: string }) => `${c.tbl}.${c.name}`;

  describe("1. schema diff against the 0024 schema", () => {
    it("sees the 0024 schema as the baseline (the diff below is not vacuous)", () => {
      expect(colsBefore.length).toBeGreaterThan(100);
      expect(colsBefore.some((c) => c.table_name === "site_templates")).toBe(true);
      expect(colsBefore.some((c) => c.table_name === "app_stacks")).toBe(false);
    });

    it("creates the ten tables and adds to pre-existing tables only the nullable organizations.max_app_stacks", () => {
      const oldTables = new Set(colsBefore.map((c) => c.table_name));
      const oldKeys = new Set(colsBefore.map(key));
      const added = colsAfter.filter((c) => oldTables.has(c.table_name) && !oldKeys.has(key(c)));
      expect(added.map((c) => [key(c), c.data_type, c.is_nullable, c.column_default])).toEqual([
        ["organizations.max_app_stacks", "integer", "YES", null],
      ]);
      expect(colsAfter.find((c) => key(c) === "app_stack_revisions.parameters")).toMatchObject({
        data_type: "jsonb",
        is_nullable: "NO",
        column_default: "'[]'::jsonb",
      });
      expect([...new Set(colsAfter.filter((c) => !oldTables.has(c.table_name)).map((c) => c.table_name))].sort()).toEqual(NEW_TABLES);
    });

    it("drops, renames, retypes, tightens or re-defaults no pre-existing column", () => {
      const after = new Map(colsAfter.map((c) => [key(c), c]));
      for (const before of colsBefore) {
        expect(after.get(key(before)), `column ${key(before)} changed or disappeared`).toEqual(before);
      }
    });

    it("keeps every pre-existing constraint, index and trigger; old tables gain one CHECK and the domains trigger only", () => {
      const oldTables = new Set(colsBefore.map((c) => c.table_name));
      for (const [before, after] of [
        [consBefore, consAfter],
        [idxBefore, idxAfter],
        [trgBefore, trgAfter],
      ] as const) {
        const byName = new Map(after.map((c) => [qualified(c), c.def]));
        expect(before.filter((c) => byName.get(qualified(c)) !== c.def)).toEqual([]);
      }
      const addedOnOld = (before: Named[], after: Named[]) =>
        after.filter((c) => oldTables.has(c.tbl) && !before.some((b) => qualified(b) === qualified(c))).map(qualified);
      expect(addedOnOld(consBefore, consAfter)).toEqual(["organizations.organizations_max_app_stacks_check"]);
      expect(addedOnOld(idxBefore, idxAfter)).toEqual([]);
      expect(addedOnOld(trgBefore, trgAfter)).toEqual(["domains.trg_domains_app_stack_hostname_claim"]);
    });
  });

  describe("2. re-apply", () => {
    it("applied again on a database with stack rows changes no column, constraint, index or trigger", async () => {
      await pg.exec(read(M0025));
      expect(await rows<Column>(pg, COLUMNS)).toEqual(colsAfter);
      expect(await rows<Named>(pg, CONSTRAINTS)).toEqual(consAfter);
      expect(await rows<Named>(pg, INDEXES)).toEqual(idxAfter);
      expect(await rows<Named>(pg, TRIGGERS)).toEqual(trgAfter);
      expect(await rows(pg, "SELECT id FROM app_stacks ORDER BY id")).toEqual([{ id: "stk_a" }, { id: "stk_b" }]);
    });
  });

  describe("3. schema.ts matches the database", () => {
    const tables: PgTable[] = [
      appTemplates,
      appTemplateVersions,
      appStacks,
      appStackParameters,
      appStackSecrets,
      appStackRevisions,
      appStackComponents,
      appStackVolumes,
      appStackDomains,
      appStackDeployments,
    ];
    // schema.ts follows the newest migration: the later ones are applied on top before comparing; each checks what it adds
    // in its own test (0026: app-routing-options-database.test.ts, 0032: below).
    let colsLatest: Column[] = [];
    let consLatest: Named[] = [];
    beforeAll(async () => {
      for (const file of files.filter((f) => f > M0025)) await pg.exec(read(file));
      colsLatest = await rows<Column>(pg, COLUMNS);
      consLatest = await rows<Named>(pg, CONSTRAINTS);
    });

    it("declares exactly the columns the migrations create for the ten tables and organizations", () => {
      for (const table of [...tables, organizations]) {
        const config = getTableConfig(table);
        const present = colsLatest.filter((c) => c.table_name === config.name).map((c) => c.column_name);
        expect(config.columns.map((c) => c.name).sort(), config.name).toEqual(present.sort());
      }
      expect(tables.map((t) => getTableConfig(t).name).sort()).toEqual(NEW_TABLES);
    });

    it("names in schema.ts every unique, primary key and composite foreign key the migrations create", () => {
      const present = new Set(consLatest.map(qualified));
      const declared = tables.flatMap((table) => {
        const config = getTableConfig(table);
        return [
          ...config.uniqueConstraints.map((u) => u.getName()),
          ...config.primaryKeys.map((p) => p.getName()),
          ...config.foreignKeys.map((f) => f.getName()).filter((name) => name.startsWith("fk_")),
        ].map((name) => `${config.name}.${name}`);
      });
      expect(declared.length).toBe(27);
      expect(declared.filter((name) => !present.has(name))).toEqual([]);
    });
  });

  describe("4. CHECK constraints", () => {
    it("accepts the base row of every new table", async () => {
      for (const table of NEW_TABLES) await probe(insert(table));
    });

    const CASES: [string, Record<string, string>, string][] = [
      ["app_templates", { slug: "'Bad'" }, "app_templates_slug_check"],
      ["app_templates", { slug: "'a'" }, "app_templates_slug_check"],
      ["app_templates", { name: "''" }, "app_templates_name_check"],
      ["app_templates", { name: long(81) }, "app_templates_name_check"],
      ["app_templates", { description: long(501) }, "app_templates_description_check"],
      ["app_templates", { category: "'Web'" }, "app_templates_category_check"],
      ["app_templates", { category: "'game_servers'" }, "app_templates_category_check"],
      ["app_templates", { enabled: "TRUE" }, "ck_app_templates_enabled_needs_default"],
      ["app_templates", { enabled: "TRUE", default_version_id: "'atv_a1'", archived_at: "NOW()" }, "ck_app_templates_archived_disabled"],
      ["app_templates", { built_in: "TRUE", archived_at: "NOW()" }, "ck_app_templates_built_in_not_archived"],
      ["app_template_versions", { version_number: "0" }, "app_template_versions_version_number_check"],
      ["app_template_versions", { source: "''" }, "app_template_versions_source_check"],
      ["app_template_versions", { source: long(65537) }, "app_template_versions_source_check"],
      ["app_template_versions", { spec_version: "0" }, "app_template_versions_spec_version_check"],
      ["app_template_versions", { compiled_schema: "'[]'" }, "app_template_versions_compiled_schema_check"],
      ["app_template_versions", { spec_hash: `'${"A".repeat(64)}'` }, "app_template_versions_spec_hash_check"],
      ["app_stacks", { id: "'Stk'" }, "app_stacks_id_check"],
      ["app_stacks", { id: `'s${"x".repeat(64)}'` }, "app_stacks_id_check"],
      ["app_stacks", { name: "''" }, "app_stacks_name_check"],
      ["app_stacks", { name: long(65) }, "app_stacks_name_check"],
      ["app_stacks", { status: "'bogus'" }, "app_stacks_status_check"],
      ["app_stacks", { applied_routes_hash: "'abc'" }, "app_stacks_applied_routes_hash_check"],
      ["app_stacks", { idempotency_key: "'a b'", request_hash: HASH }, "app_stacks_idempotency_key_check"],
      ["app_stacks", { idempotency_key: "'k'", request_hash: "'abc'" }, "app_stacks_request_hash_check"],
      ["app_stacks", { idempotency_key: "'k'" }, "ck_app_stacks_idempotency_pair"],
      ["app_stacks", { request_hash: HASH }, "ck_app_stacks_idempotency_pair"],
      ["app_stack_parameters", { parameter_key: "'Bad'" }, "app_stack_parameters_parameter_key_check"],
      ["app_stack_parameters", { public_value: "'{}'" }, "app_stack_parameters_public_value_check"],
      ["app_stack_parameters", { public_value: "'null'" }, "app_stack_parameters_public_value_check"],
      ["app_stack_secrets", { parameter_key: "'bad-key'" }, "app_stack_secrets_parameter_key_check"],
      ["app_stack_secrets", { version: "0" }, "app_stack_secrets_version_check"],
      ["app_stack_secrets", { ciphertext_base64: "''" }, "app_stack_secrets_ciphertext_base64_check"],
      ["app_stack_secrets", { ciphertext_base64: long(32769) }, "app_stack_secrets_ciphertext_base64_check"],
      ["app_stack_secrets", { iv_base64: long(65) }, "app_stack_secrets_iv_base64_check"],
      ["app_stack_secrets", { auth_tag_base64: "''" }, "app_stack_secrets_auth_tag_base64_check"],
      ["app_stack_revisions", { revision_number: "0" }, "app_stack_revisions_revision_number_check"],
      ["app_stack_revisions", { plan: "'[]'" }, "app_stack_revisions_plan_check"],
      ["app_stack_revisions", { plan_hash: "'abc'" }, "app_stack_revisions_plan_hash_check"],
      ["app_stack_revisions", { parameters: "'{}'" }, "app_stack_revisions_parameters_check"],
      ["app_stack_revisions", { component_count: "0" }, "app_stack_revisions_component_count_check"],
      ["app_stack_revisions", { component_count: "9" }, "app_stack_revisions_component_count_check"],
      ["app_stack_revisions", { cpu_milli: "-1" }, "app_stack_revisions_cpu_milli_check"],
      ["app_stack_revisions", { memory_bytes: "-1" }, "app_stack_revisions_memory_bytes_check"],
      ["app_stack_components", { component_key: "'web-'" }, "app_stack_components_component_key_check"],
      ["app_stack_components", { component_key: "'a_b'" }, "app_stack_components_component_key_check"],
      ["app_stack_components", { health: "'bogus'" }, "app_stack_components_health_check"],
      ["app_stack_volumes", { volume_key: "'-data'" }, "app_stack_volumes_volume_key_check"],
      ["app_stack_volumes", { retention_policy: "'keep'" }, "app_stack_volumes_retention_policy_check"],
      ["app_stack_volumes", { status: "'bogus'" }, "app_stack_volumes_status_check"],
      ["app_stack_domains", { internal_port: "0" }, "app_stack_domains_internal_port_check"],
      ["app_stack_domains", { internal_port: "65536" }, "app_stack_domains_internal_port_check"],
      ["app_stack_domains", { hostname: "'ab'" }, "app_stack_domains_hostname_check"],
      ["app_stack_domains", { status: "'bogus'" }, "app_stack_domains_status_check"],
      ["app_stack_domains", { dns_status: "'bogus'" }, "app_stack_domains_dns_status_check"],
      ["app_stack_domains", { cert_status: "'bogus'" }, "app_stack_domains_cert_status_check"],
      ["app_stack_domains", { cert_problem: "'bogus'" }, "app_stack_domains_cert_problem_check"],
      ["app_stack_domains", { cert_challenge: "'tls-alpn-01'" }, "app_stack_domains_cert_challenge_check"],
      ["app_stack_deployments", { status: "'bogus'" }, "app_stack_deployments_status_check"],
      ["app_stack_deployments", { problem: "'not_upper'" }, "app_stack_deployments_problem_check"],
    ];

    it.each(CASES)("%s %j is refused by %s", async (table, over, constraint) => {
      await expect(probe(insert(table, over))).rejects.toThrow(named(constraint));
    });

    it("refuses an upper-case stack hostname (the claim trigger checks a free name first)", async () => {
      await expect(probe(insert("app_stack_domains", { hostname: "'Free.example'" }))).rejects.toThrow(named("app_stack_domains_hostname_check"));
    });

    it("refuses a negative organizations.max_app_stacks and accepts 0 and NULL", async () => {
      await expect(probe(`UPDATE organizations SET max_app_stacks = -1 WHERE id = 'o'`)).rejects.toThrow(
        named("organizations_max_app_stacks_check"),
      );
      await probe(`UPDATE organizations SET max_app_stacks = 0 WHERE id = 'o'; UPDATE organizations SET max_app_stacks = NULL WHERE id = 'o'`);
    });

    it("uses the contracts patterns verbatim in the id, key and category CHECKs", () => {
      const def = (name: string) => consAfter.find((c) => c.name === name)?.def ?? "";
      expect(def("app_stacks_id_check")).toContain(APP_STACK_ID_PATTERN.source);
      expect(def("app_stack_components_component_key_check")).toContain(APP_STACK_KEY_PATTERN.source);
      expect(def("app_stack_volumes_volume_key_check")).toContain(APP_STACK_KEY_PATTERN.source);
      expect(def("app_stack_parameters_parameter_key_check")).toContain(APP_TEMPLATE_PARAMETER_KEY_PATTERN.source);
      expect(def("app_stack_secrets_parameter_key_check")).toContain(APP_TEMPLATE_PARAMETER_KEY_PATTERN.source);
      expect(def("app_templates_category_check")).toContain(APP_TEMPLATE_CATEGORY_PATTERN.source);
    });
  });

  describe("5. composite foreign keys", () => {
    it("refuses a stack of one organization on the allocation of another", async () => {
      await expect(probe(insert("app_stacks", { organization_id: "'o2'" }))).rejects.toThrow(named("fk_app_stacks_host_allocation_org"));
    });

    it.each(["parameters", "secrets", "revisions", "components", "volumes", "domains", "deployments"])(
      "refuses a %s row of the stack with another organization",
      async (child) => {
        await expect(probe(insert(`app_stack_${child}`, { organization_id: "'o2'" }))).rejects.toThrow(
          named(`fk_app_stack_${child}_stack_org`),
        );
      },
    );

    it("refuses a domain on an unknown component and a stack on a version of another template", async () => {
      await expect(probe(insert("app_stack_domains", { component_key: "'nope'" }))).rejects.toThrow(named("fk_app_stack_domains_component"));
      await expect(probe(insert("app_stacks", { template_version_id: "'atv_b1'" }))).rejects.toThrow(named("fk_app_stacks_template_version"));
      await expect(probe(`UPDATE app_templates SET default_version_id = 'atv_b1' WHERE id = 'atpl_a'`)).rejects.toThrow(
        named("fk_app_templates_default_version"),
      );
    });

    it("refuses a desired, applied, component or deployment revision of another stack and accepts its own", async () => {
      const cases: [string, string][] = [
        [`UPDATE app_stacks SET desired_revision_id = 'srev_b1' WHERE id = 'stk_a'`, "fk_app_stacks_desired_revision"],
        [`UPDATE app_stacks SET applied_revision_id = 'srev_b1' WHERE id = 'stk_a'`, "fk_app_stacks_applied_revision"],
        [`UPDATE app_stack_components SET applied_revision_id = 'srev_b1' WHERE stack_id = 'stk_a'`, "fk_app_stack_components_applied_revision"],
        [insert("app_stack_deployments", { revision_id: "'srev_b1'" }), "fk_app_stack_deployments_revision"],
      ];
      for (const [statement, constraint] of cases) {
        await expect(probe(statement), constraint).rejects.toThrow(named(constraint));
      }
      await probe(`UPDATE app_stacks SET desired_revision_id = 'srev_a1', applied_revision_id = 'srev_a1' WHERE id = 'stk_a';
        UPDATE app_stack_components SET applied_revision_id = 'srev_a1' WHERE stack_id = 'stk_a';
        ${insert("app_stack_deployments", { revision_id: "'srev_a1'" })}`);
    });
  });

  describe("6. immutability", () => {
    it("refuses an UPDATE of every column of a template version but created_by, and any DELETE", async () => {
      for (const set of [
        `id = 'atv_renamed'`,
        `template_id = 'atpl_b'`,
        `version_number = 7`,
        `source = 'changed'`,
        `spec_version = 2`,
        `compiled_schema = '{"a":1}'`,
        `spec_hash = '${"b".repeat(64)}'`,
        `created_at = NOW() + INTERVAL '1 day'`,
      ]) {
        await expect(probe(`UPDATE app_template_versions SET ${set} WHERE id = 'atv_a1'`), set).rejects.toThrow(
          /app_template_versions rows are immutable/,
        );
      }
      await expect(probe(`DELETE FROM app_template_versions WHERE id = 'atv_b1'`)).rejects.toThrow(/app_template_versions rows are immutable/);
      await pg.exec(`UPDATE app_template_versions SET source = source WHERE id = 'atv_a1'`);
    });

    it("nulls created_by of a version when its author is deleted", async () => {
      await pg.exec(`INSERT INTO users (id, email, name) VALUES ('u_gone','gone@example.test','Gone');
        UPDATE app_template_versions SET created_by = 'u_gone' WHERE id = 'atv_a1';
        DELETE FROM users WHERE id = 'u_gone'`);
      expect(await rows(pg, `SELECT created_by FROM app_template_versions WHERE id = 'atv_a1'`)).toEqual([{ created_by: null }]);
    });

    it("refuses any UPDATE, even a no-op, and any DELETE of a revision", async () => {
      for (const statement of [
        `UPDATE app_stack_revisions SET plan_hash = '${"b".repeat(64)}' WHERE id = 'srev_a1'`,
        `UPDATE app_stack_revisions SET revision_number = revision_number WHERE id = 'srev_a1'`,
        `UPDATE app_stack_revisions SET parameters = '[{"key":"k","value":1}]' WHERE id = 'srev_a1'`,
        `DELETE FROM app_stack_revisions WHERE id = 'srev_a1'`,
      ]) {
        await expect(probe(statement), statement).rejects.toThrow(/app_stack_revisions rows are immutable/);
      }
    });

    it("refuses an UPDATE of a secret version and its DELETE while the stack is live, allows the purge after soft delete", async () => {
      await pg.exec(`${insert("app_stacks", { id: "'stk_del'", name: "'Doomed'" })};
        ${insert("app_stack_secrets", { id: "'ssec_del'", stack_id: "'stk_del'", version: "1" })}`);
      await expect(probe(`UPDATE app_stack_secrets SET key_version = 'v2' WHERE id = 'ssec_del'`)).rejects.toThrow(
        /app_stack_secrets rows are immutable/,
      );
      await expect(probe(`DELETE FROM app_stack_secrets WHERE id = 'ssec_del'`)).rejects.toThrow(/app_stack_secrets rows are immutable/);
      await pg.exec(`UPDATE app_stacks SET status = 'deleted', deleted_at = NOW() WHERE id = 'stk_del'`);
      await expect(probe(`UPDATE app_stack_secrets SET key_version = 'v2' WHERE id = 'ssec_del'`)).rejects.toThrow(
        /app_stack_secrets rows are immutable/,
      );
      await pg.exec(`DELETE FROM app_stack_secrets WHERE stack_id = 'stk_del'`);
      expect(await rows(pg, `SELECT id FROM app_stack_secrets WHERE stack_id = 'stk_del'`)).toEqual([]);
    });

    it("DELETE FROM organizations with a live, fully populated stack cascades through every stack table", async () => {
      await pg.exec(`
        INSERT INTO organizations (id, platform_installation_id, name, slug) VALUES ('o3','pi','o3','o3');
        INSERT INTO host_allocations (id, host_id, organization_id) VALUES ('a3','h','o3');
        ${insert("app_stacks", { id: "'stk_c'", organization_id: "'o3'", host_allocation_id: "'a3'", status: "'running'" })};
        ${insert("app_stack_revisions", { id: "'srev_c1'", stack_id: "'stk_c'", organization_id: "'o3'", revision_number: "1" })};
        UPDATE app_stacks SET desired_revision_id = 'srev_c1', applied_revision_id = 'srev_c1' WHERE id = 'stk_c';
        ${insert("app_stack_parameters", { stack_id: "'stk_c'", organization_id: "'o3'" })};
        ${insert("app_stack_secrets", { id: "'ssec_c'", stack_id: "'stk_c'", organization_id: "'o3'" })};
        ${insert("app_stack_components", { stack_id: "'stk_c'", organization_id: "'o3'", component_key: "'web'", applied_revision_id: "'srev_c1'" })};
        ${insert("app_stack_volumes", { stack_id: "'stk_c'", organization_id: "'o3'" })};
        ${insert("app_stack_domains", { id: "'sdom_c'", stack_id: "'stk_c'", organization_id: "'o3'", hostname: "'c.example'" })};
        ${insert("app_stack_deployments", { id: "'sdep_c'", stack_id: "'stk_c'", organization_id: "'o3'", operation_id: "'op_c'", revision_id: "'srev_c1'" })};
        DELETE FROM organizations WHERE id = 'o3';`);
      for (const table of NEW_TABLES.filter((t) => t.startsWith("app_stack_"))) {
        expect(await rows(pg, `SELECT 1 FROM ${table} WHERE stack_id = 'stk_c'`), table).toEqual([]);
      }
      expect(await rows(pg, `SELECT 1 FROM app_stacks WHERE id = 'stk_c'`)).toEqual([]);
    });
  });

  describe("7. one hostname, one owner across sites, stacks and the panel host", () => {
    const claim = { code: "23505", constraint: "uq_panel_hostname_claim" };
    const siteDomain = (id: string, hostname: string) =>
      `INSERT INTO domains (id, site_id, organization_id, hostname) VALUES ('${id}','s1','o','${hostname}')`;

    it("refuses a stack hostname held by a site domain or by the panel host", async () => {
      await expect(probe(insert("app_stack_domains", { hostname: "'site.example'" }))).rejects.toMatchObject(claim);
      await expect(probe(insert("app_stack_domains", { hostname: "'panel.example'" }))).rejects.toMatchObject(claim);
    });

    it("refuses a site domain, in any case, that a stack holds", async () => {
      await pg.exec(insert("app_stack_domains", { id: "'sdom_held'", hostname: "'stack.example'" }));
      await expect(probe(siteDomain("d_up", "STACK.Example"))).rejects.toMatchObject(claim);
      await expect(probe(siteDomain("d_low", "stack.example"))).rejects.toMatchObject(claim);
    });

    it("lets a free name through both ways", async () => {
      await probe(insert("app_stack_domains", { hostname: "'free-stack.example'" }));
      await probe(siteDomain("d_free", "free-site.example"));
    });

    it("takes the hostname advisory lock in both trigger functions", () => {
      expect(read(M0025).match(/pg_advisory_xact_lock\(hashtext\('hp\.hostname'\), hashtext\(lower\(NEW\.hostname\)\)\)/g)).toHaveLength(2);
    });
  });

  describe("8. soft delete, live name, idempotency and the other uniques", () => {
    it("refuses status deleted without deleted_at and deleted_at on a non-deleted status", async () => {
      await expect(probe(insert("app_stacks", { status: "'deleted'" }))).rejects.toThrow(named("ck_app_stacks_deleted"));
      await expect(probe(insert("app_stacks", { status: "'failed'", deleted_at: "NOW()" }))).rejects.toThrow(named("ck_app_stacks_deleted"));
      await probe(insert("app_stacks", { status: "'deleted'", deleted_at: "NOW()" }));
    });

    it("refuses a second live stack with the same name ignoring case in the organization, allows it elsewhere or after soft delete", async () => {
      await pg.exec(insert("app_stacks", { id: "'stk_n1'", name: "'Shop'" }));
      await expect(probe(insert("app_stacks", { id: "'stk_n2'", name: "'SHOP'" }))).rejects.toThrow(named("uq_app_stacks_name_live"));
      await probe(insert("app_stacks", { id: "'stk_n2'", name: "'shop'", organization_id: "'o2'", host_allocation_id: "'a2'" }));
      await pg.exec(`UPDATE app_stacks SET status = 'deleted', deleted_at = NOW() WHERE id = 'stk_n1'`);
      await probe(insert("app_stacks", { id: "'stk_n2'", name: "'shop'" }));
    });

    it("refuses a reused idempotency key in the organization and allows it in another", async () => {
      await pg.exec(insert("app_stacks", { id: "'stk_i1'", name: "'Idem 1'", idempotency_key: "'k1'", request_hash: HASH }));
      await expect(probe(insert("app_stacks", { id: "'stk_i2'", name: "'Idem 2'", idempotency_key: "'k1'", request_hash: HASH }))).rejects.toThrow(
        named("uq_app_stacks_org_idempotency"),
      );
      await probe(
        insert("app_stacks", { id: "'stk_i2'", name: "'Idem 2'", idempotency_key: "'k1'", request_hash: HASH, organization_id: "'o2'", host_allocation_id: "'a2'" }),
      );
    });

    it.each<[string, Record<string, string>, string]>([
      ["app_templates", { id: "'atpl_dup'", slug: "'alpha'" }, "uq_app_templates_slug"],
      ["app_template_versions", { version_number: "1" }, "uq_app_template_versions_number"],
      ["app_stack_revisions", { revision_number: "1" }, "uq_app_stack_revisions_number"],
      ["app_stack_domains", { id: "'sdom_dup'", hostname: "'stack.example'" }, "uq_app_stack_domains_hostname"],
    ])("%s %j is refused by %s", async (table, over, constraint) => {
      await expect(probe(insert(table, over))).rejects.toThrow(named(constraint));
    });

    it("refuses a second deployment row for one operation and a second secret with the same version", async () => {
      await expect(probe(`${insert("app_stack_deployments")}; ${insert("app_stack_deployments", { id: "'sdep_q'" })}`)).rejects.toThrow(
        named("uq_app_stack_deployments_operation"),
      );
      await expect(probe(`${insert("app_stack_secrets")}; ${insert("app_stack_secrets", { id: "'ssec_q'" })}`)).rejects.toThrow(
        named("uq_app_stack_secrets_version"),
      );
    });
  });
});

describe("0032 the revision and the status a deployment's request replaced", () => {
  const M0032 = "0032_app_stack_deployment_replaced.sql";
  let pg: PGlite;
  const COLUMNS = `SELECT table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, column_name`;
  const CONSTRAINTS = `SELECT conrelid::regclass::text AS tbl, conname AS name, pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1, 2`;

  beforeAll(async () => {
    pg = new PGlite();
    await migrateTo(pg, M0032);
    await pg.exec(SEED_0024);
    await pg.exec(FIXTURES);
    await pg.exec(insert("app_stack_deployments", { id: "'sdep_old'", operation_id: "'op_old'", revision_id: "'srev_a1'" }));
  }, 120_000);

  afterAll(async () => {
    await pg.close();
  });

  it("adds two nullable columns, a composite foreign key and a status check, leaves the existing rows alone, and runs again unchanged", async () => {
    const colsBefore = await rows<Record<string, unknown>>(pg, COLUMNS);
    const consBefore = await rows<Record<string, unknown>>(pg, CONSTRAINTS);
    await pg.exec(read(M0032));
    const colsAfter = await rows<Record<string, unknown>>(pg, COLUMNS);
    const consAfter = await rows<Record<string, unknown>>(pg, CONSTRAINTS);
    const text = (r: Record<string, unknown>) => JSON.stringify(r);
    expect(colsAfter.filter((c) => !colsBefore.map(text).includes(text(c)))).toEqual([
      { table_name: "app_stack_deployments", column_name: "replaced_revision_id", data_type: "text", is_nullable: "YES", column_default: null },
      { table_name: "app_stack_deployments", column_name: "replaced_status", data_type: "text", is_nullable: "YES", column_default: null },
    ]);
    expect(colsBefore.filter((c) => !colsAfter.map(text).includes(text(c)))).toEqual([]);
    expect(consAfter.filter((c) => !consBefore.map(text).includes(text(c))).map((c) => c.name)).toEqual([
      "app_stack_deployments_replaced_status_check",
      "fk_app_stack_deployments_replaced_revision",
    ]);
    expect(await rows(pg, "SELECT id, replaced_revision_id, replaced_status FROM app_stack_deployments")).toEqual([
      { id: "sdep_old", replaced_revision_id: null, replaced_status: null },
    ]);
    await pg.exec(read(M0032));
    expect(await rows(pg, COLUMNS)).toEqual(colsAfter);
    expect(await rows(pg, CONSTRAINTS)).toEqual(consAfter);
  });

  it("refuses a replaced revision of another stack and a status that does not exist, and accepts its own", async () => {
    for (const [over, constraint] of [
      [{ replaced_revision_id: "'srev_b1'" }, "fk_app_stack_deployments_replaced_revision"],
      [{ replaced_status: "'paused'" }, "app_stack_deployments_replaced_status_check"],
    ] as const) {
      await pg.exec("BEGIN");
      try {
        await expect(pg.exec(insert("app_stack_deployments", over)), constraint).rejects.toThrow(named(constraint));
      } finally {
        await pg.exec("ROLLBACK");
      }
    }
    await pg.exec(insert("app_stack_deployments", { replaced_revision_id: "'srev_a1'", replaced_status: "'stopped'" }));
    expect(await rows(pg, "SELECT replaced_revision_id, replaced_status FROM app_stack_deployments WHERE id = 'sdep_p'")).toEqual([
      { replaced_revision_id: "srev_a1", replaced_status: "stopped" },
    ]);
  });
});

describe("0033 an address being removed keeps its host name until a route file without it is published", () => {
  const M0033 = "0033_app_stack_domain_removal.sql";
  let pg: PGlite;
  const COLUMNS = `SELECT table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, column_name`;
  const claim = { code: "23505" };

  beforeAll(async () => {
    pg = new PGlite();
    await migrateTo(pg, M0033);
    await pg.exec(SEED_0024);
    await pg.exec(FIXTURES);
    await pg.exec(insert("app_stack_domains", { id: "'sdom_old'", hostname: "'old.example'" }));
  }, 120_000);

  afterAll(async () => {
    await pg.close();
  });

  async function refused(statement: string): Promise<unknown> {
    await pg.exec("BEGIN");
    try {
      return await pg.exec(statement).then(
        () => null,
        (err: unknown) => err,
      );
    } finally {
      await pg.exec("ROLLBACK");
    }
  }

  it("adds one nullable column, leaves every existing address live, and runs again unchanged", async () => {
    const colsBefore = await rows<Record<string, unknown>>(pg, COLUMNS);
    await pg.exec(read(M0033));
    const colsAfter = await rows<Record<string, unknown>>(pg, COLUMNS);
    const text = (r: Record<string, unknown>) => JSON.stringify(r);
    expect(colsAfter.filter((c) => !colsBefore.map(text).includes(text(c)))).toEqual([
      { table_name: "app_stack_domains", column_name: "removal_requested_at", data_type: "timestamp with time zone", is_nullable: "YES", column_default: null },
    ]);
    expect(colsBefore.filter((c) => !colsAfter.map(text).includes(text(c)))).toEqual([]);
    expect(await rows(pg, "SELECT id, removal_requested_at FROM app_stack_domains")).toEqual([{ id: "sdom_old", removal_requested_at: null }]);
    await pg.exec(read(M0033));
    expect(await rows(pg, COLUMNS)).toEqual(colsAfter);
  });

  it("an address marked as being removed still holds its host name against a site and another application", async () => {
    await pg.exec("UPDATE app_stack_domains SET removal_requested_at = NOW() WHERE id = 'sdom_old'");
    expect(await refused("INSERT INTO domains (id, site_id, organization_id, hostname) VALUES ('d_old','s1','o','old.example')")).toMatchObject(claim);
    expect(
      await refused(insert("app_stack_domains", { id: "'sdom_b'", stack_id: "'stk_b'", organization_id: "'o2'", hostname: "'old.example'" })),
    ).toMatchObject(claim);
  });
});
