ALTER TABLE site_backups DROP CONSTRAINT IF EXISTS site_backups_kind_check;
ALTER TABLE site_backups ADD CONSTRAINT site_backups_kind_check
  CHECK (kind IN ('nightly', 'manual', 'pre_update'));

CREATE TABLE IF NOT EXISTS site_wordpress_state (
  site_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  state JSONB,
  last_update JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_site_wordpress_state_site_org FOREIGN KEY (site_id, organization_id)
    REFERENCES sites(id, organization_id) ON UPDATE CASCADE ON DELETE CASCADE
);
