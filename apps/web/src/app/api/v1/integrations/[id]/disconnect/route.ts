import { z } from "zod";
import { disconnectConnection } from "@dfos/orchestrator";
import { parseId, route } from "@/server/api";

const body = z.object({}).strict();

/** Deletes the stored token and marks the connection disconnected. */
export const POST = route<typeof body, undefined, { id: string }>(
  { permission: "integrations.manage", body, idempotent: true },
  ({ ctx, params }) => disconnectConnection(ctx, parseId(params.id)),
);
