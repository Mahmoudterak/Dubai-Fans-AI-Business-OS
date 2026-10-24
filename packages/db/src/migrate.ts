/**
 * Applies pending migrations. Safe to run repeatedly: drizzle tracks applied
 * migrations in drizzle.__drizzle_migrations and never drops existing data.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { MIGRATIONS_FOLDER } from "./paths";
import { loadDotEnv } from "./load-env";

loadDotEnv();
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Run `pnpm db:local` for a local database.");
  process.exit(1);
}

const sql = postgres(url, { max: 1 });
try {
  await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_FOLDER });
  console.log("Migrations applied.");
} finally {
  await sql.end();
}
