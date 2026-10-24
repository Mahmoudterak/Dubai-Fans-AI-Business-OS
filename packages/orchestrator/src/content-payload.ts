import { and, eq } from "drizzle-orm";
import { contentItems, contentVersions, type Database } from "@dfos/db";
import { AppError } from "@dfos/domain";

export const CONTENT_PUBLISH_ACTION = "content.publish";

/**
 * The exact thing a reviewer approves when approving a publication.
 * Text, hashtags, CTA (via contentHash), target platform/format and schedule are all included,
 * so changing any of them changes the fingerprint and voids the approval.
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
      platform: item.platform,
      format: item.format,
      audience: item.audience ?? null,
      scheduledAt: item.scheduledAt ? item.scheduledAt.toISOString() : null,
    } as Record<string, unknown>,
  };
}
