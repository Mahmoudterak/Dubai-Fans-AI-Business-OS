import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** Minimal .env loader for CLI scripts (Next.js loads .env itself). Never overrides real env vars. */
export function loadDotEnv() {
  let dir = process.cwd();
  for (let i = 0; i < 4; i++) {
    const file = path.join(dir, ".env");
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (!m || !m[1]) continue;
        const value = (m[2] ?? "").replace(/^["']|["']$/g, "");
        if (process.env[m[1]] === undefined) process.env[m[1]] = value;
      }
      return file;
    }
    dir = path.dirname(dir);
  }
  return undefined;
}
