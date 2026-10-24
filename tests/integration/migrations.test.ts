import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { auditLogs, organizations, taskEvents } from "@dfos/db";
import { MIGRATIONS_FOLDER } from "@dfos/db/testing";
import { createTask, writeAudit } from "@dfos/orchestrator";
import { freshDb, setupOrg } from "../helpers";

let t: Awaited<ReturnType<typeof freshDb>>;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(() => t.close());

describe("migrations", () => {
  it("creates all expected tables", async () => {
    const res = await t.client.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by 1",
    );
    const names = res.rows.map((r) => r.table_name);
    for (const expected of [
      "organizations",
      "organization_members",
      "agents",
      "tasks",
      "task_events",
      "agent_runs",
      "approval_requests",
      "approval_events",
      "audit_logs",
      "content_items",
      "content_versions",
      "ai_model_usage",
      "idempotency_keys",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("re-running migrations is a no-op and keeps existing data", async () => {
    const { org } = await setupOrg(t.db);
    await migrate(t.db as never, { migrationsFolder: MIGRATIONS_FOLDER });
    const rows = await t.db.select().from(organizations).where(eq(organizations.id, org.id));
    expect(rows).toHaveLength(1);
  });

  it("audit_logs rows cannot be updated or deleted", async () => {
    const { org } = await setupOrg(t.db);
    await writeAudit(t.db, org.id, { type: "system", name: "test" }, { action: "test.event" });
    await expect(t.db.update(auditLogs).set({ action: "tampered" }).where(eq(auditLogs.organizationId, org.id))).rejects.toThrow();
    await expect(t.db.delete(auditLogs).where(eq(auditLogs.organizationId, org.id))).rejects.toThrow();
    const rows = await t.db.select().from(auditLogs).where(eq(auditLogs.organizationId, org.id));
    expect(rows.some((r) => r.action === "test.event")).toBe(true);
  });

  it("task_events rows cannot be updated", async () => {
    const { ctx } = await setupOrg(t.db);
    const { task } = await createTask(ctx("member"), { type: "operations.health_check", input: {}, priority: "normal", dependsOn: [] });
    await expect(t.db.update(taskEvents).set({ message: "tampered" }).where(eq(taskEvents.taskId, task.id))).rejects.toThrow();
  });
});
