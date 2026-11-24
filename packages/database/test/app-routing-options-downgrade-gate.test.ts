import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveMigrationsDirectory } from "../src/index.js";

// ADR-0037: the hp-update downgrade gate of infra/linux/lib/common.sh, its own SQL text run on the real schema.
const dir = resolveMigrationsDirectory();
const migrations = readdirSync(dir)
  .filter((file) => file.endsWith(".sql"))
  .sort();
const COMMON = readFileSync(path.resolve(dir, "../../../infra/linux/lib/common.sh"), "utf8");

function only(pattern: RegExp): string {
  const found = [...COMMON.matchAll(pattern)].map((m) => m[1]!);
  if (found.length !== 1) throw new Error(`${pattern} matches ${found.length} times in common.sh: the gate text moved`);
  return found[0]!;
}
const MIGRATIONS_SQL = only(/"(select filename from public\.schema_migrations where filename in \([^)]*\))"/g);
const PREDICATE_SQL = only(/"(select 'app-routing-options' where exists \([^"]*\))"/g);
const VERIFIER = `$apr1$${"a".repeat(8)}$${"b".repeat(22)}`;

const SEED = `
  INSERT INTO platform_installations (id, name) VALUES ('pi','pi');
  INSERT INTO hosts (id, platform_installation_id, name, hostname, ipv4_address, total_cpu_milli, total_memory_bytes, total_storage_bytes)
    VALUES ('h','pi','h','h.example','192.0.2.1',1000,'1','1');
  INSERT INTO organizations (id, platform_installation_id, name, slug) VALUES ('o','pi','o','o');
  INSERT INTO host_allocations (id, host_id, organization_id) VALUES ('a','h','o');
  INSERT INTO app_templates (id, slug, name, category) VALUES ('atpl_t','tpl','Tpl','web');
  INSERT INTO app_template_versions (id, template_id, version_number, source, spec_version, compiled_schema, spec_hash)
    VALUES ('atv_t_1','atpl_t',1,'x',1,'{}','${"a".repeat(64)}');
  INSERT INTO app_stacks (id, organization_id, host_allocation_id, template_id, template_version_id, name, status)
    VALUES ('stk_one','o','a','atpl_t','atv_t_1','One','draft');
  INSERT INTO app_stack_components (stack_id, organization_id, component_key) VALUES ('stk_one','o','web');`;
const ADDRESSES = `
  INSERT INTO app_stack_domains (id, stack_id, organization_id, component_key, internal_port, hostname)
    VALUES ('sdom_main','stk_one','o','web',8080,'main.example.test'), ('sdom_old','stk_one','o','web',8080,'old.example.test');`;

let pg: PGlite;
const gate = async () => (await pg.query(PREDICATE_SQL)).rows.map((row) => Object.values(row as object));
const PLAIN =
  "redirect_to_domain_id = NULL, access_username = NULL, access_password_hash = NULL, path_routes = '[]'::jsonb, compression = FALSE";

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec("CREATE TABLE schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  for (const file of migrations) {
    await pg.exec(readFileSync(path.join(dir, file), "utf8"));
    await pg.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
  }
  await pg.exec(SEED);
});
afterAll(async () => {
  await pg.close();
});

describe("hp-update downgrade gate app-routing-options", () => {
  it("the migrations query names 0026_app_routing_options.sql as recorded", async () => {
    const files = (await pg.query<{ filename: string }>(MIGRATIONS_SQL)).rows.map((r) => r.filename);
    expect(files).toContain("0026_app_routing_options.sql");
  });

  it("does not hold for addresses without options, nor for compression alone", async () => {
    expect(await gate()).toEqual([]);
    await pg.exec(ADDRESSES);
    expect(await gate()).toEqual([]);
    await pg.exec("UPDATE app_stack_domains SET compression = TRUE");
    expect(await gate()).toEqual([]);
  });

  it.each([
    ["a redirect", "redirect_to_domain_id = 'sdom_main'", "sdom_old"],
    ["a password", `access_username = 'guest', access_password_hash = '${VERIFIER}'`, "sdom_main"],
    ["a path", `path_routes = '[{"pathPrefix":"/api","componentKey":"web","port":8080,"stripPrefix":true}]'::jsonb`, "sdom_main"],
  ])("holds while an address has %s, and no longer once it is cleared", async (_, set, id) => {
    await pg.exec(`UPDATE app_stack_domains SET ${set} WHERE id = '${id}'`);
    expect(await gate()).toEqual([["app-routing-options"]]);
    await pg.exec(`UPDATE app_stack_domains SET ${PLAIN} WHERE id = '${id}'`);
    expect(await gate()).toEqual([]);
  });

  it("names the schema and never schema_migrations (the psql stub of features-gate.test.ts)", () => {
    expect(PREDICATE_SQL).toContain("public.");
    expect(PREDICATE_SQL).not.toContain("schema_migrations");
  });
});
