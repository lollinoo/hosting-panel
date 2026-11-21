-- Site templates (ADR 0033). Additive: new tables, and two nullable columns on sites, so the previous release keeps
-- running after an automatic rollback (it never names them; a NULL template_version_id means "built-in WordPress v1").
CREATE TABLE IF NOT EXISTS site_templates (
  id TEXT PRIMARY KEY,
  module TEXT NOT NULL CHECK (module ~ '^[a-z][a-z0-9_]{0,31}$'),  -- the known keys are SITE_TYPE_KEYS, checked in code
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  description TEXT CHECK (description IS NULL OR char_length(description) <= 500),
  built_in BOOLEAN NOT NULL DEFAULT FALSE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  default_version_id TEXT,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_site_templates_enabled_needs_default CHECK (NOT enabled OR default_version_id IS NOT NULL),
  CONSTRAINT ck_site_templates_archived_disabled CHECK (archived_at IS NULL OR enabled = FALSE),
  CONSTRAINT ck_site_templates_built_in_not_archived CHECK (NOT built_in OR archived_at IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_site_templates_name_active ON site_templates (lower(name)) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS site_template_versions (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES site_templates(id) ON DELETE RESTRICT,
  version_number INTEGER NOT NULL CHECK (version_number >= 1),
  source TEXT NOT NULL CHECK (octet_length(source) BETWEEN 1 AND 65536),
  spec JSONB NOT NULL CHECK (jsonb_typeof(spec) = 'object'),
  spec_hash TEXT NOT NULL CHECK (spec_hash ~ '^[0-9a-f]{64}$'),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_site_template_versions_number UNIQUE (template_id, version_number),
  CONSTRAINT uq_site_template_versions_id_template UNIQUE (id, template_id)
);

-- The default must be a version of the same template (circular FK, added after both tables exist).
ALTER TABLE site_templates DROP CONSTRAINT IF EXISTS fk_site_templates_default_version;
ALTER TABLE site_templates ADD CONSTRAINT fk_site_templates_default_version
  FOREIGN KEY (default_version_id, id) REFERENCES site_template_versions(id, template_id) ON UPDATE NO ACTION ON DELETE NO ACTION;

-- A version never changes and is never deleted; only created_by may be nulled (ON DELETE SET NULL of the user).
CREATE OR REPLACE FUNCTION prevent_site_template_versions_mutation() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'site_template_versions rows are immutable';
  END IF;
  IF (NEW.id, NEW.template_id, NEW.version_number, NEW.source, NEW.spec, NEW.spec_hash, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.template_id, OLD.version_number, OLD.source, OLD.spec, OLD.spec_hash, OLD.created_at) THEN
    RAISE EXCEPTION 'site_template_versions rows are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_prevent_site_template_versions_mutation ON site_template_versions;
CREATE TRIGGER trg_prevent_site_template_versions_mutation BEFORE UPDATE OR DELETE ON site_template_versions
  FOR EACH ROW EXECUTE FUNCTION prevent_site_template_versions_mutation();

ALTER TABLE sites ADD COLUMN IF NOT EXISTS template_version_id TEXT;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS template_parameters JSONB;
ALTER TABLE sites DROP CONSTRAINT IF EXISTS fk_sites_template_version;
ALTER TABLE sites ADD CONSTRAINT fk_sites_template_version
  FOREIGN KEY (template_version_id) REFERENCES site_template_versions(id) ON UPDATE NO ACTION ON DELETE RESTRICT;
ALTER TABLE sites DROP CONSTRAINT IF EXISTS ck_sites_template_parameters;
ALTER TABLE sites ADD CONSTRAINT ck_sites_template_parameters
  CHECK (template_parameters IS NULL OR jsonb_typeof(template_parameters) = 'array');
CREATE INDEX IF NOT EXISTS idx_sites_template_version ON sites (template_version_id) WHERE template_version_id IS NOT NULL;
