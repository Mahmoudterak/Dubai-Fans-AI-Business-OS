import { listAgents } from "@dfos/orchestrator";
import { route } from "@/server/api";

export const GET = route({ permission: "agents.read" }, ({ ctx }) => listAgents(ctx));
