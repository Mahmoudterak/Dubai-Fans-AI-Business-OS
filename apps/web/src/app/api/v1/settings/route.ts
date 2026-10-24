import { updateOrgSettingsBody } from "@dfos/contracts";
import { getOrganization, updateOrgSettings } from "@dfos/orchestrator";
import { route } from "@/server/api";

export const GET = route({ permission: "org.read" }, ({ ctx }) => getOrganization(ctx));

/** Includes the org-wide kill switch (agentsPaused) and the monthly AI budget. */
export const PATCH = route({ permission: "org.manage", body: updateOrgSettingsBody, idempotent: true }, ({ ctx, body }) =>
  updateOrgSettings(ctx, body),
);
