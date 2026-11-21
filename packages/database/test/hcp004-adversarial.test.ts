import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LEGACY_BACKUP_TARGET_ID,
  appendAuditEvent,
  backupTargetS3SecretAad,
  decryptSecretAesGcm,
  deleteTlsCertificate,
  encryptSecretAesGcm,
  enqueueOperationTransactional,
  insertTlsCertificateVersion,
  insertTlsCertificateWithVersion,
  readTlsVersionKey,
  repairLegacyBackupCopies,
  resolveMigrationsDirectory,
  tlsKeyAad,
  type HostingPanelDatabase,
  type NewTlsVersion,
} from "../src/index.js";

// HCP-SPEC-004 M1, adversarial pass on PGlite (migrations 0021/0022, TLS repository, request hash, PEM guards).
// Independent of the engineers' suites: these tests attack the schema and the repositories, they do not re-prove
// the happy path. Ids in the test names are the acceptance ids of the spec (TLS-xx / BKP-xx) they defend.
const dir = resolveMigrationsDirectory();
const M0022 = "0022_backup_targets_and_copies.sql";
const allFiles = readdirSync(dir)
  .filter((file) => file.endsWith(".sql"))
  .sort();
const read = (file: string) => readFileSync(path.join(dir, file), "utf8");

const MASTER_KEY = "c".repeat(64);
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const LEGACY = LEGACY_BACKUP_TARGET_ID;

async function install(until?: string): Promise<PGlite> {
  const pg = new PGlite();
  for (const file of allFiles) {
    if (until !== undefined && file >= until) break;
    await pg.exec(read(file));
  }
  return pg;
}

const asDb = (pg: PGlite) => drizzle(pg) as unknown as HostingPanelDatabase;

async function rows<T = Record<string, unknown>>(pg: PGlite, query: string): Promise<T[]> {
  return (await pg.query<T>(query)).rows;
}

const count = async (pg: PGlite, table: string, where = "TRUE"): Promise<number> =>
  Number((await rows<{ n: number }>(pg, `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`))[0]?.n);

// A statement the database must refuse; `constraint` pins WHICH rule refused it.
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

// Same, for a script that opens its own transaction: always leaves the connection clean.
async function refusesInTx(pg: PGlite, statements: string[], constraint: RegExp | string): Promise<void> {
  let message = "";
  try {
    await pg.exec("BEGIN");
    for (const statement of statements) await pg.exec(statement);
    await pg.exec("COMMIT");
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  } finally {
    await pg.exec("ROLLBACK").catch(() => undefined);
  }
  expect(message, `expected a refusal of: ${statements.join("; ")}`).not.toBe("");
  expect(message).toMatch(typeof constraint === "string" ? new RegExp(constraint) : constraint);
}

const fp = (n: number) => n.toString(16).padStart(64, "0");

interface RawVersion {
  id: string;
  cert: string;
  org: string;
  n: number;
  fingerprint: string;
  ct?: string;
  iv?: string;
  tag?: string;
  idem?: string | null;
  hash?: string | null;
}
const rawVersion = (v: RawVersion) =>
  `INSERT INTO tls_certificate_versions (id, certificate_id, organization_id, version_number, leaf_pem, chain_pem,
     key_ciphertext_base64, key_iv_base64, key_auth_tag_base64, subject, issuer, serial_number, fingerprint_sha256,
     not_before, not_after, san_dns, key_type, key_bits, idempotency_key, request_hash)
   VALUES ('${v.id}','${v.cert}','${v.org}',${String(v.n)},'LEAF','CHAIN','${v.ct ?? "ct"}','${v.iv ?? "iv"}','${v.tag ?? "tag"}',
     's','i','01','${v.fingerprint}', NOW() - INTERVAL '1 day', NOW() + INTERVAL '30 days', '["a.example"]', 'ec', 256,
     ${v.idem === undefined || v.idem === null ? "NULL" : `'${v.idem}'`}, ${v.hash === undefined || v.hash === null ? "NULL" : `'${v.hash}'`})`;

const s3Target = (id: string, prefix: string, extra = "") =>
  `INSERT INTO backup_targets (id, kind, name, config_json, s3_location_key, s3_secret_ciphertext_base64, s3_secret_iv_base64,
     s3_secret_auth_tag_base64, s3_secret_key_version)
   SELECT '${id}','s3','S', c.cfg, hp_s3_location_key(c.cfg->>'endpoint', c.cfg->>'bucket', c.cfg->>'prefix'), 'c','i','t','v1'
   FROM (SELECT '{"endpoint":"https://e","region":"r","bucket":"b","prefix":${prefix},"accessKeyId":"A"${extra}}'::jsonb AS cfg) c`;

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

// ---------------------------------------------------------------------------------------------------------------
describe("HCP-SPEC-004 adversarial: cross-tenant foreign keys (TLS-04, BKP-15)", () => {
  let pg: PGlite;

  beforeAll(async () => {
    pg = await install();
    await pg.exec(ORG_SEED);
    await pg.exec(`
      INSERT INTO tls_certificates (id, organization_id, name) VALUES ('cti_a','oA','a'),('cti_b','oB','b');
      ${rawVersion({ id: "ctv_a1", cert: "cti_a", org: "oA", n: 1, fingerprint: fp(1) })};
      ${rawVersion({ id: "ctv_b1", cert: "cti_b", org: "oB", n: 1, fingerprint: fp(2) })};`);
  }, 120_000);

  afterAll(async () => {
    await pg.close();
  });

  it("TLS-04 refuses a certificate whose provenance site belongs to another organization, on insert and update", async () => {
    await refuses(pg, "INSERT INTO tls_certificates (id, organization_id, name, created_for_site_id) VALUES ('cti_x','oB','x','s1')", "fk_tls_certificates_site_org");
    await refuses(pg, "UPDATE tls_certificates SET created_for_site_id = 's3' WHERE id = 'cti_a'", "fk_tls_certificates_site_org");
    await refuses(pg, "UPDATE tls_certificates SET created_for_site_id = 'site_that_does_not_exist' WHERE id = 'cti_a'", "fk_tls_certificates_site_org");
    // same organization, any site: allowed (the certificate is reusable across the sites of its organization)
    await pg.exec("UPDATE tls_certificates SET created_for_site_id = 's2' WHERE id = 'cti_a'");
    await pg.exec("UPDATE tls_certificates SET created_for_site_id = NULL WHERE id = 'cti_a'");
  });

  it("TLS-04 refuses to move a certificate that has versions to another organization (its key AAD names the org)", async () => {
    await refuses(pg, "UPDATE tls_certificates SET organization_id = 'oB' WHERE id = 'cti_a'", "fk_tls_certificate_versions_cert_org");
    expect(await rows(pg, "SELECT organization_id FROM tls_certificates WHERE id = 'cti_a'")).toEqual([{ organization_id: "oA" }]);
  });

  it("TLS-04 refuses a NEW domain that points at another organization's version, in either column order", async () => {
    await refuses(
      pg,
      "INSERT INTO domains (id, site_id, organization_id, hostname, cert_mode, manual_certificate_version_id) VALUES ('d9','s1','oA','z.example','manual','ctv_b1')",
      "fk_domains_manual_cert_version_org",
    );
    // the domain borrows the tenant of the version instead: then its own site (organization A) refuses
    await refuses(
      pg,
      "INSERT INTO domains (id, site_id, organization_id, hostname, cert_mode, manual_certificate_version_id) VALUES ('d9','s1','oB','z.example','manual','ctv_b1')",
      "fk_domains_site_org",
    );
    await refuses(pg, "UPDATE domains SET organization_id = 'oB', cert_mode = 'manual', manual_certificate_version_id = 'ctv_b1' WHERE id = 'd1'", "fk_domains_site_org");
    expect(await count(pg, "domains", "id = 'd9'")).toBe(0);
  });

  it("TLS-04 cannot be defeated by deferring constraints inside one transaction", async () => {
    await refusesInTx(
      pg,
      [
        "SET CONSTRAINTS ALL DEFERRED",
        "UPDATE domains SET cert_mode = 'manual', manual_certificate_version_id = 'ctv_b1' WHERE id = 'd1'",
      ],
      "fk_domains_manual_cert_version_org",
    );
    expect(await rows(pg, "SELECT cert_mode FROM domains WHERE id = 'd1'")).toEqual([{ cert_mode: "acme" }]);
  });

  it("TLS-04 holds in every statement order around a site move: move first, assign after, move back", async () => {
    await pg.exec(`INSERT INTO sites (id, organization_id, host_allocation_id, name, slug) VALUES ('s4','oA','aA','s4','s4');
      INSERT INTO domains (id, site_id, organization_id, hostname) VALUES ('d4','s4','oA','m.example')`);
    const move = (org: string, alloc: string) => `UPDATE sites SET organization_id = '${org}', host_allocation_id = '${alloc}' WHERE id = 's4'`;
    await pg.exec(move("oB", "aB")); // the domain follows its site (ON UPDATE CASCADE)
    expect(await rows(pg, "SELECT organization_id FROM domains WHERE id = 'd4'")).toEqual([{ organization_id: "oB" }]);
    // the old tenant's version can no longer be assigned to the domain that now lives in the new tenant
    await refuses(pg, "UPDATE domains SET cert_mode = 'manual', manual_certificate_version_id = 'ctv_a1' WHERE id = 'd4'", "fk_domains_manual_cert_version_org");
    await pg.exec("UPDATE domains SET cert_mode = 'manual', manual_certificate_version_id = 'ctv_b1' WHERE id = 'd4'");
    // and it cannot be taken back to the old tenant while it holds the new tenant's certificate
    await refuses(pg, move("oA", "aA"), "fk_domains_manual_cert_version_org");
    // one transaction: release the certificate, move back, assign the foreign version again: refused at the last step
    await refusesInTx(
      pg,
      [
        "UPDATE domains SET cert_mode = 'acme', manual_certificate_version_id = NULL WHERE id = 'd4'",
        move("oA", "aA"),
        "UPDATE domains SET cert_mode = 'manual', manual_certificate_version_id = 'ctv_b1' WHERE id = 'd4'",
      ],
      "fk_domains_manual_cert_version_org",
    );
    expect(await rows(pg, "SELECT organization_id, cert_mode FROM domains WHERE id = 'd4'")).toEqual([{ organization_id: "oB", cert_mode: "manual" }]);
  });

  it("TLS-04 a version row cannot be re-owned: neither UPDATE nor an upsert of the same id changes its organization", async () => {
    await refuses(pg, "UPDATE tls_certificate_versions SET organization_id = 'oB' WHERE id = 'ctv_a1'", "material is immutable");
    await refuses(
      pg,
      `${rawVersion({ id: "ctv_a1", cert: "cti_b", org: "oB", n: 9, fingerprint: fp(77) })}
       ON CONFLICT (id) DO UPDATE SET certificate_id = EXCLUDED.certificate_id, organization_id = EXCLUDED.organization_id`,
      "material is immutable",
    );
    expect(await rows(pg, "SELECT certificate_id, organization_id FROM tls_certificate_versions WHERE id = 'ctv_a1'")).toEqual([
      { certificate_id: "cti_a", organization_id: "oA" },
    ]);
  });

  it("BKP-15 a target shared by two sites' policies and copies never couples the sites: deleting one leaves the other whole", async () => {
    await pg.exec(`
      INSERT INTO backup_targets (id, kind, name) VALUES ('bkt_shared','local','L');
      INSERT INTO backup_policies (id, scope, site_id) VALUES ('bpl_x1','site','s1'),('bpl_x2','site','s2');
      INSERT INTO backup_policy_targets VALUES ('bpl_x1','bkt_shared',1,TRUE),('bpl_x2','bkt_shared',1,TRUE);
      INSERT INTO site_backups (id, site_id, kind, status, operation_id, snapshot_id) VALUES
        ('bk_x1','s1','manual','succeeded','op_x1','${"1".repeat(64)}'),('bk_x2','s2','manual','succeeded','op_x2','${"2".repeat(64)}');
      INSERT INTO site_backup_copies (id, backup_id, target_id, status, snapshot_id, job_id) VALUES
        ('bcp_x1','bk_x1','bkt_shared','succeeded','${"1".repeat(64)}','job_1'),('bcp_x2','bk_x2','bkt_shared','succeeded','${"2".repeat(64)}','job_2')`);
    // job ids are global: a second site cannot reuse the first site's job id
    await pg.exec("INSERT INTO backup_targets (id, kind, name, enabled, archived_at) VALUES ('bkt_second','local','second',FALSE,NOW())");
    await refuses(pg, "INSERT INTO site_backup_copies (id, backup_id, target_id, priority, status, job_id) VALUES ('bcp_dup','bk_x2','bkt_second',2,'failed','job_1')", "uq_site_backup_copies_job");
    await refuses(pg, "INSERT INTO backup_policies (id, scope, site_id) VALUES ('bpl_ghost','site','site_that_does_not_exist')", "backup_policies_site_id_fkey");
    // the shared target cannot disappear under either site while it is referenced
    await refuses(pg, "DELETE FROM backup_targets WHERE id = 'bkt_shared'", /backup_policy_targets_target_id_fkey|site_backup_copies_target_id_fkey/);
    // site 1 goes: its policy, its policy targets (site cascade) and its backups' copies (backup cascade) follow; site 2 is untouched
    await pg.exec("DELETE FROM sites WHERE id = 's1'; DELETE FROM site_backups WHERE site_id = 's1'");
    expect(await count(pg, "backup_policies", "id = 'bpl_x1'")).toBe(0);
    expect(await count(pg, "backup_policy_targets", "policy_id = 'bpl_x1'")).toBe(0);
    expect(await count(pg, "site_backup_copies", "id = 'bcp_x1'")).toBe(0);
    expect(await count(pg, "backup_policy_targets", "policy_id = 'bpl_x2'")).toBe(1);
    expect(await count(pg, "site_backup_copies", "id = 'bcp_x2'")).toBe(1);
    expect(await count(pg, "backup_targets", "id = 'bkt_shared'")).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("HCP-SPEC-004 adversarial: immutability of tls_certificate_versions (TLS-09, TLS-01)", () => {
  let pg: PGlite;
  const id = "ctv_imm1";

  beforeAll(async () => {
    pg = await install();
    await pg.exec(ORG_SEED);
    await pg.exec(`
      INSERT INTO tls_certificates (id, organization_id, name) VALUES ('cti_i','oA','i'),('cti_j','oA','j');
      ${rawVersion({ id, cert: "cti_i", org: "oA", n: 1, fingerprint: fp(10), idem: "key-1", hash: HASH_A })};
      ${rawVersion({ id: "ctv_imm2", cert: "cti_i", org: "oA", n: 2, fingerprint: fp(11) })}`);
  }, 120_000);

  afterAll(async () => {
    await pg.close();
  });

  // Every column the trigger lists, each with a value that satisfies its CHECK, so only the trigger can refuse.
  const MUTATIONS: [string, string][] = [
    ["id", "'ctv_renamed'"],
    ["certificate_id", "'cti_j'"],
    ["version_number", "42"],
    ["leaf_pem", "'OTHER LEAF'"],
    ["chain_pem", "''"],
    ["key_ciphertext_base64", "'swapped'"],
    ["key_iv_base64", "'swapped'"],
    ["key_auth_tag_base64", "'swapped'"],
    ["key_version", "'v2'"],
    ["subject", "'CN=evil'"],
    ["issuer", "'CN=evil'"],
    ["serial_number", "'ff'"],
    ["fingerprint_sha256", `'${fp(999)}'`],
    ["not_before", "NOW() - INTERVAL '2 days'"],
    ["not_after", "NOW() + INTERVAL '900 days'"],
    ["san_dns", `'["evil.example"]'::jsonb`],
    ["key_type", "'rsa'"],
    ["key_bits", "4096"],
    ["idempotency_key", "'another-key'"],
    ["request_hash", `'${HASH_B}'`],
    ["created_at", "NOW() + INTERVAL '1 year'"],
  ];

  it.each(MUTATIONS)("TLS-09 refuses an UPDATE of %s", async (column, value) => {
    await refuses(pg, `UPDATE tls_certificate_versions SET ${column} = ${value} WHERE id = '${id}'`, "material is immutable");
  });

  it("TLS-09 refuses to erase or forge the idempotency evidence: value to NULL, NULL to value, hash to NULL", async () => {
    await refuses(pg, `UPDATE tls_certificate_versions SET idempotency_key = NULL WHERE id = '${id}'`, "material is immutable");
    await refuses(pg, `UPDATE tls_certificate_versions SET request_hash = NULL WHERE id = '${id}'`, "material is immutable");
    await refuses(pg, "UPDATE tls_certificate_versions SET idempotency_key = 'forged' WHERE id = 'ctv_imm2'", "material is immutable");
    await refuses(pg, `UPDATE tls_certificate_versions SET request_hash = '${HASH_B}' WHERE id = 'ctv_imm2'`, "material is immutable");
  });

  it("TLS-09 a multi-row UPDATE with one mutating row changes nothing at all", async () => {
    await refuses(
      pg,
      `UPDATE tls_certificate_versions SET status = 'active', leaf_pem = CASE WHEN id = 'ctv_imm2' THEN 'X' ELSE leaf_pem END WHERE certificate_id = 'cti_i'`,
      "material is immutable",
    );
    expect(await rows(pg, "SELECT status, leaf_pem FROM tls_certificate_versions WHERE certificate_id = 'cti_i' ORDER BY id")).toEqual([
      { status: "pending", leaf_pem: "LEAF" },
      { status: "pending", leaf_pem: "LEAF" },
    ]);
  });

  it("TLS-09 mixing a lifecycle change with a material change in one statement is refused as a whole", async () => {
    await refuses(pg, `UPDATE tls_certificate_versions SET status = 'active', publish_generation = 7, fingerprint_sha256 = '${fp(998)}' WHERE id = '${id}'`, "material is immutable");
    expect(await rows(pg, `SELECT status, publish_generation FROM tls_certificate_versions WHERE id = '${id}'`)).toEqual([{ status: "pending", publish_generation: 0 }]);
  });

  it("TLS-09 lifecycle columns stay writable and a no-op rewrite of the material is accepted", async () => {
    await pg.exec(`UPDATE tls_certificate_versions SET leaf_pem = leaf_pem, san_dns = san_dns, idempotency_key = idempotency_key WHERE id = '${id}'`);
    for (const status of ["applying", "failed", "pending", "applying", "active", "inactive"]) {
      await pg.exec(`UPDATE tls_certificate_versions SET status = '${status}', publish_generation = publish_generation + 1, last_checked_at = NOW() WHERE id = '${id}'`);
    }
    expect(await rows(pg, `SELECT status, publish_generation FROM tls_certificate_versions WHERE id = '${id}'`)).toEqual([{ status: "inactive", publish_generation: 6 }]);
  });

  it("TLS-09 an INSERT .. ON CONFLICT DO UPDATE cannot overwrite the key envelope of an existing version", async () => {
    await refuses(
      pg,
      `${rawVersion({ id, cert: "cti_i", org: "oA", n: 1, fingerprint: fp(10), ct: "attacker-ct", iv: "attacker-iv", tag: "attacker-tag" })}
       ON CONFLICT (id) DO UPDATE SET key_ciphertext_base64 = EXCLUDED.key_ciphertext_base64,
         key_iv_base64 = EXCLUDED.key_iv_base64, key_auth_tag_base64 = EXCLUDED.key_auth_tag_base64`,
      "material is immutable",
    );
    expect(await rows(pg, `SELECT key_ciphertext_base64 AS c FROM tls_certificate_versions WHERE id = '${id}'`)).toEqual([{ c: "ct" }]);
  });

  it("TLS-09 an assigned version cannot be swapped out by delete + insert of the same id in one transaction", async () => {
    await pg.exec(`UPDATE domains SET cert_mode = 'manual', manual_certificate_version_id = '${id}' WHERE id = 'd1'`);
    await refusesInTx(
      pg,
      [`DELETE FROM tls_certificate_versions WHERE id = '${id}'`, rawVersion({ id, cert: "cti_i", org: "oA", n: 1, fingerprint: fp(10), ct: "attacker-ct" })],
      "fk_domains_manual_cert_version_org",
    );
    expect(await rows(pg, `SELECT key_ciphertext_base64 AS c FROM tls_certificate_versions WHERE id = '${id}'`)).toEqual([{ c: "ct" }]);
    await pg.exec("UPDATE domains SET cert_mode = 'acme', manual_certificate_version_id = NULL WHERE id = 'd1'");
  });

  it("TLS-11 deleting the active version of an unassigned certificate clears the pointer but keeps the certificate and its other versions", async () => {
    await pg.exec(`UPDATE tls_certificates SET active_version_id = 'ctv_imm2' WHERE id = 'cti_i'; DELETE FROM tls_certificate_versions WHERE id = 'ctv_imm2'`);
    expect(await rows(pg, "SELECT organization_id, active_version_id FROM tls_certificates WHERE id = 'cti_i'")).toEqual([{ organization_id: "oA", active_version_id: null }]);
    expect(await count(pg, "tls_certificate_versions", "certificate_id = 'cti_i'")).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("HCP-SPEC-004 adversarial: TLS repository (TLS-01, TLS-09, TLS-11)", () => {
  let pg: PGlite;
  let db: HostingPanelDatabase;
  let seq = 1000;

  const keyMarker = (n: number) => `ADVERSARIAL-KEY-MATERIAL-${String(n)}`;
  const version = (n: number, over: Partial<NewTlsVersion> = {}): NewTlsVersion => ({
    leafPem: `-----BEGIN CERTIFICATE-----\nADVLEAF${String(n)}\n-----END CERTIFICATE-----\n`,
    chainPem: `-----BEGIN CERTIFICATE-----\nADVCHAIN${String(n)}\n-----END CERTIFICATE-----\n`,
    privateKeyPem: `-----BEGIN PRIVATE KEY-----\n${keyMarker(n)}\n-----END PRIVATE KEY-----\n`,
    subject: `CN=h${String(n)}.example`,
    issuer: "CN=Test CA",
    serialNumber: n.toString(16),
    fingerprintSha256: fp(n),
    notBefore: new Date("2026-11-01T00:00:00.000Z"),
    notAfter: new Date("2027-11-01T00:00:00.000Z"),
    sanDns: [`h${String(n)}.example`],
    keyType: "ec",
    keyBits: 256,
    ...over,
  });
  const next = (over: Partial<NewTlsVersion> = {}) => version((seq += 1), over);
  const importCert = (org = "oA", extra: { key?: string; hash?: string; v?: NewTlsVersion } = {}) =>
    insertTlsCertificateWithVersion(db, {
      organizationId: org,
      name: "Adversarial",
      createdForSiteId: null,
      createdByUserId: null,
      version: extra.v ?? next(),
      masterKey: MASTER_KEY,
      ...(extra.key === undefined ? {} : { idempotencyKey: extra.key }),
      ...(extra.hash === undefined ? {} : { requestHash: extra.hash }),
    });
  const addVersion = (certificateId: string, org = "oA", extra: { key?: string; hash?: string; v?: NewTlsVersion } = {}) =>
    insertTlsCertificateVersion(db, {
      organizationId: org,
      certificateId,
      createdByUserId: null,
      version: extra.v ?? next(),
      masterKey: MASTER_KEY,
      ...(extra.key === undefined ? {} : { idempotencyKey: extra.key }),
      ...(extra.hash === undefined ? {} : { requestHash: extra.hash }),
    });

  beforeAll(async () => {
    pg = await install();
    await pg.exec(ORG_SEED);
    db = asDb(pg);
  }, 120_000);

  afterAll(async () => {
    await pg.close();
  });

  describe("version numbers under the certificate row lock (TLS-09)", () => {
    it("hands 8 parallel new versions distinct, contiguous numbers and leaves no gap", async () => {
      const { certificateId } = await importCert();
      const results = await Promise.all(Array.from({ length: 8 }, () => addVersion(certificateId)));
      expect(results.map((r) => r.versionNumber).sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
      expect(new Set(results.map((r) => r.versionId)).size).toBe(8);
      expect(await rows(pg, `SELECT version_number FROM tls_certificate_versions WHERE certificate_id = '${certificateId}' ORDER BY version_number`)).toEqual(
        [1, 2, 3, 4, 5, 6, 7, 8, 9].map((version_number) => ({ version_number })),
      );
    });

    it("parallel replays of one idempotency key create exactly one version, and every caller learns its id and number", async () => {
      const { certificateId } = await importCert();
      const same = next();
      const results = await Promise.all(Array.from({ length: 6 }, () => addVersion(certificateId, "oA", { key: "race-key", hash: HASH_A, v: same })));
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect(new Set(results.map((r) => r.versionId)).size).toBe(1);
      expect(new Set(results.map((r) => r.versionNumber))).toEqual(new Set([2]));
      expect(await count(pg, "tls_certificate_versions", `certificate_id = '${certificateId}'`)).toBe(2);
    });

    it("parallel callers that reuse one key with two different request hashes: one wins, the other hash is IDEMPOTENCY_CONFLICT", async () => {
      const { certificateId } = await importCert();
      const settled = await Promise.allSettled(
        [HASH_A, HASH_B, HASH_A, HASH_B, HASH_A, HASH_B].map((hash) => addVersion(certificateId, "oA", { key: "mixed-key", hash, v: next() })),
      );
      const ok = settled.filter((s): s is PromiseFulfilledResult<Awaited<ReturnType<typeof addVersion>>> => s.status === "fulfilled");
      const bad = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
      expect(ok.filter((s) => !s.value.replayed)).toHaveLength(1);
      expect(bad).toHaveLength(3);
      for (const failure of bad) expect(failure.reason).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      const [stored] = await rows<{ request_hash: string }>(pg, `SELECT request_hash FROM tls_certificate_versions WHERE certificate_id = '${certificateId}' AND idempotency_key = 'mixed-key'`);
      expect(stored?.request_hash).toBeDefined();
      expect(await count(pg, "tls_certificate_versions", `certificate_id = '${certificateId}'`)).toBe(2);
    });

    it("parallel imports of one fingerprint: one certificate wins, the rest are ALREADY_EXISTS naming it, and no orphan certificate stays", async () => {
      const shared = next();
      const before = await count(pg, "tls_certificates");
      const settled = await Promise.allSettled(Array.from({ length: 5 }, () => importCert("oA", { v: shared })));
      const ok = settled.filter((s) => s.status === "fulfilled");
      const bad = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
      expect(ok).toHaveLength(1);
      const winner = (ok[0] as PromiseFulfilledResult<{ certificateId: string; versionId: string }>).value;
      for (const failure of bad) {
        expect(failure.reason).toMatchObject({ code: "ALREADY_EXISTS", existing: { certificateId: winner.certificateId, versionId: winner.versionId } });
      }
      expect(bad).toHaveLength(4);
      expect(await count(pg, "tls_certificates")).toBe(before + 1);
    });

    it.each([
      ["insert first, delete second", false],
      ["delete first, insert second", true],
    ])("a new version racing a delete (%s) never leaves an orphan version or a raw foreign-key error", async (_label, deleteFirst) => {
      const { certificateId } = await importCert();
      const del = () => db.transaction((tx) => deleteTlsCertificate(tx, { organizationId: "oA", certificateId }));
      const add = () => addVersion(certificateId);
      const settled = await Promise.allSettled(deleteFirst ? [del(), add()] : [add(), del()]);
      const deleted = settled[deleteFirst ? 0 : 1] as PromiseSettledResult<unknown>;
      const added = settled[deleteFirst ? 1 : 0] as PromiseSettledResult<unknown>;
      expect(deleted.status).toBe("fulfilled");
      if (added.status === "rejected") expect(added.reason).toMatchObject({ code: "NOT_FOUND" });
      expect(await count(pg, "tls_certificates", `id = '${certificateId}'`)).toBe(0);
      expect(await count(pg, "tls_certificate_versions", `certificate_id = '${certificateId}'`)).toBe(0);
    });
  });

  describe("wrong AAD and swapped envelopes (TLS-01)", () => {
    let a1: { certificateId: string; versionId: string };
    let a2: { versionId: string };
    let b1: { certificateId: string; versionId: string };
    const envelope = async (versionId: string) =>
      (await rows<{ c: string; i: string; t: string }>(pg, `SELECT key_ciphertext_base64 AS c, key_iv_base64 AS i, key_auth_tag_base64 AS t FROM tls_certificate_versions WHERE id = '${versionId}'`))[0]!;
    // The trigger forbids UPDATE, so a hostile row is a fresh INSERT carrying somebody else's envelope.
    const forge = async (id: string, certificateId: string, org: string, n: number, env: { c: string; i: string; t: string }) => {
      seq += 1;
      await pg.exec(rawVersion({ id, cert: certificateId, org, n, fingerprint: fp(seq), ct: env.c, iv: env.i, tag: env.t }));
      return readTlsVersionKey(db, { versionId: id, masterKey: MASTER_KEY });
    };

    beforeAll(async () => {
      a1 = await importCert("oA");
      a2 = await addVersion(a1.certificateId);
      b1 = await importCert("oB");
    });

    it("the untouched versions open with the right master key (guards the failures below against passing vacuously)", async () => {
      for (const [versionId, marker] of [[a1.versionId, "ADVERSARIAL-KEY-MATERIAL-"], [a2.versionId, "ADVERSARIAL-KEY-MATERIAL-"], [b1.versionId, "ADVERSARIAL-KEY-MATERIAL-"]] as const) {
        expect((await readTlsVersionKey(db, { versionId, masterKey: MASTER_KEY })).privateKeyPem).toContain(marker);
      }
    });

    it("an envelope copied onto a sibling version of the same certificate does not authenticate (version in the AAD)", async () => {
      await expect(forge("ctv_forge_sibling", a1.certificateId, "oA", 50, await envelope(a1.versionId))).rejects.toThrow();
    });

    it("an envelope of another organization's version copied into this organization's certificate does not authenticate", async () => {
      const donor = await envelope(b1.versionId);
      await expect(forge("ctv_forge_xorg_a", a1.certificateId, "oA", 51, donor)).rejects.toThrow();
      const { certificateId: bOwn } = await importCert("oB");
      await expect(forge("ctv_forge_xorg_b", bOwn, "oB", 2, await envelope(a1.versionId))).rejects.toThrow();
    });

    it("a tampered tag, IV or ciphertext is rejected (integrity), each against the original that still opens", async () => {
      const env = await envelope(a1.versionId);
      const flip = (b64: string) => {
        const bytes = Buffer.from(b64, "base64");
        bytes[0] = (bytes[0] ?? 0) ^ 0x01;
        return bytes.toString("base64");
      };
      await expect(forge("ctv_forge_tag", a1.certificateId, "oA", 52, { ...env, t: flip(env.t) })).rejects.toThrow();
      await expect(forge("ctv_forge_iv", a1.certificateId, "oA", 53, { ...env, i: flip(env.i) })).rejects.toThrow();
      await expect(forge("ctv_forge_ct", a1.certificateId, "oA", 54, { ...env, c: flip(env.c) })).rejects.toThrow();
      await expect(forge("ctv_forge_trunc", a1.certificateId, "oA", 55, { ...env, c: Buffer.from(env.c, "base64").subarray(0, 4).toString("base64") })).rejects.toThrow();
      await expect(readTlsVersionKey(db, { versionId: a1.versionId, masterKey: MASTER_KEY })).resolves.toMatchObject({ certificateId: a1.certificateId });
    });

    it("a secret of another kind sealed under the same master key (backup target S3 secret) cannot be read back as a TLS key", async () => {
      const foreign = encryptSecretAesGcm({ ...backupTargetS3SecretAad("bkt_x"), plaintext: "s3-secret", masterKey: MASTER_KEY });
      await expect(
        forge("ctv_forge_kind", a1.certificateId, "oA", 56, { c: foreign.ciphertextBase64, i: foreign.ivBase64, t: foreign.authTagBase64 }),
      ).rejects.toThrow();
    });

    it("the AAD pins organization, certificate AND version: any single wrong component fails, the exact triple opens", async () => {
      const env = await envelope(a1.versionId);
      const open = (org: string, cert: string, ver: string) =>
        decryptSecretAesGcm({ ...tlsKeyAad(org, cert, ver), ciphertextBase64: env.c, ivBase64: env.i, authTagBase64: env.t, masterKey: MASTER_KEY });
      expect(open("oA", a1.certificateId, a1.versionId)).toContain("ADVERSARIAL-KEY-MATERIAL-");
      expect(() => open("oB", a1.certificateId, a1.versionId)).toThrow();
      expect(() => open("oA", b1.certificateId, a1.versionId)).toThrow();
      expect(() => open("oA", a1.certificateId, a2.versionId)).toThrow();
    });
  });

  describe("hard delete leaves no key ciphertext anywhere (TLS-11, TLS-01)", () => {
    const publicTables = async (): Promise<string[]> =>
      (await rows<{ table_name: string }>(pg, "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1")).map((r) => r.table_name);
    // Every table whose row text contains the needle: the scan covers every column of every table.
    const tablesHolding = async (needle: string): Promise<string[]> => {
      const found: string[] = [];
      for (const table of await publicTables()) {
        const hit = await rows<{ n: number }>(pg, `SELECT count(*)::int AS n FROM "${table}" t WHERE position('${needle}' in t::text) > 0`);
        if (Number(hit[0]?.n) > 0) found.push(table);
      }
      return found;
    };
    const secretsOf = async (versionIds: string[]): Promise<string[]> => {
      const out: string[] = [];
      for (const id of versionIds) {
        const [r] = await rows<{ c: string; i: string; t: string }>(pg, `SELECT key_ciphertext_base64 AS c, key_iv_base64 AS i, key_auth_tag_base64 AS t FROM tls_certificate_versions WHERE id = '${id}'`);
        if (r) out.push(r.c, r.i, r.t);
      }
      return out;
    };

    it("before the delete exactly one table holds the ciphertext and none holds the plaintext key; after it, none holds anything of it", async () => {
      const first = await importCert("oA");
      const second = await addVersion(first.certificateId);
      const keep = await importCert("oA");
      const needles = await secretsOf([first.versionId, second.versionId]);
      expect(needles).toHaveLength(6);
      for (const needle of needles) expect(await tablesHolding(needle)).toEqual(["tls_certificate_versions"]);
      expect(await tablesHolding("ADVERSARIAL-KEY-MATERIAL")).toEqual([]);
      expect(await tablesHolding("PRIVATE KEY")).toEqual([]);

      const removed = await db.transaction(async (tx) => {
        const result = await deleteTlsCertificate(tx, { organizationId: "oA", certificateId: first.certificateId });
        // the audit trail may keep ids and fingerprints, never the envelope (the guard would refuse PEM anyway)
        await appendAuditEvent(tx, { action: "tls.certificate.deleted", targetType: "tls_certificate", targetId: first.certificateId, organizationId: "oA", actorType: "system", details: result });
        return result;
      });
      expect(removed.versionIds).toEqual([first.versionId, second.versionId]);
      for (const needle of needles) expect(await tablesHolding(needle)).toEqual([]);
      // the neighbour certificate keeps its envelope: the delete is not a table-wide wipe
      const neighbour = await secretsOf([keep.versionId]);
      expect(await tablesHolding(neighbour[0] as string)).toEqual(["tls_certificate_versions"]);
    });

    it("a refused delete (certificate in use) rolls back whole: every envelope is still there", async () => {
      const used = await importCert("oA");
      const extra = await addVersion(used.certificateId);
      await pg.exec(`UPDATE domains SET cert_mode = 'manual', manual_certificate_version_id = '${extra.versionId}' WHERE id = 'd2'`);
      const needles = await secretsOf([used.versionId, extra.versionId]);
      await expect(db.transaction((tx) => deleteTlsCertificate(tx, { organizationId: "oA", certificateId: used.certificateId }))).rejects.toMatchObject({ code: "CERTIFICATE_IN_USE" });
      for (const needle of needles) expect(await tablesHolding(needle)).toEqual(["tls_certificate_versions"]);
      expect(await count(pg, "tls_certificate_versions", `certificate_id = '${used.certificateId}'`)).toBe(2);
      await pg.exec("UPDATE domains SET cert_mode = 'acme', manual_certificate_version_id = NULL WHERE id = 'd2'");
    });

    it("deleting the organization cascades the versions away with their ciphertext", async () => {
      await pg.exec("INSERT INTO organizations (id, platform_installation_id, name, slug) VALUES ('oC','pi','c','c')");
      const doomed = await importCert("oC");
      const more = await addVersion(doomed.certificateId, "oC");
      const needles = await secretsOf([doomed.versionId, more.versionId]);
      for (const needle of needles) expect(await tablesHolding(needle)).toEqual(["tls_certificate_versions"]);
      await pg.exec("DELETE FROM organizations WHERE id = 'oC'");
      for (const needle of needles) expect(await tablesHolding(needle)).toEqual([]);
    });

    it("a refused import (duplicate fingerprint) leaves no half-written envelope behind", async () => {
      const dup = next();
      await importCert("oA", { v: dup });
      const before = await count(pg, "tls_certificate_versions");
      await expect(importCert("oA", { v: dup })).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
      expect(await count(pg, "tls_certificate_versions")).toBe(before);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("HCP-SPEC-004 adversarial: request-hash idempotency and PEM guards (TLS-01, TLS-13, BKP-14)", () => {
  let pg: PGlite;
  let db: HostingPanelDatabase;
  let n = 0;

  const PEM_BODY = "MIIBADVERSARIALBODY";
  const deep = (levels: number, leaf: string): Record<string, unknown> =>
    Array.from({ length: levels }, (_, k) => levels - k).reduce<unknown>((inner, level) => ({ [`l${String(level)}`]: inner }), leaf) as Record<string, unknown>;
  const pem = (type: string, eol = "\n", end = true) => `-----BEGIN ${type}-----${eol}${PEM_BODY}${eol}${end ? `-----END ${type}-----${eol}` : ""}`;

  beforeAll(async () => {
    pg = await install();
    await pg.exec(ORG_SEED);
    db = asDb(pg);
  }, 120_000);

  afterAll(async () => {
    await pg.close();
  });

  const op = (extra: Record<string, unknown> = {}) => {
    n += 1;
    return {
      organizationId: "oA",
      kind: "site.tls.apply" as const,
      resourceType: "site" as const,
      resourceId: `site_adv_${String(n)}`,
      ...extra,
    };
  };
  const totals = async () => ({
    operations: await count(pg, "operations"),
    steps: await count(pg, "operation_steps"),
    outbox: await count(pg, "outbox_events"),
    audit: await count(pg, "audit_events"),
  });

  describe("request hash (BKP-14, D9)", () => {
    it("scopes the key to the organization: another organization may reuse key and hash independently", async () => {
      const a = await enqueueOperationTransactional(db, op({ idempotencyKey: "shared-key", requestHash: HASH_A }));
      const b = await enqueueOperationTransactional(db, { ...op({ idempotencyKey: "shared-key", requestHash: HASH_B }), organizationId: "oB" });
      expect(b.idempotentReplay).toBe(false);
      expect(b.operation.id).not.toBe(a.operation.id);
    });

    it("a conflicting replay writes nothing: no operation, no step, no outbox event", async () => {
      const input = op({ idempotencyKey: "conflict-writes-nothing", requestHash: HASH_A, steps: [{ key: "a", label: "A" }] });
      await enqueueOperationTransactional(db, input);
      const before = await totals();
      await expect(enqueueOperationTransactional(db, { ...input, requestHash: HASH_B })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      expect(await totals()).toEqual(before);
    });

    it("the same key with the same hash on another resource or another kind is still a conflict (target mismatch wins)", async () => {
      const input = op({ idempotencyKey: "target-mismatch", requestHash: HASH_A });
      await enqueueOperationTransactional(db, input);
      await expect(enqueueOperationTransactional(db, { ...input, resourceId: "another_site" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      await expect(enqueueOperationTransactional(db, { ...input, kind: "site.backups.create" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    });

    it("a replay is answered before the resource lock: same key/hash replays while its own operation holds the lock", async () => {
      const input = op({ idempotencyKey: "lock-replay", requestHash: HASH_A, lockKey: "adv-lock-1" });
      const first = await enqueueOperationTransactional(db, input);
      const replay = await enqueueOperationTransactional(db, input);
      expect(replay.idempotentReplay).toBe(true);
      expect(replay.operation.id).toBe(first.operation.id);
      // a different hash is IDEMPOTENCY_CONFLICT, not RESOURCE_LOCKED; a brand-new key on the held lock is RESOURCE_LOCKED
      await expect(enqueueOperationTransactional(db, { ...input, requestHash: HASH_B })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      await expect(enqueueOperationTransactional(db, { ...input, idempotencyKey: "lock-new-key" })).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });
    });

    it.each([
      ["upper-case hex", "A".repeat(64)],
      ["63 hex characters", "a".repeat(63)],
      ["65 hex characters", "a".repeat(65)],
      ["non-hex characters", "g".repeat(64)],
      ["a PEM block", "-----BEGIN CERTIFICATE-----"],
    ])("refuses a request hash of %s and leaves no operation or outbox event", async (_label, requestHash) => {
      const before = await totals();
      await expect(enqueueOperationTransactional(db, op({ idempotencyKey: `bad-hash-${String(n)}`, requestHash }))).rejects.toThrow();
      expect(await totals()).toEqual(before);
    });

    it("5 parallel callers with one key and hash create one operation and one outbox event; the rest replay it", async () => {
      const input = op({ idempotencyKey: "parallel-key", requestHash: HASH_A });
      const before = await totals();
      const results = await Promise.all(Array.from({ length: 5 }, () => enqueueOperationTransactional(db, input)));
      expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
      expect(new Set(results.map((r) => r.operation.id)).size).toBe(1);
      const after = await totals();
      expect(after.operations).toBe(before.operations + 1);
      expect(after.outbox).toBe(before.outbox + 1);
    });
  });

  describe("PEM guard on the outbox payload (fail closed) and the audit details (redact, never lose the row) (TLS-01, TLS-13, D15)", () => {
    const PAYLOADS: [string, unknown, string][] = [
      ["a CRLF-terminated certificate", { note: pem("CERTIFICATE", "\r\n") }, "note"],
      ["a PEM with no END line", { note: pem("PRIVATE KEY", "\n", false) }, "note"],
      ["a CRLF PEM with no END line", { note: pem("RSA PRIVATE KEY", "\r\n", false) }, "note"],
      ["a PEM after leading text and whitespace", { note: `  \t\r\nkey follows:\n${pem("EC PRIVATE KEY")}` }, "note"],
      ["a PEM inside a sentence", { note: `see ${pem("CERTIFICATE").replace(/\n/g, " ")} for details` }, "note"],
      ["an encrypted private key", { note: pem("ENCRYPTED PRIVATE KEY") }, "note"],
      ["a PEM in an array", { chain: ["ok", pem("CERTIFICATE")] }, "chain[1]"],
      ["a PEM in an array of arrays", { chain: [["ok"], ["ok", pem("CERTIFICATE")]] }, "chain[1][1]"],
      ["a PEM in an array of objects", { items: [{ a: 1 }, { b: { c: pem("CERTIFICATE") } }] }, "items[1].b.c"],
      ["a PEM twelve levels deep", deep(12, pem("CERTIFICATE")), Array.from({ length: 12 }, (_, k) => `l${String(k + 1)}`).join(".")],
    ];

    it.each(PAYLOADS)("refuses %s in the outbox payload: VALIDATION_ERROR naming the path, never the content, nothing persisted", async (_label, payload, path) => {
      const before = await totals();
      const err = (await enqueueOperationTransactional(db, op({ outboxPayload: payload })).catch((e: unknown) => e)) as Error & { code?: string };
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe("VALIDATION_ERROR");
      expect(err.message).toContain(path);
      expect(err.message).not.toContain(PEM_BODY);
      expect(err.message).not.toContain("-----BEGIN");
      expect(await totals()).toEqual(before);
    });

    it.each(PAYLOADS)("redacts %s in the audit details: the row is still written, with [REDACTED_PEM] and never the content", async (_label, payload) => {
      const before = await totals();
      const event = await appendAuditEvent(db, { action: "adv.pem", targetType: "tls_certificate", actorType: "system", details: payload as Record<string, unknown> });
      expect(event?.details).not.toEqual(payload);
      const stored = JSON.stringify(event?.details);
      expect(stored).toContain("[REDACTED_PEM]");
      expect(stored).not.toContain(PEM_BODY);
      expect(stored).not.toContain("-----BEGIN");
      const [row] = (await pg.query<{ details: unknown }>("SELECT details FROM audit_events WHERE id = $1", [event?.id])).rows;
      expect(JSON.stringify(row?.details)).toBe(stored);
      expect(await totals()).toEqual({ ...before, audit: before.audit + 1 });
    });

    it("keeps every non-PEM value next to a redacted one", async () => {
      const event = await appendAuditEvent(db, {
        action: "adv.pem.mixed",
        targetType: "tls_certificate",
        actorType: "system",
        details: { ok: "fine", n: 3, flag: false, none: null, list: ["a", pem("CERTIFICATE"), { k: "v" }], nested: { deep: pem("PRIVATE KEY"), keep: "x" } },
      });
      expect(event?.details).toEqual({
        ok: "fine",
        n: 3,
        flag: false,
        none: null,
        list: ["a", "[REDACTED_PEM]", { k: "v" }],
        nested: { deep: "[REDACTED_PEM]", keep: "x" },
      });
    });

    it("a request id that carries a PEM marker (X-Request-ID: -----BEGIN) loses the marker, not the audit row", async () => {
      const before = await totals();
      const event = await appendAuditEvent(db, {
        action: "account.password.change",
        targetType: "user",
        details: { requestId: "-----BEGIN", outcome: "ok" },
      });
      expect(event?.details).toEqual({ requestId: "[REDACTED_PEM]", outcome: "ok" });
      expect(await totals()).toEqual({ ...before, audit: before.audit + 1 });
    });

    it("a PEM in the audit details does not abort the caller's transaction: the business change and both audits commit together", async () => {
      const before = await totals();
      await db.transaction(async (tx) => {
        await appendAuditEvent(tx, { action: "adv.ok", targetType: "tls_certificate", actorType: "system", details: { fine: true } });
        await appendAuditEvent(tx, { action: "adv.pem", targetType: "tls_certificate", actorType: "system", details: { nested: [pem("CERTIFICATE")] } });
      });
      expect(await totals()).toEqual({ ...before, audit: before.audit + 2 });
    });

    it("details nobody can serialise (circular, BigInt, a throwing toJSON) and PEM-bearing keys or lines abort nothing: every audit commits, none keeps the PEM", async () => {
      const circular: Record<string, unknown> = { note: pem("CERTIFICATE") };
      circular.self = circular;
      const hostile = [circular, { big: 1n, note: pem("CERTIFICATE") }, { bad: { toJSON: () => { throw new Error(pem("CERTIFICATE")); } } }, { [pem("PRIVATE KEY")]: "v" }, { lines: pem("PRIVATE KEY").split("\n") }];
      const before = await totals();
      await db.transaction(async (tx) => {
        for (const details of hostile) await appendAuditEvent(tx, { action: "adv.hostile", targetType: "tls_certificate", actorType: "system", details });
      });
      expect(await totals()).toEqual({ ...before, audit: before.audit + hostile.length });
      const stored = (await pg.query<{ details: unknown }>("SELECT details FROM audit_events WHERE action = 'adv.hostile'")).rows;
      expect(JSON.stringify(stored)).not.toContain(PEM_BODY);
      expect(JSON.stringify(stored)).not.toContain("-----BEGIN");
    });

    it("lets through what is not PEM: fingerprints, ids, prose that names a certificate, a truncated marker", async () => {
      const harmless = {
        fingerprintSha256: "f".repeat(64),
        versionId: "ctv_1",
        subject: "CN=BEGIN CERTIFICATE",
        note: "----BEGIN CERTIFICATE---- is only four dashes",
        list: [["a"], [{ b: "-----END CERTIFICATE-----" }]],
      };
      const event = await appendAuditEvent(db, { action: "adv.fine", targetType: "tls_certificate", actorType: "system", details: harmless });
      expect(event?.details).toEqual(harmless);
      await expect(enqueueOperationTransactional(db, op({ outboxPayload: harmless }))).resolves.toMatchObject({ idempotentReplay: false });
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("HCP-SPEC-004 adversarial: backup target constraints and copies (BKP-01, BKP-07, BKP-08, BKP-15)", () => {
  let pg: PGlite;

  beforeAll(async () => {
    pg = await install();
    await pg.exec(ORG_SEED);
  }, 120_000);

  afterAll(async () => {
    await pg.close();
  });

  it("a local target cannot be the legacy settings target, and the legacy target cannot carry a location", async () => {
    await refuses(pg, "INSERT INTO backup_targets (id, kind, name, legacy_settings) VALUES ('bkt_ll','local','L',TRUE)", /ck_backup_targets_legacy|uq_backup_targets_one_legacy|ck_backup_targets_secret/);
    await refuses(pg, `INSERT INTO backup_targets (id, kind, name, legacy_settings, local_root) VALUES ('bkt_ll','s3','S',TRUE,'/var/x')`, /ck_backup_targets_local_only|ck_backup_targets_legacy/);
  });

  it("only one LIVE local target exists at a time: archive frees the slot, un-archiving the old one while a new one is live is refused", async () => {
    await pg.exec("INSERT INTO backup_targets (id, kind, name) VALUES ('bkt_old','local','old')");
    await pg.exec("UPDATE backup_targets SET archived_at = NOW(), enabled = FALSE WHERE id = 'bkt_old'");
    await pg.exec("INSERT INTO backup_targets (id, kind, name) VALUES ('bkt_new','local','new')");
    await refuses(pg, "UPDATE backup_targets SET archived_at = NULL, enabled = TRUE WHERE id = 'bkt_old'", "uq_backup_targets_one_local");
    // any number of archived locals may coexist
    await pg.exec(`INSERT INTO backup_targets (id, kind, name, enabled, archived_at) VALUES ('bkt_old2','local','old2',FALSE,NOW()),('bkt_old3','local','old3',FALSE,NOW())`);
    await pg.exec("DELETE FROM backup_targets WHERE id IN ('bkt_old','bkt_old2','bkt_old3','bkt_new')");
  });

  it("two live S3 targets differing only in prefix or bucket are distinct locations; endpoint, bucket and prefix together are the key", async () => {
    await pg.exec(s3Target("bkt_p1", `"p1"`));
    await pg.exec(s3Target("bkt_p2", `"p2"`));
    await refuses(pg, s3Target("bkt_p3", `"p1"`), "uq_backup_targets_s3_location");
    // an unrelated key cannot make the location look different: the config CHECK refuses any key beyond the five
    await refuses(pg, s3Target("bkt_p4", `"p1"`, `,"note":"differs only in an unrelated key"`), "ck_backup_targets_config");
    await pg.exec("DELETE FROM backup_targets WHERE id IN ('bkt_p1','bkt_p2')");
  });

  // Fixed in 0022: the config CHECK requires JSON strings and the unique index is built on the normalised location key.
  it("a JSON-null prefix, bucket or endpoint cannot be used to put two live S3 targets on one restic location", async () => {
    for (const id of ["bkt_n1", "bkt_n2"]) await refuses(pg, s3Target(id, "null"), "ck_backup_targets_config");
    await refuses(pg, s3Target("bkt_n3", `"p"`).replace('"bucket":"b"', '"bucket":null'), "ck_backup_targets_config");
    await refuses(pg, s3Target("bkt_n4", `"p"`).replace('"endpoint":"https://e"', '"endpoint":null'), "ck_backup_targets_config");
  });

  it("endpoint spelling (case, default port) and prefix slashes cannot split one restic location in two", async () => {
    await pg.exec(s3Target("bkt_e1", `"x/y"`));
    await refuses(pg, s3Target("bkt_e2", `"/x//y/"`), "uq_backup_targets_s3_location");
    await refuses(pg, s3Target("bkt_e3", `"x/y"`).replace("https://e", "HTTPS://E:443"), "uq_backup_targets_s3_location");
    await pg.exec("DELETE FROM backup_targets WHERE id = 'bkt_e1'");
  });

  it("copy statuses are the five copy states: the aggregate 'partial' belongs to the logical backup only", async () => {
    await pg.exec(`INSERT INTO backup_targets (id, kind, name) VALUES ('bkt_c','local','C');
      INSERT INTO site_backups (id, site_id, kind, status, operation_id) VALUES ('bk_p','s1','manual','running','op_p1')`);
    await refuses(pg, "INSERT INTO site_backup_copies (id, backup_id, target_id, status) VALUES ('bcp_p','bk_p','bkt_c','partial')", "site_backup_copies_status_check");
    await refuses(pg, "INSERT INTO site_backup_copies (id, backup_id, target_id, status) VALUES ('bcp_p','bk_p','bkt_c','')", "site_backup_copies_status_check");
    for (const status of ["running", "failed", "missing", "unknown"]) {
      await pg.exec(`INSERT INTO site_backup_copies (id, backup_id, target_id, status) VALUES ('bcp_${status}','bk_p','bkt_c','${status}')`);
      await pg.exec(`DELETE FROM site_backup_copies WHERE id = 'bcp_${status}'`);
    }
    await pg.exec("UPDATE site_backups SET status = 'partial' WHERE id = 'bk_p'");
    await refuses(pg, "UPDATE site_backups SET status = 'PARTIAL' WHERE id = 'bk_p'", "site_backups_status_check");
  });

  it("BKP-07/08 a logical backup holds at most two copies: a third is refused by priority, and one copy per target", async () => {
    await pg.exec(`INSERT INTO backup_targets (id, kind, name, config_json, s3_location_key, s3_secret_ciphertext_base64, s3_secret_iv_base64, s3_secret_auth_tag_base64, s3_secret_key_version)
        VALUES ('bkt_c2','s3','S','{"endpoint":"https://e","region":"r","bucket":"c2","prefix":"p","accessKeyId":"A"}','https://e/c2/p','c','i','t','v1'),
               ('bkt_c3','s3','S','{"endpoint":"https://e","region":"r","bucket":"c3","prefix":"p","accessKeyId":"A"}','https://e/c3/p','c','i','t','v1');
      INSERT INTO site_backup_copies (id, backup_id, target_id, priority, status) VALUES ('bcp_a','bk_p','bkt_c',1,'failed'),('bcp_b','bk_p','bkt_c2',2,'failed')`);
    await refuses(pg, "INSERT INTO site_backup_copies (id, backup_id, target_id, priority, status) VALUES ('bcp_c','bk_p','bkt_c3',3,'failed')", "site_backup_copies_priority_check");
    await refuses(pg, "INSERT INTO site_backup_copies (id, backup_id, target_id, priority, status) VALUES ('bcp_c','bk_p','bkt_c3',1,'failed')", "uq_site_backup_copies_backup_priority");
    await refuses(pg, "UPDATE site_backup_copies SET priority = 1 WHERE id = 'bcp_b'", "uq_site_backup_copies_backup_priority");
  });

  it("BKP-08 a copy cannot be marked succeeded without a snapshot by UPDATE either, and a failed copy keeps its snapshot id", async () => {
    await refuses(pg, "UPDATE site_backup_copies SET status = 'succeeded' WHERE id = 'bcp_a'", "ck_site_backup_copies_snapshot");
    await pg.exec(`UPDATE site_backup_copies SET status = 'succeeded', snapshot_id = '${"e".repeat(64)}', size_bytes = 0 WHERE id = 'bcp_a'`);
    await refuses(pg, "UPDATE site_backup_copies SET snapshot_id = NULL WHERE id = 'bcp_a'", "ck_site_backup_copies_snapshot");
    await refuses(pg, "UPDATE site_backup_copies SET size_bytes = -1 WHERE id = 'bcp_a'", "site_backup_copies_size_bytes_check");
  });

  it("copy cascade: deleting the logical backup removes every copy; the targets survive; deleting a still-referenced target is refused", async () => {
    await refuses(pg, "DELETE FROM backup_targets WHERE id = 'bkt_c2'", "site_backup_copies_target_id_fkey");
    await pg.exec("DELETE FROM site_backups WHERE id = 'bk_p'");
    expect(await count(pg, "site_backup_copies", "backup_id = 'bk_p'")).toBe(0);
    expect(await count(pg, "backup_targets", "id IN ('bkt_c','bkt_c2','bkt_c3')")).toBe(3);
    await pg.exec("DELETE FROM backup_targets WHERE id IN ('bkt_c','bkt_c2','bkt_c3')");
  });

  it("copy cascade: the organization's operations take their panel copies with them; targets and other organizations' copies stay", async () => {
    await pg.exec(`INSERT INTO backup_targets (id, kind, name) VALUES ('bkt_pc','local','PC');
      INSERT INTO operations (id, organization_id, kind, resource_type, resource_id) VALUES
        ('op_pa','oA','panel.backups.create','site','x'),('op_pb','oB','panel.backups.create','site','x');
      INSERT INTO panel_backup_copies (id, operation_id, target_id, status) VALUES ('pbc_a','op_pa','bkt_pc','running'),('pbc_b','op_pb','bkt_pc','running')`);
    await pg.exec("DELETE FROM organizations WHERE id = 'oA'");
    expect(await count(pg, "panel_backup_copies", "id = 'pbc_a'")).toBe(0);
    expect(await count(pg, "panel_backup_copies", "id = 'pbc_b'")).toBe(1);
    expect(await count(pg, "backup_targets", "id = 'bkt_pc'")).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("HCP-SPEC-004 adversarial: 0022 backfill on odd legacy data (BKP-01, BKP-03, BKP-18)", () => {
  const SNAP = (s: string) => `md5('${s}') || md5('${s}x')`;
  const SETTINGS = `INSERT INTO backup_settings (id, endpoint, region, bucket, prefix, access_key_id, secret_access_key_ciphertext_base64,
      secret_access_key_iv_base64, secret_access_key_auth_tag_base64, schedule_hour_utc, retention_days, last_nightly_run_on)
    VALUES ('default','https://s3.example','eu','bkt','p','AK','c','i','t',6,30,'2026-11-18')`;

  describe("many sites and every shape of legacy row", () => {
    let pg: PGlite;
    beforeAll(async () => {
      pg = await install(M0022);
      await pg.exec(ORG_SEED);
      await pg.exec(SETTINGS);
      // 250 sites x 6 backups: succeeded+snapshot, failed (no snapshot), failed+snapshot, running, succeeded with no
      // operation id, succeeded with NO snapshot (odd). Site rows are not required: site_backups has no FK to sites.
      await pg.exec(`INSERT INTO site_backups (id, site_id, kind, status, operation_id, snapshot_id, size_bytes, problem, started_at, finished_at)
        SELECT 'bk_' || s || '_' || k, 'site_' || s, CASE WHEN k % 2 = 0 THEN 'nightly' ELSE 'manual' END,
          (ARRAY['succeeded','failed','failed','running','succeeded','succeeded'])[k],
          CASE WHEN k = 5 THEN NULL ELSE 'op_' || s || '_' || k END,
          CASE k WHEN 1 THEN ${SNAP("a")} || s::text WHEN 3 THEN ${SNAP("c")} || s::text WHEN 5 THEN ${SNAP("e")} || s::text ELSE NULL END,
          CASE WHEN k IN (1, 3, 5) THEN 9223372036854775807 - s ELSE NULL END,
          CASE WHEN k = 3 THEN 'interrupted' ELSE NULL END,
          TIMESTAMPTZ '2026-10-01 02:00:00+00' + (s || ' minutes')::interval,
          CASE WHEN k = 4 THEN NULL ELSE TIMESTAMPTZ '2026-10-01 02:05:00+00' + (s || ' minutes')::interval END
        FROM generate_series(1, 250) s, generate_series(1, 6) k`);
      await pg.exec(read(M0022));
    }, 180_000);
    afterAll(async () => {
      await pg.close();
    });

    it("BKP-01 writes one copy per backup that has a snapshot or is running, none for the others, with the snapshot, status, job and times of the source", async () => {
      expect(await count(pg, "site_backups")).toBe(1500);
      expect(await count(pg, "site_backup_copies")).toBe(250 * 4);
      expect(await count(pg, "site_backup_copies", `target_id <> '${LEGACY}' OR priority <> 1 OR required IS NOT TRUE`)).toBe(0);
      // no copy for the failed row without a snapshot nor for the odd succeeded row without one
      expect(await count(pg, "site_backup_copies", "backup_id LIKE '%\\_2' OR backup_id LIKE '%\\_6'")).toBe(0);
      const mismatches = await rows<{ n: number }>(
        pg,
        `SELECT count(*)::int AS n FROM site_backup_copies c JOIN site_backups b ON b.id = c.backup_id
         WHERE c.status IS DISTINCT FROM b.status OR c.snapshot_id IS DISTINCT FROM b.snapshot_id OR c.job_id IS DISTINCT FROM b.operation_id
            OR c.size_bytes IS DISTINCT FROM b.size_bytes OR c.problem IS DISTINCT FROM b.problem
            OR c.started_at IS DISTINCT FROM b.started_at OR c.finished_at IS DISTINCT FROM b.finished_at`,
      );
      expect(mismatches[0]?.n).toBe(0);
    });

    it("BKP-03 gives the copies the deterministic ids the boot repair also computes, and a second run changes nothing", async () => {
      const wrongIds = await rows<{ n: number }>(pg, `SELECT count(*)::int AS n FROM site_backup_copies WHERE id <> 'bcp_' || md5(backup_id || ':' || target_id)`);
      expect(wrongIds[0]?.n).toBe(0);
      const before = await rows(pg, "SELECT id FROM site_backup_copies ORDER BY id");
      await pg.exec(read(M0022));
      expect(await rows(pg, "SELECT id FROM site_backup_copies ORDER BY id")).toEqual(before);
      expect(await count(pg, "backup_targets")).toBe(1);
    });

    it("BKP-03 a legacy backup with a null job id and one with a null snapshot never collide on the unique job index", async () => {
      expect(await count(pg, "site_backup_copies", "job_id IS NULL")).toBe(250);
      expect(await count(pg, "site_backup_copies", "status = 'running' AND snapshot_id IS NULL")).toBe(250);
    });
  });

  describe("an install that has backups but no S3 settings row", () => {
    let pg: PGlite;
    beforeAll(async () => {
      pg = await install(M0022);
      await pg.exec(ORG_SEED);
      await pg.exec(`INSERT INTO site_backups (id, site_id, kind, status, operation_id, snapshot_id) VALUES
        ('bk_1','s1','manual','succeeded','op_1','${"1".repeat(64)}'),('bk_2','s1','manual','running','op_2',NULL),('bk_3','s2','manual','failed','op_3',NULL)`);
      await pg.exec(read(M0022));
    }, 120_000);
    afterAll(async () => {
      await pg.close();
    });

    it("BKP-02 creates no legacy target and no copy, but both policies with the defaults and no target", async () => {
      expect(await count(pg, "backup_targets")).toBe(0);
      expect(await count(pg, "site_backup_copies")).toBe(0);
      expect(await rows(pg, "SELECT scope, schedule_hour_utc, retention_days FROM backup_policies ORDER BY scope")).toEqual([
        { scope: "default_site", schedule_hour_utc: 2, retention_days: 14 },
        { scope: "panel", schedule_hour_utc: null, retention_days: 14 },
      ]);
      expect(await count(pg, "backup_policy_targets")).toBe(0);
    });

    it("BKP-18 when the settings reappear (old release), the boot repair attaches the legacy target and gives the rows their copies once", async () => {
      await pg.exec(SETTINGS);
      expect(await repairLegacyBackupCopies(asDb(pg))).toBe(2); // the succeeded and the running row; the failed row has no snapshot
      expect(await rows(pg, "SELECT backup_id, status, snapshot_id, job_id FROM site_backup_copies ORDER BY backup_id")).toEqual([
        { backup_id: "bk_1", status: "succeeded", snapshot_id: "1".repeat(64), job_id: "op_1" },
        { backup_id: "bk_2", status: "running", snapshot_id: null, job_id: "op_2" },
      ]);
      expect(await rows(pg, `SELECT policy_id FROM backup_policy_targets WHERE target_id = '${LEGACY}' ORDER BY policy_id`)).toHaveLength(2);
      expect(await repairLegacyBackupCopies(asDb(pg))).toBe(0);
      expect(await count(pg, "site_backup_copies")).toBe(2);
    });
  });

  describe("re-running 0022 after the new release ran and an older release inserted rows", () => {
    let pg: PGlite;
    let targetsBefore = "";
    beforeAll(async () => {
      pg = await install(M0022);
      await pg.exec(ORG_SEED);
      await pg.exec(SETTINGS);
      await pg.exec(`INSERT INTO site_backups (id, site_id, kind, status, operation_id, snapshot_id) VALUES ('bk_old','s1','manual','succeeded','op_old','${"a".repeat(64)}')`);
      await pg.exec(read(M0022));
      // the new release is used: an admin edits the policies and adds a local target; a partial backup exists
      await pg.exec(`
        UPDATE backup_policies SET schedule_hour_utc = 9, retention_days = 45, last_nightly_run_on = '2026-11-25' WHERE scope = 'default_site';
        UPDATE backup_policies SET retention_days = 90 WHERE scope = 'panel';
        INSERT INTO backup_targets (id, kind, name) VALUES ('bkt_local','local','Local');
        INSERT INTO backup_policy_targets (policy_id, target_id, priority) SELECT id, 'bkt_local', 2 FROM backup_policies WHERE scope = 'default_site';
        INSERT INTO site_backups (id, site_id, kind, status, operation_id, snapshot_id) VALUES ('bk_new','s1','manual','partial','op_new','${"b".repeat(64)}');
        INSERT INTO site_backup_copies (id, backup_id, target_id, priority, status, snapshot_id) VALUES ('bcp_new','bk_new','bkt_local',1,'succeeded','${"b".repeat(64)}')`);
      targetsBefore = JSON.stringify(await rows(pg, "SELECT * FROM backup_targets ORDER BY id"));
      // rollback to an older release: it rotates the S3 settings and writes rows with no copies, some odd
      await pg.exec(`
        UPDATE backup_settings SET bucket = 'rotated-bucket', schedule_hour_utc = 1;
        INSERT INTO site_backups (id, site_id, kind, status, operation_id, snapshot_id) VALUES
          ('bk_rb1','s1','nightly','succeeded','op_rb1','${"c".repeat(64)}'),('bk_rb2','s2','manual','running','op_rb2',NULL),
          ('bk_rb3','s2','manual','failed','op_rb3',NULL),('bk_rb4','s2','manual','failed','op_rb4','${"d".repeat(64)}')`);
      await pg.exec(read(M0022));
    }, 180_000);
    afterAll(async () => {
      await pg.close();
    });

    it("BKP-18 gives exactly the copy-less legacy rows their copy and leaves the new release's rows alone", async () => {
      expect(await rows(pg, "SELECT backup_id, target_id, status FROM site_backup_copies ORDER BY backup_id")).toEqual([
        { backup_id: "bk_new", target_id: "bkt_local", status: "succeeded" },
        { backup_id: "bk_old", target_id: LEGACY, status: "succeeded" },
        { backup_id: "bk_rb1", target_id: LEGACY, status: "succeeded" },
        { backup_id: "bk_rb2", target_id: LEGACY, status: "running" },
        { backup_id: "bk_rb4", target_id: LEGACY, status: "failed" },
      ]);
    });

    it("BKP-18 keeps the partial aggregate status through the constraint re-creation", async () => {
      expect(await rows(pg, "SELECT status FROM site_backups WHERE id = 'bk_new'")).toEqual([{ status: "partial" }]);
    });

    it("BKP-18 does not reset what the admin changed: policy hour, retention, nightly state, policy targets and the local target", async () => {
      expect(await rows(pg, "SELECT scope, schedule_hour_utc, retention_days, last_nightly_run_on::text AS ran FROM backup_policies ORDER BY scope")).toEqual([
        { scope: "default_site", schedule_hour_utc: 9, retention_days: 45, ran: "2026-11-25" },
        { scope: "panel", schedule_hour_utc: null, retention_days: 90, ran: null },
      ]);
      expect(await rows(pg, "SELECT target_id, priority FROM backup_policy_targets WHERE policy_id LIKE 'bpl_%' ORDER BY policy_id, priority")).toEqual(
        expect.arrayContaining([{ target_id: "bkt_local", priority: 2 }]),
      );
      // The older release's rotation moved the settings' location; the database moved the legacy key with it (0022
      // trigger). Nothing else in either target changed.
      const expected = (JSON.parse(targetsBefore) as Array<Record<string, unknown>>).map((t) =>
        t.id === LEGACY ? { ...t, s3_location_key: "https://s3.example/rotated-bucket/p" } : t,
      );
      expect(JSON.stringify(await rows(pg, "SELECT * FROM backup_targets ORDER BY id"))).toBe(JSON.stringify(expected));
    });

    it("BKP-03 the legacy target stays a pointer: rotating the settings does not change its row, and no secret is copied into it", async () => {
      const [legacy] = await rows<Record<string, unknown>>(pg, `SELECT * FROM backup_targets WHERE id = '${LEGACY}'`);
      expect(legacy).toMatchObject({ legacy_settings: true, config_json: {}, s3_secret_ciphertext_base64: null, s3_secret_iv_base64: null, s3_secret_auth_tag_base64: null });
      expect(await rows(pg, "SELECT bucket FROM backup_settings")).toEqual([{ bucket: "rotated-bucket" }]);
    });
  });
});
