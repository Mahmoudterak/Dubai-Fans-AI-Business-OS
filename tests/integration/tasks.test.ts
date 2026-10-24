import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tasks } from "@dfos/db";
import {
  cancelTask,
  claimNextTask,
  createTask,
  executeTask,
  getTask,
  listTaskEvents,
  recoverStaleTasks,
  retryTask,
  transitionTask,
  updateAgent,
  updateOrgSettings,
} from "@dfos/orchestrator";
import { freshDb, setupOrg } from "../helpers";

let t: Awaited<ReturnType<typeof freshDb>>;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(() => t.close());
// The queue is global across orgs; keep tests independent by clearing leftovers.
afterEach(async () => {
  await t.db.update(tasks).set({ status: "cancelled" }).where(inArray(tasks.status, ["queued", "retrying", "running"]));
});

const health = { type: "operations.health_check" as const, input: {}, priority: "normal" as const, dependsOn: [] as string[] };

/** Drains the queue (claims only this org's work because other tests' tasks are finished or paused). */
async function runAll(max = 10) {
  const statuses: string[] = [];
  for (let i = 0; i < max; i++) {
    const task = await claimNextTask(t.db, "test-worker");
    if (!task) break;
    const r = await executeTask(t.db, task);
    statuses.push(r.status);
  }
  return statuses;
}

describe("task engine", () => {
  it("runs a real task end to end and records events, a run and audit entries", async () => {
    const { ctx } = await setupOrg(t.db);
    const { task } = await createTask(ctx("member"), { ...health, title: "Check system" });
    expect(task.status).toBe("queued");

    await runAll();
    const detail = await getTask(ctx("member"), task.id);
    expect(detail.task.status).toBe("succeeded");
    expect(detail.task.result).toMatchObject({ recommendations: expect.any(Array) });
    expect(detail.runs).toHaveLength(1);
    expect(detail.runs[0]!.status).toBe("succeeded");
    expect(detail.runs[0]!.durationMs).toBeGreaterThanOrEqual(0);

    const events = await listTaskEvents(ctx("member"), task.id);
    expect(events.map((e) => e.type)).toEqual(["created", "status.running", "status.succeeded"]);
  });

  it("rejects invalid input and unknown types", async () => {
    const { ctx } = await setupOrg(t.db);
    await expect(createTask(ctx("member"), { ...health, type: "finance.ai_usage_report", input: { days: 500 } })).rejects.toMatchObject({ code: "validation_failed" });
    await expect(createTask(ctx("member"), { ...health, input: { extra: 1 } })).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("viewers cannot create tasks", async () => {
    const { ctx } = await setupOrg(t.db);
    await expect(createTask(ctx("viewer"), health)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("deduplicates by idempotency key", async () => {
    const { ctx } = await setupOrg(t.db);
    const a = await createTask(ctx("member"), health, { idempotencyKey: "abc" });
    const b = await createTask(ctx("member"), health, { idempotencyKey: "abc" });
    expect(b.deduplicated).toBe(true);
    expect(b.task.id).toBe(a.task.id);
  });

  it("waits for dependencies and cancels dependents of a cancelled task", async () => {
    const { ctx } = await setupOrg(t.db);
    await updateOrgSettings(ctx("owner"), { agentsPaused: true });
    const { task: first } = await createTask(ctx("member"), health);
    const { task: second } = await createTask(ctx("member"), { ...health, dependsOn: [first.id] });
    const { task: third } = await createTask(ctx("member"), { ...health, dependsOn: [second.id] });
    await cancelTask(ctx("member"), first.id);
    const rows = await t.db.select().from(tasks).where(eq(tasks.organizationId, ctx("member").organizationId));
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.status]));
    expect(byId[second.id]).toBe("cancelled");
    expect(byId[third.id]).toBe("cancelled");
  });

  it("runs dependencies in order", async () => {
    const { ctx } = await setupOrg(t.db);
    const { task: first } = await createTask(ctx("member"), health);
    const { task: second } = await createTask(ctx("member"), { ...health, dependsOn: [first.id], priority: "urgent" });
    // second is urgent but must wait for first.
    const claimed = await claimNextTask(t.db, "w");
    expect(claimed?.id).toBe(first.id);
    await executeTask(t.db, claimed!);
    const next = await claimNextTask(t.db, "w");
    expect(next?.id).toBe(second.id);
    await executeTask(t.db, next!);
  });

  it("a task is claimed by one worker only", async () => {
    const { ctx } = await setupOrg(t.db);
    await createTask(ctx("member"), health);
    const [a, b] = await Promise.all([claimNextTask(t.db, "w1"), claimNextTask(t.db, "w2")]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const claimed = (a ?? b)!;
    await executeTask(t.db, claimed);
  });

  it("does not run tasks of paused orgs or disabled agents", async () => {
    const { ctx } = await setupOrg(t.db);
    const { task } = await createTask(ctx("member"), health);
    await updateAgent(ctx("admin"), "operations", { enabled: false });
    expect(await claimNextTask(t.db, "w")).toBeUndefined();
    await updateAgent(ctx("admin"), "operations", { enabled: true });
    await updateOrgSettings(ctx("owner"), { agentsPaused: true });
    expect(await claimNextTask(t.db, "w")).toBeUndefined();
    await updateOrgSettings(ctx("owner"), { agentsPaused: false });
    const claimed = await claimNextTask(t.db, "w");
    expect(claimed?.id).toBe(task.id);
    await executeTask(t.db, claimed!);
  });

  it("refuses invalid transitions", async () => {
    const { ctx } = await setupOrg(t.db);
    const { task } = await createTask(ctx("member"), health);
    await expect(transitionTask(t.db, task, "succeeded", { type: "system", name: "t" })).rejects.toMatchObject({ code: "invalid_transition" });
    await cancelTask(ctx("member"), task.id);
    await expect(cancelTask(ctx("member"), task.id)).rejects.toMatchObject({ code: "invalid_transition" });
  });

  it("recovers tasks whose worker died", async () => {
    const { ctx } = await setupOrg(t.db);
    const { task } = await createTask(ctx("member"), health);
    const claimed = await claimNextTask(t.db, "dead-worker");
    expect(claimed?.id).toBe(task.id);
    await t.db.update(tasks).set({ lockedAt: new Date(Date.now() - 3600_000) }).where(eq(tasks.id, task.id));
    expect(await recoverStaleTasks(t.db, 60_000)).toBe(1);
    const [row] = await t.db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row!.status).toBe("retrying");
    const again = await claimNextTask(t.db, "w");
    expect(again?.id).toBe(task.id);
    await executeTask(t.db, again!);
  });

  it("only failed tasks can be retried manually", async () => {
    const { ctx } = await setupOrg(t.db);
    const { task } = await createTask(ctx("member"), health);
    await expect(retryTask(ctx("member"), task.id)).rejects.toMatchObject({ code: "invalid_transition" });
    await cancelTask(ctx("member"), task.id);
  });
});
