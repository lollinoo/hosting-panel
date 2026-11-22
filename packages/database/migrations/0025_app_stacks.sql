-- Application stacks (ADR-0035, HCP-SPEC-005). Additive: ten new tables, one nullable column on organizations and a
-- hostname-claim trigger on domains, so the previous release keeps running after an automatic rollback: it never names
-- the new tables, inserts organizations without the new column (NULL = unlimited), and the domains trigger only refuses
-- a hostname that a stack holds, with the same SQLSTATE 23505 its unique index already raises. Safe to run again.

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS max_app_stacks INTEGER;
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_max_app_stacks_check;
ALTER TABLE organizations ADD CONSTRAINT organizations_max_app_stacks_check CHECK (max_app_stacks IS NULL OR max_app_stacks >= 0);

-- Catalog. Draft = disabled and not archived; published = enabled (needs a default version); archived = archived_at set.
CREATE TABLE IF NOT EXISTS app_templates (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL CHECK (slug ~ '^[a-z][a-z0-9-]{1,47}$'),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  description TEXT CHECK (description IS NULL OR char_length(description) <= 500),
  category TEXT NOT NULL CHECK (category ~ '^[a-z][a-z0-9-]{0,31}$'),  -- the known categories are checked in code
  built_in BOOLEAN NOT NULL DEFAULT FALSE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  default_version_id TEXT,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_app_templates_slug UNIQUE (slug),
  CONSTRAINT ck_app_templates_enabled_needs_default CHECK (NOT enabled OR default_version_id IS NOT NULL),
  CONSTRAINT ck_app_templates_archived_disabled CHECK (archived_at IS NULL OR enabled = FALSE),
  CONSTRAINT ck_app_templates_built_in_not_archived CHECK (NOT built_in OR archived_at IS NULL)
);

CREATE TABLE IF NOT EXISTS app_template_versions (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES app_templates(id) ON DELETE RESTRICT,
  version_number INTEGER NOT NULL CHECK (version_number >= 1),
  source TEXT NOT NULL CHECK (octet_length(source) BETWEEN 1 AND 65536),
  spec_version INTEGER NOT NULL CHECK (spec_version >= 1),  -- APP_TEMPLATE_SPEC_VERSION (1) is checked in code
  compiled_schema JSONB NOT NULL CHECK (jsonb_typeof(compiled_schema) = 'object'),
  spec_hash TEXT NOT NULL CHECK (spec_hash ~ '^[0-9a-f]{64}$'),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_app_template_versions_number UNIQUE (template_id, version_number),
  CONSTRAINT uq_app_template_versions_id_template UNIQUE (id, template_id)
);

ALTER TABLE app_templates DROP CONSTRAINT IF EXISTS fk_app_templates_default_version;
ALTER TABLE app_templates ADD CONSTRAINT fk_app_templates_default_version
  FOREIGN KEY (default_version_id, id) REFERENCES app_template_versions(id, template_id) ON UPDATE NO ACTION ON DELETE NO ACTION;

-- A version never changes and is never deleted; only created_by may be nulled (ON DELETE SET NULL of the user).
CREATE OR REPLACE FUNCTION prevent_app_template_versions_mutation() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'app_template_versions rows are immutable';
  END IF;
  IF (NEW.id, NEW.template_id, NEW.version_number, NEW.source, NEW.spec_version, NEW.compiled_schema, NEW.spec_hash, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.template_id, OLD.version_number, OLD.source, OLD.spec_version, OLD.compiled_schema, OLD.spec_hash, OLD.created_at) THEN
    RAISE EXCEPTION 'app_template_versions rows are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_prevent_app_template_versions_mutation ON app_template_versions;
CREATE TRIGGER trg_prevent_app_template_versions_mutation BEFORE UPDATE OR DELETE ON app_template_versions
  FOR EACH ROW EXECUTE FUNCTION prevent_app_template_versions_mutation();

-- Stacks. The id names Docker objects and the route file (app_<id>.yml), hence the CHECK. A stack never changes
-- organization (its secrets' AAD names it): every FK to it is ON UPDATE NO ACTION.
CREATE TABLE IF NOT EXISTS app_stacks (
  id TEXT PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9_]{0,63}$'),
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  host_allocation_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_version_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','queued','deploying','running','degraded','failed','unknown',
    'stopping','stopped','starting','updating','deleting','deleted','delete_failed')),
  desired_revision_id TEXT,
  applied_revision_id TEXT,
  resource_quota_id TEXT REFERENCES resource_quotas(id) ON DELETE SET NULL,
  applied_routes_hash TEXT CHECK (applied_routes_hash IS NULL OR applied_routes_hash ~ '^[0-9a-f]{64}$'),
  idempotency_key TEXT CHECK (idempotency_key IS NULL OR idempotency_key ~ '^[\x21-\x7E]{1,255}$'),
  request_hash TEXT CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$'),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT uq_app_stacks_id_org UNIQUE (id, organization_id),
  CONSTRAINT ck_app_stacks_deleted CHECK ((status = 'deleted') = (deleted_at IS NOT NULL)),
  CONSTRAINT ck_app_stacks_idempotency_pair CHECK ((idempotency_key IS NULL) = (request_hash IS NULL)),
  CONSTRAINT fk_app_stacks_host_allocation_org FOREIGN KEY (host_allocation_id, organization_id)
    REFERENCES host_allocations(id, organization_id) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT fk_app_stacks_template_version FOREIGN KEY (template_version_id, template_id)
    REFERENCES app_template_versions(id, template_id) ON UPDATE NO ACTION ON DELETE NO ACTION
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_app_stacks_name_live ON app_stacks (organization_id, lower(name)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_app_stacks_org_idempotency ON app_stacks (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_app_stacks_org_created ON app_stacks (organization_id, created_at);
CREATE INDEX IF NOT EXISTS idx_app_stacks_template_version ON app_stacks (template_version_id);

-- Public parameter values only; secret parameters live in app_stack_secrets.
CREATE TABLE IF NOT EXISTS app_stack_parameters (
  stack_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  parameter_key TEXT NOT NULL CHECK (parameter_key ~ '^[a-z][a-z0-9_]{0,31}$'),
  public_value JSONB NOT NULL CHECK (jsonb_typeof(public_value) IN ('string','number','boolean')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (stack_id, parameter_key),
  CONSTRAINT fk_app_stack_parameters_stack_org FOREIGN KEY (stack_id, organization_id)
    REFERENCES app_stacks(id, organization_id) ON UPDATE NO ACTION ON DELETE CASCADE
);

-- Immutable secret versions (AES-256-GCM, AAD "<org>:*:app:<stack>:<parameter>:<version>").
CREATE TABLE IF NOT EXISTS app_stack_secrets (
  id TEXT PRIMARY KEY,
  stack_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  parameter_key TEXT NOT NULL CHECK (parameter_key ~ '^[a-z][a-z0-9_]{0,31}$'),
  version INTEGER NOT NULL CHECK (version >= 1),
  ciphertext_base64 TEXT NOT NULL CHECK (char_length(ciphertext_base64) BETWEEN 1 AND 32768),
  iv_base64 TEXT NOT NULL CHECK (char_length(iv_base64) BETWEEN 1 AND 64),
  auth_tag_base64 TEXT NOT NULL CHECK (char_length(auth_tag_base64) BETWEEN 1 AND 64),
  key_version TEXT NOT NULL DEFAULT 'v1',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_app_stack_secrets_version UNIQUE (stack_id, parameter_key, version),
  CONSTRAINT fk_app_stack_secrets_stack_org FOREIGN KEY (stack_id, organization_id)
    REFERENCES app_stacks(id, organization_id) ON UPDATE NO ACTION ON DELETE CASCADE
);

-- Immutable revisions: secret-free plan (opaque here), its hash, the public parameter values and the totals the quota charges.
CREATE TABLE IF NOT EXISTS app_stack_revisions (
  id TEXT PRIMARY KEY,
  stack_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
  template_version_id TEXT NOT NULL REFERENCES app_template_versions(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
  plan JSONB NOT NULL CHECK (jsonb_typeof(plan) = 'object'),
  plan_hash TEXT NOT NULL CHECK (plan_hash ~ '^[0-9a-f]{64}$'),
  parameters JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(parameters) = 'array'),  -- sorted public {key,value} only
  component_count INTEGER NOT NULL CHECK (component_count BETWEEN 1 AND 8),
  cpu_milli INTEGER NOT NULL CHECK (cpu_milli >= 0),
  memory_bytes BIGINT NOT NULL CHECK (memory_bytes >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_app_stack_revisions_number UNIQUE (stack_id, revision_number),
  CONSTRAINT uq_app_stack_revisions_id_stack UNIQUE (id, stack_id),
  CONSTRAINT fk_app_stack_revisions_stack_org FOREIGN KEY (stack_id, organization_id)
    REFERENCES app_stacks(id, organization_id) ON UPDATE NO ACTION ON DELETE CASCADE
);

-- desired/applied revision belong to the same stack (circular FKs, added after both tables exist).
ALTER TABLE app_stacks DROP CONSTRAINT IF EXISTS fk_app_stacks_desired_revision;
ALTER TABLE app_stacks ADD CONSTRAINT fk_app_stacks_desired_revision
  FOREIGN KEY (desired_revision_id, id) REFERENCES app_stack_revisions(id, stack_id) ON UPDATE NO ACTION ON DELETE NO ACTION;
ALTER TABLE app_stacks DROP CONSTRAINT IF EXISTS fk_app_stacks_applied_revision;
ALTER TABLE app_stacks ADD CONSTRAINT fk_app_stacks_applied_revision
  FOREIGN KEY (applied_revision_id, id) REFERENCES app_stack_revisions(id, stack_id) ON UPDATE NO ACTION ON DELETE NO ACTION;

-- Revisions never change; a DELETE passes only while the parent stack is being deleted (organization cascade).
CREATE OR REPLACE FUNCTION prevent_app_stack_revisions_mutation() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM app_stacks WHERE id = OLD.stack_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'app_stack_revisions rows are immutable';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_prevent_app_stack_revisions_mutation ON app_stack_revisions;
CREATE TRIGGER trg_prevent_app_stack_revisions_mutation BEFORE UPDATE OR DELETE ON app_stack_revisions
  FOR EACH ROW EXECUTE FUNCTION prevent_app_stack_revisions_mutation();

-- Secret versions never change; a DELETE passes only for a deleted stack (purge) or a stack being deleted (cascade).
CREATE OR REPLACE FUNCTION prevent_app_stack_secrets_mutation() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM app_stacks WHERE id = OLD.stack_id AND deleted_at IS NULL) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'app_stack_secrets rows are immutable';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_prevent_app_stack_secrets_mutation ON app_stack_secrets;
CREATE TRIGGER trg_prevent_app_stack_secrets_mutation BEFORE UPDATE OR DELETE ON app_stack_secrets
  FOR EACH ROW EXECUTE FUNCTION prevent_app_stack_secrets_mutation();

-- Observed state per component of the desired revision (never a Docker id).
CREATE TABLE IF NOT EXISTS app_stack_components (
  stack_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  component_key TEXT NOT NULL CHECK (component_key ~ '^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$'),
  health TEXT NOT NULL DEFAULT 'unknown' CHECK (health IN ('unknown','starting','healthy','unhealthy','stopped','missing')),
  health_observed_at TIMESTAMPTZ,
  applied_revision_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (stack_id, component_key),
  CONSTRAINT fk_app_stack_components_stack_org FOREIGN KEY (stack_id, organization_id)
    REFERENCES app_stacks(id, organization_id) ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT fk_app_stack_components_applied_revision FOREIGN KEY (applied_revision_id, stack_id)
    REFERENCES app_stack_revisions(id, stack_id) ON UPDATE NO ACTION ON DELETE NO ACTION
);

-- Named volumes: never removed implicitly; retention_policy 'destroy' is set only by a delete that destroys data.
CREATE TABLE IF NOT EXISTS app_stack_volumes (
  stack_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  volume_key TEXT NOT NULL CHECK (volume_key ~ '^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$'),
  retention_policy TEXT NOT NULL DEFAULT 'retain' CHECK (retention_policy IN ('retain','destroy')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','present','retained','removed','missing')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (stack_id, volume_key),
  CONSTRAINT fk_app_stack_volumes_stack_org FOREIGN KEY (stack_id, organization_id)
    REFERENCES app_stacks(id, organization_id) ON UPDATE NO ACTION ON DELETE CASCADE
);

-- Web addresses of a stack (ACME only). DNS/cert columns mirror domains (0006, 0020) so domain-policy.ts is reused.
CREATE TABLE IF NOT EXISTS app_stack_domains (
  id TEXT PRIMARY KEY,
  stack_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  component_key TEXT NOT NULL,
  internal_port INTEGER NOT NULL CHECK (internal_port BETWEEN 1 AND 65535),
  hostname TEXT NOT NULL CHECK (hostname = lower(hostname) AND char_length(hostname) BETWEEN 3 AND 253),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','failed')),
  dns_status TEXT NOT NULL DEFAULT 'unchecked'
    CHECK (dns_status IN ('unchecked','ok','not_found','points_elsewhere','ipv6_conflict','lookup_failed')),
  dns_observed JSONB NOT NULL DEFAULT '{"a":[],"aaaa":[]}'::jsonb,
  dns_checked_at TIMESTAMPTZ,
  dns_next_check_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dns_attempts INTEGER NOT NULL DEFAULT 0,
  cert_status TEXT NOT NULL DEFAULT 'none' CHECK (cert_status IN ('none','requested','active','failed')),
  cert_problem TEXT CHECK (cert_problem IS NULL
    OR cert_problem IN ('rate_limited','port_80_blocked','not_pointing','caa_blocked','dns_provider','other')),
  cert_challenge TEXT NOT NULL DEFAULT 'http-01' CHECK (cert_challenge IN ('http-01','dns-01')),
  cert_requested_at TIMESTAMPTZ,
  cert_retry_at TIMESTAMPTZ,
  cert_attempts INTEGER NOT NULL DEFAULT 0,
  cert_expires_at TIMESTAMPTZ,
  cert_trusted BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_app_stack_domains_hostname UNIQUE (hostname),
  CONSTRAINT fk_app_stack_domains_stack_org FOREIGN KEY (stack_id, organization_id)
    REFERENCES app_stacks(id, organization_id) ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT fk_app_stack_domains_component FOREIGN KEY (stack_id, component_key)
    REFERENCES app_stack_components(stack_id, component_key) ON UPDATE NO ACTION ON DELETE NO ACTION
);
CREATE INDEX IF NOT EXISTS idx_app_stack_domains_stack ON app_stack_domains (stack_id);
CREATE INDEX IF NOT EXISTS idx_app_stack_domains_dns_due ON app_stack_domains (dns_next_check_at);

-- One row per stack operation (history of deploys and lifecycle actions); operation_id has no FK (site_backups precedent).
CREATE TABLE IF NOT EXISTS app_stack_deployments (
  id TEXT PRIMARY KEY,
  stack_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  revision_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','unknown','cancelled')),
  problem TEXT CHECK (problem IS NULL OR problem ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  CONSTRAINT uq_app_stack_deployments_operation UNIQUE (operation_id),
  CONSTRAINT fk_app_stack_deployments_stack_org FOREIGN KEY (stack_id, organization_id)
    REFERENCES app_stacks(id, organization_id) ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT fk_app_stack_deployments_revision FOREIGN KEY (revision_id, stack_id)
    REFERENCES app_stack_revisions(id, stack_id) ON UPDATE NO ACTION ON DELETE NO ACTION
);
CREATE INDEX IF NOT EXISTS idx_app_stack_deployments_stack ON app_stack_deployments (stack_id, started_at);

-- One hostname, one owner, across domains (sites), app_stack_domains (stacks) and hosts (the panel). Each writer takes a
-- transaction-scoped advisory lock on the lower-cased name, then looks at the other table with a fresh snapshot (READ
-- COMMITTED, the only level the panel uses): of two concurrent writers of the same name the second waits for the
-- first to end and then sees its row. The refusal is SQLSTATE 23505, which every site writer already maps to
-- DOMAIN_CONFLICT. The site trigger does not look at hosts: site writers keep their own pre-checks unchanged.
CREATE OR REPLACE FUNCTION app_stack_domains_hostname_claim() RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('hp.hostname'), hashtext(lower(NEW.hostname)));
  IF EXISTS (SELECT 1 FROM domains WHERE lower(hostname) = lower(NEW.hostname))
     OR EXISTS (SELECT 1 FROM hosts WHERE lower(hostname) = lower(NEW.hostname)) THEN
    RAISE EXCEPTION 'hostname already in use' USING ERRCODE = 'unique_violation', CONSTRAINT = 'uq_panel_hostname_claim';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_app_stack_domains_hostname_claim ON app_stack_domains;
CREATE TRIGGER trg_app_stack_domains_hostname_claim BEFORE INSERT OR UPDATE OF hostname ON app_stack_domains
  FOR EACH ROW EXECUTE FUNCTION app_stack_domains_hostname_claim();

CREATE OR REPLACE FUNCTION domains_app_stack_hostname_claim() RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('hp.hostname'), hashtext(lower(NEW.hostname)));
  IF EXISTS (SELECT 1 FROM app_stack_domains WHERE hostname = lower(NEW.hostname)) THEN
    RAISE EXCEPTION 'hostname already in use' USING ERRCODE = 'unique_violation', CONSTRAINT = 'uq_panel_hostname_claim';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_domains_app_stack_hostname_claim ON domains;
CREATE TRIGGER trg_domains_app_stack_hostname_claim BEFORE INSERT OR UPDATE OF hostname ON domains
  FOR EACH ROW EXECUTE FUNCTION domains_app_stack_hostname_claim();
