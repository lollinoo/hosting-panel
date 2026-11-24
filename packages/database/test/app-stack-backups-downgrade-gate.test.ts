import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveMigrationsDirectory } from "../src/index.js";

// ADR-0038 K10: the hp-update downgrade gate of infra/linux/lib/common.sh, its own SQL text run on the real schema.
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
const PREDICATE_SQL = only(/"(select 'app-stack-backups' where exists \([^"]*\))"/g);
const STACKS_SQL = only(/"(select 'app-stacks' where exists \([^"]*\))"/g);

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
    VALUES ('stk_one','o','a','atpl_t','atv_t_1','One','stopped');
  INSERT INTO app_stack_volumes (stack_id, organization_id, volume_key, status) VALUES ('stk_one','o','data','present');
  INSERT INTO backup_targets (id, kind, name, local_root) VALUES ('t_local','local','Local','/var/lib/hosting-panel/local-repos/t_local');`;

let pg: PGlite;
const ask = async (sql: string) => (await pg.query(sql)).rows.map((row) => Object.values(row as object));
const gate = () => ask(PREDICATE_SQL);
const backup = (id: string, status: string, stackId = "stk_one") =>
  pg.exec(
    `INSERT INTO app_stack_backups (id, stack_id, organization_id, kind, status, operation_id, volume_keys)
       VALUES ('${id}','${stackId}','o','manual','${status}','op_${id}','["data"]')`,
  );

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

describe("hp-update downgrade gate app-stack-backups", () => {
  it("the migrations query names 0027_app_stack_backups.sql as recorded", async () => {
    const files = (await pg.query<{ filename: string }>(MIGRATIONS_SQL)).rows.map((r) => r.filename);
    expect(files).toContain("0027_app_stack_backups.sql");
  });

  it("does not hold for an application that was never backed up", async () => {
    expect(await gate()).toEqual([]);
    expect(await ask(STACKS_SQL)).toEqual([["app-stacks"]]);
  });

  it.each(["running", "succeeded", "partial", "failed"])("holds while a %s backup exists, and no longer once it is gone", async (status) => {
    await backup("sbak_x", status);
    expect(await gate()).toEqual([["app-stack-backups"]]);
    await pg.exec("DELETE FROM app_stack_backups WHERE id = 'sbak_x'");
    expect(await gate()).toEqual([]);
  });

  it("holds for the backup of a deleted application, which the app-stacks gate no longer sees", async () => {
    await backup("sbak_kept", "succeeded");
    await pg.exec(
      `INSERT INTO app_stack_backup_copies (id, backup_id, target_id, status, snapshot_id) VALUES ('sbc_kept','sbak_kept','t_local','succeeded','${"a".repeat(64)}')`,
    );
    await pg.exec("DELETE FROM app_stack_volumes WHERE stack_id = 'stk_one'");
    await pg.exec("UPDATE app_stacks SET status = 'deleted', deleted_at = now() WHERE id = 'stk_one'");
    expect(await ask(STACKS_SQL)).toEqual([]);
    expect(await gate()).toEqual([["app-stack-backups"]]);
    // the row of the application can even be absent: the backups have no foreign key to it
    await backup("sbak_orphan", "succeeded", "stk_never");
    await pg.exec("DELETE FROM app_stack_backups WHERE id = 'sbak_kept'");
    expect(await gate()).toEqual([["app-stack-backups"]]);
    expect((await pg.query("SELECT id FROM app_stack_backup_copies")).rows).toEqual([]);
    await pg.exec("DELETE FROM app_stack_backups");
    expect(await gate()).toEqual([]);
  });

  it("names the schema and never schema_migrations (the psql stub of features-gate.test.ts)", () => {
    expect(PREDICATE_SQL).toContain("public.");
    expect(PREDICATE_SQL).not.toContain("schema_migrations");
  });
});
