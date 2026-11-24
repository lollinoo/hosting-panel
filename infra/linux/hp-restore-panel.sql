-- infra/linux/hp-restore-panel.sql (NEW). Runs after `hp-accounts setup`, inside psql --single-transaction. Idempotent.
-- Copies of the panel backup being restored: resolved while the operation is still open (the generic close below
-- ignores them). One copy row with a recorded snapshot = that copy is the backup we restored from. A copy without a
-- snapshot id cannot be 'succeeded' (ck_panel_backup_copies_snapshot), and two copies cannot be told apart: 'unknown'.
UPDATE panel_backup_copies c
   SET status = CASE WHEN c.snapshot_id IS NOT NULL
                      AND (SELECT count(*) FROM panel_backup_copies x WHERE x.operation_id = c.operation_id) = 1
                     THEN 'succeeded' ELSE 'unknown' END,
       finished_at = COALESCE(c.finished_at, now())
 WHERE c.status = 'running'
   AND c.operation_id IN (SELECT id FROM operations WHERE kind = 'panel.backups.create'
                             AND status IN ('queued', 'processing', 'accepted', 'reconciling', 'unknown'));
UPDATE operation_steps SET status = 'succeeded', completed_at = COALESCE(completed_at, now())
 WHERE status IN ('pending', 'running', 'unknown')
   AND operation_id IN (SELECT id FROM operations WHERE kind = 'panel.backups.create'
                           AND status IN ('queued', 'processing', 'accepted', 'reconciling', 'unknown'));
UPDATE backup_settings
   SET last_panel_backup_at = o.started_at, last_panel_backup_status = 'succeeded', last_panel_backup_problem = NULL
  FROM operations o
 WHERE o.kind = 'panel.backups.create' AND o.status IN ('queued', 'processing', 'accepted', 'reconciling', 'unknown')
   AND o.started_at IS NOT NULL;
UPDATE operations SET status = 'succeeded', lease_expires_at = NULL, completed_at = now(), updated_at = now()
 WHERE kind = 'panel.backups.create' AND status IN ('queued', 'processing', 'accepted', 'reconciling', 'unknown');
UPDATE operation_steps SET status = CASE WHEN status = 'pending' THEN 'cancelled' ELSE 'failed' END,
       message = COALESCE(message, 'Not finished when the panel copy was made'), completed_at = COALESCE(completed_at, now())
 WHERE status IN ('pending', 'running', 'unknown')
   AND operation_id IN (SELECT id FROM operations WHERE status IN ('queued', 'processing', 'accepted', 'reconciling', 'unknown'));
UPDATE operations SET status = 'failed', error_code = 'OPERATION_INTERRUPTED',
       error_message = 'Not finished when the panel copy was made', lease_expires_at = NULL, completed_at = now(), updated_at = now()
 WHERE status IN ('queued', 'processing', 'accepted', 'reconciling', 'unknown');
UPDATE panel_backup_copies SET status = 'failed', problem = 'interrupted', finished_at = COALESCE(finished_at, now())
 WHERE status = 'running';
UPDATE outbox_events SET status = 'failed', locked_at = NULL, last_error = 'Not finished when the panel copy was made'
 WHERE status IN ('pending', 'processing');
UPDATE quota_reservations SET status = 'released' WHERE status = 'pending';
UPDATE site_backups SET status = 'failed', problem = 'interrupted', finished_at = COALESCE(finished_at, now()) WHERE status = 'running';
UPDATE site_backup_copies SET status = 'failed', problem = 'interrupted', finished_at = COALESCE(finished_at, now())
 WHERE status = 'running';
UPDATE site_backups SET restore_status = 'failed', restore_problem = 'interrupted', restored_at = COALESCE(restored_at, now())
 WHERE restore_status = 'running';
UPDATE site_backups SET archive_operation_id = NULL, archive_target_id = NULL, archive_status = NULL, archive_problem = NULL, archive_ready_until = NULL
 WHERE archive_status IS NOT NULL;
UPDATE backup_settings SET nightly_run_started_at = NULL WHERE nightly_run_started_at IS NOT NULL;
UPDATE backup_policies SET nightly_run_started_at = NULL WHERE nightly_run_started_at IS NOT NULL;
-- Manual certificates: the files do not exist on the new host. An interrupted apply is failed (active stays active);
-- generation 0 makes the API/executor re-materialise every active version at start.
UPDATE tls_certificate_versions SET status = 'failed', last_error_code = 'interrupted' WHERE status = 'applying';
UPDATE tls_publish_state SET confirmed_generation = 0 WHERE confirmed_generation <> 0;
-- No stale "healthy" for a folder that may not be mounted on the new host (the target stays enabled).
UPDATE backup_targets SET last_test_at = NULL, last_test_outcome = NULL, last_test_problem = NULL,
       last_test_available_bytes = NULL, last_test_total_bytes = NULL
 WHERE kind = 'local';
UPDATE sites SET status = 'degraded', updated_at = now() WHERE status IN ('deploying', 'maintenance');
-- Application stacks: the new host has no containers, volumes or routes. Revisions, secrets and deleted stacks stay.
UPDATE app_stack_deployments SET status = 'failed', problem = 'OPERATION_INTERRUPTED', ended_at = COALESCE(ended_at, now())
 WHERE status IN ('queued','running','unknown');
UPDATE app_stack_components SET health = 'missing', health_observed_at = NULL, updated_at = now() WHERE health <> 'missing';
UPDATE app_stack_volumes SET status = 'missing', updated_at = now() WHERE status IN ('pending','present','retained');
UPDATE app_stack_domains SET status = 'pending', cert_status = 'none', cert_expires_at = NULL, dns_next_check_at = now(),
       updated_at = now() WHERE status <> 'pending' OR cert_status <> 'none';
UPDATE app_stacks SET status = 'delete_failed', applied_routes_hash = NULL, applied_addresses_hash = NULL, updated_at = now()
 WHERE status = 'deleting';
UPDATE app_stacks SET status = 'failed', applied_routes_hash = NULL, applied_addresses_hash = NULL, updated_at = now()
 WHERE deleted_at IS NULL AND status NOT IN ('draft','failed','delete_failed','deleting');
DELETE FROM user_sessions;
