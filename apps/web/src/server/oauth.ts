import "server-only";

/** httpOnly cookie that binds an OAuth flow to the browser that started it. */
export const OAUTH_STATE_COOKIE = "dfos_oauth_state";
export const OAUTH_COOKIE_PATH = "/api/v1/integrations/meta";
export const OAUTH_COOKIE_MAX_AGE = 600;
