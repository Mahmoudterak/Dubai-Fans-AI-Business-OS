import { getApproval } from "@dfos/orchestrator";
import { parseId, route } from "@/server/api";

export const GET = route<undefined, undefined, { id: string }>({ permission: "approvals.read" }, ({ ctx, params }) =>
  getApproval(ctx, parseId(params.id)),
);
