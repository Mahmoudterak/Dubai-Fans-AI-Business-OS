import { listApprovalsQuery } from "@dfos/contracts";
import { listApprovals } from "@dfos/orchestrator";
import { route } from "@/server/api";

export const GET = route({ permission: "approvals.read", query: listApprovalsQuery }, ({ ctx, query }) => listApprovals(ctx, query));
