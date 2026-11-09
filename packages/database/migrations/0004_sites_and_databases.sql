-- Managed WordPress sites: PHP version, per-site databases, ownership moves (ON UPDATE CASCADE)

ALTER TABLE sites ADD COLUMN IF NOT EXISTS php_version TEXT
  CHECK (php_version IS NULL OR php_version IN ('8.3', '8.4', '8.5'));

CREATE TABLE IF NOT EXISTS site_databases (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  db_name TEXT NOT NULL UNIQUE,
  db_user TEXT NOT NULL UNIQUE,
  password_secret_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_site_databases_site_org FOREIGN KEY (site_id, organization_id)
    REFERENCES sites(id, organization_id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_site_databases_site ON site_databases (organization_id, site_id);

ALTER TABLE service_instances DROP CONSTRAINT IF EXISTS fk_service_instances_site_org;
ALTER TABLE service_instances ADD CONSTRAINT fk_service_instances_site_org
  FOREIGN KEY (site_id, organization_id) REFERENCES sites(id, organization_id)
  ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE stack_revisions DROP CONSTRAINT IF EXISTS fk_stack_revisions_service_instance_org;
ALTER TABLE stack_revisions ADD CONSTRAINT fk_stack_revisions_service_instance_org
  FOREIGN KEY (service_instance_id, organization_id) REFERENCES service_instances(id, organization_id)
  ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE domains DROP CONSTRAINT IF EXISTS fk_domains_site_org;
ALTER TABLE domains ADD CONSTRAINT fk_domains_site_org
  FOREIGN KEY (site_id, organization_id) REFERENCES sites(id, organization_id)
  ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE encrypted_secrets DROP CONSTRAINT IF EXISTS fk_encrypted_secrets_site_org;
ALTER TABLE encrypted_secrets ADD CONSTRAINT fk_encrypted_secrets_site_org
  FOREIGN KEY (site_id, organization_id) REFERENCES sites(id, organization_id)
  ON UPDATE CASCADE ON DELETE CASCADE;

-- Revisions stay immutable, except that an ownership move may rewrite organization_id alone
-- (the ON UPDATE CASCADE from service_instances).
CREATE OR REPLACE FUNCTION prevent_stack_revisions_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.organization_id IS DISTINCT FROM OLD.organization_id
     AND (NEW.id, NEW.service_instance_id, NEW.revision_number, NEW.spec_hash, NEW.declarative_config,
          NEW.secret_refs, NEW.resource_limits, NEW.author_id, NEW.created_at)
         IS NOT DISTINCT FROM
         (OLD.id, OLD.service_instance_id, OLD.revision_number, OLD.spec_hash, OLD.declarative_config,
          OLD.secret_refs, OLD.resource_limits, OLD.author_id, OLD.created_at) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'stack_revisions is append-only and immutable';
END;
$$ LANGUAGE plpgsql;
