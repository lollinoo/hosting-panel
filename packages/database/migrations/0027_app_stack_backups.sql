-- Backups of applications (ADR-0038). Additive: two new tables and nothing else, so the previous release keeps running
-- after an automatic rollback: it never names them. The one thing it meets is the foreign key from a copy to its
-- destination: deleting a destination that holds application copies is refused by the database there (the release
-- that knows the table refuses it earlier, with a plain answer). Safe to run again.

-- One row per backup. No foreign key to app_stacks: the backups of a deleted application stay until the retention
-- period removes them (K7). operation_id has no FK (site_backups precedent); a restore writes its safety copy as a
-- `pre_restore` row under its own operation and marks the row it reads with restore_*.
CREATE TABLE IF NOT EXISTS app_stack_backups (
  id TEXT PRIMARY KEY,
  stack_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('manual','pre_restore')),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','partial','failed')),
  operation_id TEXT NOT NULL,
  revision_id TEXT,
  volume_keys JSONB NOT NULL CHECK (jsonb_typeof(volume_keys) = 'array'),
  resume_after BOOLEAN NOT NULL DEFAULT FALSE,
  size_bytes BIGINT CHECK (size_bytes >= 0),
  problem TEXT CHECK (problem IS NULL OR problem ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  restore_operation_id TEXT,
  restore_status TEXT CHECK (restore_status IS NULL OR restore_status IN ('running','succeeded','failed')),
  restore_problem TEXT CHECK (restore_problem IS NULL OR restore_problem ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'),
  restored_at TIMESTAMPTZ,
  -- pre_restore rows only. incomplete_data: the data it copied had been left half written by an earlier restore.
  -- left_incomplete: its own restore left the data so (it failed while writing, or before writing data that already
  -- were, or it wrote back a copy of such data). While the newest operation of the application other than a backup or
  -- a clean-up is a restore whose safety backup has left_incomplete, the newest one of whole data is never removed (K7).
  incomplete_data BOOLEAN NOT NULL DEFAULT FALSE,
  left_incomplete BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT uq_app_stack_backups_operation UNIQUE (operation_id)
);
CREATE INDEX IF NOT EXISTS idx_app_stack_backups_stack ON app_stack_backups (stack_id, started_at);
CREATE INDEX IF NOT EXISTS idx_app_stack_backups_restore_operation ON app_stack_backups (restore_operation_id)
  WHERE restore_operation_id IS NOT NULL;

-- One row per destination of a backup (at most two), the mirror of site_backup_copies.
CREATE TABLE IF NOT EXISTS app_stack_backup_copies (
  id TEXT PRIMARY KEY,
  backup_id TEXT NOT NULL REFERENCES app_stack_backups(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES backup_targets(id) ON DELETE RESTRICT,
  priority INTEGER NOT NULL DEFAULT 1 CHECK (priority BETWEEN 1 AND 2),
  required BOOLEAN NOT NULL DEFAULT TRUE,
  job_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
  snapshot_id TEXT,
  size_bytes BIGINT CHECK (size_bytes >= 0),
  problem TEXT CHECK (problem IS NULL OR problem ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  CONSTRAINT uq_app_stack_backup_copies_backup_target UNIQUE (backup_id, target_id),
  CONSTRAINT uq_app_stack_backup_copies_backup_priority UNIQUE (backup_id, priority),
  CONSTRAINT ck_app_stack_backup_copies_snapshot CHECK (status <> 'succeeded' OR snapshot_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_app_stack_backup_copies_job ON app_stack_backup_copies (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_app_stack_backup_copies_target_status ON app_stack_backup_copies (target_id, status);
