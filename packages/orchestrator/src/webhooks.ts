import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { getEnv } from "@dfos/config";
import { integrationConnections, webhookEvents, type Database } from "@dfos/db";
import { AppError } from "@dfos/domain";
import { normalizeInstagramWebhook, verifyMetaSignature } from "@dfos/integrations";
import { logger } from "@dfos/observability";
import { rowsOf } from "./context";
import { INSTAGRAM } from "./integrations";

export const MAX_WEBHOOK_BYTES = 1_000_000;
const MAX_ATTEMPTS = 5;
const LIVE = ["active", "expired", "error"] as const;

/**
 * Accepts one Meta delivery. Order: size → signature over the raw bytes → JSON → normalize
 * → store (deduplicated). Only after every event is stored does the route return 200,
 * so Meta retries if anything fails before that. Nothing is executed here.
 */
export async function ingestMetaWebhook(db: Database, rawBody: Uint8Array, signatureHeader: string | null) {
  const secret = getEnv().META_APP_SECRET;
  if (!secret) throw new AppError("integration_not_connected", "META_APP_SECRET is not configured");
  if (rawBody.byteLength > MAX_WEBHOOK_BYTES) throw new AppError("validation_failed", "Payload too large");
  if (!verifyMetaSignature(rawBody, signatureHeader, secret)) throw new AppError("signature_invalid", "Invalid webhook signature");

  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(rawBody).toString("utf8"));
  } catch {
    throw new AppError("validation_failed", "Payload is not JSON");
  }
  const events = normalizeInstagramWebhook(body);
  if (!events.length) return { received: 0, duplicates: 0, ignored: true };

  const accounts = [...new Set(events.map((e) => e.externalAccountId))];
  const connections = await db
    .select({ id: integrationConnections.id, organizationId: integrationConnections.organizationId, externalAccountId: integrationConnections.externalAccountId })
    .from(integrationConnections)
    .where(and(eq(integrationConnections.provider, INSTAGRAM), inArray(integrationConnections.externalAccountId, accounts), inArray(integrationConnections.status, [...LIVE])));

  let received = 0;
  for (const e of events) {
    const conn = connections.find((c) => c.externalAccountId === e.externalAccountId);
    const inserted = await db
      .insert(webhookEvents)
      .values({
        provider: INSTAGRAM,
        dedupeKey: e.dedupeKey,
        organizationId: conn?.organizationId,
        connectionId: conn?.id,
        externalAccountId: e.externalAccountId,
        eventType: e.eventType,
        payload: e.payload,
      })
      .onConflictDoNothing()
      .returning({ id: webhookEvents.id });
    if (inserted.length) received++;
  }
  // Counts only: payloads can contain personal data.
  logger.info("meta webhook stored", { events: events.length, received, duplicates: events.length - received });
  return { received, duplicates: events.length - received, ignored: false };
}

export type WebhookEventRow = typeof webhookEvents.$inferSelect;
/** Handler per event type. Handlers receive verified, org-scoped events only. */
export type WebhookHandler = (db: Database, event: WebhookEventRow & { organizationId: string }) => Promise<void>;

/**
 * No handlers yet: comments and messages feed the inbox/CRM, which arrive in phase 7.
 * Until then events are kept and marked "ignored" with the reason, never silently dropped.
 */
export const DEFAULT_WEBHOOK_HANDLERS: Record<string, WebhookHandler> = {};

export async function processWebhookEvents(db: Database, handlers: Record<string, WebhookHandler> = DEFAULT_WEBHOOK_HANDLERS, batch = 25) {
  // Recover events stuck in "processing" (worker died mid-way).
  await db
    .update(webhookEvents)
    .set({ status: "received" })
    .where(and(eq(webhookEvents.status, "processing"), lt(webhookEvents.nextAttemptAt, new Date(Date.now() - 10 * 60_000))));

  const res = await db.execute(sql`
    UPDATE webhook_events SET status = 'processing', attempts = attempts + 1, next_attempt_at = now()
    WHERE id IN (
      SELECT id FROM webhook_events
      WHERE status = 'received' AND next_attempt_at <= now()
      ORDER BY received_at
      FOR UPDATE SKIP LOCKED
      LIMIT ${batch}
    )
    RETURNING id
  `);
  const ids = rowsOf<{ id: string }>(res).map((r) => r.id);
  if (!ids.length) return { processed: 0, ignored: 0, failed: 0, retried: 0 };
  const rows = await db.select().from(webhookEvents).where(inArray(webhookEvents.id, ids));
  const tally = { processed: 0, ignored: 0, failed: 0, retried: 0 };

  for (const ev of rows) {
    const finish = async (status: "processed" | "ignored", note?: string) => {
      await db.update(webhookEvents).set({ status, processedAt: new Date(), lastError: note ?? null }).where(eq(webhookEvents.id, ev.id));
      tally[status]++;
    };
    if (!ev.organizationId || !ev.connectionId) {
      await finish("ignored", "unknown_account: no live connection for this Instagram account");
      continue;
    }
    const [conn] = await db.select().from(integrationConnections).where(eq(integrationConnections.id, ev.connectionId));
    if (!conn || !conn.enabled || conn.organizationId !== ev.organizationId) {
      await finish("ignored", "connection_disabled_or_missing");
      continue;
    }
    const handler = handlers[ev.eventType];
    if (!handler) {
      await finish("ignored", `no_handler: "${ev.eventType}" is stored for the inbox/CRM (phase 7)`);
      continue;
    }
    try {
      await handler(db, { ...ev, organizationId: ev.organizationId });
      await finish("processed");
    } catch (e) {
      const message = e instanceof Error ? e.message.slice(0, 300) : "handler failed";
      if (ev.attempts >= MAX_ATTEMPTS) {
        await db.update(webhookEvents).set({ status: "failed", lastError: message, processedAt: new Date() }).where(eq(webhookEvents.id, ev.id));
        tally.failed++;
      } else {
        const delay = 30_000 * 2 ** (ev.attempts - 1);
        await db
          .update(webhookEvents)
          .set({ status: "received", lastError: message, nextAttemptAt: new Date(Date.now() + delay) })
          .where(eq(webhookEvents.id, ev.id));
        tally.retried++;
      }
    }
  }
  return tally;
}
