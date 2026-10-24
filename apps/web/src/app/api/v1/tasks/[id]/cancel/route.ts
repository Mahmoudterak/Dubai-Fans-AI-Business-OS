import { z } from "zod";
import { cancelTask } from "@dfos/orchestrator";
import { parseId, route } from "@/server/api";

const body = z.object({ reason: z.string().trim().max(500).optional() });

export const POST = route<typeof body, undefined, { id: string }>(
  { permission: "tasks.cancel", body, idempotent: true },
  ({ ctx, params, body }) => cancelTask(ctx, parseId(params.id), body.reason),
);
