CREATE TABLE IF NOT EXISTS dns_provider_settings (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  provider TEXT NOT NULL CHECK (provider IN ('cloudflare','digitalocean','gandiv5','hetzner','httpreq','ionos','ovh')),
  credential_names JSONB NOT NULL DEFAULT '[]'::jsonb,
  credentials_ciphertext_base64 TEXT NOT NULL,
  credentials_iv_base64 TEXT NOT NULL,
  credentials_auth_tag_base64 TEXT NOT NULL,
  credentials_key_version TEXT NOT NULL DEFAULT 'v1',
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE domains ADD COLUMN IF NOT EXISTS cert_challenge TEXT NOT NULL DEFAULT 'http-01';
ALTER TABLE domains DROP CONSTRAINT IF EXISTS domains_cert_challenge_check;
ALTER TABLE domains ADD CONSTRAINT domains_cert_challenge_check CHECK (cert_challenge IN ('http-01','dns-01'));

ALTER TABLE domains DROP CONSTRAINT IF EXISTS domains_cert_problem_check;
ALTER TABLE domains ADD CONSTRAINT domains_cert_problem_check CHECK (cert_problem IS NULL OR cert_problem IN ('rate_limited','port_80_blocked','not_pointing','caa_blocked','dns_provider','other'));
