import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { approvalRequests, auditLogs, contentItems, contentPublications, integrationConnections } from "@dfos/db";
import {
  addContentVersion,
  createContent,
  decideApproval,
  processPublications,
  publishContent,
  publishDueContent,
  scheduleContent,
  setConnectionEnabled,
  submitContentForApproval,
  uploadMedia,
  type Ctx,
} from "@dfos/orchestrator";
import { freshDb, setupOrg } from "../helpers";
import { connectInstagram, FakeGraph, makeJpeg, memoryStorage, setMetaTestEnv } from "../meta-fake";

let t: Awaited<ReturnType<typeof freshDb>>;
let graph: FakeGraph;
beforeAll(async () => {
  setMetaTestEnv();
  t = await freshDb();
});
afterAll(() => t.close());
beforeEach(() => {
  graph = new FakeGraph();
  memoryStorage(true);
});

const deps = () => ({ client: graph.client() });

async function approvedPost(opts: { scopes?: string[]; withImage?: boolean; size?: [number, number]; connect?: boolean } = {}) {
  const s = await setupOrg(t.db);
  const ctx = (r: Parameters<typeof s.ctx>[0]): Ctx => s.ctx(r);
  const conn = opts.connect === false ? null : await connectInstagram(t.db, s.org.id, { igUserId: graph.igUserId, scopes: opts.scopes });
  const item = await createContent(ctx("member"), { title: "منشور", platform: "instagram", format: "post", body: "مروحة جديدة", hashtags: ["#دبي"], cta: "اطلبها الآن" });
  if (opts.withImage !== false) {
    const [w, h] = opts.size ?? [1080, 1080];
    const media = await uploadMedia(ctx("member"), { bytes: makeJpeg(w, h) });
    await addContentVersion(ctx("member"), item.id, { body: "مروحة جديدة", hashtags: ["#دبي"], cta: "اطلبها الآن", mediaAssetId: media.id });
  }
  const approval = await submitContentForApproval(ctx("member"), item.id);
  await decideApproval(ctx("approver"), approval.id, "approve", { fingerprint: approval.fingerprint });
  return { ...s, ctx, item, approval, connection: conn?.connection };
}

/** Runs worker rounds, skipping waits, until the publication stops moving. */
async function drain(itemId: string, rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    await t.db.update(contentPublications).set({ nextCheckAt: new Date(0) }).where(eq(contentPublications.contentItemId, itemId));
    await processPublications(t.db, deps());
  }
  const [pub] = await t.db.select().from(contentPublications).where(eq(contentPublications.contentItemId, itemId));
  const [item] = await t.db.select().from(contentItems).where(eq(contentItems.id, itemId));
  return { pub: pub!, item: item! };
}

describe("Instagram publishing", () => {
  it("happy path: container → FINISHED → media_publish → confirmed; caption and signed image URL are sent", async () => {
    const { ctx, item } = await approvedPost();
    await publishContent(ctx("approver"), item.id, deps());
    const { pub, item: after } = await drain(item.id);
    expect(pub.status).toBe("published");
    expect(pub.permalink).toContain("instagram.com/p/");
    expect(after.status).toBe("published");
    expect(graph.publishCalls).toBe(1);
    const container = [...graph.containers.values()][0]!;
    expect(container.caption).toBe("مروحة جديدة\n\nاطلبها الآن\n\n#دبي");
    expect(container.imageUrl).toMatch(/^https:\/\/storage\.test\//);
    const audit = await t.db.select().from(auditLogs).where(eq(auditLogs.targetId, item.id));
    expect(audit.map((a) => a.action)).toContain("content.published");
  });

  it("waits while Instagram is processing, then publishes", async () => {
    const { ctx, item } = await approvedPost();
    graph.nextContainerStatus = "IN_PROGRESS";
    await publishContent(ctx("approver"), item.id, deps());
    let r = await drain(item.id, 2);
    expect(r.pub.status).toBe("container_processing");
    expect(graph.publishCalls).toBe(0);
    for (const c of graph.containers.values()) c.status = "FINISHED";
    r = await drain(item.id, 2);
    expect(r.pub.status).toBe("published");
  });

  it("unknown outcome after a successful post: never publishes twice, finds the post instead", async () => {
    const { ctx, item } = await approvedPost();
    graph.publishBehaviour = ["network_after_success"];
    await publishContent(ctx("approver"), item.id, deps());
    const { pub, item: after } = await drain(item.id);
    expect(graph.publishCalls).toBe(1);
    expect(pub.status).toBe("published");
    expect(pub.externalMediaId).toBe("media_1");
    expect(after.status).toBe("published");
  });

  it("unknown outcome when nothing was posted: retries media_publish once the container is confirmed unpublished", async () => {
    const { ctx, item } = await approvedPost();
    graph.publishBehaviour = ["network_before", "ok"];
    await publishContent(ctx("approver"), item.id, deps());
    const { pub } = await drain(item.id);
    expect(graph.publishCalls).toBe(2);
    expect(pub.status).toBe("published");
    expect(graph.media.size).toBe(1);
  });

  it("a definite rejection from Meta fails without retrying", async () => {
    const { ctx, item } = await approvedPost();
    graph.publishBehaviour = ["reject"];
    await publishContent(ctx("approver"), item.id, deps());
    const { pub, item: after } = await drain(item.id);
    expect(pub.status).toBe("failed");
    expect(graph.publishCalls).toBe(1);
    expect(after.status).toBe("failed");
    expect(after.lastError?.code).toBe("meta_9007");
  });

  it("container ERROR fails the publication", async () => {
    const { ctx, item } = await approvedPost();
    graph.nextContainerStatus = "ERROR";
    await publishContent(ctx("approver"), item.id, deps());
    const { pub } = await drain(item.id);
    expect(pub.status).toBe("failed");
    expect(graph.publishCalls).toBe(0);
  });

  it("auth error marks the connection expired and fails without posting", async () => {
    const { ctx, item, connection } = await approvedPost();
    graph.publishBehaviour = ["auth"];
    await publishContent(ctx("approver"), item.id, deps());
    const { pub } = await drain(item.id);
    expect(pub.status).toBe("failed");
    expect(pub.lastError?.code).toBe("reauth_required");
    const [conn] = await t.db.select().from(integrationConnections).where(eq(integrationConnections.id, connection!.id));
    expect(conn!.status).toBe("expired");
  });

  it("waits when the 24h publishing quota is used up", async () => {
    const { ctx, item } = await approvedPost();
    graph.quota = { used: 100, total: 100 };
    await publishContent(ctx("approver"), item.id, deps());
    await processPublications(t.db, deps());
    await t.db.update(contentPublications).set({ nextCheckAt: new Date(0) }).where(eq(contentPublications.contentItemId, item.id));
    await processPublications(t.db, deps());
    const [pub] = await t.db.select().from(contentPublications).where(eq(contentPublications.contentItemId, item.id));
    expect(pub!.status).toBe("ready_to_publish");
    expect(pub!.lastError?.code).toBe("quota_reached");
    expect(pub!.nextCheckAt.getTime()).toBeGreaterThan(Date.now() + 30 * 60_000);
    expect(graph.publishCalls).toBe(0);
  });

  it("kill switch: a paused connection holds the publication before anything is created", async () => {
    const { ctx, item, connection } = await approvedPost();
    await publishContent(ctx("approver"), item.id, deps());
    await setConnectionEnabled(ctx("owner"), connection!.id, false);
    const { pub } = await drain(item.id, 2);
    expect(pub.status).toBe("queued");
    expect(pub.lastError?.code).toBe("connection_paused");
    expect(graph.containers.size).toBe(0);
    await setConnectionEnabled(ctx("owner"), connection!.id, true);
    expect((await drain(item.id)).pub.status).toBe("published");
  });
});

describe("pre-checks keep the approval unused", () => {
  const expectUnused = async (approvalId: string) => {
    const [a] = await t.db.select().from(approvalRequests).where(eq(approvalRequests.id, approvalId));
    expect(a!.status).toBe("approved");
  };

  it("no image", async () => {
    const { ctx, item, approval } = await approvedPost({ withImage: false });
    await expect(publishContent(ctx("approver"), item.id, deps())).rejects.toMatchObject({ code: "validation_failed" });
    await expectUnused(approval.id);
  });

  it("missing publish permission on the account", async () => {
    const { ctx, item, approval } = await approvedPost({ scopes: ["instagram_business_basic"] });
    await expect(publishContent(ctx("approver"), item.id, deps())).rejects.toMatchObject({ code: "integration_missing_permission" });
    await expectUnused(approval.id);
  });

  it("aspect ratio outside Instagram limits", async () => {
    const { ctx, item, approval } = await approvedPost({ size: [1000, 2000] });
    await expect(publishContent(ctx("approver"), item.id, deps())).rejects.toMatchObject({ code: "validation_failed" });
    await expectUnused(approval.id);
  });

  it("storage that Meta cannot reach (localhost)", async () => {
    memoryStorage(false);
    const { ctx, item, approval } = await approvedPost();
    await expect(publishContent(ctx("approver"), item.id, deps())).rejects.toMatchObject({ code: "storage_not_configured" });
    await expectUnused(approval.id);
  });

  it("expired authorization", async () => {
    const { ctx, item, approval, connection } = await approvedPost();
    await t.db.update(integrationConnections).set({ tokenExpiresAt: new Date(Date.now() - 1000) }).where(eq(integrationConnections.id, connection!.id));
    await expect(publishContent(ctx("approver"), item.id, deps())).rejects.toMatchObject({ code: "integration_reauth_required" });
    await expectUnused(approval.id);
  });

  it("another org's connection is never used", async () => {
    const other = await setupOrg(t.db);
    await connectInstagram(t.db, other.org.id, { igUserId: graph.igUserId });
    const { ctx, item, approval } = await approvedPost({ connect: false });
    await expect(publishContent(ctx("approver"), item.id, deps())).rejects.toMatchObject({ code: "integration_not_connected" });
    await expectUnused(approval.id);
  });

  it("scheduled publishing goes through the same checks and approval", async () => {
    const s = await setupOrg(t.db);
    await connectInstagram(t.db, s.org.id, { igUserId: graph.igUserId });
    const item = await createContent(s.ctx("member"), { title: "مجدول", platform: "instagram", format: "post", body: "نص", hashtags: [] });
    const media = await uploadMedia(s.ctx("member"), { bytes: makeJpeg(1080, 1080) });
    await addContentVersion(s.ctx("member"), item.id, { body: "نص", hashtags: [], mediaAssetId: media.id });
    await scheduleContent(s.ctx("member"), item.id, new Date(Date.now() + 120_000));
    const approval = await submitContentForApproval(s.ctx("member"), item.id);
    await decideApproval(s.ctx("approver"), approval.id, "approve", { fingerprint: approval.fingerprint });
    await t.db.update(contentItems).set({ scheduledAt: new Date(Date.now() - 1000) }).where(eq(contentItems.id, item.id));
    // Moving the time directly (not through the service) changes the fingerprint → refused at execution.
    const results = await publishDueContent(t.db, deps());
    expect(results.find((r) => r.id === item.id)?.ok).toBe(false);
    expect(graph.publishCalls).toBe(0);
  });
});
