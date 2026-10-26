import { getConnection } from "@dfos/orchestrator";
import { parseId, route } from "@/server/api";

export const GET = route<undefined, undefined, { id: string }>({ permission: "integrations.read" }, async ({ ctx, params }) => {
  const c = await getConnection(ctx, parseId(params.id));
  return {
    id: c.id,
    provider: c.provider,
    status: c.status,
    enabled: c.enabled,
    canPublish: c.canPublish,
    grantedScopes: c.grantedScopes,
    tokenExpiresAt: c.tokenExpiresAt,
    lastSyncAt: c.lastSyncAt,
    lastError: c.lastError,
  };
});
