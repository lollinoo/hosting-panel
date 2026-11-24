-- 0029_notifications.sql (ADR-0040). Notifications of the alerts: the channels, what each channel was already told,
-- and the messages with their outcome.
-- Additive: three new tables and their indexes, no change to an existing table. The previous release never reads
-- them, so it keeps running on this schema after an automatic rollback. Safe to run again.

-- One channel per kind and per scope. organization_id NULL is the server's scope (the administrator's channels).
-- The address of a webhook, its signing key and a bot token live only inside the encrypted config; display_host and
-- chat are what a page may show.
CREATE TABLE IF NOT EXISTS notification_channels (
  id TEXT PRIMARY KEY,
  organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('email','webhook','telegram')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  groups JSONB NOT NULL CHECK (jsonb_typeof(groups) = 'array'),
  recipients JSONB CHECK (recipients IS NULL OR jsonb_typeof(recipients) = 'array'),
  display_host TEXT,
  chat TEXT,
  signed BOOLEAN NOT NULL DEFAULT FALSE,
  locale TEXT NOT NULL DEFAULT 'it' CHECK (locale IN ('it','en')),
  config_ciphertext_base64 TEXT,
  config_iv_base64 TEXT,
  config_auth_tag_base64 TEXT,
  config_key_version TEXT NOT NULL DEFAULT 'v1',
  last_tested_at TIMESTAMPTZ,
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Email has nothing to hide; a webhook and a bot always have their encrypted config, whole.
  CONSTRAINT ck_notification_channels_config CHECK (
    (kind = 'email') = (config_ciphertext_base64 IS NULL)
    AND (config_ciphertext_base64 IS NULL) = (config_iv_base64 IS NULL)
    AND (config_ciphertext_base64 IS NULL) = (config_auth_tag_base64 IS NULL)),
  -- Typed addresses exist only for the server's email: a customer's mail goes to the customer's owners.
  CONSTRAINT ck_notification_channels_recipients CHECK (
    recipients IS NULL OR (kind = 'email' AND organization_id IS NULL)),
  CONSTRAINT ck_notification_channels_shown CHECK (
    (kind = 'webhook') = (display_host IS NOT NULL) AND (kind = 'telegram') = (chat IS NOT NULL))
);
-- A UNIQUE over (organization_id, kind) would not hold for the server's scope, where organization_id is NULL.
CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_channels_server_kind ON notification_channels (kind)
  WHERE organization_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_channels_org_kind ON notification_channels (organization_id, kind)
  WHERE organization_id IS NOT NULL;

-- What a channel knows: one row per alert that is open for it, with the event as it was, because when the alert
-- closes it is no longer there to read. announced_at NULL: seen once, not told yet.
-- No CHECK on kind or severity: the lists live in the contracts and may grow without a migration.
CREATE TABLE IF NOT EXISTS notification_channel_alerts (
  channel_id TEXT NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
  alert_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  event JSONB NOT NULL CHECK (jsonb_typeof(event) = 'object'),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  announced_at TIMESTAMPTZ,
  PRIMARY KEY (channel_id, alert_key)
);

-- One message to one channel (for mail: to one recipient), with its events and its outcome.
-- No CHECK on problem: the list lives in the contracts.
CREATE TABLE IF NOT EXISTS notification_deliveries (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
  events JSONB NOT NULL CHECK (jsonb_typeof(events) = 'array'),
  omitted INTEGER NOT NULL DEFAULT 0 CHECK (omitted >= 0),
  opened_count INTEGER NOT NULL DEFAULT 0 CHECK (opened_count >= 0),
  closed_count INTEGER NOT NULL DEFAULT 0 CHECK (closed_count >= 0),
  test BOOLEAN NOT NULL DEFAULT FALSE,
  recipient TEXT,
  locale TEXT NOT NULL CHECK (locale IN ('it','en')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ,
  problem TEXT,
  http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  -- A message is waiting exactly while it has a next attempt and no end.
  CONSTRAINT ck_notification_deliveries_pending CHECK (
    (status = 'pending') = (finished_at IS NULL) AND (status = 'pending') = (next_attempt_at IS NOT NULL)),
  CONSTRAINT ck_notification_deliveries_sent CHECK (status <> 'sent' OR problem IS NULL),
  CONSTRAINT ck_notification_deliveries_failed CHECK (status <> 'failed' OR problem IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_due ON notification_deliveries (next_attempt_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_channel_created ON notification_deliveries (channel_id, created_at);
