/**
 * TEST ONLY: an in-process fake of the Instagram Graph API endpoints we use.
 * Lets the real MetaInstagramClient, publisher and OAuth code run without network access.
 */
import { randomBytes } from "node:crypto";
import { getEnv, resetEnvCache } from "@dfos/config";
import type { Database } from "@dfos/db";
import { integrationConnections } from "@dfos/db";
import { EncryptedDbSecretStore, MemoryStorageProvider, MetaInstagramClient, setStorageProvider } from "@dfos/integrations";

export const TEST_SECRETS_KEY = randomBytes(32).toString("base64");
export const TEST_APP_SECRET = "test-app-secret-not-real";

export function setMetaTestEnv() {
  Object.assign(process.env, {
    META_APP_ID: "123456",
    META_APP_SECRET: TEST_APP_SECRET,
    META_REDIRECT_URI: "https://app.example.test/api/v1/integrations/meta/callback",
    META_WEBHOOK_VERIFY_TOKEN: "verify-me",
    SECRETS_ENCRYPTION_KEY: TEST_SECRETS_KEY,
    OBJECT_STORAGE_ENDPOINT: "",
  });
  resetEnvCache();
}

export function makeJpeg(width: number, height: number, padding = 32) {
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Uint8Array([0xff, 0xd8, ...sof, ...new Array(padding).fill(0), 0xff, 0xd9]);
}

type ContainerState = "IN_PROGRESS" | "FINISHED" | "ERROR" | "EXPIRED" | "PUBLISHED";

export class FakeGraph {
  igUserId = `178414${Math.floor(Math.random() * 1e10).toString().padStart(10, "0")}`;
  username = "dubaifans_test";
  permissions = ["instagram_business_basic", "instagram_business_content_publish"];
  tokenCounter = 0;
  containers = new Map<string, { status: ContainerState; caption: string; imageUrl: string }>();
  media = new Map<string, { caption: string; timestamp: string }>();
  publishCalls = 0;
  /** Container status reported after creation (FINISHED unless a test changes it). */
  nextContainerStatus: ContainerState = "FINISHED";
  /** Queue of behaviours for the next media_publish calls. */
  publishBehaviour: Array<"ok" | "network_after_success" | "network_before" | "reject" | "auth"> = [];
  quota = { used: 0, total: 100 };
  failExchange = false;
  calls: string[] = [];

  fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const params = new URLSearchParams(url.search);
    if (init?.body instanceof URLSearchParams) init.body.forEach((v, k) => params.set(k, v));
    if (init?.body instanceof FormData) init.body.forEach((v, k) => params.set(k, String(v)));
    const path = url.pathname.replace(/^\/v\d+\.\d+/, "");
    this.calls.push(`${method} ${url.host}${path}`);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const authError = () => json({ error: { message: "Error validating access token", type: "OAuthException", code: 190 } }, 400);

    if (url.host === "api.instagram.com" && path === "/oauth/access_token") {
      if (this.failExchange || params.get("code") === "bad") return json({ error_type: "OAuthException", code: 400, error_message: "Invalid code" }, 400);
      return json({ data: [{ access_token: `IGAAshort${++this.tokenCounter}xxxxxxxxxxxxxxxx`, user_id: this.igUserId, permissions: this.permissions.join(",") }] });
    }
    if (path === "/access_token") return json({ access_token: `IGAAlong${++this.tokenCounter}yyyyyyyyyyyyyyyyyy`, token_type: "bearer", expires_in: 5184000 });
    if (path === "/refresh_access_token") return json({ access_token: `IGAArefreshed${++this.tokenCounter}zzzzzzzzzzzzzz`, token_type: "bearer", expires_in: 5184000 });

    const token = params.get("access_token") ?? "";
    if (!token.startsWith("IGAA")) return authError();
    if (token.includes("revoked")) return authError();

    if (path === "/me") return json({ id: "app-scoped-1", user_id: this.igUserId, username: this.username, account_type: "BUSINESS" });
    if (path === `/${this.igUserId}/subscribed_apps`) return json({ success: true });
    if (path === `/${this.igUserId}/content_publishing_limit`) return json({ data: [{ quota_usage: this.quota.used, config: { quota_total: this.quota.total, quota_duration: 86400 } }] });
    if (method === "POST" && path === `/${this.igUserId}/media`) {
      const id = `cont_${this.containers.size + 1}`;
      this.containers.set(id, { status: this.nextContainerStatus, caption: params.get("caption") ?? "", imageUrl: params.get("image_url") ?? "" });
      return json({ id });
    }
    if (method === "GET" && path === `/${this.igUserId}/media`) {
      return json({ data: [...this.media.entries()].reverse().map(([id, m]) => ({ id, caption: m.caption, timestamp: m.timestamp, permalink: `https://www.instagram.com/p/${id}/` })) });
    }
    if (method === "POST" && path === `/${this.igUserId}/media_publish`) {
      this.publishCalls++;
      const c = this.containers.get(params.get("creation_id") ?? "");
      if (!c) return json({ error: { message: "Invalid creation_id", code: 100 } }, 400);
      const behaviour = this.publishBehaviour.shift() ?? "ok";
      if (behaviour === "auth") return authError();
      if (behaviour === "reject") return json({ error: { message: "Media cannot be published", code: 9007, error_subcode: 2207027 } }, 400);
      if (behaviour === "network_before") throw new TypeError("fetch failed");
      const mediaId = `media_${this.media.size + 1}`;
      c.status = "PUBLISHED";
      this.media.set(mediaId, { caption: c.caption, timestamp: new Date().toISOString() });
      if (behaviour === "network_after_success") throw new TypeError("fetch failed");
      return json({ id: mediaId });
    }
    const containerMatch = path.match(/^\/(cont_\d+)$/);
    if (containerMatch) {
      const c = this.containers.get(containerMatch[1]!);
      return c ? json({ id: containerMatch[1], status_code: c.status }) : json({ error: { message: "not found", code: 100 } }, 400);
    }
    const mediaMatch = path.match(/^\/(media_\d+)$/);
    if (mediaMatch) {
      const m = this.media.get(mediaMatch[1]!);
      return m ? json({ id: mediaMatch[1], caption: m.caption, timestamp: m.timestamp, permalink: `https://www.instagram.com/p/${mediaMatch[1]}/` }) : json({ error: { message: "not found", code: 100 } }, 400);
    }
    return json({ error: { message: `unhandled ${method} ${path}`, code: 100 } }, 400);
  };

  client() {
    return new MetaInstagramClient({ env: getEnv(), fetch: this.fetch, timeoutMs: 2000 });
  }
}

/** Inserts an active Instagram connection with an encrypted token, as the OAuth flow would. */
export async function connectInstagram(db: Database, organizationId: string, opts: { scopes?: string[]; igUserId?: string; token?: string; enabled?: boolean } = {}) {
  const secrets = new EncryptedDbSecretStore(db);
  const ref = await secrets.put(organizationId, opts.token ?? "IGAAlong-test-token-aaaaaaaaaaaaaaaa");
  const [row] = await db
    .insert(integrationConnections)
    .values({
      organizationId,
      provider: "instagram",
      externalAccountId: opts.igUserId ?? `178414${Math.floor(Math.random() * 1e10).toString().padStart(10, "0")}`,
      username: "dubaifans_test",
      accountType: "BUSINESS",
      grantedScopes: opts.scopes ?? ["instagram_business_basic", "instagram_business_content_publish"],
      secretRef: ref,
      enabled: opts.enabled ?? true,
      tokenObtainedAt: new Date(),
      tokenExpiresAt: new Date(Date.now() + 50 * 86400_000),
    })
    .returning();
  return { connection: row!, secrets };
}

export function memoryStorage(publiclyReachable = true) {
  const s = new MemoryStorageProvider(publiclyReachable);
  setStorageProvider(s);
  return s;
}
