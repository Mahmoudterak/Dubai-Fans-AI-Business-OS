import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { getEnv } from "@dfos/config";
import { mediaAssets } from "@dfos/db";
import { AppError } from "@dfos/domain";
import { getStorageProvider, inspectImage, mediaStorageKey, safeDisplayName, type StorageProvider } from "@dfos/integrations";
import { audit } from "./audit";
import { requirePermission, type Ctx } from "./context";

/**
 * Stores an image. The DB row is written only after the storage provider confirms the
 * object exists with the expected size; otherwise the upload is reported as failed.
 */
export async function uploadMedia(ctx: Ctx, file: { bytes: Uint8Array; name?: string }, storage?: StorageProvider) {
  requirePermission(ctx, "content.write");
  const store = storage ?? getStorageProvider();
  const info = inspectImage(file.bytes, getEnv().MEDIA_MAX_UPLOAD_BYTES);
  const id = randomUUID();
  const key = mediaStorageKey(ctx.organizationId, id, info.extension);
  await store.put(key, file.bytes, info.contentType);
  const head = await store.head(key);
  if (!head || head.size !== file.bytes.byteLength) {
    throw new AppError("integration_error", "Storage did not confirm the upload");
  }
  const [row] = await ctx.db
    .insert(mediaAssets)
    .values({
      id,
      organizationId: ctx.organizationId,
      storageProvider: store.name,
      storageKey: key,
      contentType: info.contentType,
      sizeBytes: file.bytes.byteLength,
      sha256: info.sha256,
      width: info.width,
      height: info.height,
      originalName: safeDisplayName(file.name),
      createdByUserId: ctx.actor.type === "user" ? ctx.actor.userId : undefined,
    })
    .returning();
  await audit(ctx, { action: "media.uploaded", targetType: "media", targetId: id, data: { sizeBytes: file.bytes.byteLength, width: info.width, height: info.height } });
  return row!;
}

export async function getMediaAsset(ctx: Ctx, id: string) {
  requirePermission(ctx, "content.read");
  const [row] = await ctx.db.select().from(mediaAssets).where(and(eq(mediaAssets.id, id), eq(mediaAssets.organizationId, ctx.organizationId)));
  if (!row) throw new AppError("not_found", "Media not found");
  return row;
}

/** Short-lived private link for previews in the UI. */
export async function getMediaPreviewUrl(ctx: Ctx, id: string, storage?: StorageProvider) {
  const row = await getMediaAsset(ctx, id);
  return { url: await (storage ?? getStorageProvider()).signedGetUrl(row.storageKey, 300), expiresInSeconds: 300 };
}

export async function listMedia(ctx: Ctx, limit = 50) {
  requirePermission(ctx, "content.read");
  return ctx.db.select().from(mediaAssets).where(eq(mediaAssets.organizationId, ctx.organizationId)).orderBy(desc(mediaAssets.createdAt)).limit(limit);
}
