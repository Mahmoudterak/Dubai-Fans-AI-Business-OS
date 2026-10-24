import { scheduleContentBody } from "@dfos/contracts";
import { scheduleContent } from "@dfos/orchestrator";
import { parseId, route } from "@/server/api";

export const POST = route<typeof scheduleContentBody, undefined, { id: string }>(
  { permission: "content.write", body: scheduleContentBody, idempotent: true },
  ({ ctx, params, body }) => scheduleContent(ctx, parseId(params.id), new Date(body.scheduledAt)),
);
