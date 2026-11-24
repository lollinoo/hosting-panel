-- An address of an application being removed (issue #112): the row stays, and keeps claiming its host name through the
-- 0025 triggers, until a route file without it is published; then it is deleted. Additive: the column is NULL on every
-- existing address (none is being removed). The previous release, after an automatic rollback, reads a marked address
-- as a live one and publishes it again. Safe to run again.
ALTER TABLE app_stack_domains ADD COLUMN IF NOT EXISTS removal_requested_at TIMESTAMPTZ;
