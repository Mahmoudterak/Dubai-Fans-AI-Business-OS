import { and, eq, inArray, sql } from "drizzle-orm";
import { getEnv } from "@dfos/config";
import {
  contentItems,
  contentPublications,
  contentVersions,
  integrationConnections,
  mediaAssets,
  type Database,
} from "@dfos/db";
import { AppError, isAppError } from "@dfos/domain";
import {
  EncryptedDbSecretStore,
  getStorageProvider,
  instagramAspectOk,
  MetaApiError,
  MetaInstagramClient,
  type StorageProvider,
} from "@dfos/integrations";
import { logger } from "@dfos/observability";
import { writeAudit } from "./audit";
import { rowsOf, type Actor } from "./context";
import { findPublishingConnection, getAccessToken, markAuthFailure, PUBLISH_SCOPE, type ConnectionRow, type MetaDeps } from "./integrations";

export interface PublishDeps extends MetaDeps {
  storage?: StorageProvider;
}

const CAPTION_MAX = 2200;
const HASHTAG_MAX = 30;
const MAX_CONTAINER_ATTEMPTS = 3;
const MAX_PUBLISH_ATTEMPTS = 3;
const MAX_STATUS_CHECKS = 12;
const ACTOR: Actor = { type: "system", name: "publisher" };

type Item = typeof contentItems.$inferSelect;
type Version = typeof contentVersions.$inferSelect;
export type PublicationRow = typeof contentPublications.$inferSelect;

export function composeCaption(v: { body: string; hashtags: string[]; cta: string | null }) {
  const parts = [v.body.trim()];
  if (v.cta) parts.push(v.cta.trim());
  if (v.hashtags.length) parts.push(v.hashtags.join(" "));
  return parts.join("\n\n");
}

/**
 * Everything that can be checked before the approval is consumed. Any failure here
 * leaves the approval unused, so the user can fix the problem and publish again.
 */
export async function precheckInstagram(db: Database, organizationId: string, item: Item, version: Version, d: PublishDeps = {}) {
  if (item.platform !== "instagram") {
    throw new AppError("integration_not_connected", `Publishing to ${item.platform} is not supported yet`);
  }
  if (item.format !== "post") {
    throw new AppError("validation_failed", "Only single-image Instagram posts are supported for now");
  }
  const connection = await findPublishingConnection(db, organizationId);
  if (!connection) throw new AppError("integration_not_connected", "No Instagram account is connected. Connect it in Integrations first.");
  if (!connection.enabled) throw new AppError("integration_not_connected", "The Instagram connection is paused");
  if (connection.status !== "active" || (connection.tokenExpiresAt && connection.tokenExpiresAt <= new Date())) {
    throw new AppError("integration_reauth_required", "Instagram authorization expired. Reconnect the account.");
  }
  if (!connection.grantedScopes.includes(PUBLISH_SCOPE)) {
    throw new AppError("integration_missing_permission", `The account did not grant ${PUBLISH_SCOPE}`);
  }

  const caption = composeCaption(version);
  if (caption.length > CAPTION_MAX) throw new AppError("validation_failed", `Caption is longer than ${CAPTION_MAX} characters`);
  if (version.hashtags.length > HASHTAG_MAX) throw new AppError("validation_failed", `More than ${HASHTAG_MAX} hashtags`);

  if (!version.mediaAssetId) throw new AppError("validation_failed", "Instagram posts need a JPEG image. Attach one to this version.");
  const [media] = await db
    .select()
    .from(mediaAssets)
    .where(and(eq(mediaAssets.id, version.mediaAssetId), eq(mediaAssets.organizationId, organizationId)));
  if (!media) throw new AppError("validation_failed", "Attached image not found");
  if (media.contentType !== "image/jpeg") throw new AppError("validation_failed", "Instagram accepts JPEG images only");
  if (media.width && media.height && !instagramAspectOk(media.width, media.height)) {
    throw new AppError("validation_failed", "Image aspect ratio must be between 4:5 and 1.91:1 for Instagram");
  }
  const storage = d.storage ?? getStorageProvider();
  if (!storage.publiclyReachable) {
    throw new AppError("storage_not_configured", "Images must be stored where Meta can download them (not localhost)");
  }
  const head = await storage.head(media.storageKey);
  if (!head || head.size !== media.sizeBytes) throw new AppError("validation_failed", "The stored image is missing or changed");
  return { connection, media, caption };
}

export async function createPublication(
  db: Database,
  input: { organizationId: string; item: Item; version: Version; approvalRequestId: string; connection: ConnectionRow },
) {
  const [row] = await db
    .insert(contentPublications)
    .values({
      organizationId: input.organizationId,
      contentItemId: input.item.id,
      versionId: input.version.id,
      approvalRequestId: input.approvalRequestId,
      connectionId: input.connection.id,
      platform: input.item.platform,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) throw new AppError("conflict", "A publication already exists for this approval");
  return row;
}

// ───────────────────────── Worker state machine ─────────────────────────

/**
 * queued ──create container──► container_processing ──FINISHED──► ready_to_publish
 *   ──(write publish_requested first)── media_publish ──► confirm via GET media ──► published
 *
 * Duplicate protection: media_publish is the only call that creates a post. Before it is
 * ever retried, the container is re-checked: PUBLISHED means it already went out (we look
 * the post up instead of publishing again); only FINISHED (= not published) allows a retry.
 * If we cannot tell, the publication stops in `needs_review` for a human.
 */
export async function processPublications(db: Database, d: PublishDeps = {}, batch = 10) {
  const res = await db.execute(sql`
    UPDATE content_publications SET locked_until = now() + interval '2 minutes'
    WHERE id IN (
      SELECT id FROM content_publications
      WHERE status IN ('queued', 'container_processing', 'ready_to_publish', 'publish_requested')
        AND next_check_at <= now()
        AND (locked_until IS NULL OR locked_until < now())
      ORDER BY next_check_at
      FOR UPDATE SKIP LOCKED
      LIMIT ${batch}
    )
    RETURNING id
  `);
  const ids = rowsOf<{ id: string }>(res).map((r) => r.id);
  const results: Array<{ id: string; status: string }> = [];
  for (const id of ids) {
    try {
      results.push({ id, status: await step(db, id, d) });
    } catch (e) {
      logger.error("publication step crashed", { publicationId: id, err: e instanceof Error ? e.message : String(e) });
      await db.update(contentPublications).set({ nextCheckAt: new Date(Date.now() + 60_000) }).where(eq(contentPublications.id, id));
      results.push({ id, status: "error" });
    } finally {
      await db.update(contentPublications).set({ lockedUntil: null }).where(eq(contentPublications.id, id));
    }
  }
  return results;
}

const later = (ms: number) => new Date(Date.now() + ms);

async function step(db: Database, id: string, d: PublishDeps): Promise<string> {
  const client = d.client ?? new MetaInstagramClient();
  const secrets = d.secrets ?? new EncryptedDbSecretStore(db);
  let [pub] = await db.select().from(contentPublications).where(eq(contentPublications.id, id));
  if (!pub) return "missing";
  const [conn] = await db.select().from(integrationConnections).where(eq(integrationConnections.id, pub.connectionId));
  if (!conn || conn.organizationId !== pub.organizationId) return fail(db, pub, "connection_missing", "The Instagram connection no longer exists");

  if (!conn.enabled && pub.status !== "publish_requested") {
    // Kill switch: hold before anything is created; resume when re-enabled.
    await db.update(contentPublications).set({ nextCheckAt: later(5 * 60_000), lastError: { code: "connection_paused", message: "Instagram connection is paused" } }).where(eq(contentPublications.id, id));
    return "paused";
  }

  let token: string;
  try {
    token = await getAccessToken(db, { ...conn, enabled: true }, secrets);
  } catch (e) {
    if (isAppError(e)) return fail(db, pub, e.code, e.message);
    throw e;
  }

  const set = async (patch: Partial<typeof contentPublications.$inferInsert>) => {
    [pub] = await db.update(contentPublications).set(patch).where(eq(contentPublications.id, id)).returning();
  };

  const onMetaError = async (e: unknown, backoffMs: number, attempts: number, max: number) => {
    if (!(e instanceof MetaApiError)) throw e;
    if (e.isAuthError) {
      await markAuthFailure(db, conn, e);
      return fail(db, pub!, "reauth_required", "Instagram authorization is no longer valid");
    }
    if (e.retryable && attempts < max) {
      await set({ nextCheckAt: later(backoffMs), lastError: { code: `meta_${e.code ?? e.httpStatus}`, message: e.message } });
      return "retry_scheduled";
    }
    return fail(db, pub!, `meta_${e.code ?? e.httpStatus}`, e.message);
  };

  // 1. Create the media container (safe to repeat: an unused container expires after 24h).
  if (pub.status === "queued") {
    if (pub.containerAttempts >= MAX_CONTAINER_ATTEMPTS) return fail(db, pub, "container_failed", "Could not create the Instagram container");
    const [version] = await db.select().from(contentVersions).where(eq(contentVersions.id, pub.versionId));
    const [media] = version?.mediaAssetId ? await db.select().from(mediaAssets).where(eq(mediaAssets.id, version.mediaAssetId)) : [];
    if (!version || !media) return fail(db, pub, "media_missing", "The approved image is missing");
    const storage = d.storage ?? getStorageProvider();
    const imageUrl = await storage.signedGetUrl(media.storageKey, getEnv().OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS);
    await set({ containerAttempts: pub.containerAttempts + 1 });
    try {
      const { containerId } = await client.createImageContainer(token, conn.externalAccountId, imageUrl, composeCaption(version));
      await set({ containerId, status: "container_processing", nextCheckAt: later(15_000), lastError: null });
      return "container_created";
    } catch (e) {
      return onMetaError(e, 30_000 * pub.containerAttempts, pub.containerAttempts, MAX_CONTAINER_ATTEMPTS);
    }
  }

  // 2. Wait for Meta to finish processing the media.
  if (pub.status === "container_processing") {
    try {
      const s = await client.getContainerStatus(token, pub.containerId!);
      if (s.statusCode === "FINISHED") {
        await set({ status: "ready_to_publish", nextCheckAt: new Date(), statusChecks: pub.statusChecks + 1 });
      } else if (s.statusCode === "IN_PROGRESS") {
        if (pub.statusChecks + 1 >= MAX_STATUS_CHECKS) return fail(db, pub, "container_timeout", "Instagram took too long to process the image");
        await set({ statusChecks: pub.statusChecks + 1, nextCheckAt: later(30_000) });
        return "processing";
      } else if (s.statusCode === "PUBLISHED") {
        await set({ status: "publish_requested", nextCheckAt: new Date() });
      } else {
        return fail(db, pub, `container_${s.statusCode.toLowerCase() || "unknown"}`, s.status ?? `Container status ${s.statusCode}`);
      }
    } catch (e) {
      return onMetaError(e, 60_000, pub.statusChecks + 1, MAX_STATUS_CHECKS);
    }
  }

  // 3. Publish. The status is written BEFORE the call, so a crash afterwards is detected.
  if (pub.status === "ready_to_publish") {
    if (pub.publishAttempts >= MAX_PUBLISH_ATTEMPTS) return fail(db, pub, "publish_failed", "Instagram did not accept the post");
    try {
      const limit = await client.getPublishingLimit(token, conn.externalAccountId);
      if (limit.used >= limit.total) {
        await set({ nextCheckAt: later(60 * 60_000), lastError: { code: "quota_reached", message: `Publishing limit reached (${limit.used}/${limit.total} in 24h)` } });
        return "quota_wait";
      }
    } catch (e) {
      return onMetaError(e, 60_000, pub.statusChecks, MAX_STATUS_CHECKS);
    }
    await set({ status: "publish_requested", publishAttempts: pub.publishAttempts + 1 });
    try {
      const { mediaId } = await client.publishContainer(token, conn.externalAccountId, pub.containerId!);
      await set({ externalMediaId: mediaId, lastError: null });
    } catch (e) {
      if (!(e instanceof MetaApiError)) throw e;
      if (e.isAuthError) {
        await markAuthFailure(db, conn, e);
        return fail(db, pub, "reauth_required", "Instagram authorization is no longer valid");
      }
      if (!e.retryable && !e.isAmbiguous) {
        // Meta answered with a definite rejection: nothing was posted.
        return fail(db, pub, `meta_${e.code ?? e.httpStatus}`, e.message);
      }
      // Unknown outcome: never call media_publish again blindly. Resolve on the next round.
      await set({ nextCheckAt: later(60_000), lastError: { code: "publish_outcome_unknown", message: e.message } });
      return "outcome_unknown";
    }
  }

  // 4. Confirm (or resolve an unknown outcome) before marking anything as published.
  if (pub.status === "publish_requested") {
    try {
      if (pub.externalMediaId) return await confirm(db, pub, token, client, pub.externalMediaId);
      const s = await client.getContainerStatus(token, pub.containerId!);
      if (s.statusCode === "PUBLISHED") {
        const [version] = await db.select().from(contentVersions).where(eq(contentVersions.id, pub.versionId));
        const caption = version ? composeCaption(version) : "";
        const recent = await client.listRecentMedia(token, conn.externalAccountId, 10);
        const since = pub.createdAt.getTime() - 5 * 60_000;
        const match = recent.find((m) => m.caption === caption && (!m.timestamp || new Date(m.timestamp).getTime() >= since));
        if (match) return await confirm(db, pub, token, client, match.id);
        return needsReview(db, pub, "Instagram reports the post as published but it could not be matched. Check the account.");
      }
      if (s.statusCode === "FINISHED") {
        // Not published: retrying media_publish cannot create a duplicate.
        await set({ status: "ready_to_publish", nextCheckAt: later(30_000) });
        return "will_retry_publish";
      }
      if (s.statusCode === "IN_PROGRESS") {
        await set({ nextCheckAt: later(30_000), statusChecks: pub.statusChecks + 1 });
        return "processing";
      }
      return fail(db, pub, `container_${s.statusCode.toLowerCase() || "unknown"}`, s.status ?? "Container failed");
    } catch (e) {
      if (e instanceof MetaApiError && e.isAuthError) {
        await markAuthFailure(db, conn, e);
        return needsReview(db, pub, "Authorization was lost while confirming the post. Reconnect and check the account.");
      }
      if (e instanceof MetaApiError && pub.statusChecks + 1 < MAX_STATUS_CHECKS) {
        await set({ statusChecks: pub.statusChecks + 1, nextCheckAt: later(60_000), lastError: { code: "confirm_pending", message: e.message } });
        return "confirm_retry";
      }
      if (e instanceof MetaApiError) return needsReview(db, pub, "Could not confirm the post with Instagram");
      throw e;
    }
  }
  return pub.status;
}

async function confirm(db: Database, pub: PublicationRow, token: string, client: MetaInstagramClient, mediaId: string) {
  const media = await client.getMedia(token, mediaId);
  if (media.id !== mediaId) return needsReview(db, pub, "Instagram returned a different media id");
  const publishedAt = media.timestamp ? new Date(media.timestamp) : new Date();
  await db
    .update(contentPublications)
    .set({ status: "published", externalMediaId: mediaId, permalink: media.permalink, publishedAt, lastError: null })
    .where(eq(contentPublications.id, pub.id));
  await db
    .update(contentItems)
    .set({ status: "published", publishedAt, externalPostId: mediaId, lastError: null })
    .where(eq(contentItems.id, pub.contentItemId));
  await writeAudit(db, pub.organizationId, ACTOR, {
    action: "content.published",
    targetType: "content",
    targetId: pub.contentItemId,
    data: { platform: pub.platform, externalId: mediaId, permalink: media.permalink, publicationId: pub.id },
  });
  return "published";
}

async function fail(db: Database, pub: PublicationRow, code: string, message: string) {
  await db.update(contentPublications).set({ status: "failed", lastError: { code, message } }).where(eq(contentPublications.id, pub.id));
  await db.update(contentItems).set({ status: "failed", lastError: { code, message } }).where(eq(contentItems.id, pub.contentItemId));
  await writeAudit(db, pub.organizationId, ACTOR, { action: "content.publish_failed", targetType: "content", targetId: pub.contentItemId, data: { code, message, publicationId: pub.id } });
  return "failed";
}

async function needsReview(db: Database, pub: PublicationRow, message: string) {
  await db.update(contentPublications).set({ status: "needs_review", lastError: { code: "needs_review", message } }).where(eq(contentPublications.id, pub.id));
  await db.update(contentItems).set({ status: "failed", lastError: { code: "needs_review", message } }).where(eq(contentItems.id, pub.contentItemId));
  await writeAudit(db, pub.organizationId, ACTOR, { action: "content.publish_needs_review", targetType: "content", targetId: pub.contentItemId, data: { message, publicationId: pub.id } });
  return "needs_review";
}

export async function listPublications(db: Database, organizationId: string, contentItemId: string) {
  return db
    .select()
    .from(contentPublications)
    .where(and(eq(contentPublications.organizationId, organizationId), eq(contentPublications.contentItemId, contentItemId)));
}

export const ACTIVE_PUBLICATION_STATUSES = ["queued", "container_processing", "ready_to_publish", "publish_requested"] as const;
export async function hasActivePublication(db: Database, contentItemId: string) {
  const rows = await db
    .select({ id: contentPublications.id })
    .from(contentPublications)
    .where(and(eq(contentPublications.contentItemId, contentItemId), inArray(contentPublications.status, [...ACTIVE_PUBLICATION_STATUSES])));
  return rows.length > 0;
}
