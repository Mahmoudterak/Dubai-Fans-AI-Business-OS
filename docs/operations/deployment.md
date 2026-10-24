# Deployment

Nothing in this document has been deployed yet. It describes the intended setup.

## Components

| Component | Where | Notes |
|---|---|---|
| Web (`apps/web`) | Vercel | Root directory `apps/web`; install `pnpm install --frozen-lockfile` at repo root |
| Worker (`apps/worker`) | Any always-on Node host (Railway, Render, Fly.io, a VM) | Long-running loop; not suitable for serverless functions |
| Database | Managed PostgreSQL (Neon, Supabase, RDS) | Use the pooled URL for web, direct URL for migrations; `sslmode=require` |
| Auth | Clerk | Enable MFA in the Clerk dashboard |

## Environment variables

See `.env.example` for the full list. Required in production:

- `DATABASE_URL`, `APP_BASE_URL`, `AUTH_SECRET` (32+ chars)
- `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
- Optional: `AI_PROVIDER`, `AI_GATEWAY_API_KEY`, `AI_DEFAULT_MODEL`, `AI_BASE_URL`, `AI_PRICE_*`
- Phase 6: `META_APP_ID`, `META_APP_SECRET`, `META_REDIRECT_URI`, `META_WEBHOOK_VERIFY_TOKEN`

Set them in Vercel (Production and Preview separately) and in the worker host. Never put secrets in `NEXT_PUBLIC_*`.

## Vercel

- Preview: separate database (e.g. a Neon branch) and Clerk development instance. Never point previews at production data.
- Production: production database and Clerk production instance.
- Clerk: add the production domain; sign-in path `/sign-in`.
- The CSP in `next.config.ts` allows `*.clerk.accounts.dev` and `*.clerk.com`. If you use a Clerk custom domain, add it to `script-src`, `connect-src` and `frame-src`.

## Release order

1. `pnpm db:migrate` against the target database (migrations are additive; never drop columns in the same release that stops using them).
2. Deploy the worker.
3. Deploy the web app.
4. Check `GET /api/v1/health` returns `200 {"status":"ok"}`.

## Rollback

- Web: promote the previous deployment in Vercel (instant).
- Worker: redeploy the previous build; in-flight tasks whose worker stops are recovered automatically after `WORKER_LOCK_TIMEOUT_MS`.
- Database: migrations are forward-only. Because they are additive, the previous app version keeps working against the newer schema. If a migration itself is faulty, restore from the provider's point-in-time recovery (see runbook) rather than hand-editing.
- Emergency stop: Settings → "إيقاف جميع الوكلاء" (or `PATCH /api/v1/settings {"agentsPaused": true}`) stops all agent work for an organization immediately.

## Scaling notes

- The rate limiter is in-memory per instance. With several web instances, move it to a shared store (e.g. Postgres table or Upstash).
- Several workers can run in parallel safely; increase `WORKER_CONCURRENCY` or add instances.

## Domain and redirect URLs

- `APP_BASE_URL=https://<your-domain>`
- `META_REDIRECT_URI=https://<your-domain>/api/v1/integrations/meta/callback` (phase 6)
- Webhook URL for Meta: `https://<your-domain>/api/v1/webhooks/meta` (phase 6)
