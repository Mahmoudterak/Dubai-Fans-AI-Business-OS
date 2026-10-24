import { t } from "@/i18n/ar";
import { Badge } from "./ui";

type Tone = Parameters<typeof Badge>[0]["tone"];

const taskTone: Record<string, Tone> = {
  queued: "neutral",
  running: "blue",
  waiting_approval: "gold",
  retrying: "amber",
  succeeded: "green",
  failed: "red",
  cancelled: "neutral",
};
const approvalTone: Record<string, Tone> = {
  pending: "gold",
  approved: "green",
  rejected: "red",
  changes_requested: "amber",
  executed: "blue",
  invalidated: "neutral",
  expired: "neutral",
};
const contentTone: Record<string, Tone> = {
  draft: "neutral",
  in_review: "gold",
  changes_requested: "amber",
  approved: "green",
  scheduled: "purple",
  publishing: "blue",
  published: "green",
  failed: "red",
  rejected: "red",
};
const riskTone: Record<string, Tone> = { low: "neutral", medium: "amber", high: "red", critical: "red" };

export const TaskStatus = ({ s }: { s: string }) => <Badge tone={taskTone[s]}>{t.taskStatus[s as keyof typeof t.taskStatus] ?? s}</Badge>;
export const ApprovalStatus = ({ s }: { s: string }) => (
  <Badge tone={approvalTone[s]}>{t.approvalStatus[s as keyof typeof t.approvalStatus] ?? s}</Badge>
);
export const ContentStatus = ({ s }: { s: string }) => (
  <Badge tone={contentTone[s]}>{t.contentStatus[s as keyof typeof t.contentStatus] ?? s}</Badge>
);
export const RiskBadge = ({ s }: { s: string }) => <Badge tone={riskTone[s]}>خطورة: {t.risk[s as keyof typeof t.risk] ?? s}</Badge>;

export function formatDate(d: Date | string | null | undefined, timeZone = "Asia/Dubai") {
  if (!d) return "—";
  return new Intl.DateTimeFormat("ar-AE", { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(d));
}

export function formatUsd(v: string | number | null | undefined) {
  if (v === null || v === undefined) return "—";
  return `$${Number(v).toFixed(4)}`;
}
