#!/usr/bin/env node
/**
 * DEVELOPMENT ONLY: runs a real PostgreSQL server locally without Docker,
 * using the `embedded-postgres` binaries. Data lives in .data/postgres (git-ignored).
 * Production must use a managed PostgreSQL (e.g. Neon, Supabase, RDS).
 */
import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "node:fs";
import path from "node:path";

const port = Number(process.env.LOCAL_PG_PORT ?? 54329);
const dataDir = path.resolve(".data/postgres");
const firstRun = !existsSync(path.join(dataDir, "PG_VERSION"));

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: "dfos",
  password: "dfos_local_only",
  port,
  persistent: true,
  // UTF-8 regardless of the OS locale (Windows defaults to WIN1252, which breaks Arabic text).
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
  onLog: () => {},
});

if (firstRun) {
  console.log("Initialising local PostgreSQL data directory…");
  await pg.initialise();
}
await pg.start();
if (firstRun) await pg.createDatabase("dfos");

console.log(`\nLocal PostgreSQL is running on port ${port}.`);
console.log(`DATABASE_URL=postgres://dfos:dfos_local_only@127.0.0.1:${port}/dfos\n`);
console.log("Press Ctrl+C to stop.");

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 1 << 30);
