import { and, eq, gte, sql } from "drizzle-orm";
import { aiModelUsage } from "@dfos/db";
import type { TaskHandler } from "./types";

/** Summarises recorded AI usage. Costs are only summed where a price was configured at call time. */
export const financeAiUsageReport: TaskHandler = async (h) => {
  const days = Number(h.task.input.days ?? 30);
  const since = new Date(Date.now() - days * 86400_000);
  const rows = await h.db
    .select({
      model: aiModelUsage.model,
      provider: aiModelUsage.provider,
      calls: sql<number>`count(*)::int`,
      failed: sql<number>`count(*) filter (where not ${aiModelUsage.success})::int`,
      inputTokens: sql<number>`coalesce(sum(${aiModelUsage.inputTokens}), 0)::int`,
      outputTokens: sql<number>`coalesce(sum(${aiModelUsage.outputTokens}), 0)::int`,
      knownCostUsd: sql<string | null>`sum(${aiModelUsage.costUsd})::text`,
      callsWithUnknownCost: sql<number>`count(*) filter (where ${aiModelUsage.costUsd} is null and ${aiModelUsage.success})::int`,
    })
    .from(aiModelUsage)
    .where(and(eq(aiModelUsage.organizationId, h.org.id), gte(aiModelUsage.createdAt, since)))
    .groupBy(aiModelUsage.model, aiModelUsage.provider);

  const totalCalls = rows.reduce((s, r) => s + r.calls, 0);
  const knownCost = rows.reduce((s, r) => s + (r.knownCostUsd ? Number(r.knownCostUsd) : 0), 0);
  const unknown = rows.reduce((s, r) => s + r.callsWithUnknownCost, 0);
  const summary =
    totalCalls === 0
      ? `لا يوجد استخدام مسجل للنماذج خلال ${days} يومًا.`
      : `${totalCalls} استدعاء خلال ${days} يومًا، التكلفة المعروفة ${knownCost.toFixed(4)} دولار` +
        (unknown ? ` (${unknown} استدعاء دون سعر مُعدّ، تكلفتها غير محسوبة)` : "");

  return {
    kind: "succeeded",
    summary,
    result: {
      periodDays: days,
      since: since.toISOString(),
      byModel: rows,
      totals: { calls: totalCalls, knownCostUsd: knownCost.toFixed(6), callsWithUnknownCost: unknown },
      note: "Costs come only from configured per-token prices. Calls without a configured price are counted but not priced.",
    },
  };
};
