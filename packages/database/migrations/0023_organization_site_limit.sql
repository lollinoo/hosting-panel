-- Per-customer site limit. Additive: the new column is NULL (= unlimited) for every existing organization,
-- so the previous release keeps running after an automatic rollback. Safe to run again.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS max_sites INTEGER;
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_max_sites_check;
ALTER TABLE organizations ADD CONSTRAINT organizations_max_sites_check CHECK (max_sites IS NULL OR max_sites >= 0);
