import Link from "next/link";
import { PenSquare } from "lucide-react";
import { listContentQuery } from "@dfos/contracts";
import { can, CONTENT_STATUSES } from "@dfos/domain";
import { listContent } from "@dfos/orchestrator";
import { NewContentForm } from "@/components/content-forms";
import { EmptyState, LinkButton, PageHeader, Table, Td, buttonClass } from "@/components/ui";
import { ContentStatus, formatDate } from "@/components/status";
import { t } from "@/i18n/ar";
import { requirePageCtx } from "@/server/session";

export const metadata = { title: "استوديو المحتوى" };

export default async function ContentPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { ctx } = await requirePageCtx();
  const sp = await searchParams;
  const q = listContentQuery.safeParse(sp);
  const rows = await listContent(ctx, q.success ? q.data : { limit: 25, offset: 0 });
  const role = ctx.actor.type === "user" ? ctx.actor.role : "viewer";
  const canWrite = can(role, "content.write");

  return (
    <>
      <PageHeader
        title={t.nav.content}
        description="اكتب المحتوى أو اطلب من وكيل التسويق نسخًا، احفظ الإصدارات، ثم أرسله للموافقة قبل الجدولة والنشر."
        actions={canWrite && !sp.new ? <LinkButton href="/content?new=1" variant="gold">محتوى جديد</LinkButton> : undefined}
      />
      {sp.new && canWrite && <NewContentForm />}
      <form className="mb-4 flex flex-wrap gap-2" action="/content">
        <select name="status" defaultValue={sp.status ?? ""} className="rounded-xl border border-ink-700 bg-ink-900 px-3 py-2 text-sm">
          <option value="">كل الحالات</option>
          {CONTENT_STATUSES.map((s) => <option key={s} value={s}>{t.contentStatus[s]}</option>)}
        </select>
        <select name="platform" defaultValue={sp.platform ?? ""} className="rounded-xl border border-ink-700 bg-ink-900 px-3 py-2 text-sm">
          <option value="">كل المنصات</option>
          {Object.entries(t.platform).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <button className={buttonClass("ghost")} type="submit">تصفية</button>
      </form>
      {rows.length === 0 ? (
        <EmptyState icon={<PenSquare className="size-8" />} title="لا يوجد محتوى" action={canWrite ? <LinkButton href="/content?new=1">إنشاء محتوى</LinkButton> : undefined} />
      ) : (
        <Table head={["العنوان", "المنصة", "الحالة", "الإصدار الحالي", "موعد النشر", "آخر تعديل"]}>
          {rows.map(({ item, version }) => (
            <tr key={item.id} className="hover:bg-ink-800/60">
              <Td>
                <Link href={`/content/${item.id}`} className="font-medium hover:text-accent-400">{item.title}</Link>
                {version && <span className="block max-w-md truncate text-xs text-ink-400">{version.body}</span>}
              </Td>
              <Td>{t.platform[item.platform]} · {t.format[item.format]}</Td>
              <Td><ContentStatus s={item.status} /></Td>
              <Td><span className="ltr">v{version?.versionNumber ?? "—"}</span> {version?.source === "ai" && <span className="text-xs text-violet-300">AI</span>}</Td>
              <Td className="text-xs">{formatDate(item.scheduledAt)}</Td>
              <Td className="text-xs text-ink-400">{formatDate(item.updatedAt)}</Td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}
