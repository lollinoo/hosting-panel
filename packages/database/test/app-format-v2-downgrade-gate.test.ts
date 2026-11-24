import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveMigrationsDirectory } from "../src/index.js";

// ADR-0036 §2.11: the hp-update downgrade gate `app-format-v2` of infra/linux/lib/common.sh, its own SQL text run on
// the real schema. It holds for a stack an older release cannot read, never for a template row alone.
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
const PREDICATE_SQL = only(/"(select 'app-format-v2' where exists \([^"]*\))"/g);
const STACKS_SQL = only(/"(select 'app-stacks' where exists \([^"]*\))"/g);

const HASH = "a".repeat(64);
const SEED = `
  INSERT INTO platform_installations (id, name) VALUES ('pi','pi');
  INSERT INTO hosts (id, platform_installation_id, name, hostname, ipv4_address, total_cpu_milli, total_memory_bytes, total_storage_bytes)
    VALUES ('h','pi','h','h.example','192.0.2.1',1000,'1','1');
  INSERT INTO organizations (id, platform_installation_id, name, slug) VALUES ('o','pi','o','o');
  INSERT INTO host_allocations (id, host_id, organization_id) VALUES ('a','h','o');
  INSERT INTO app_templates (id, slug, name, category) VALUES ('atpl_t','tpl','Tpl','web');
  INSERT INTO app_template_versions (id, template_id, version_number, source, spec_version, compiled_schema, spec_hash)
    VALUES ('atv_t_1','atpl_t',1,'x',1,'{}','${HASH}');
  INSERT INTO app_template_versions (id, template_id, version_number, source, spec_version, compiled_schema, spec_hash)
    VALUES ('atv_t_2','atpl_t',2,'y',2,'{}','${"b".repeat(64)}');`;

let pg: PGlite;
const names = async (sql: string) => (await pg.query(sql)).rows.map((r) => Object.values(r as object)[0]);
const stack = (id: string, versionId: string, status = "draft") =>
  pg.exec(`INSERT INTO app_stacks (id, organization_id, host_allocation_id, template_id, template_version_id, name, status)
    VALUES ('${id}','o','a','atpl_t','${versionId}','${id}','${status}')`);
const revision = (id: string, stackId: string, number: number, versionId: string, schemaVersion: number) =>
  pg.exec(`INSERT INTO app_stack_revisions (id, stack_id, organization_id, revision_number, template_version_id, plan, plan_hash, component_count, cpu_milli, memory_bytes)
    VALUES ('${id}','${stackId}','o',${number},'${versionId}','{"schemaVersion":${schemaVersion},"components":[]}','${HASH}',1,100,1048576)`);
const remove = (id: string) => pg.exec(`UPDATE app_stacks SET status = 'deleted', deleted_at = now() WHERE id = '${id}'`);

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

describe("hp-update downgrade gate app-format-v2", () => {
  it("does not hold for a template version of the extended format that no stack uses", async () => {
    // Every panel of this release has such a row: the built-in WordPress template is seeded at boot.
    expect(await names(PREDICATE_SQL)).toEqual([]);
    expect(await names(STACKS_SQL)).toEqual([]);
  });

  it("does not hold for a stack of the first format, which the gate app-stacks already names", async () => {
    await stack("stk_first", "atv_t_1");
    await revision("srev_first_1", "stk_first", 1, "atv_t_1", 1);
    expect(await names(PREDICATE_SQL)).toEqual([]);
    expect(await names(STACKS_SQL)).toEqual(["app-stacks"]);
  });

  it("holds for a stack on a template version of the extended format, a draft without a revision included", async () => {
    await stack("stk_draft", "atv_t_2");
    expect(await names(PREDICATE_SQL)).toEqual(["app-format-v2"]);
    await remove("stk_draft");
    expect(await names(PREDICATE_SQL)).toEqual([]);
  });

  it("holds for a stack back on a version of the first format that keeps a revision written in the extended one", async () => {
    await stack("stk_back", "atv_t_1", "running");
    await revision("srev_back_1", "stk_back", 1, "atv_t_2", 2);
    await revision("srev_back_2", "stk_back", 2, "atv_t_1", 1);
    expect(await names(PREDICATE_SQL)).toEqual(["app-format-v2"]);
    await remove("stk_back");
    expect(await names(PREDICATE_SQL)).toEqual([]);
    // The stack of the first format is still there: only the older gate holds.
    expect(await names(STACKS_SQL)).toEqual(["app-stacks"]);
  });

  it("answers one row however many stacks of the extended format exist", async () => {
    await stack("stk_two", "atv_t_2");
    await stack("stk_three", "atv_t_2");
    await revision("srev_three_1", "stk_three", 1, "atv_t_2", 2);
    expect(await names(PREDICATE_SQL)).toEqual(["app-format-v2"]);
  });

  it("names the schema and never schema_migrations, and has no double quote (it travels inside a shell string)", () => {
    expect(PREDICATE_SQL).toContain("public.app_stacks");
    expect(PREDICATE_SQL).toContain("public.app_template_versions");
    expect(PREDICATE_SQL).toContain("public.app_stack_revisions");
    expect(PREDICATE_SQL).not.toContain("schema_migrations");
    expect(PREDICATE_SQL).not.toContain('"');
  });
});
