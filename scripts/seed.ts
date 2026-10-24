/**
 * Development seed. Creates one organization and three dev-login users.
 * - Refuses to run in production.
 * - Idempotent: running it again changes nothing.
 * - Creates NO business data (tasks, content, metrics). Everything you see in the
 *   app afterwards is something you created.
 */
import { eq } from "drizzle-orm";
import { closeDb, getDb, organizationMembers, organizations } from "@dfos/db";
import { loadDotEnv } from "@dfos/db/load-env";
import { bootstrapOrganization, ensureOrgDefaults, upsertUser } from "@dfos/orchestrator";

loadDotEnv();
if (process.env.NODE_ENV === "production") {
  console.error("Refusing to seed a production database.");
  process.exit(1);
}

const db = getDb();
const SLUG = "dubai-fans-dev";

const owner = await upsertUser(db, { authProvider: "dev", authSubject: "dev-owner", email: "owner@dev.local", displayName: "المالك (تطوير)" });
const approver = await upsertUser(db, { authProvider: "dev", authSubject: "dev-approver", email: "approver@dev.local", displayName: "المعتمد (تطوير)" });
const member = await upsertUser(db, { authProvider: "dev", authSubject: "dev-member", email: "member@dev.local", displayName: "عضو الفريق (تطوير)" });

let [org] = await db.select().from(organizations).where(eq(organizations.slug, SLUG));
if (!org) {
  org = await bootstrapOrganization(db, { name: "Dubai Fans — بيئة التطوير", slug: SLUG, ownerUserId: owner.id });
  console.log("Created development organization.");
} else {
  await ensureOrgDefaults(db, org.id);
  console.log("Development organization already exists.");
}
for (const [u, role] of [[approver, "approver"], [member, "member"]] as const) {
  await db.insert(organizationMembers).values({ organizationId: org.id, userId: u.id, role }).onConflictDoNothing();
}
console.log("Dev users: owner, approver, member (sign in from /sign-in in development).");
await closeDb();
