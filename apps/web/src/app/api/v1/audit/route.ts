import { z } from "zod";
import { paginationQuery } from "@dfos/contracts";
import { listAuditLogs } from "@dfos/orchestrator";
import { route } from "@/server/api";

const query = paginationQuery.extend({ action: z.string().max(80).optional() });

export const GET = route({ permission: "audit.read", query }, ({ ctx, query: q }) => listAuditLogs(ctx, q));
