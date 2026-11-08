-- Deleting a site cascades to its services and their revisions. Revisions stay immutable
-- (and a direct DELETE still fails) unless the parent service no longer exists, which is
-- only true while a cascade from service_instances, sites or organizations is running.
CREATE OR REPLACE FUNCTION prevent_stack_revisions_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND NOT EXISTS (SELECT 1 FROM service_instances WHERE id = OLD.service_instance_id) THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.organization_id IS DISTINCT FROM OLD.organization_id
     AND (NEW.id, NEW.service_instance_id, NEW.revision_number, NEW.spec_hash, NEW.declarative_config,
          NEW.secret_refs, NEW.resource_limits, NEW.author_id, NEW.created_at)
         IS NOT DISTINCT FROM
         (OLD.id, OLD.service_instance_id, OLD.revision_number, OLD.spec_hash, OLD.declarative_config,
          OLD.secret_refs, OLD.resource_limits, OLD.author_id, OLD.created_at) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'stack_revisions is append-only and immutable';
END;
$$ LANGUAGE plpgsql;
