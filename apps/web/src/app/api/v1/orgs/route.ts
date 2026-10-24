import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { ORG_COOKIE } from "@dfos/auth";
import { getDb } from "@dfos/db";
import { bootstrapOrganization } from "@dfos/orchestrator";
import { getSession } from "@/server/session";
import { crossOriginBlocked, isSameOrigin } from "@/server/api";

const body = z.object({ name: z.string().trim().min(2).max(120) });

/** Onboarding: a signed-in user with no organization creates one and becomes its owner. */
export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return crossOriginBlocked();
  const session = await getSession();
  if (!session) return NextResponse.json({ error: { code: "unauthenticated", message: "Sign in required" } }, { status: 401 });
  const parsed = body.safeParse(Object.fromEntries(await req.formData()));
  if (!parsed.success) return NextResponse.redirect(new URL("/onboarding?error=1", req.url), 303);
  const slug = `${parsed.data.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "org"}-${crypto.randomUUID().slice(0, 8)}`;
  const org = await bootstrapOrganization(getDb(), { name: parsed.data.name, slug, ownerUserId: session.user.id });
  const res = NextResponse.redirect(new URL("/", req.url), 303);
  res.cookies.set(ORG_COOKIE, org.id, { httpOnly: true, sameSite: "lax", path: "/", secure: req.nextUrl.protocol === "https:" });
  return res;
}
