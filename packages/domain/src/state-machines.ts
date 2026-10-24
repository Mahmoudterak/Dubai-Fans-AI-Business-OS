import { AppError } from "./errors";

export const TASK_STATUSES = [
  "queued",
  "running",
  "waiting_approval",
  "retrying",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

const taskTransitions: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ["running", "cancelled"],
  // running -> queued is used when a stale lock is recovered.
  running: ["succeeded", "failed", "waiting_approval", "retrying", "queued"],
  waiting_approval: ["queued", "cancelled", "failed"],
  retrying: ["running", "cancelled", "failed"],
  failed: ["queued"], // manual retry only
  succeeded: [],
  cancelled: [],
};

export const CANCELLABLE_TASK_STATUSES: readonly TaskStatus[] = [
  "queued",
  "waiting_approval",
  "retrying",
];
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ["succeeded", "cancelled"];

export function canTransitionTask(from: TaskStatus, to: TaskStatus) {
  return taskTransitions[from].includes(to);
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus) {
  if (!canTransitionTask(from, to)) {
    throw new AppError("invalid_transition", `Task cannot move from "${from}" to "${to}"`);
  }
}

export const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "changes_requested",
  "executed",
  "invalidated",
  "expired",
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

const approvalTransitions: Record<ApprovalStatus, readonly ApprovalStatus[]> = {
  pending: ["approved", "rejected", "changes_requested", "invalidated", "expired"],
  approved: ["executed", "invalidated", "expired"],
  rejected: [],
  changes_requested: [],
  executed: [],
  invalidated: [],
  expired: [],
};

export function canTransitionApproval(from: ApprovalStatus, to: ApprovalStatus) {
  return approvalTransitions[from].includes(to);
}

export function assertApprovalTransition(from: ApprovalStatus, to: ApprovalStatus) {
  if (!canTransitionApproval(from, to)) {
    throw new AppError("invalid_transition", `Approval cannot move from "${from}" to "${to}"`);
  }
}

export const CONTENT_STATUSES = [
  "draft",
  "in_review",
  "changes_requested",
  "approved",
  "scheduled",
  "publishing",
  "published",
  "failed",
  "rejected",
] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

export const CONTENT_PLATFORMS = ["instagram", "facebook", "tiktok", "whatsapp", "website"] as const;
export type ContentPlatform = (typeof CONTENT_PLATFORMS)[number];

export const CONTENT_FORMATS = ["post", "reel", "story", "carousel", "ad_copy", "caption"] as const;
export type ContentFormat = (typeof CONTENT_FORMATS)[number];

export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
