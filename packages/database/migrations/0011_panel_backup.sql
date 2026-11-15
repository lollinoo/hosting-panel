ALTER TABLE backup_settings
  ADD COLUMN IF NOT EXISTS last_panel_backup_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_panel_backup_status TEXT CHECK (last_panel_backup_status IN ('succeeded', 'failed')),
  ADD COLUMN IF NOT EXISTS last_panel_backup_problem TEXT;
