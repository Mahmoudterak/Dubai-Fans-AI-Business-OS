/**
 * Test-only helpers: an in-memory PostgreSQL (PGlite) with all migrations applied.
 * Never import this from application code.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "./schema";
import type { Database } from "./client";
import { MIGRATIONS_FOLDER } from "./paths";

export { MIGRATIONS_FOLDER };

export async function createTestDb(): Promise<{ db: Database; client: PGlite; close: () => Promise<void> }> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db: db as unknown as Database, client, close: () => client.close() };
}
