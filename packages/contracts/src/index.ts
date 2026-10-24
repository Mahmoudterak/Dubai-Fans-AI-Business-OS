import { z } from "zod";
import {
  APPROVAL_STATUSES,
  CONTENT_FORMATS,
  CONTENT_PLATFORMS,
  CONTENT_STATUSES,
  TASK_PRIORITIES,
  TASK_STATUSES,
} from "@dfos/domain";

// ─────────── Task inputs, one schema per implemented task type ───────────

export const taskInputSchemas = {
  "ceo.plan": z.object({
    goal: z.string().trim().min(5).max(2000),
  }),
  "marketing.draft_content": z.object({
    contentItemId: z.uuid(),
    instructions: z.string().trim().max(2000).optional(),
  }),
  "operations.health_check": z.object({}).strict(),
  "finance.ai_usage_report": z.object({
    days: z.number().int().min(1).max(90).default(30),
  }),
} as const;

export type TaskType = keyof typeof taskInputSchemas;
export const TASK_TYPES = Object.keys(taskInputSchemas) as [TaskType, ...TaskType[]];

export const createTaskBody = z.object({
  type: z.enum(TASK_TYPES),
  title: z.string().trim().min(1).max(200).optional(),
  input: z.record(z.string(), z.unknown()).default({}),
  priority: z.enum(TASK_PRIORITIES).default("normal"),
  dependsOn: z.array(z.uuid()).max(20).default([]),
  budgetUsd: z.number().positive().max(1000).optional(),
});
export type CreateTaskBody = z.infer<typeof createTaskBody>;

export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

export const listTasksQuery = paginationQuery.extend({
  status: z.enum(TASK_STATUSES).optional(),
  agent: z.string().max(40).optional(),
  q: z.string().max(200).optional(),
});

export const listApprovalsQuery = paginationQuery.extend({
  status: z.enum(APPROVAL_STATUSES).optional(),
});

export const listContentQuery = paginationQuery.extend({
  status: z.enum(CONTENT_STATUSES).optional(),
  platform: z.enum(CONTENT_PLATFORMS).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

// ─────────── Approvals ───────────

/** The reviewer must send back the fingerprint they saw, so the decision binds to that exact version. */
export const approvalDecisionBody = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  note: z.string().trim().max(2000).optional(),
});

export const requestChangesBody = approvalDecisionBody.extend({
  note: z.string().trim().min(1).max(2000),
});

// ─────────── Content ───────────

const hashtags = z
  .array(z.string().trim().regex(/^#?[\p{L}\p{N}_]{1,60}$/u, "Invalid hashtag"))
  .max(30)
  .default([]);

export const contentVersionBody = z.object({
  body: z.string().trim().min(1).max(5000),
  hashtags,
  cta: z.string().trim().max(300).optional(),
});

export const createContentBody = contentVersionBody.extend({
  title: z.string().trim().min(1).max(200),
  platform: z.enum(CONTENT_PLATFORMS),
  format: z.enum(CONTENT_FORMATS),
  audience: z.string().trim().max(500).optional(),
  goal: z.string().trim().max(500).optional(),
  tone: z.string().trim().max(100).optional(),
});

export const generateContentBody = z.object({
  contentItemId: z.uuid(),
  instructions: z.string().trim().max(2000).optional(),
});

export const scheduleContentBody = z.object({
  scheduledAt: z.iso.datetime({ offset: true }),
});

// ─────────── Agents ───────────

export const updateAgentBody = z.object({
  enabled: z.boolean().optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  maxCostPerRunUsd: z.number().positive().max(100).nullable().optional(),
});

export const updateOrgSettingsBody = z.object({
  agentsPaused: z.boolean().optional(),
  aiMonthlyBudgetUsd: z.number().positive().max(100000).nullable().optional(),
  timezone: z.string().max(64).optional(),
});

// ─────────── AI output schemas ───────────

export const ceoPlanOutput = z.object({
  summary: z.string().min(1).max(2000),
  subtasks: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        agent: z.string().min(1).max(40),
        type: z.string().min(1).max(80),
        rationale: z.string().max(1000),
        input: z.record(z.string(), z.unknown()).default({}),
        dependsOnIndex: z.array(z.number().int().min(0)).max(10).default([]),
      }),
    )
    .min(1)
    .max(10),
});
export type CeoPlanOutput = z.infer<typeof ceoPlanOutput>;

export const marketingDraftOutput = z.object({
  variants: z
    .array(
      z.object({
        body: z.string().min(1).max(5000),
        hashtags: z.array(z.string().max(60)).max(30).default([]),
        cta: z.string().max(300).optional(),
      }),
    )
    .min(1)
    .max(3),
  notes: z.string().max(1000).optional(),
});
export type MarketingDraftOutput = z.infer<typeof marketingDraftOutput>;
