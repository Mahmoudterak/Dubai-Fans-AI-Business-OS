import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import {
  ctxFromSession,
  DEV_SESSION_COOKIE,
  getAuthMode,
  ORG_COOKIE,
  resolveOrganization,
  userFromClerk,
  verifyDevSessionToken,
  type SessionInfo,
} from "@dfos/auth";
import { getDb, users } from "@dfos/db";
import type { Ctx } from "@dfos/orchestrator";

export interface Session {
  mode: "clerk" | "dev";
  user: typeof users.$inferSelect;
  info: SessionInfo;
}

async function currentUser(): Promise<Session["user"] | null> {
  const mode = getAuthMode();
  const db = getDb();
  if (mode === "clerk") {
    const { auth, currentUser: clerkUser } = await import("@clerk/nextjs/server");
    const { userId } = await auth();
    if (!userId) return null;
    const cu = await clerkUser();
    if (!cu) return null;
    const email = cu.primaryEmailAddress?.emailAddress ?? cu.emailAddresses[0]?.emailAddress ?? "";
    return userFromClerk(db, {
      subject: userId,
      email,
      displayName: [cu.firstName, cu.lastName].filter(Boolean).join(" ") || email || "User",
    });
  }
  if (mode === "dev") {
    const jar = await cookies();
    const userId = verifyDevSessionToken(jar.get(DEV_SESSION_COOKIE)?.value);
    if (!userId) return null;
    const [u] = await db.select().from(users).where(and(eq(users.id, userId), eq(users.authProvider, "dev")));
    return u ?? null;
  }
  return null;
}

export async function getSession(): Promise<Session | null> {
  const mode = getAuthMode();
  if (mode === "none") return null;
  const user = await currentUser();
  if (!user) return null;
  const jar = await cookies();
  const info = await resolveOrganization(getDb(), user.id, jar.get(ORG_COOKIE)?.value);
  return { mode, user, info };
}

/** For server components: returns a scoped context or redirects to sign-in / onboarding. */
export async function requirePageCtx(): Promise<{ ctx: Ctx; session: Session }> {
  const session = await getSession();
  if (!session) redirect("/sign-in");
  const ctx = ctxFromSession(getDb(), session.info);
  if (!ctx) redirect("/onboarding");
  return { ctx, session };
}
