import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { approvalRequests, tasks } from "@dfos/db";
import type { TaskHandler } from "./types";

const HOUR = 3600_000;

/** Read-only report built from the database. Suggests actions; changes nothing. */
export const operationsHealthCheck: TaskHandler = async (h) => {
  const org = h.org.id;
  const now = Date.now();
  const [byStatus, failed24h, stuckRunning, oldApprovals, blocked] = await Promise.all([
    h.db
      .select({ status: tasks.status, n: sql<number>`count(*)::int` })
      .from(tasks)
      .where(eq(tasks.organizationId, org))
      .groupBy(tasks.status),
    h.db
      .select({ id: tasks.id, title: tasks.title, error: tasks.error })
      .from(tasks)
      .where(and(eq(tasks.organizationId, org), eq(tasks.status, "failed"), gte(tasks.finishedAt, new Date(now - 24 * HOUR))))
      .limit(20),
    h.db
      .select({ id: tasks.id, title: tasks.title, lockedAt: tasks.lockedAt })
      .from(tasks)
      .where(and(eq(tasks.organizationId, org), eq(tasks.status, "running"), lt(tasks.lockedAt, new Date(now - 10 * 60_000))))
      .limit(20),
    h.db
      .select({ id: approvalRequests.id, title: approvalRequests.title, createdAt: approvalRequests.createdAt })
      .from(approvalRequests)
      .where(and(eq(approvalRequests.organizationId, org), eq(approvalRequests.status, "pending"), lt(approvalRequests.createdAt, new Date(now - 24 * HOUR))))
      .limit(20),
    h.db
      .select({ id: tasks.id, title: tasks.title })
      .from(tasks)
      .where(
        and(
          eq(tasks.organizationId, org),
          inArray(tasks.status, ["queued", "retrying"]),
          lt(tasks.runAfter, new Date(now - HOUR)),
        ),
      )
      .limit(20),
  ]);

  const recommendations: string[] = [];
  if (failed24h.length) recommendations.push(`راجع ${failed24h.length} مهام فشلت خلال 24 ساعة وأعد تشغيل ما يلزم من مركز المهام.`);
  if (stuckRunning.length) recommendations.push(`${stuckRunning.length} مهام قيد التشغيل منذ أكثر من 10 دقائق: تحقق من أن العامل الخلفي يعمل.`);
  if (oldApprovals.length) recommendations.push(`${oldApprovals.length} طلبات موافقة تنتظر منذ أكثر من يوم.`);
  if (blocked.length) recommendations.push(`${blocked.length} مهام في الطابور منذ أكثر من ساعة: قد يكون العامل متوقفًا أو الوكيل معطلًا أو التبعيات لم تكتمل.`);
  if (!recommendations.length) recommendations.push("لا توجد مشكلات ظاهرة في السجلات الحالية.");

  return {
    kind: "succeeded",
    summary: recommendations[0]!,
    result: {
      generatedAt: new Date().toISOString(),
      tasksByStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
      failedLast24h: failed24h,
      stuckRunning,
      approvalsWaitingOver24h: oldApprovals,
      queuedOverOneHour: blocked,
      recommendations,
    },
  };
};
