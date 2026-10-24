# Dubai Fans AI Business OS

منصة لإدارة الأعمال بوكلاء الذكاء الاصطناعي: وكيل تنفيذي ينسّق وكلاء متخصصين، مع محرك مهام حقيقي، ومركز موافقات بشرية، وسجل تدقيق غير قابل للتعديل، واستوديو محتوى. الواجهة عربية (RTL).

An AI-agent business operating system: a CEO agent coordinating specialist agents, a real task engine, a human approval center, an append-only audit log, and a content studio. Arabic RTL UI.

> Current state, what is done and what is not: see **[PROJECT_STATUS.md](PROJECT_STATUS.md)**.

## Stack

| Layer | Choice |
|---|---|
| Monorepo | pnpm workspaces + Turborepo |
| Web | Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4 |
| API | Route handlers under `/api/v1`, Zod validation, OpenAPI at `/api/v1/openapi` |
| Database | PostgreSQL + Drizzle ORM (migrations in `packages/db/migrations`) |
| Auth | Clerk (production, MFA) · signed dev login (development only) |
| Jobs | Separate worker process, Postgres queue (`FOR UPDATE SKIP LOCKED`), no Redis |
| AI | Provider-agnostic gateway (Anthropic or any OpenAI-compatible endpoint) |
| Tests | Vitest + PGlite (real PostgreSQL in memory) |

```
apps/web            Next.js UI + /api/v1
apps/worker         background worker (tasks, retries, recovery, scheduled publishing)
packages/config     typed environment
packages/domain     roles, permissions, state machines, fingerprints, errors
packages/contracts  Zod schemas for API input and AI output
packages/db         Drizzle schema, migrations, client
packages/ai         AI gateway (validation, retries, budgets, usage)
packages/orchestrator  tasks, approvals, content, agents, runner, audit
packages/auth       session + organization resolution
packages/observability  JSON logger with secret redaction
tests/              unit · integration · api · security
docs/               architecture and operations
```

## Run locally

Requirements: Node 22+, pnpm 11. Docker is **not** required.

```bash
pnpm install
```

```bash
cp .env.example .env
```

Set `AUTH_SECRET` in `.env` (32+ random characters). Then, in three terminals:

```bash
pnpm db:local
```

Copy the printed `DATABASE_URL` into `.env` (first run only), then:

```bash
pnpm db:migrate && pnpm db:seed
```

```bash
pnpm dev:web
```

```bash
pnpm dev:worker
```

Open http://localhost:3000, sign in as one of the seeded development users (owner / approver / member).

`pnpm db:local` runs a real PostgreSQL from the `embedded-postgres` package (data in `.data/postgres`, UTF-8). It is for development only.

### First end-to-end check

1. **Agents Center → Operations Agent → "تشغيل فحص الصحة"**: a task is created (202), the worker runs it, and the task page shows the result, the agent run and every event.
2. **Content Studio → new content → "إرسال للموافقة"** → **Approval Center → اعتماد**.
3. **"نشر الآن"** is refused with *integration not connected* until Instagram is connected (phase 6). The approval stays unused.

### AI features

Leave `AI_PROVIDER` empty and everything except AI drafting/planning works; the UI says AI is not configured. To enable:

```dotenv
AI_PROVIDER=anthropic
AI_GATEWAY_API_KEY=...        # never commit
AI_DEFAULT_MODEL=claude-sonnet-5-5
AI_PRICE_INPUT_PER_MTOK_USD=  # optional: enables cost tracking and budgets
AI_PRICE_OUTPUT_PER_MTOK_USD=
```

Or `AI_PROVIDER=openai-compatible` with `AI_BASE_URL` (e.g. Vercel AI Gateway).

## Scripts

| Command | What it does |
|---|---|
| `pnpm test` | all unit, integration, API and security tests |
| `pnpm lint` / `pnpm typecheck` | ESLint / TypeScript across the workspace |
| `pnpm build` | production build |
| `pnpm db:generate` | new migration from schema changes |
| `pnpm db:migrate` | apply pending migrations (safe to repeat) |
| `pnpm db:seed` | development org + users (refuses in production, idempotent) |

## Deploying

See [docs/operations/deployment.md](docs/operations/deployment.md) (Vercel for the web app, a long-running host for the worker, managed PostgreSQL, Clerk, Meta app setup, rollback) and [docs/operations/runbook.md](docs/operations/runbook.md).

## Security model (short)

- Every query is scoped by `organization_id`; permissions are checked on the server for every API call.
- No agent can approve anything. Sensitive actions need a human approval bound to a SHA-256 fingerprint of the exact payload; any change voids it; it can be used once; the approver's rights are re-checked at execution.
- Audit log, approval history and task events are append-only at the database level.
- Secrets live in environment/secret managers only. Logs redact tokens and keys.

Details: [docs/architecture/overview.md](docs/architecture/overview.md).
