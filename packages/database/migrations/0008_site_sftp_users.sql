CREATE TABLE IF NOT EXISTS site_sftp_users (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL CHECK (password_hash LIKE '$6$%'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  password_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_site_sftp_users_site_org FOREIGN KEY (site_id, organization_id)
    REFERENCES sites(id, organization_id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_site_sftp_users_site ON site_sftp_users (organization_id, site_id);
