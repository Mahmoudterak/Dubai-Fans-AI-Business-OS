import { z } from "zod";
import { syncConnection } from "@dfos/orchestrator";
import { parseId, route } from "@/server/api";

const body = z.object({}).strict();

/** Re-reads the account profile and the 24h publishing quota from Instagram. */
export const POST = route<typeof body, undefined, { id: string }>(
  { permission: "integrations.manage", body, idempotent: true, rateLimit: 10 },
  ({ ctx, params }) => syncConnection(ctx, parseId(params.id)),
);
