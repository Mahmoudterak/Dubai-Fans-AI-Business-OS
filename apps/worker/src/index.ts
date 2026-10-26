/**
 * Background worker: runs agent tasks outside HTTP requests.
 * - Claims tasks from the Postgres queue (safe to run several workers).
 * - Recovers tasks whose worker died, expires approvals, publishes scheduled content.
 * - Stops gracefully on SIGINT/SIGTERM: finishes in-flight tasks, claims no new ones.
 */
import { hostname } from "node:os";
import { closeDb, getDb } from "@dfos/db";
import { getAiConfigStatus, getEnv, getMetaConnectStatus } from "@dfos/config";
import { createLogger } from "@dfos/observability";
import {
  claimNextTask,
  executeTask,
  expireApprovals,
  processPublications,
  processWebhookEvents,
  publishDueContent,
  recoverStaleTasks,
  refreshExpiringTokens,
} from "@dfos/orchestrator";
import { loadDotEnv } from "@dfos/db/load-env";
import { WorkerHealth } from "./health";

loadDotEnv();
const env = getEnv();
const log = createLogger({ service: "worker" }, env.LOG_LEVEL);
const workerId = `${hostname()}:${process.pid}`;
const concurrency = Math.max(1, Number(process.env.WORKER_CONCURRENCY ?? 2));
const db = getDb();

let stopping = false;
const inFlight = new Set<Promise<unknown>>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const health = new WorkerHealth(["queue", "maintenance", "integrations"]);

async function slot(n: number) {
  while (!stopping) {
    try {
      const task = await claimNextTask(db, `${workerId}#${n}`);
      health.ok("queue");
      if (!task) {
        await sleep(env.WORKER_POLL_INTERVAL_MS);
        continue;
      }
      const p = executeTask(db, task, { log });
      inFlight.add(p);
      await p.finally(() => inFlight.delete(p));
    } catch (err) {
      log.error("worker loop error", { err });
      await sleep(env.WORKER_POLL_INTERVAL_MS * 2);
    }
  }
}

async function maintenance() {
  let tick = 0;
  while (!stopping) {
    try {
      const recovered = await recoverStaleTasks(db, env.WORKER_LOCK_TIMEOUT_MS);
      const expired = await expireApprovals(db);
      const scheduled = await publishDueContent(db);
      // Token refresh is cheap to check but only needs to run occasionally.
      const refreshed = tick % 60 === 0 && getMetaConnectStatus(env).ready ? await refreshExpiringTokens(db) : 0;
      if (recovered || expired || scheduled.length || refreshed) log.info("maintenance", { recovered, expired, scheduled: scheduled.length, refreshed });
      health.ok("maintenance");
    } catch (err) {
      log.error("maintenance error", { err });
    }
    tick++;
    await sleep(30_000);
  }
}

/** Publications and webhook events move in short steps; poll them more often. */
async function integrationsLoop() {
  while (!stopping) {
    try {
      const pubs = await processPublications(db);
      const hooks = await processWebhookEvents(db);
      if (pubs.length || hooks.processed || hooks.failed || hooks.ignored) log.info("integrations", { publications: pubs, webhooks: hooks });
      health.ok("integrations");
    } catch (err) {
      log.error("integrations loop error", { err });
    }
    await sleep(5_000);
  }
}

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info("stopping worker", { signal, inFlight: inFlight.size });
  await Promise.allSettled([...inFlight]);
  await closeDb();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

const ai = getAiConfigStatus(env);
log.info("worker started", {
  workerId,
  concurrency,
  ai: ai.configured ? `${ai.provider}/${ai.model}` : `not configured (${ai.reason})`,
});
// Hosts that require an HTTP port (Render Web Service) set PORT; then /healthz reports liveness.
const port = Number(process.env.PORT ?? 0);
if (port > 0) {
  health.listen(port, () => ({ workerId, concurrency, inFlight: inFlight.size, ai: ai.configured }));
  log.info("health endpoint listening", { port, path: "/healthz" });
}
void maintenance();
void integrationsLoop();
await Promise.all(Array.from({ length: concurrency }, (_, i) => slot(i)));
