CREATE TABLE IF NOT EXISTS backup_settings (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  endpoint TEXT NOT NULL,
  region TEXT NOT NULL,
  bucket TEXT NOT NULL,
  prefix TEXT NOT NULL DEFAULT '',
  access_key_id TEXT NOT NULL,
  secret_access_key_ciphertext_base64 TEXT NOT NULL,
  secret_access_key_iv_base64 TEXT NOT NULL,
  secret_access_key_auth_tag_base64 TEXT NOT NULL,
  secret_access_key_key_version TEXT NOT NULL DEFAULT 'v1',
  schedule_hour_utc INTEGER NOT NULL DEFAULT 2 CHECK (schedule_hour_utc BETWEEN 0 AND 23),
  retention_days INTEGER NOT NULL DEFAULT 14 CHECK (retention_days BETWEEN 1 AND 365),
  last_nightly_run_on DATE,
  nightly_run_started_at TIMESTAMPTZ,
  last_test_at TIMESTAMPTZ,
  last_test_outcome TEXT CHECK (last_test_outcome IN ('ok', 'failed')),
  last_test_problem TEXT,
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS site_backups (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('nightly', 'manual')),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  operation_id TEXT UNIQUE,
  snapshot_id TEXT,
  size_bytes BIGINT,
  problem TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_site_backups_site_started
  ON site_backups (site_id, started_at DESC);
