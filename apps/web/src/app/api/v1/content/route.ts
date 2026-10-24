import { createContentBody, listContentQuery } from "@dfos/contracts";
import { createContent, listContent } from "@dfos/orchestrator";
import { respond, route } from "@/server/api";

export const GET = route({ permission: "content.read", query: listContentQuery }, ({ ctx, query }) => listContent(ctx, query));

export const POST = route(
  { permission: "content.write", body: createContentBody, idempotent: true },
  async ({ ctx, body }) => respond(201, await createContent(ctx, body)),
);
