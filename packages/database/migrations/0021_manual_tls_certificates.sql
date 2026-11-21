-- Manual TLS certificates (ADR-0031). Additive: every new column of an existing table is NULL or has a DEFAULT,
-- so the previous release keeps running after an automatic rollback.
CREATE TABLE IF NOT EXISTS tls_certificates (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 128),
  created_for_site_id TEXT,
  active_version_id TEXT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_tls_certificates_id_org UNIQUE (id, organization_id),
  -- NO ACTION on update: a cascade would move the certificate (and its key, whose AAD names the org) to another tenant.
  CONSTRAINT fk_tls_certificates_site_org FOREIGN KEY (created_for_site_id, organization_id)
    REFERENCES sites(id, organization_id) ON UPDATE NO ACTION ON DELETE SET NULL (created_for_site_id)
);
CREATE INDEX IF NOT EXISTS idx_tls_certificates_org ON tls_certificates (organization_id);
CREATE INDEX IF NOT EXISTS idx_tls_certificates_created_for_site
  ON tls_certificates (created_for_site_id) WHERE created_for_site_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS tls_certificate_versions (
  id TEXT PRIMARY KEY,
  certificate_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  version_number INTEGER NOT NULL CHECK (version_number >= 1),
  leaf_pem TEXT NOT NULL,
  chain_pem TEXT NOT NULL,
  key_ciphertext_base64 TEXT NOT NULL,
  key_iv_base64 TEXT NOT NULL,
  key_auth_tag_base64 TEXT NOT NULL,
  key_version TEXT NOT NULL DEFAULT 'v1',
  subject TEXT NOT NULL,
  issuer TEXT NOT NULL,
  serial_number TEXT NOT NULL,
  fingerprint_sha256 TEXT NOT NULL CHECK (fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
  not_before TIMESTAMPTZ NOT NULL,
  not_after TIMESTAMPTZ NOT NULL,
  san_dns JSONB NOT NULL CHECK (jsonb_typeof(san_dns) = 'array' AND jsonb_array_length(san_dns) BETWEEN 1 AND 64),
  key_type TEXT NOT NULL CHECK (key_type IN ('rsa','ec')),
  key_bits INTEGER NOT NULL CHECK (key_bits BETWEEN 256 AND 16384),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applying','active','inactive','failed')),
  publish_generation BIGINT NOT NULL DEFAULT 0 CHECK (publish_generation >= 0),
  last_error_code TEXT CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  last_checked_at TIMESTAMPTZ,
  activated_at TIMESTAMPTZ,
  idempotency_key TEXT,
  request_hash TEXT CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$'),
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_tls_certificate_versions_validity CHECK (not_before < not_after),
  CONSTRAINT uq_tls_certificate_versions_id_org UNIQUE (id, organization_id),
  CONSTRAINT uq_tls_certificate_versions_id_cert UNIQUE (id, certificate_id),
  CONSTRAINT uq_tls_certificate_versions_number UNIQUE (certificate_id, version_number),
  CONSTRAINT fk_tls_certificate_versions_cert_org FOREIGN KEY (certificate_id, organization_id)
    REFERENCES tls_certificates(id, organization_id) ON UPDATE NO ACTION ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tls_certificate_versions_org_fingerprint
  ON tls_certificate_versions (organization_id, fingerprint_sha256);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tls_certificate_versions_org_idempotency
  ON tls_certificate_versions (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tls_certificate_versions_not_after ON tls_certificate_versions (not_after);
CREATE INDEX IF NOT EXISTS idx_tls_certificate_versions_org_created ON tls_certificate_versions (organization_id, created_at);

-- The active version must be a version of the same certificate (circular FK, added after both tables exist).
ALTER TABLE tls_certificates DROP CONSTRAINT IF EXISTS fk_tls_certificates_active_version;
ALTER TABLE tls_certificates ADD CONSTRAINT fk_tls_certificates_active_version
  FOREIGN KEY (active_version_id, id) REFERENCES tls_certificate_versions(id, certificate_id)
  ON DELETE SET NULL (active_version_id);

-- Certificate material and metadata never change; only the lifecycle columns do.
CREATE OR REPLACE FUNCTION prevent_tls_certificate_versions_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF (NEW.id, NEW.certificate_id, NEW.organization_id, NEW.version_number, NEW.leaf_pem, NEW.chain_pem,
      NEW.key_ciphertext_base64, NEW.key_iv_base64, NEW.key_auth_tag_base64, NEW.key_version,
      NEW.subject, NEW.issuer, NEW.serial_number, NEW.fingerprint_sha256, NEW.not_before, NEW.not_after,
      NEW.san_dns, NEW.key_type, NEW.key_bits, NEW.idempotency_key, NEW.request_hash, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.certificate_id, OLD.organization_id, OLD.version_number, OLD.leaf_pem, OLD.chain_pem,
      OLD.key_ciphertext_base64, OLD.key_iv_base64, OLD.key_auth_tag_base64, OLD.key_version,
      OLD.subject, OLD.issuer, OLD.serial_number, OLD.fingerprint_sha256, OLD.not_before, OLD.not_after,
      OLD.san_dns, OLD.key_type, OLD.key_bits, OLD.idempotency_key, OLD.request_hash, OLD.created_at) THEN
    RAISE EXCEPTION 'tls_certificate_versions material is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_tls_certificate_versions_mutation ON tls_certificate_versions;
CREATE TRIGGER trg_prevent_tls_certificate_versions_mutation
BEFORE UPDATE ON tls_certificate_versions
FOR EACH ROW
EXECUTE FUNCTION prevent_tls_certificate_versions_mutation();

ALTER TABLE domains ADD COLUMN IF NOT EXISTS cert_mode TEXT NOT NULL DEFAULT 'acme';
ALTER TABLE domains ADD COLUMN IF NOT EXISTS manual_certificate_version_id TEXT;
ALTER TABLE domains DROP CONSTRAINT IF EXISTS domains_cert_mode_check;
ALTER TABLE domains ADD CONSTRAINT domains_cert_mode_check CHECK (cert_mode IN ('acme','manual'));
ALTER TABLE domains DROP CONSTRAINT IF EXISTS domains_cert_mode_version_check;
ALTER TABLE domains ADD CONSTRAINT domains_cert_mode_version_check CHECK (
  (cert_mode = 'acme' AND manual_certificate_version_id IS NULL)
  OR (cert_mode = 'manual' AND manual_certificate_version_id IS NOT NULL));
-- Composite: a domain can only point to a version of its own organization. NO ACTION (end of statement) on both
-- sides: a site move with a manual domain fails loudly, an organization cascade deleting both sides succeeds.
ALTER TABLE domains DROP CONSTRAINT IF EXISTS fk_domains_manual_cert_version_org;
ALTER TABLE domains ADD CONSTRAINT fk_domains_manual_cert_version_org
  FOREIGN KEY (manual_certificate_version_id, organization_id)
  REFERENCES tls_certificate_versions(id, organization_id) ON UPDATE NO ACTION ON DELETE NO ACTION;
CREATE INDEX IF NOT EXISTS idx_domains_manual_cert_version
  ON domains (manual_certificate_version_id) WHERE manual_certificate_version_id IS NOT NULL;

-- One server-wide manifest generation counter for hp-manual-certificates.yml.
CREATE TABLE IF NOT EXISTS tls_publish_state (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  desired_generation BIGINT NOT NULL DEFAULT 0,
  confirmed_generation BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_tls_publish_state_generations CHECK (confirmed_generation >= 0 AND confirmed_generation <= desired_generation)
);
INSERT INTO tls_publish_state (id) VALUES ('default') ON CONFLICT (id) DO NOTHING;

-- Same Idempotency-Key with a different payload is refused (HCP-SPEC-004 4.1).
ALTER TABLE operations ADD COLUMN IF NOT EXISTS request_hash TEXT;
-- NOT VALID: the column was just added and is NULL on every existing row, so the never-purged operations table is not
-- scanned under the ACCESS EXCLUSIVE lock; every new or updated row is still checked.
ALTER TABLE operations DROP CONSTRAINT IF EXISTS operations_request_hash_check;
ALTER TABLE operations ADD CONSTRAINT operations_request_hash_check
  CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$') NOT VALID;
