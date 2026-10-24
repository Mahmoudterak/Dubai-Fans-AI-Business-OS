import { and, eq, gte, sql } from "drizzle-orm";
import {
  AiBudgetExceededError,
  AiNotConfiguredError,
  AiOutputInvalidError,
  AiProviderError,
  createAiGateway,
  type AiGateway,
  type UsageRecord,
} from "@dfos/ai";
import { agentRuns, agentToolPermissions, agents, aiModelUsage, organizations, tasks, type Database } from "@dfos/db";
import { AppError, getAgentDefinition, isAppError } from "@dfos/domain";
import type { TaskType } from "@dfos/contracts";
import { logger, type Logger } from "@dfos/observability";
import { createApprovalRequest } from "./approvals";
import { writeAudit } from "./audit";
import type { Actor } from "./context";
import { HANDLERS, type HandlerResult } from "./handlers";
import { cancelDependents } from "./tasks";
import { transitionTask, type TaskRow } from "./task-core";

export interface RunnerDeps {
  /** Build an AI gateway that records usage through `onUsage`. Tests inject a mock-backed one. */
  makeAi?: (onUsage: (u: UsageRecord) => Promise<void>) => AiGateway;
  log?: Logger;
  now?: () => Date;
}

interface ClassifiedError {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
}

export function classifyError(err: unknown): ClassifiedError {
  if (err instanceof AiNotConfiguredError) return { code: "ai_not_configured", message: err.message, retryable: false };
  if (err instanceof AiBudgetExceededError) return { code: "budget_exceeded", message: err.message, retryable: false };
  if (err instanceof AiOutputInvalidError) return { code: "ai_output_invalid", message: err.message, retryable: true };
  if (err instanceof AiProviderError) return { code: `ai_${err.code}`, message: err.message, retryable: err.retryable };
  if (err instanceof TimeoutError) return { code: "timeout", message: err.message, retryable: true };
  if (isAppError(err)) {
    const retryable = err.code === "conflict" || err.code === "internal_error";
    return { code: err.code, message: err.message, retryable, details: err.details };
  }
  return { code: "internal_error", message: err instanceof Error ? err.message : String(err), retryable: true };
}

class TimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(`Agent run exceeded ${ms} ms`)), ms);
    }),
  ]);
}

/** Exponential backoff: 10s, 20s, 40s ... capped at 10 minutes. */
export function retryDelayMs(attempt: number) {
  return Math.min(10_000 * 2 ** Math.max(0, attempt - 1), 600_000);
}

async function remainingBudget(db: Database, task: TaskRow, agent: typeof agents.$inferSelect, org: typeof organizations.$inferSelect) {
  const limits: number[] = [];
  const [spentTask] = await db
    .select({ s: sql<string | null>`sum(${aiModelUsage.costUsd})::text` })
    .from(aiModelUsage)
    .where(eq(aiModelUsage.taskId, task.id));
  const taskSpent = Number(spentTask?.s ?? 0);
  if (task.budgetUsd) limits.push(Number(task.budgetUsd) - taskSpent);
  if (agent.maxCostPerRunUsd) limits.push(Number(agent.maxCostPerRunUsd));
  if (org.aiMonthlyBudgetUsd) {
    const start = new Date();
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
    const [spentMonth] = await db
      .select({ s: sql<string | null>`sum(${aiModelUsage.costUsd})::text` })
      .from(aiModelUsage)
      .where(and(eq(aiModelUsage.organizationId, org.id), gte(aiModelUsage.createdAt, start)));
    limits.push(Number(org.aiMonthlyBudgetUsd) - Number(spentMonth?.s ?? 0));
  }
  return limits.length ? Math.min(...limits) : null;
}

/**
 * Executes a task already claimed by `claimNextTask` (status = running).
 * Records an agent run, AI usage, task events and audit entries, and decides
 * the next state: succeeded, waiting_approval, retrying or failed.
 */
export async function executeTask(db: Database, task: TaskRow, deps: RunnerDeps = {}) {
  const log = (deps.log ?? logger).child({ taskId: task.id, traceId: task.traceId, type: task.type });
  const [org] = await db.select().from(organizations).where(eq(organizations.id, task.organizationId));
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.organizationId, task.organizationId), eq(agents.key, task.agentKey)));
  const actor: Extract<Actor, { type: "agent" }> = { type: "agent", agentKey: task.agentKey };
  const systemActor: Actor = { type: "system", name: "runner" };

  const [run] = await db
    .insert(agentRuns)
    .values({
      organizationId: task.organizationId,
      taskId: task.id,
      agentKey: task.agentKey,
      attempt: task.attempts,
      traceId: task.traceId,
    })
    .returning();
  if (!run) throw new Error("failed to create agent run");
  const started = Date.now();

  const usage = { inputTokens: 0, outputTokens: 0, costUsd: null as number | null, model: null as string | null };
  const onUsage = async (u: UsageRecord) => {
    await db.insert(aiModelUsage).values({
      organizationId: task.organizationId,
      agentRunId: run.id,
      taskId: task.id,
      provider: u.provider,
      model: u.model,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      costUsd: u.costUsd === null ? null : u.costUsd.toFixed(6),
      costSource: u.costSource,
      latencyMs: u.latencyMs,
      success: u.success,
      errorCode: u.errorCode,
    });
    usage.inputTokens += u.inputTokens;
    usage.outputTokens += u.outputTokens;
    if (u.costUsd !== null) usage.costUsd = (usage.costUsd ?? 0) + u.costUsd;
    usage.model = u.model;
  };

  const finishRun = async (status: "succeeded" | "failed", summary: string | null, error?: { code: string; message: string }) => {
    await db
      .update(agentRuns)
      .set({
        status,
        finishedAt: new Date(),
        durationMs: Date.now() - started,
        summary,
        error,
        model: usage.model,
        inputTokens: usage.inputTokens || null,
        outputTokens: usage.outputTokens || null,
        costUsd: usage.costUsd === null ? null : usage.costUsd.toFixed(6),
      })
      .where(eq(agentRuns.id, run.id));
  };

  try {
    if (!org || !agent) throw new AppError("not_found", "Organization or agent missing");
    if (org.agentsPaused) throw new AppError("agent_disabled", "Agents are paused for this organization");
    if (!agent.enabled) throw new AppError("agent_disabled", "Agent is disabled");
    const def = getAgentDefinition(task.agentKey);
    const handler = HANDLERS[task.type as TaskType];
    if (!def || !handler || !def.taskTypes.includes(task.type)) {
      throw new AppError("validation_failed", `No handler for task type ${task.type}`);
    }

    const ai = (deps.makeAi ?? ((cb) => createAiGateway({ onUsage: cb })))(onUsage);
    const budget = await remainingBudget(db, task, agent, org);
    if (budget !== null && budget <= 0) throw new AppError("budget_exceeded", "AI budget for this task, agent or month is used up");

    const result: HandlerResult = await withTimeout(
      handler({
        db,
        task,
        org,
        agent,
        runId: run.id,
        actor,
        ai,
        log,
        remainingBudgetUsd: budget,
        async requireTool(tool) {
          const [perm] = await db
            .select()
            .from(agentToolPermissions)
            .where(and(eq(agentToolPermissions.agentId, agent.id), eq(agentToolPermissions.tool, tool)));
          if (!perm?.allowed || !def.tools.includes(tool)) {
            throw new AppError("forbidden", `Agent ${def.key} is not allowed to use tool ${tool}`);
          }
        },
      }),
      agent.timeoutMs,
    );

    if (result.kind === "needs_approval") {
      const approval = await createApprovalRequest(db, actor, {
        organizationId: task.organizationId,
        taskId: task.id,
        ...result.approval,
      });
      await transitionTask(db, task, "waiting_approval", actor, {
        message: result.summary,
        set: { approvalRequestId: approval.id, result: result.result, lockedAt: null, lockedBy: null },
        data: { approvalRequestId: approval.id },
      });
      await finishRun("succeeded", result.summary);
      log.info("task waiting for approval", { approvalId: approval.id });
      return { status: "waiting_approval" as const, approvalId: approval.id };
    }

    await transitionTask(db, task, "succeeded", actor, { message: result.summary, set: { result: result.result, error: null } });
    await finishRun("succeeded", result.summary);
    await writeAudit(db, task.organizationId, actor, { action: "task.succeeded", targetType: "task", targetId: task.id });
    log.info("task succeeded");
    return { status: "succeeded" as const };
  } catch (err) {
    const c = classifyError(err);
    await finishRun("failed", null, { code: c.code, message: c.message });
    const [fresh] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    if (!fresh || fresh.status !== "running") {
      // Someone else moved it (e.g. stale-lock recovery). Do not fight over the state.
      log.warn("task no longer running after failure", { code: c.code });
      return { status: "abandoned" as const };
    }
    const error = { code: c.code, message: c.message, ...(c.details ? { details: c.details } : {}) };
    if (c.retryable && fresh.attempts < fresh.maxAttempts) {
      const delay = retryDelayMs(fresh.attempts);
      await transitionTask(db, fresh, "retrying", systemActor, {
        message: `Attempt ${fresh.attempts} failed (${c.code}); retrying in ${Math.round(delay / 1000)}s`,
        set: { error, runAfter: new Date(Date.now() + delay), lockedAt: null, lockedBy: null },
      });
      log.warn("task will retry", { code: c.code, attempt: fresh.attempts });
      return { status: "retrying" as const, error };
    }
    await transitionTask(db, fresh, "failed", systemActor, { message: c.message, set: { error } });
    await cancelDependents(db, fresh.organizationId, fresh.id, systemActor);
    await writeAudit(db, task.organizationId, systemActor, { action: "task.failed", targetType: "task", targetId: task.id, data: { code: c.code } });
    log.error("task failed", { code: c.code });
    return { status: "failed" as const, error };
  }
}
