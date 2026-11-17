ALTER TABLE site_backups
  ADD COLUMN IF NOT EXISTS site_url TEXT,
  ADD COLUMN IF NOT EXISTS restore_operation_id TEXT,
  ADD COLUMN IF NOT EXISTS restore_status TEXT CHECK (restore_status IN ('running', 'succeeded', 'failed')),
  ADD COLUMN IF NOT EXISTS restore_problem TEXT,
  ADD COLUMN IF NOT EXISTS restored_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archive_operation_id TEXT,
  ADD COLUMN IF NOT EXISTS archive_status TEXT CHECK (archive_status IN ('preparing', 'ready', 'failed')),
  ADD COLUMN IF NOT EXISTS archive_problem TEXT,
  ADD COLUMN IF NOT EXISTS archive_ready_until TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_operations_resource_submitted
  ON operations (resource_id, submitted_at DESC);
