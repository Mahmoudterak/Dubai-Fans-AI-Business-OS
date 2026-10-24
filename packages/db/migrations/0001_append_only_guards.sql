-- Audit trail and approval history are append-only.
-- Normal application code can INSERT but never UPDATE or DELETE these rows.
-- Deleting a whole organization (ON DELETE CASCADE) is still possible for a DB owner
-- by disabling the trigger inside a maintenance transaction; see docs/operations/runbook.md.
CREATE OR REPLACE FUNCTION dfos_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% blocked)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION dfos_block_mutation();
--> statement-breakpoint
CREATE TRIGGER approval_events_append_only
  BEFORE UPDATE OR DELETE ON approval_events
  FOR EACH ROW EXECUTE FUNCTION dfos_block_mutation();
--> statement-breakpoint
CREATE TRIGGER task_events_append_only
  BEFORE UPDATE OR DELETE ON task_events
  FOR EACH ROW EXECUTE FUNCTION dfos_block_mutation();
--> statement-breakpoint
ALTER TABLE task_dependencies
  ADD CONSTRAINT task_dependencies_no_self CHECK (task_id <> depends_on_task_id);
--> statement-breakpoint
-- An executed approval must record when it ran.
ALTER TABLE approval_requests
  ADD CONSTRAINT approval_executed_has_time
  CHECK (status <> 'executed' OR executed_at IS NOT NULL);
