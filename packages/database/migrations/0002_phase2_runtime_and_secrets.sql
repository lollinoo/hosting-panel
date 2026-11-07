-- HCP-SPEC-003 Phase 2 Additive Runtime, Outbox Locks, Daemon Heartbeats & AES-256-GCM Secrets Migration

CREATE TABLE IF NOT EXISTS encrypted_secrets (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id TEXT,
  secret_key TEXT NOT NULL,
  ciphertext_base64 TEXT NOT NULL,
  iv_base64 TEXT NOT NULL,
  auth_tag_base64 TEXT NOT NULL,
  key_version TEXT NOT NULL DEFAULT 'v1',
  version INTEGER NOT NULL DEFAULT 1,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_encrypted_secrets_id_org UNIQUE (id, organization_id),
  CONSTRAINT fk_encrypted_secrets_site_org FOREIGN KEY (site_id, organization_id)
    REFERENCES sites(id, organization_id) ON DELETE CASCADE,
  CONSTRAINT chk_encrypted_secrets_non_empty CHECK (
    ciphertext_base64 <> '' AND iv_base64 <> '' AND auth_tag_base64 <> '' AND version >= 1
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_encrypted_secrets_scope_key
  ON encrypted_secrets (organization_id, COALESCE(site_id, ''), secret_key);

CREATE INDEX IF NOT EXISTS idx_encrypted_secrets_org_site
  ON encrypted_secrets (organization_id, site_id);

CREATE TABLE IF NOT EXISTS host_agent_heartbeats (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  component TEXT NOT NULL CHECK (component IN ('docker_executor', 'host_agent')),
  status TEXT NOT NULL CHECK (status IN ('online', 'degraded', 'offline')),
  version TEXT NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  telemetry_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_host_agent_heartbeats_host_component UNIQUE (host_id, component)
);

CREATE INDEX IF NOT EXISTS idx_host_agent_heartbeats_host
  ON host_agent_heartbeats (host_id);

ALTER TABLE operations ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS last_error TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_operations_active_lock
  ON operations (lock_key)
  WHERE status IN ('queued', 'processing', 'accepted', 'reconciling', 'unknown')
    AND lock_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_operations_org_idempotency
  ON operations (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
