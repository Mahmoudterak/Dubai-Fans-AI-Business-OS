import { z } from "zod";
import { retryTask } from "@dfos/orchestrator";
import { parseId, route } from "@/server/api";

const body = z.object({}).strict();

export const POST = route<typeof body, undefined, { id: string }>(
  { permission: "tasks.create", body, idempotent: true },
  ({ ctx, params }) => retryTask(ctx, parseId(params.id)),
);
