-- Terminal in a component of an application (ADR-0041). A session belongs to a site or to one component of an
-- application, exactly one of the two. Additive: the rows and the writes of the previous release always set site_id,
-- so they satisfy the new check, and it never names the two new columns. Safe to run again.

ALTER TABLE admin_terminal_sessions ALTER COLUMN site_id DROP NOT NULL;
ALTER TABLE admin_terminal_sessions ADD COLUMN IF NOT EXISTS stack_id TEXT;
ALTER TABLE admin_terminal_sessions ADD COLUMN IF NOT EXISTS component_key TEXT;
ALTER TABLE admin_terminal_sessions DROP CONSTRAINT IF EXISTS admin_terminal_sessions_target_check;
ALTER TABLE admin_terminal_sessions ADD CONSTRAINT admin_terminal_sessions_target_check CHECK (
  (site_id IS NOT NULL AND stack_id IS NULL AND component_key IS NULL)
  OR (site_id IS NULL AND stack_id IS NOT NULL AND component_key IS NOT NULL)
);
