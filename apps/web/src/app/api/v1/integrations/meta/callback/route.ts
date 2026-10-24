import { NextResponse, type NextRequest } from "next/server";
import { ctxFromSession } from "@dfos/auth";
import { getDb } from "@dfos/db";
import { isAppError } from "@dfos/domain";
import { logger } from "@dfos/observability";
import { completeMetaConnect } from "@dfos/orchestrator";
import { OAUTH_COOKIE_PATH, OAUTH_STATE_COOKIE } from "@/server/oauth";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

/**
 * Instagram redirects here. The code is exchanged server-side only; the browser never sees
 * a token. Every outcome redirects back to /integrations with a status code, and the state
 * cookie is always cleared.
 */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const back = (query: string) => {
    const res = NextResponse.redirect(new URL(`/integrations?${query}`, req.url), 303);
    res.cookies.set(OAUTH_STATE_COOKIE, "", { path: OAUTH_COOKIE_PATH, maxAge: 0 });
    return res;
  };
  const session = await getSession();
  if (!session) return back("error=unauthenticated");
  const ctx = ctxFromSession(getDb(), session.info);
  if (!ctx) return back("error=forbidden");
  try {
    await completeMetaConnect(ctx, {
      state: p.get("state"),
      stateCookie: req.cookies.get(OAUTH_STATE_COOKIE)?.value ?? null,
      code: p.get("code"),
      error: p.get("error"),
      errorReason: p.get("error_reason"),
    });
    return back("connected=1");
  } catch (e) {
    const code = isAppError(e) ? e.code : "internal_error";
    if (!isAppError(e)) logger.error("instagram callback failed", { err: e });
    return back(`error=${code}`);
  }
}
