import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import {
  approvalEvents,
  approvalRequests,
  contentItems,
  tasks,
  users,
  type Database,
} from "@dfos/db";
import { actionFingerprint, AppError, assertApprovalTransition, can, type ApprovalStatus, type RiskLevel } from "@dfos/domain";
import { audit, writeAudit } from "./audit";
import { actorId, requirePermission, requireUser, type Actor, type Ctx } from "./context";
import { CONTENT_PUBLISH_ACTION, loadContentPublishPayload } from "./content-payload";
import { getMembership } from "./orgs";
import { transitionTask } from "./task-core";

export type ApprovalRow = typeof approvalRequests.$inferSelect;

export interface NewApproval {
  organizationId: string;
  actionType: string;
  title: string;
  summary?: string;
  payload: Record<string, unknown>;
  riskLevel: RiskLevel;
  taskId?: string;
  contentItemId?: string;
  expiresAt?: Date;
}

export async function createApprovalRequest(db: Database, actor: Actor, input: NewApproval, requestId?: string) {
  const fingerprint = actionFingerprint(input.actionType, input.payload);
  const [row] = await db
    .insert(approvalRequests)
    .values({
      ...input,
      fingerprint,
      status: "pending",
      requestedByType: actor.type,
      requestedById: actorId(actor),
    })
    .returning();
  if (!row) throw new AppError("internal_error", "Failed to create approval request");
  await db.insert(approvalEvents).values({
    organizationId: input.organizationId,
    approvalRequestId: row.id,
    type: "requested",
    actorType: actor.type,
    actorId: actorId(actor),
    fingerprint,
  });
  await writeAudit(db, input.organizationId, actor, {
    action: "approval.requested",
    targetType: "approval",
    targetId: row.id,
    data: { actionType: input.actionType, riskLevel: input.riskLevel, fingerprint },
  }, requestId);
  return row;
}

export async function listApprovals(ctx: Ctx, q: { status?: ApprovalStatus; limit: number; offset: number }) {
  requirePermission(ctx, "approvals.read");
  const where = q.status
    ? and(eq(approvalRequests.organizationId, ctx.organizationId), eq(approvalRequests.status, q.status))
    : eq(approvalRequests.organizationId, ctx.organizationId);
  return ctx.db
    .select()
    .from(approvalRequests)
    .where(where)
    .orderBy(desc(approvalRequests.createdAt))
    .limit(q.limit)
    .offset(q.offset);
}

async function loadApproval(db: Database, organizationId: string, id: string) {
  const [row] = await db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.id, id), eq(approvalRequests.organizationId, organizationId)));
  if (!row) throw new AppError("not_found", "Approval request not found");
  return row;
}

export async function getApproval(ctx: Ctx, id: string) {
  requirePermission(ctx, "approvals.read");
  const approval = await loadApproval(ctx.db, ctx.organizationId, id);
  const events = await ctx.db
    .select({
      id: approvalEvents.id,
      type: approvalEvents.type,
      actorType: approvalEvents.actorType,
      actorId: approvalEvents.actorId,
      note: approvalEvents.note,
      fingerprint: approvalEvents.fingerprint,
      createdAt: approvalEvents.createdAt,
    })
    .from(approvalEvents)
    .where(and(eq(approvalEvents.approvalRequestId, id), eq(approvalEvents.organizationId, ctx.organizationId)))
    .orderBy(approvalEvents.createdAt);
  let decidedBy: { displayName: string; email: string } | undefined;
  if (approval.decidedByUserId) {
    const [u] = await ctx.db
      .select({ displayName: users.displayName, email: users.email })
      .from(users)
      .where(eq(users.id, approval.decidedByUserId));
    decidedBy = u;
  }
  const stale = await isStale(ctx.db, approval);
  return { approval, events, decidedBy, stale };
}

/** True when the underlying action no longer matches what was submitted for review. */
async function isStale(db: Database, approval: ApprovalRow): Promise<boolean> {
  if (approval.actionType === CONTENT_PUBLISH_ACTION && approval.contentItemId) {
    try {
      const { payload } = await loadContentPublishPayload(db, approval.organizationId, approval.contentItemId);
      return actionFingerprint(approval.actionType, payload) !== approval.fingerprint;
    } catch {
      return true;
    }
  }
  return false;
}

async function setStatus(
  db: Database,
  approval: ApprovalRow,
  to: ApprovalStatus,
  actor: Actor,
  extra: Partial<typeof approvalRequests.$inferInsert> = {},
  note?: string,
) {
  assertApprovalTransition(approval.status, to);
  const [updated] = await db
    .update(approvalRequests)
    .set({ status: to, ...extra })
    .where(and(eq(approvalRequests.id, approval.id), eq(approvalRequests.status, approval.status)))
    .returning();
  if (!updated) throw new AppError("conflict", "Approval was changed by someone else; reload and try again");
  await db.insert(approvalEvents).values({
    organizationId: approval.organizationId,
    approvalRequestId: approval.id,
    type: to,
    actorType: actor.type,
    actorId: actorId(actor),
    note,
    fingerprint: approval.fingerprint,
  });
  return updated;
}

export type Decision = "approve" | "reject" | "request_changes";

export async function decideApproval(
  ctx: Ctx,
  id: string,
  decision: Decision,
  input: { fingerprint: string; note?: string },
) {
  requirePermission(ctx, "approvals.decide");
  const user = requireUser(ctx);

  // State changes that must persist even though the request fails (expiry, staleness)
  // are committed first; the error is raised after the transaction.
  const outcome = await ctx.db.transaction(async (tx) => {
    const approval = await loadApproval(tx, ctx.organizationId, id);
    if (approval.status !== "pending") {
      throw new AppError("invalid_transition", `Approval is already ${approval.status}`);
    }
    if (approval.expiresAt && approval.expiresAt < new Date()) {
      await setStatus(tx, approval, "expired", { type: "system", name: "approvals" });
      return { error: new AppError("approval_invalid", "Approval request has expired") };
    }
    // The reviewer must have seen the exact version that is stored.
    if (input.fingerprint !== approval.fingerprint) {
      throw new AppError("approval_invalid", "The action changed since you opened it. Reload and review again.");
    }
    // And the stored version must still match the live object.
    if (await isStale(tx, approval)) {
      await setStatus(tx, approval, "invalidated", { type: "system", name: "approvals" }, {}, "content changed before decision");
      return {
        error: new AppError("approval_invalid", "The content changed after it was submitted. It must be resubmitted."),
      };
    }

    const to: ApprovalStatus =
      decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "changes_requested";
    const updated = await setStatus(
      tx,
      approval,
      to,
      ctx.actor,
      { decidedByUserId: user.userId, decidedAt: new Date(), decisionNote: input.note ?? null },
      input.note,
    );

    await applyDecisionSideEffects(tx, ctx, updated, to);
    await audit(ctx, {
      action: `approval.${to}`,
      targetType: "approval",
      targetId: id,
      data: { actionType: approval.actionType, fingerprint: approval.fingerprint, note: input.note },
    }, tx);
    return { approval: updated };
  });
  if ("error" in outcome) throw outcome.error;
  return outcome.approval;
}

async function applyDecisionSideEffects(tx: Database, ctx: Ctx, approval: ApprovalRow, to: ApprovalStatus) {
  if (approval.taskId) {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, approval.taskId), eq(tasks.organizationId, ctx.organizationId)));
    if (task && task.status === "waiting_approval" && task.approvalRequestId === approval.id) {
      if (to === "approved") {
        await transitionTask(tx, task, "queued", ctx.actor, { message: "Approved; resuming", eventType: "approval.approved", set: { runAfter: new Date() } });
      } else if (to === "rejected") {
        await transitionTask(tx, task, "cancelled", ctx.actor, { message: "Rejected by reviewer", eventType: "approval.rejected" });
      } else if (to === "changes_requested") {
        await transitionTask(tx, task, "failed", ctx.actor, {
          message: "Reviewer requested changes",
          eventType: "approval.changes_requested",
          set: { error: { code: "changes_requested", message: approval.decisionNote ?? "Changes requested" } },
        });
      }
    }
  }
  if (approval.contentItemId && approval.actionType === CONTENT_PUBLISH_ACTION) {
    const [item] = await tx
      .select()
      .from(contentItems)
      .where(and(eq(contentItems.id, approval.contentItemId), eq(contentItems.organizationId, ctx.organizationId)));
    if (item) {
      const status =
        to === "approved" ? (item.scheduledAt ? "scheduled" : "approved") : to === "rejected" ? "rejected" : "changes_requested";
      await tx.update(contentItems).set({ status }).where(eq(contentItems.id, item.id));
    }
  }
}

/**
 * Called right before a sensitive action runs. Succeeds at most once per approval.
 * Re-checks: status, action type, fingerprint of the live payload, and that the
 * person who approved still holds approval rights *now*.
 * Call it outside a transaction that could roll back: invalidations must persist.
 */
export async function consumeApproval(
  db: Database,
  input: { organizationId: string; approvalId: string; actionType: string; currentPayload: Record<string, unknown>; executor: Actor; requestId?: string },
) {
  const approval = await loadApproval(db, input.organizationId, input.approvalId);
  if (approval.status === "executed") throw new AppError("approval_invalid", "This approval was already used");
  if (approval.status !== "approved") throw new AppError("approval_required", `Approval is ${approval.status}, not approved`);
  if (approval.actionType !== input.actionType) throw new AppError("approval_invalid", "Approval is for a different action");
  if (approval.expiresAt && approval.expiresAt < new Date()) {
    await setStatus(db, approval, "expired", { type: "system", name: "approvals" });
    throw new AppError("approval_invalid", "Approval has expired");
  }

  const fp = actionFingerprint(input.actionType, input.currentPayload);
  if (fp !== approval.fingerprint) {
    await setStatus(db, approval, "invalidated", input.executor, {}, "action changed after approval");
    throw new AppError("approval_invalid", "The action changed after it was approved. A new approval is needed.");
  }

  if (!approval.decidedByUserId) throw new AppError("approval_invalid", "Approval has no recorded approver");
  const membership = await getMembership(db, approval.decidedByUserId, input.organizationId);
  if (!membership || !can(membership.role, "approvals.decide")) {
    await setStatus(db, approval, "invalidated", input.executor, {}, "approver no longer has approval rights");
    throw new AppError("approval_invalid", "The approver no longer has approval rights. A new approval is needed.");
  }

  const [consumed] = await db
    .update(approvalRequests)
    .set({ status: "executed", executedAt: new Date() })
    .where(
      and(
        eq(approvalRequests.id, approval.id),
        eq(approvalRequests.status, "approved"),
        eq(approvalRequests.fingerprint, fp),
      ),
    )
    .returning();
  if (!consumed) throw new AppError("approval_invalid", "This approval was already used");

  await db.insert(approvalEvents).values({
    organizationId: input.organizationId,
    approvalRequestId: approval.id,
    type: "executed",
    actorType: input.executor.type,
    actorId: actorId(input.executor),
    fingerprint: fp,
  });
  await writeAudit(db, input.organizationId, input.executor, {
    action: "approval.executed",
    targetType: "approval",
    targetId: approval.id,
    data: { actionType: approval.actionType, fingerprint: fp },
  }, input.requestId);
  return consumed;
}

/** Voids open approvals for an object whose content changed. */
export async function invalidateOpenApprovals(
  db: Database,
  organizationId: string,
  target: { contentItemId?: string; taskId?: string },
  actor: Actor,
  reason: string,
) {
  const conds = [
    eq(approvalRequests.organizationId, organizationId),
    inArray(approvalRequests.status, ["pending", "approved"] as ApprovalStatus[]),
  ];
  if (target.contentItemId) conds.push(eq(approvalRequests.contentItemId, target.contentItemId));
  if (target.taskId) conds.push(eq(approvalRequests.taskId, target.taskId));
  const open = await db.select().from(approvalRequests).where(and(...conds));
  for (const a of open) await setStatus(db, a, "invalidated", actor, {}, reason);
  return open.length;
}

/** Marks pending/approved requests past their expiry. Run by the worker. */
export async function expireApprovals(db: Database) {
  const rows = await db
    .select()
    .from(approvalRequests)
    .where(and(inArray(approvalRequests.status, ["pending", "approved"] as ApprovalStatus[]), lt(approvalRequests.expiresAt, sql`now()`)));
  for (const a of rows) await setStatus(db, a, "expired", { type: "system", name: "worker" });
  return rows.length;
}
