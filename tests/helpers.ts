import { createTestDb } from "@dfos/db/testing";
import type { Database } from "@dfos/db";
import type { Role } from "@dfos/domain";
import { bootstrapOrganization, upsertUser, type Ctx } from "@dfos/orchestrator";
import { organizationMembers } from "@dfos/db";

export async function freshDb() {
  return createTestDb();
}

let counter = 0;

/** Creates an org with one user per role and returns a Ctx for each. */
export async function setupOrg(db: Database, name = "Test Org") {
  counter++;
  const mk = (role: string) =>
    upsertUser(db, {
      authProvider: "dev",
      authSubject: `${role}-${counter}-${Math.random().toString(36).slice(2, 8)}`,
      email: `${role}${counter}@example.test`,
      displayName: `${role} ${counter}`,
    });
  const owner = await mk("owner");
  const org = await bootstrapOrganization(db, {
    name,
    slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${counter}-${Math.random().toString(36).slice(2, 6)}`,
    ownerUserId: owner.id,
  });
  const users: Record<Role, { id: string }> = { owner } as Record<Role, { id: string }>;
  for (const role of ["admin", "approver", "member", "viewer"] as const) {
    const u = await mk(role);
    await db.insert(organizationMembers).values({ organizationId: org.id, userId: u.id, role });
    users[role] = u;
  }
  const ctx = (role: Role): Ctx => ({
    db,
    organizationId: org.id,
    actor: { type: "user", userId: users[role].id, role },
  });
  return { org, users, ctx };
}
