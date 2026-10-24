import { and, desc, eq, gte, sql } from "drizzle-orm";
import { aiModelUsage, approvalRequests, auditLogs, contentItems, organizations, tasks } from "@dfos/db";
import { getAiConfigStatus, isMetaConfigured } from "@dfos/config";
import { can } from "@dfos/domain";
import { requirePermission, type Ctx } from "./context";

/** Every number here comes from the database. Nothing is estimated or sample data. */
export async function getDashboard(ctx: Ctx) {
  requirePermission(ctx, "org.read");
  const org = ctx.organizationId;
  const since30 = new Date(Date.now() - 30 * 86400_000);
  const since24 = new Date(Date.now() - 86400_000);

  const [taskCounts, failed24, pendingApprovals, usage, contentCounts, lastClaim, orgRow] = await Promise.all([
    ctx.db.select({ status: tasks.status, n: sql<number>`count(*)::int` }).from(tasks).where(eq(tasks.organizationId, org)).groupBy(tasks.status),
    ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(tasks)
      .where(and(eq(tasks.organizationId, org), eq(tasks.status, "failed"), gte(tasks.finishedAt, since24))),
    ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(approvalRequests)
      .where(and(eq(approvalRequests.organizationId, org), eq(approvalRequests.status, "pending"))),
    ctx.db
      .select({
        calls: sql<number>`count(*)::int`,
        inputTokens: sql<number>`coalesce(sum(${aiModelUsage.inputTokens}),0)::int`,
        outputTokens: sql<number>`coalesce(sum(${aiModelUsage.outputTokens}),0)::int`,
        knownCostUsd: sql<string | null>`sum(${aiModelUsage.costUsd})::text`,
        unpricedCalls: sql<number>`count(*) filter (where ${aiModelUsage.costUsd} is null and ${aiModelUsage.success})::int`,
      })
      .from(aiModelUsage)
      .where(and(eq(aiModelUsage.organizationId, org), gte(aiModelUsage.createdAt, since30))),
    ctx.db.select({ status: contentItems.status, n: sql<number>`count(*)::int` }).from(contentItems).where(eq(contentItems.organizationId, org)).groupBy(contentItems.status),
    ctx.db.select({ at: sql<Date | null>`max(${tasks.lockedAt})` }).from(tasks),
    ctx.db.select().from(organizations).where(eq(organizations.id, org)),
  ]);

  const recentEvents =
    ctx.actor.type === "user" && can(ctx.actor.role, "audit.read")
      ? await ctx.db.select().from(auditLogs).where(eq(auditLogs.organizationId, org)).orderBy(desc(auditLogs.createdAt)).limit(10)
      : [];

  const ai = getAiConfigStatus();
  return {
    organization: orgRow[0] ? { name: orgRow[0].name, agentsPaused: orgRow[0].agentsPaused, timezone: orgRow[0].timezone } : null,
    tasks: {
      byStatus: Object.fromEntries(taskCounts.map((r) => [r.status, r.n])) as Record<string, number>,
      failedLast24h: failed24[0]?.n ?? 0,
    },
    approvals: { pending: pendingApprovals[0]?.n ?? 0 },
    content: { byStatus: Object.fromEntries(contentCounts.map((r) => [r.status, r.n])) as Record<string, number> },
    ai: {
      configured: ai.configured,
      reason: ai.configured ? null : ai.reason,
      model: ai.configured ? ai.model : null,
      last30d: usage[0] ?? { calls: 0, inputTokens: 0, outputTokens: 0, knownCostUsd: null, unpricedCalls: 0 },
    },
    // Worker liveness is inferred from the last task it claimed (any org). Null = never ran.
    worker: { lastClaimAt: lastClaim[0]?.at ?? null },
    integrations: [
      { provider: "meta", name: "Meta / Instagram", appConfigured: isMetaConfigured(), connected: false, phase: 6 },
      { provider: "tiktok", name: "TikTok", appConfigured: false, connected: false, phase: null },
      { provider: "whatsapp", name: "WhatsApp Business", appConfigured: false, connected: false, phase: null },
      { provider: "google_ads", name: "Google Ads", appConfigured: false, connected: false, phase: null },
    ],
    recentEvents,
  };
}
