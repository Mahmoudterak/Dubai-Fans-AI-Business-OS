import { NextResponse, type NextRequest } from "next/server";
import { getEnv } from "@dfos/config";
import { getDb } from "@dfos/db";
import { parseSignedRequest } from "@dfos/integrations";
import { revokeByExternalAccount } from "@dfos/orchestrator";

export const dynamic = "force-dynamic";

/**
 * "Deauthorize callback URL" in the Instagram app settings. Meta posts a form field
 * `signed_request` signed with the app secret. The account's token is deleted and the
 * connection marked revoked.
 */
export async function POST(req: NextRequest) {
  const secret = getEnv().META_APP_SECRET;
  if (!secret) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const form = await req.formData().catch(() => null);
  const signed = form?.get("signed_request");
  const data = typeof signed === "string" ? parseSignedRequest(signed, secret) : null;
  const userId = data?.user_id;
  if (!data || (typeof userId !== "string" && typeof userId !== "number")) {
    return NextResponse.json({ error: "invalid_signed_request" }, { status: 400 });
  }
  await revokeByExternalAccount(getDb(), String(userId), "Access removed by the user on Instagram");
  return NextResponse.json({ ok: true });
}
