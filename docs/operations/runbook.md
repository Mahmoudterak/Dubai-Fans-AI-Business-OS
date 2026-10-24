# Runbook

## Health

- `GET /api/v1/health` → `200 {"status":"ok","checks":{"database":"ok","ai":"configured|not_configured"}}`; `503` when the database is unreachable.
- Dashboard → "حالة النظام" shows when the worker last claimed a task. If tasks stay queued, the worker is down, the org is paused, or the agent is disabled.
- Operations Agent → "فحص الصحة" reports failed tasks (24h), stuck runs, old approvals and long-queued tasks.

## Logs

JSON lines on stdout from web and worker. Correlate with `requestId` (API) and `traceId` (task). Secrets are redacted by key name and by value pattern.

## Common problems

| Symptom | Check |
|---|---|
| Tasks stay `queued` | Worker running? `agents_paused`? Agent enabled? Dependencies succeeded? |
| Task failed `ai_not_configured` | Set `AI_PROVIDER`, `AI_GATEWAY_API_KEY`, `AI_DEFAULT_MODEL` on the worker host |
| Task failed `budget_exceeded` | Raise the task/agent/month budget in Settings, or wait for next month |
| Publish fails `integration_not_connected` | Expected until Meta is connected (phase 6) |
| Approval `approval_invalid` | Content changed, approver lost rights, or it was already used. Resubmit |

## Backups and restore

- Use the managed provider's automated backups with **point-in-time recovery** enabled (Neon/Supabase/RDS all support it). Keep at least 7 days.
- Before risky migrations, take a manual snapshot/branch.
- Restore drill (do it once before launch): restore to a new database/branch, point a preview deployment at it, check `/api/v1/health`, sign in, open a task.
- Logical export: `pg_dump --format=custom --no-owner "$DATABASE_URL" > backup.dump`; restore with `pg_restore --no-owner -d "$TARGET_URL" backup.dump`.

## Append-only tables

`audit_logs`, `approval_events` and `task_events` reject UPDATE and DELETE via triggers. Deleting an organization (GDPR-style erasure) therefore needs a deliberate maintenance step by a database owner:

```sql
BEGIN;
ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only;
ALTER TABLE approval_events DISABLE TRIGGER approval_events_append_only;
ALTER TABLE task_events DISABLE TRIGGER task_events_append_only;
DELETE FROM organizations WHERE id = '<org-id>';
ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_append_only;
ALTER TABLE approval_events ENABLE TRIGGER approval_events_append_only;
ALTER TABLE task_events ENABLE TRIGGER task_events_append_only;
COMMIT;
```

Record who ran it and why outside the database.

## Kill switches

- Whole organization: Settings → stop all agents (`agents_paused`).
- Single agent: Agents Center → stop agent (`agents.enabled = false`).
- AI spend: set the monthly AI budget in Settings (requires configured prices).
