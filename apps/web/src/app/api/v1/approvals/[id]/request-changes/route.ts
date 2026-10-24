import { requestChangesBody } from "@dfos/contracts";
import { decideApproval } from "@dfos/orchestrator";
import { parseId, route } from "@/server/api";

export const POST = route<typeof requestChangesBody, undefined, { id: string }>(
  { permission: "approvals.decide", body: requestChangesBody, idempotent: true, rateLimit: 30 },
  ({ ctx, params, body }) => decideApproval(ctx, parseId(params.id), "request_changes", body),
);
