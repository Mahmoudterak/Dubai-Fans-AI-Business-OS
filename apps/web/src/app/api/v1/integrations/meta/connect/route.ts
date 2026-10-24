import { NextResponse, type NextRequest } from "next/server";
import { ctxFromSession } from "@dfos/auth";
import { getDb } from "@dfos/db";
import { isAppError } from "@dfos/domain";
import { startMetaConnect } from "@dfos/orchestrator";
import { crossOriginBlocked, isSameOrigin } from "@/server/api";
import { OAUTH_COOKIE_MAX_AGE, OAUTH_COOKIE_PATH, OAUTH_STATE_COOKIE } from "@/server/oauth";
import { checkRateLimit } from "@/server/rate-limit";
import { getSession } from "@/server/session";

/**
 * Form POST from the Integrations page. Creates a single-use state, stores the raw value
 * in an httpOnly cookie for this browser, and redirects to Instagram's consent screen.
 */
export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return crossOriginBlocked();
  const session = await getSession();
  if (!session) return NextResponse.redirect(new URL("/sign-in", req.url), 303);
  const ctx = ctxFromSession(getDb(), session.info);
  if (!ctx) return NextResponse.redirect(new URL("/onboarding", req.url), 303);
  if (!checkRateLimit(`${session.user.id}:meta-connect`, 10, 60_000).allowed) {
    return NextResponse.redirect(new URL("/integrations?error=rate_limited", req.url), 303);
  }
  try {
    const { state, authorizeUrl } = await startMetaConnect(ctx);
    const res = NextResponse.redirect(authorizeUrl, 303);
    res.cookies.set(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: "lax",
      secure: req.nextUrl.protocol === "https:",
      path: OAUTH_COOKIE_PATH,
      maxAge: OAUTH_COOKIE_MAX_AGE,
    });
    return res;
  } catch (e) {
    const code = isAppError(e) ? e.code : "internal_error";
    return NextResponse.redirect(new URL(`/integrations?error=${code}`, req.url), 303);
  }
}
