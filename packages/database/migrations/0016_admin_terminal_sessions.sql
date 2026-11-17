CREATE TABLE IF NOT EXISTS admin_terminal_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  container_name TEXT NOT NULL,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  close_reason TEXT CHECK (close_reason IN ('closed','shell_exited','idle','time_limit','container_gone','executor_gone','not_started')),
  CHECK ((closed_at IS NULL) = (close_reason IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_admin_terminal_sessions_open ON admin_terminal_sessions (opened_at) WHERE closed_at IS NULL;
