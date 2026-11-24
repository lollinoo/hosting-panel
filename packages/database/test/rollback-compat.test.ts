import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LEGACY_BACKUP_COPIES_BACKFILL_SQL, resolveMigrationsDirectory } from "../src/index.js";

// HCP-SPEC-004 rollback compatibility (BKP-18, BKP-01): after 0021/0022 the previous release (0020-era code) must keep
// running on the migrated schema, and what it writes in the meantime must be repairable by the boot repair.
const dir = resolveMigrationsDirectory();
const M0021 = "0021_manual_tls_certificates.sql";
const M0022 = "0022_backup_targets_and_copies.sql";
const files = readdirSync(dir)
  .filter((file) => file.endsWith(".sql"))
  .sort();
const read = (file: string) => readFileSync(path.join(dir, file), "utf8");
const LEGACY_TARGET = "bkt_8c7b230a58dbf28ec9cb5c8b6ef3273e";
const SNAP_OLD = "a".repeat(64);
const SNAP_NEW = "b".repeat(64);
const SNAP_RUN = "d".repeat(64);

async function migrateTo(pg: PGlite, until: string): Promise<void> {
  for (const file of files) {
    if (file >= until) break;
    await pg.exec(read(file));
  }
}

async function rows<T = Record<string, unknown>>(pg: PGlite, query: string): Promise<T[]> {
  return (await pg.query<T>(query)).rows;
}

// A 0020-era install: S3 configured, one organization with two sites, a few backups made by the previous release.
const SEED_0020 = `
  INSERT INTO platform_installations (id, name) VALUES ('pi','pi');
  INSERT INTO hosts (id, platform_installation_id, name, hostname, ipv4_address, total_cpu_milli, total_memory_bytes, total_storage_bytes)
    VALUES ('h','pi','h','h.example','192.0.2.1',1000,'1','1');
  INSERT INTO organizations (id, platform_installation_id, name, slug) VALUES ('o','pi','o','o');
  INSERT INTO host_allocations (id, host_id, organization_id) VALUES ('a','h','o');
  INSERT INTO sites (id, organization_id, host_allocation_id, name, slug) VALUES ('s1','o','a','s1','s1'),('s2','o','a','s2','s2');
  INSERT INTO domains (id, site_id, organization_id, hostname) VALUES ('d_old','s1','o','old.example');
  INSERT INTO backup_settings (id, endpoint, region, bucket, prefix, access_key_id, secret_access_key_ciphertext_base64,
    secret_access_key_iv_base64, secret_access_key_auth_tag_base64, schedule_hour_utc, retention_days)
  VALUES ('default','https://s3.example','eu','bkt','p','AK','c','i','t',4,21);
  INSERT INTO site_backups (id, site_id, kind, status, operation_id, snapshot_id, size_bytes, started_at, finished_at)
  VALUES ('bkp_old','s1','nightly','succeeded','op_old','${SNAP_OLD}',10,'2026-11-01T02:00:00Z','2026-11-01T02:05:00Z');`;

// The statements the previous release runs against the migrated schema: none of them names a column added by 0021/0022.
const OLD_RELEASE_WRITES = `
  INSERT INTO domains (id, site_id, organization_id, hostname) VALUES ('d_rb','s1','o','rb.example');
  INSERT INTO operations (id, organization_id, kind, resource_type, resource_id)
    VALUES ('op_rb','o','site.backups.create','site','s1');
  INSERT INTO site_backups (id, site_id, kind, status, operation_id, snapshot_id, size_bytes, started_at, finished_at)
    VALUES ('bkp_rb_ok','s1','manual','succeeded','op_rb_ok','${SNAP_NEW}',20,'2026-11-10T02:00:00Z','2026-11-10T02:05:00Z');
  INSERT INTO site_backups (id, site_id, kind, status, operation_id, started_at)
    VALUES ('bkp_rb_run','s2','manual','running','op_rb_run','2026-11-11T02:00:00Z');
  UPDATE site_backups SET status = 'succeeded', snapshot_id = '${SNAP_RUN}', size_bytes = 30, finished_at = '2026-11-11T02:09:00Z'
    WHERE id = 'bkp_rb_run';
  INSERT INTO site_backups (id, site_id, kind, status, problem, started_at, finished_at)
    VALUES ('bkp_rb_fail','s2','nightly','failed','unreachable','2026-11-12T02:00:00Z','2026-11-12T02:01:00Z');`;

describe("HCP-SPEC-004 rollback compatibility: 0021/0022 are additive for the previous release", () => {
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
  let colsBefore: Column[] = [];
  let colsAfter: Column[] = [];
  let consBefore: Named[] = [];
  let consAfter: Named[] = [];
  let idxBefore: Named[] = [];
  let idxAfter: Named[] = [];

  beforeAll(async () => {
    pg = new PGlite();
    await migrateTo(pg, M0021);
    colsBefore = await rows<Column>(pg, COLUMNS);
    consBefore = await rows<Named>(pg, CONSTRAINTS);
    idxBefore = await rows<Named>(pg, INDEXES);
    await pg.exec(SEED_0020);
    await pg.exec(read(M0021));
    await pg.exec(read(M0022));
    colsAfter = await rows<Column>(pg, COLUMNS);
    consAfter = await rows<Named>(pg, CONSTRAINTS);
    idxAfter = await rows<Named>(pg, INDEXES);
  }, 120_000);

  afterAll(async () => {
    await pg.close();
  });

  const key = (c: Column) => `${c.table_name}.${c.column_name}`;

  describe("schema diff against the 0020 schema", () => {
    it("sees the 0020 schema as the baseline (the diff below is not vacuous)", () => {
      expect(colsBefore.length).toBeGreaterThan(100);
      expect(colsBefore.some((c) => c.table_name === "domains" && c.column_name === "cert_challenge")).toBe(true);
      expect(colsBefore.some((c) => c.table_name === "tls_certificates" || c.table_name === "backup_targets")).toBe(false);
      expect(colsAfter.some((c) => c.table_name === "tls_certificates")).toBe(true);
    });

    it("drops, renames, retypes, tightens or re-defaults no pre-existing column", () => {
      const after = new Map(colsAfter.map((c) => [key(c), c]));
      for (const before of colsBefore) {
        // toEqual on the whole descriptor: a missing column, another type/length, NOT NULL added, or a changed default all fail.
        expect(after.get(key(before)), `column ${key(before)} changed or disappeared`).toEqual(before);
      }
    });

    it("adds to pre-existing tables only the five known columns, each nullable or defaulted", () => {
      const oldTables = new Set(colsBefore.map((c) => c.table_name));
      const oldKeys = new Set(colsBefore.map(key));
      const added = colsAfter.filter((c) => oldTables.has(c.table_name) && !oldKeys.has(key(c)));
      // Pinned list: a new column on an old table needs a rollback review (nullable or DEFAULT) before it joins this list.
      expect(added.map(key).sort()).toEqual([
        "domains.cert_mode",
        "domains.manual_certificate_version_id",
        "operations.request_hash",
        "site_backups.archive_target_id",
        "site_backups.restore_target_id",
      ]);
      for (const column of added) {
        expect(
          column.is_nullable === "YES" || column.column_default !== null,
          `${key(column)} is NOT NULL without a default: the previous release's INSERT would fail`,
        ).toBe(true);
      }
    });

    it("keeps every pre-existing constraint and index with the same definition, except the widened backup status check", () => {
      const consAfterByName = new Map(consAfter.map((c) => [`${c.tbl}.${c.name}`, c.def]));
      const changed = consBefore.filter((c) => consAfterByName.get(`${c.tbl}.${c.name}`) !== c.def).map((c) => `${c.tbl}.${c.name}`);
      expect(changed).toEqual(["site_backups.site_backups_status_check"]);
      const idxAfterByName = new Map(idxAfter.map((c) => [`${c.tbl}.${c.name}`, c.def]));
      expect(idxBefore.filter((c) => idxAfterByName.get(`${c.tbl}.${c.name}`) !== c.def)).toEqual([]);
    });

    it("widens the backup status check to a strict superset of the old values", async () => {
      expect(consBefore.find((c) => c.name === "site_backups_status_check")?.def).toMatch(/running.*succeeded.*failed/);
      // Every status the previous release writes is still accepted; the new aggregate is only added.
      for (const status of ["running", "succeeded", "failed", "partial"]) {
        await pg.exec(`INSERT INTO site_backups (id, site_id, kind, status) VALUES ('probe_${status}','s1','manual','${status}');
          DELETE FROM site_backups WHERE id = 'probe_${status}'`);
      }
      await expect(pg.exec(`INSERT INTO site_backups (id, site_id, kind, status) VALUES ('probe_x','s1','manual','bogus')`)).rejects.toThrow(
        /site_backups_status_check/,
      );
    });
  });

  describe("0020-era statements on the migrated schema (the previous release keeps running)", () => {
    beforeAll(async () => {
      await pg.exec(OLD_RELEASE_WRITES);
    });

    it("domains inserted without cert_mode are acme with no manual version; operations without request_hash keep it NULL", async () => {
      expect(await rows(pg, "SELECT id, cert_mode, manual_certificate_version_id FROM domains ORDER BY id")).toEqual([
        { id: "d_old", cert_mode: "acme", manual_certificate_version_id: null },
        { id: "d_rb", cert_mode: "acme", manual_certificate_version_id: null },
      ]);
      expect(await rows(pg, "SELECT request_hash FROM operations WHERE id = 'op_rb'")).toEqual([{ request_hash: null }]);
      // The previous release's own domain updates still pass the cert_mode/version pairing check.
      await pg.exec("UPDATE domains SET cert_status = 'active', cert_problem = NULL WHERE id = 'd_rb'");
    });

    it("site_backups written by the previous release (succeeded with a snapshot, running then succeeded) are accepted and get no copy", async () => {
      expect(await rows(pg, "SELECT id, status, snapshot_id, restore_target_id, archive_target_id FROM site_backups WHERE id LIKE 'bkp_rb%' ORDER BY id")).toEqual([
        { id: "bkp_rb_fail", status: "failed", snapshot_id: null, restore_target_id: null, archive_target_id: null },
        { id: "bkp_rb_ok", status: "succeeded", snapshot_id: SNAP_NEW, restore_target_id: null, archive_target_id: null },
        { id: "bkp_rb_run", status: "succeeded", snapshot_id: SNAP_RUN, restore_target_id: null, archive_target_id: null },
      ]);
      expect(await rows(pg, "SELECT backup_id FROM site_backup_copies WHERE backup_id LIKE 'bkp_rb%'")).toEqual([]);
    });

    it("the backup_settings upsert of the previous release still works and leaves a single row", async () => {
      const upsert = (bucket: string, retention: number) => `
        INSERT INTO backup_settings (id, endpoint, region, bucket, prefix, access_key_id, secret_access_key_ciphertext_base64,
          secret_access_key_iv_base64, secret_access_key_auth_tag_base64, schedule_hour_utc, retention_days, updated_at)
        VALUES ('default','https://s3.example','eu','${bucket}','p','AK','c2','i2','t2',5,${retention}, NOW())
        ON CONFLICT (id) DO UPDATE SET bucket = EXCLUDED.bucket, retention_days = EXCLUDED.retention_days,
          schedule_hour_utc = EXCLUDED.schedule_hour_utc, secret_access_key_ciphertext_base64 = EXCLUDED.secret_access_key_ciphertext_base64,
          updated_at = EXCLUDED.updated_at`;
      await pg.exec(upsert("bkt2", 30));
      expect(await rows(pg, "SELECT bucket, retention_days, schedule_hour_utc FROM backup_settings")).toEqual([
        { bucket: "bkt2", retention_days: 30, schedule_hour_utc: 5 },
      ]);
      // And the previous release deleting the settings (disconnecting S3) does not trip over the legacy target.
      await pg.exec("DELETE FROM backup_settings WHERE id = 'default'");
      await pg.exec(upsert("bkt2", 30));
      expect(await rows(pg, "SELECT count(*)::int AS n FROM backup_settings")).toEqual([{ n: 1 }]);
    });

    it("DELETE FROM site_backups (single backup and deleteAllSiteBackups) cascades the copies and is never blocked", async () => {
      expect(await rows(pg, "SELECT backup_id FROM site_backup_copies ORDER BY backup_id")).toEqual([{ backup_id: "bkp_old" }]);
      await pg.exec("DELETE FROM site_backups WHERE id = 'bkp_old'");
      expect(await rows(pg, "SELECT count(*)::int AS n FROM site_backup_copies")).toEqual([{ n: 0 }]);
      await pg.exec("DELETE FROM site_backups WHERE site_id = 's2'");
      expect(await rows(pg, "SELECT count(*)::int AS n FROM site_backups WHERE site_id = 's2'")).toEqual([{ n: 0 }]);
    });
  });
});

describe("HCP-SPEC-004 rollback compatibility: the boot repair of backups written while rolled back", () => {
  let pg: PGlite;
  const copies = () =>
    rows<{ backup_id: string; target_id: string; priority: number; required: boolean; job_id: string | null; status: string; snapshot_id: string | null; size_bytes: number | null; problem: string | null }>(
      pg,
      "SELECT backup_id, target_id, priority, required, job_id, status, snapshot_id, size_bytes, problem FROM site_backup_copies ORDER BY backup_id",
    );

  beforeAll(async () => {
    pg = new PGlite();
    await migrateTo(pg, M0021);
    await pg.exec(SEED_0020);
    await pg.exec(read(M0021));
    await pg.exec(read(M0022));
    await pg.exec(OLD_RELEASE_WRITES);
  }, 120_000);

  afterAll(async () => {
    await pg.close();
  });

  it("starts with the legacy backup copied by the migration and the rolled-back ones copy-less", async () => {
    expect((await copies()).map((c) => c.backup_id)).toEqual(["bkp_old"]);
  });

  it("LEGACY_BACKUP_COPIES_BACKFILL_SQL gives each copy-less backup with a snapshot exactly one legacy copy, mirroring the row", async () => {
    await pg.exec(LEGACY_BACKUP_COPIES_BACKFILL_SQL);
    const after = await copies();
    expect(after.map((c) => c.backup_id)).toEqual(["bkp_old", "bkp_rb_ok", "bkp_rb_run"]);
    expect(after.find((c) => c.backup_id === "bkp_rb_ok")).toEqual({
      backup_id: "bkp_rb_ok",
      target_id: LEGACY_TARGET,
      priority: 1,
      required: true,
      job_id: "op_rb_ok",
      status: "succeeded",
      snapshot_id: SNAP_NEW,
      size_bytes: 20,
      problem: null,
    });
    // running -> succeeded in place by the previous release: the copy reflects the final state, not the running one.
    expect(after.find((c) => c.backup_id === "bkp_rb_run")).toMatchObject({ status: "succeeded", snapshot_id: SNAP_RUN, size_bytes: 30, job_id: "op_rb_run" });
    // The failed backup never reached the repository: no copy. Every copy has the one legacy target.
    expect(after.some((c) => c.backup_id === "bkp_rb_fail")).toBe(false);
    expect(new Set(after.map((c) => c.target_id))).toEqual(new Set([LEGACY_TARGET]));
  });

  it("is idempotent: a second and a third run insert nothing and change nothing", async () => {
    const first = JSON.stringify(await rows(pg, "SELECT * FROM site_backup_copies ORDER BY id"));
    await pg.exec(LEGACY_BACKUP_COPIES_BACKFILL_SQL);
    await pg.exec(LEGACY_BACKUP_COPIES_BACKFILL_SQL);
    expect(JSON.stringify(await rows(pg, "SELECT * FROM site_backup_copies ORDER BY id"))).toBe(first);
    expect(await rows(pg, "SELECT backup_id, count(*)::int AS n FROM site_backup_copies GROUP BY backup_id HAVING count(*) > 1")).toEqual([]);
  });

  it("never gives a second copy to a backup that already has one from another target (new-release rows)", async () => {
    await pg.exec(`INSERT INTO backup_targets (id, kind, name, local_root, initialized_at) VALUES ('bkt_loc','local','L','/var/backups/hp',NOW());
      INSERT INTO site_backups (id, site_id, kind, status, snapshot_id) VALUES ('bkp_new','s1','manual','succeeded','${SNAP_NEW}');
      INSERT INTO site_backup_copies (id, backup_id, target_id, status, snapshot_id) VALUES ('bcp_n','bkp_new','bkt_loc','succeeded','${SNAP_NEW}')`);
    await pg.exec(LEGACY_BACKUP_COPIES_BACKFILL_SQL);
    expect(await rows(pg, "SELECT target_id FROM site_backup_copies WHERE backup_id = 'bkp_new'")).toEqual([{ target_id: "bkt_loc" }]);
  });

  it("re-applying 0021 and 0022 on the state the previous release left (roll-forward) repairs the same copies and changes nothing else", async () => {
    // A second database in the same rolled-back state, migrated forward again instead of repaired at boot.
    const forward = new PGlite();
    try {
      await migrateTo(forward, M0021);
      await forward.exec(SEED_0020);
      await forward.exec(read(M0021));
      await forward.exec(read(M0022));
      await forward.exec(OLD_RELEASE_WRITES);
      await forward.exec(read(M0021));
      await forward.exec(read(M0022));
      expect((await rows<{ backup_id: string }>(forward, "SELECT backup_id FROM site_backup_copies ORDER BY backup_id")).map((c) => c.backup_id)).toEqual([
        "bkp_old",
        "bkp_rb_ok",
        "bkp_rb_run",
      ]);
      expect(await rows(forward, "SELECT count(*)::int AS n FROM backup_targets")).toEqual([{ n: 1 }]);
      // The rolled-back domains and operations stay acme / hash-less across the second migration.
      expect(await rows(forward, "SELECT DISTINCT cert_mode FROM domains")).toEqual([{ cert_mode: "acme" }]);
    } finally {
      await forward.close();
    }
  });
});

describe("HCP-SPEC-004 rollback compatibility: the previous release moves, deletes and re-creates the S3 settings", () => {
  let pg: PGlite;
  const legacy = async () => (await rows<Record<string, unknown>>(pg, `SELECT * FROM backup_targets WHERE legacy_settings`))[0];
  // The statements of the previous release: it knows nothing of backup_targets.
  const settingsRow = (endpoint: string, bucket: string, prefix: string) =>
    `INSERT INTO backup_settings (id, endpoint, region, bucket, prefix, access_key_id, secret_access_key_ciphertext_base64,
       secret_access_key_iv_base64, secret_access_key_auth_tag_base64, schedule_hour_utc, retention_days, updated_at)
     VALUES ('default','${endpoint}','eu','${bucket}','${prefix}','AK','c','i','t',4,21, NOW())
     ON CONFLICT (id) DO UPDATE SET endpoint = EXCLUDED.endpoint, bucket = EXCLUDED.bucket, prefix = EXCLUDED.prefix, updated_at = EXCLUDED.updated_at`;
  const regularTarget = (id: string, endpoint: string, bucket: string, prefix: string) =>
    `INSERT INTO backup_targets (id, kind, name, config_json, s3_location_key, s3_secret_ciphertext_base64, s3_secret_iv_base64,
       s3_secret_auth_tag_base64, s3_secret_key_version)
     SELECT '${id}','s3','S', c.cfg, hp_s3_location_key('${endpoint}','${bucket}','${prefix}'), 'c','i','t','v1'
     FROM (SELECT '{"endpoint":"${endpoint}","region":"r","bucket":"${bucket}","prefix":"${prefix}","accessKeyId":"A"}'::jsonb AS cfg) c`;

  beforeAll(async () => {
    pg = new PGlite();
    await migrateTo(pg, M0021);
    await pg.exec(SEED_0020);
    await pg.exec(read(M0021));
    await pg.exec(read(M0022));
  }, 120_000);

  afterAll(async () => {
    await pg.close();
  });

  it("starts with the legacy target on the location of the settings", async () => {
    expect(await legacy()).toMatchObject({ id: LEGACY_TARGET, archived_at: null, enabled: true, s3_location_key: "https://s3.example/bkt/p" });
  });

  it("moves the legacy key with the settings, so a new target on the new location is refused and the old location is free", async () => {
    await pg.exec(settingsRow("https://s3.example", "bkt2", "p"));
    expect((await legacy())?.s3_location_key).toBe("https://s3.example/bkt2/p");
    await expect(pg.exec(regularTarget("bkt_new", "https://s3.example", "bkt2", "p"))).rejects.toThrow(/uq_backup_targets_s3_location/);
    await pg.exec(regularTarget("bkt_old", "https://s3.example", "bkt", "p"));
    await pg.exec("DELETE FROM backup_targets WHERE id = 'bkt_old'");
  });

  it("fails the previous release's settings write when a live target already holds the location (and changes nothing)", async () => {
    await pg.exec(regularTarget("bkt_taken", "https://s3.taken.example", "taken", "t"));
    await expect(pg.exec(settingsRow("https://s3.taken.example", "taken", "t"))).rejects.toThrow(/uq_backup_targets_s3_location/);
    expect(await rows(pg, "SELECT bucket FROM backup_settings")).toEqual([{ bucket: "bkt2" }]);
    expect((await legacy())?.s3_location_key).toBe("https://s3.example/bkt2/p");
    await pg.exec("DELETE FROM backup_targets WHERE id = 'bkt_taken'");
  });

  it("delete then insert (a clear and a new save): the legacy target stays live, follows the new location, and no second one appears", async () => {
    const copiesBefore = await rows(pg, "SELECT id FROM site_backup_copies ORDER BY id");
    const policyRowsBefore = await rows(pg, "SELECT policy_id, target_id FROM backup_policy_targets ORDER BY policy_id");
    await pg.exec("DELETE FROM backup_settings WHERE id = 'default'");
    // the settings are gone, the target is not: it keeps the location its copies live at (it simply cannot resolve)
    expect(await legacy()).toMatchObject({ archived_at: null, enabled: true, s3_location_key: "https://s3.example/bkt2/p" });
    expect(await rows(pg, "SELECT id FROM site_backup_copies ORDER BY id")).toEqual(copiesBefore);

    await pg.exec(settingsRow("https://s3.reborn.example", "reborn", "r"));
    expect(await legacy()).toMatchObject({ id: LEGACY_TARGET, archived_at: null, enabled: true, s3_location_key: "https://s3.reborn.example/reborn/r" });
    expect(await rows(pg, "SELECT id FROM backup_targets WHERE legacy_settings")).toHaveLength(1);
    expect(await rows(pg, "SELECT policy_id, target_id FROM backup_policy_targets ORDER BY policy_id")).toEqual(policyRowsBefore);
    // the new location is taken, the abandoned one is free
    await expect(pg.exec(regularTarget("bkt_on_reborn", "https://s3.reborn.example", "reborn", "r"))).rejects.toThrow(/uq_backup_targets_s3_location/);
    await pg.exec(regularTarget("bkt_left", "https://s3.example", "bkt2", "p"));
    await pg.exec("DELETE FROM backup_targets WHERE id = 'bkt_left'");
  });

  it("the copy backfill gives the live legacy target a backup written at the new location", async () => {
    await pg.exec(`INSERT INTO site_backups (id, site_id, kind, status, operation_id, snapshot_id, size_bytes, started_at, finished_at)
      VALUES ('bkp_reborn','s1','manual','succeeded','op_reborn','${SNAP_NEW}',20,'2026-11-12T02:00:00Z','2026-11-12T02:05:00Z')`);
    await pg.exec(LEGACY_BACKUP_COPIES_BACKFILL_SQL);
    expect(await rows(pg, "SELECT target_id FROM site_backup_copies WHERE backup_id = 'bkp_reborn'")).toEqual([{ target_id: LEGACY_TARGET }]);
    expect((await legacy())?.archived_at).toBeNull();
  });

  it("a legacy target archived on purpose (the M3 adapter) is given nothing written at another location, and what is written at its own", async () => {
    await pg.exec("UPDATE backup_targets SET archived_at = NOW(), enabled = FALSE, customer_selectable = FALSE WHERE legacy_settings");
    // an archived row is not moved by the settings: they go elsewhere, and a backup is written there
    await pg.exec(settingsRow("https://s3.elsewhere.example", "elsewhere", "e"));
    expect((await legacy())?.s3_location_key).toBe("https://s3.reborn.example/reborn/r");
    await pg.exec(`INSERT INTO site_backups (id, site_id, kind, status, operation_id, snapshot_id)
      VALUES ('bkp_archived_elsewhere','s1','manual','succeeded','op_archived_elsewhere','${SNAP_RUN}')`);
    await pg.exec(LEGACY_BACKUP_COPIES_BACKFILL_SQL);
    expect(await rows(pg, "SELECT 1 FROM site_backup_copies WHERE backup_id = 'bkp_archived_elsewhere'")).toEqual([]);

    await pg.exec(settingsRow("https://s3.reborn.example", "reborn", "r"));
    await pg.exec(LEGACY_BACKUP_COPIES_BACKFILL_SQL);
    // the settings point at the archived target's own location again: its repository is the one the backup went to
    expect(await rows(pg, "SELECT target_id FROM site_backup_copies WHERE backup_id = 'bkp_archived_elsewhere'")).toEqual([{ target_id: LEGACY_TARGET }]);
    expect((await legacy())?.archived_at).not.toBeNull();
    expect((await legacy())?.s3_location_key).toBe("https://s3.reborn.example/reborn/r");
  });

  it("with no settings row at all an archived target gets nothing", async () => {
    await pg.exec("DELETE FROM backup_settings WHERE id = 'default'");
    await pg.exec(`INSERT INTO site_backups (id, site_id, kind, status, operation_id, snapshot_id)
      VALUES ('bkp_nosettings','s1','manual','succeeded','op_nosettings','${SNAP_RUN}')`);
    await pg.exec(LEGACY_BACKUP_COPIES_BACKFILL_SQL);
    expect(await rows(pg, "SELECT 1 FROM site_backup_copies WHERE backup_id = 'bkp_nosettings'")).toEqual([]);
  });
});

describe("0025 app stacks", () => {
  // HCP-SPEC-005: after 0025 the previous release (0024-era code) keeps running on the migrated schema.
  const M0025 = "0025_app_stacks.sql";
  const HASH = "a".repeat(64);
  let pg: PGlite;
  const SEED_0024 = `
    INSERT INTO platform_installations (id, name) VALUES ('pi','pi');
    INSERT INTO hosts (id, platform_installation_id, name, hostname, ipv4_address, total_cpu_milli, total_memory_bytes, total_storage_bytes)
      VALUES ('h','pi','h','h.example','192.0.2.1',1000,'1','1');
    INSERT INTO organizations (id, platform_installation_id, name, slug, max_sites) VALUES ('o','pi','o','o',5);
    INSERT INTO host_allocations (id, host_id, organization_id) VALUES ('a','h','o');
    INSERT INTO sites (id, organization_id, host_allocation_id, name, slug) VALUES ('s1','o','a','s1','s1');
    INSERT INTO domains (id, site_id, organization_id, hostname) VALUES ('d_old','s1','o','old.example');`;
  // A stack written by the new release before the rollback.
  const STACK_ROWS = `
    INSERT INTO app_templates (id, slug, name, category) VALUES ('atpl_a','alpha','Alpha','web');
    INSERT INTO app_template_versions (id, template_id, version_number, source, spec_version, compiled_schema, spec_hash)
      VALUES ('atv_a1','atpl_a',1,'x',1,'{}','${HASH}');
    INSERT INTO app_stacks (id, organization_id, host_allocation_id, template_id, template_version_id, name, status)
      VALUES ('stk_a','o','a','atpl_a','atv_a1','Stack A','running');
    INSERT INTO app_stack_components (stack_id, organization_id, component_key) VALUES ('stk_a','o','web');
    INSERT INTO app_stack_domains (id, stack_id, organization_id, component_key, internal_port, hostname)
      VALUES ('sdom_a','stk_a','o','web',8080,'stack.example');`;
  // The statements the previous release runs: none names a table, column or trigger added by 0025.
  const OLD_RELEASE_WRITES = `
    INSERT INTO organizations (id, platform_installation_id, name, slug, max_sites) VALUES ('o_rb','pi','rb','rb',3);
    UPDATE organizations SET name = 'renamed', max_sites = 4 WHERE id = 'o_rb';
    INSERT INTO sites (id, organization_id, host_allocation_id, name, slug) VALUES ('s_rb','o','a','rb','rb');
    UPDATE sites SET status = 'ready' WHERE id = 's_rb';
    INSERT INTO domains (id, site_id, organization_id, hostname) VALUES ('d_rb','s_rb','o','rb.example');
    UPDATE domains SET status = 'active', hostname = 'rb2.example' WHERE id = 'd_rb';
    INSERT INTO operations (id, organization_id, kind, resource_type, resource_id) VALUES ('op_rb','o','site.create','site','s_rb');
    UPDATE operations SET status = 'succeeded' WHERE id = 'op_rb';
    INSERT INTO outbox_events (id, event_type, aggregate_type, aggregate_id, payload)
      VALUES ('ev_rb','operation.requested','operation','op_rb','{"operationId":"op_rb"}');
    UPDATE outbox_events SET status = 'published', published_at = NOW() WHERE id = 'ev_rb';
    INSERT INTO encrypted_secrets (id, organization_id, site_id, secret_key, ciphertext_base64, iv_base64, auth_tag_base64)
      VALUES ('sec_rb','o','s_rb','db_password','c','i','t');
    UPDATE encrypted_secrets SET version = 2, ciphertext_base64 = 'c2' WHERE id = 'sec_rb';
    DELETE FROM encrypted_secrets WHERE id = 'sec_rb';
    DELETE FROM outbox_events WHERE id = 'ev_rb';
    DELETE FROM operations WHERE id = 'op_rb';
    DELETE FROM domains WHERE id = 'd_rb';
    DELETE FROM sites WHERE id = 's_rb';`;

  beforeAll(async () => {
    pg = new PGlite();
    await migrateTo(pg, M0025);
    await pg.exec(SEED_0024);
    await pg.exec(read(M0025));
    await pg.exec(STACK_ROWS);
  }, 120_000);

  afterAll(async () => {
    await pg.close();
  });

  it("runs the previous release's writes on sites, domains, organizations, operations, outbox and secrets", async () => {
    await pg.exec(OLD_RELEASE_WRITES);
    expect(await rows(pg, "SELECT id, max_sites, max_app_stacks FROM organizations ORDER BY id")).toEqual([
      { id: "o", max_sites: 5, max_app_stacks: null },
      { id: "o_rb", max_sites: 4, max_app_stacks: null },
    ]);
    await pg.exec("DELETE FROM organizations WHERE id = 'o_rb'");
  });

  it("refuses the previous release a site domain that a stack holds with the 23505 its unique index already raises", async () => {
    await expect(pg.exec("INSERT INTO domains (id, site_id, organization_id, hostname) VALUES ('d_taken','s1','o','stack.example')")).rejects.toMatchObject({
      code: "23505",
    });
  });

  it("runs 0025 again on a database with site and stack rows without harm", async () => {
    await pg.exec(read(M0025));
    expect(await rows(pg, "SELECT id, status FROM app_stacks")).toEqual([{ id: "stk_a", status: "running" }]);
    expect(await rows(pg, "SELECT hostname FROM app_stack_domains")).toEqual([{ hostname: "stack.example" }]);
    expect(await rows(pg, "SELECT hostname FROM domains ORDER BY hostname")).toEqual([{ hostname: "old.example" }]);
  });
});

describe("0026 app routing options", () => {
  // ADR-0037: after 0026 the previous release (0025-era code) keeps running on the migrated schema.
  const M0026 = "0026_app_routing_options.sql";
  const HASH = "a".repeat(64);
  const VERIFIER = "$apr1$r31.....$HqJZimcKQFAMYayBlzkrA/";
  let pg: PGlite;
  // A 0025-era install: one application with three web addresses.
  const SEED_0025 = `
    INSERT INTO platform_installations (id, name) VALUES ('pi','pi');
    INSERT INTO hosts (id, platform_installation_id, name, hostname, ipv4_address, total_cpu_milli, total_memory_bytes, total_storage_bytes)
      VALUES ('h','pi','h','h.example','192.0.2.1',1000,'1','1');
    INSERT INTO organizations (id, platform_installation_id, name, slug) VALUES ('o','pi','o','o');
    INSERT INTO host_allocations (id, host_id, organization_id) VALUES ('a','h','o');
    INSERT INTO app_templates (id, slug, name, category) VALUES ('atpl_a','alpha','Alpha','web');
    INSERT INTO app_template_versions (id, template_id, version_number, source, spec_version, compiled_schema, spec_hash)
      VALUES ('atv_a1','atpl_a',1,'x',1,'{}','${HASH}');
    INSERT INTO app_stacks (id, organization_id, host_allocation_id, template_id, template_version_id, name, status)
      VALUES ('stk_a','o','a','atpl_a','atv_a1','Stack A','running'), ('stk_b','o','a','atpl_a','atv_a1','Stack B','running');
    INSERT INTO app_stack_components (stack_id, organization_id, component_key) VALUES ('stk_a','o','web'), ('stk_b','o','web');
    INSERT INTO app_stack_domains (id, stack_id, organization_id, component_key, internal_port, hostname, status, cert_status)
      VALUES ('sdom_main','stk_a','o','web',8080,'main.example','active','active'),
             ('sdom_www','stk_a','o','web',8080,'www.main.example','active','active'),
             ('sdom_old','stk_a','o','web',8080,'old.example','pending','none'),
             ('sdom_b','stk_b','o','web',8080,'b.example','active','active');`;
  // Options written by the new release before the rollback.
  const NEW_RELEASE_OPTIONS = `
    UPDATE app_stack_domains SET compression = TRUE, access_username = 'team', access_password_hash = '${VERIFIER}',
      path_routes = '[{"pathPrefix":"/api","componentKey":"web","port":8080,"stripPrefix":true}]'::jsonb WHERE id = 'sdom_main';
    UPDATE app_stack_domains SET redirect_to_domain_id = 'sdom_main' WHERE id IN ('sdom_www','sdom_old');
    UPDATE app_stack_domains SET redirect_to_domain_id = NULL, compression = TRUE WHERE id = 'sdom_b';`;
  // The statements the previous release runs on addresses: none names a column or a constraint added by 0026.
  const OLD_RELEASE_WRITES = `
    INSERT INTO app_stack_domains (id, stack_id, organization_id, component_key, internal_port, hostname)
      VALUES ('sdom_rb','stk_a','o','web',8080,'rb.example');
    UPDATE app_stack_domains SET status = 'active', dns_status = 'ok', dns_checked_at = NOW(), cert_status = 'active', updated_at = NOW()
      WHERE id = 'sdom_rb';
    UPDATE app_stack_domains SET cert_status = 'requested', cert_requested_at = NOW() WHERE id = 'sdom_main';
    DELETE FROM app_stack_domains WHERE id = 'sdom_rb';`;
  const OPTIONS = "SELECT id, redirect_to_domain_id, compression, access_username, access_password_hash, path_routes FROM app_stack_domains ORDER BY id";

  beforeAll(async () => {
    pg = new PGlite();
    await migrateTo(pg, M0026);
    await pg.exec(SEED_0025);
    await pg.exec(read(M0026));
  }, 120_000);

  afterAll(async () => {
    await pg.close();
  });

  it("gives every address that existed before the migration no option", async () => {
    const none = { redirect_to_domain_id: null, compression: false, access_username: null, access_password_hash: null, path_routes: [] };
    expect(await rows(pg, OPTIONS)).toEqual(["sdom_b", "sdom_main", "sdom_old", "sdom_www"].map((id) => ({ id, ...none })));
  });

  it("runs the previous release's writes on addresses that carry options, and leaves the options alone", async () => {
    await pg.exec(NEW_RELEASE_OPTIONS);
    const before = await rows(pg, OPTIONS);
    await pg.exec(OLD_RELEASE_WRITES);
    expect(await rows(pg, OPTIONS)).toEqual(before);
    expect(await rows(pg, "SELECT cert_status FROM app_stack_domains WHERE id = 'sdom_main'")).toEqual([{ cert_status: "requested" }]);
  });

  it("runs 0026 again on a database with options without harm", async () => {
    const before = await rows(pg, OPTIONS);
    await pg.exec(read(M0026));
    expect(await rows(pg, OPTIONS)).toEqual(before);
    await expect(pg.exec("UPDATE app_stack_domains SET redirect_to_domain_id = 'sdom_main' WHERE id = 'sdom_b'")).rejects.toMatchObject({ code: "23503" });
    await expect(pg.exec("UPDATE app_stack_domains SET access_username = 'solo' WHERE id = 'sdom_b'")).rejects.toMatchObject({ code: "23514" });
  });

  it("lets the previous release remove the destination of a redirect: the other addresses stay, without redirect", async () => {
    await pg.exec("DELETE FROM app_stack_domains WHERE id = 'sdom_main'");
    expect(await rows(pg, "SELECT id, redirect_to_domain_id, stack_id, hostname FROM app_stack_domains WHERE stack_id = 'stk_a' ORDER BY id")).toEqual([
      { id: "sdom_old", redirect_to_domain_id: null, stack_id: "stk_a", hostname: "old.example" },
      { id: "sdom_www", redirect_to_domain_id: null, stack_id: "stk_a", hostname: "www.main.example" },
    ]);
  });

  it("lets the previous release delete an application whose addresses redirect to each other", async () => {
    await pg.exec("UPDATE app_stack_domains SET redirect_to_domain_id = 'sdom_www' WHERE id = 'sdom_old'");
    // 0025-era deletion removes the addresses of the stack in one statement.
    await pg.exec("DELETE FROM app_stack_domains WHERE stack_id = 'stk_a'");
    expect(await rows(pg, "SELECT id FROM app_stack_domains ORDER BY id")).toEqual([{ id: "sdom_b" }]);
    // The cascade from the stack row removes a redirecting pair as well.
    await pg.exec(`INSERT INTO app_stack_domains (id, stack_id, organization_id, component_key, internal_port, hostname)
      VALUES ('sdom_b2','stk_b','o','web',8080,'b2.example');
      UPDATE app_stack_domains SET redirect_to_domain_id = 'sdom_b' WHERE id = 'sdom_b2';
      DELETE FROM app_stacks WHERE id = 'stk_b';`);
    expect(await rows(pg, "SELECT id FROM app_stack_domains")).toEqual([]);
  });
});

describe("0028 app stack links", () => {
  // ADR-0039: after 0028 the previous release keeps running on the migrated schema; it never names app_stack_links.
  const M0028 = "0028_app_stack_links.sql";
  const HASH = "a".repeat(64);
  let pg: PGlite;
  const SEED_BEFORE = `
    INSERT INTO platform_installations (id, name) VALUES ('pi','pi');
    INSERT INTO hosts (id, platform_installation_id, name, hostname, ipv4_address, total_cpu_milli, total_memory_bytes, total_storage_bytes)
      VALUES ('h','pi','h','h.example','192.0.2.1',1000,'1','1');
    INSERT INTO organizations (id, platform_installation_id, name, slug) VALUES ('o','pi','o','o');
    INSERT INTO host_allocations (id, host_id, organization_id) VALUES ('a','h','o');
    INSERT INTO app_templates (id, slug, name, category) VALUES ('atpl_a','alpha','Alpha','database');
    INSERT INTO app_template_versions (id, template_id, version_number, source, spec_version, compiled_schema, spec_hash)
      VALUES ('atv_a1','atpl_a',1,'x',1,'{}','${HASH}');
    INSERT INTO app_stacks (id, organization_id, host_allocation_id, template_id, template_version_id, name, status)
      VALUES ('stk_app','o','a','atpl_a','atv_a1','Application','running'),('stk_db','o','a','atpl_a','atv_a1','Database','running');`;
  // A link written by the new release before the rollback.
  const LINK_ROW = `
    INSERT INTO app_stack_links (id, organization_id, consumer_stack_id, provider_stack_id, state)
      VALUES ('slnk_a','o','stk_app','stk_db','active');`;
  // What the previous release does to applications: none of it names the new table.
  const OLD_RELEASE_WRITES = `
    UPDATE app_stacks SET status = 'stopped', updated_at = NOW() WHERE id = 'stk_app';
    UPDATE app_stacks SET name = 'Renamed' WHERE id = 'stk_db';
    INSERT INTO app_stacks (id, organization_id, host_allocation_id, template_id, template_version_id, name, status)
      VALUES ('stk_rb','o','a','atpl_a','atv_a1','Rollback','draft');
    UPDATE app_stacks SET status = 'deleted', deleted_at = NOW() WHERE id = 'stk_rb';
    INSERT INTO operations (id, organization_id, kind, resource_type, resource_id) VALUES ('op_rb','o','stack.stop','app_stack','stk_app');
    UPDATE operations SET status = 'succeeded' WHERE id = 'op_rb';
    DELETE FROM operations WHERE id = 'op_rb';`;

  beforeAll(async () => {
    pg = new PGlite();
    await migrateTo(pg, M0028);
    await pg.exec(SEED_BEFORE);
    await pg.exec(read(M0028));
    await pg.exec(LINK_ROW);
  }, 120_000);

  afterAll(async () => {
    await pg.close();
  });

  it("adds one table and changes no column of a table that was there", async () => {
    const fresh = new PGlite();
    try {
      await migrateTo(fresh, M0028);
      const columns = "SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1, 2";
      const before = await rows<{ table_name: string }>(fresh, columns);
      await fresh.exec(read(M0028));
      const after = await rows<{ table_name: string }>(fresh, columns);
      expect(after.filter((c) => c.table_name !== "app_stack_links")).toEqual(before);
      expect([...new Set(after.map((c) => c.table_name))].filter((t) => !before.some((c) => c.table_name === t))).toEqual(["app_stack_links"]);
      const triggers = "SELECT count(*)::int AS n FROM information_schema.triggers WHERE trigger_schema = 'public'";
      await fresh.exec(read(M0028));
      const fullyBefore = new PGlite();
      try {
        await migrateTo(fullyBefore, M0028);
        expect(await rows(fresh, triggers)).toEqual(await rows(fullyBefore, triggers));
      } finally {
        await fullyBefore.close();
      }
    } finally {
      await fresh.close();
    }
  }, 120_000);

  it("runs the previous release's writes on applications and operations while a link exists", async () => {
    await pg.exec(OLD_RELEASE_WRITES);
    expect(await rows(pg, "SELECT id, status FROM app_stacks ORDER BY id")).toEqual([
      { id: "stk_app", status: "stopped" },
      { id: "stk_db", status: "running" },
      { id: "stk_rb", status: "deleted" },
    ]);
    expect(await rows(pg, "SELECT id, state FROM app_stack_links")).toEqual([{ id: "slnk_a", state: "active" }]);
  });

  it("lets the previous release mark a linked application as deleted: the row stays, the link stays with it", async () => {
    await pg.exec("UPDATE app_stacks SET status = 'deleted', deleted_at = NOW() WHERE id = 'stk_app'");
    expect(await rows(pg, "SELECT consumer_stack_id FROM app_stack_links")).toEqual([{ consumer_stack_id: "stk_app" }]);
    await pg.exec("UPDATE app_stacks SET status = 'stopped', deleted_at = NULL WHERE id = 'stk_app'");
  });

  it("runs 0028 again on a database with a link without harm", async () => {
    await pg.exec(read(M0028));
    expect(await rows(pg, "SELECT id, organization_id, consumer_stack_id, provider_stack_id, state FROM app_stack_links")).toEqual([
      { id: "slnk_a", organization_id: "o", consumer_stack_id: "stk_app", provider_stack_id: "stk_db", state: "active" },
    ]);
  });
});
