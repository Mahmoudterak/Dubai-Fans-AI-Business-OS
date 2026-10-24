import Link from "next/link";
import { notFound } from "next/navigation";
import { getAiConfigStatus } from "@dfos/config";
import { can, isAppError } from "@dfos/domain";
import { getContent, getOrganization } from "@dfos/orchestrator";
import { ActionButton } from "@/components/action-button";
import { GenerateForm, ScheduleForm, VersionEditor } from "@/components/content-forms";
import { Badge, Card, CardTitle, KeyValue, Notice, PageHeader } from "@/components/ui";
import { ApprovalStatus, ContentStatus, formatDate } from "@/components/status";
import { t } from "@/i18n/ar";
import { requirePageCtx } from "@/server/session";

export const metadata = { title: "تحرير المحتوى" };

export default async function ContentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx } = await requirePageCtx();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  let data;
  try {
    data = await getContent(ctx, id);
  } catch (e) {
    if (isAppError(e) && e.code === "not_found") notFound();
    throw e;
  }
  const org = await getOrganization(ctx);
  const { item, versions, approvals, publishing } = data;
  const current = versions.find((v) => v.id === item.currentVersionId);
  const role = ctx.actor.type === "user" ? ctx.actor.role : "viewer";
  const canWrite = can(role, "content.write");
  const canPublish = can(role, "content.publish");
  const openApproval = approvals.find((a) => a.status === "pending" || a.status === "approved");
  const locked = ["in_review", "approved", "scheduled"].includes(item.status);
  const finished = item.status === "published" || item.status === "publishing";

  return (
    <>
      <PageHeader
        title={item.title}
        description={`${t.platform[item.platform]} · ${t.format[item.format]}`}
        actions={
          <>
            <ContentStatus s={item.status} />
            {canWrite && ["draft", "changes_requested", "rejected", "failed"].includes(item.status) && !openApproval && (
              <ActionButton path={`/content/${item.id}/submit`} variant="gold">إرسال للموافقة</ActionButton>
            )}
            {canPublish && (item.status === "approved" || item.status === "scheduled") && (
              <ActionButton path={`/content/${item.id}/publish`} confirm="نشر هذا المحتوى الآن؟ لا يمكن التراجع.">نشر الآن</ActionButton>
            )}
          </>
        }
      />

      {!publishing.connected && (
        <div className="mb-4">
          <Notice tone="blue">
            لا يوجد حساب {t.platform[item.platform]} متصل، لذلك لن يتم النشر الفعلي حتى إن اعتُمد المحتوى. ربط Instagram مخطط في المرحلة 6 (
            <Link href="/integrations" className="underline">التكاملات</Link>).
          </Notice>
        </div>
      )}
      {item.lastError && (
        <div className="mb-4"><Notice tone="red">آخر خطأ: {item.lastError.message}</Notice></div>
      )}
      {openApproval && (
        <div className="mb-4">
          <Notice>
            يوجد طلب موافقة <ApprovalStatus s={openApproval.status} /> لهذا المحتوى.{" "}
            <Link className="underline" href={`/approvals/${openApproval.id}`}>عرضه</Link>
          </Notice>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardTitle action={current && <Badge tone={current.source === "ai" ? "purple" : "neutral"}>v{current.versionNumber} · {current.source === "ai" ? "ذكاء اصطناعي" : "يدوي"}</Badge>}>
            النص الحالي
          </CardTitle>
          {current && canWrite && !finished ? (
            <VersionEditor key={current.id} contentId={item.id} initial={{ body: current.body, hashtags: current.hashtags, cta: current.cta }} locked={locked} />
          ) : (
            <div className="whitespace-pre-wrap leading-8">{current?.body}</div>
          )}
        </Card>
        <div className="flex flex-col gap-4">
          <Card>
            <CardTitle>البيانات</CardTitle>
            <KeyValue
              items={[
                ["الجمهور", item.audience ?? "—"],
                ["الهدف", item.goal ?? "—"],
                ["النبرة", item.tone ?? "—"],
                ["موعد النشر", formatDate(item.scheduledAt, org.timezone)],
                ["نُشر", formatDate(item.publishedAt, org.timezone)],
              ]}
            />
          </Card>
          {canWrite && !finished && (
            <Card>
              <CardTitle>وكيل التسويق</CardTitle>
              <GenerateForm contentId={item.id} aiConfigured={getAiConfigStatus().configured} />
            </Card>
          )}
          {canWrite && !finished && (
            <Card>
              <CardTitle>الجدولة</CardTitle>
              <ScheduleForm contentId={item.id} current={item.scheduledAt ? item.scheduledAt.toISOString() : null} timezone={org.timezone} />
            </Card>
          )}
        </div>
      </div>

      <h2 className="mb-3 mt-8 text-lg font-semibold">الإصدارات</h2>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {versions.map((v) => (
          <Card key={v.id} className={v.id === item.currentVersionId ? "border-accent-500/50" : undefined}>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Badge tone={v.id === item.currentVersionId ? "blue" : "neutral"}>v{v.versionNumber}{v.id === item.currentVersionId ? " · الحالي" : ""}</Badge>
              <Badge tone={v.source === "ai" ? "purple" : "neutral"}>{v.source === "ai" ? "ذكاء اصطناعي" : "يدوي"}</Badge>
              <span className="text-xs text-ink-400">{formatDate(v.createdAt, org.timezone)}</span>
            </div>
            <p className="line-clamp-4 whitespace-pre-wrap text-sm text-ink-300">{v.body}</p>
            {v.hashtags.length > 0 && <p className="mt-1 text-xs text-accent-400">{v.hashtags.join(" ")}</p>}
            {canWrite && !finished && v.id !== item.currentVersionId && (
              <div className="mt-3">
                <ActionButton path={`/content/${item.id}/versions/${v.id}/select`} variant="ghost" confirm={locked ? "اختيار إصدار آخر يُبطل الموافقة الحالية. متابعة؟" : undefined}>
                  اجعله الإصدار الحالي
                </ActionButton>
              </div>
            )}
          </Card>
        ))}
      </div>

      {approvals.length > 0 && (
        <>
          <h2 className="mb-3 mt-8 text-lg font-semibold">سجل الموافقات</h2>
          <ul className="flex flex-col gap-2 text-sm">
            {approvals.map((a) => (
              <li key={a.id} className="flex items-center gap-3 rounded-xl bg-ink-850 px-4 py-2">
                <ApprovalStatus s={a.status} />
                <Link className="hover:text-accent-400" href={`/approvals/${a.id}`}>{a.summary ?? a.title}</Link>
                <span className="ms-auto text-xs text-ink-400">{formatDate(a.createdAt, org.timezone)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
