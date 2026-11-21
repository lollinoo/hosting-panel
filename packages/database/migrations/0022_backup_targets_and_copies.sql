-- Backup targets, policies and per-target copies (ADR-0032). The legacy S3 configuration stays in backup_settings:
-- the legacy target reads it through getBackupTarget(); no ciphertext is copied under another AAD.

-- The restic repository of an S3 target is endpoint + bucket + prefix. This is its canonical spelling: scheme and host
-- lowercased, the port read as a number (leading zeros stripped, so :0443 is :443) and dropped when it is the scheme's
-- default (:443 for https, :80 for http), the trailing '/' of the endpoint dropped, the bucket as is, the prefix without
-- leading, trailing or repeated '/'. Two spellings of one location give one key; NULL in, NULL out. Known limit: the long
-- and the short form of one IPv6 literal ([2001:db8:0:0:0:0:0:1] and [2001:db8::1]) are two keys.
-- The targets service stores it in backup_targets.s3_location_key on every insert and update; the trigger below keeps
-- the legacy target's key equal to the location in backup_settings.
CREATE OR REPLACE FUNCTION hp_s3_location_key(endpoint TEXT, bucket TEXT, prefix TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $fn$
  SELECT regexp_replace(
           regexp_replace(
             regexp_replace(lower(substring(endpoint from '^(?:[^:/]*://)?[^/]*')), ':0+([0-9]+)$', ':\1'),
             '^(https://.*):443$', '\1'),
           '^(http://.*):80$', '\1')
         || regexp_replace(substr(endpoint, length(substring(endpoint from '^(?:[^:/]*://)?[^/]*')) + 1), '/+$', '')
         || '/' || bucket
         || CASE WHEN btrim(regexp_replace(prefix, '/{2,}', '/', 'g'), '/') = '' THEN ''
                 ELSE '/' || btrim(regexp_replace(prefix, '/{2,}', '/', 'g'), '/') END
$fn$;

CREATE TABLE IF NOT EXISTS backup_targets (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('s3','local')),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 128),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  legacy_settings BOOLEAN NOT NULL DEFAULT FALSE,
  customer_selectable BOOLEAN NOT NULL DEFAULT FALSE,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config_json) = 'object'),
  s3_location_key TEXT,
  s3_secret_ciphertext_base64 TEXT,
  s3_secret_iv_base64 TEXT,
  s3_secret_auth_tag_base64 TEXT,
  s3_secret_key_version TEXT,
  retention_days INTEGER CHECK (retention_days BETWEEN 1 AND 365),
  last_test_at TIMESTAMPTZ,
  last_test_outcome TEXT CHECK (last_test_outcome IN ('ok','failed')),
  last_test_problem TEXT,
  last_test_available_bytes BIGINT CHECK (last_test_available_bytes >= 0),
  last_test_total_bytes BIGINT CHECK (last_test_total_bytes >= 0),
  local_root TEXT CHECK (local_root IS NULL OR local_root ~ '^/[A-Za-z0-9._/-]{1,255}$'),
  initialized_at TIMESTAMPTZ,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ,
  CONSTRAINT ck_backup_targets_secret CHECK (
    (kind = 's3' AND NOT legacy_settings
      AND s3_secret_ciphertext_base64 IS NOT NULL AND s3_secret_iv_base64 IS NOT NULL
      AND s3_secret_auth_tag_base64 IS NOT NULL AND s3_secret_key_version IS NOT NULL)
    OR ((kind = 'local' OR legacy_settings)
      AND s3_secret_ciphertext_base64 IS NULL AND s3_secret_iv_base64 IS NULL
      AND s3_secret_auth_tag_base64 IS NULL AND s3_secret_key_version IS NULL)),
  CONSTRAINT ck_backup_targets_legacy CHECK (NOT legacy_settings OR (kind = 's3' AND config_json = '{}'::jsonb)),
  CONSTRAINT ck_backup_targets_local_only CHECK (kind = 'local' OR (initialized_at IS NULL AND local_root IS NULL)),
  -- An S3 config holds exactly these five JSON strings: no other key (a plaintext secret does not fit), no JSON null.
  CONSTRAINT ck_backup_targets_config CHECK (
    (config_json = '{}'::jsonb AND (kind = 'local' OR legacy_settings))
    OR (kind = 's3' AND NOT legacy_settings
      AND config_json ?& ARRAY['endpoint','region','bucket','prefix','accessKeyId']
      AND config_json - ARRAY['endpoint','region','bucket','prefix','accessKeyId'] = '{}'::jsonb
      AND jsonb_typeof(config_json->'endpoint') = 'string' AND jsonb_typeof(config_json->'region') = 'string'
      AND jsonb_typeof(config_json->'bucket') = 'string' AND jsonb_typeof(config_json->'prefix') = 'string'
      AND jsonb_typeof(config_json->'accessKeyId') = 'string')),
  -- A live S3 target always has its location key; a new target's key is derived from its own config. The legacy
  -- target keeps its location in backup_settings, so its key is set from there (backfill, boot repair, legacy adapter).
  CONSTRAINT ck_backup_targets_s3_key CHECK (
    (kind = 'local' AND s3_location_key IS NULL)
    OR (kind = 's3' AND (archived_at IS NOT NULL OR s3_location_key IS NOT NULL)
      AND (legacy_settings OR s3_location_key IS NOT DISTINCT FROM
        hp_s3_location_key(config_json->>'endpoint', config_json->>'bucket', config_json->>'prefix')))),
  CONSTRAINT ck_backup_targets_archived CHECK (archived_at IS NULL OR (NOT enabled AND NOT customer_selectable))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_backup_targets_one_local ON backup_targets (kind)
  WHERE kind = 'local' AND archived_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_backup_targets_one_legacy ON backup_targets (legacy_settings)
  WHERE legacy_settings;
-- Two live S3 targets (the legacy one included) never share one restic location: one target's retention would prune
-- the other's snapshots.
CREATE UNIQUE INDEX IF NOT EXISTS uq_backup_targets_s3_location ON backup_targets (s3_location_key)
  WHERE kind = 's3' AND archived_at IS NULL;

-- The legacy target is a pointer to the one backup_settings row, so the database keeps the two in step for every
-- release that writes the row: this one, the legacy adapter, or an older release after a rollback that knows nothing
-- of backup_targets. A write that moves the settings onto the location of another live target fails (23505): fail
-- closed, never one restic repository under two targets. When no legacy target exists at all (a fresh install, a plain
-- upsert of the settings), the write also creates the live legacy target, with the deterministic id of the backfill
-- below, and attaches it (priority 1, required) to the default_site and panel policies that have no target: the same
-- state an upgraded install has. An ARCHIVED legacy target (the legacy adapter, M3, archives it on a location change
-- and freezes the settings) counts as existing: it is never revived, re-pointed or replaced. There is no DELETE
-- trigger: deleting the settings (a "clear", which also deletes every site backup) leaves the live legacy target as it
-- is, with its last key, copies and policy rows; it simply cannot be resolved while the settings are absent (not
-- configured, as before), and the next INSERT moves its key to the new location.
CREATE OR REPLACE FUNCTION hp_backup_settings_sync_legacy_target() RETURNS TRIGGER
LANGUAGE plpgsql AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM backup_targets WHERE legacy_settings) THEN
    UPDATE backup_targets SET s3_location_key = hp_s3_location_key(NEW.endpoint, NEW.bucket, NEW.prefix)
      WHERE legacy_settings AND archived_at IS NULL
        AND s3_location_key IS DISTINCT FROM hp_s3_location_key(NEW.endpoint, NEW.bucket, NEW.prefix);
  ELSE
    -- No ON CONFLICT: a location another live target already holds must fail the write (fail closed).
    INSERT INTO backup_targets (id, kind, name, enabled, legacy_settings, customer_selectable, config_json,
      s3_location_key, last_test_at, last_test_outcome, last_test_problem, updated_by_user_id, created_at, updated_at)
    VALUES ('bkt_' || md5('hp:backup-target:s3_legacy_default'), 's3', 'S3', TRUE, TRUE, FALSE, '{}'::jsonb,
      hp_s3_location_key(NEW.endpoint, NEW.bucket, NEW.prefix), NEW.last_test_at, NEW.last_test_outcome,
      NEW.last_test_problem, NEW.updated_by_user_id, NEW.updated_at, NEW.updated_at);
    INSERT INTO backup_policy_targets (policy_id, target_id, priority, required)
    SELECT p.id, 'bkt_' || md5('hp:backup-target:s3_legacy_default'), 1, TRUE FROM backup_policies p
    WHERE p.scope IN ('default_site','panel')
      AND NOT EXISTS (SELECT 1 FROM backup_policy_targets x WHERE x.policy_id = p.id);
  END IF;
  RETURN NEW;
END
$fn$;
DROP TRIGGER IF EXISTS trg_backup_settings_sync_legacy_target ON backup_settings;
CREATE TRIGGER trg_backup_settings_sync_legacy_target AFTER INSERT OR UPDATE ON backup_settings
  FOR EACH ROW EXECUTE FUNCTION hp_backup_settings_sync_legacy_target();

CREATE TABLE IF NOT EXISTS backup_policies (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('default_site','site','panel')),
  site_id TEXT REFERENCES sites(id) ON DELETE CASCADE,
  schedule_hour_utc INTEGER CHECK (schedule_hour_utc BETWEEN 0 AND 23),
  retention_days INTEGER CHECK (retention_days BETWEEN 1 AND 365),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_nightly_run_on DATE,
  nightly_run_started_at TIMESTAMPTZ,
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_backup_policies_site CHECK ((scope = 'site') = (site_id IS NOT NULL)),
  CONSTRAINT ck_backup_policies_hour CHECK ((scope = 'default_site') = (schedule_hour_utc IS NOT NULL)),
  CONSTRAINT ck_backup_policies_retention CHECK ((scope = 'site') = (retention_days IS NULL)),
  CONSTRAINT ck_backup_policies_site_enabled CHECK (scope <> 'site' OR enabled),
  CONSTRAINT ck_backup_policies_nightly CHECK (
    scope = 'default_site' OR (last_nightly_run_on IS NULL AND nightly_run_started_at IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_backup_policies_scope ON backup_policies (scope) WHERE site_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_backup_policies_site ON backup_policies (site_id) WHERE site_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS backup_policy_targets (
  policy_id TEXT NOT NULL REFERENCES backup_policies(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES backup_targets(id) ON DELETE RESTRICT,
  priority INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 2),
  required BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (policy_id, target_id),
  CONSTRAINT uq_backup_policy_targets_priority UNIQUE (policy_id, priority)
);
CREATE INDEX IF NOT EXISTS idx_backup_policy_targets_target ON backup_policy_targets (target_id);

CREATE TABLE IF NOT EXISTS site_backup_copies (
  id TEXT PRIMARY KEY,
  backup_id TEXT NOT NULL REFERENCES site_backups(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES backup_targets(id) ON DELETE RESTRICT,
  priority INTEGER NOT NULL DEFAULT 1 CHECK (priority BETWEEN 1 AND 2),
  required BOOLEAN NOT NULL DEFAULT TRUE,
  job_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','missing','unknown')),
  snapshot_id TEXT,
  size_bytes BIGINT CHECK (size_bytes >= 0),
  problem TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  CONSTRAINT uq_site_backup_copies_backup_target UNIQUE (backup_id, target_id),
  CONSTRAINT uq_site_backup_copies_backup_priority UNIQUE (backup_id, priority),
  CONSTRAINT ck_site_backup_copies_snapshot CHECK (status <> 'succeeded' OR snapshot_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_site_backup_copies_job ON site_backup_copies (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_site_backup_copies_target_status ON site_backup_copies (target_id, status);

CREATE TABLE IF NOT EXISTS panel_backup_copies (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES backup_targets(id) ON DELETE RESTRICT,
  priority INTEGER NOT NULL DEFAULT 1 CHECK (priority BETWEEN 1 AND 2),
  required BOOLEAN NOT NULL DEFAULT TRUE,
  job_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','missing','unknown')),
  snapshot_id TEXT,
  size_bytes BIGINT CHECK (size_bytes >= 0),
  problem TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  CONSTRAINT uq_panel_backup_copies_operation_target UNIQUE (operation_id, target_id),
  CONSTRAINT uq_panel_backup_copies_operation_priority UNIQUE (operation_id, priority),
  CONSTRAINT ck_panel_backup_copies_snapshot CHECK (status <> 'succeeded' OR snapshot_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_panel_backup_copies_job ON panel_backup_copies (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_panel_backup_copies_target_started ON panel_backup_copies (target_id, started_at DESC);

-- The aggregate of a logical backup: 'partial' = at least one copy succeeded and a required one did not.
ALTER TABLE site_backups DROP CONSTRAINT IF EXISTS site_backups_status_check;
ALTER TABLE site_backups ADD CONSTRAINT site_backups_status_check
  CHECK (status IN ('running','succeeded','partial','failed'));
ALTER TABLE site_backups
  ADD COLUMN IF NOT EXISTS restore_target_id TEXT REFERENCES backup_targets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS archive_target_id TEXT REFERENCES backup_targets(id) ON DELETE SET NULL;

-- Legacy S3 backfill: deterministic ids, set-based, ON CONFLICT DO NOTHING (running the file twice adds nothing).
INSERT INTO backup_targets (id, kind, name, enabled, legacy_settings, customer_selectable, config_json, s3_location_key,
  last_test_at, last_test_outcome, last_test_problem, updated_by_user_id, created_at, updated_at)
SELECT 'bkt_' || md5('hp:backup-target:s3_legacy_default'), 's3', 'S3', TRUE, TRUE, FALSE, '{}'::jsonb,
  hp_s3_location_key(bs.endpoint, bs.bucket, bs.prefix), bs.last_test_at, bs.last_test_outcome, bs.last_test_problem, bs.updated_by_user_id, bs.updated_at, bs.updated_at
FROM backup_settings bs WHERE bs.id = 'default'
ON CONFLICT DO NOTHING;

-- Policies exist on every install (local-only included): the nightly run state moves to the default_site row.
INSERT INTO backup_policies (id, scope, schedule_hour_utc, retention_days, last_nightly_run_on, nightly_run_started_at)
SELECT 'bpl_' || md5('hp:backup-policy:default_site'), 'default_site', COALESCE(bs.schedule_hour_utc, 2),
  COALESCE(bs.retention_days, 14), bs.last_nightly_run_on, bs.nightly_run_started_at
FROM (SELECT 1) AS one LEFT JOIN backup_settings bs ON bs.id = 'default'
ON CONFLICT DO NOTHING;
INSERT INTO backup_policies (id, scope, retention_days)
SELECT 'bpl_' || md5('hp:backup-policy:panel'), 'panel', COALESCE(bs.retention_days, 14)
FROM (SELECT 1) AS one LEFT JOIN backup_settings bs ON bs.id = 'default'
ON CONFLICT DO NOTHING;

INSERT INTO backup_policy_targets (policy_id, target_id, priority, required)
SELECT p.id, t.id, 1, TRUE
FROM backup_policies p JOIN backup_targets t ON t.id = 'bkt_' || md5('hp:backup-target:s3_legacy_default')
WHERE p.id IN ('bpl_' || md5('hp:backup-policy:default_site'), 'bpl_' || md5('hp:backup-policy:panel'))
ON CONFLICT DO NOTHING;

-- One copy per legacy row that has a snapshot (same snapshot id and times) or is still running; a 'partial' row
-- (not a copy state) with a snapshot becomes a succeeded copy. An archived legacy target takes a row only while the
-- settings still point at its location: it is never given backups written somewhere else.
INSERT INTO site_backup_copies (id, backup_id, target_id, priority, required, job_id, status, snapshot_id,
  size_bytes, problem, started_at, finished_at)
SELECT 'bcp_' || md5(sb.id || ':' || t.id), sb.id, t.id, 1, TRUE, sb.operation_id,
  CASE WHEN sb.status = 'partial' THEN 'succeeded' ELSE sb.status END, sb.snapshot_id,
  sb.size_bytes, sb.problem, sb.started_at, sb.finished_at
FROM site_backups sb JOIN backup_targets t ON t.id = 'bkt_' || md5('hp:backup-target:s3_legacy_default')
WHERE (sb.snapshot_id IS NOT NULL OR sb.status = 'running')
  AND (t.archived_at IS NULL OR EXISTS (SELECT 1 FROM backup_settings bs
    WHERE bs.id = 'default' AND t.s3_location_key = hp_s3_location_key(bs.endpoint, bs.bucket, bs.prefix)))
  AND NOT EXISTS (SELECT 1 FROM site_backup_copies c WHERE c.backup_id = sb.id)
ON CONFLICT DO NOTHING;
