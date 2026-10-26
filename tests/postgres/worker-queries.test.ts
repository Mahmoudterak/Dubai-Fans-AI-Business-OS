/**
 * Runs the worker's background queries against a REAL PostgreSQL through the production
 * driver (postgres-js). The in-memory test database (PGlite) accepts some inputs that
 * postgres-js rejects, e.g. a Date inside a raw sql`` fragment, so these must also run here.
 *
 * Skipped unless TEST_DATABASE_URL points at a migrated database (CI sets it).
 */
import { afterAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { schema, type Database } from "@dfos/db";
import {
  claimNextTask,
  expireApprovals,
  processPublications,
  processWebhookEvents,
  publishDueContent,
  recoverStaleTasks,
  refreshExpiringTokens,
} from "@dfos/orchestrator";

const url = process.env.TEST_DATABASE_URL;
const client = url ? postgres(url, { max: 2, prepare: false }) : undefined;
const db = client ? (drizzle(client, { schema }) as unknown as Database) : undefined;
afterAll(async () => {
  await client?.end({ timeout: 5 });
});

describe.skipIf(!url)("worker queries on real PostgreSQL (postgres-js)", () => {
  it("every background loop query runs without driver errors", async () => {
    await expect(recoverStaleTasks(db!, 300_000)).resolves.toBeTypeOf("number");
    await expect(expireApprovals(db!)).resolves.toBeTypeOf("number");
    await expect(publishDueContent(db!)).resolves.toBeInstanceOf(Array);
    await expect(processPublications(db!)).resolves.toBeInstanceOf(Array);
    await expect(processWebhookEvents(db!)).resolves.toMatchObject({ processed: expect.any(Number) });
    await expect(refreshExpiringTokens(db!)).resolves.toBeTypeOf("number");
  });

  it("claiming from the queue works with the production driver", async () => {
    const claimed = await claimNextTask(db!, "pg-smoke-test");
    // Nothing should normally be queued in a test database; if something is, it was claimed correctly.
    expect(claimed === undefined || claimed.status === "running").toBe(true);
  });
});
