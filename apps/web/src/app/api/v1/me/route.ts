import { route } from "@/server/api";

export const GET = route({}, async ({ session, ctx }) => ({
  user: { id: session.user.id, email: session.user.email, displayName: session.user.displayName },
  authMode: session.mode,
  organizationId: ctx.organizationId,
  role: ctx.actor.type === "user" ? ctx.actor.role : null,
  organizations: session.info.organizations,
}));
