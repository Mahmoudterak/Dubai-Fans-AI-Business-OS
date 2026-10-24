import { paginationQuery } from "@dfos/contracts";
import { listAgentRuns } from "@dfos/orchestrator";
import { route } from "@/server/api";

export const GET = route<undefined, typeof paginationQuery, { key: string }>(
  { permission: "agents.read", query: paginationQuery },
  ({ ctx, params, query }) => listAgentRuns(ctx, params.key, query),
);
