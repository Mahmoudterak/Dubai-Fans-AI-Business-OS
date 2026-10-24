import { and, desc, eq } from "drizzle-orm";
import { untrusted } from "@dfos/ai";
import { approvalRequests, contentItems } from "@dfos/db";
import { actionFingerprint, AGENT_DEFINITIONS, AppError } from "@dfos/domain";
import { ceoPlanOutput, taskInputSchemas, TASK_TYPES, type TaskType } from "@dfos/contracts";
import { consumeApproval } from "../approvals";
import { createTask } from "../tasks";
import type { HandlerContext, HandlerResult, TaskHandler } from "./types";

export const CREATE_SUBTASKS_ACTION = "tasks.create_subtasks";

interface PlannedSubtask {
  title: string;
  type: TaskType;
  agent: string;
  input: Record<string, unknown>;
  dependsOnIndex: number[];
  rationale: string;
}
interface PlanPayload extends Record<string, unknown> {
  parentTaskId: string;
  summary: string;
  subtasks: PlannedSubtask[];
}

const delegableTypes: readonly TaskType[] = TASK_TYPES.filter((t) => t !== "ceo.plan");

const SYSTEM = `You are the CEO orchestration agent of "Dubai Fans", a business in Dubai.
Break the manager's goal into 1-6 concrete subtasks and assign each to one agent.
You may ONLY use these task types (agent → type → required input):
${AGENT_DEFINITIONS.filter((a) => a.key !== "ceo")
  .flatMap((a) => a.taskTypes.map((t) => `- agent "${a.key}" → type "${t}"`))
  .join("\n")}
Input rules:
- "marketing.draft_content": {"contentItemId": "<id from the content list>", "instructions": "..."}. Only use ids from the provided list. If none fits, do not use this type.
- "operations.health_check": {}
- "finance.ai_usage_report": {"days": 1-90}
Use dependsOnIndex to reference earlier subtasks (0-based) that must finish first.
Write titles and rationale in Arabic.
Return JSON: {"summary": string, "subtasks": [{"title","agent","type","rationale","input","dependsOnIndex"}]}`;

/**
 * Model output is untrusted: every subtask is checked against the task types we
 * actually support, the agent that owns them, and their input schema.
 * A subtask whose dependency was rejected is rejected too.
 */
export function validatePlan(
  subtasks: Array<{ title: string; agent: string; type: string; rationale: string; input: Record<string, unknown>; dependsOnIndex: number[] }>,
  knownContentIds: Set<string>,
) {
  const accepted: PlannedSubtask[] = [];
  const rejected: Array<{ index: number; title: string; reason: string }> = [];
  const acceptedIndex = new Map<number, number>(); // model index -> accepted index

  subtasks.forEach((s, index) => {
    const reject = (reason: string) => rejected.push({ index, title: s.title, reason });
    const type = s.type as TaskType;
    const def = AGENT_DEFINITIONS.find((a) => a.taskTypes.includes(type));
    if (!delegableTypes.includes(type) || !def) return reject("unsupported task type");
    if (def.key !== s.agent) return reject("agent does not handle this type");
    const parsed = taskInputSchemas[type].safeParse(s.input);
    if (!parsed.success) return reject("invalid input");
    if (type === "marketing.draft_content" && !knownContentIds.has(String((parsed.data as { contentItemId: string }).contentItemId))) {
      return reject("unknown content item");
    }
    const deps = s.dependsOnIndex.filter((j) => j !== index);
    if (deps.some((j) => j > index || !acceptedIndex.has(j))) return reject("depends on a missing or rejected subtask");
    acceptedIndex.set(index, accepted.length);
    accepted.push({
      title: s.title,
      type,
      agent: def.key,
      input: parsed.data as Record<string, unknown>,
      dependsOnIndex: deps.map((j) => acceptedIndex.get(j)!),
      rationale: s.rationale,
    });
    return undefined;
  });
  return { accepted, rejected };
}

async function createPlannedSubtasks(h: HandlerContext, plan: PlanPayload) {
  const created: string[] = [];
  for (const [i, s] of plan.subtasks.entries()) {
    const dependsOn = s.dependsOnIndex.map((j) => created[j]).filter((x): x is string => Boolean(x));
    const { task } = await createTask(
      { db: h.db, organizationId: h.org.id, actor: h.actor },
      { type: s.type, title: s.title, input: s.input, priority: h.task.priority, dependsOn },
      // Deterministic keys make resuming after a crash safe: no duplicate subtasks.
      { parentTaskId: h.task.id, idempotencyKey: `${h.task.id}:subtask:${i}` },
    );
    created.push(task.id);
  }
  return created;
}

export const ceoPlan: TaskHandler = async (h): Promise<HandlerResult> => {
  const pending = (h.task.result as { pendingPlan?: PlanPayload } | null)?.pendingPlan;

  // Second run: the plan was approved. Consume the approval, then create subtasks.
  if (h.task.approvalRequestId && pending) {
    await h.requireTool(CREATE_SUBTASKS_ACTION);
    const [approval] = await h.db
      .select()
      .from(approvalRequests)
      .where(and(eq(approvalRequests.id, h.task.approvalRequestId), eq(approvalRequests.organizationId, h.org.id)));
    const alreadyConsumed =
      approval?.status === "executed" &&
      approval.taskId === h.task.id &&
      approval.fingerprint === actionFingerprint(CREATE_SUBTASKS_ACTION, pending);
    if (!alreadyConsumed) {
      await consumeApproval(h.db, {
        organizationId: h.org.id,
        approvalId: h.task.approvalRequestId,
        actionType: CREATE_SUBTASKS_ACTION,
        currentPayload: pending,
        executor: h.actor,
      });
    }
    const ids = await createPlannedSubtasks(h, pending);
    return {
      kind: "succeeded",
      summary: `تم إنشاء ${ids.length} مهام فرعية بعد الموافقة`,
      result: { plan: pending, subtaskIds: ids },
    };
  }

  // First run: ask the model for a plan, validate it, and request approval.
  const goal = String(h.task.input.goal ?? "");
  const content = await h.db
    .select({ id: contentItems.id, title: contentItems.title, platform: contentItems.platform })
    .from(contentItems)
    .where(eq(contentItems.organizationId, h.org.id))
    .orderBy(desc(contentItems.updatedAt))
    .limit(20);

  const out = await h.ai.generateStructured({
    system: SYSTEM,
    prompt: [
      untrusted("manager_goal", goal),
      untrusted("content_items", JSON.stringify(content)),
    ].join("\n\n"),
    schema: ceoPlanOutput,
    model: h.agent.model ?? undefined,
    remainingBudgetUsd: h.remainingBudgetUsd,
  });

  const { accepted, rejected } = validatePlan(out.data.subtasks, new Set(content.map((c) => c.id)));

  if (accepted.length === 0) {
    throw new AppError("ai_output_invalid", "The plan had no valid subtasks", { rejected });
  }

  const plan: PlanPayload = { parentTaskId: h.task.id, summary: out.data.summary, subtasks: accepted };
  return {
    kind: "needs_approval",
    summary: `خطة من ${accepted.length} مهام بانتظار الموافقة`,
    result: { pendingPlan: plan, rejectedSubtasks: rejected },
    approval: {
      actionType: CREATE_SUBTASKS_ACTION,
      title: `خطة المدير التنفيذي: ${h.task.title}`,
      summary: out.data.summary,
      payload: plan,
      riskLevel: "medium",
    },
  };
};
