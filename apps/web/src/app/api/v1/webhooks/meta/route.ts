import { NextResponse, type NextRequest } from "next/server";
import { getEnv } from "@dfos/config";
import { getDb } from "@dfos/db";
import { isAppError } from "@dfos/domain";
import { verifyChallenge } from "@dfos/integrations";
import { logger } from "@dfos/observability";
import { ingestMetaWebhook, MAX_WEBHOOK_BYTES } from "@dfos/orchestrator";

export const dynamic = "force-dynamic";

/** Meta's subscription handshake: echo hub.challenge only when the verify token matches. */
export function GET(req: NextRequest) {
  const challenge = verifyChallenge(req.nextUrl.searchParams, getEnv().META_WEBHOOK_VERIFY_TOKEN);
  if (!challenge) return new NextResponse("Forbidden", { status: 403 });
  return new NextResponse(challenge, { status: 200, headers: { "content-type": "text/plain" } });
}

/**
 * Event delivery. 200 is returned only after the events are stored, so Meta retries on
 * any failure. Bad signatures get 401 and are never stored. Processing happens in the worker.
 */
export async function POST(req: NextRequest) {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_WEBHOOK_BYTES) return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  const raw = new Uint8Array(await req.arrayBuffer());
  try {
    const r = await ingestMetaWebhook(getDb(), raw, req.headers.get("x-hub-signature-256"));
    return NextResponse.json({ ok: true, received: r.received, duplicates: r.duplicates });
  } catch (e) {
    if (isAppError(e)) {
      if (e.code === "signature_invalid") logger.warn("meta webhook rejected: bad signature");
      return NextResponse.json({ error: e.code }, { status: e.status === 422 ? 400 : e.status });
    }
    logger.error("meta webhook store failed", { err: e });
    // 500 makes Meta retry the delivery later.
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
