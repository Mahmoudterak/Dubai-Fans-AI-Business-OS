import { approvalDecisionBody } from "@dfos/contracts";
import { decideApproval } from "@dfos/orchestrator";
import { parseId, route } from "@/server/api";

export const POST = route<typeof approvalDecisionBody, undefined, { id: string }>(
  { permission: "approvals.decide", body: approvalDecisionBody, idempotent: true, rateLimit: 30 },
  ({ ctx, params, body }) => decideApproval(ctx, parseId(params.id), "reject", body),
);
