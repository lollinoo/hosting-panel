-- HCP-SPEC-001 §6.2 & §6.3 Initial PostgreSQL Schema Migration (Idempotent)

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT NOT NULL,
  email_verified BOOLEAN NOT NULL DEFAULT TRUE,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  is_platform_admin BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT users_issuer_subject_unique UNIQUE (issuer, subject),
  CONSTRAINT users_email_unique UNIQUE (email)
);

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'customer',
  status TEXT NOT NULL DEFAULT 'active',
  primary_locale TEXT NOT NULL DEFAULT 'it-IT',
  parent_reseller_id TEXT REFERENCES organizations (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT organizations_slug_unique UNIQUE (slug)
);

CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT memberships_organization_user_unique UNIQUE (organization_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_memberships_user_id ON memberships (user_id);

CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  organization_id TEXT REFERENCES organizations (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_roles_organization_id ON roles (organization_id);

CREATE TABLE IF NOT EXISTS permissions (
  key TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  risk_level TEXT NOT NULL DEFAULT 'low'
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id TEXT NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  permission_key TEXT NOT NULL REFERENCES permissions (key) ON DELETE CASCADE,
  effect TEXT NOT NULL DEFAULT 'allow',
  CONSTRAINT role_permissions_pkey PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE IF NOT EXISTS membership_roles (
  id TEXT PRIMARY KEY,
  membership_id TEXT NOT NULL REFERENCES memberships (id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL DEFAULT 'organization',
  scope_resource_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_membership_roles_membership_id ON membership_roles (membership_id);

CREATE TABLE IF NOT EXISTS support_access_grants (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  operator_user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  approved_by_user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  permissions_json JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_access_grants_org_operator
  ON support_access_grants (organization_id, operator_user_id);

CREATE TABLE IF NOT EXISTS quota_allocations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  plan_code TEXT NOT NULL,
  servers_used INTEGER NOT NULL DEFAULT 0,
  servers_limit INTEGER NOT NULL DEFAULT 0,
  applications_used INTEGER NOT NULL DEFAULT 0,
  applications_limit INTEGER NOT NULL DEFAULT 0,
  databases_used INTEGER NOT NULL DEFAULT 0,
  databases_limit INTEGER NOT NULL DEFAULT 0,
  domains_used INTEGER NOT NULL DEFAULT 0,
  domains_limit INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT quota_allocations_organization_unique UNIQUE (organization_id)
);

CREATE TABLE IF NOT EXISTS provider_instances (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'coolify-v4',
  base_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'connected',
  version TEXT,
  capabilities_json JSONB NOT NULL,
  last_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS provider_connections (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  provider_instance_id TEXT NOT NULL REFERENCES provider_instances (id) ON DELETE RESTRICT,
  team_id TEXT NOT NULL,
  secret_ref_read TEXT NOT NULL,
  secret_ref_write TEXT,
  secret_ref_deploy TEXT,
  status TEXT NOT NULL DEFAULT 'connected',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT provider_connections_id_org_unique UNIQUE (id, organization_id)
);

CREATE INDEX IF NOT EXISTS idx_provider_connections_org_id
  ON provider_connections (organization_id);

CREATE TABLE IF NOT EXISTS server_allocations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  provider_connection_id TEXT NOT NULL,
  provider_server_id TEXT NOT NULL,
  name TEXT NOT NULL,
  region TEXT NOT NULL,
  public_ipv4 TEXT,
  status TEXT NOT NULL DEFAULT 'unknown',
  health TEXT NOT NULL DEFAULT 'unknown',
  vcpu_count INTEGER NOT NULL,
  memory_mb INTEGER NOT NULL,
  disk_gb INTEGER NOT NULL,
  last_observed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT server_allocations_id_org_unique UNIQUE (id, organization_id),
  CONSTRAINT fk_server_allocations_connection_org
    FOREIGN KEY (provider_connection_id, organization_id)
    REFERENCES provider_connections (id, organization_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_server_allocations_org_id
  ON server_allocations (organization_id);

CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  requested_by_user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  provider_operation_id TEXT,
  error_code TEXT,
  error_message TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT operations_org_kind_idempotency_unique
    UNIQUE (organization_id, kind, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_operations_org_submitted
  ON operations (organization_id, submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_operations_resource
  ON operations (organization_id, resource_id);

CREATE TABLE IF NOT EXISTS hosting_resources (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL,
  server_allocation_id TEXT NOT NULL,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  desired_state TEXT NOT NULL DEFAULT 'running',
  observed_status TEXT NOT NULL DEFAULT 'unknown',
  health TEXT NOT NULL DEFAULT 'unknown',
  observed_source TEXT NOT NULL DEFAULT 'coolify',
  last_observed_at TIMESTAMPTZ,
  locked_by_operation_id TEXT REFERENCES operations (id) ON DELETE SET NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT hosting_resources_connection_provider_unique UNIQUE (connection_id, provider_id),
  CONSTRAINT hosting_resources_id_org_unique UNIQUE (id, organization_id),
  CONSTRAINT fk_hosting_resources_connection_org
    FOREIGN KEY (connection_id, organization_id)
    REFERENCES provider_connections (id, organization_id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_hosting_resources_server_org
    FOREIGN KEY (server_allocation_id, organization_id)
    REFERENCES server_allocations (id, organization_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_hosting_resources_org_type
  ON hosting_resources (organization_id, type);

CREATE TABLE IF NOT EXISTS resource_grants (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  principal_user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL,
  permission TEXT NOT NULL REFERENCES permissions (key) ON DELETE CASCADE,
  effect TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_resource_grants_resource_org
    FOREIGN KEY (resource_id, organization_id)
    REFERENCES hosting_resources (id, organization_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_resource_grants_org_principal
  ON resource_grants (organization_id, principal_user_id);

CREATE TABLE IF NOT EXISTS applications (
  resource_id TEXT PRIMARY KEY REFERENCES hosting_resources (id) ON DELETE CASCADE,
  environment TEXT NOT NULL DEFAULT 'production',
  repository_url TEXT,
  branch TEXT,
  build_pack TEXT NOT NULL DEFAULT 'nixpacks',
  primary_domain TEXT,
  last_deployed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS databases (
  resource_id TEXT PRIMARY KEY REFERENCES hosting_resources (id) ON DELETE CASCADE,
  engine TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  storage_allocated_gb INTEGER NOT NULL,
  internal_hostname TEXT,
  port INTEGER,
  last_backup_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS deployment_records (
  id TEXT PRIMARY KEY,
  application_resource_id TEXT NOT NULL REFERENCES applications (resource_id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  operation_id TEXT REFERENCES operations (id) ON DELETE SET NULL,
  provider_deployment_id TEXT,
  commit_sha TEXT,
  image_tag TEXT,
  status TEXT NOT NULL,
  triggered_by_user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_deployment_records_resource_org
    FOREIGN KEY (application_resource_id, organization_id)
    REFERENCES hosting_resources (id, organization_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_deployment_records_app_created
  ON deployment_records (application_resource_id, created_at DESC);

CREATE TABLE IF NOT EXISTS domains (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  application_resource_id TEXT NOT NULL REFERENCES applications (resource_id) ON DELETE CASCADE,
  hostname TEXT NOT NULL,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  verification_status TEXT NOT NULL DEFAULT 'pending',
  https_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT domains_hostname_unique UNIQUE (hostname),
  CONSTRAINT domains_hostname_lowercase_check CHECK (hostname = LOWER(hostname)),
  CONSTRAINT domains_id_org_unique UNIQUE (id, organization_id),
  CONSTRAINT fk_domains_app_resource_org
    FOREIGN KEY (application_resource_id, organization_id)
    REFERENCES hosting_resources (id, organization_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_domains_org_id ON domains (organization_id);

CREATE TABLE IF NOT EXISTS certificate_observations (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL REFERENCES domains (id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  hostname TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown',
  issuer TEXT,
  valid_from TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  observed_at TIMESTAMPTZ,
  source TEXT NOT NULL DEFAULT 'coolify',
  CONSTRAINT fk_certificate_observations_domain_org
    FOREIGN KEY (domain_id, organization_id)
    REFERENCES domains (id, organization_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_certificate_observations_org_id
  ON certificate_observations (organization_id);

CREATE TABLE IF NOT EXISTS operation_steps (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operations (id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  CONSTRAINT operation_steps_operation_key_unique UNIQUE (operation_id, key)
);

CREATE INDEX IF NOT EXISTS idx_operation_steps_operation_order
  ON operation_steps (operation_id, step_order);

CREATE TABLE IF NOT EXISTS outbox_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL REFERENCES operations (id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  published_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT outbox_events_operation_unique UNIQUE (operation_id)
);

CREATE INDEX IF NOT EXISTS idx_outbox_events_pending
  ON outbox_events (published_at, created_at);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT,
  actor_user_id TEXT,
  actor_email TEXT,
  impersonated_by_user_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  outcome TEXT NOT NULL,
  request_id TEXT NOT NULL,
  ip_address TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_events_org_occurred
  ON audit_events (organization_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_events_occurred
  ON audit_events (occurred_at DESC);

-- HCP-SPEC-001 §5.4 & §12.3: Immutable Append-Only Audit Log Enforcement
CREATE OR REPLACE FUNCTION prevent_audit_events_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only and immutable; % is prohibited', TG_OP
    USING ERRCODE = '55000';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_audit_events_immutable'
  ) THEN
    CREATE TRIGGER trg_audit_events_immutable
    BEFORE UPDATE OR DELETE ON audit_events
    FOR EACH ROW
    EXECUTE FUNCTION prevent_audit_events_mutation();
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_audit_events_no_truncate'
  ) THEN
    CREATE TRIGGER trg_audit_events_no_truncate
    BEFORE TRUNCATE ON audit_events
    FOR EACH STATEMENT
    EXECUTE FUNCTION prevent_audit_events_mutation();
  END IF;
END;
$$;
