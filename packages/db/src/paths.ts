import { fileURLToPath } from "node:url";
import path from "node:path";

export const MIGRATIONS_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);
