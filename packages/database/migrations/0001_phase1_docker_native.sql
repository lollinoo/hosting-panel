-- HCP-SPEC-002 Phase 1 Docker-Native Baseline Schema Migration

CREATE TABLE IF NOT EXISTS platform_installations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  spec_version TEXT NOT NULL DEFAULT 'HCP-SPEC-002',
  phase TEXT NOT NULL DEFAULT 'phase-1',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hosts (
  id TEXT PRIMARY KEY,
  platform_installation_id TEXT NOT NULL REFERENCES platform_installations(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  hostname TEXT NOT NULL UNIQUE,
  ipv4_address TEXT NOT NULL,
  ipv6_address TEXT,
  status TEXT NOT NULL DEFAULT 'ready',
  hosting_mode TEXT NOT NULL DEFAULT 'dedicated',
  total_cpu_milli INTEGER NOT NULL,
  total_memory_bytes TEXT NOT NULL,
  total_storage_bytes TEXT NOT NULL,
  security_reviewed BOOLEAN NOT NULL DEFAULT FALSE,
  shared_approved BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  platform_installation_id TEXT NOT NULL REFERENCES platform_installations(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  user_status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  is_preset BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS permissions (
  key TEXT PRIMARY KEY,
  description TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key TEXT NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, user_id)
);

CREATE TABLE IF NOT EXISTS membership_roles (
  id TEXT PRIMARY KEY,
  membership_id TEXT NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL DEFAULT 'organization',
  scope_resource_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hosting_admin_scopes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id TEXT,
  installation_id TEXT NOT NULL REFERENCES platform_installations(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS support_access_grants (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  operator_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  approved_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permissions JSONB NOT NULL,
  reason TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS resource_grants (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  principal_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL,
  permission TEXT NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  effect TEXT NOT NULL DEFAULT 'allow',
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS host_allocations (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE RESTRICT,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  hosting_mode TEXT NOT NULL DEFAULT 'dedicated',
  dedicated_scope BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_host_allocations_id_org UNIQUE (id, organization_id)
);

CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  host_allocation_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_sites_id_org UNIQUE (id, organization_id),
  CONSTRAINT uq_sites_org_slug UNIQUE (organization_id, slug),
  CONSTRAINT fk_sites_host_allocation_org FOREIGN KEY (host_allocation_id, organization_id)
    REFERENCES host_allocations(id, organization_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS service_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  category TEXT NOT NULL,
  default_image TEXT NOT NULL,
  default_port INTEGER,
  environment_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
  default_configuration JSONB NOT NULL DEFAULT '{}'::jsonb,
  approved_for_dedicated BOOLEAN NOT NULL DEFAULT TRUE,
  approved_for_shared BOOLEAN NOT NULL DEFAULT FALSE,
  min_cpu_milli INTEGER NOT NULL DEFAULT 100,
  min_memory_bytes TEXT NOT NULL DEFAULT '134217728',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS service_instances (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  service_template_id TEXT NOT NULL REFERENCES service_templates(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  desired_status TEXT NOT NULL DEFAULT 'running',
  current_revision_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_service_instances_id_org UNIQUE (id, organization_id),
  CONSTRAINT fk_service_instances_site_org FOREIGN KEY (site_id, organization_id)
    REFERENCES sites(id, organization_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS stack_revisions (
  id TEXT PRIMARY KEY,
  service_instance_id TEXT NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  revision_number INTEGER NOT NULL,
  spec_hash TEXT NOT NULL,
  declarative_config JSONB NOT NULL,
  secret_refs JSONB NOT NULL DEFAULT '{}'::jsonb,
  resource_limits JSONB,
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_stack_revisions_service_rev UNIQUE (service_instance_id, revision_number),
  CONSTRAINT fk_stack_revisions_service_instance_org FOREIGN KEY (service_instance_id, organization_id)
    REFERENCES service_instances(id, organization_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS docker_resources (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  service_instance_id TEXT NOT NULL REFERENCES service_instances(id) ON DELETE CASCADE,
  internal_docker_ref TEXT NOT NULL,
  resource_type TEXT NOT NULL DEFAULT 'container',
  status TEXT NOT NULL DEFAULT 'running',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS observed_states (
  id TEXT PRIMARY KEY,
  service_instance_id TEXT NOT NULL UNIQUE REFERENCES service_instances(id) ON DELETE CASCADE,
  observed_status TEXT NOT NULL,
  observed_revision_hash TEXT,
  out_of_band_modified BOOLEAN NOT NULL DEFAULT FALSE,
  raw_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS domains (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  hostname TEXT NOT NULL UNIQUE,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_domains_site_org FOREIGN KEY (site_id, organization_id)
    REFERENCES sites(id, organization_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS resource_quotas (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  host_allocation_id TEXT REFERENCES host_allocations(id) ON DELETE SET NULL,
  max_sites INTEGER NOT NULL,
  max_services INTEGER NOT NULL,
  max_cpu_milli INTEGER NOT NULL,
  max_memory_bytes TEXT NOT NULL,
  max_storage_bytes TEXT NOT NULL,
  used_sites INTEGER NOT NULL DEFAULT 0,
  used_services INTEGER NOT NULL DEFAULT 0,
  used_cpu_milli INTEGER NOT NULL DEFAULT 0,
  used_memory_bytes TEXT NOT NULL DEFAULT '0',
  used_storage_bytes TEXT NOT NULL DEFAULT '0',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS quota_reservations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  resource_quota_id TEXT NOT NULL REFERENCES resource_quotas(id) ON DELETE CASCADE,
  sites INTEGER NOT NULL DEFAULT 0,
  services INTEGER NOT NULL DEFAULT 0,
  cpu_milli INTEGER NOT NULL DEFAULT 0,
  memory_bytes TEXT NOT NULL DEFAULT '0',
  storage_bytes TEXT NOT NULL DEFAULT '0',
  status TEXT NOT NULL DEFAULT 'pending',
  idempotency_key TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  requested_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  idempotency_key TEXT,
  lock_key TEXT,
  error_code TEXT,
  error_message TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS operation_steps (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS outbox_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_type TEXT NOT NULL DEFAULT 'user',
  organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  ip_address TEXT,
  user_agent TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- PostgreSQL Immutability Triggers for audit_events and stack_revisions
CREATE OR REPLACE FUNCTION prevent_audit_events_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only and immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_audit_events_mutation ON audit_events;
CREATE TRIGGER trg_prevent_audit_events_mutation
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW
EXECUTE FUNCTION prevent_audit_events_mutation();

CREATE OR REPLACE FUNCTION prevent_stack_revisions_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'stack_revisions is append-only and immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_stack_revisions_mutation ON stack_revisions;
CREATE TRIGGER trg_prevent_stack_revisions_mutation
BEFORE UPDATE OR DELETE ON stack_revisions
FOR EACH ROW
EXECUTE FUNCTION prevent_stack_revisions_mutation();
