import { NextResponse, type NextRequest } from "next/server";
import { DEV_SESSION_COOKIE, getAuthMode, ORG_COOKIE } from "@dfos/auth";
import { crossOriginBlocked, isSameOrigin } from "@/server/api";

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return crossOriginBlocked();
  // With Clerk, sign-out happens through Clerk's own UI/session; here we just clear our cookies.
  const target = getAuthMode() === "clerk" ? "/sign-in?signout=1" : "/sign-in";
  const res = NextResponse.redirect(new URL(target, req.url), 303);
  res.cookies.delete(DEV_SESSION_COOKIE);
  res.cookies.delete(ORG_COOKIE);
  return res;
}
