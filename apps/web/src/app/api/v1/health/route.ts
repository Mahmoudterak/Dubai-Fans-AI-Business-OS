import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { getAiConfigStatus } from "@dfos/config";
import { getDb } from "@dfos/db";

export const dynamic = "force-dynamic";

/** Liveness/readiness probe. Public, returns no tenant data. */
export async function GET() {
  const started = Date.now();
  let database: "ok" | "error" = "ok";
  try {
    await getDb().execute(sql`select 1`);
  } catch {
    database = "error";
  }
  const ai = getAiConfigStatus();
  const body = {
    status: database === "ok" ? "ok" : "degraded",
    checks: { database, ai: ai.configured ? "configured" : "not_configured" },
    latencyMs: Date.now() - started,
    time: new Date().toISOString(),
  };
  return NextResponse.json(body, { status: database === "ok" ? 200 : 503 });
}
