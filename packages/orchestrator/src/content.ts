import { and, desc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import { agentPolicies, approvalRequests, contentItems, contentVersions, type Database } from "@dfos/db";
import { AppError, canonicalJson, sha256, type ContentPlatform, type ContentStatus } from "@dfos/domain";
import type { z } from "zod";
import type { contentVersionBody, createContentBody } from "@dfos/contracts";
import { consumeApproval, createApprovalRequest, invalidateOpenApprovals } from "./approvals";
import { audit } from "./audit";
import { requirePermission, type Actor, type Ctx } from "./context";
import { CONTENT_PUBLISH_ACTION, loadContentPublishPayload } from "./content-payload";
import { getPublisher } from "./publishers";

type VersionInput = z.infer<typeof contentVersionBody>;
type CreateInput = z.infer<typeof createContentBody>;

const PLATFORM_NAMES: Record<ContentPlatform, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  tiktok: "TikTok",
  whatsapp: "WhatsApp",
  website: "الموقع",
};

const normalizeTags =(tags: string[]) => tags.map((t) => (t.startsWith("#") ? t : `#${t}`));

export function contentHash(v: { body: string; hashtags: string[]; cta?: string | null }) {
  return sha256(canonicalJson({ body: v.body, hashtags: v.hashtags, cta: v.cta ?? null }));
}

/** Statuses where the content is under review or cleared to go out. Editing them voids approvals. */
const LOCKED_STATUSES: ContentStatus[] = ["in_review", "approved", "scheduled"];

export async function createContent(ctx: Ctx, input: CreateInput) {
  requirePermission(ctx, "content.write");
  return ctx.db.transaction(async (tx) => {
    const [item] = await tx
      .insert(contentItems)
      .values({
        organizationId: ctx.organizationId,
        title: input.title,
        platform: input.platform,
        format: input.format,
        audience: input.audience,
        goal: input.goal,
        tone: input.tone,
        createdByUserId: ctx.actor.type === "user" ? ctx.actor.userId : undefined,
      })
      .returning();
    if (!item) throw new AppError("internal_error", "Failed to create content");
    const version = await insertVersion(tx, ctx, item.id, input, "manual");
    await tx.update(contentItems).set({ currentVersionId: version.id }).where(eq(contentItems.id, item.id));
    await audit(ctx, { action: "content.created", targetType: "content", targetId: item.id }, tx);
    return { ...item, currentVersionId: version.id };
  });
}

async function insertVersion(
  db: Database,
  ctx: { organizationId: string; actor: Actor },
  contentItemId: string,
  v: VersionInput,
  source: "manual" | "ai",
  agentRunId?: string,
) {
  const [last] = await db
    .select({ n: sql<number>`coalesce(max(${contentVersions.versionNumber}), 0)::int` })
    .from(contentVersions)
    .where(eq(contentVersions.contentItemId, contentItemId));
  const hashtags = normalizeTags(v.hashtags ?? []);
  const [row] = await db
    .insert(contentVersions)
    .values({
      organizationId: ctx.organizationId,
      contentItemId,
      versionNumber: (last?.n ?? 0) + 1,
      body: v.body,
      hashtags,
      cta: v.cta,
      source,
      agentRunId,
      createdByUserId: ctx.actor.type === "user" ? ctx.actor.userId : undefined,
      contentHash: contentHash({ body: v.body, hashtags, cta: v.cta }),
    })
    .returning();
  if (!row) throw new AppError("internal_error", "Failed to save version");
  return row;
}

async function loadItem(db: Database, organizationId: string, id: string) {
  const [item] = await db
    .select()
    .from(contentItems)
    .where(and(eq(contentItems.id, id), eq(contentItems.organizationId, organizationId)));
  if (!item) throw new AppError("not_found", "Content item not found");
  return item;
}

/** Any change to what would be published voids open approvals and sends the item back to draft. */
async function onContentChanged(db: Database, ctx: { organizationId: string; actor: Actor }, item: typeof contentItems.$inferSelect, reason: string) {
  const voided = await invalidateOpenApprovals(db, ctx.organizationId, { contentItemId: item.id }, ctx.actor, reason);
  if (LOCKED_STATUSES.includes(item.status) || voided > 0) {
    await db.update(contentItems).set({ status: "draft" }).where(eq(contentItems.id, item.id));
  }
  return voided;
}

export async function addContentVersion(
  ctx: Ctx | (Omit<Ctx, "actor"> & { actor: Actor }),
  contentItemId: string,
  v: VersionInput,
  opts: { source?: "manual" | "ai"; agentRunId?: string; makeCurrent?: boolean } = {},
) {
  requirePermission(ctx, "content.write");
  return ctx.db.transaction(async (tx) => {
    const item = await loadItem(tx, ctx.organizationId, contentItemId);
    if (item.status === "publishing" || item.status === "published") {
      throw new AppError("conflict", "Published content cannot be edited; create a new item instead");
    }
    const version = await insertVersion(tx, ctx, item.id, v, opts.source ?? "manual", opts.agentRunId);
    let voided = 0;
    if (opts.makeCurrent ?? true) {
      await tx.update(contentItems).set({ currentVersionId: version.id }).where(eq(contentItems.id, item.id));
      voided = await onContentChanged(tx, ctx, item, "content edited");
    }
    await audit(ctx, {
      action: "content.version_created",
      targetType: "content",
      targetId: item.id,
      data: { versionNumber: version.versionNumber, source: version.source, approvalsInvalidated: voided },
    }, tx);
    return { version, approvalsInvalidated: voided };
  });
}

export async function selectContentVersion(ctx: Ctx, contentItemId: string, versionId: string) {
  requirePermission(ctx, "content.write");
  return ctx.db.transaction(async (tx) => {
    const item = await loadItem(tx, ctx.organizationId, contentItemId);
    const [version] = await tx
      .select()
      .from(contentVersions)
      .where(and(eq(contentVersions.id, versionId), eq(contentVersions.contentItemId, item.id)));
    if (!version) throw new AppError("not_found", "Version not found");
    if (item.currentVersionId === versionId) return { approvalsInvalidated: 0 };
    await tx.update(contentItems).set({ currentVersionId: versionId }).where(eq(contentItems.id, item.id));
    const voided = await onContentChanged(tx, ctx, item, "different version selected");
    await audit(ctx, { action: "content.version_selected", targetType: "content", targetId: item.id, data: { versionNumber: version.versionNumber } }, tx);
    return { approvalsInvalidated: voided };
  });
}

export async function listContent(
  ctx: Ctx,
  q: { status?: ContentStatus; platform?: ContentPlatform; from?: string; to?: string; limit: number; offset: number },
) {
  requirePermission(ctx, "content.read");
  const conds: SQL[] = [eq(contentItems.organizationId, ctx.organizationId)];
  if (q.status) conds.push(eq(contentItems.status, q.status));
  if (q.platform) conds.push(eq(contentItems.platform, q.platform));
  if (q.from) conds.push(gte(contentItems.scheduledAt, new Date(q.from)));
  if (q.to) conds.push(lte(contentItems.scheduledAt, new Date(q.to)));
  return ctx.db
    .select({ item: contentItems, version: contentVersions })
    .from(contentItems)
    .leftJoin(contentVersions, eq(contentVersions.id, contentItems.currentVersionId))
    .where(and(...conds))
    .orderBy(desc(contentItems.updatedAt))
    .limit(q.limit)
    .offset(q.offset);
}

export async function getContent(ctx: Ctx, id: string) {
  requirePermission(ctx, "content.read");
  const item = await loadItem(ctx.db, ctx.organizationId, id);
  const [versions, approvals] = await Promise.all([
    ctx.db.select().from(contentVersions).where(and(eq(contentVersions.contentItemId, id), eq(contentVersions.organizationId, ctx.organizationId))).orderBy(desc(contentVersions.versionNumber)),
    ctx.db.select().from(approvalRequests).where(and(eq(approvalRequests.contentItemId, id), eq(approvalRequests.organizationId, ctx.organizationId))).orderBy(desc(approvalRequests.createdAt)),
  ]);
  const publisher = getPublisher(item.platform);
  const publishing = publisher
    ? { available: true, connected: await publisher.isConnected(ctx.db, ctx.organizationId) }
    : { available: false, connected: false };
  return { item, versions, approvals, publishing };
}

async function policyFor(db: Database, organizationId: string, actionType: string) {
  const [p] = await db
    .select()
    .from(agentPolicies)
    .where(and(eq(agentPolicies.organizationId, organizationId), eq(agentPolicies.actionType, actionType)));
  // No policy row = safest default.
  return p ?? { requiresApproval: true, riskLevel: "high" as const };
}

export async function submitContentForApproval(ctx: Ctx, id: string) {
  requirePermission(ctx, "content.write");
  return ctx.db.transaction(async (tx) => {
    const item = await loadItem(tx, ctx.organizationId, id);
    if (!["draft", "changes_requested", "rejected", "failed"].includes(item.status)) {
      throw new AppError("invalid_transition", `Content in status "${item.status}" cannot be submitted`);
    }
    const [open] = await tx
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(and(eq(approvalRequests.contentItemId, id), inArray(approvalRequests.status, ["pending", "approved"])));
    if (open) throw new AppError("conflict", "This content already has an open approval request");

    const { payload } = await loadContentPublishPayload(tx, ctx.organizationId, id);
    const policy = await policyFor(tx, ctx.organizationId, CONTENT_PUBLISH_ACTION);
    const approval = await createApprovalRequest(tx, ctx.actor, {
      organizationId: ctx.organizationId,
      actionType: CONTENT_PUBLISH_ACTION,
      title: `نشر على ${PLATFORM_NAMES[item.platform]}: ${item.title}`,
      summary: `الإصدار ${String(payload.versionNumber)} — ${item.format}`,
      payload,
      riskLevel: policy.riskLevel,
      contentItemId: id,
    }, ctx.requestId);
    await tx.update(contentItems).set({ status: "in_review" }).where(eq(contentItems.id, id));
    return approval;
  });
}

export async function scheduleContent(ctx: Ctx, id: string, scheduledAt: Date) {
  requirePermission(ctx, "content.write");
  if (scheduledAt.getTime() < Date.now() + 60_000) {
    throw new AppError("validation_failed", "Schedule time must be at least one minute in the future");
  }
  return ctx.db.transaction(async (tx) => {
    const item = await loadItem(tx, ctx.organizationId, id);
    if (item.status === "publishing" || item.status === "published") {
      throw new AppError("conflict", "Content is already published");
    }
    await tx.update(contentItems).set({ scheduledAt }).where(eq(contentItems.id, id));
    // The schedule is part of the approved action: changing it voids approvals.
    const voided = await onContentChanged(tx, ctx, item, "schedule changed");
    await audit(ctx, { action: "content.scheduled", targetType: "content", targetId: id, data: { scheduledAt: scheduledAt.toISOString(), approvalsInvalidated: voided } }, tx);
    return { scheduledAt, approvalsInvalidated: voided };
  });
}

/**
 * Publishes approved content. Order matters:
 * 1. integration must be connected (otherwise fail without using the approval),
 * 2. the approval is consumed atomically (prevents double publishing),
 * 3. only then the external call happens.
 */
export async function publishContent(ctx: Ctx | (Omit<Ctx, "actor"> & { actor: Actor }), id: string) {
  requirePermission(ctx, "content.publish");
  const item = await loadItem(ctx.db, ctx.organizationId, id);
  if (item.status !== "approved" && item.status !== "scheduled") {
    throw new AppError("approval_required", "Content must be approved before it can be published");
  }
  const [approval] = await ctx.db
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.contentItemId, id),
        eq(approvalRequests.organizationId, ctx.organizationId),
        eq(approvalRequests.actionType, CONTENT_PUBLISH_ACTION),
        eq(approvalRequests.status, "approved"),
      ),
    )
    .orderBy(desc(approvalRequests.decidedAt))
    .limit(1);
  if (!approval) throw new AppError("approval_required", "No valid approval found for this content");

  const publisher = getPublisher(item.platform);
  if (!publisher || !(await publisher.isConnected(ctx.db, ctx.organizationId))) {
    throw new AppError("integration_not_connected", `No connected ${item.platform} account. Connect it in Integrations first.`);
  }

  const { payload, version } = await loadContentPublishPayload(ctx.db, ctx.organizationId, id);
  await consumeApproval(ctx.db, {
    organizationId: ctx.organizationId,
    approvalId: approval.id,
    actionType: CONTENT_PUBLISH_ACTION,
    currentPayload: payload,
    executor: ctx.actor,
    requestId: ctx.requestId,
  });

  await ctx.db.update(contentItems).set({ status: "publishing" }).where(eq(contentItems.id, id));
  try {
    const result = await publisher.publish(ctx.db, ctx.organizationId, { item, version });
    await ctx.db
      .update(contentItems)
      .set({ status: "published", publishedAt: new Date(), externalPostId: result.externalId, lastError: null })
      .where(eq(contentItems.id, id));
    await audit(ctx, { action: "content.published", targetType: "content", targetId: id, data: { externalId: result.externalId, platform: item.platform } });
    return { status: "published" as const, externalId: result.externalId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.db
      .update(contentItems)
      .set({ status: "failed", lastError: { code: "publish_failed", message } })
      .where(eq(contentItems.id, id));
    await audit(ctx, { action: "content.publish_failed", targetType: "content", targetId: id, data: { message } });
    // The approval stays consumed: a new attempt needs a fresh approval.
    throw new AppError("internal_error", `Publishing failed: ${message}`);
  }
}

/** Worker: publish scheduled items whose time has come. */
export async function publishDueContent(db: Database) {
  const due = await db
    .select()
    .from(contentItems)
    .where(and(eq(contentItems.status, "scheduled"), lte(contentItems.scheduledAt, new Date())));
  const results: Array<{ id: string; ok: boolean; error?: string }> = [];
  for (const item of due) {
    try {
      await publishContent({ db, organizationId: item.organizationId, actor: { type: "system", name: "scheduler" } }, item.id);
      results.push({ id: item.id, ok: true });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof AppError && e.code === "integration_not_connected") {
        await db.update(contentItems).set({ status: "failed", lastError: { code: e.code, message } }).where(eq(contentItems.id, item.id));
      }
      results.push({ id: item.id, ok: false, error: message });
    }
  }
  return results;
}
