import { and, eq } from "drizzle-orm";
import { attachMediaBody } from "@dfos/contracts";
import { contentItems, contentVersions } from "@dfos/db";
import { AppError } from "@dfos/domain";
import { addContentVersion } from "@dfos/orchestrator";
import { parseId, respond, route } from "@/server/api";

/** Attaches (or removes) an image by saving a new version. Voids open approvals like any edit. */
export const POST = route<typeof attachMediaBody, undefined, { id: string }>(
  { permission: "content.write", body: attachMediaBody, idempotent: true },
  async ({ ctx, params, body }) => {
    const id = parseId(params.id);
    const [item] = await ctx.db.select().from(contentItems).where(and(eq(contentItems.id, id), eq(contentItems.organizationId, ctx.organizationId)));
    if (!item?.currentVersionId) throw new AppError("not_found", "Content item not found");
    const [cur] = await ctx.db.select().from(contentVersions).where(eq(contentVersions.id, item.currentVersionId));
    if (!cur) throw new AppError("not_found", "Version not found");
    const r = await addContentVersion(ctx, id, { body: cur.body, hashtags: cur.hashtags, cta: cur.cta ?? undefined, mediaAssetId: body.mediaAssetId });
    return respond(201, r);
  },
);
