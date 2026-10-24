import { updateConnectionBody } from "@dfos/contracts";
import { getConnection, setConnectionEnabled } from "@dfos/orchestrator";
import { parseId, route } from "@/server/api";

type P = { id: string };

export const GET = route<undefined, undefined, P>({ permission: "integrations.read" }, ({ ctx, params }) => getConnection(ctx, parseId(params.id)));

/** Kill switch for one connection. */
export const PATCH = route<typeof updateConnectionBody, undefined, P>(
  { permission: "integrations.manage", body: updateConnectionBody, idempotent: true },
  ({ ctx, params, body }) => setConnectionEnabled(ctx, parseId(params.id), body.enabled),
);
