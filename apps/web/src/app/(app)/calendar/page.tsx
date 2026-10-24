import Link from "next/link";
import { and, eq, gte, lt, or } from "drizzle-orm";
import { contentItems } from "@dfos/db";
import { getOrganization } from "@dfos/orchestrator";
import { requirePermission } from "@dfos/orchestrator";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { ContentStatus } from "@/components/status";
import { t } from "@/i18n/ar";
import { requirePageCtx } from "@/server/session";

export const metadata = { title: "تقويم النشر" };

export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const { ctx } = await requirePageCtx();
  requirePermission(ctx, "content.read");
  const org = await getOrganization(ctx);
  const tz = org.timezone;
  const { month } = await searchParams;
  const now = new Date();
  const [y, m] = /^\d{4}-\d{2}$/.test(month ?? "") ? month!.split("-").map(Number) : [now.getUTCFullYear(), now.getUTCMonth() + 1];
  // A few hours of margin on each side so items near midnight in the org zone are included.
  const start = new Date(Date.UTC(y!, m! - 1, 1) - 14 * 3600_000);
  const end = new Date(Date.UTC(y!, m!, 1) + 14 * 3600_000);

  const items = await ctx.db
    .select()
    .from(contentItems)
    .where(
      and(
        eq(contentItems.organizationId, ctx.organizationId),
        or(and(gte(contentItems.scheduledAt, start), lt(contentItems.scheduledAt, end)), and(gte(contentItems.publishedAt, start), lt(contentItems.publishedAt, end))),
      ),
    );

  const dayKey = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const monthPrefix = `${y}-${String(m).padStart(2, "0")}`;
  const byDay = new Map<string, typeof items>();
  for (const it of items) {
    const when = it.publishedAt ?? it.scheduledAt;
    if (!when) continue;
    const k = dayKey(when);
    if (!k.startsWith(monthPrefix)) continue;
    byDay.set(k, [...(byDay.get(k) ?? []), it]);
  }
  const days = [...byDay.keys()].sort();
  const prev = new Date(Date.UTC(y!, m! - 2, 1));
  const next = new Date(Date.UTC(y!, m!, 1));
  const fmtMonth = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const time = (d: Date) => new Intl.DateTimeFormat("ar-AE", { timeStyle: "short", timeZone: tz }).format(d);

  return (
    <>
      <PageHeader
        title={t.nav.calendar}
        description={`${t.common.timezoneNote} ${tz}.`}
        actions={
          <div className="flex items-center gap-3 text-sm">
            <Link href={`/calendar?month=${fmtMonth(prev)}`} className="text-ink-400 hover:text-ink-100">→ السابق</Link>
            <span className="ltr font-semibold">{monthPrefix}</span>
            <Link href={`/calendar?month=${fmtMonth(next)}`} className="text-ink-400 hover:text-ink-100">التالي ←</Link>
          </div>
        }
      />
      {days.length === 0 ? (
        <EmptyState title="لا يوجد محتوى مجدول أو منشور في هذا الشهر" description="حدّد موعد نشر من صفحة المحتوى ليظهر هنا." />
      ) : (
        <div className="flex flex-col gap-3">
          {days.map((d) => (
            <Card key={d}>
              <h2 className="ltr mb-3 text-end font-semibold text-gold-400">{d}</h2>
              <ul className="flex flex-col gap-2">
                {byDay.get(d)!.map((it) => (
                  <li key={it.id} className="flex flex-wrap items-center gap-3 text-sm">
                    <span className="ltr w-16 text-ink-400">{time((it.publishedAt ?? it.scheduledAt)!)}</span>
                    <Link href={`/content/${it.id}`} className="font-medium hover:text-accent-400">{it.title}</Link>
                    <span className="text-xs text-ink-400">{t.platform[it.platform]}</span>
                    <ContentStatus s={it.status} />
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
