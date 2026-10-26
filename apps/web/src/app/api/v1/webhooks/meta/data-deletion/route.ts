import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getEnv } from "@dfos/config";
import { getDb } from "@dfos/db";
import { parseSignedRequest } from "@dfos/integrations";
import { revokeByExternalAccount } from "@dfos/orchestrator";

export const dynamic = "force-dynamic";

/**
 * "Data deletion request URL". Deletes the stored token and revokes the connection, then
 * answers in the format Meta expects: { url, confirmation_code }.
 * Note: webhook events already stored for the account are kept for audit; see meta-setup.md.
 */
export async function POST(req: NextRequest) {
  const env = getEnv();
  if (!env.META_APP_SECRET) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const form = await req.formData().catch(() => null);
  const signed = form?.get("signed_request");
  const data = typeof signed === "string" ? parseSignedRequest(signed, env.META_APP_SECRET) : null;
  const userId = data?.user_id;
  if (!data || (typeof userId !== "string" && typeof userId !== "number")) {
    return NextResponse.json({ error: "invalid_signed_request" }, { status: 400 });
  }
  const code = randomUUID();
  await revokeByExternalAccount(getDb(), String(userId), `Data deletion requested (confirmation ${code})`);
  return NextResponse.json({ url: `${env.APP_BASE_URL}/data-deletion?code=${code}`, confirmation_code: code });
}
