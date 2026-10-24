import { drizzle } from "drizzle-orm/postgres-js";
import type { PgDatabase } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { getEnv } from "@dfos/config";
import * as schema from "./schema";

export { schema };

/**
 * Driver-agnostic database type. Production uses postgres-js; tests use PGlite.
 * Transactions (`tx`) are assignable to this type too.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Database = PgDatabase<any, typeof schema>;

const globalForDb = globalThis as unknown as { __dfosDb?: Database; __dfosSql?: postgres.Sql };

export function getDb(): Database {
  if (globalForDb.__dfosDb) return globalForDb.__dfosDb;
  const url = getEnv().DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. For local development run `pnpm db:local` and copy the printed URL into .env",
    );
  }
  const sql = postgres(url, { max: 10, prepare: false });
  globalForDb.__dfosSql = sql;
  globalForDb.__dfosDb = drizzle(sql, { schema });
  return globalForDb.__dfosDb;
}

/** Inject a database (used by tests with PGlite). */
export function setDb(db: Database | undefined) {
  globalForDb.__dfosDb = db;
}

export async function closeDb() {
  await globalForDb.__dfosSql?.end({ timeout: 5 });
  globalForDb.__dfosSql = undefined;
  globalForDb.__dfosDb = undefined;
}
