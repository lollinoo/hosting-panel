import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveMigrationsDirectory } from "../src/index.js";

// BKP-16, TLS-10: infra/linux/hp-restore-panel.sql resets the copy ledgers, the TLS versions and the local target
// state of a panel restored on a new host, on every install shape (local-only has no backup_settings row).
const dir = resolveMigrationsDirectory();
const migrations = readdirSync(dir)
  .filter((file) => file.endsWith(".sql"))
  .sort();
const RESTORE_SQL = readFileSync(
  path.resolve(dir, "../../../infra/linux/hp-restore-panel.sql"),
  "utf8",
);
const SNAP = "a".repeat(64);
const SNAP_2 = "b".repeat(64);

const SEED = `
  INSERT INTO platform_installations (id, name) VALUES ('pi','pi');
  INSERT INTO hosts (id, platform_installation_id, name, hostname, ipv4_address, total_cpu_milli, total_memory_bytes, total_storage_bytes)
    VALUES ('h','pi','h','h.example','192.0.2.1',1000,'1','1');
  INSERT INTO organizations (id, platform_installation_id, name, slug) VALUES ('o','pi','o','o');
  INSERT INTO host_allocations (id, host_id, organization_id) VALUES ('a','h','o');
  INSERT INTO sites (id, organization_id, host_allocation_id, name, slug) VALUES ('s1','o','a','s1','s1');

  INSERT INTO backup_targets (id, kind, name, local_root, last_test_at, last_test_outcome, last_test_problem,
    last_test_available_bytes, last_test_total_bytes)
    VALUES ('t_local','local','Local','/var/lib/hosting-panel/local-repos/t_local', now(), 'failed', 'local_target_unmounted', 5, 10);
  INSERT INTO backup_targets (id, kind, name, legacy_settings, s3_location_key, last_test_at, last_test_outcome)
    VALUES ('t_s3','s3','S3',TRUE,'https://s3.example/bkt', now(), 'ok');

  INSERT INTO operations (id, organization_id, kind, status, resource_type, resource_id, started_at) VALUES
    ('op_one','o','panel.backups.create','processing','panel','panel', '2026-11-01T02:00:00Z'),
    ('op_two','o','panel.backups.create','processing','panel','panel', '2026-11-02T02:00:00Z'),
    ('op_nosnap','o','panel.backups.create','queued','panel','panel', NULL),
    ('op_closed','o','panel.backups.create','failed','panel','panel', NULL),
    ('op_done','o','panel.backups.create','succeeded','panel','panel', NULL),
    ('op_site','o','site.backups.create','processing','site','s1', NULL);
  INSERT INTO panel_backup_copies (id, operation_id, target_id, priority, status, snapshot_id) VALUES
    ('pc_one','op_one','t_local',1,'running','${SNAP}'),
    ('pc_two_a','op_two','t_local',1,'running','${SNAP}'),
    ('pc_two_b','op_two','t_s3',2,'running','${SNAP_2}'),
    ('pc_nosnap','op_nosnap','t_local',1,'running',NULL),
    ('pc_closed','op_closed','t_local',1,'running',NULL),
    ('pc_done','op_done','t_local',1,'succeeded','${SNAP}'),
    ('pc_done_missing','op_done','t_s3',2,'missing',NULL);

  INSERT INTO site_backups (id, site_id, kind, status, snapshot_id, restore_status, restore_target_id, archive_status,
    archive_operation_id, archive_target_id, archive_ready_until, started_at) VALUES
    ('bk_run','s1','manual','running',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2026-11-01T02:00:00Z'),
    ('bk_ok','s1','manual','succeeded','${SNAP}','running','t_local','ready','op_arch','t_local', now(),'2026-11-02T02:00:00Z'),
    ('bk_mix','s1','nightly','succeeded','${SNAP}',NULL,NULL,NULL,NULL,NULL,NULL,'2026-11-03T02:00:00Z');
  INSERT INTO site_backup_copies (id, backup_id, target_id, priority, status, snapshot_id) VALUES
    ('sc_run','bk_run','t_local',1,'running',NULL),
    ('sc_ok','bk_ok','t_local',1,'succeeded','${SNAP}'),
    ('sc_mix_ok','bk_mix','t_local',1,'succeeded','${SNAP}'),
    ('sc_mix_unknown','bk_mix','t_s3',2,'unknown',NULL),
    ('sc_missing','bk_ok','t_s3',2,'missing',NULL);

  INSERT INTO tls_certificates (id, organization_id, name) VALUES ('c1','o','c1');
  INSERT INTO tls_certificate_versions (id, certificate_id, organization_id, version_number, leaf_pem, chain_pem,
    key_ciphertext_base64, key_iv_base64, key_auth_tag_base64, subject, issuer, serial_number, fingerprint_sha256,
    not_before, not_after, san_dns, key_type, key_bits, status) VALUES
    ('v_apply','c1','o',1,'l','c','k','i','t','CN=a','CN=ca','1','${"1".repeat(64)}','2026-01-01','2027-01-01','["a.example"]','ec',256,'applying'),
    ('v_active','c1','o',2,'l','c','k','i','t','CN=a','CN=ca','2','${"2".repeat(64)}','2026-01-01','2027-01-01','["a.example"]','ec',256,'active'),
    ('v_inactive','c1','o',3,'l','c','k','i','t','CN=a','CN=ca','3','${"3".repeat(64)}','2026-01-01','2027-01-01','["a.example"]','ec',256,'inactive');
  UPDATE tls_publish_state SET desired_generation = 5, confirmed_generation = 3;

  UPDATE backup_policies SET nightly_run_started_at = now(), last_nightly_run_on = '2026-11-20' WHERE scope = 'default_site';

  INSERT INTO app_templates (id, slug, name, category) VALUES ('tpl','notes','Notes','tools');
  INSERT INTO app_template_versions (id, template_id, version_number, source, spec_version, compiled_schema, spec_hash)
    VALUES ('atv','tpl',1,'x',1,'{}','${"d".repeat(64)}');
  INSERT INTO app_stacks (id, organization_id, host_allocation_id, template_id, template_version_id, name, status,
    applied_routes_hash, applied_addresses_hash, deleted_at, updated_at) VALUES
    ('stk_run','o','a','tpl','atv','run','running','${"c".repeat(64)}','${"f".repeat(64)}',NULL,'2026-11-01T00:00:00Z'),
    ('stk_del','o','a','tpl','atv','del','deleting','${"c".repeat(64)}','${"f".repeat(64)}',NULL,'2026-11-01T00:00:00Z'),
    ('stk_gone','o','a','tpl','atv','gone','deleted',NULL,NULL,'2026-11-01T00:00:00Z','2026-11-01T00:00:00Z');
  INSERT INTO app_stack_revisions (id, stack_id, organization_id, revision_number, template_version_id, plan, plan_hash,
    component_count, cpu_milli, memory_bytes) VALUES ('rev_run','stk_run','o',1,'atv','{}','${"e".repeat(64)}',1,500,1);
  INSERT INTO app_stack_secrets (id, stack_id, organization_id, parameter_key, version, ciphertext_base64, iv_base64,
    auth_tag_base64) VALUES ('sec_run','stk_run','o','db_password',1,'c','i','t'), ('sec_gone','stk_gone','o','db_password',1,'c','i','t');
  INSERT INTO app_stack_deployments (id, stack_id, organization_id, operation_id, revision_id, status)
    VALUES ('dep_run','stk_run','o','op_stack','rev_run','running');
  INSERT INTO app_stack_components (stack_id, organization_id, component_key, health, health_observed_at, applied_revision_id)
    VALUES ('stk_run','o','app','healthy', now(),'rev_run');
  INSERT INTO app_stack_volumes (stack_id, organization_id, volume_key, status) VALUES ('stk_run','o','data','present');
  INSERT INTO app_stack_links (id, organization_id, consumer_stack_id, provider_stack_id, state) VALUES
    ('slnk_active','o','stk_run','stk_del','active'),
    ('slnk_pending','o','stk_gone','stk_del','pending'),
    ('slnk_removing','o','stk_del','stk_run','removing');
  INSERT INTO app_stack_domains (id, stack_id, organization_id, component_key, internal_port, hostname, status, cert_status,
    cert_expires_at, dns_next_check_at) VALUES ('dom_run','stk_run','o','app',8080,'app.example','active','active', now(), '2027-01-01');`;

const LEGACY_SETTINGS = `
  INSERT INTO backup_settings (id, endpoint, region, bucket, prefix, access_key_id, secret_access_key_ciphertext_base64,
    secret_access_key_iv_base64, secret_access_key_auth_tag_base64, nightly_run_started_at, last_panel_backup_status)
  VALUES ('default','https://s3.example','eu','bkt','','AK','c','i','t', now(), 'failed');`;

async function rows<T = Record<string, unknown>>(pg: PGlite, query: string): Promise<T[]> {
  return (await pg.query<T>(query)).rows;
}

async function build(withSettings: boolean): Promise<PGlite> {
  const pg = new PGlite();
  for (const file of migrations) await pg.exec(readFileSync(path.join(dir, file), "utf8"));
  await pg.exec(SEED);
  if (withSettings) await pg.exec(LEGACY_SETTINGS);
  return pg;
}

const LEDGER = `
  SELECT 'pc' AS t, id, status, problem, finished_at::text AS x FROM panel_backup_copies
  UNION ALL SELECT 'sc', id, status, problem, finished_at::text FROM site_backup_copies
  UNION ALL SELECT 'sb', id, status, problem, concat_ws('|', restore_status, restore_target_id, archive_status, archive_operation_id, archive_target_id, archive_ready_until) FROM site_backups
  UNION ALL SELECT 'op', id, status, error_code, concat_ws('|', completed_at, lease_expires_at) FROM operations
  UNION ALL SELECT 'tv', id, status, last_error_code, NULL FROM tls_certificate_versions
  UNION ALL SELECT 'tp', id, confirmed_generation::text, desired_generation::text, NULL FROM tls_publish_state
  UNION ALL SELECT 'bt', id, last_test_outcome, last_test_problem, concat_ws('|', last_test_at, last_test_available_bytes, last_test_total_bytes) FROM backup_targets
  UNION ALL SELECT 'bp', id, nightly_run_started_at::text, last_nightly_run_on::text, NULL FROM backup_policies
  UNION ALL SELECT 'bs', id, nightly_run_started_at::text, last_panel_backup_status, NULL FROM backup_settings
  UNION ALL SELECT 'as', id, status, applied_addresses_hash, applied_routes_hash FROM app_stacks
  UNION ALL SELECT 'al', id, state, NULL, NULL FROM app_stack_links
  UNION ALL SELECT 'ad', id, status, problem, ended_at::text FROM app_stack_deployments
  UNION ALL SELECT 'ac', component_key, health, NULL, health_observed_at::text FROM app_stack_components
  UNION ALL SELECT 'av', volume_key, status, NULL, NULL FROM app_stack_volumes
  UNION ALL SELECT 'am', id, status, cert_status, concat_ws('|', cert_expires_at, dns_next_check_at <= now()) FROM app_stack_domains
  ORDER BY 1, 2`;

describe.each([
  { shape: "local-only install (no backup_settings row)", withSettings: false },
  { shape: "install with the legacy backup_settings row", withSettings: true },
])("hp-restore-panel.sql on a $shape", ({ withSettings }) => {
  let pg: PGlite;
  let first: Record<string, unknown>[] = [];
  let before: Record<string, unknown>[] = [];

  beforeAll(async () => {
    pg = await build(withSettings);
    before = await rows(pg, LEDGER);
    await pg.exec(RESTORE_SQL);
    first = await rows(pg, LEDGER);
  });
  afterAll(async () => {
    await pg.close();
  });

  const byId = (t: string, id: string) => first.find((r) => r.t === t && r.id === id);

  it("resolves the copies of the open panel backup before the operations close (D7.1)", () => {
    expect(byId("pc", "pc_one")).toMatchObject({ status: "succeeded", problem: null });
    expect(byId("pc", "pc_two_a")).toMatchObject({ status: "unknown", problem: null });
    expect(byId("pc", "pc_two_b")).toMatchObject({ status: "unknown", problem: null });
    // a lone copy without a snapshot id cannot be 'succeeded' (CHECK): it is 'unknown', never a made-up snapshot
    expect(byId("pc", "pc_nosnap")).toMatchObject({ status: "unknown" });
    expect(byId("pc", "pc_one")?.x).not.toBeNull();
    expect(byId("op", "op_one")).toMatchObject({ status: "succeeded" });
    expect(byId("op", "op_two")).toMatchObject({ status: "succeeded" });
    expect(byId("op", "op_site")).toMatchObject({ status: "failed", problem: "OPERATION_INTERRUPTED" });
  });

  it("fails the leftover running copies as interrupted and leaves the settled ones alone (D7.2, D7.3)", () => {
    expect(byId("pc", "pc_closed")).toMatchObject({ status: "failed", problem: "interrupted" });
    expect(byId("pc", "pc_done")).toMatchObject({ status: "succeeded", problem: null });
    expect(byId("pc", "pc_done_missing")).toMatchObject({ status: "missing" });
    expect(byId("sc", "sc_run")).toMatchObject({ status: "failed", problem: "interrupted" });
    expect(byId("sc", "sc_run")?.x).not.toBeNull();
    expect(byId("sc", "sc_ok")).toMatchObject({ status: "succeeded", problem: null });
    expect(byId("sc", "sc_mix_ok")).toMatchObject({ status: "succeeded" });
    expect(byId("sc", "sc_mix_unknown")).toMatchObject({ status: "unknown" });
    expect(byId("sc", "sc_missing")).toMatchObject({ status: "missing" });
    expect(byId("sb", "bk_run")).toMatchObject({ status: "failed", problem: "interrupted" });
    expect(byId("sb", "bk_mix")).toMatchObject({ status: "succeeded", problem: null });
  });

  it("resets the archive including archive_target_id and keeps restore_target_id as history (D7.4)", () => {
    // restore_status running -> failed (restore_target_id kept), archive_* cleared
    expect(byId("sb", "bk_ok")?.x).toBe("failed|t_local");
    expect(before.find((r) => r.t === "sb" && r.id === "bk_ok")?.x).toContain("t_local|ready|op_arch|t_local|");
  });

  it("fails an interrupted TLS apply and keeps the active version (D7.5)", () => {
    expect(byId("tv", "v_apply")).toMatchObject({ status: "failed", problem: "interrupted" });
    expect(byId("tv", "v_active")).toMatchObject({ status: "active", problem: null });
    expect(byId("tv", "v_inactive")).toMatchObject({ status: "inactive", problem: null });
  });

  it("resets the confirmed publish generation, not the desired one (D7.6)", () => {
    expect(byId("tp", "default")).toMatchObject({ status: "0", problem: "5" });
  });

  it("clears the test result of the local target only (D7.7)", () => {
    expect(byId("bt", "t_local")).toMatchObject({ status: null, problem: null, x: "" });
    expect(byId("bt", "t_s3")?.status).toBe("ok");
    expect(byId("bt", "t_s3")?.x).not.toBe("");
  });

  it("clears the nightly cursor in-flight marker of the policy and the legacy row, keeping the last run day (D7.8)", () => {
    const policy = first.find((r) => r.t === "bp" && r.problem === "2026-11-20");
    expect(policy).toMatchObject({ status: null });
    expect(first.filter((r) => r.t === "bp" && r.status !== null)).toEqual([]);
    if (withSettings) {
      expect(byId("bs", "default")).toMatchObject({ status: null });
    } else {
      expect(first.some((r) => r.t === "bs")).toBe(false);
    }
  });

  it("tells the truth about application stacks: nothing runs on the new host (HCP-SPEC-005)", async () => {
    // Nothing is published on the new server: neither the routes hash nor the fingerprint of its addresses (ADR-0037).
    expect(byId("as", "stk_run")).toMatchObject({ status: "failed", problem: null, x: null });
    expect(byId("as", "stk_del")).toMatchObject({ status: "delete_failed", problem: null, x: null });
    expect(byId("as", "stk_gone")).toEqual(before.find((r) => r.t === "as" && r.id === "stk_gone"));
    expect(byId("ad", "dep_run")).toMatchObject({ status: "failed", problem: "OPERATION_INTERRUPTED" });
    expect(byId("ad", "dep_run")?.x).not.toBeNull();
    expect(byId("ac", "app")).toMatchObject({ status: "missing", x: null });
    // ADR-0039: no database is attached to anything on the new host; a disconnection still to confirm stays one.
    expect(first.filter((r) => r.t === "al").map((r) => [r.id, r.status])).toEqual([
      ["slnk_active", "pending"],
      ["slnk_pending", "pending"],
      ["slnk_removing", "removing"],
    ]);
    expect(byId("av", "data")).toMatchObject({ status: "missing" });
    expect(byId("am", "dom_run")).toMatchObject({ status: "pending", problem: "none", x: "t" });
    expect(
      await rows(pg, `SELECT id, updated_at = '2026-11-01T00:00:00Z' AS same FROM app_stacks WHERE deleted_at IS NOT NULL`),
    ).toEqual([{ id: "stk_gone", same: true }]);
    expect(await rows(pg, "SELECT id FROM app_stack_revisions")).toEqual([{ id: "rev_run" }]);
    expect(await rows(pg, "SELECT id, version FROM app_stack_secrets ORDER BY id")).toEqual([
      { id: "sec_gone", version: 1 },
      { id: "sec_run", version: 1 },
    ]);
  });

  it("is idempotent: a second run changes nothing", async () => {
    await pg.exec(RESTORE_SQL);
    expect(await rows(pg, LEDGER)).toEqual(first);
  });
});
