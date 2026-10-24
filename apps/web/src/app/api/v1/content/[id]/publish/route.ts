import { z } from "zod";
import { publishContent } from "@dfos/orchestrator";
import { parseId, route } from "@/server/api";

const body = z.object({}).strict();

/** Requires an approved, unchanged version and a connected account. Never publishes twice. */
export const POST = route<typeof body, undefined, { id: string }>(
  { permission: "content.publish", body, idempotent: true, rateLimit: 10 },
  ({ ctx, params }) => publishContent(ctx, parseId(params.id)),
);
