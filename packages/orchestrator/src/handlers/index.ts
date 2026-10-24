import type { TaskType } from "@dfos/contracts";
import { ceoPlan } from "./ceo";
import { financeAiUsageReport } from "./finance";
import { marketingDraftContent } from "./marketing";
import { operationsHealthCheck } from "./operations";
import type { TaskHandler } from "./types";

export const HANDLERS: Record<TaskType, TaskHandler> = {
  "ceo.plan": ceoPlan,
  "marketing.draft_content": marketingDraftContent,
  "operations.health_check": operationsHealthCheck,
  "finance.ai_usage_report": financeAiUsageReport,
};

export type { HandlerContext, HandlerResult, TaskHandler } from "./types";
export { validatePlan, CREATE_SUBTASKS_ACTION } from "./ceo";
