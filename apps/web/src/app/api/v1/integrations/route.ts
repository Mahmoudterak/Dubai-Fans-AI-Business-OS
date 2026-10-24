import { integrationsConfigStatus, listConnections } from "@dfos/orchestrator";
import { route } from "@/server/api";

/** Real status: configuration readiness plus actual connection records. Secrets are never included. */
export const GET = route({ permission: "integrations.read" }, async ({ ctx }) => ({
  config: integrationsConfigStatus(),
  connections: await listConnections(ctx),
}));
