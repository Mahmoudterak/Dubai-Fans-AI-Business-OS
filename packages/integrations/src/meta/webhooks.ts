import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson, sha256 } from "@dfos/domain";

/** Meta signs the raw request body with HMAC-SHA256 using the app secret: "sha256=<hex>". */
export function verifyMetaSignature(rawBody: Uint8Array, header: string | null, appSecret: string): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const given = Buffer.from(header.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** GET verification handshake. Returns the challenge to echo, or null to reject (403). */
export function verifyChallenge(params: URLSearchParams, verifyToken: string | undefined): string | null {
  if (!verifyToken) return null;
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token") ?? "";
  const challenge = params.get("hub.challenge");
  if (mode !== "subscribe" || !challenge) return null;
  const a = Buffer.from(token);
  const b = Buffer.from(verifyToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return /^[A-Za-z0-9_-]{1,128}$/.test(challenge) ? challenge : null;
}

export interface NormalizedWebhookEvent {
  externalAccountId: string;
  eventType: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
}

/**
 * Splits a delivery into one event per change/message.
 * Meta does not give every notification type a unique event id, so the dedupe key is:
 *  - messaging: the message id (`message.mid`) when present,
 *  - changes with an object id in `value.id` (e.g. comments): field + that id,
 *  - otherwise: a hash of account id + event time + field + canonical value.
 * A redelivery of the same notification therefore maps to the same key.
 */
export function normalizeInstagramWebhook(body: unknown): NormalizedWebhookEvent[] {
  if (!body || typeof body !== "object") return [];
  const b = body as { object?: unknown; entry?: unknown };
  if (b.object !== "instagram" && b.object !== "user") return [];
  if (!Array.isArray(b.entry)) return [];
  const out: NormalizedWebhookEvent[] = [];
  for (const entry of b.entry.slice(0, 1000)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { id?: unknown; time?: unknown; changes?: unknown; messaging?: unknown };
    const account = e.id !== undefined ? String(e.id) : "";
    if (!account || account.length > 64) continue;
    if (Array.isArray(e.changes)) {
      for (const change of e.changes) {
        const c = change as { field?: unknown; value?: unknown };
        if (typeof c?.field !== "string") continue;
        const value = (c.value ?? {}) as Record<string, unknown>;
        const objectId = typeof value.id === "string" || typeof value.id === "number" ? String(value.id) : null;
        const dedupeKey = objectId
          ? `ig:${account}:${c.field}:${objectId}`
          : `ig:${account}:${c.field}:h:${sha256(canonicalJson({ t: e.time ?? null, v: value }))}`;
        out.push({ externalAccountId: account, eventType: c.field, dedupeKey, payload: { field: c.field, time: e.time ?? null, value } });
      }
    }
    if (Array.isArray(e.messaging)) {
      for (const m of e.messaging) {
        const msg = m as Record<string, unknown>;
        const mid = (msg.message as { mid?: unknown } | undefined)?.mid;
        const kind = msg.message ? "messages" : msg.reaction ? "message_reactions" : msg.read ? "messaging_seen" : "messaging";
        const dedupeKey =
          typeof mid === "string" ? `ig:${account}:${kind}:${mid}` : `ig:${account}:${kind}:h:${sha256(canonicalJson(msg))}`;
        out.push({ externalAccountId: account, eventType: kind, dedupeKey, payload: msg });
      }
    }
  }
  return out;
}

/**
 * Meta `signed_request` (deauthorize / data deletion callbacks):
 * "<base64url HMAC-SHA256(payload, app secret)>.<base64url JSON payload>".
 */
export function parseSignedRequest(signedRequest: string, appSecret: string): Record<string, unknown> | null {
  const [sig, payload] = signedRequest.split(".", 2);
  if (!sig || !payload) return null;
  const expected = createHmac("sha256", appSecret).update(payload).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    if (data.algorithm && String(data.algorithm).toUpperCase() !== "HMAC-SHA256") return null;
    return data;
  } catch {
    return null;
  }
}
