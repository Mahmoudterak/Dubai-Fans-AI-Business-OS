import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { approvalRequests, contentItems, organizationMembers } from "@dfos/db";
import {
  addContentVersion,
  consumeApproval,
  createContent,
  decideApproval,
  getApproval,
  loadContentPublishPayload,
  publishContent,
  registerPublisher,
  scheduleContent,
  submitContentForApproval,
  unregisterPublisher,
  CONTENT_PUBLISH_ACTION,
} from "@dfos/orchestrator";
import { freshDb, setupOrg } from "../helpers";

let t: Awaited<ReturnType<typeof freshDb>>;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(() => t.close());
afterEach(() => unregisterPublisher("instagram"));

const draft = {
  title: "إطلاق مروحة جديدة",
  platform: "instagram" as const,
  format: "post" as const,
  body: "مروحة جديدة لصيف دبي",
  hashtags: ["دبي", "#صيف"],
};

/** Test double for a connected Instagram account. Counts real publish calls. */
function fakeInstagram() {
  const calls: string[] = [];
  registerPublisher({
    platform: "instagram",
    isConnected: async () => true,
    publish: async (_db, _org, req) => {
      calls.push(req.version.id);
      return { externalId: `ig_${calls.length}` };
    },
  });
  return calls;
}

async function submitted(ctx: ReturnType<Awaited<ReturnType<typeof setupOrg>>["ctx"]>) {
  const item = await createContent(ctx, draft);
  const approval = await submitContentForApproval(ctx, item.id);
  return { item, approval };
}

describe("approval center", () => {
  it("approve → publish once; a second publish is refused", async () => {
    const { ctx } = await setupOrg(t.db);
    const calls = fakeInstagram();
    const { item, approval } = await submitted(ctx("member"));
    expect(approval.status).toBe("pending");

    await decideApproval(ctx("approver"), approval.id, "approve", { fingerprint: approval.fingerprint });
    const res = await publishContent(ctx("approver"), item.id);
    expect(res.status).toBe("published");
    expect(calls).toHaveLength(1);

    await expect(publishContent(ctx("approver"), item.id)).rejects.toMatchObject({ code: "approval_required" });
    expect(calls).toHaveLength(1);
    const detail = await getApproval(ctx("approver"), approval.id);
    expect(detail.approval.status).toBe("executed");
    expect(detail.events.map((e) => e.type)).toEqual(["requested", "approved", "executed"]);
  });

  it("cannot publish before approval", async () => {
    const { ctx } = await setupOrg(t.db);
    const calls = fakeInstagram();
    const { item } = await submitted(ctx("member"));
    await expect(publishContent(ctx("owner"), item.id)).rejects.toMatchObject({ code: "approval_required" });
    expect(calls).toHaveLength(0);
  });

  it("editing approved content voids the approval and requires a new one", async () => {
    const { ctx } = await setupOrg(t.db);
    const calls = fakeInstagram();
    const { item, approval } = await submitted(ctx("member"));
    await decideApproval(ctx("approver"), approval.id, "approve", { fingerprint: approval.fingerprint });

    const edit = await addContentVersion(ctx("member"), item.id, { body: "نص معدّل بعد الموافقة", hashtags: [] });
    expect(edit.approvalsInvalidated).toBe(1);
    const [row] = await t.db.select().from(contentItems).where(eq(contentItems.id, item.id));
    expect(row!.status).toBe("draft");
    await expect(publishContent(ctx("approver"), item.id)).rejects.toMatchObject({ code: "approval_required" });
    expect(calls).toHaveLength(0);

    const second = await submitContentForApproval(ctx("member"), item.id);
    expect(second.fingerprint).not.toBe(approval.fingerprint);
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
    await expect(
      decideApproval(ctx("approver"), approval.id, "approve", { fingerprint: "0".repeat(64) }),
    ).rejects.toMatchObject({ code: "approval_invalid" });
  });

  it("content changed while pending → approving is refused and the request is invalidated", async () => {
    const { ctx } = await setupOrg(t.db);
    const { item, approval } = await submitted(ctx("member"));
    // Bypass the service (which would invalidate itself) to simulate a race.
    const { version } = await loadContentPublishPayload(t.db, ctx("member").organizationId, item.id);
    await t.db.update(contentItems).set({ audience: "جمهور مختلف" }).where(eq(contentItems.id, item.id));
    expect(version).toBeTruthy();
    await expect(
      decideApproval(ctx("approver"), approval.id, "approve", { fingerprint: approval.fingerprint }),
    ).rejects.toMatchObject({ code: "approval_invalid" });
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
    const { ctx, users } = await setupOrg(t.db);
    const calls = fakeInstagram();
    const { item, approval } = await submitted(ctx("member"));
    await decideApproval(ctx("approver"), approval.id, "approve", { fingerprint: approval.fingerprint });
    await t.db.update(organizationMembers).set({ role: "viewer" }).where(eq(organizationMembers.userId, users.approver.id));
    await expect(publishContent(ctx("owner"), item.id)).rejects.toMatchObject({ code: "approval_invalid" });
    expect(calls).toHaveLength(0);
  });

  it("consuming the same approval twice in parallel succeeds once", async () => {
    const { ctx } = await setupOrg(t.db);
    const { item, approval } = await submitted(ctx("member"));
    await decideApproval(ctx("approver"), approval.id, "approve", { fingerprint: approval.fingerprint });
    const { payload } = await loadContentPublishPayload(t.db, ctx("member").organizationId, item.id);
    const args = {
      organizationId: ctx("member").organizationId,
      approvalId: approval.id,
      actionType: CONTENT_PUBLISH_ACTION,
      currentPayload: payload,
      executor: { type: "system" as const, name: "t" },
    };
    const results = await Promise.allSettled([consumeApproval(t.db, args), consumeApproval(t.db, args)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("publishing without a connected account fails and keeps the approval unused", async () => {
    const { ctx } = await setupOrg(t.db);
    const { item, approval } = await submitted(ctx("member"));
    await decideApproval(ctx("approver"), approval.id, "approve", { fingerprint: approval.fingerprint });
    await expect(publishContent(ctx("approver"), item.id)).rejects.toMatchObject({ code: "integration_not_connected" });
    const [row] = await t.db.select().from(approvalRequests).where(eq(approvalRequests.id, approval.id));
    expect(row!.status).toBe("approved");
  });
});
