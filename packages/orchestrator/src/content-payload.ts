import { and, eq } from "drizzle-orm";
import { contentItems, contentVersions, mediaAssets, type Database } from "@dfos/db";
import { AppError } from "@dfos/domain";

export const CONTENT_PUBLISH_ACTION = "content.publish";

/**
 * The exact thing a reviewer approves when approving a publication.
 * Text, hashtags, CTA, image (by content hash), target platform/format, audience and
 * schedule are all included, so changing any of them changes the fingerprint and voids
 * the approval.
 */
export async function loadContentPublishPayload(db: Database, organizationId: string, contentItemId: string) {
  const [item] = await db
    .select()
    .from(contentItems)
    .where(and(eq(contentItems.id, contentItemId), eq(contentItems.organizationId, organizationId)));
  if (!item) throw new AppError("not_found", "Content item not found");
  if (!item.currentVersionId) throw new AppError("conflict", "Content item has no version");
  const [version] = await db
    .select()
    .from(contentVersions)
    .where(and(eq(contentVersions.id, item.currentVersionId), eq(contentVersions.organizationId, organizationId)));
  if (!version) throw new AppError("conflict", "Current content version is missing");
  let media: { id: string; sha256: string; width: number | null; height: number | null } | null = null;
  if (version.mediaAssetId) {
    const [m] = await db
      .select({ id: mediaAssets.id, sha256: mediaAssets.sha256, width: mediaAssets.width, height: mediaAssets.height })
      .from(mediaAssets)
      .where(and(eq(mediaAssets.id, version.mediaAssetId), eq(mediaAssets.organizationId, organizationId)));
    media = m ?? null;
  }
  return {
    item,
    version,
    payload: {
      contentItemId: item.id,
      versionId: version.id,
      versionNumber: version.versionNumber,
      contentHash: version.contentHash,
      body: version.body,
      hashtags: version.hashtags,
      cta: version.cta ?? null,
      media: media ? { id: media.id, sha256: media.sha256, width: media.width, height: media.height } : null,
      platform: item.platform,
      format: item.format,
      audience: item.audience ?? null,
      scheduledAt: item.scheduledAt ? item.scheduledAt.toISOString() : null,
    } as Record<string, unknown>,
  };
}
