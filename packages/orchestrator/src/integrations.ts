import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { getEnv, getMetaConnectStatus, getStorageStatus, isSecretsKeyValid } from "@dfos/config";
import { integrationConnections, oauthStates, type Database } from "@dfos/db";
import { AppError } from "@dfos/domain";
import { EncryptedDbSecretStore, MetaApiError, MetaInstagramClient, type SecretStore } from "@dfos/integrations";
import { logger } from "@dfos/observability";
import { audit, writeAudit } from "./audit";
import { requirePermission, requireUser, type Actor, type Ctx } from "./context";

export const INSTAGRAM = "instagram";
const STATE_TTL_MS = 10 * 60_000;
export const REQUIRED_BASE_SCOPE = "instagram_business_basic";
export const PUBLISH_SCOPE = "instagram_business_content_publish";

export interface MetaDeps {
  client?: MetaInstagramClient;
  secrets?: SecretStore;
}
const resolve = (db: Database, d: MetaDeps) => ({
  client: d.client ?? new MetaInstagramClient(),
  secrets: d.secrets ?? new EncryptedDbSecretStore(db),
});

export type ConnectionRow = typeof integrationConnections.$inferSelect;
const LIVE = ["active", "expired", "error"] as const;

/** What the API/UI may see. Never includes the secret reference. */
export function publicConnection(c: ConnectionRow) {
  const { secretRef: _secretRef, ...rest } = c;
  return {
    ...rest,
    canPublish: c.status === "active" && c.enabled && c.grantedScopes.includes(PUBLISH_SCOPE),
  };
}

const hashState = (s: string) => createHash("sha256").update(s).digest("hex");

export function integrationsConfigStatus() {
  const env = getEnv();
  const meta = getMetaConnectStatus(env);
  const storage = getStorageStatus(env);
  return {
    meta: meta.ready ? { ready: true as const, missing: [] as string[] } : meta,
    storage: storage.ready ? { ready: true as const, missing: [] as string[] } : storage,
    secrets: isSecretsKeyValid(env),
    webhookConfigured: Boolean(env.META_APP_SECRET && env.META_WEBHOOK_VERIFY_TOKEN),
    redirectUri: env.META_REDIRECT_URI ?? null,
    webhookUrl: `${env.APP_BASE_URL}/api/v1/webhooks/meta`,
    graphApiVersion: env.META_GRAPH_API_VERSION,
    requestedScopes: env.META_INSTAGRAM_SCOPES.split(",").map((s) => s.trim()),
  };
}

// ───────────────────────── OAuth ─────────────────────────

/**
 * Starts "Business Login for Instagram". The random state is returned once (for the
 * browser cookie and the redirect); only its SHA-256 is stored, bound to user + org,
 * single use, valid 10 minutes.
 */
export async function startMetaConnect(ctx: Ctx, d: MetaDeps = {}) {
  requirePermission(ctx, "integrations.manage");
  const user = requireUser(ctx);
  const status = getMetaConnectStatus();
  if (!status.ready) {
    throw new AppError("integration_not_connected", `Instagram connection is not configured (missing: ${status.missing.join(", ")})`);
  }
  const state = randomBytes(32).toString("base64url");
  await ctx.db.insert(oauthStates).values({
    organizationId: ctx.organizationId,
    userId: user.userId,
    provider: INSTAGRAM,
    purpose: "connect",
    stateHash: hashState(state),
    expiresAt: new Date(Date.now() + STATE_TTL_MS),
  });
  await audit(ctx, { action: "integration.connect_started", targetType: "integration", targetId: INSTAGRAM });
  return { state, authorizeUrl: resolve(ctx.db, d).client.buildAuthorizeUrl(state) };
}

export interface CallbackInput {
  state: string | null;
  /** State value from the httpOnly cookie set when the flow started (binds the browser). */
  stateCookie: string | null;
  code: string | null;
  error: string | null;
  errorReason: string | null;
}

/**
 * Validates the callback and exchanges the code on the server. The state must:
 * match the browser cookie, exist, be unused, be unexpired, and belong to this user and org.
 * It is consumed atomically before any call to Meta.
 */
export async function completeMetaConnect(ctx: Ctx, input: CallbackInput, d: MetaDeps = {}) {
  requirePermission(ctx, "integrations.manage");
  const user = requireUser(ctx);
  if (!input.state || !/^[A-Za-z0-9_-]{20,128}$/.test(input.state)) throw new AppError("forbidden", "Missing or malformed OAuth state");
  const a = Buffer.from(hashState(input.state));
  const b = Buffer.from(hashState(input.stateCookie ?? ""));
  if (!input.stateCookie || !timingSafeEqual(a, b)) throw new AppError("forbidden", "OAuth state does not match this browser session");

  const [claimed] = await ctx.db
    .update(oauthStates)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(oauthStates.stateHash, hashState(input.state)),
        eq(oauthStates.provider, INSTAGRAM),
        sql`${oauthStates.usedAt} is null`,
        sql`${oauthStates.expiresAt} > now()`,
      ),
    )
    .returning();
  if (!claimed) throw new AppError("forbidden", "OAuth state is invalid, expired or already used");
  if (claimed.userId !== user.userId || claimed.organizationId !== ctx.organizationId) {
    throw new AppError("forbidden", "OAuth flow was started by a different user or organization");
  }

  if (input.error) {
    await audit(ctx, { action: "integration.connect_denied", targetType: "integration", targetId: INSTAGRAM, data: { reason: input.errorReason ?? input.error } });
    throw new AppError("integration_not_connected", input.errorReason === "user_denied" ? "Access was not granted on Instagram" : "Instagram returned an error");
  }
  if (!input.code || input.code.length > 2048) throw new AppError("validation_failed", "Missing authorization code");

  const { client, secrets } = resolve(ctx.db, d);
  let short, long, me;
  try {
    // Meta appends "#_" to the redirect; strip it defensively in case it reaches the code.
    short = await client.exchangeCode(input.code.replace(/#_$/, ""));
    long = await client.exchangeLongLived(short.accessToken);
    me = await client.getMe(long.accessToken);
  } catch (e) {
    if (e instanceof MetaApiError) {
      logger.warn("instagram connect failed", { code: e.code, httpStatus: e.httpStatus });
      throw new AppError("integration_error", `Instagram rejected the connection: ${e.message}`);
    }
    throw e;
  }
  const scopes = short.permissions;
  if (!scopes.includes(REQUIRED_BASE_SCOPE)) {
    throw new AppError("integration_missing_permission", `The ${REQUIRED_BASE_SCOPE} permission was not granted`);
  }
  const igUserId = me.igUserId || short.userId;

  const existing = await ctx.db
    .select()
    .from(integrationConnections)
    .where(and(eq(integrationConnections.provider, INSTAGRAM), eq(integrationConnections.externalAccountId, igUserId), inArray(integrationConnections.status, [...LIVE])));
  const other = existing.find((c) => c.organizationId !== ctx.organizationId);
  if (other) throw new AppError("conflict", "This Instagram account is already connected to another organization");
  const mine = existing.find((c) => c.organizationId === ctx.organizationId);

  const now = new Date();
  let connection: ConnectionRow;
  if (mine?.secretRef) {
    await secrets.replace(ctx.organizationId, mine.secretRef, long.accessToken);
    [connection] = (await ctx.db
      .update(integrationConnections)
      .set({
        status: "active",
        username: me.username,
        accountType: me.accountType,
        grantedScopes: scopes,
        tokenObtainedAt: now,
        tokenExpiresAt: long.expiresAt,
        lastSyncAt: now,
        lastError: null,
        connectedByUserId: user.userId,
      })
      .where(eq(integrationConnections.id, mine.id))
      .returning()) as [ConnectionRow];
  } else {
    const ref = await secrets.put(ctx.organizationId, long.accessToken);
    [connection] = (await ctx.db
      .insert(integrationConnections)
      .values({
        organizationId: ctx.organizationId,
        provider: INSTAGRAM,
        externalAccountId: igUserId,
        username: me.username,
        accountType: me.accountType,
        grantedScopes: scopes,
        secretRef: ref,
        tokenObtainedAt: now,
        tokenExpiresAt: long.expiresAt,
        lastSyncAt: now,
        connectedByUserId: user.userId,
      })
      .returning()) as [ConnectionRow];
  }

  // Optional: subscribe the account to webhook fields. Failure here does not undo the connection.
  const fields = (getEnv().META_WEBHOOK_FIELDS ?? "").split(",").map((f) => f.trim()).filter(Boolean);
  if (fields.length) {
    try {
      await client.subscribeWebhooks(long.accessToken, igUserId, fields);
    } catch (e) {
      await ctx.db
        .update(integrationConnections)
        .set({ lastError: { code: "webhook_subscribe_failed", message: e instanceof Error ? e.message : "failed", at: now.toISOString() } })
        .where(eq(integrationConnections.id, connection.id));
    }
  }

  await audit(ctx, {
    action: mine ? "integration.reconnected" : "integration.connected",
    targetType: "integration",
    targetId: connection.id,
    data: { provider: INSTAGRAM, username: me.username, accountType: me.accountType, scopes },
  });
  return publicConnection(connection);
}

// ───────────────────────── Connections ─────────────────────────

export async function listConnections(ctx: Ctx) {
  requirePermission(ctx, "integrations.read");
  const rows = await ctx.db.select().from(integrationConnections).where(eq(integrationConnections.organizationId, ctx.organizationId));
  return rows.map(publicConnection);
}

async function loadConnection(db: Database, organizationId: string, id: string) {
  const [c] = await db
    .select()
    .from(integrationConnections)
    .where(and(eq(integrationConnections.id, id), eq(integrationConnections.organizationId, organizationId)));
  if (!c) throw new AppError("not_found", "Connection not found");
  return c;
}

export async function getConnection(ctx: Ctx, id: string) {
  requirePermission(ctx, "integrations.read");
  return publicConnection(await loadConnection(ctx.db, ctx.organizationId, id));
}

export async function disconnectConnection(ctx: Ctx, id: string, d: MetaDeps = {}) {
  requirePermission(ctx, "integrations.manage");
  const c = await loadConnection(ctx.db, ctx.organizationId, id);
  if (c.secretRef) await resolve(ctx.db, d).secrets.delete(ctx.organizationId, c.secretRef);
  const [row] = await ctx.db
    .update(integrationConnections)
    .set({ status: "disconnected", secretRef: null, enabled: false })
    .where(eq(integrationConnections.id, c.id))
    .returning();
  await audit(ctx, { action: "integration.disconnected", targetType: "integration", targetId: id, data: { username: c.username } });
  return publicConnection(row!);
}

/** Kill switch: a disabled connection is never used for publishing or syncing. */
export async function setConnectionEnabled(ctx: Ctx, id: string, enabled: boolean) {
  requirePermission(ctx, "integrations.manage");
  const c = await loadConnection(ctx.db, ctx.organizationId, id);
  const [row] = await ctx.db.update(integrationConnections).set({ enabled }).where(eq(integrationConnections.id, c.id)).returning();
  await audit(ctx, { action: enabled ? "integration.enabled" : "integration.disabled", targetType: "integration", targetId: id });
  return publicConnection(row!);
}

async function markAuthFailure(db: Database, c: ConnectionRow, e: MetaApiError) {
  await db
    .update(integrationConnections)
    .set({ status: "expired", lastError: { code: "reauth_required", message: e.message, at: new Date().toISOString() } })
    .where(eq(integrationConnections.id, c.id));
}

/** Returns a usable token or throws a clear error. Never logs or returns the token. */
export async function getAccessToken(db: Database, c: ConnectionRow, secrets: SecretStore) {
  if (c.status === "disconnected" || c.status === "revoked" || !c.secretRef) {
    throw new AppError("integration_not_connected", "Instagram account is not connected");
  }
  if (!c.enabled) throw new AppError("integration_not_connected", "This Instagram connection is paused");
  if (c.status === "expired" || (c.tokenExpiresAt && c.tokenExpiresAt <= new Date())) {
    if (c.status !== "expired") {
      await db.update(integrationConnections).set({ status: "expired" }).where(eq(integrationConnections.id, c.id));
    }
    throw new AppError("integration_reauth_required", "Instagram authorization expired. Reconnect the account.");
  }
  return secrets.get(c.organizationId, c.secretRef);
}

/** Re-reads the profile and publishing quota from Instagram. */
export async function syncConnection(ctx: Ctx, id: string, d: MetaDeps = {}) {
  requirePermission(ctx, "integrations.manage");
  const { client, secrets } = resolve(ctx.db, d);
  const c = await loadConnection(ctx.db, ctx.organizationId, id);
  const token = await getAccessToken(ctx.db, c, secrets);
  try {
    const me = await client.getMe(token);
    const limit = await client.getPublishingLimit(token, c.externalAccountId);
    const [row] = await ctx.db
      .update(integrationConnections)
      .set({ username: me.username, accountType: me.accountType, lastSyncAt: new Date(), lastError: null, status: "active" })
      .where(eq(integrationConnections.id, c.id))
      .returning();
    await audit(ctx, { action: "integration.synced", targetType: "integration", targetId: id });
    return { connection: publicConnection(row!), publishingLimit: limit };
  } catch (e) {
    if (e instanceof MetaApiError) {
      if (e.isAuthError) {
        await markAuthFailure(ctx.db, c, e);
        throw new AppError("integration_reauth_required", "Instagram authorization is no longer valid. Reconnect the account.");
      }
      await ctx.db
        .update(integrationConnections)
        .set({ status: "error", lastError: { code: "sync_failed", message: e.message, at: new Date().toISOString() } })
        .where(eq(integrationConnections.id, c.id));
      throw new AppError("integration_error", `Instagram sync failed: ${e.message}`);
    }
    throw e;
  }
}

/** Worker: refresh long-lived tokens that expire within 7 days (Meta requires them to be ≥24h old). */
export async function refreshExpiringTokens(db: Database, d: MetaDeps = {}) {
  const { client, secrets } = resolve(db, d);
  const soon = new Date(Date.now() + 7 * 86400_000);
  const dayAgo = new Date(Date.now() - 86400_000);
  const due = await db
    .select()
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.provider, INSTAGRAM),
        eq(integrationConnections.status, "active"),
        lt(integrationConnections.tokenExpiresAt, soon),
        lt(integrationConnections.tokenObtainedAt, dayAgo),
      ),
    );
  let refreshed = 0;
  for (const c of due) {
    try {
      const token = await getAccessToken(db, c, secrets);
      const next = await client.refreshLongLived(token);
      await secrets.replace(c.organizationId, c.secretRef!, next.accessToken);
      await db
        .update(integrationConnections)
        .set({ tokenObtainedAt: new Date(), tokenExpiresAt: next.expiresAt, lastError: null })
        .where(eq(integrationConnections.id, c.id));
      await writeAudit(db, c.organizationId, { type: "system", name: "worker" }, { action: "integration.token_refreshed", targetType: "integration", targetId: c.id });
      refreshed++;
    } catch (e) {
      if (e instanceof MetaApiError && e.isAuthError) await markAuthFailure(db, c, e);
      else logger.warn("token refresh failed", { connectionId: c.id, err: e instanceof Error ? e.message : String(e) });
    }
  }
  return refreshed;
}

/** Meta deauthorize / data deletion callback: revoke every live connection for that account and drop its token. */
export async function revokeByExternalAccount(db: Database, externalAccountId: string, reason: string, d: MetaDeps = {}) {
  const secrets = d.secrets ?? new EncryptedDbSecretStore(db);
  const rows = await db
    .select()
    .from(integrationConnections)
    .where(and(eq(integrationConnections.provider, INSTAGRAM), eq(integrationConnections.externalAccountId, externalAccountId), inArray(integrationConnections.status, [...LIVE])));
  const actor: Actor = { type: "system", name: "meta-callback" };
  for (const c of rows) {
    if (c.secretRef) await secrets.delete(c.organizationId, c.secretRef);
    await db
      .update(integrationConnections)
      .set({ status: "revoked", secretRef: null, enabled: false, lastError: { code: "revoked", message: reason, at: new Date().toISOString() } })
      .where(eq(integrationConnections.id, c.id));
    await writeAudit(db, c.organizationId, actor, { action: "integration.revoked", targetType: "integration", targetId: c.id, data: { reason } });
  }
  return rows.length;
}

/** Active, enabled connection for an org (used by publishing). */
export async function findPublishingConnection(db: Database, organizationId: string) {
  const rows = await db
    .select()
    .from(integrationConnections)
    .where(and(eq(integrationConnections.organizationId, organizationId), eq(integrationConnections.provider, INSTAGRAM), inArray(integrationConnections.status, [...LIVE])));
  return rows[0];
}

export { markAuthFailure };
