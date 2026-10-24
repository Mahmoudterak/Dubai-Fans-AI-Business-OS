import { createHmac, timingSafeEqual } from "node:crypto";
import { getEnv, isClerkConfigured, isDevAuthAllowed } from "@dfos/config";
import type { Database } from "@dfos/db";
import type { Role } from "@dfos/domain";
import { getMembership, listUserOrganizations, upsertUser, type Ctx } from "@dfos/orchestrator";

export const DEV_SESSION_COOKIE = "dfos_dev_session";
export const ORG_COOKIE = "dfos_org";
const DEV_SESSION_TTL_SECONDS = 60 * 60 * 12;

export type AuthMode = "clerk" | "dev" | "none";

export function getAuthMode(): AuthMode {
  if (isClerkConfigured()) return "clerk";
  if (isDevAuthAllowed()) return "dev";
  return "none";
}

function secret(): string {
  const env = getEnv();
  if (env.AUTH_SECRET && env.AUTH_SECRET.length >= 32) return env.AUTH_SECRET;
  if (env.NODE_ENV === "production") throw new Error("AUTH_SECRET (32+ chars) is required in production");
  return "dfos-insecure-development-secret-do-not-use-in-production";
}

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const sign = (payload: string) => createHmac("sha256", secret()).update(payload).digest("base64url");

/** DEV ONLY: a signed, expiring cookie value naming the dev user. */
export function createDevSessionToken(userId: string, now = Date.now()) {
  if (!isDevAuthAllowed()) throw new Error("Dev auth is disabled");
  const payload = b64(JSON.stringify({ sub: userId, exp: Math.floor(now / 1000) + DEV_SESSION_TTL_SECONDS }));
  return `${payload}.${sign(payload)}`;
}

export function verifyDevSessionToken(token: string | undefined, now = Date.now()): string | null {
  if (!token || !isDevAuthAllowed()) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as { sub?: string; exp?: number };
    if (!data.sub || !data.exp || data.exp * 1000 < now) return null;
    return data.sub;
  } catch {
    return null;
  }
}

export interface ClerkIdentity {
  subject: string;
  email: string;
  displayName: string;
}

/** Maps a Clerk identity to our users table (created on first sign-in). */
export async function userFromClerk(db: Database, identity: ClerkIdentity) {
  return upsertUser(db, {
    authProvider: "clerk",
    authSubject: identity.subject,
    email: identity.email,
    displayName: identity.displayName,
  });
}

export interface SessionInfo {
  userId: string;
  organizationId: string | null;
  role: Role | null;
  organizations: Array<{ id: string; name: string; role: Role }>;
}

/**
 * Resolves which organization the user is acting in. The org cookie is only a hint:
 * membership is always re-checked against the database.
 */
export async function resolveOrganization(db: Database, userId: string, orgHint: string | undefined): Promise<SessionInfo> {
  const orgs = await listUserOrganizations(db, userId);
  const list = orgs.map((o) => ({ id: o.organization.id, name: o.organization.name, role: o.role }));
  const chosen = (orgHint && list.find((o) => o.id === orgHint)) || list[0];
  if (!chosen) return { userId, organizationId: null, role: null, organizations: list };
  const membership = await getMembership(db, userId, chosen.id);
  if (!membership) return { userId, organizationId: null, role: null, organizations: list };
  return { userId, organizationId: chosen.id, role: membership.role, organizations: list };
}

export function ctxFromSession(db: Database, s: SessionInfo, requestId?: string): Ctx | null {
  if (!s.organizationId || !s.role) return null;
  return { db, organizationId: s.organizationId, actor: { type: "user", userId: s.userId, role: s.role }, requestId };
}
