import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

// Enum values mirror @dfos/domain. Kept literal here so drizzle-kit can load this file on its own.
export const roleEnum = pgEnum("member_role", ["owner", "admin", "approver", "member", "viewer"]);
export const memberStatusEnum = pgEnum("member_status", ["active", "suspended"]);
export const taskStatusEnum = pgEnum("task_status", [
  "queued",
  "running",
  "waiting_approval",
  "retrying",
  "succeeded",
  "failed",
  "cancelled",
]);
export const taskPriorityEnum = pgEnum("task_priority", ["low", "normal", "high", "urgent"]);
export const actorTypeEnum = pgEnum("actor_type", ["user", "agent", "system"]);
export const runStatusEnum = pgEnum("agent_run_status", ["running", "succeeded", "failed"]);
export const approvalStatusEnum = pgEnum("approval_status", [
  "pending",
  "approved",
  "rejected",
  "changes_requested",
  "executed",
  "invalidated",
  "expired",
]);
export const riskLevelEnum = pgEnum("risk_level", ["low", "medium", "high", "critical"]);
export const contentStatusEnum = pgEnum("content_status", [
  "draft",
  "in_review",
  "changes_requested",
  "approved",
  "scheduled",
  "publishing",
  "published",
  "failed",
  "rejected",
]);
export const contentPlatformEnum = pgEnum("content_platform", [
  "instagram",
  "facebook",
  "tiktok",
  "whatsapp",
  "website",
]);
export const contentFormatEnum = pgEnum("content_format", [
  "post",
  "reel",
  "story",
  "carousel",
  "ad_copy",
  "caption",
]);
export const contentSourceEnum = pgEnum("content_source", ["manual", "ai"]);
export const costSourceEnum = pgEnum("cost_source", ["configured_price", "unknown"]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

const orgId = () =>
  uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" });

// ───────────────────────── Organizations & users ─────────────────────────

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  timezone: text("timezone").notNull().default("Asia/Dubai"),
  /** Monthly AI spend ceiling. Null = no ceiling set (cost still recorded). */
  aiMonthlyBudgetUsd: numeric("ai_monthly_budget_usd", { precision: 12, scale: 4 }),
  /** Org-wide kill switch: when true no agent runs. */
  agentsPaused: boolean("agents_paused").notNull().default(false),
  /** Four-eyes rule: the approver must differ from the requester and the content author. Off by default. */
  requireDistinctApprover: boolean("require_distinct_approver").notNull().default(false),
  ...timestamps,
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    authProvider: text("auth_provider").notNull(), // "clerk" | "dev"
    authSubject: text("auth_subject").notNull(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex("users_auth_identity_uq").on(t.authProvider, t.authSubject)],
);

export const organizationMembers = pgTable(
  "organization_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: roleEnum("role").notNull().default("member"),
    status: memberStatusEnum("status").notNull().default("active"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("org_members_org_user_uq").on(t.organizationId, t.userId),
    index("org_members_user_idx").on(t.userId),
  ],
);

// ───────────────────────── Agents ─────────────────────────

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    key: text("key").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    model: text("model"),
    maxCostPerRunUsd: numeric("max_cost_per_run_usd", { precision: 12, scale: 4 }),
    maxAttempts: integer("max_attempts").notNull().default(3),
    timeoutMs: integer("timeout_ms").notNull().default(120000),
    ...timestamps,
  },
  (t) => [uniqueIndex("agents_org_key_uq").on(t.organizationId, t.key)],
);

export const agentPolicies = pgTable(
  "agent_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    actionType: text("action_type").notNull(),
    requiresApproval: boolean("requires_approval").notNull().default(true),
    riskLevel: riskLevelEnum("risk_level").notNull().default("high"),
    ...timestamps,
  },
  (t) => [uniqueIndex("agent_policies_org_action_uq").on(t.organizationId, t.actionType)],
);

export const agentToolPermissions = pgTable(
  "agent_tool_permissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    tool: text("tool").notNull(),
    allowed: boolean("allowed").notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex("agent_tool_perm_agent_tool_uq").on(t.agentId, t.tool)],
);

// ───────────────────────── Tasks ─────────────────────────

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    parentTaskId: uuid("parent_task_id").references((): AnyPgColumn => tasks.id, {
      onDelete: "cascade",
    }),
    agentKey: text("agent_key").notNull(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    input: jsonb("input").$type<Record<string, unknown>>().notNull().default({}),
    status: taskStatusEnum("status").notNull().default("queued"),
    priority: taskPriorityEnum("priority").notNull().default("normal"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    error: jsonb("error").$type<{ code: string; message: string; details?: unknown }>(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    approvalRequestId: uuid("approval_request_id"),
    budgetUsd: numeric("budget_usd", { precision: 12, scale: 4 }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    idempotencyKey: text("idempotency_key"),
    traceId: uuid("trace_id").notNull().defaultRandom(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("tasks_claim_idx").on(t.status, t.runAfter),
    index("tasks_org_created_idx").on(t.organizationId, t.createdAt),
    index("tasks_parent_idx").on(t.parentTaskId),
    uniqueIndex("tasks_org_idempotency_uq")
      .on(t.organizationId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
  ],
);

export const taskDependencies = pgTable(
  "task_dependencies",
  {
    organizationId: orgId(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    dependsOnTaskId: uuid("depends_on_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.dependsOnTaskId] })],
);

export const taskEvents = pgTable(
  "task_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    fromStatus: taskStatusEnum("from_status"),
    toStatus: taskStatusEnum("to_status"),
    message: text("message"),
    data: jsonb("data").$type<Record<string, unknown>>(),
    actorType: actorTypeEnum("actor_type").notNull(),
    actorId: text("actor_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("task_events_task_idx").on(t.taskId, t.createdAt)],
);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    agentKey: text("agent_key").notNull(),
    attempt: integer("attempt").notNull(),
    status: runStatusEnum("status").notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    summary: text("summary"),
    error: jsonb("error").$type<{ code: string; message: string }>(),
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    traceId: uuid("trace_id").notNull(),
  },
  (t) => [
    index("agent_runs_org_agent_idx").on(t.organizationId, t.agentKey, t.startedAt),
    index("agent_runs_task_idx").on(t.taskId),
  ],
);

// ───────────────────────── Approvals & audit ─────────────────────────

export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    contentItemId: uuid("content_item_id").references((): AnyPgColumn => contentItems.id, {
      onDelete: "set null",
    }),
    actionType: text("action_type").notNull(),
    title: text("title").notNull(),
    summary: text("summary"),
    /** The exact action that will run if approved. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    fingerprint: text("fingerprint").notNull(),
    riskLevel: riskLevelEnum("risk_level").notNull().default("high"),
    status: approvalStatusEnum("status").notNull().default("pending"),
    requestedByType: actorTypeEnum("requested_by_type").notNull(),
    requestedById: text("requested_by_id"),
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("approvals_org_status_idx").on(t.organizationId, t.status, t.createdAt),
    index("approvals_content_idx").on(t.contentItemId),
  ],
);

export const approvalEvents = pgTable(
  "approval_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    approvalRequestId: uuid("approval_request_id")
      .notNull()
      .references(() => approvalRequests.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    actorType: actorTypeEnum("actor_type").notNull(),
    actorId: text("actor_id"),
    note: text("note"),
    fingerprint: text("fingerprint"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("approval_events_request_idx").on(t.approvalRequestId, t.createdAt)],
);

/** Append-only. A DB trigger (see migrations) blocks UPDATE and DELETE. */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    actorType: actorTypeEnum("actor_type").notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    data: jsonb("data").$type<Record<string, unknown>>(),
    requestId: text("request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_logs_org_created_idx").on(t.organizationId, t.createdAt)],
);

// ───────────────────────── Content ─────────────────────────

export const contentItems = pgTable(
  "content_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    title: text("title").notNull(),
    platform: contentPlatformEnum("platform").notNull(),
    format: contentFormatEnum("format").notNull(),
    status: contentStatusEnum("status").notNull().default("draft"),
    currentVersionId: uuid("current_version_id"),
    audience: text("audience"),
    goal: text("goal"),
    tone: text("tone"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    externalPostId: text("external_post_id"),
    lastError: jsonb("last_error").$type<{ code: string; message: string }>(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (t) => [
    index("content_org_status_idx").on(t.organizationId, t.status),
    index("content_org_scheduled_idx").on(t.organizationId, t.scheduledAt),
  ],
);

export const contentVersions = pgTable(
  "content_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    contentItemId: uuid("content_item_id")
      .notNull()
      .references(() => contentItems.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    body: text("body").notNull(),
    hashtags: jsonb("hashtags").$type<string[]>().notNull().default([]),
    cta: text("cta"),
    source: contentSourceEnum("source").notNull(),
    agentRunId: uuid("agent_run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    contentHash: text("content_hash").notNull(),
    /** Image attached to this version. Part of the approved fingerprint. */
    mediaAssetId: uuid("media_asset_id").references((): AnyPgColumn => mediaAssets.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("content_versions_item_number_uq").on(t.contentItemId, t.versionNumber)],
);

/** Files in object storage. A row exists only after the storage provider confirmed the upload. */
export const mediaAssets = pgTable(
  "media_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    storageProvider: text("storage_provider").notNull(),
    storageKey: text("storage_key").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    width: integer("width"),
    height: integer("height"),
    originalName: text("original_name"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("media_assets_storage_key_uq").on(t.storageProvider, t.storageKey),
    index("media_assets_org_idx").on(t.organizationId, t.createdAt),
  ],
);

// ───────────────────────── Integrations ─────────────────────────

export const connectionStatusEnum = pgEnum("connection_status", [
  "active",
  "expired",
  "revoked",
  "error",
  "disconnected",
]);
export const webhookStatusEnum = pgEnum("webhook_status", ["received", "processing", "processed", "ignored", "failed"]);
export const publicationStatusEnum = pgEnum("publication_status", [
  "queued",
  "container_processing",
  "ready_to_publish",
  "publish_requested",
  "published",
  "failed",
  "needs_review",
]);

export const integrationConnections = pgTable(
  "integration_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    provider: text("provider").notNull(), // "instagram"
    externalAccountId: text("external_account_id").notNull(),
    username: text("username"),
    accountType: text("account_type"),
    status: connectionStatusEnum("status").notNull().default("active"),
    /** Kill switch for this connection: when false nothing is published or synced. */
    enabled: boolean("enabled").notNull().default(true),
    grantedScopes: jsonb("granted_scopes").$type<string[]>().notNull().default([]),
    /** Opaque reference into integration_secrets. Null once disconnected. Never the token itself. */
    secretRef: text("secret_ref"),
    tokenObtainedAt: timestamp("token_obtained_at", { withTimezone: true }),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastError: jsonb("last_error").$type<{ code: string; message: string; at: string }>(),
    connectedByUserId: uuid("connected_by_user_id").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    index("integration_connections_org_idx").on(t.organizationId, t.provider),
    // One live connection per external account across all orgs: webhooks are routed by account id.
    uniqueIndex("integration_connections_live_account_uq")
      .on(t.provider, t.externalAccountId)
      .where(sql`${t.status} in ('active', 'expired', 'error')`),
  ],
);

/**
 * Encrypted secrets (AES-256-GCM). The key lives outside the database (env / secret manager),
 * so a database dump alone does not reveal tokens.
 */
export const integrationSecrets = pgTable("integration_secrets", {
  ref: text("ref").primaryKey(),
  organizationId: orgId(),
  keyVersion: integer("key_version").notNull(),
  iv: text("iv").notNull(),
  authTag: text("auth_tag").notNull(),
  ciphertext: text("ciphertext").notNull(),
  ...timestamps,
});

/** One row per OAuth attempt. Only a hash of the state is stored; single use; short expiry. */
export const oauthStates = pgTable(
  "oauth_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    purpose: text("purpose").notNull(),
    stateHash: text("state_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("oauth_states_hash_uq").on(t.stateHash)],
);

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    /** Derived from trusted fields of the event; see docs/operations/meta-setup.md. */
    dedupeKey: text("dedupe_key").notNull(),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").references(() => integrationConnections.id, { onDelete: "set null" }),
    externalAccountId: text("external_account_id"),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: webhookStatusEnum("status").notNull().default("received"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("webhook_events_dedupe_uq").on(t.provider, t.dedupeKey),
    index("webhook_events_pending_idx").on(t.status, t.nextAttemptAt),
    index("webhook_events_org_idx").on(t.organizationId, t.receivedAt),
  ],
);

/** One publication per approval: the unique approval id is what stops double posting. */
export const contentPublications = pgTable(
  "content_publications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    contentItemId: uuid("content_item_id")
      .notNull()
      .references(() => contentItems.id, { onDelete: "cascade" }),
    versionId: uuid("version_id")
      .notNull()
      .references(() => contentVersions.id, { onDelete: "restrict" }),
    approvalRequestId: uuid("approval_request_id")
      .notNull()
      .references(() => approvalRequests.id, { onDelete: "restrict" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => integrationConnections.id, { onDelete: "restrict" }),
    platform: contentPlatformEnum("platform").notNull(),
    status: publicationStatusEnum("status").notNull().default("queued"),
    containerId: text("container_id"),
    externalMediaId: text("external_media_id"),
    permalink: text("permalink"),
    containerAttempts: integer("container_attempts").notNull().default(0),
    statusChecks: integer("status_checks").notNull().default(0),
    publishAttempts: integer("publish_attempts").notNull().default(0),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }).notNull().defaultNow(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastError: jsonb("last_error").$type<{ code: string; message: string }>(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("content_publications_approval_uq").on(t.approvalRequestId),
    index("content_publications_due_idx").on(t.status, t.nextCheckAt),
    index("content_publications_content_idx").on(t.contentItemId),
  ],
);

// ───────────────────────── Usage & idempotency ─────────────────────────

export const aiModelUsage = pgTable(
  "ai_model_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    agentRunId: uuid("agent_run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    /** Null when no price is configured: we never invent a cost. */
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    costSource: costSourceEnum("cost_source").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    success: boolean("success").notNull(),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ai_usage_org_created_idx").on(t.organizationId, t.createdAt)],
);

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: orgId(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    key: text("key").notNull(),
    route: text("route").notNull(),
    requestHash: text("request_hash").notNull(),
    statusCode: integer("status_code"),
    response: jsonb("response"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("idempotency_org_key_route_uq").on(t.organizationId, t.key, t.route)],
);
