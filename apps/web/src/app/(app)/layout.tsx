import { and, eq, sql } from "drizzle-orm";
import { approvalRequests, organizations } from "@dfos/db";
import { AppShell } from "@/components/app-shell";
import { t } from "@/i18n/ar";
import { requirePageCtx } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { ctx, session } = await requirePageCtx();
  const [[org], [pending]] = await Promise.all([
    ctx.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, ctx.organizationId)),
    ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(approvalRequests)
      .where(and(eq(approvalRequests.organizationId, ctx.organizationId), eq(approvalRequests.status, "pending"))),
  ]);
  const role = session.info.role ?? "viewer";
  return (
    <AppShell
      orgName={org?.name ?? ""}
      userName={session.user.displayName}
      role={t.role[role]}
      pendingApprovals={pending?.n ?? 0}
      devMode={session.mode === "dev"}
    >
      {children}
    </AppShell>
  );
}
