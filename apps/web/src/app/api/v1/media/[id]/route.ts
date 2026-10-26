import { getMediaAsset, getMediaPreviewUrl } from "@dfos/orchestrator";
import { parseId, route } from "@/server/api";

/** Metadata plus a 5-minute private preview link. */
export const GET = route<undefined, undefined, { id: string }>({ permission: "content.read" }, async ({ ctx, params }) => {
  const id = parseId(params.id);
  const asset = await getMediaAsset(ctx, id);
  const preview = await getMediaPreviewUrl(ctx, id);
  return { ...asset, preview };
});
