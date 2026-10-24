import { and, desc, eq, sql } from "drizzle-orm";
import { agentRuns, agentToolPermissions, agents } from "@dfos/db";
import { getAiConfigStatus } from "@dfos/config";
import { AGENT_DEFINITIONS, AppError, getAgentDefinition } from "@dfos/domain";
import { audit } from "./audit";
import { requirePermission, type Ctx } from "./context";

export type AgentAvailability = "ready" | "disabled" | "needs_ai_config" | "not_implemented";

export async function listAgents(ctx: Ctx) {
  requirePermission(ctx, "agents.read");
  const ai = getAiConfigStatus();
  const [rows, stats, perms] = await Promise.all([
    ctx.db.select().from(agents).where(eq(agents.organizationId, ctx.organizationId)),
    ctx.db
      .select({
        agentKey: agentRuns.agentKey,
        total: sql<number>`count(*)::int`,
        succeeded: sql<number>`count(*) filter (where ${agentRuns.status} = 'succeeded')::int`,
        failed: sql<number>`count(*) filter (where ${agentRuns.status} = 'failed')::int`,
        lastRunAt: sql<Date | null>`max(${agentRuns.startedAt})`,
      })
      .from(agentRuns)
      .where(eq(agentRuns.organizationId, ctx.organizationId))
      .groupBy(agentRuns.agentKey),
    ctx.db.select().from(agentToolPermissions).where(eq(agentToolPermissions.organizationId, ctx.organizationId)),
  ]);

  return AGENT_DEFINITIONS.map((def) => {
    const row = rows.find((r) => r.key === def.key);
    const s = stats.find((x) => x.agentKey === def.key);
    let availability: AgentAvailability = "ready";
    if (def.taskTypes.length === 0) availability = "not_implemented";
    else if (!row?.enabled) availability = "disabled";
    else if (def.requiresAi && !ai.configured) availability = "needs_ai_config";
    return {
      ...def,
      id: row?.id ?? null,
      enabled: row?.enabled ?? false,
      model: row?.model ?? null,
      maxAttempts: row?.maxAttempts ?? 3,
      maxCostPerRunUsd: row?.maxCostPerRunUsd ?? null,
      availability,
      tools: def.tools.map((tool) => ({
        tool,
        allowed: perms.some((p) => p.agentId === row?.id && p.tool === tool && p.allowed),
      })),
      stats: {
        total: s?.total ?? 0,
        succeeded: s?.succeeded ?? 0,
        failed: s?.failed ?? 0,
        lastRunAt: s?.lastRunAt ?? null,
      },
    };
  });
}

export async function getAgent(ctx: Ctx, key: string) {
  const all = await listAgents(ctx);
  const agent = all.find((a) => a.key === key);
  if (!agent) throw new AppError("not_found", "Agent not found");
  return agent;
}

export async function listAgentRuns(ctx: Ctx, key: string, q: { limit: number; offset: number }) {
  requirePermission(ctx, "agents.read");
  if (!getAgentDefinition(key)) throw new AppError("not_found", "Agent not found");
  return ctx.db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.organizationId, ctx.organizationId), eq(agentRuns.agentKey, key)))
    .orderBy(desc(agentRuns.startedAt))
    .limit(q.limit)
    .offset(q.offset);
}

export async function updateAgent(
  ctx: Ctx,
  key: string,
  patch: { enabled?: boolean; maxAttempts?: number; maxCostPerRunUsd?: number | null },
) {
  requirePermission(ctx, "agents.manage");
  const def = getAgentDefinition(key);
  if (!def) throw new AppError("not_found", "Agent not found");
  if (patch.enabled && def.taskTypes.length === 0) {
    throw new AppError("conflict", `${def.name} has no implemented capabilities yet and cannot be enabled`);
  }
  const set: Partial<typeof agents.$inferInsert> = {};
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  if (patch.maxAttempts !== undefined) set.maxAttempts = patch.maxAttempts;
  if (patch.maxCostPerRunUsd !== undefined)
    set.maxCostPerRunUsd = patch.maxCostPerRunUsd === null ? null : String(patch.maxCostPerRunUsd);
  const [row] = await ctx.db
    .update(agents)
    .set(set)
    .where(and(eq(agents.organizationId, ctx.organizationId), eq(agents.key, key)))
    .returning();
  if (!row) throw new AppError("not_found", "Agent not set up for this organization");
  await audit(ctx, { action: patch.enabled === false ? "agent.disabled" : "agent.updated", targetType: "agent", targetId: key, data: patch });
  return row;
}
