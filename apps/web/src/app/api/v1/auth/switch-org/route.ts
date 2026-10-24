import { NextResponse, type NextRequest } from "next/server";
import { ORG_COOKIE } from "@dfos/auth";
import { getDb } from "@dfos/db";
import { getMembership } from "@dfos/orchestrator";
import { getSession } from "@/server/session";
import { crossOriginBlocked, isSameOrigin } from "@/server/api";

/** Switches the active organization after checking membership on the server. */
export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return crossOriginBlocked();
  const session = await getSession();
  if (!session) return NextResponse.redirect(new URL("/sign-in", req.url), 303);
  const form = await req.formData();
  const orgId = String(form.get("organizationId") ?? "");
  const member = /^[0-9a-f-]{36}$/.test(orgId) ? await getMembership(getDb(), session.user.id, orgId) : undefined;
  const res = NextResponse.redirect(new URL("/", req.url), 303);
  if (member) res.cookies.set(ORG_COOKIE, orgId, { httpOnly: true, sameSite: "lax", path: "/", secure: req.nextUrl.protocol === "https:" });
  return res;
}
