import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { approvalRequests, contentItems, contentPublications, organizationMembers, organizations } from "@dfos/db";
import {
  addContentVersion,
  consumeApproval,
  createContent,
  decideApproval,
  getApproval,
  loadContentPublishPayload,
  processPublications,
  publishContent,
  scheduleContent,
  submitContentForApproval,
  uploadMedia,
  CONTENT_PUBLISH_ACTION,
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

const draft = { title: "إطلاق مروحة جديدة", platform: "instagram" as const, format: "post" as const, body: "مروحة جديدة لصيف دبي", hashtags: ["دبي", "#صيف"] };

async function withImage(ctx: Ctx) {
  const item = await createContent(ctx, draft);
  const media = await uploadMedia(ctx, { bytes: makeJpeg(1080, 1080), name: "fan.jpg" });
  await addContentVersion(ctx, item.id, { body: draft.body, hashtags: draft.hashtags, mediaAssetId: media.id });
  return item;
}
async function submitted(ctx: Ctx) {
  const item = await withImage(ctx);
  const approval = await submitContentForApproval(ctx, item.id);
  return { item, approval };
}
const deps = () => ({ client: graph.client() });

describe("approval center", () => {
  it("approve → publish once (confirmed by Instagram); a second publish is refused", async () => {
    const { ctx, org } = await setupOrg(t.db);
    await connectInstagram(t.db, org.id, { igUserId: graph.igUserId });
    const { item, approval } = await submitted(ctx("member"));
    expect(approval.status).toBe("pending");
    await decideApproval(ctx("approver"), approval.id, "approve", { fingerprint: approval.fingerprint });

    const started = await publishContent(ctx("approver"), item.id, deps());
    expect(started.status).toBe("publishing");
    let [row] = await t.db.select().from(contentItems).where(eq(contentItems.id, item.id));
    expect(row!.status).toBe("publishing"); // not "published" before Instagram confirms

    await processPublications(t.db, deps()); // container
    await t.db.update(contentPublications).set({ nextCheckAt: new Date(0) }).where(eq(contentPublications.contentItemId, item.id));
    await processPublications(t.db, deps()); // status FINISHED → publish → confirm
    [row] = await t.db.select().from(contentItems).where(eq(contentItems.id, item.id));
    expect(row!.status).toBe("published");
    expect(row!.externalPostId).toBe("media_1");
    expect(graph.publishCalls).toBe(1);

    await expect(publishContent(ctx("approver"), item.id, deps())).rejects.toMatchObject({ code: "approval_required" });
    expect(graph.publishCalls).toBe(1);
    const detail = await getApproval(ctx("approver"), approval.id);
    expect(detail.approval.status).toBe("executed");
    expect(detail.events.map((e) => e.type)).toEqual(["requested", "approved", "executed"]);
  });

  it("cannot publish before approval", async () => {
    const { ctx, org } = await setupOrg(t.db);
    await connectInstagram(t.db, org.id, { igUserId: graph.igUserId });
    const { item } = await submitted(ctx("member"));
    await expect(publishContent(ctx("owner"), item.id, deps())).rejects.toMatchObject({ code: "approval_required" });
    expect(graph.publishCalls).toBe(0);
  });

  it("editing approved content voids the approval and requires a new one", async () => {
    const { ctx, org } = await setupOrg(t.db);
    await connectInstagram(t.db, org.id, { igUserId: graph.igUserId });
    const { item, approval } = await submitted(ctx("member"));
    await decideApproval(ctx("approver"), approval.id, "approve", { fingerprint: approval.fingerprint });

    const edit = await addContentVersion(ctx("member"), item.id, { body: "نص معدّل بعد الموافقة", hashtags: [] });
    expect(edit.approvalsInvalidated).toBe(1);
    const [row] = await t.db.select().from(contentItems).where(eq(contentItems.id, item.id));
    expect(row!.status).toBe("draft");
    await expect(publishContent(ctx("approver"), item.id, deps())).rejects.toMatchObject({ code: "approval_required" });

    const second = await submitContentForApproval(ctx("member"), item.id);
    expect(second.fingerprint).not.toBe(approval.fingerprint);
  });

  it("text edits keep the image; replacing the image changes the fingerprint", async () => {
    const { ctx } = await setupOrg(t.db);
    const item = await withImage(ctx("member"));
    const before = await loadContentPublishPayload(t.db, ctx("member").organizationId, item.id);
    await addContentVersion(ctx("member"), item.id, { body: "نص جديد", hashtags: [] });
    const afterText = await loadContentPublishPayload(t.db, ctx("member").organizationId, item.id);
    expect(afterText.version.mediaAssetId).toBe(before.version.mediaAssetId);
    const other = await uploadMedia(ctx("member"), { bytes: makeJpeg(1080, 1350), name: "b.jpg" });
    await addContentVersion(ctx("member"), item.id, { body: "نص جديد", hashtags: [], mediaAssetId: other.id });
    const afterImage = await loadContentPublishPayload(t.db, ctx("member").organizationId, item.id);
    expect((afterImage.payload.media as { sha256: string }).sha256).not.toBe((afterText.payload.media as { sha256: string }).sha256);
  });

  it("changing the schedule voids the approval", async () => {
    const { ctx } = await setupOrg(t.db);
    const { item, approval } = await submitted(ctx("member"));
    await decideApproval(ctx("approver"), approval.id, "approve", { fingerprint: approval.fingerprint });
    const r = await scheduleContent(ctx("member"), item.id, new Date(Date.now() + 3600_000));
    expect(r.approvalsInvalidated).toBe(1);
  });

  it("decision must reference the reviewed fingerprint", async () => {
    const { ctx } = await setupOrg(t.db);
    const { approval } = await submitted(ctx("member"));
    await expect(decideApproval(ctx("approver"), approval.id, "approve", { fingerprint: "0".repeat(64) })).rejects.toMatchObject({ code: "approval_invalid" });
  });

  it("content changed while pending → approving is refused and the request is invalidated", async () => {
    const { ctx } = await setupOrg(t.db);
    const { item, approval } = await submitted(ctx("member"));
    await t.db.update(contentItems).set({ audience: "جمهور مختلف" }).where(eq(contentItems.id, item.id));
    await expect(decideApproval(ctx("approver"), approval.id, "approve", { fingerprint: approval.fingerprint })).rejects.toMatchObject({ code: "approval_invalid" });
    const [row] = await t.db.select().from(approvalRequests).where(eq(approvalRequests.id, approval.id));
    expect(row!.status).toBe("invalidated");
  });

  it("members and viewers cannot decide; agents cannot decide", async () => {
    const { ctx } = await setupOrg(t.db);
    const { approval } = await submitted(ctx("member"));
    for (const role of ["member", "viewer"] as const) {
      await expect(decideApproval(ctx(role), approval.id, "approve", { fingerprint: approval.fingerprint })).rejects.toMatchObject({ code: "forbidden" });
    }
    const agentCtx = { ...ctx("member"), actor: { type: "agent" as const, agentKey: "ceo" } };
    await expect(decideApproval(agentCtx, approval.id, "approve", { fingerprint: approval.fingerprint })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("a rejected approval cannot be approved later", async () => {
    const { ctx } = await setupOrg(t.db);
    const { approval } = await submitted(ctx("member"));
    await decideApproval(ctx("approver"), approval.id, "reject", { fingerprint: approval.fingerprint, note: "لا" });
    await expect(decideApproval(ctx("owner"), approval.id, "approve", { fingerprint: approval.fingerprint })).rejects.toMatchObject({ code: "invalid_transition" });
  });

  it("approver demoted before execution → approval is no longer valid", async () => {
    const { ctx, users, org } = await setupOrg(t.db);
    await connectInstagram(t.db, org.id, { igUserId: graph.igUserId });
    const { item, approval } = await submitted(ctx("member"));
    await decideApproval(ctx("approver"), approval.id, "approve", { fingerprint: approval.fingerprint });
    await t.db.update(organizationMembers).set({ role: "viewer" }).where(eq(organizationMembers.userId, users.approver.id));
    await expect(publishContent(ctx("owner"), item.id, deps())).rejects.toMatchObject({ code: "approval_invalid" });
    expect(graph.publishCalls).toBe(0);
  });

  it("consuming the same approval twice in parallel succeeds once", async () => {
    const { ctx } = await setupOrg(t.db);
    const { item, approval } = await submitted(ctx("member"));
    await decideApproval(ctx("approver"), approval.id, "approve", { fingerprint: approval.fingerprint });
    const { payload } = await loadContentPublishPayload(t.db, ctx("member").organizationId, item.id);
    const args = { organizationId: ctx("member").organizationId, approvalId: approval.id, actionType: CONTENT_PUBLISH_ACTION, currentPayload: payload, executor: { type: "system" as const, name: "t" } };
    const results = await Promise.allSettled([consumeApproval(t.db, args), consumeApproval(t.db, args)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("parallel publish requests create one publication only", async () => {
    const { ctx, org } = await setupOrg(t.db);
    await connectInstagram(t.db, org.id, { igUserId: graph.igUserId });
    const { item, approval } = await submitted(ctx("member"));
    await decideApproval(ctx("approver"), approval.id, "approve", { fingerprint: approval.fingerprint });
    const results = await Promise.allSettled([publishContent(ctx("approver"), item.id, deps()), publishContent(ctx("approver"), item.id, deps())]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const pubs = await t.db.select().from(contentPublications).where(eq(contentPublications.contentItemId, item.id));
    expect(pubs).toHaveLength(1);
  });

  it("publishing without a connected account fails and keeps the approval unused", async () => {
    const { ctx } = await setupOrg(t.db);
    const { item, approval } = await submitted(ctx("member"));
    await decideApproval(ctx("approver"), approval.id, "approve", { fingerprint: approval.fingerprint });
    await expect(publishContent(ctx("approver"), item.id, deps())).rejects.toMatchObject({ code: "integration_not_connected" });
    const [row] = await t.db.select().from(approvalRequests).where(eq(approvalRequests.id, approval.id));
    expect(row!.status).toBe("approved");
  });
});

describe("four-eyes policy", () => {
  it("is off by default: an approver may approve their own submission", async () => {
    const { ctx } = await setupOrg(t.db);
    const { approval } = await submitted(ctx("approver"));
    await expect(decideApproval(ctx("approver"), approval.id, "approve", { fingerprint: approval.fingerprint })).resolves.toMatchObject({ status: "approved" });
  });

  it("when enabled, authors cannot approve their own work but others can; rejecting stays allowed", async () => {
    const { ctx, org } = await setupOrg(t.db);
    await t.db.update(organizations).set({ requireDistinctApprover: true }).where(eq(organizations.id, org.id));
    const { approval } = await submitted(ctx("approver"));
    await expect(decideApproval(ctx("approver"), approval.id, "approve", { fingerprint: approval.fingerprint })).rejects.toMatchObject({ code: "forbidden" });
    await expect(decideApproval(ctx("owner"), approval.id, "approve", { fingerprint: approval.fingerprint })).resolves.toMatchObject({ status: "approved" });

    const second = await submitted(ctx("approver"));
    await expect(decideApproval(ctx("approver"), second.approval.id, "reject", { fingerprint: second.approval.fingerprint })).resolves.toMatchObject({ status: "rejected" });
  });

  it("when enabled, whoever last edited the content cannot approve it", async () => {
    const { ctx, org } = await setupOrg(t.db);
    await t.db.update(organizations).set({ requireDistinctApprover: true }).where(eq(organizations.id, org.id));
    const item = await withImage(ctx("member"));
    await addContentVersion(ctx("admin"), item.id, { body: "تعديل من المدير", hashtags: [] });
    const approval = await submitContentForApproval(ctx("member"), item.id);
    await expect(decideApproval(ctx("admin"), approval.id, "approve", { fingerprint: approval.fingerprint })).rejects.toMatchObject({ code: "forbidden" });
    await expect(decideApproval(ctx("approver"), approval.id, "approve", { fingerprint: approval.fingerprint })).resolves.toMatchObject({ status: "approved" });
  });
});
