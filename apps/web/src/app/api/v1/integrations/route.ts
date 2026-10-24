import { getDashboard } from "@dfos/orchestrator";
import { route } from "@/server/api";

/** Real status only. Nothing is reported as connected until a connection exists (phase 6). */
export const GET = route({ permission: "integrations.read" }, async ({ ctx }) => (await getDashboard(ctx)).integrations);
