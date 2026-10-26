import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { webhookEvents } from "@dfos/db";
import { ingestMetaWebhook, processWebhookEvents, setConnectionEnabled } from "@dfos/orchestrator";
import { freshDb, setupOrg } from "../helpers";
import { connectInstagram, setMetaTestEnv, TEST_APP_SECRET } from "../meta-fake";

let t: Awaited<ReturnType<typeof freshDb>>;
beforeAll(async () => {
  setMetaTestEnv();
  t = await freshDb();
});
afterAll(() => t.close());

const sign = (raw: Buffer, secret = TEST_APP_SECRET) => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
const body = (account: string, commentId = "c1", text = "تعليق رائع") =>
  Buffer.from(JSON.stringify({ object: "instagram", entry: [{ id: account, time: 1761300000, changes: [{ field: "comments", value: { id: commentId, text, from: { id: "u1", username: "fan" } } }] }] }));
const rand = () => `1784${Math.floor(Math.random() * 1e12)}`;

describe("Meta webhooks", () => {
  it("stores a signed event for the right organization", async () => {
    const { org } = await setupOrg(t.db);
    const account = rand();
    await connectInstagram(t.db, org.id, { igUserId: account });
    const raw = body(account);
    const r = await ingestMetaWebhook(t.db, raw, sign(raw));
    expect(r.received).toBe(1);
    const rows = await t.db.select().from(webhookEvents).where(eq(webhookEvents.externalAccountId, account));
    expect(rows[0]!.organizationId).toBe(org.id);
    expect(rows[0]!.eventType).toBe("comments");
    expect(rows[0]!.dedupeKey).toBe(`ig:${account}:comments:c1`);
  });

  it("redelivery of the same event is stored once", async () => {
    const { org } = await setupOrg(t.db);
    const account = rand();
    await connectInstagram(t.db, org.id, { igUserId: account });
    const raw = body(account, "c-dup");
    await ingestMetaWebhook(t.db, raw, sign(raw));
    const again = await ingestMetaWebhook(t.db, raw, sign(raw));
    expect(again).toMatchObject({ received: 0, duplicates: 1 });
    expect(await t.db.select().from(webhookEvents).where(eq(webhookEvents.externalAccountId, account))).toHaveLength(1);
  });

  it("rejects missing, wrong and forged signatures and stores nothing", async () => {
    const account = rand();
    const raw = body(account);
    await expect(ingestMetaWebhook(t.db, raw, null)).rejects.toMatchObject({ code: "signature_invalid" });
    await expect(ingestMetaWebhook(t.db, raw, sign(raw, "wrong-secret"))).rejects.toMatchObject({ code: "signature_invalid" });
    await expect(ingestMetaWebhook(t.db, raw, "sha256=" + "0".repeat(64))).rejects.toMatchObject({ code: "signature_invalid" });
    // Signature over different bytes (body tampered after signing).
    await expect(ingestMetaWebhook(t.db, body(account, "c1", "changed"), sign(raw))).rejects.toMatchObject({ code: "signature_invalid" });
    expect(await t.db.select().from(webhookEvents).where(eq(webhookEvents.externalAccountId, account))).toHaveLength(0);
  });

  it("rejects invalid JSON and oversized payloads; ignores unknown shapes", async () => {
    const bad = Buffer.from("{not json");
    await expect(ingestMetaWebhook(t.db, bad, sign(bad))).rejects.toMatchObject({ code: "validation_failed" });
    const huge = Buffer.alloc(1_000_001, 32);
    await expect(ingestMetaWebhook(t.db, huge, sign(huge))).rejects.toMatchObject({ code: "validation_failed" });
    const other = Buffer.from(JSON.stringify({ object: "page", entry: [] }));
    expect(await ingestMetaWebhook(t.db, other, sign(other))).toMatchObject({ received: 0, ignored: true });
  });

  it("events for unknown accounts are kept but never processed for any org", async () => {
    const account = rand();
    const raw = body(account, "orphan");
    await ingestMetaWebhook(t.db, raw, sign(raw));
    await processWebhookEvents(t.db, { comments: async () => { throw new Error("must not run"); } });
    const [row] = await t.db.select().from(webhookEvents).where(eq(webhookEvents.externalAccountId, account));
    expect(row!.organizationId).toBeNull();
    expect(row!.status).toBe("ignored");
  });

  it("worker processes with a handler, retries failures, and gives up after 5 attempts", async () => {
    const { org } = await setupOrg(t.db);
    const account = rand();
    await connectInstagram(t.db, org.id, { igUserId: account });
    const ok = body(account, "ok-1");
    const fail = body(account, "fail-1");
    await ingestMetaWebhook(t.db, ok, sign(ok));
    await ingestMetaWebhook(t.db, fail, sign(fail));
    const seen: string[] = [];
    const handlers = {
      comments: async (_db: unknown, ev: { dedupeKey: string; organizationId: string }) => {
        expect(ev.organizationId).toBe(org.id);
        if (ev.dedupeKey.endsWith("fail-1")) throw new Error("downstream unavailable");
        seen.push(ev.dedupeKey);
      },
    };
    for (let i = 0; i < 6; i++) {
      await t.db.update(webhookEvents).set({ nextAttemptAt: new Date(0) }).where(eq(webhookEvents.externalAccountId, account));
      await processWebhookEvents(t.db, handlers);
    }
    const rows = await t.db.select().from(webhookEvents).where(eq(webhookEvents.externalAccountId, account));
    const byKey = Object.fromEntries(rows.map((r) => [r.dedupeKey.split(":").pop(), r]));
    expect(byKey["ok-1"]!.status).toBe("processed");
    expect(byKey["fail-1"]!.status).toBe("failed");
    expect(byKey["fail-1"]!.attempts).toBe(5);
    expect(seen).toHaveLength(1);
  });

  it("events of a paused connection are not acted on; without a handler they are kept as ignored", async () => {
    const s = await setupOrg(t.db);
    const account = rand();
    const { connection } = await connectInstagram(t.db, s.org.id, { igUserId: account });
    await setConnectionEnabled(s.ctx("owner"), connection.id, false);
    const raw = body(account, "paused");
    await ingestMetaWebhook(t.db, raw, sign(raw));
    await processWebhookEvents(t.db, { comments: async () => { throw new Error("must not run"); } });
    const [row] = await t.db.select().from(webhookEvents).where(eq(webhookEvents.externalAccountId, account));
    expect(row!.status).toBe("ignored");
    expect(row!.lastError).toMatch(/connection_disabled/);
  });

  it("a database failure surfaces as an error (the route then answers 500 and Meta retries)", async () => {
    const down = () => {
      throw new Error("connection terminated");
    };
    const brokenDb = { select: down, insert: down, update: down, execute: down } as unknown as typeof t.db;
    const raw = body(rand());
    await expect(ingestMetaWebhook(brokenDb, raw, sign(raw))).rejects.toThrow(/connection terminated/);
  });
});
