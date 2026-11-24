-- Private links between a database and an application of the same customer (ADR-0039). Additive: one new table, so
-- the previous release keeps running after an automatic rollback: it never names it. Safe to run again.
--
-- A row says: the only component of provider_stack_id (a database) is, or is to be, attached to the private network of
-- consumer_stack_id. Both applications belong to organization_id: the two composite foreign keys make a link across
-- customers impossible to store. The component and the port are not stored: they are read from the database's plan
-- when the link is applied, so an upgrade of the database cannot leave a stale name here.

CREATE TABLE IF NOT EXISTS app_stack_links (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  consumer_stack_id TEXT NOT NULL,
  provider_stack_id TEXT NOT NULL,
  -- pending: not confirmed on the server yet. removing: disconnected by the customer, kept until the server confirms it.
  state TEXT NOT NULL DEFAULT 'pending' CONSTRAINT app_stack_links_state_check CHECK (state IN ('pending', 'active', 'removing')),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_app_stack_links_pair UNIQUE (consumer_stack_id, provider_stack_id),
  CONSTRAINT ck_app_stack_links_distinct CHECK (consumer_stack_id <> provider_stack_id),
  CONSTRAINT fk_app_stack_links_consumer_org FOREIGN KEY (consumer_stack_id, organization_id)
    REFERENCES app_stacks (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT fk_app_stack_links_provider_org FOREIGN KEY (provider_stack_id, organization_id)
    REFERENCES app_stacks (id, organization_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_app_stack_links_provider ON app_stack_links (provider_stack_id);
