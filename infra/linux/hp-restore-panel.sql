-- infra/linux/hp-restore-panel.sql (NEW). Runs after `hp-accounts setup`, inside psql --single-transaction. Idempotent.
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
UPDATE outbox_events SET status = 'failed', locked_at = NULL, last_error = 'Not finished when the panel copy was made'
 WHERE status IN ('pending', 'processing');
UPDATE quota_reservations SET status = 'released' WHERE status = 'pending';
UPDATE site_backups SET status = 'failed', problem = 'interrupted', finished_at = COALESCE(finished_at, now()) WHERE status = 'running';
UPDATE site_backups SET restore_status = 'failed', restore_problem = 'interrupted', restored_at = COALESCE(restored_at, now())
 WHERE restore_status = 'running';
UPDATE site_backups SET archive_operation_id = NULL, archive_status = NULL, archive_problem = NULL, archive_ready_until = NULL
 WHERE archive_status IS NOT NULL;
UPDATE backup_settings SET nightly_run_started_at = NULL WHERE nightly_run_started_at IS NOT NULL;
UPDATE sites SET status = 'degraded', updated_at = now() WHERE status IN ('deploying', 'maintenance');
DELETE FROM user_sessions;
