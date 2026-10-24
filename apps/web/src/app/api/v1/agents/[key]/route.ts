import { updateAgentBody } from "@dfos/contracts";
import { getAgent, updateAgent } from "@dfos/orchestrator";
import { route } from "@/server/api";

type P = { key: string };

export const GET = route<undefined, undefined, P>({ permission: "agents.read" }, ({ ctx, params }) => getAgent(ctx, params.key));

export const PATCH = route<typeof updateAgentBody, undefined, P>(
  { permission: "agents.manage", body: updateAgentBody, idempotent: true },
  ({ ctx, params, body }) => updateAgent(ctx, params.key, body),
);
