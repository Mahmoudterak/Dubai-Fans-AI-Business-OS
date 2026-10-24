import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cancelTask,
  createContent,
  createTask,
  decideApproval,
  getApproval,
  getContent,
  getTask,
  listApprovals,
  listAuditLogs,
  listContent,
  listTaskEvents,
  listTasks,
  submitContentForApproval,
  addContentVersion,
} from "@dfos/orchestrator";
import { freshDb, setupOrg } from "../helpers";

let t: Awaited<ReturnType<typeof freshDb>>;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(() => t.close());

describe("organization isolation", () => {
  it("org B can never read or change org A's records", async () => {
    const A = await setupOrg(t.db, "Alpha");
    const B = await setupOrg(t.db, "Beta");

    const { task } = await createTask(A.ctx("member"), { type: "operations.health_check", input: {}, priority: "normal", dependsOn: [] });
    const item = await createContent(A.ctx("member"), { title: "سري", platform: "instagram", format: "post", body: "نص خاص", hashtags: [] });
    const approval = await submitContentForApproval(A.ctx("member"), item.id);

    // Reads
    await expect(getTask(B.ctx("owner"), task.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(listTaskEvents(B.ctx("owner"), task.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(getContent(B.ctx("owner"), item.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(getApproval(B.ctx("owner"), approval.id)).rejects.toMatchObject({ code: "not_found" });
    expect((await listTasks(B.ctx("owner"), { limit: 100, offset: 0 })).items).toHaveLength(0);
    expect(await listContent(B.ctx("owner"), { limit: 100, offset: 0 })).toHaveLength(0);
    expect(await listApprovals(B.ctx("owner"), { limit: 100, offset: 0 })).toHaveLength(0);
    const audit = await listAuditLogs(B.ctx("owner"), { limit: 100, offset: 0 });
    expect(audit.every((e) => e.organizationId === B.org.id)).toBe(true);

    // Writes
    await expect(cancelTask(B.ctx("owner"), task.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(addContentVersion(B.ctx("owner"), item.id, { body: "hacked", hashtags: [] })).rejects.toMatchObject({ code: "not_found" });
    await expect(
      decideApproval(B.ctx("owner"), approval.id, "approve", { fingerprint: approval.fingerprint }),
    ).rejects.toMatchObject({ code: "not_found" });

    // Dependencies across orgs are refused.
    await expect(
      createTask(B.ctx("member"), { type: "operations.health_check", input: {}, priority: "normal", dependsOn: [task.id] }),
    ).rejects.toMatchObject({ code: "validation_failed" });

    // A's data is untouched.
    const still = await getApproval(A.ctx("owner"), approval.id);
    expect(still.approval.status).toBe("pending");
  });

  it("viewers cannot read the audit log", async () => {
    const A = await setupOrg(t.db, "Gamma");
    await expect(listAuditLogs(A.ctx("viewer"), { limit: 10, offset: 0 })).rejects.toMatchObject({ code: "forbidden" });
  });
});
