import { listMembers } from "@dfos/orchestrator";
import { route } from "@/server/api";

export const GET = route({ permission: "org.read" }, ({ ctx }) => listMembers(ctx));
