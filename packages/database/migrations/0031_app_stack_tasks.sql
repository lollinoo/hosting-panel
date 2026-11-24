-- Tasks of applications (ADR-0042). Additive: two new tables and one trigger on app_stacks that deletes rows of the
-- new tables only, so the previous release keeps running after an automatic rollback: it never names the new tables,
-- and when it deletes an application the trigger still removes what the tasks of that application left. Safe to run
-- again.

-- When a task of an application runs by itself. No row = never. Whole hours in UTC; weekday 1 (Monday) to 7 (Sunday).
-- served_slot_at: the latest time already dealt with (queued, or closed without a run). skipped_slot_at and
-- skip_reason: the latest time that was not run, and why; a run queued later for the same schedule clears them.
CREATE TABLE IF NOT EXISTS app_stack_task_schedules (
  stack_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  task_key TEXT NOT NULL CHECK (task_key ~ '^[a-z]([a-z0-9-]{0,30}[a-z0-9])?$'),
  frequency TEXT NOT NULL CHECK (frequency IN ('hourly','daily','weekly')),
  hour_utc INTEGER CHECK (hour_utc BETWEEN 0 AND 23),
  weekday INTEGER CHECK (weekday BETWEEN 1 AND 7),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  served_slot_at TIMESTAMPTZ,
  skipped_slot_at TIMESTAMPTZ,
  skip_reason TEXT CHECK (skip_reason IN ('busy','not_running','missed')),
  CONSTRAINT app_stack_task_schedules_pkey PRIMARY KEY (stack_id, task_key),
  CONSTRAINT fk_app_stack_task_schedules_stack_org FOREIGN KEY (stack_id, organization_id)
    REFERENCES app_stacks(id, organization_id) ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT ck_app_stack_task_schedules_shape CHECK (
    (frequency = 'hourly' AND hour_utc IS NULL AND weekday IS NULL)
    OR (frequency = 'daily' AND hour_utc IS NOT NULL AND weekday IS NULL)
    OR (frequency = 'weekly' AND hour_utc IS NOT NULL AND weekday IS NOT NULL)
  ),
  CONSTRAINT ck_app_stack_task_schedules_skip CHECK ((skipped_slot_at IS NULL) = (skip_reason IS NULL))
);

-- One row per run of a task. The command is not here: it is read from the template when the run begins. What the run
-- printed (masked and bounded by the executor) lives only in this row; operation_id has no FK (site_backups precedent).
CREATE TABLE IF NOT EXISTS app_stack_task_runs (
  id TEXT PRIMARY KEY CHECK (id ~ '^srun_[0-9a-f]{24}$'),
  stack_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  task_key TEXT NOT NULL CHECK (task_key ~ '^[a-z]([a-z0-9-]{0,30}[a-z0-9])?$'),
  component_key TEXT NOT NULL CHECK (component_key ~ '^[a-z]([a-z0-9-]{0,30}[a-z0-9])?$'),
  run_trigger TEXT NOT NULL CHECK (run_trigger IN ('manual','schedule')),
  requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  slot_at TIMESTAMPTZ,
  operation_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','succeeded','failed','timed_out','not_started','unknown')),
  problem TEXT
    CHECK (problem IN ('component_not_running','cannot_run_tasks','task_gone','unavailable','refused','outcome_lost','busy')),
  exit_code INTEGER CHECK (exit_code BETWEEN 0 AND 255),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  output TEXT NOT NULL DEFAULT '' CHECK (octet_length(output) <= 16384),
  output_truncated BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT uq_app_stack_task_runs_operation UNIQUE (operation_id),
  CONSTRAINT fk_app_stack_task_runs_stack_org FOREIGN KEY (stack_id, organization_id)
    REFERENCES app_stacks(id, organization_id) ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT ck_app_stack_task_runs_trigger CHECK (
    (run_trigger = 'schedule') = (slot_at IS NOT NULL) AND (run_trigger = 'manual' OR requested_by IS NULL)
  ),
  CONSTRAINT ck_app_stack_task_runs_ended CHECK ((status IN ('queued','running')) = (ended_at IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_app_stack_task_runs_task ON app_stack_task_runs (stack_id, task_key, requested_at);
-- A time of a schedule is queued at most once, whatever the writer.
CREATE UNIQUE INDEX IF NOT EXISTS uq_app_stack_task_runs_slot ON app_stack_task_runs (stack_id, task_key, slot_at)
  WHERE slot_at IS NOT NULL;

-- An application is deleted by setting deleted_at (its row stays): what its tasks left goes with it.
CREATE OR REPLACE FUNCTION app_stacks_forget_tasks() RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM app_stack_task_runs WHERE stack_id = NEW.id;
  DELETE FROM app_stack_task_schedules WHERE stack_id = NEW.id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_app_stacks_forget_tasks ON app_stacks;
CREATE TRIGGER trg_app_stacks_forget_tasks AFTER UPDATE OF deleted_at ON app_stacks
  FOR EACH ROW WHEN (NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL) EXECUTE FUNCTION app_stacks_forget_tasks();
