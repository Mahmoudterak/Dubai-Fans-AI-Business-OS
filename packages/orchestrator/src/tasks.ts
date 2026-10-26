import { and, desc, eq, ilike, inArray, lt, sql, type SQL } from "drizzle-orm";
import { agentRuns, agents, contentItems, taskDependencies, taskEvents, tasks, type Database } from "@dfos/db";
import {
  agentForTaskType,
  AppError,
  CANCELLABLE_TASK_STATUSES,
  type TaskStatus,
} from "@dfos/domain";
import { taskInputSchemas, type CreateTaskBody, type TaskType } from "@dfos/contracts";
import { invalidateOpenApprovals } from "./approvals";
import { audit } from "./audit";
import { actorId, requirePermission, rowsOf, type Actor, type Ctx } from "./context";
import { recordTaskEvent, transitionTask, type TaskRow } from "./task-core";

export interface CreateTaskOptions {
  parentTaskId?: string;
  idempotencyKey?: string;
  /** Pre-validated dependency ids (used by the CEO agent when creating subtasks). */
}

export function validateTaskInput(type: TaskType, input: unknown) {
  const parsed = taskInputSchemas[type].safeParse(input);
  if (!parsed.success) {
    throw new AppError("validation_failed", "Invalid task input", parsed.error.issues);
  }
  return parsed.data as Record<string, unknown>;
}

export async function createTask(ctx: Ctx, body: CreateTaskBody, opts: CreateTaskOptions = {}) {
  requirePermission(ctx, "tasks.create");
  const def = agentForTaskType(body.type);
  if (!def) throw new AppError("validation_failed", `No agent handles task type "${body.type}"`);
  const input = validateTaskInput(body.type, body.input);

  if (opts.idempotencyKey) {
    const [existing] = await ctx.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.organizationId, ctx.organizationId), eq(tasks.idempotencyKey, opts.idempotencyKey)));
    if (existing) return { task: existing, deduplicated: true };
  }

  return ctx.db.transaction(async (tx) => {
    const [agent] = await tx
      .select()
      .from(agents)
      .where(and(eq(agents.organizationId, ctx.organizationId), eq(agents.key, def.key)));
    if (!agent) throw new AppError("not_found", `Agent "${def.key}" is not set up for this organization`);
    if (!agent.enabled) throw new AppError("agent_disabled", `${def.name} is disabled`);

    if (body.type === "marketing.draft_content") {
      const contentItemId = String(input.contentItemId);
      const [item] = await tx
        .select({ id: contentItems.id })
        .from(contentItems)
        .where(and(eq(contentItems.id, contentItemId), eq(contentItems.organizationId, ctx.organizationId)));
      if (!item) throw new AppError("not_found", "Content item not found");
    }

    if (body.dependsOn.length) {
      const deps = await tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.organizationId, ctx.organizationId), inArray(tasks.id, body.dependsOn)));
      if (deps.length !== new Set(body.dependsOn).size) {
        throw new AppError("validation_failed", "One or more dependencies were not found");
      }
    }

    if (opts.parentTaskId) {
      const [parent] = await tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.id, opts.parentTaskId), eq(tasks.organizationId, ctx.organizationId)));
      if (!parent) throw new AppError("not_found", "Parent task not found");
    }

    const [task] = await tx
      .insert(tasks)
      .values({
        organizationId: ctx.organizationId,
        parentTaskId: opts.parentTaskId,
        agentKey: def.key,
        type: body.type,
        title: body.title ?? `${def.name}: ${body.type}`,
        input,
        priority: body.priority,
        maxAttempts: agent.maxAttempts,
        budgetUsd: body.budgetUsd !== undefined ? String(body.budgetUsd) : undefined,
        createdByUserId: ctx.actor.type === "user" ? ctx.actor.userId : undefined,
        idempotencyKey: opts.idempotencyKey,
      })
      .returning();
    if (!task) throw new AppError("internal_error", "Failed to create task");

    if (body.dependsOn.length) {
      await tx.insert(taskDependencies).values(
        body.dependsOn.map((d) => ({ organizationId: ctx.organizationId, taskId: task.id, dependsOnTaskId: d })),
      );
    }
    await recordTaskEvent(tx, task, ctx.actor, "created", undefined, { type: body.type, dependsOn: body.dependsOn });
    await audit(ctx, { action: "task.created", targetType: "task", targetId: task.id, data: { type: body.type } }, tx);
    return { task, deduplicated: false };
  });
}

export async function listTasks(
  ctx: Ctx,
  q: { status?: TaskStatus; agent?: string; q?: string; limit: number; offset: number; parentTaskId?: string },
) {
  requirePermission(ctx, "tasks.read");
  const conds: SQL[] = [eq(tasks.organizationId, ctx.organizationId)];
  if (q.status) conds.push(eq(tasks.status, q.status));
  if (q.agent) conds.push(eq(tasks.agentKey, q.agent));
  if (q.parentTaskId) conds.push(eq(tasks.parentTaskId, q.parentTaskId));
  if (q.q) conds.push(ilike(tasks.title, `%${q.q.replace(/[%_\\]/g, "\\$&")}%`));
  const where = and(...conds);
  const [rows, [count]] = await Promise.all([
    ctx.db.select().from(tasks).where(where).orderBy(desc(tasks.createdAt)).limit(q.limit).offset(q.offset),
    ctx.db.select({ n: sql<number>`count(*)::int` }).from(tasks).where(where),
  ]);
  return { items: rows, total: count?.n ?? 0 };
}

async function loadTask(db: Database, organizationId: string, id: string) {
  const [task] = await db.select().from(tasks).where(and(eq(tasks.id, id), eq(tasks.organizationId, organizationId)));
  if (!task) throw new AppError("not_found", "Task not found");
  return task;
}

export async function getTask(ctx: Ctx, id: string) {
  requirePermission(ctx, "tasks.read");
  const task = await loadTask(ctx.db, ctx.organizationId, id);
  const [subtasks, deps, runs] = await Promise.all([
    ctx.db.select().from(tasks).where(and(eq(tasks.organizationId, ctx.organizationId), eq(tasks.parentTaskId, id))).orderBy(tasks.createdAt),
    ctx.db
      .select({ id: tasks.id, title: tasks.title, status: tasks.status })
      .from(taskDependencies)
      .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnTaskId))
      .where(and(eq(taskDependencies.taskId, id), eq(taskDependencies.organizationId, ctx.organizationId))),
    ctx.db.select().from(agentRuns).where(and(eq(agentRuns.taskId, id), eq(agentRuns.organizationId, ctx.organizationId))).orderBy(desc(agentRuns.startedAt)),
  ]);
  return { task, subtasks, dependencies: deps, runs };
}

export async function listTaskEvents(ctx: Ctx, id: string) {
  requirePermission(ctx, "tasks.read");
  await loadTask(ctx.db, ctx.organizationId, id);
  return ctx.db
    .select()
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, id), eq(taskEvents.organizationId, ctx.organizationId)))
    .orderBy(taskEvents.createdAt);
}

export async function cancelTask(ctx: Ctx, id: string, reason?: string) {
  requirePermission(ctx, "tasks.cancel");
  return ctx.db.transaction(async (tx) => {
    const task = await loadTask(tx, ctx.organizationId, id);
    if (!CANCELLABLE_TASK_STATUSES.includes(task.status)) {
      throw new AppError("invalid_transition", `A ${task.status} task cannot be cancelled`);
    }
    const updated = await transitionTask(tx, task, "cancelled", ctx.actor, { message: reason ?? "Cancelled by user" });
    await invalidateOpenApprovals(tx, ctx.organizationId, { taskId: id }, ctx.actor, "task cancelled");
    await cancelDependents(tx, ctx.organizationId, id, ctx.actor);
    await audit(ctx, { action: "task.cancelled", targetType: "task", targetId: id, data: { reason } }, tx);
    return updated;
  });
}

export async function retryTask(ctx: Ctx, id: string) {
  requirePermission(ctx, "tasks.create");
  return ctx.db.transaction(async (tx) => {
    const task = await loadTask(tx, ctx.organizationId, id);
    if (task.status !== "failed") throw new AppError("invalid_transition", "Only failed tasks can be retried");
    const updated = await transitionTask(tx, task, "queued", ctx.actor, {
      message: "Manual retry",
      eventType: "retry.manual",
      set: { attempts: 0, error: null, runAfter: new Date(), approvalRequestId: null, finishedAt: null },
    });
    await audit(ctx, { action: "task.retried", targetType: "task", targetId: id }, tx);
    return updated;
  });
}

/** Tasks that depend (directly or indirectly) on a failed/cancelled task can never run: cancel them. */
export async function cancelDependents(db: Database, organizationId: string, taskId: string, actor: Actor) {
  const pending: string[] = [taskId];
  const seen = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const dependents = await db
      .select({ task: tasks })
      .from(taskDependencies)
      .innerJoin(tasks, eq(tasks.id, taskDependencies.taskId))
      .where(and(eq(taskDependencies.dependsOnTaskId, current), eq(taskDependencies.organizationId, organizationId)));
    for (const { task } of dependents) {
      if (CANCELLABLE_TASK_STATUSES.includes(task.status)) {
        await transitionTask(db, task, "cancelled", actor, {
          message: "A task this one depends on did not succeed",
          eventType: "dependency.failed",
          data: { dependency: current },
        });
        pending.push(task.id);
      }
    }
  }
}

// ───────────────────────── Worker queue ─────────────────────────

/**
 * Claims one runnable task with FOR UPDATE SKIP LOCKED, so several workers can
 * run safely in parallel. Skips paused orgs, disabled agents and tasks whose
 * dependencies have not all succeeded.
 */
export async function claimNextTask(db: Database, workerId: string): Promise<TaskRow | undefined> {
  const res = await db.execute(sql`
    WITH next AS (
      SELECT t.id, t.status AS prev_status
      FROM tasks t
      JOIN organizations o ON o.id = t.organization_id
      JOIN agents a ON a.organization_id = t.organization_id AND a.key = t.agent_key
      WHERE t.status IN ('queued', 'retrying')
        AND t.run_after <= now()
        AND o.agents_paused = false
        AND a.enabled = true
        AND NOT EXISTS (
          SELECT 1 FROM task_dependencies d
          JOIN tasks dt ON dt.id = d.depends_on_task_id
          WHERE d.task_id = t.id AND dt.status <> 'succeeded'
        )
      ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.created_at
      FOR UPDATE OF t SKIP LOCKED
      LIMIT 1
    )
    UPDATE tasks SET
      status = 'running',
      locked_at = now(),
      locked_by = ${workerId},
      attempts = tasks.attempts + 1,
      started_at = coalesce(tasks.started_at, now()),
      updated_at = now()
    FROM next
    WHERE tasks.id = next.id
    RETURNING tasks.id, next.prev_status
  `);
  const row = rowsOf<{ id: string; prev_status: TaskStatus }>(res)[0];
  if (!row) return undefined;
  const [task] = await db.select().from(tasks).where(eq(tasks.id, row.id));
  if (!task) return undefined;
  await db.insert(taskEvents).values({
    organizationId: task.organizationId,
    taskId: task.id,
    type: "status.running",
    fromStatus: row.prev_status,
    toStatus: "running",
    message: `Claimed by ${workerId} (attempt ${task.attempts})`,
    actorType: "system",
    actorId: actorId({ type: "system", name: workerId }),
  });
  return task;
}

/** Running tasks whose worker died (lock older than timeout) go back to retrying or fail. */
export async function recoverStaleTasks(db: Database, lockTimeoutMs: number) {
  const cutoff = new Date(Date.now() - lockTimeoutMs);
  const stale = await db
    .select()
    .from(tasks)
    // Typed comparison: postgres-js cannot serialise a Date placed inside a raw sql`` fragment.
    .where(and(eq(tasks.status, "running"), lt(tasks.lockedAt, cutoff)));
  const actor: Actor = { type: "system", name: "recovery" };
  for (const task of stale) {
    try {
      if (task.attempts < task.maxAttempts) {
        await transitionTask(db, task, "retrying", actor, {
          message: "Worker lock expired; will retry",
          eventType: "recovery.stale_lock",
          set: { lockedAt: null, lockedBy: null, runAfter: new Date() },
        });
      } else {
        await transitionTask(db, task, "failed", actor, {
          message: "Worker lock expired and attempts are exhausted",
          eventType: "recovery.stale_lock",
          set: { error: { code: "worker_lost", message: "Worker stopped while running this task" } },
        });
        await cancelDependents(db, task.organizationId, task.id, actor);
      }
    } catch (e) {
      if (!(e instanceof AppError && e.code === "conflict")) throw e;
    }
  }
  return stale.length;
}
