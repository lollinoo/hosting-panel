import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  backupPolicies,
  backupPolicyTargets,
  backupTargets,
  createDatabaseClient,
  domains,
  eq,
  hostAllocations,
  hosts,
  operations,
  organizations,
  panelBackupCopies,
  platformInstallations,
  resolveMigrationsDirectory,
  siteBackupCopies,
  siteBackups,
  sites,
  sql,
  tlsCertificates,
  tlsCertificateVersions,
  tlsPublishState,
  type DatabaseClient,
} from "../src/index.js";

// HCP-SPEC-004: 0021 (manual TLS certificates) and 0022 (backup targets, policies and copies).
const dir = resolveMigrationsDirectory();
const M0021 = "0021_manual_tls_certificates.sql";
const M0022 = "0022_backup_targets_and_copies.sql";
const allFiles = readdirSync(dir)
  .filter((file) => file.endsWith(".sql"))
  .sort();
const read = (file: string) => readFileSync(path.join(dir, file), "utf8");

const LEGACY_TARGET = "bkt_8c7b230a58dbf28ec9cb5c8b6ef3273e"; // 'bkt_' || md5('hp:backup-target:s3_legacy_default')
const SNAP_A = "a".repeat(64);
const SNAP_C = "c".repeat(64);

async function applyAll(pg: PGlite, until?: string): Promise<void> {
  for (const file of allFiles) {
    if (until !== undefined && file >= until) break;
    await pg.exec(read(file));
  }
}

async function rows<T = Record<string, unknown>>(pg: PGlite, query: string): Promise<T[]> {
  return (await pg.query<T>(query)).rows;
}

// A statement the database must refuse; `constraint` pins WHICH rule refused it, not just that something threw.
async function refuses(pg: PGlite, query: string, constraint: RegExp | string): Promise<void> {
  let message = "";
  try {
    await pg.exec(query);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message, `expected a refusal of: ${query}`).not.toBe("");
  expect(message).toMatch(typeof constraint === "string" ? new RegExp(constraint) : constraint);
}

const version = (id: string, cert: string, org: string, n: number, fp: string, extra = "") =>
  `INSERT INTO tls_certificate_versions (id, certificate_id, organization_id, version_number, leaf_pem, chain_pem,
     key_ciphertext_base64, key_iv_base64, key_auth_tag_base64, subject, issuer, serial_number, fingerprint_sha256,
     not_before, not_after, san_dns, key_type, key_bits ${extra ? "," + extra.split("=")[0] : ""})
   VALUES ('${id}','${cert}','${org}',${n},'L','C','k','i','t','s','i','01','${fp.repeat(64)}',
     NOW() - INTERVAL '1 day', NOW() + INTERVAL '30 days', '["a.example"]', 'ec', 256 ${extra ? "," + extra.split("=")[1] : ""})`;

// The key is what the targets service stores: hp_s3_location_key(endpoint, bucket, prefix) of the JSON values.
const s3Row = (id: string, config: Record<string, unknown>, key?: string | null) =>
  `INSERT INTO backup_targets (id, kind, name, config_json, s3_location_key, s3_secret_ciphertext_base64, s3_secret_iv_base64,
     s3_secret_auth_tag_base64, s3_secret_key_version)
   SELECT '${id}','s3','S', c.cfg, ${key === undefined ? "hp_s3_location_key(c.cfg->>'endpoint', c.cfg->>'bucket', c.cfg->>'prefix')" : key === null ? "NULL" : `'${key}'`},
     'c','i','t','v1'
   FROM (SELECT '${JSON.stringify(config)}'::jsonb AS cfg) c`;
const S3_CONFIG = { endpoint: "https://e", region: "r", bucket: "b", prefix: "p", accessKeyId: "A" };
const s3Target = (id: string, prefix: string) => s3Row(id, { ...S3_CONFIG, prefix });

const ORG_SEED = `
  INSERT INTO platform_installations (id, name) VALUES ('pi','pi');
  INSERT INTO hosts (id, platform_installation_id, name, hostname, ipv4_address, total_cpu_milli, total_memory_bytes, total_storage_bytes)
    VALUES ('h','pi','h','h.example','192.0.2.1',1000,'1','1');
  INSERT INTO organizations (id, platform_installation_id, name, slug) VALUES ('oA','pi','a','a'),('oB','pi','b','b');
  INSERT INTO host_allocations (id, host_id, organization_id) VALUES ('aA','h','oA'),('aB','h','oB');
  INSERT INTO sites (id, organization_id, host_allocation_id, name, slug)
    VALUES ('s1','oA','aA','s1','s1'),('s2','oA','aA','s2','s2'),('s3','oB','aB','s3','s3');
  INSERT INTO domains (id, site_id, organization_id, hostname)
    VALUES ('d1','s1','oA','a.example'),('d2','s2','oA','b.example'),('d3','s3','oB','c.example');`;

const LEGACY_SEED = `
  INSERT INTO backup_settings (id, endpoint, region, bucket, prefix, access_key_id, secret_access_key_ciphertext_base64,
    secret_access_key_iv_base64, secret_access_key_auth_tag_base64, schedule_hour_utc, retention_days, last_nightly_run_on,
    last_test_at, last_test_outcome)
  VALUES ('default','https://s3.example','eu','bkt','p','AK','c','i','t',4,21,'2026-11-20','2026-11-19T10:00:00Z','ok');
  INSERT INTO operations (id, organization_id, kind, resource_type, resource_id)
    VALUES ('op_1','oA','site.backups.create','site','s1');
  INSERT INTO site_backups (id, site_id, kind, status, operation_id, snapshot_id, size_bytes, problem, started_at, finished_at) VALUES
    ('bkp_ok','s1','nightly','succeeded','op_aaa','${SNAP_A}',10,NULL,'2026-11-01T02:00:00Z','2026-11-01T02:05:00Z'),
    ('bkp_fail','s1','manual','failed','op_bbb',NULL,NULL,'unreachable','2026-11-02T02:00:00Z','2026-11-02T02:01:00Z'),
    ('bkp_failsnap','s1','manual','failed','op_ccc','${SNAP_C}',5,'interrupted','2026-11-03T02:00:00Z','2026-11-03T02:01:00Z'),
    ('bkp_run','s2','manual','running','op_ddd',NULL,NULL,NULL,'2026-11-04T02:00:00Z',NULL),
    ('bkp_busy','s2','nightly','failed',NULL,NULL,NULL,'site_busy','2026-11-05T02:00:00Z','2026-11-05T02:00:00Z');`;

const snapshot = async (pg: PGlite): Promise<string> =>
  JSON.stringify(
    (
      await pg.query(`SELECT
        (SELECT json_agg(t ORDER BY id) FROM (SELECT id, kind, legacy_settings, config_json, last_test_at, s3_location_key FROM backup_targets) t) AS targets,
        (SELECT json_agg(p ORDER BY id) FROM backup_policies p) AS policies,
        (SELECT json_agg(x ORDER BY policy_id) FROM backup_policy_targets x) AS policy_targets,
        (SELECT json_agg(y ORDER BY id) FROM (SELECT id, backup_id, target_id, status, snapshot_id, job_id, started_at, finished_at FROM site_backup_copies) y) AS copies,
        (SELECT json_agg(z) FROM tls_publish_state z) AS publish_state`)
    ).rows[0],
  );

describe("HCP-SPEC-004 migrations 0021/0022 on an upgraded install", () => {
  let pg: PGlite;
  let afterFirstRun = "";
  let afterSecondRun = "";

  beforeAll(async () => {
    pg = new PGlite();
    await applyAll(pg, M0021);
    await pg.exec(ORG_SEED);
    await pg.exec(LEGACY_SEED);
    await pg.exec(read(M0021));
    await pg.exec(read(M0022));
    afterFirstRun = await snapshot(pg);
    await pg.exec(read(M0021));
    await pg.exec(read(M0022));
    afterSecondRun = await snapshot(pg);
  }, 120_000);

  afterAll(async () => {
    await pg.close();
  });

  describe("0022 backfill of the legacy S3 configuration", () => {
    it("running 0021 and 0022 a second time changes nothing (backfill-twice idempotency)", () => {
      expect(afterSecondRun).toBe(afterFirstRun);
      expect(JSON.parse(afterFirstRun).targets).toHaveLength(1);
    });

    it("creates exactly one legacy S3 target that holds no secret and no location (read through backup_settings)", async () => {
      const targets = await rows(pg, "SELECT * FROM backup_targets");
      expect(targets).toHaveLength(1);
      expect(targets[0]).toMatchObject({
        id: LEGACY_TARGET,
        kind: "s3",
        name: "S3",
        enabled: true,
        legacy_settings: true,
        customer_selectable: false,
        config_json: {},
        s3_secret_ciphertext_base64: null,
        s3_secret_iv_base64: null,
        s3_secret_auth_tag_base64: null,
        s3_secret_key_version: null,
        local_root: null,
        initialized_at: null,
        archived_at: null,
        last_test_outcome: "ok",
      });
      expect(new Date(String(targets[0]?.last_test_at)).toISOString()).toBe("2026-11-19T10:00:00.000Z");
    });

    it("leaves backup_settings and every site_backups column of the previous release untouched", async () => {
      expect(await rows(pg, "SELECT endpoint, bucket, prefix, schedule_hour_utc, retention_days FROM backup_settings")).toEqual([
        { endpoint: "https://s3.example", bucket: "bkt", prefix: "p", schedule_hour_utc: 4, retention_days: 21 },
      ]);
      const backups = await rows<{ id: string; snapshot_id: string | null; size_bytes: string | null; status: string; restore_target_id: null; archive_target_id: null }>(
        pg,
        "SELECT id, snapshot_id, size_bytes, status, restore_target_id, archive_target_id FROM site_backups ORDER BY id",
      );
      expect(backups.map((b) => [b.id, b.snapshot_id, b.status])).toEqual([
        ["bkp_busy", null, "failed"],
        ["bkp_fail", null, "failed"],
        ["bkp_failsnap", SNAP_C, "failed"],
        ["bkp_ok", SNAP_A, "succeeded"],
        ["bkp_run", null, "running"],
      ]);
      expect(backups.every((b) => b.restore_target_id === null && b.archive_target_id === null)).toBe(true);
    });

    it("seeds the default_site and panel policies from backup_settings and attaches the legacy target at priority 1", async () => {
      const policies = await rows<Record<string, unknown>>(pg, "SELECT * FROM backup_policies ORDER BY scope");
      expect(policies.map((p) => p.scope)).toEqual(["default_site", "panel"]);
      expect(policies[0]).toMatchObject({
        site_id: null,
        schedule_hour_utc: 4,
        retention_days: 21,
        enabled: true,
        nightly_run_started_at: null,
      });
      expect(await rows(pg, "SELECT to_char(last_nightly_run_on, 'YYYY-MM-DD') AS day FROM backup_policies WHERE scope = 'default_site'")).toEqual([
        { day: "2026-11-20" },
      ]);
      expect(policies[1]).toMatchObject({ site_id: null, schedule_hour_utc: null, retention_days: 21, last_nightly_run_on: null });
      expect(await rows(pg, "SELECT target_id, priority, required FROM backup_policy_targets ORDER BY policy_id")).toEqual([
        { target_id: LEGACY_TARGET, priority: 1, required: true },
        { target_id: LEGACY_TARGET, priority: 1, required: true },
      ]);
    });

    it("writes one copy per legacy backup that has a snapshot or is running, with the same snapshot ids and times", async () => {
      const copies = await rows<Record<string, unknown>>(
        pg,
        "SELECT backup_id, target_id, priority, required, job_id, status, snapshot_id, size_bytes, problem, started_at, finished_at FROM site_backup_copies ORDER BY backup_id",
      );
      expect(copies.map((c) => c.backup_id)).toEqual(["bkp_failsnap", "bkp_ok", "bkp_run"]);
      const byBackup = Object.fromEntries(copies.map((c) => [String(c.backup_id), c]));
      expect(byBackup.bkp_ok).toMatchObject({
        target_id: LEGACY_TARGET,
        priority: 1,
        required: true,
        job_id: "op_aaa",
        status: "succeeded",
        snapshot_id: SNAP_A,
        size_bytes: 10,
        problem: null,
      });
      expect(new Date(String(byBackup.bkp_ok?.started_at)).toISOString()).toBe("2026-11-01T02:00:00.000Z");
      expect(new Date(String(byBackup.bkp_ok?.finished_at)).toISOString()).toBe("2026-11-01T02:05:00.000Z");
      expect(byBackup.bkp_failsnap).toMatchObject({ status: "failed", snapshot_id: SNAP_C, problem: "interrupted", job_id: "op_ccc" });
      expect(byBackup.bkp_run).toMatchObject({ status: "running", snapshot_id: null, finished_at: null, job_id: "op_ddd" });
      // A failed backup with no snapshot never reached the repository: no copy.
      expect(copies.some((c) => c.backup_id === "bkp_fail" || c.backup_id === "bkp_busy")).toBe(false);
      expect(await rows(pg, "SELECT id FROM site_backup_copies WHERE id <> 'bcp_' || md5(backup_id || ':' || target_id)")).toEqual([]);
    });

    it("gives existing rows the rollback-compatible defaults on the tables it extends", async () => {
      expect(await rows(pg, "SELECT DISTINCT cert_mode, manual_certificate_version_id FROM domains")).toEqual([
        { cert_mode: "acme", manual_certificate_version_id: null },
      ]);
      expect(await rows(pg, "SELECT DISTINCT request_hash FROM operations")).toEqual([{ request_hash: null }]);
    });
  });

  describe("tls_publish_state and operations.request_hash", () => {
    it("seeds the single default row and refuses a second one or a confirmed generation above the desired one", async () => {
      expect(await rows(pg, "SELECT id, desired_generation, confirmed_generation FROM tls_publish_state")).toEqual([
        { id: "default", desired_generation: 0, confirmed_generation: 0 },
      ]);
      await refuses(pg, "INSERT INTO tls_publish_state (id) VALUES ('other')", "tls_publish_state_id_check");
      await refuses(pg, "UPDATE tls_publish_state SET confirmed_generation = 1", "ck_tls_publish_state_generations");
      await pg.exec("UPDATE tls_publish_state SET desired_generation = 2, confirmed_generation = 2");
      await pg.exec("UPDATE tls_publish_state SET desired_generation = 0, confirmed_generation = 0");
    });

    it("adds the request_hash CHECK NOT VALID so the never-purged operations table is not scanned, yet new rows are checked", async () => {
      expect(await rows(pg, "SELECT convalidated FROM pg_constraint WHERE conname = 'operations_request_hash_check'")).toEqual([{ convalidated: false }]);
      await refuses(pg, "INSERT INTO operations (id, organization_id, kind, resource_type, resource_id, request_hash) VALUES ('op_nv','oA','site.backups.create','site','s1','ZZ')", "operations_request_hash_check");
    });

    it("accepts a sha-256 hex request hash and refuses any other shape", async () => {
      await refuses(pg, "UPDATE operations SET request_hash = 'XYZ' WHERE id = 'op_1'", "operations_request_hash_check");
      await pg.exec(`UPDATE operations SET request_hash = '${"ab".repeat(32)}' WHERE id = 'op_1'`);
      await pg.exec("UPDATE operations SET request_hash = NULL WHERE id = 'op_1'");
    });
  });

  describe("0021 certificates, versions and domain assignment", () => {
    beforeAll(async () => {
      await pg.exec(`
        INSERT INTO tls_certificates (id, organization_id, name, created_for_site_id)
          VALUES ('cti_a','oA','a','s1'),('cti_b','oB','b',NULL);
        ${version("ctv_a1", "cti_a", "oA", 1, "a")};
        ${version("ctv_b1", "cti_b", "oB", 1, "b")};`);
    });

    it("refuses a version that names a certificate of another organization (composite FK)", async () => {
      await refuses(pg, version("ctv_x", "cti_a", "oB", 2, "e"), "fk_tls_certificate_versions_cert_org");
    });

    it("keeps a fingerprint unique per organization but not across organizations", async () => {
      await refuses(pg, version("ctv_dup", "cti_a", "oA", 2, "a"), "uq_tls_certificate_versions_org_fingerprint");
      await pg.exec(`INSERT INTO tls_certificates (id, organization_id, name) VALUES ('cti_tmp','oB','tmp'); ${version("ctv_tmp", "cti_tmp", "oB", 1, "a")}`);
      await pg.exec("DELETE FROM tls_certificates WHERE id = 'cti_tmp'");
    });

    it("keeps version numbers unique per certificate and the idempotency key unique per organization", async () => {
      await refuses(pg, version("ctv_n", "cti_a", "oA", 1, "f"), "uq_tls_certificate_versions_number");
      await pg.exec(version("ctv_k1", "cti_a", "oA", 5, "1", "idempotency_key='key-1'"));
      await refuses(pg, version("ctv_k2", "cti_a", "oA", 6, "2", "idempotency_key='key-1'"), "uq_tls_certificate_versions_org_idempotency");
      await pg.exec("DELETE FROM tls_certificate_versions WHERE id = 'ctv_k1'");
    });

    it("refuses malformed key material metadata and lifecycle values", async () => {
      await refuses(pg, version("ctv_t1", "cti_a", "oA", 7, "3").replace("'ec', 256", "'dsa', 1024"), "tls_certificate_versions_key_type_check");
      await refuses(pg, version("ctv_t2", "cti_a", "oA", 7, "3").replace("'ec', 256", "'ec', 8"), "tls_certificate_versions_key_bits_check");
      await refuses(pg, version("ctv_t3", "cti_a", "oA", 7, "3").replace(`'["a.example"]'`, "'[]'"), "tls_certificate_versions_san_dns_check");
      await refuses(pg, version("ctv_t4", "cti_a", "oA", 7, "3").replace("'01','" + "3".repeat(64) + "'", "'01','XYZ'"), "tls_certificate_versions_fingerprint_sha256_check");
      await refuses(pg, version("ctv_t5", "cti_a", "oA", 7, "3").replace("NOW() - INTERVAL '1 day', NOW() + INTERVAL '30 days'", "NOW(), NOW() - INTERVAL '1 day'"), "ck_tls_certificate_versions_validity");
      await refuses(pg, "UPDATE tls_certificate_versions SET status = 'bogus' WHERE id = 'ctv_a1'", "tls_certificate_versions_status_check");
      // The problem slug cannot carry free text, and so never a PEM block.
      await refuses(pg, "UPDATE tls_certificate_versions SET last_error_code = '-----BEGIN PRIVATE KEY----- x' WHERE id = 'ctv_a1'", "tls_certificate_versions_last_error_code_check");
      await refuses(pg, "UPDATE tls_certificate_versions SET last_error_code = 'Apply Failed' WHERE id = 'ctv_a1'", "tls_certificate_versions_last_error_code_check");
      await pg.exec("UPDATE tls_certificate_versions SET last_error_code = 'apply_failed' WHERE id = 'ctv_a1'");
      await pg.exec("UPDATE tls_certificate_versions SET last_error_code = NULL WHERE id = 'ctv_a1'");
      await refuses(pg, "UPDATE tls_certificates SET name = '' WHERE id = 'cti_a'", "tls_certificates_name_check");
    });

    it("accepts the active version of the same certificate and refuses the one of another certificate", async () => {
      await pg.exec("UPDATE tls_certificates SET active_version_id = 'ctv_a1' WHERE id = 'cti_a'");
      await refuses(pg, "UPDATE tls_certificates SET active_version_id = 'ctv_b1' WHERE id = 'cti_a'", "fk_tls_certificates_active_version");
    });

    it("refuses a domain that points to a version of another organization, and enforces the mode/version pairing", async () => {
      await refuses(pg, "UPDATE domains SET cert_mode = 'manual', manual_certificate_version_id = 'ctv_b1' WHERE id = 'd1'", "fk_domains_manual_cert_version_org");
      await refuses(pg, "UPDATE domains SET cert_mode = 'manual' WHERE id = 'd1'", "domains_cert_mode_version_check");
      await refuses(pg, "UPDATE domains SET manual_certificate_version_id = 'ctv_a1' WHERE id = 'd1'", "domains_cert_mode_version_check");
      await refuses(pg, "UPDATE domains SET cert_mode = 'other' WHERE id = 'd1'", "domains_cert_mode_check");
      await pg.exec("UPDATE domains SET cert_mode = 'manual', manual_certificate_version_id = 'ctv_a1' WHERE id = 'd1'");
    });

    it("makes the certificate material immutable and leaves the lifecycle columns mutable", async () => {
      await refuses(pg, "UPDATE tls_certificate_versions SET leaf_pem = 'X' WHERE id = 'ctv_a1'", "material is immutable");
      await refuses(pg, "UPDATE tls_certificate_versions SET key_ciphertext_base64 = 'X' WHERE id = 'ctv_a1'", "material is immutable");
      await refuses(pg, "UPDATE tls_certificate_versions SET fingerprint_sha256 = '" + "9".repeat(64) + "' WHERE id = 'ctv_a1'", "material is immutable");
      await refuses(pg, "UPDATE tls_certificate_versions SET san_dns = '[\"x.example\"]' WHERE id = 'ctv_a1'", "material is immutable");
      await refuses(pg, "UPDATE tls_certificate_versions SET request_hash = '" + "1".repeat(64) + "' WHERE id = 'ctv_a1'", "material is immutable");
      await refuses(pg, "UPDATE tls_certificate_versions SET organization_id = 'oB' WHERE id = 'ctv_a1'", "material is immutable");
      await pg.exec(
        "UPDATE tls_certificate_versions SET status = 'active', publish_generation = 3, last_error_code = NULL, last_checked_at = NOW(), activated_at = NOW() WHERE id = 'ctv_a1'",
      );
      expect(await rows(pg, "SELECT status, publish_generation FROM tls_certificate_versions WHERE id = 'ctv_a1'")).toEqual([
        { status: "active", publish_generation: 3 },
      ]);
    });

    it("refuses to delete a version or a certificate that a domain uses", async () => {
      await refuses(pg, "DELETE FROM tls_certificate_versions WHERE id = 'ctv_a1'", "fk_domains_manual_cert_version_org");
      await refuses(pg, "DELETE FROM tls_certificates WHERE id = 'cti_a'", "fk_domains_manual_cert_version_org");
    });

    it("refuses a site move while one of its domains is manual, and while a certificate names it as provenance", async () => {
      const move = "UPDATE sites SET organization_id = 'oB', host_allocation_id = 'aB' WHERE id = 's1'";
      // Both rules apply: whichever foreign key Postgres checks first refuses it.
      await refuses(pg, move, /fk_(domains_manual_cert_version_org|tls_certificates_site_org)/);
      // Manual domain alone (no provenance): the domain's composite FK refuses.
      await pg.exec("UPDATE tls_certificates SET created_for_site_id = NULL WHERE id = 'cti_a'");
      await refuses(pg, move, "fk_domains_manual_cert_version_org");
      // Provenance alone (domain back to automatic): the certificate's composite FK refuses.
      await pg.exec(`
        UPDATE domains SET cert_mode = 'acme', manual_certificate_version_id = NULL WHERE id = 'd1';
        UPDATE tls_certificates SET created_for_site_id = 's1' WHERE id = 'cti_a'`);
      await refuses(pg, move, "fk_tls_certificates_site_org");
      // The API pre-step clears the provenance, then the move goes through and the domain follows its site.
      await pg.exec(`UPDATE tls_certificates SET created_for_site_id = NULL WHERE created_for_site_id = 's1'; ${move}`);
      expect(await rows(pg, "SELECT organization_id FROM sites WHERE id = 's1'")).toEqual([{ organization_id: "oB" }]);
      expect(await rows(pg, "SELECT organization_id FROM domains WHERE id = 'd1'")).toEqual([{ organization_id: "oB" }]);
    });

    it("keeps the certificate when its site is deleted and clears the provenance", async () => {
      await pg.exec("UPDATE tls_certificates SET created_for_site_id = 's2' WHERE id = 'cti_a'; DELETE FROM sites WHERE id = 's2'");
      expect(await rows(pg, "SELECT organization_id, created_for_site_id FROM tls_certificates WHERE id = 'cti_a'")).toEqual([
        { organization_id: "oA", created_for_site_id: null },
      ]);
    });

    it("deletes an unused certificate with its versions and leaves no key ciphertext behind", async () => {
      await pg.exec("DELETE FROM tls_certificates WHERE id = 'cti_a'");
      expect(await rows(pg, "SELECT count(*)::int AS n FROM tls_certificate_versions WHERE certificate_id = 'cti_a'")).toEqual([{ n: 0 }]);
    });

    it("deletes a site that has a manual domain, and the organization cascade removes certificates and versions", async () => {
      await pg.exec(`
        UPDATE domains SET cert_mode = 'manual', manual_certificate_version_id = 'ctv_b1' WHERE id = 'd3';
        UPDATE tls_certificates SET active_version_id = 'ctv_b1', created_for_site_id = 's3' WHERE id = 'cti_b';
        DELETE FROM sites WHERE id = 's3'`);
      expect(await rows(pg, "SELECT created_for_site_id, active_version_id FROM tls_certificates WHERE id = 'cti_b'")).toEqual([
        { created_for_site_id: null, active_version_id: "ctv_b1" },
      ]);
      await pg.exec("DELETE FROM organizations WHERE id = 'oB'");
      expect(await rows(pg, "SELECT (SELECT count(*)::int FROM tls_certificates) AS c, (SELECT count(*)::int FROM tls_certificate_versions) AS v")).toEqual([
        { c: 0, v: 0 },
      ]);
    });
  });

  describe("0022 backup targets", () => {
    it("allows one live local target and one legacy target", async () => {
      await refuses(pg, "INSERT INTO backup_targets (id, kind, name) VALUES ('bkt_l1','local','L'),('bkt_l2','local','L2')", "uq_backup_targets_one_local");
      await pg.exec("INSERT INTO backup_targets (id, kind, name) VALUES ('bkt_l1','local','L')");
      await refuses(pg, "INSERT INTO backup_targets (id, kind, name) VALUES ('bkt_l2','local','L2')", "uq_backup_targets_one_local");
      await refuses(pg, "INSERT INTO backup_targets (id, kind, name, legacy_settings, s3_location_key) VALUES ('bkt_lg2','s3','S',TRUE,'https://lg2/b')", "uq_backup_targets_one_legacy");
    });

    it("keeps the S3 secret envelope exactly on non-legacy S3 targets", async () => {
      await refuses(
        pg,
        `INSERT INTO backup_targets (id, kind, name, config_json, s3_location_key)
         VALUES ('bkt_s','s3','S','{"endpoint":"https://e","region":"r","bucket":"b","prefix":"","accessKeyId":"A"}','https://e/b')`,
        "ck_backup_targets_secret",
      );
      await refuses(
        pg,
        `INSERT INTO backup_targets (id, kind, name, s3_secret_ciphertext_base64, s3_secret_iv_base64, s3_secret_auth_tag_base64, s3_secret_key_version)
         VALUES ('bkt_l3','local','L','c','i','t','v1')`,
        "ck_backup_targets_secret",
      );
      await refuses(
        pg,
        `UPDATE backup_targets SET s3_secret_ciphertext_base64 = 'c', s3_secret_iv_base64 = 'i', s3_secret_auth_tag_base64 = 't', s3_secret_key_version = 'v1' WHERE id = '${LEGACY_TARGET}'`,
        "ck_backup_targets_secret",
      );
    });

    it("requires the S3 location keys in config_json and an empty config for local and legacy targets", async () => {
      await refuses(
        pg,
        `INSERT INTO backup_targets (id, kind, name, config_json, s3_secret_ciphertext_base64, s3_secret_iv_base64, s3_secret_auth_tag_base64, s3_secret_key_version)
         VALUES ('bkt_x','s3','S','{"endpoint":"https://e","region":"r","prefix":"","accessKeyId":"A"}','c','i','t','v1')`,
        "ck_backup_targets_config",
      );
      await refuses(pg, `UPDATE backup_targets SET config_json = '{"x":1}' WHERE id = 'bkt_l1'`, "ck_backup_targets_config");
      await refuses(pg, `UPDATE backup_targets SET config_json = '{"endpoint":"e"}' WHERE id = '${LEGACY_TARGET}'`, "ck_backup_targets_(legacy|config)");
      await refuses(pg, "UPDATE backup_targets SET config_json = '[]' WHERE id = 'bkt_l1'", "backup_targets_config_json_check");
    });

    it("refuses two live S3 targets on one restic location, and allows the location again once the first is archived", async () => {
      await pg.exec(s3Target("bkt_s1", "p"));
      await refuses(pg, s3Target("bkt_s2", "p"), "uq_backup_targets_s3_location");
      await pg.exec(s3Target("bkt_s3", "other"));
      await pg.exec("DELETE FROM backup_targets WHERE id = 'bkt_s3'");
      await pg.exec(`UPDATE backup_targets SET archived_at = NOW(), enabled = FALSE WHERE id = 'bkt_s1'; ${s3Target("bkt_s2", "p")}`);
      expect(await rows(pg, "SELECT id FROM backup_targets WHERE kind = 's3' AND NOT legacy_settings AND archived_at IS NULL")).toEqual([{ id: "bkt_s2" }]);
    });

    it("builds the S3 location key with hp_s3_location_key: lowercase host, default port dropped, slashes normalised", async () => {
      const key = async (endpoint: string, bucket: string, prefix: string) =>
        (await rows<{ k: string | null }>(pg, `SELECT hp_s3_location_key('${endpoint}', '${bucket}', '${prefix}') AS k`))[0]?.k;
      expect(await key("https://S3.Example.com:443/", "bkt", "/a//b/")).toBe("https://s3.example.com/bkt/a/b");
      expect(await key("http://S3.Example.com:80", "bkt", "")).toBe("http://s3.example.com/bkt");
      expect(await key("https://s3.example.com:8443", "bkt", "p")).toBe("https://s3.example.com:8443/bkt/p");
      expect(await key("https://s3.example.com:80", "bkt", "p")).toBe("https://s3.example.com:80/bkt/p");
      expect(await key("http://s3.example.com:443", "bkt", "p")).toBe("http://s3.example.com:443/bkt/p");
      expect(await key("https://[2001:DB8::1]:443", "Bkt", "p")).toBe("https://[2001:db8::1]/Bkt/p");
      expect(await rows(pg, "SELECT hp_s3_location_key('https://e', 'b', NULL) AS k")).toEqual([{ k: null }]);
      expect((await rows<{ p: string; v: string }>(pg, "SELECT provolatile AS v, proparallel AS p FROM pg_proc WHERE proname = 'hp_s3_location_key'"))[0]).toMatchObject({ v: "i" });
    });

    it("treats case, default-port and slash variants of one endpoint/bucket/prefix as one restic location", async () => {
      await pg.exec(s3Row("bkt_v0", { ...S3_CONFIG, endpoint: "https://s3.example.com", prefix: "a/b" }));
      await refuses(pg, s3Row("bkt_v1", { ...S3_CONFIG, endpoint: "https://S3.EXAMPLE.COM", prefix: "a/b" }), "uq_backup_targets_s3_location");
      await refuses(pg, s3Row("bkt_v2", { ...S3_CONFIG, endpoint: "https://s3.example.com:443", prefix: "a/b" }), "uq_backup_targets_s3_location");
      await refuses(pg, s3Row("bkt_v3", { ...S3_CONFIG, endpoint: "https://s3.example.com", prefix: "/a//b/" }), "uq_backup_targets_s3_location");
      await pg.exec(s3Row("bkt_v4", { ...S3_CONFIG, endpoint: "https://s3.example.com:8443", prefix: "a/b" }));
      await pg.exec(s3Row("bkt_v5", { ...S3_CONFIG, endpoint: "http://s3.example.com", prefix: "a/b" }));
      await pg.exec(s3Row("bkt_v6", { ...S3_CONFIG, endpoint: "https://s3.example.com", bucket: "B", prefix: "a/b" }));
      await pg.exec("DELETE FROM backup_targets WHERE id LIKE 'bkt_v%'");
    });

    it("normalises the port numerically: leading zeros are stripped, then the scheme default is dropped", async () => {
      const key = async (endpoint: string, prefix = "p") =>
        (await rows<{ k: string | null }>(pg, `SELECT hp_s3_location_key('${endpoint}', 'bkt', '${prefix}') AS k`))[0]?.k;
      expect(await key("https://s3.example.com:0443")).toBe("https://s3.example.com/bkt/p");
      expect(await key("https://s3.example.com:00443")).toBe("https://s3.example.com/bkt/p");
      expect(await key("http://s3.example.com:080")).toBe("http://s3.example.com/bkt/p");
      expect(await key("http://S3.Example.com:00080")).toBe("http://s3.example.com/bkt/p");
      expect(await key("https://s3.example.com:09000")).toBe("https://s3.example.com:9000/bkt/p");
      expect(await key("https://s3.example.com:9000")).toBe("https://s3.example.com:9000/bkt/p");
      expect(await key("https://[2001:db8::1]:0443")).toBe("https://[2001:db8::1]/bkt/p");
      // a default of the OTHER scheme is an ordinary port; zeros alone never make a port
      expect(await key("https://s3.example.com:0080")).toBe("https://s3.example.com:80/bkt/p");
      expect(await key("http://s3.example.com:0443")).toBe("http://s3.example.com:443/bkt/p");
      expect(await key("https://s3.example.com:10")).toBe("https://s3.example.com:10/bkt/p");
      expect(await key("https://s3.example.com:0")).toBe("https://s3.example.com:0/bkt/p");
      expect(await key("https://s3.example.com:00")).toBe("https://s3.example.com:0/bkt/p");
    });

    it("refuses a zero-padded spelling of a port as another restic location", async () => {
      await pg.exec(s3Row("bkt_z0", { ...S3_CONFIG, endpoint: "https://s3.zero.example:9000", prefix: "z" }));
      await pg.exec(s3Row("bkt_z1", { ...S3_CONFIG, endpoint: "https://s3.zero.example", prefix: "z" }));
      await refuses(pg, s3Row("bkt_z2", { ...S3_CONFIG, endpoint: "https://s3.zero.example:09000", prefix: "z" }), "uq_backup_targets_s3_location");
      await refuses(pg, s3Row("bkt_z3", { ...S3_CONFIG, endpoint: "https://s3.zero.example:0443", prefix: "z" }), "uq_backup_targets_s3_location");
      await refuses(pg, s3Row("bkt_z4", { ...S3_CONFIG, endpoint: "https://s3.zero.example:00443", prefix: "z" }), "uq_backup_targets_s3_location");
      await pg.exec("DELETE FROM backup_targets WHERE id LIKE 'bkt_z%'");
    });

    it("keeps the legacy target in the same location space: a new target on the legacy settings location is refused", async () => {
      expect(await rows(pg, `SELECT s3_location_key FROM backup_targets WHERE id = '${LEGACY_TARGET}'`)).toEqual([
        { s3_location_key: "https://s3.example/bkt/p" },
      ]);
      await refuses(pg, s3Row("bkt_lg", { ...S3_CONFIG, endpoint: "https://S3.example:443", bucket: "bkt", prefix: "/p/" }), "uq_backup_targets_s3_location");
      await pg.exec(s3Row("bkt_lg", { ...S3_CONFIG, endpoint: "https://s3.example", bucket: "bkt", prefix: "q" }));
      await pg.exec("DELETE FROM backup_targets WHERE id = 'bkt_lg'");
    });

    it("refuses a live S3 target without a location key, or one that differs from its config", async () => {
      await refuses(pg, s3Row("bkt_k1", S3_CONFIG, null), "ck_backup_targets_s3_key");
      await refuses(pg, s3Row("bkt_k2", S3_CONFIG, "https://other/b/p"), "ck_backup_targets_s3_key");
      await refuses(pg, `UPDATE backup_targets SET s3_location_key = NULL WHERE id = '${LEGACY_TARGET}'`, "ck_backup_targets_s3_key");
      await refuses(pg, "UPDATE backup_targets SET s3_location_key = 'https://e/b/p' WHERE id = 'bkt_l1'", "ck_backup_targets_s3_key");
    });

    it("refuses JSON null, non-string values and extra keys in the S3 config (a plaintext secret must not fit)", async () => {
      for (const field of ["endpoint", "bucket", "prefix", "region", "accessKeyId"]) {
        await refuses(pg, s3Row("bkt_j1", { ...S3_CONFIG, [field]: null }), "ck_backup_targets_config");
        await refuses(pg, s3Row("bkt_j2", { ...S3_CONFIG, [field]: 7 }), "ck_backup_targets_config");
        await refuses(pg, s3Row("bkt_j3", { ...S3_CONFIG, [field]: ["x"] }), "ck_backup_targets_config");
      }
      await refuses(pg, s3Row("bkt_j4", { ...S3_CONFIG, secretAccessKey: "plaintext" }), "ck_backup_targets_config");
      await refuses(pg, s3Row("bkt_j5", { ...S3_CONFIG, note: "x" }), "ck_backup_targets_config");
      await refuses(pg, `UPDATE backup_targets SET config_json = config_json || '{"secret_access_key":"x"}' WHERE id = 'bkt_s2'`, "ck_backup_targets_config");
    });

    it("refuses an archived target that is still enabled or customer selectable", async () => {
      await refuses(pg, "UPDATE backup_targets SET archived_at = NOW() WHERE id = 'bkt_l1'", "ck_backup_targets_archived");
      await refuses(pg, "UPDATE backup_targets SET archived_at = NOW(), enabled = FALSE, customer_selectable = TRUE WHERE id = 'bkt_l1'", "ck_backup_targets_archived");
    });

    it("keeps local-only columns on local targets and shapes the root as an absolute path", async () => {
      await refuses(pg, "UPDATE backup_targets SET local_root = '/x' WHERE id = 'bkt_s2'", "ck_backup_targets_local_only");
      await refuses(pg, "UPDATE backup_targets SET initialized_at = NOW() WHERE id = 'bkt_s2'", "ck_backup_targets_local_only");
      await refuses(pg, "UPDATE backup_targets SET local_root = 'relative/path' WHERE id = 'bkt_l1'", "backup_targets_local_root_check");
      await refuses(pg, "UPDATE backup_targets SET local_root = '/var/a b' WHERE id = 'bkt_l1'", "backup_targets_local_root_check");
      await pg.exec("UPDATE backup_targets SET local_root = '/var/lib/hosting-panel/local-repos', initialized_at = NOW(), last_test_available_bytes = 1073741824, last_test_total_bytes = 2147483648 WHERE id = 'bkt_l1'");
      await refuses(pg, "UPDATE backup_targets SET last_test_available_bytes = -1 WHERE id = 'bkt_l1'", "backup_targets_last_test_available_bytes_check");
      await pg.exec("UPDATE backup_targets SET local_root = NULL, initialized_at = NULL WHERE id = 'bkt_l1'");
    });

    it("refuses retention and test outcome values outside their range", async () => {
      await refuses(pg, "UPDATE backup_targets SET retention_days = 0 WHERE id = 'bkt_l1'", "backup_targets_retention_days_check");
      await refuses(pg, "UPDATE backup_targets SET retention_days = 366 WHERE id = 'bkt_l1'", "backup_targets_retention_days_check");
      await refuses(pg, "UPDATE backup_targets SET last_test_outcome = 'maybe' WHERE id = 'bkt_l1'", "backup_targets_last_test_outcome_check");
      await refuses(pg, "INSERT INTO backup_targets (id, kind, name) VALUES ('bkt_k','tape','T')", "backup_targets_kind_check");
    });
  });

  describe("0022 policies, policy targets and copies", () => {
    it("enforces the scope rules of the policy rows", async () => {
      await refuses(pg, "INSERT INTO backup_policies (id, scope) VALUES ('bpl_x','site')", "ck_backup_policies_site");
      await refuses(pg, "INSERT INTO backup_policies (id, scope, schedule_hour_utc, retention_days) VALUES ('bpl_y','default_site',2,14)", "uq_backup_policies_scope");
      await refuses(pg, "INSERT INTO backup_policies (id, scope, retention_days) VALUES ('bpl_p','panel',9)", "uq_backup_policies_scope");
      await refuses(pg, "INSERT INTO backup_policies (id, scope, retention_days) VALUES ('bpl_h','default_site',9)", "ck_backup_policies_hour");
      await refuses(pg, "UPDATE backup_policies SET schedule_hour_utc = 24 WHERE scope = 'default_site'", "backup_policies_schedule_hour_utc_check");
      await refuses(pg, "UPDATE backup_policies SET retention_days = 0 WHERE scope = 'panel'", "backup_policies_retention_days_check");
      await refuses(pg, "UPDATE backup_policies SET last_nightly_run_on = '2026-11-21' WHERE scope = 'panel'", "ck_backup_policies_nightly");
      await refuses(pg, "UPDATE backup_policies SET nightly_run_started_at = NOW() WHERE scope = 'panel'", "ck_backup_policies_nightly");
      await pg.exec("UPDATE backup_policies SET nightly_run_started_at = NOW() WHERE scope = 'default_site'");
      await pg.exec("UPDATE backup_policies SET nightly_run_started_at = NULL WHERE scope = 'default_site'");
      await pg.exec("INSERT INTO sites (id, organization_id, host_allocation_id, name, slug) VALUES ('s5','oA','aA','s5','s5')");
      await refuses(pg, "INSERT INTO backup_policies (id, scope, site_id, retention_days) VALUES ('bpl_z','site','s5',3)", "ck_backup_policies_retention");
      await refuses(pg, "INSERT INTO backup_policies (id, scope, site_id, schedule_hour_utc) VALUES ('bpl_z','site','s5',3)", "ck_backup_policies_hour");
      await refuses(pg, "INSERT INTO backup_policies (id, scope, site_id, enabled) VALUES ('bpl_z','site','s5',FALSE)", "ck_backup_policies_site_enabled");
      await refuses(pg, "INSERT INTO backup_policies (id, scope, site_id, schedule_hour_utc, retention_days) VALUES ('bpl_z','default_site','s5',2,14)", "ck_backup_policies_site");
    });

    it("accepts a site policy of targets only, one per site, and cascades with the site", async () => {
      await pg.exec(`INSERT INTO backup_policies (id, scope, site_id) VALUES ('bpl_s1','site','s5'); INSERT INTO backup_policy_targets VALUES ('bpl_s1','bkt_l1',1,TRUE)`);
      await refuses(pg, "INSERT INTO backup_policies (id, scope, site_id) VALUES ('bpl_s2','site','s5')", "uq_backup_policies_site");
      await pg.exec("DELETE FROM sites WHERE id = 's5'");
      expect(await rows(pg, "SELECT count(*)::int AS n FROM backup_policies WHERE id = 'bpl_s1'")).toEqual([{ n: 0 }]);
      expect(await rows(pg, "SELECT count(*)::int AS n FROM backup_policy_targets WHERE policy_id = 'bpl_s1'")).toEqual([{ n: 0 }]);
    });

    it("allows at most two targets per policy with distinct priorities", async () => {
      await pg.exec("INSERT INTO sites (id, organization_id, host_allocation_id, name, slug) VALUES ('s6','oA','aA','s6','s6')");
      await pg.exec(`INSERT INTO backup_policies (id, scope, site_id) VALUES ('bpl_s6','site','s6')`);
      await pg.exec("INSERT INTO backup_policy_targets VALUES ('bpl_s6','bkt_l1',1,TRUE)");
      await refuses(pg, `INSERT INTO backup_policy_targets VALUES ('bpl_s6','${LEGACY_TARGET}',3,TRUE)`, "backup_policy_targets_priority_check");
      await refuses(pg, `INSERT INTO backup_policy_targets VALUES ('bpl_s6','${LEGACY_TARGET}',1,TRUE)`, "uq_backup_policy_targets_priority");
      await refuses(pg, "INSERT INTO backup_policy_targets VALUES ('bpl_s6','bkt_l1',2,TRUE)", "backup_policy_targets_pkey");
      await pg.exec(`INSERT INTO backup_policy_targets VALUES ('bpl_s6','${LEGACY_TARGET}',2,FALSE)`);
    });

    it("refuses to delete a target that a policy or a copy references (archive only)", async () => {
      await refuses(pg, "DELETE FROM backup_targets WHERE id = 'bkt_l1'", "backup_policy_targets_target_id_fkey");
      await refuses(pg, `DELETE FROM backup_targets WHERE id = '${LEGACY_TARGET}'`, "(backup_policy_targets|site_backup_copies)_target_id_fkey");
    });

    it("accepts the partial aggregate status and refuses an unknown one", async () => {
      await refuses(pg, "UPDATE site_backups SET status = 'bogus' WHERE id = 'bkp_ok'", "site_backups_status_check");
      await pg.exec("UPDATE site_backups SET status = 'partial' WHERE id = 'bkp_ok'");
      await pg.exec("UPDATE site_backups SET status = 'succeeded' WHERE id = 'bkp_ok'");
    });

    it("refuses a succeeded copy without a snapshot, for site and panel copies", async () => {
      await refuses(pg, "INSERT INTO site_backup_copies (id, backup_id, target_id, priority, status) VALUES ('bcp_x','bkp_fail','bkt_l1',2,'succeeded')", "ck_site_backup_copies_snapshot");
      await refuses(pg, "INSERT INTO site_backup_copies (id, backup_id, target_id, priority, status) VALUES ('bcp_x','bkp_fail','bkt_l1',2,'bogus')", "site_backup_copies_status_check");
      await pg.exec("INSERT INTO operations (id, organization_id, kind, resource_type, resource_id) VALUES ('op_p','oA','panel.backups.create','site','s1')");
      await refuses(pg, "INSERT INTO panel_backup_copies (id, operation_id, target_id, status) VALUES ('pbc_1','op_p','bkt_l1','succeeded')", "ck_panel_backup_copies_snapshot");
    });

    it("keeps one copy per backup and target, one per priority, and one job id per copy", async () => {
      await pg.exec(`INSERT INTO site_backup_copies (id, backup_id, target_id, priority, status, job_id) VALUES ('bcp_l1','bkp_fail','bkt_l1',1,'failed','op_bbb-t2')`);
      await refuses(pg, "INSERT INTO site_backup_copies (id, backup_id, target_id, priority, status) VALUES ('bcp_l2','bkp_fail','bkt_l1',2,'failed')", "uq_site_backup_copies_backup_target");
      await refuses(pg, `INSERT INTO site_backup_copies (id, backup_id, target_id, priority, status) VALUES ('bcp_l2','bkp_fail','${LEGACY_TARGET}',1,'failed')`, "uq_site_backup_copies_backup_priority");
      await refuses(pg, `INSERT INTO site_backup_copies (id, backup_id, target_id, priority, status, job_id) VALUES ('bcp_l2','bkp_busy','bkt_l1',1,'failed','op_bbb-t2')`, "uq_site_backup_copies_job");
      await pg.exec(`INSERT INTO panel_backup_copies (id, operation_id, target_id, priority, status, job_id) VALUES ('pbc_ok','op_p','bkt_l1',1,'running','op_p')`);
      await refuses(pg, `INSERT INTO panel_backup_copies (id, operation_id, target_id, priority, status) VALUES ('pbc_2','op_p','bkt_l1',2,'failed')`, "uq_panel_backup_copies_operation_target");
      await refuses(pg, `INSERT INTO panel_backup_copies (id, operation_id, target_id, priority, status) VALUES ('pbc_2','op_p','${LEGACY_TARGET}',1,'failed')`, "uq_panel_backup_copies_operation_priority");
      await refuses(pg, `INSERT INTO panel_backup_copies (id, operation_id, target_id, priority, status, job_id) VALUES ('pbc_2','op_1','bkt_l1',1,'failed','op_p')`, "uq_panel_backup_copies_job");
    });

    it("cascades a deleted logical backup to its copies (the previous release's deleteAllSiteBackups) and a deleted operation to panel copies", async () => {
      expect(await rows(pg, "SELECT count(*)::int AS n FROM site_backup_copies WHERE backup_id = 'bkp_ok'")).toEqual([{ n: 1 }]);
      await pg.exec("DELETE FROM site_backups WHERE id = 'bkp_ok'");
      expect(await rows(pg, "SELECT count(*)::int AS n FROM site_backup_copies WHERE backup_id = 'bkp_ok'")).toEqual([{ n: 0 }]);
      await pg.exec("DELETE FROM operations WHERE id = 'op_p'");
      expect(await rows(pg, "SELECT count(*)::int AS n FROM panel_backup_copies")).toEqual([{ n: 0 }]);
    });

    it("clears the restore and archive target references of a backup when an unreferenced target is removed", async () => {
      await pg.exec(`${s3Target("bkt_ref", "ref")};
        UPDATE site_backups SET restore_target_id = 'bkt_ref', archive_target_id = 'bkt_ref' WHERE id = 'bkp_fail'`);
      await pg.exec("DELETE FROM backup_targets WHERE id = 'bkt_ref'");
      expect(await rows(pg, "SELECT restore_target_id, archive_target_id FROM site_backups WHERE id = 'bkp_fail'")).toEqual([
        { restore_target_id: null, archive_target_id: null },
      ]);
    });
  });
});

describe("HCP-SPEC-004 migrations 0021/0022 on a fresh install", () => {
  let pg: PGlite;
  let afterFirstRun = "";

  beforeAll(async () => {
    pg = new PGlite();
    await applyAll(pg);
    afterFirstRun = await snapshot(pg);
  }, 120_000);

  afterAll(async () => {
    await pg.close();
  });

  it("creates both policies with the defaults and no target at all", async () => {
    expect(await rows(pg, "SELECT scope, site_id, schedule_hour_utc, retention_days, enabled FROM backup_policies ORDER BY scope")).toEqual([
      { scope: "default_site", site_id: null, schedule_hour_utc: 2, retention_days: 14, enabled: true },
      { scope: "panel", site_id: null, schedule_hour_utc: null, retention_days: 14, enabled: true },
    ]);
    expect(await rows(pg, "SELECT count(*)::int AS n FROM backup_targets")).toEqual([{ n: 0 }]);
    expect(await rows(pg, "SELECT count(*)::int AS n FROM backup_policy_targets")).toEqual([{ n: 0 }]);
    expect(await rows(pg, "SELECT count(*)::int AS n FROM site_backup_copies")).toEqual([{ n: 0 }]);
  });

  it("seeds tls_publish_state and survives a second run of both files unchanged", async () => {
    expect(await rows(pg, "SELECT id, desired_generation, confirmed_generation FROM tls_publish_state")).toEqual([
      { id: "default", desired_generation: 0, confirmed_generation: 0 },
    ]);
    await pg.exec(read(M0021));
    await pg.exec(read(M0022));
    expect(await snapshot(pg)).toBe(afterFirstRun);
    expect(await rows(pg, "SELECT count(*)::int AS n FROM backup_policies")).toEqual([{ n: 2 }]);
  });
});

describe("HCP-SPEC-004 Drizzle schema matches the migrated tables", () => {
  let client: DatabaseClient;

  beforeAll(async () => {
    client = createDatabaseClient({ mode: "pglite" });
    await client.migrate();
  }, 120_000);

  afterAll(async () => {
    await client.close();
  });

  const NEW_TABLES: Array<[string, PgTable]> = [
    ["tls_certificates", tlsCertificates],
    ["tls_certificate_versions", tlsCertificateVersions],
    ["tls_publish_state", tlsPublishState],
    ["backup_targets", backupTargets],
    ["backup_policies", backupPolicies],
    ["backup_policy_targets", backupPolicyTargets],
    ["site_backup_copies", siteBackupCopies],
    ["panel_backup_copies", panelBackupCopies],
  ];

  it.each(NEW_TABLES)("%s declares exactly the columns of the migrated table", async (name, table) => {
    const declared = getTableConfig(table).columns.map((column) => column.name).sort();
    expect(declared).toEqual(await columnsOf(client, name));
  });

  it("declares only unique constraints and named foreign keys that exist in Postgres under the same name", async () => {
    const declared = NEW_TABLES.flatMap(([name, table]) => {
      const config = getTableConfig(table);
      return [
        ...config.uniqueConstraints.map((constraint) => `${name}.${constraint.name}`),
        ...config.foreignKeys.map((fk) => fk.getName()).filter((fkName) => fkName.startsWith("fk_")).map((fkName) => `${name}.${fkName}`),
      ];
    }).sort();
    const result = await client.db.execute(
      sql`SELECT conrelid::regclass::text AS tbl, conname FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND contype IN ('u', 'f')`,
    );
    const present = new Set((result.rows as Array<{ tbl: string; conname: string }>).map((row) => `${row.tbl}.${row.conname}`));
    expect(declared.length).toBeGreaterThan(10);
    expect(declared.filter((name) => !present.has(name))).toEqual([]);
  });

  it("declares the columns that 0021/0022 add to domains, operations and site_backups", () => {
    const names = (table: PgTable) => getTableConfig(table).columns.map((column) => column.name);
    expect(names(domains)).toEqual(expect.arrayContaining(["cert_mode", "manual_certificate_version_id"]));
    expect(names(operations)).toContain("request_hash");
    expect(names(siteBackups)).toEqual(expect.arrayContaining(["restore_target_id", "archive_target_id"]));
  });

  it("round-trips a manual certificate, a domain assignment and a backup target through Drizzle", async () => {
    const { db } = client;
    await db.insert(platformInstallations).values({ id: "pin_h4", name: "H4" });
    await db.insert(hosts).values({
      id: "hst_h4",
      platformInstallationId: "pin_h4",
      name: "h4",
      hostname: "h4.example",
      ipv4Address: "192.0.2.4",
      totalCpuMilli: 1000,
      totalMemoryBytes: "1",
      totalStorageBytes: "1",
    });
    await db.insert(organizations).values({ id: "org_h4", platformInstallationId: "pin_h4", name: "H4", slug: "h4" });
    await db.insert(hostAllocations).values({ id: "ha_h4", hostId: "hst_h4", organizationId: "org_h4" });
    await db.insert(sites).values({ id: "sit_h4", organizationId: "org_h4", hostAllocationId: "ha_h4", name: "s", slug: "s" });
    await db.insert(domains).values({ id: "dom_h4", siteId: "sit_h4", organizationId: "org_h4", hostname: "h4.example.org" });
    expect((await db.select().from(domains).where(eq(domains.id, "dom_h4")))[0]).toMatchObject({ certMode: "acme", manualCertificateVersionId: null });

    await db.insert(tlsCertificates).values({ id: "cti_h4", organizationId: "org_h4", name: "shop", createdForSiteId: "sit_h4" });
    const notBefore = new Date("2026-11-01T00:00:00Z");
    const notAfter = new Date("2027-02-01T00:00:00Z");
    await db.insert(tlsCertificateVersions).values({
      id: "ctv_h4",
      certificateId: "cti_h4",
      organizationId: "org_h4",
      versionNumber: 1,
      leafPem: "L",
      chainPem: "",
      keyCiphertextBase64: "c",
      keyIvBase64: "i",
      keyAuthTagBase64: "t",
      subject: "CN=shop.example",
      issuer: "CN=CA",
      serialNumber: "01",
      fingerprintSha256: "f".repeat(64),
      notBefore,
      notAfter,
      sanDns: ["shop.example", "*.shop.example"],
      keyType: "ec",
      keyBits: 256,
    });
    const [stored] = await db.select().from(tlsCertificateVersions).where(eq(tlsCertificateVersions.id, "ctv_h4"));
    expect(stored).toMatchObject({
      status: "pending",
      keyVersion: "v1",
      publishGeneration: 0,
      lastErrorCode: null,
      sanDns: ["shop.example", "*.shop.example"],
      keyBits: 256,
    });
    expect(stored?.notAfter.toISOString()).toBe(notAfter.toISOString());

    await db.update(domains).set({ certMode: "manual", manualCertificateVersionId: "ctv_h4" }).where(eq(domains.id, "dom_h4"));
    expect((await db.select().from(domains).where(eq(domains.id, "dom_h4")))[0]).toMatchObject({ certMode: "manual", manualCertificateVersionId: "ctv_h4" });
    await db.update(tlsCertificates).set({ activeVersionId: "ctv_h4" }).where(eq(tlsCertificates.id, "cti_h4"));
    expect((await db.select().from(tlsPublishState))[0]).toMatchObject({ id: "default", desiredGeneration: 0, confirmedGeneration: 0 });

    await db.insert(backupTargets).values({ id: "bkt_h4", kind: "local", name: "Local", localRoot: "/var/lib/hosting-panel/local-repos", lastTestAvailableBytes: 5_000_000_000 });
    expect((await db.select().from(backupTargets).where(eq(backupTargets.id, "bkt_h4")))[0]).toMatchObject({
      enabled: true,
      legacySettings: false,
      customerSelectable: false,
      configJson: {},
      localRoot: "/var/lib/hosting-panel/local-repos",
      lastTestAvailableBytes: 5_000_000_000,
      archivedAt: null,
    });
    const policies = await db.select().from(backupPolicies);
    expect(policies.map((policy) => policy.scope).sort()).toEqual(["default_site", "panel"]);
    expect(policies.find((policy) => policy.scope === "default_site")).toMatchObject({ scheduleHourUtc: 2, retentionDays: 14, lastNightlyRunOn: null });
  });
});

async function columnsOf(client: DatabaseClient, table: string): Promise<string[]> {
  const result = await client.db.execute(
    sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table} ORDER BY column_name`,
  );
  return (result.rows as Array<{ column_name: string }>).map((row) => row.column_name).sort();
}

// ---------------------------------------------------------------------------------------------------------------
// The legacy target keeps its location in backup_settings. The database, not the application, keeps the two in step:
// the release that runs may be this one, a future adapter or an older release after an automatic rollback.
const settingsInsert = (endpoint: string, bucket: string, prefix: string) =>
  `INSERT INTO backup_settings (id, endpoint, region, bucket, prefix, access_key_id, secret_access_key_ciphertext_base64,
     secret_access_key_iv_base64, secret_access_key_auth_tag_base64)
   VALUES ('default','${endpoint}','eu','${bucket}','${prefix}','AK','c','i','t')`;

describe("HCP-SPEC-004 0022: the legacy target's location key follows backup_settings (any application version)", () => {
  let pg: PGlite;
  const legacy = () => rows<Record<string, unknown>>(pg, `SELECT * FROM backup_targets WHERE id = '${LEGACY_TARGET}'`);
  const legacyKey = async () => (await legacy())[0]?.s3_location_key;
  const settings = () => rows(pg, "SELECT endpoint, bucket, prefix, access_key_id, region FROM backup_settings");
  // What an older release issues to change the settings: it knows nothing of backup_targets.
  const olderRelease = (set: string) => `UPDATE backup_settings SET ${set}, updated_at = NOW() WHERE id = 'default'`;

  beforeAll(async () => {
    pg = new PGlite();
    await applyAll(pg, M0021);
    await pg.exec(ORG_SEED);
    await pg.exec(LEGACY_SEED);
    await pg.exec(read(M0021));
    await pg.exec(read(M0022));
  }, 120_000);

  afterAll(async () => {
    await pg.close();
  });

  it("installs exactly one trigger on backup_settings, however often 0022 runs", async () => {
    const triggers = () => rows(pg, "SELECT tgname FROM pg_trigger WHERE tgrelid = 'backup_settings'::regclass AND NOT tgisinternal");
    expect(await triggers()).toHaveLength(1);
    await pg.exec(read(M0022));
    await pg.exec(read(M0022));
    expect(await triggers()).toHaveLength(1);
    expect(await legacyKey()).toBe("https://s3.example/bkt/p");
  });

  it("leaves the legacy row byte-identical on a credential-only update (the key is a function of the location alone)", async () => {
    const before = JSON.stringify(await legacy());
    await pg.exec(
      olderRelease(
        "access_key_id = 'AK2', region = 'us-east-1', secret_access_key_ciphertext_base64 = 'c2', schedule_hour_utc = 7, retention_days = 30, last_test_outcome = NULL, last_test_at = NULL",
      ),
    );
    expect(JSON.stringify(await legacy())).toBe(before);
    // the same location spelled differently is the same location: still no change to the row
    await pg.exec(olderRelease("endpoint = 'https://S3.Example:443/', prefix = '/p/'"));
    expect(JSON.stringify(await legacy())).toBe(before);
  });

  it("moves the legacy key when an older release moves the location: the new location is taken, the abandoned one is free", async () => {
    await pg.exec(olderRelease("endpoint = 'https://S3.Moved.example:0443', bucket = 'moved', prefix = '/q//r/'"));
    expect(await legacyKey()).toBe("https://s3.moved.example/moved/q/r");
    await refuses(pg, s3Row("bkt_n1", { ...S3_CONFIG, endpoint: "https://s3.moved.example", bucket: "moved", prefix: "q/r" }), "uq_backup_targets_s3_location");
    await pg.exec(s3Row("bkt_n2", { ...S3_CONFIG, endpoint: "https://s3.example", bucket: "bkt", prefix: "p" }));
    await pg.exec("DELETE FROM backup_targets WHERE id = 'bkt_n2'");
  });

  it("follows an upsert the way the previous release writes it (INSERT ... ON CONFLICT DO UPDATE)", async () => {
    await pg.exec(`${settingsInsert("https://s3.upsert.example", "up", "u")}
      ON CONFLICT (id) DO UPDATE SET endpoint = EXCLUDED.endpoint, bucket = EXCLUDED.bucket, prefix = EXCLUDED.prefix`);
    expect(await legacyKey()).toBe("https://s3.upsert.example/up/u");
    await refuses(pg, s3Row("bkt_n3", { ...S3_CONFIG, endpoint: "https://s3.upsert.example", bucket: "up", prefix: "u" }), "uq_backup_targets_s3_location");
  });

  it("fails the settings write when a live target already holds the new location (fail closed: no shared restic repository)", async () => {
    await pg.exec(s3Row("bkt_held", { ...S3_CONFIG, endpoint: "https://s3.held.example", bucket: "held", prefix: "h" }));
    const [settingsBefore, keyBefore] = [JSON.stringify(await settings()), await legacyKey()];
    await refuses(pg, olderRelease("endpoint = 'https://S3.HELD.example:443', bucket = 'held', prefix = 'h/'"), "uq_backup_targets_s3_location");
    await refuses(
      pg,
      `${settingsInsert("https://s3.held.example", "held", "h")} ON CONFLICT (id) DO UPDATE SET endpoint = EXCLUDED.endpoint, bucket = EXCLUDED.bucket, prefix = EXCLUDED.prefix`,
      "uq_backup_targets_s3_location",
    );
    expect(JSON.stringify(await settings())).toBe(settingsBefore);
    expect(await legacyKey()).toBe(keyBefore);
    await pg.exec("DELETE FROM backup_targets WHERE id = 'bkt_held'");
    // once the holder is gone the same write goes through
    await pg.exec(olderRelease("endpoint = 'https://s3.held.example', bucket = 'held', prefix = 'h'"));
    expect(await legacyKey()).toBe("https://s3.held.example/held/h");
  });

  it("keeps the legacy target live when the settings are deleted: copies, policy rows and key stay, and the next INSERT moves the key", async () => {
    const counts = async () => ({
      copies: (await rows<{ n: number }>(pg, "SELECT count(*)::int AS n FROM site_backup_copies"))[0]?.n,
      policyTargets: (await rows<{ n: number }>(pg, "SELECT count(*)::int AS n FROM backup_policy_targets"))[0]?.n,
    });
    const before = await counts();
    expect(before.copies).toBeGreaterThan(0);
    await pg.exec("DELETE FROM backup_settings WHERE id = 'default'");
    const [kept] = await legacy();
    expect(kept).toMatchObject({ legacy_settings: true, enabled: true, archived_at: null, s3_location_key: "https://s3.held.example/held/h" });
    expect(await counts()).toEqual(before);
    // While the settings are absent the location its copies live at stays taken.
    await refuses(pg, s3Row("bkt_held_again", { ...S3_CONFIG, endpoint: "https://s3.held.example", bucket: "held", prefix: "h" }), "uq_backup_targets_s3_location");

    // The admin (or the previous release) saves S3 again, elsewhere: an INSERT. The same live target follows it.
    await pg.exec(settingsInsert("https://s3.reborn.example", "reborn", "r"));
    expect((await legacy())[0]).toMatchObject({ id: LEGACY_TARGET, enabled: true, archived_at: null, s3_location_key: "https://s3.reborn.example/reborn/r" });
    expect(await rows(pg, "SELECT id FROM backup_targets WHERE legacy_settings")).toHaveLength(1);
    expect(await counts()).toEqual(before);
    // ... so no regular target may take the new location, and the abandoned one is free.
    await refuses(pg, s3Row("bkt_reborn", { ...S3_CONFIG, endpoint: "https://s3.reborn.example", bucket: "reborn", prefix: "r" }), "uq_backup_targets_s3_location");
    await pg.exec(s3Row("bkt_old_held", { ...S3_CONFIG, endpoint: "https://s3.held.example", bucket: "held", prefix: "h" }));
    await pg.exec("DELETE FROM backup_targets WHERE id = 'bkt_old_held'");
  });

  it("a legacy target archived on purpose (the M3 adapter) is never touched by the settings; a second 0022 run changes nothing and attaches nothing to it at another location", async () => {
    await pg.exec("UPDATE backup_targets SET archived_at = NOW(), enabled = FALSE, customer_selectable = FALSE WHERE id = '" + LEGACY_TARGET + "'");
    // No live legacy target holds the settings' location any more, so a regular target may take it.
    await pg.exec(s3Row("bkt_takes_reborn", { ...S3_CONFIG, endpoint: "https://s3.reborn.example", bucket: "reborn", prefix: "r" }));
    await pg.exec("DELETE FROM backup_targets WHERE id = 'bkt_takes_reborn'");
    await pg.exec(olderRelease("bucket = 'reborn2'"));
    expect((await legacy())[0]).toMatchObject({ enabled: false, s3_location_key: "https://s3.reborn.example/reborn/r" });
    expect((await legacy())[0]?.archived_at).not.toBeNull();

    await pg.exec(`INSERT INTO site_backups (id, site_id, kind, status, operation_id, snapshot_id)
      VALUES ('bkp_elsewhere','s1','manual','succeeded','op_elsewhere','${SNAP_A}')`);
    const state = async () => JSON.stringify(await rows(pg, "SELECT id, enabled, customer_selectable, archived_at, s3_location_key FROM backup_targets ORDER BY id"));
    const before = [await state(), await snapshot(pg)];
    await pg.exec(read(M0022));
    expect([await state(), await snapshot(pg)]).toEqual(before);
    expect(await rows(pg, "SELECT 1 FROM site_backup_copies WHERE backup_id = 'bkp_elsewhere'")).toEqual([]);

    // The settings point at the archived target's own location again: its repository is the one the row was written to.
    await pg.exec(olderRelease("endpoint = 'https://s3.reborn.example', bucket = 'reborn', prefix = 'r'"));
    await pg.exec(read(M0022));
    expect(await rows(pg, `SELECT target_id FROM site_backup_copies WHERE backup_id = 'bkp_elsewhere'`)).toEqual([{ target_id: LEGACY_TARGET }]);
    expect((await legacy())[0]?.archived_at).not.toBeNull();
  });
});

describe("HCP-SPEC-004 0022: the first write of backup_settings creates the live legacy target (fresh install, tests, older release)", () => {
  let pg: PGlite;
  const legacy = () => rows<Record<string, unknown>>(pg, "SELECT * FROM backup_targets WHERE legacy_settings");
  const attached = () =>
    rows(pg, "SELECT p.scope, t.target_id, t.priority, t.required FROM backup_policy_targets t JOIN backup_policies p ON p.id = t.policy_id ORDER BY p.scope");
  const targetsState = async () => JSON.stringify([await rows(pg, "SELECT * FROM backup_targets ORDER BY id"), await attached()]);

  beforeAll(async () => {
    pg = new PGlite();
    await applyAll(pg);
  }, 120_000);

  afterAll(async () => {
    await pg.close();
  });

  it("starts without any legacy target; a plain INSERT creates it, keyed by the location, attached to both policies at priority 1", async () => {
    expect(await legacy()).toEqual([]);
    await pg.exec(settingsInsert("https://S3.Fresh.example:443", "fresh", "/f/"));
    const [target] = await legacy();
    expect(target).toMatchObject({
      id: LEGACY_TARGET,
      kind: "s3",
      name: "S3",
      enabled: true,
      customer_selectable: false,
      archived_at: null,
      config_json: {},
      s3_location_key: "https://s3.fresh.example/fresh/f",
    });
    expect(await attached()).toEqual([
      { scope: "default_site", target_id: LEGACY_TARGET, priority: 1, required: true },
      { scope: "panel", target_id: LEGACY_TARGET, priority: 1, required: true },
    ]);
  });

  it("a second run of 0022 changes nothing", async () => {
    const before = await targetsState();
    await pg.exec(read(M0022));
    expect(await targetsState()).toBe(before);
  });

  it("an older release's DELETE + INSERT keeps the one live legacy target, moves its key and adds no policy row", async () => {
    await pg.exec("DELETE FROM backup_settings WHERE id = 'default'");
    expect(await legacy()).toHaveLength(1);
    await pg.exec(settingsInsert("https://s3.moved.example", "moved", "m"));
    expect(await legacy()).toHaveLength(1);
    expect((await legacy())[0]).toMatchObject({ id: LEGACY_TARGET, archived_at: null, s3_location_key: "https://s3.moved.example/moved/m" });
    expect(await attached()).toHaveLength(2);
  });

  it("never revives, re-points or duplicates an archived legacy target", async () => {
    await pg.exec(`UPDATE backup_targets SET archived_at = NOW(), enabled = FALSE, customer_selectable = FALSE WHERE id = '${LEGACY_TARGET}'`);
    await pg.exec("DELETE FROM backup_settings WHERE id = 'default'");
    await pg.exec(settingsInsert("https://s3.other.example", "other", "o"));
    const all = await rows<Record<string, unknown>>(pg, "SELECT * FROM backup_targets WHERE legacy_settings");
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ enabled: false, s3_location_key: "https://s3.moved.example/moved/m" });
    expect(all[0]?.archived_at).not.toBeNull();
  });

  it("fails the first write closed when a live target already holds the location: no settings row, no legacy target", async () => {
    const fresh = new PGlite();
    try {
      await applyAll(fresh);
      await fresh.exec(s3Row("bkt_holder", { ...S3_CONFIG, endpoint: "https://s3.held.example", bucket: "held", prefix: "h" }));
      await refuses(fresh, settingsInsert("https://S3.HELD.example:443", "held", "h/"), "uq_backup_targets_s3_location");
      expect(await rows(fresh, "SELECT 1 FROM backup_settings")).toEqual([]);
      expect(await rows(fresh, "SELECT 1 FROM backup_targets WHERE legacy_settings")).toEqual([]);
    } finally {
      await fresh.close();
    }
  });
});
