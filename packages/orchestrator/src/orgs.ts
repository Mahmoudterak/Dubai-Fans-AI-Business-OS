import { and, eq } from "drizzle-orm";
import {
  agentPolicies,
  agentToolPermissions,
  agents,
  organizationMembers,
  organizations,
  users,
  type Database,
} from "@dfos/db";
import { AGENT_DEFINITIONS, AppError, type RiskLevel, type Role } from "@dfos/domain";
import { audit, writeAudit } from "./audit";
import { requirePermission, type Ctx } from "./context";

/** Safest defaults: every outward-facing action needs a human approval. */
export const DEFAULT_POLICIES: Array<{ actionType: string; riskLevel: RiskLevel }> = [
  { actionType: "content.publish", riskLevel: "high" },
  { actionType: "tasks.create_subtasks", riskLevel: "medium" },
  { actionType: "messages.send", riskLevel: "critical" },
  { actionType: "ads.change_budget", riskLevel: "critical" },
];

/** Creates missing agent rows, tool permissions and policies. Never overwrites existing settings. */
export async function ensureOrgDefaults(db: Database, organizationId: string) {
  await db
    .insert(agents)
    .values(AGENT_DEFINITIONS.map((a) => ({ organizationId, key: a.key, enabled: a.taskTypes.length > 0 })))
    .onConflictDoNothing();

  const rows = await db.select().from(agents).where(eq(agents.organizationId, organizationId));
  const perms = rows.flatMap((row) => {
    const def = AGENT_DEFINITIONS.find((d) => d.key === row.key);
    return (def?.tools ?? []).map((tool) => ({ organizationId, agentId: row.id, tool, allowed: true }));
  });
  if (perms.length) await db.insert(agentToolPermissions).values(perms).onConflictDoNothing();

  await db
    .insert(agentPolicies)
    .values(DEFAULT_POLICIES.map((p) => ({ organizationId, ...p, requiresApproval: true })))
    .onConflictDoNothing();
}

export async function bootstrapOrganization(
  db: Database,
  input: { name: string; slug: string; ownerUserId: string },
) {
  return db.transaction(async (tx) => {
    const [org] = await tx
      .insert(organizations)
      .values({ name: input.name, slug: input.slug })
      .returning();
    if (!org) throw new AppError("internal_error", "Failed to create organization");
    await tx.insert(organizationMembers).values({
      organizationId: org.id,
      userId: input.ownerUserId,
      role: "owner",
    });
    await ensureOrgDefaults(tx, org.id);
    await writeAudit(tx, org.id, { type: "user", userId: input.ownerUserId, role: "owner" }, {
      action: "organization.created",
      targetType: "organization",
      targetId: org.id,
    });
    return org;
  });
}

export async function upsertUser(
  db: Database,
  input: { authProvider: string; authSubject: string; email: string; displayName: string },
) {
  const [row] = await db
    .insert(users)
    .values(input)
    .onConflictDoUpdate({
      target: [users.authProvider, users.authSubject],
      set: { email: input.email, displayName: input.displayName },
    })
    .returning();
  if (!row) throw new AppError("internal_error", "Failed to upsert user");
  return row;
}

export async function getMembership(db: Database, userId: string, organizationId: string) {
  const [row] = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.status, "active"),
      ),
    );
  return row;
}

export async function listUserOrganizations(db: Database, userId: string) {
  return db
    .select({ organization: organizations, role: organizationMembers.role })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .where(and(eq(organizationMembers.userId, userId), eq(organizationMembers.status, "active")));
}

export async function getOrganization(ctx: Ctx) {
  const [org] = await ctx.db.select().from(organizations).where(eq(organizations.id, ctx.organizationId));
  if (!org) throw new AppError("not_found", "Organization not found");
  return org;
}

export async function listMembers(ctx: Ctx) {
  requirePermission(ctx, "org.read");
  return ctx.db
    .select({
      id: organizationMembers.id,
      role: organizationMembers.role,
      status: organizationMembers.status,
      userId: users.id,
      email: users.email,
      displayName: users.displayName,
      createdAt: organizationMembers.createdAt,
    })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(eq(organizationMembers.organizationId, ctx.organizationId));
}

export async function updateOrgSettings(
  ctx: Ctx,
  patch: { agentsPaused?: boolean; requireDistinctApprover?: boolean; aiMonthlyBudgetUsd?: number | null; timezone?: string },
) {
  requirePermission(ctx, "org.manage");
  const set: Partial<typeof organizations.$inferInsert> = {};
  if (patch.agentsPaused !== undefined) set.agentsPaused = patch.agentsPaused;
  if (patch.requireDistinctApprover !== undefined) set.requireDistinctApprover = patch.requireDistinctApprover;
  if (patch.aiMonthlyBudgetUsd !== undefined)
    set.aiMonthlyBudgetUsd = patch.aiMonthlyBudgetUsd === null ? null : String(patch.aiMonthlyBudgetUsd);
  if (patch.timezone !== undefined) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: patch.timezone });
    } catch {
      throw new AppError("validation_failed", "Unknown time zone");
    }
    set.timezone = patch.timezone;
  }
  const [org] = await ctx.db
    .update(organizations)
    .set(set)
    .where(eq(organizations.id, ctx.organizationId))
    .returning();
  await audit(ctx, { action: "organization.settings_updated", targetType: "organization", targetId: ctx.organizationId, data: patch });
  return org;
}

export async function setMemberRole(ctx: Ctx, memberId: string, role: Role) {
  requirePermission(ctx, "members.manage");
  if (role === "owner" && ctx.actor.type === "user" && ctx.actor.role !== "owner") {
    throw new AppError("forbidden", "Only an owner can grant the owner role");
  }
  const [row] = await ctx.db
    .update(organizationMembers)
    .set({ role })
    .where(and(eq(organizationMembers.id, memberId), eq(organizationMembers.organizationId, ctx.organizationId)))
    .returning();
  if (!row) throw new AppError("not_found", "Member not found");
  await audit(ctx, { action: "member.role_changed", targetType: "member", targetId: memberId, data: { role } });
  return row;
}
