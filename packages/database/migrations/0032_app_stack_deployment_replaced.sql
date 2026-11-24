-- What a stack operation's request replaced (issue #92), so an operation that changed nothing on the server puts back
-- exactly that. Additive: the new column is NULL on every existing deployment (nothing to put back), so the previous
-- release keeps running after an automatic rollback. Safe to run again.
ALTER TABLE app_stack_deployments ADD COLUMN IF NOT EXISTS replaced_revision_id TEXT;
ALTER TABLE app_stack_deployments DROP CONSTRAINT IF EXISTS fk_app_stack_deployments_replaced_revision;
ALTER TABLE app_stack_deployments ADD CONSTRAINT fk_app_stack_deployments_replaced_revision FOREIGN KEY (replaced_revision_id, stack_id)
  REFERENCES app_stack_revisions(id, stack_id) ON UPDATE NO ACTION ON DELETE NO ACTION;
