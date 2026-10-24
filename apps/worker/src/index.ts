/**
 * Background worker: runs agent tasks outside HTTP requests.
 * - Claims tasks from the Postgres queue (safe to run several workers).
 * - Recovers tasks whose worker died, expires approvals, publishes scheduled content.
 * - Stops gracefully on SIGINT/SIGTERM: finishes in-flight tasks, claims no new ones.
 */
import { hostname } from "node:os";
import { closeDb, getDb } from "@dfos/db";
import { getAiConfigStatus, getEnv } from "@dfos/config";
import { createLogger } from "@dfos/observability";
import {
  claimNextTask,
  executeTask,
  expireApprovals,
  publishDueContent,
  recoverStaleTasks,
} from "@dfos/orchestrator";
import { loadDotEnv } from "@dfos/db/load-env";

loadDotEnv();
const env = getEnv();
const log = createLogger({ service: "worker" }, env.LOG_LEVEL);
const workerId = `${hostname()}:${process.pid}`;
const concurrency = Math.max(1, Number(process.env.WORKER_CONCURRENCY ?? 2));
const db = getDb();

let stopping = false;
const inFlight = new Set<Promise<unknown>>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function slot(n: number) {
  while (!stopping) {
    try {
      const task = await claimNextTask(db, `${workerId}#${n}`);
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
  while (!stopping) {
    try {
      const recovered = await recoverStaleTasks(db, env.WORKER_LOCK_TIMEOUT_MS);
      const expired = await expireApprovals(db);
      const published = await publishDueContent(db);
      if (recovered || expired || published.length) log.info("maintenance", { recovered, expired, published });
    } catch (err) {
      log.error("maintenance error", { err });
    }
    await sleep(30_000);
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
void maintenance();
await Promise.all(Array.from({ length: concurrency }, (_, i) => slot(i)));
