import { z } from "zod";
import { submitContentForApproval } from "@dfos/orchestrator";
import { parseId, respond, route } from "@/server/api";

const body = z.object({}).strict();

export const POST = route<typeof body, undefined, { id: string }>(
  { permission: "content.write", body, idempotent: true },
  async ({ ctx, params }) => respond(201, await submitContentForApproval(ctx, parseId(params.id))),
);
