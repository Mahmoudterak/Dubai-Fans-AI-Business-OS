import { z } from "zod";
import { ROLES } from "@dfos/domain";
import { setMemberRole } from "@dfos/orchestrator";
import { parseId, route } from "@/server/api";

const body = z.object({ role: z.enum(ROLES) });

export const PATCH = route<typeof body, undefined, { id: string }>(
  { permission: "members.manage", body, idempotent: true },
  ({ ctx, params, body }) => setMemberRole(ctx, parseId(params.id), body.role),
);
