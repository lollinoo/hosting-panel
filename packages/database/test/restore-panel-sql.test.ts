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
    cert_expires_at, dns_next_check_at) VALUES ('dom_run','stk_run','o','app',8080,'app.example','active','active', now(), '2027-01-01');

  INSERT INTO app_stack_backups (id, stack_id, organization_id, kind, status, operation_id, volume_keys, size_bytes, problem,
    finished_at, restore_operation_id, restore_status, restore_problem, restored_at) VALUES
    ('sbak_run','stk_run','o','manual','running','op_sb_run','["data"]',NULL,NULL,NULL,NULL,NULL,NULL,NULL),
    ('sbak_half','stk_run','o','manual','running','op_sb_half','["data"]',NULL,NULL,NULL,NULL,NULL,NULL,NULL),
    ('sbak_opt','stk_run','o','pre_restore','running','op_sb_opt','["data"]',NULL,NULL,NULL,NULL,NULL,NULL,NULL),
    ('sbak_none','stk_gone','o','manual','running','op_sb_none','["data"]',NULL,NULL,NULL,NULL,NULL,NULL,NULL),
    ('sbak_src','stk_run','o','manual','succeeded','op_sb_src','["data"]',70,NULL,'2026-11-02T03:00:00Z','op_sb_opt','running',NULL,NULL),
    ('sbak_src_b','stk_run','o','manual','succeeded','op_sb_src_b','["data"]',70,NULL,'2026-11-02T03:00:00Z','op_sb_safe_b','running',NULL,NULL),
    ('sbak_safe_b','stk_run','o','pre_restore','running','op_sb_safe_b','["data"]',NULL,NULL,NULL,NULL,NULL,NULL,NULL),
    ('sbak_old','stk_run','o','manual','partial','op_sb_old','["data"]',60,'unreachable','2026-11-01T03:00:00Z','op_sb_rst_old','failed','timeout','2026-11-01T04:00:00Z'),
    ('sbak_done','stk_gone','o','manual','succeeded','op_sb_done','["data"]',50,NULL,'2026-11-01T03:00:00Z','op_sb_rst_done','succeeded',NULL,'2026-11-01T05:00:00Z');
  INSERT INTO app_stack_backup_copies (id, backup_id, target_id, priority, required, status, snapshot_id, size_bytes, problem, finished_at) VALUES
    ('sbc_run','sbak_run','t_local',1,TRUE,'running',NULL,NULL,NULL,NULL),
    ('sbc_half_ok','sbak_half','t_local',1,TRUE,'succeeded','${SNAP}',40,NULL,'2026-11-03T03:00:00Z'),
    ('sbc_half_run','sbak_half','t_s3',2,TRUE,'running',NULL,NULL,NULL,NULL),
    ('sbc_opt_ok','sbak_opt','t_local',1,TRUE,'succeeded','${SNAP}',30,NULL,'2026-11-03T03:00:00Z'),
    ('sbc_opt_run','sbak_opt','t_s3',2,FALSE,'running',NULL,NULL,NULL,NULL),
    ('sbc_src','sbak_src','t_local',1,TRUE,'succeeded','${SNAP}',70,NULL,'2026-11-02T03:00:00Z'),
    ('sbc_old_ok','sbak_old','t_local',1,TRUE,'succeeded','${SNAP}',60,NULL,'2026-11-01T03:00:00Z'),
    ('sbc_old_bad','sbak_old','t_s3',2,TRUE,'failed',NULL,NULL,'unreachable','2026-11-01T03:00:00Z'),
    ('sbc_done','sbak_done','t_s3',1,TRUE,'succeeded','${SNAP_2}',50,NULL,'2026-11-01T03:00:00Z');

  INSERT INTO notification_channels (id, organization_id, kind, groups, recipients, last_tested_at)
    VALUES ('nch_mail',NULL,'email','["availability","server"]','["ops@example.com"]','2026-11-01T00:00:00Z');
  INSERT INTO notification_channel_alerts (channel_id, alert_key, kind, severity, event, announced_at) VALUES
    ('nch_mail','disk_high','disk_high','critical','{}','2026-11-01T00:00:00Z'),
    ('nch_mail','site_container_down:s1','site_container_down','critical','{}',NULL);
  INSERT INTO notification_deliveries (id, channel_id, events, locale, recipient, status, attempts, next_attempt_at, problem,
    finished_at) VALUES
    ('ndl_wait','nch_mail','[]','it','ops@example.com','pending',1,'2026-11-01T00:02:00Z','mail_refused',NULL),
    ('ndl_sent','nch_mail','[]','it','ops@example.com','sent',1,NULL,NULL,'2026-11-01T00:00:00Z'),
    ('ndl_failed','nch_mail','[]','it','ops@example.com','failed',4,NULL,'mail_refused','2026-11-01T00:00:00Z');`;

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
  UNION ALL SELECT 'ab', id, status, problem, concat_ws('|', COALESCE(size_bytes::text, '-'), COALESCE(finished_at::text, '-'),
    COALESCE(restore_status, '-'), COALESCE(restore_problem, '-'), COALESCE(restored_at::text, '-'), left_incomplete::text) FROM app_stack_backups
  UNION ALL SELECT 'ax', id, status, problem, concat_ws('|', COALESCE(snapshot_id, '-'), COALESCE(size_bytes::text, '-'),
    COALESCE(finished_at::text, '-')) FROM app_stack_backup_copies
  UNION ALL SELECT 'nc', id, kind, enabled::text, concat_ws('|', groups, recipients, last_tested_at) FROM notification_channels
  UNION ALL SELECT 'na', alert_key, severity, NULL, announced_at::text FROM notification_channel_alerts
  UNION ALL SELECT 'nd', id, status, problem, concat_ws('|', attempts, next_attempt_at, finished_at) FROM notification_deliveries
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

  it("closes the backups and restores of applications left open, and follows the copies that are good (ADR-0038)", () => {
    const cols = (t: string, id: string) => String(byId(t, id)?.x).split("|");
    // no good copy: the backup failed, with the reason
    expect(byId("ax", "sbc_run")).toMatchObject({ status: "failed", problem: "interrupted" });
    expect(cols("ax", "sbc_run").slice(0, 2)).toEqual(["-", "-"]);
    expect(cols("ax", "sbc_run")[2]).not.toBe("-");
    expect(byId("ab", "sbak_run")).toMatchObject({ status: "failed", problem: "interrupted" });
    expect(cols("ab", "sbak_run")[0]).toBe("-");
    expect(cols("ab", "sbak_run")[1]).not.toBe("-");
    // a backup that never got a copy row
    expect(byId("ab", "sbak_none")).toMatchObject({ status: "failed", problem: "interrupted" });
    // one good copy and one that was still open: partial, with the size of the good copy
    expect(byId("ax", "sbc_half_ok")).toEqual(before.find((r) => r.t === "ax" && r.id === "sbc_half_ok"));
    expect(byId("ax", "sbc_half_run")).toMatchObject({ status: "failed", problem: "interrupted" });
    expect(byId("ab", "sbak_half")).toMatchObject({ status: "partial", problem: "interrupted" });
    expect(cols("ab", "sbak_half")[0]).toBe("40");
    // the copy that was open was not required: the backup is good
    expect(byId("ax", "sbc_opt_run")).toMatchObject({ status: "failed", problem: "interrupted" });
    expect(byId("ab", "sbak_opt")).toMatchObject({ status: "succeeded", problem: null });
    expect(cols("ab", "sbak_opt")[0]).toBe("30");
    // a restore that was running failed; the backup it read stays good
    expect(byId("ab", "sbak_src")).toMatchObject({ status: "succeeded", problem: null });
    expect(cols("ab", "sbak_src").slice(2, 4)).toEqual(["failed", "interrupted"]);
    expect(cols("ab", "sbak_src")[4]).not.toBe("-");
    // its safety backup was good, so the restore may have begun writing: that backup holds the data to go back to
    expect(byId("ab", "sbak_opt")).toMatchObject({ status: "succeeded" });
    expect(cols("ab", "sbak_opt")[5]).toBe("true");
    // a safety backup that reached no destination means nothing was written
    expect(byId("ab", "sbak_safe_b")).toMatchObject({ status: "failed", problem: "interrupted" });
    expect(cols("ab", "sbak_safe_b")[5]).toBe("false");
    expect(cols("ab", "sbak_src_b").slice(2, 4)).toEqual(["failed", "interrupted"]);
    expect(before.filter((r) => r.t === "ab" && String(r.x).split("|")[5] === "true")).toEqual([]);
    // settled rows are not touched, the backups of a deleted application included
    for (const [t, id] of [["ab", "sbak_old"], ["ab", "sbak_done"], ["ax", "sbc_src"], ["ax", "sbc_old_ok"], ["ax", "sbc_old_bad"], ["ax", "sbc_done"]] as const) {
      expect(byId(t, id), id).toEqual(before.find((r) => r.t === t && r.id === id));
    }
    expect(first.filter((r) => (r.t === "ab" || r.t === "ax") && r.status === "running")).toEqual([]);
    expect(first.filter((r) => r.t === "ab" && String(r.x).split("|")[2] === "running")).toEqual([]);
  });

  it("forgets what the notification channels were told and gives up the messages still waiting (ADR-0040)", () => {
    const was = (t: string, id: string) => before.find((r) => r.t === t && r.id === id);
    // The alerts of the host the copy was made on are not this host's.
    expect(before.filter((r) => r.t === "na").map((r) => r.id)).toEqual(["disk_high", "site_container_down:s1"]);
    expect(first.filter((r) => r.t === "na")).toEqual([]);
    // Waiting: one attempt made, the next one due. After: not delivered, no attempt due, an end.
    expect(was("nd", "ndl_wait")?.x).toMatch(/^1\|[^|]+$/);
    expect(byId("nd", "ndl_wait")).toMatchObject({ status: "failed", problem: "expired" });
    expect(byId("nd", "ndl_wait")?.x).toMatch(/^1\|[^|]+$/);
    expect(byId("nd", "ndl_wait")?.x).not.toBe(was("nd", "ndl_wait")?.x);
    // What already had an outcome keeps it, and so does the channel.
    for (const id of ["ndl_sent", "ndl_failed"]) expect(byId("nd", id)).toEqual(was("nd", id));
    expect(byId("nc", "nch_mail")).toEqual(was("nc", "nch_mail"));
    expect(byId("nc", "nch_mail")).toMatchObject({ status: "email", problem: "true" });
  });

  it("is idempotent: a second run changes nothing", async () => {
    await pg.exec(RESTORE_SQL);
    expect(await rows(pg, LEDGER)).toEqual(first);
  });
});
