import { NextResponse, type NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { createDevSessionToken, DEV_SESSION_COOKIE } from "@dfos/auth";
import { isDevAuthAllowed } from "@dfos/config";
import { getDb, users } from "@dfos/db";
import { crossOriginBlocked, isSameOrigin } from "@/server/api";

/**
 * DEVELOPMENT ONLY. Signs in as a seeded dev user (auth_provider = "dev").
 * Returns 404 in production or whenever Clerk is configured.
 */
export async function POST(req: NextRequest) {
  if (!isDevAuthAllowed()) return NextResponse.json({ error: { code: "not_found", message: "Not found" } }, { status: 404 });
  if (!isSameOrigin(req)) return crossOriginBlocked();
  const form = await req.formData();
  const userId = String(form.get("userId") ?? "");
  if (!/^[0-9a-f-]{36}$/.test(userId)) return NextResponse.redirect(new URL("/sign-in?error=1", req.url), 303);
  const [user] = await getDb().select().from(users).where(and(eq(users.id, userId), eq(users.authProvider, "dev")));
  if (!user) return NextResponse.redirect(new URL("/sign-in?error=1", req.url), 303);

  const res = NextResponse.redirect(new URL("/", req.url), 303);
  res.cookies.set(DEV_SESSION_COOKIE, createDevSessionToken(user.id), {
    httpOnly: true,
    sameSite: "lax",
    secure: req.nextUrl.protocol === "https:",
    path: "/",
    maxAge: 60 * 60 * 12,
  });
  return res;
}
