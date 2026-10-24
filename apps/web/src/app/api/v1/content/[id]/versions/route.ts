import { contentVersionBody } from "@dfos/contracts";
import { addContentVersion } from "@dfos/orchestrator";
import { parseId, respond, route } from "@/server/api";

export const POST = route<typeof contentVersionBody, undefined, { id: string }>(
  { permission: "content.write", body: contentVersionBody, idempotent: true },
  async ({ ctx, params, body }) => respond(201, await addContentVersion(ctx, parseId(params.id), body)),
);
