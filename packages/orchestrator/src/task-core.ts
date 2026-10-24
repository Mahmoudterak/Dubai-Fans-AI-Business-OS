import { and, eq } from "drizzle-orm";
import { taskEvents, tasks, type Database } from "@dfos/db";
import { AppError, assertTaskTransition, type TaskStatus } from "@dfos/domain";
import { actorId, type Actor } from "./context";

export type TaskRow = typeof tasks.$inferSelect;

export interface TransitionOptions {
  message?: string;
  data?: Record<string, unknown>;
  set?: Partial<typeof tasks.$inferInsert>;
  eventType?: string;
}

/**
 * Moves a task between states. Validates the transition and uses
 * compare-and-set on the current status so two workers cannot both win.
 */
export async function transitionTask(
  db: Database,
  task: Pick<TaskRow, "id" | "organizationId" | "status">,
  to: TaskStatus,
  actor: Actor,
  opts: TransitionOptions = {},
): Promise<TaskRow> {
  assertTaskTransition(task.status, to);
  const terminal = to === "succeeded" || to === "failed" || to === "cancelled";
  const [updated] = await db
    .update(tasks)
    .set({
      status: to,
      ...(terminal ? { finishedAt: new Date(), lockedAt: null, lockedBy: null } : {}),
      ...(opts.set ?? {}),
    })
    .where(
      and(
        eq(tasks.id, task.id),
        eq(tasks.organizationId, task.organizationId),
        eq(tasks.status, task.status),
      ),
    )
    .returning();
  if (!updated) {
    throw new AppError("conflict", "Task changed state concurrently; reload and try again");
  }
  await db.insert(taskEvents).values({
    organizationId: task.organizationId,
    taskId: task.id,
    type: opts.eventType ?? `status.${to}`,
    fromStatus: task.status,
    toStatus: to,
    message: opts.message,
    data: opts.data,
    actorType: actor.type,
    actorId: actorId(actor),
  });
  return updated;
}

export async function recordTaskEvent(
  db: Database,
  task: Pick<TaskRow, "id" | "organizationId">,
  actor: Actor,
  type: string,
  message?: string,
  data?: Record<string, unknown>,
) {
  await db.insert(taskEvents).values({
    organizationId: task.organizationId,
    taskId: task.id,
    type,
    message,
    data,
    actorType: actor.type,
    actorId: actorId(actor),
  });
}
