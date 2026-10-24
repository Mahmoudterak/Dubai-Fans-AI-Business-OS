import type { Database } from "@dfos/db";
import { AppError, assertCan, type Permission, type Role } from "@dfos/domain";

export type Actor =
  | { type: "user"; userId: string; role: Role }
  | { type: "agent"; agentKey: string }
  | { type: "system"; name: string };

/** Every service call carries the org it is scoped to. Queries must always filter by it. */
export interface Ctx {
  db: Database;
  organizationId: string;
  actor: Actor;
  requestId?: string;
}

export function actorId(actor: Actor): string {
  switch (actor.type) {
    case "user":
      return actor.userId;
    case "agent":
      return `agent:${actor.agentKey}`;
    case "system":
      return `system:${actor.name}`;
  }
}

/**
 * Users are checked against their role. Agents and system actors can only reach
 * services through server-side code paths, never through the public API,
 * and they can never hold approval rights.
 */
export function requirePermission(ctx: Ctx, permission: Permission) {
  if (ctx.actor.type === "user") return assertCan(ctx.actor.role, permission);
  if (permission === "approvals.decide") {
    throw new AppError("forbidden", "Only a human can decide on approvals");
  }
}

export function requireUser(ctx: Ctx): Extract<Actor, { type: "user" }> {
  if (ctx.actor.type !== "user") throw new AppError("forbidden", "A signed-in user is required");
  return ctx.actor;
}

/** postgres-js returns an array, PGlite returns { rows }. */
export function rowsOf<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  const rows = (res as { rows?: unknown[] } | null)?.rows;
  return (rows ?? []) as T[];
}
