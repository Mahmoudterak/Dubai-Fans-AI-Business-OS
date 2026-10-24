import { z } from "zod";
import { selectContentVersion } from "@dfos/orchestrator";
import { parseId, route } from "@/server/api";

const body = z.object({}).strict();

export const POST = route<typeof body, undefined, { id: string; versionId: string }>(
  { permission: "content.write", body, idempotent: true },
  ({ ctx, params }) => selectContentVersion(ctx, parseId(params.id), parseId(params.versionId)),
);
