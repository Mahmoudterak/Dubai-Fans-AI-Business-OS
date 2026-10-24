import { getContent } from "@dfos/orchestrator";
import { parseId, route } from "@/server/api";

export const GET = route<undefined, undefined, { id: string }>({ permission: "content.read" }, ({ ctx, params }) => getContent(ctx, parseId(params.id)));
