import { getEnv, type ServerEnv } from "@dfos/config";

/**
 * Minimal client for "Instagram API with Instagram Login" (graph.instagram.com).
 * Endpoints follow Meta's documentation (checked 2026-10-24, API v26.0):
 *  - Business Login for Instagram: instagram.com/oauth/authorize, api.instagram.com/oauth/access_token,
 *    graph.instagram.com/access_token (ig_exchange_token), graph.instagram.com/refresh_access_token
 *  - Content Publishing: POST /<IG_ID>/media, GET /<CONTAINER_ID>?fields=status_code,
 *    POST /<IG_ID>/media_publish, GET /<IG_ID>/content_publishing_limit
 *
 * Tokens are only ever sent to Meta. Error messages never include URLs or tokens.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class MetaApiError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: number | null,
    readonly subcode: number | null,
    message: string,
    /** True when retrying the same request cannot create duplicates and may succeed. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "MetaApiError";
  }
  /** OAuth token invalid/expired/revoked (Graph error code 190). */
  get isAuthError() {
    return this.code === 190 || this.httpStatus === 401;
  }
  /** Request may or may not have reached Meta (network/timeout). */
  get isAmbiguous() {
    return this.httpStatus === 0;
  }
}

export type ContainerStatus = "IN_PROGRESS" | "FINISHED" | "ERROR" | "EXPIRED" | "PUBLISHED";

export interface MetaClientOptions {
  env?: ServerEnv;
  fetch?: FetchLike;
  timeoutMs?: number;
}

const API_HOST = "https://graph.instagram.com";
const OAUTH_AUTHORIZE = "https://www.instagram.com/oauth/authorize";
const OAUTH_TOKEN = "https://api.instagram.com/oauth/access_token";

export class MetaInstagramClient {
  private readonly env: ServerEnv;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(opts: MetaClientOptions = {}) {
    this.env = opts.env ?? getEnv();
    this.fetchImpl = opts.fetch ?? ((i, init) => fetch(i, init));
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  private get version() {
    return this.env.META_GRAPH_API_VERSION;
  }

  get scopes(): string[] {
    return this.env.META_INSTAGRAM_SCOPES.split(",").map((s) => s.trim()).filter(Boolean);
  }

  buildAuthorizeUrl(state: string) {
    const u = new URL(OAUTH_AUTHORIZE);
    u.searchParams.set("client_id", this.env.META_APP_ID ?? "");
    u.searchParams.set("redirect_uri", this.env.META_REDIRECT_URI ?? "");
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", this.scopes.join(","));
    u.searchParams.set("state", state);
    return u.toString();
  }

  private async request(method: "GET" | "POST", url: string, params: Record<string, string>, form = false): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      if (method === "GET") {
        const u = new URL(url);
        for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
        res = await this.fetchImpl(u.toString(), { method, signal: controller.signal });
      } else {
        const body = form ? toFormData(params) : new URLSearchParams(params);
        res = await this.fetchImpl(url, { method, body, signal: controller.signal });
      }
    } catch {
      throw new MetaApiError(0, null, null, controller.signal.aborted ? "Meta request timed out" : "Meta unreachable", true);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let json: Record<string, unknown>;
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      throw new MetaApiError(res.status, null, null, `Meta returned non-JSON (HTTP ${res.status})`, res.status >= 500);
    }
    if (!res.ok || json.error) {
      const err = (json.error ?? {}) as { code?: number; error_subcode?: number; message?: string; is_transient?: boolean; type?: string };
      const code = typeof err.code === "number" ? err.code : null;
      // Codes 1/2 = temporary/service errors, 4/17/32/613 = rate limits.
      const transient = err.is_transient === true || res.status >= 500 || [1, 2, 4, 17, 32, 613].includes(code ?? -1);
      const message = sanitize(err.message ?? json.error_message ?? `HTTP ${res.status}`);
      throw new MetaApiError(res.status, code, err.error_subcode ?? null, message, transient);
    }
    return json;
  }

  /** Step 2 of Business Login: code → short-lived token (server-side only). */
  async exchangeCode(code: string) {
    const json = await this.request(
      "POST",
      OAUTH_TOKEN,
      {
        client_id: this.env.META_APP_ID ?? "",
        client_secret: this.env.META_APP_SECRET ?? "",
        grant_type: "authorization_code",
        redirect_uri: this.env.META_REDIRECT_URI ?? "",
        code,
      },
      true,
    );
    // Documented shape is { data: [{ access_token, user_id, permissions }] }; older responses are flat.
    const row = (Array.isArray(json.data) ? json.data[0] : json) as { access_token?: string; user_id?: string | number; permissions?: string | string[] };
    if (!row?.access_token || row.user_id === undefined) throw new MetaApiError(200, null, null, "Token response is missing fields", false);
    const permissions = Array.isArray(row.permissions) ? row.permissions : String(row.permissions ?? "").split(",").filter(Boolean);
    return { accessToken: row.access_token, userId: String(row.user_id), permissions };
  }

  /** Step 3: short-lived → long-lived (60 days). */
  async exchangeLongLived(shortToken: string) {
    const json = await this.request("GET", `${API_HOST}/access_token`, {
      grant_type: "ig_exchange_token",
      client_secret: this.env.META_APP_SECRET ?? "",
      access_token: shortToken,
    });
    return parseToken(json);
  }

  /** Refresh a long-lived token that is at least 24h old and not expired. */
  async refreshLongLived(token: string) {
    const json = await this.request("GET", `${API_HOST}/refresh_access_token`, { grant_type: "ig_refresh_token", access_token: token });
    return parseToken(json);
  }

  async getMe(token: string) {
    const json = await this.request("GET", `${API_HOST}/${this.version}/me`, {
      fields: "user_id,username,account_type",
      access_token: token,
    });
    return {
      igUserId: String(json.user_id ?? json.id ?? ""),
      appScopedId: String(json.id ?? ""),
      username: typeof json.username === "string" ? json.username : null,
      accountType: typeof json.account_type === "string" ? json.account_type : null,
    };
  }

  async createImageContainer(token: string, igUserId: string, imageUrl: string, caption: string) {
    const json = await this.request("POST", `${API_HOST}/${this.version}/${encodeURIComponent(igUserId)}/media`, {
      image_url: imageUrl,
      caption,
      access_token: token,
    });
    if (typeof json.id !== "string" && typeof json.id !== "number") throw new MetaApiError(200, null, null, "Container id missing", false);
    return { containerId: String(json.id) };
  }

  async getContainerStatus(token: string, containerId: string) {
    const json = await this.request("GET", `${API_HOST}/${this.version}/${encodeURIComponent(containerId)}`, {
      fields: "status_code,status",
      access_token: token,
    });
    return { statusCode: String(json.status_code ?? "") as ContainerStatus, status: typeof json.status === "string" ? sanitize(json.status) : null };
  }

  /** Creates the post. NOT idempotent: callers must check container status before retrying. */
  async publishContainer(token: string, igUserId: string, containerId: string) {
    const json = await this.request("POST", `${API_HOST}/${this.version}/${encodeURIComponent(igUserId)}/media_publish`, {
      creation_id: containerId,
      access_token: token,
    });
    if (json.id === undefined) throw new MetaApiError(200, null, null, "Media id missing", false);
    return { mediaId: String(json.id) };
  }

  async getMedia(token: string, mediaId: string) {
    const json = await this.request("GET", `${API_HOST}/${this.version}/${encodeURIComponent(mediaId)}`, {
      fields: "id,permalink,timestamp,caption",
      access_token: token,
    });
    return {
      id: String(json.id ?? ""),
      permalink: typeof json.permalink === "string" ? json.permalink : null,
      timestamp: typeof json.timestamp === "string" ? json.timestamp : null,
      caption: typeof json.caption === "string" ? json.caption : null,
    };
  }

  async listRecentMedia(token: string, igUserId: string, limit = 10) {
    const json = await this.request("GET", `${API_HOST}/${this.version}/${encodeURIComponent(igUserId)}/media`, {
      fields: "id,permalink,timestamp,caption",
      limit: String(limit),
      access_token: token,
    });
    const data = Array.isArray(json.data) ? (json.data as Array<Record<string, unknown>>) : [];
    return data.map((m) => ({
      id: String(m.id ?? ""),
      permalink: typeof m.permalink === "string" ? m.permalink : null,
      timestamp: typeof m.timestamp === "string" ? m.timestamp : null,
      caption: typeof m.caption === "string" ? m.caption : null,
    }));
  }

  async getPublishingLimit(token: string, igUserId: string) {
    const json = await this.request("GET", `${API_HOST}/${this.version}/${encodeURIComponent(igUserId)}/content_publishing_limit`, {
      fields: "quota_usage,config",
      access_token: token,
    });
    const row = (Array.isArray(json.data) ? json.data[0] : json) as { quota_usage?: number; config?: { quota_total?: number } } | undefined;
    return { used: Number(row?.quota_usage ?? 0), total: Number(row?.config?.quota_total ?? 100) };
  }

  /** Subscribes the connected account to webhook fields (Instagram Login variant). */
  async subscribeWebhooks(token: string, igUserId: string, fields: string[]) {
    const json = await this.request("POST", `${API_HOST}/${this.version}/${encodeURIComponent(igUserId)}/subscribed_apps`, {
      subscribed_fields: fields.join(","),
      access_token: token,
    });
    return json.success === true;
  }
}

function parseToken(json: Record<string, unknown>) {
  if (typeof json.access_token !== "string") throw new MetaApiError(200, null, null, "Token missing in response", false);
  const expiresIn = Number(json.expires_in ?? 0);
  return { accessToken: json.access_token, expiresAt: expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null };
}

function toFormData(params: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(params)) fd.set(k, v);
  return fd;
}

/** Strip anything that looks like a token or URL with credentials from provider messages. */
export function sanitize(message: unknown) {
  return String(message)
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/\b(IG[A-Za-z]{2}|EAA)[A-Za-z0-9_-]{16,}/g, "[token]")
    .slice(0, 300);
}
