# Architecture

## Shape

A **modular monolith**: one Next.js app (UI + `/api/v1`) and one **separate worker process**, sharing domain packages and one PostgreSQL database.

```
Browser ──► Next.js (apps/web)
              ├─ server components read through @dfos/orchestrator (scoped Ctx)
              └─ /api/v1 route handlers ─► route() wrapper ─► @dfos/orchestrator
                                                                 │
PostgreSQL ◄─────────────────────────────────────────────────────┤
     ▲                                                           │
     └──── apps/worker: claimNextTask → executeTask → handlers ──┘
                                     └─► @dfos/ai gateway ─► provider
```

Long work never runs inside an HTTP request: `POST /tasks` returns **202** and the worker runs the task.

## Packages

| Package | Responsibility | Depends on |
|---|---|---|
| `config` | Typed env, feature status (AI, Clerk, Meta) | zod |
| `observability` | JSON logger with secret redaction, trace ids | – |
| `domain` | Roles/permissions, task/approval/content state machines, fingerprints, `AppError`, agent catalogue | zod |
| `contracts` | Zod schemas: API bodies, per-task-type input, AI output | domain |
| `db` | Drizzle schema, migrations, client (postgres-js), PGlite test helper | config |
| `ai` | Gateway: providers, structured output, retries, timeouts, budgets, usage callback | config, observability |
| `orchestrator` | Services: tasks, approvals, content, agents, audit, dashboard, runner, handlers | all above |
| `auth` | Dev session tokens, Clerk identity mapping, org resolution | orchestrator |

## Multi-tenancy

- Every tenant table has `organization_id` (FK, cascade).
- Every service receives a `Ctx { db, organizationId, actor }` and filters by `organizationId` in every query, including lookups by id. Records of other orgs are reported as **404**, not 403, so ids cannot be probed.
- The org cookie is only a hint; membership is re-read from the database on every request.
- PostgreSQL Row-Level Security is **not enabled yet** (see ADR-004 below). Isolation is enforced in the application layer and covered by `tests/security/tenant-isolation.test.ts`.

## Task engine

States: `queued → running → succeeded`, plus `waiting_approval`, `retrying`, `failed`, `cancelled`. Transitions are validated (`domain/state-machines.ts`) and applied with compare-and-set on the current status, and each one writes a `task_events` row.

- **Claiming**: one SQL statement with `FOR UPDATE SKIP LOCKED`; skips paused orgs, disabled agents, and tasks whose dependencies have not all succeeded. Safe with several workers.
- **Retries**: retryable errors (provider 5xx/429/timeouts, invalid model output) go to `retrying` with exponential backoff until `max_attempts`; others fail immediately (`ai_not_configured`, `budget_exceeded`, validation, permission).
- **Recovery**: tasks stuck in `running` past `WORKER_LOCK_TIMEOUT_MS` are moved back to `retrying` or `failed`.
- **Dependencies**: when a task fails or is cancelled, everything depending on it is cancelled.
- **Duplicates**: `Idempotency-Key` → `tasks.idempotency_key` (unique per org). CEO subtasks use deterministic keys, so a resumed run never duplicates them.
- **Runs**: each attempt creates an `agent_runs` row: agent, task, status, start/end, duration, summary, error, model, tokens, cost, trace id.

## Approvals

1. An action that needs approval is stored as a **payload** with `fingerprint = sha256(actionType + canonical JSON(payload))`.
2. The reviewer's decision must send back the fingerprint they saw. If the live object no longer matches, the request is invalidated.
3. Before executing, `consumeApproval` re-checks: status = approved, action type, fingerprint of the *current* payload, and that the approver **still** has `approvals.decide`. It then flips `approved → executed` with a conditional update, so it succeeds once.
4. Editing content, changing its version or schedule voids open approvals and returns it to draft.
5. Agents can never decide (enforced in `requirePermission` and by RBAC).
6. Publishing checks the integration **before** consuming the approval, so a missing connection does not waste it.

Policies (`agent_policies`) default to the safest setting: approval required for publishing, external messages, ad budget changes and CEO subtask creation.

## AI gateway

- Providers: Anthropic Messages API, any OpenAI-compatible endpoint, and a mock that only runs in `NODE_ENV=test`.
- Agent instructions go in the system prompt; user and external text is wrapped in `<untrusted_input>` and the closing tag is stripped from the data. Security rules tell the model it cannot grant permissions or call tools.
- Output is parsed and validated with Zod; one repair round, then `ai_output_invalid`.
- Model output never executes anything directly. Example: the CEO plan is re-validated against the real task types, owning agents, input schemas and known content ids; invalid subtasks are dropped and listed.
- Usage is recorded for every call (including failures). Cost is stored only when per-token prices are configured; otherwise `cost_source = unknown`.
- Budgets: per task (`budget_usd`), per agent run (`max_cost_per_run_usd`), per org per month. Enforced only when prices are known.
- Agent tool use requires an `agent_tool_permissions` row (`requireTool`).

## API conventions

`apps/web/src/server/api.ts` wraps every route: session → org context → permission → same-origin check (CSRF) → rate limit → Zod body/query → idempotency → handler → `{ data, requestId }` or `{ error: { code, message, details }, requestId }`. `x-request-id` is propagated from the proxy.

## Decisions (ADR)

- **ADR-001 Modular monolith + separate worker.** One deployable web app and one worker; split later if needed.
- **ADR-002 Postgres as the queue (no Redis).** `SKIP LOCKED` is enough at this scale; one fewer paid service. Revisit if throughput needs it.
- **ADR-003 Clerk for production auth**, with a signed dev login that is impossible to enable in production or when Clerk is configured.
- **ADR-004 RLS deferred.** App-layer scoping is enforced and tested. Enabling `FORCE ROW LEVEL SECURITY` needs a non-owner DB role and `SET LOCAL app.org_id` per transaction, including in the worker; planned for phase 8.
- **ADR-005 Roles as an enum**, not a `roles` table: five fixed roles with a code-defined permission matrix are simpler and auditable. A table can be added if custom roles are needed.
- **ADR-006 Tables created per phase.** CRM, integration and media tables arrive with phases 6–7, as the spec asks not to create unused tables.
- **ADR-007 System fonts.** Avoids a build-time dependency on Google Fonts; a brand font can be self-hosted later.
