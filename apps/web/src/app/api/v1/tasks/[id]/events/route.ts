import { listTaskEvents } from "@dfos/orchestrator";
import { parseId, route } from "@/server/api";

export const GET = route<undefined, undefined, { id: string }>({ permission: "tasks.read" }, ({ ctx, params }) =>
  listTaskEvents(ctx, parseId(params.id)),
);
