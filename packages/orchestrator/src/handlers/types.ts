import type { AiGateway } from "@dfos/ai";
import type { agents, organizations, Database } from "@dfos/db";
import type { RiskLevel } from "@dfos/domain";
import type { Logger } from "@dfos/observability";
import type { Actor } from "../context";
import type { TaskRow } from "../task-core";

export interface HandlerContext {
  db: Database;
  task: TaskRow;
  org: typeof organizations.$inferSelect;
  agent: typeof agents.$inferSelect;
  runId: string;
  actor: Extract<Actor, { type: "agent" }>;
  ai: AiGateway;
  log: Logger;
  /** Remaining USD budget for this run, or null when no ceiling applies. */
  remainingBudgetUsd: number | null;
  /** Throws unless the org allows this agent to use the tool. */
  requireTool(tool: string): Promise<void>;
}

export type HandlerResult =
  | { kind: "succeeded"; summary: string; result: Record<string, unknown> }
  | {
      kind: "needs_approval";
      summary: string;
      /** Stored on the task so the resumed run can rebuild the exact payload. */
      result: Record<string, unknown>;
      approval: {
        actionType: string;
        title: string;
        summary?: string;
        payload: Record<string, unknown>;
        riskLevel: RiskLevel;
      };
    };

export type TaskHandler = (ctx: HandlerContext) => Promise<HandlerResult>;
