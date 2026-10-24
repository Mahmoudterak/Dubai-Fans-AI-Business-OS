import { and, desc, eq } from "drizzle-orm";
import { auditLogs, type Database } from "@dfos/db";
import { redact } from "@dfos/observability";
import { actorId, requirePermission, type Actor, type Ctx } from "./context";

export interface AuditEntry {
  action: string;
  targetType?: string;
  targetId?: string;
  data?: Record<string, unknown>;
}

export async function writeAudit(
  db: Database,
  organizationId: string,
  actor: Actor,
  entry: AuditEntry,
  requestId?: string,
) {
  await db.insert(auditLogs).values({
    organizationId,
    actorType: actor.type,
    actorId: actorId(actor),
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    data: entry.data ? (redact(entry.data) as Record<string, unknown>) : undefined,
    requestId,
  });
}

export const audit = (ctx: Ctx, entry: AuditEntry, db: Database = ctx.db) =>
  writeAudit(db, ctx.organizationId, ctx.actor, entry, ctx.requestId);

export async function listAuditLogs(ctx: Ctx, opts: { limit: number; offset: number; action?: string }) {
  requirePermission(ctx, "audit.read");
  const where = opts.action
    ? and(eq(auditLogs.organizationId, ctx.organizationId), eq(auditLogs.action, opts.action))
    : eq(auditLogs.organizationId, ctx.organizationId);
  return ctx.db
    .select()
    .from(auditLogs)
    .where(where)
    .orderBy(desc(auditLogs.createdAt))
    .limit(opts.limit)
    .offset(opts.offset);
}
