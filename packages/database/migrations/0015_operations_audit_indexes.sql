CREATE INDEX IF NOT EXISTS idx_operations_org_submitted ON operations (organization_id, submitted_at);
CREATE INDEX IF NOT EXISTS idx_audit_events_timestamp_id ON audit_events (timestamp, id);
ALTER TABLE host_agent_heartbeats DROP CONSTRAINT IF EXISTS host_agent_heartbeats_component_check;
ALTER TABLE host_agent_heartbeats ADD CONSTRAINT host_agent_heartbeats_component_check
  CHECK (component IN ('docker_executor', 'host_agent', 'panel_containers', 'panel_certificate'));
