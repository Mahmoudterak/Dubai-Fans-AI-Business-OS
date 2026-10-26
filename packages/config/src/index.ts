import { z } from "zod";

/**
 * Server-side environment. Never import this from client components.
 * Empty strings are treated as "not set" so a copied .env.example works as-is.
 */
const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalString = z.preprocess(emptyToUndefined, z.string().optional());
const optionalNumber = z.preprocess(emptyToUndefined, z.coerce.number().nonnegative().optional());

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_BASE_URL: z.preprocess(emptyToUndefined, z.url().default("http://localhost:3000")),

  DATABASE_URL: optionalString,

  // Auth. Clerk is the production provider. Dev auth only works outside production.
  AUTH_SECRET: optionalString,
  CLERK_SECRET_KEY: optionalString,
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: optionalString,
  DEV_AUTH_ENABLED: z.preprocess(emptyToUndefined, z.enum(["true", "false"]).default("true")),

  // AI gateway
  AI_PROVIDER: z.preprocess(
    emptyToUndefined,
    z.enum(["anthropic", "openai-compatible", "mock"]).optional(),
  ),
  AI_GATEWAY_API_KEY: optionalString,
  AI_BASE_URL: optionalString,
  AI_DEFAULT_MODEL: optionalString,
  AI_PRICE_INPUT_PER_MTOK_USD: optionalNumber,
  AI_PRICE_OUTPUT_PER_MTOK_USD: optionalNumber,
  AI_REQUEST_TIMEOUT_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(60000)),
  AI_MAX_OUTPUT_TOKENS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(2048)),

  // Meta / Instagram — "Instagram API with Instagram Login". App ID and secret are the
  // *Instagram* app ID/secret shown under Instagram > API setup with Instagram login.
  META_APP_ID: optionalString,
  META_APP_SECRET: optionalString,
  META_REDIRECT_URI: optionalString,
  META_WEBHOOK_VERIFY_TOKEN: optionalString,
  META_GRAPH_API_VERSION: z.preprocess(emptyToUndefined, z.string().regex(/^v\d+\.\d+$/).default("v26.0")),
  /** Webhook fields to subscribe each connected account to, e.g. "comments,messages". Empty = none. */
  META_WEBHOOK_FIELDS: optionalString,
  META_INSTAGRAM_SCOPES: z.preprocess(
    emptyToUndefined,
    z.string().default("instagram_business_basic,instagram_business_content_publish"),
  ),

  // Secrets at rest: base64 of 32 random bytes. Keep it in the host's secret manager, never in the DB.
  SECRETS_ENCRYPTION_KEY: optionalString,
  SECRETS_KEY_VERSION: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(1)),
  /** Previous keys for rotation, "version:base64key" comma-separated. */
  SECRETS_PREVIOUS_KEYS: optionalString,

  // Object storage (S3-compatible: AWS S3, Cloudflare R2, Backblaze B2, MinIO...)
  OBJECT_STORAGE_ENDPOINT: optionalString,
  OBJECT_STORAGE_REGION: z.preprocess(emptyToUndefined, z.string().default("auto")),
  OBJECT_STORAGE_BUCKET: optionalString,
  OBJECT_STORAGE_ACCESS_KEY_ID: optionalString,
  OBJECT_STORAGE_SECRET_ACCESS_KEY: optionalString,
  OBJECT_STORAGE_FORCE_PATH_STYLE: z.preprocess(emptyToUndefined, z.enum(["true", "false"]).default("true")),
  /** Lifetime of signed GET links handed to Meta. Must cover container processing (minutes). */
  OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS: z.preprocess(emptyToUndefined, z.coerce.number().int().min(300).max(604800).default(3600)),
  MEDIA_MAX_UPLOAD_BYTES: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(8 * 1024 * 1024)),

  // Worker
  WORKER_POLL_INTERVAL_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(2000)),
  WORKER_LOCK_TIMEOUT_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(300000)),

  LOG_LEVEL: z.preprocess(emptyToUndefined, z.enum(["debug", "info", "warn", "error"]).default("info")),
});

export type ServerEnv = z.infer<typeof envSchema>;

let cached: ServerEnv | undefined;

export function getEnv(source: Record<string, string | undefined> = process.env): ServerEnv {
  if (cached && source === process.env) return cached;
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  if (source === process.env) cached = parsed.data;
  return parsed.data;
}

/** For tests: drop the cached env so changes to process.env take effect. */
export function resetEnvCache() {
  cached = undefined;
}

export function isClerkConfigured(env = getEnv()) {
  return Boolean(env.CLERK_SECRET_KEY && env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
}

/** Dev auth is never allowed in production, whatever the flag says. */
export function isDevAuthAllowed(env = getEnv()) {
  return env.NODE_ENV !== "production" && env.DEV_AUTH_ENABLED === "true" && !isClerkConfigured(env);
}

export type AiConfigStatus =
  | { configured: true; provider: "anthropic" | "openai-compatible" | "mock"; model: string }
  | { configured: false; reason: string };

export function getAiConfigStatus(env = getEnv()): AiConfigStatus {
  if (!env.AI_PROVIDER) return { configured: false, reason: "AI_PROVIDER is not set" };
  if (env.AI_PROVIDER === "mock") {
    if (env.NODE_ENV !== "test") return { configured: false, reason: "The mock AI provider only runs in tests" };
    return { configured: true, provider: "mock", model: env.AI_DEFAULT_MODEL ?? "mock-model" };
  }
  if (!env.AI_GATEWAY_API_KEY) return { configured: false, reason: "AI_GATEWAY_API_KEY is not set" };
  if (!env.AI_DEFAULT_MODEL) return { configured: false, reason: "AI_DEFAULT_MODEL is not set" };
  if (env.AI_PROVIDER === "openai-compatible" && !env.AI_BASE_URL) {
    return { configured: false, reason: "AI_BASE_URL is required for openai-compatible providers" };
  }
  return { configured: true, provider: env.AI_PROVIDER, model: env.AI_DEFAULT_MODEL };
}

export function isMetaConfigured(env = getEnv()) {
  return Boolean(env.META_APP_ID && env.META_APP_SECRET && env.META_REDIRECT_URI);
}

export type FeatureStatus = { ready: true } | { ready: false; missing: string[] };

/** Everything needed to connect an Instagram account. */
export function getMetaConnectStatus(env = getEnv()): FeatureStatus {
  const missing: string[] = [];
  if (!env.META_APP_ID) missing.push("META_APP_ID");
  if (!env.META_APP_SECRET) missing.push("META_APP_SECRET");
  if (!env.META_REDIRECT_URI) missing.push("META_REDIRECT_URI");
  if (!isSecretsKeyValid(env)) missing.push("SECRETS_ENCRYPTION_KEY");
  return missing.length ? { ready: false, missing } : { ready: true };
}

export function isSecretsKeyValid(env = getEnv()) {
  if (!env.SECRETS_ENCRYPTION_KEY) return false;
  try {
    return Buffer.from(env.SECRETS_ENCRYPTION_KEY, "base64").length === 32;
  } catch {
    return false;
  }
}

export function getStorageStatus(env = getEnv()): FeatureStatus {
  const missing: string[] = [];
  if (!env.OBJECT_STORAGE_ENDPOINT) missing.push("OBJECT_STORAGE_ENDPOINT");
  if (!env.OBJECT_STORAGE_BUCKET) missing.push("OBJECT_STORAGE_BUCKET");
  if (!env.OBJECT_STORAGE_ACCESS_KEY_ID) missing.push("OBJECT_STORAGE_ACCESS_KEY_ID");
  if (!env.OBJECT_STORAGE_SECRET_ACCESS_KEY) missing.push("OBJECT_STORAGE_SECRET_ACCESS_KEY");
  return missing.length ? { ready: false, missing } : { ready: true };
}
