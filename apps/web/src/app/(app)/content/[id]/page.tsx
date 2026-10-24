import Link from "next/link";
import { notFound } from "next/navigation";
import { getAiConfigStatus } from "@dfos/config";
import { can, isAppError } from "@dfos/domain";
import { isStorageAvailable } from "@dfos/integrations";
import { getContent, getMediaPreviewUrl, getOrganization } from "@dfos/orchestrator";
import { ActionButton } from "@/components/action-button";
import { AutoRefresh } from "@/components/auto-refresh";
import { MediaPicker } from "@/components/media-picker";
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
  const { item, versions, approvals, publishing, publications } = data;
  const current = versions.find((v) => v.id === item.currentVersionId);
  const activePublication = publications.find((p) => ["queued", "container_processing", "ready_to_publish", "publish_requested"].includes(p.status));
  const storageReady = isStorageAvailable();
  let imageUrl: string | null = null;
  if (current?.mediaAssetId && storageReady) {
    try {
      imageUrl = (await getMediaPreviewUrl(ctx, current.mediaAssetId)).url;
    } catch {
      imageUrl = null;
    }
  }
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
            {canPublish && ["approved", "scheduled", "failed"].includes(item.status) && openApproval?.status === "approved" && !activePublication && (
              <ActionButton path={`/content/${item.id}/publish`} confirm="نشر هذا المحتوى الآن على Instagram؟ لا يمكن التراجع.">نشر الآن</ActionButton>
            )}
          </>
        }
      />

      {!publishing.available ? (
        <div className="mb-4"><Notice tone="blue">النشر إلى {t.platform[item.platform]} غير مدعوم بعد. المدعوم حاليًا: منشورات Instagram بصورة واحدة.</Notice></div>
      ) : !publishing.connected ? (
        <div className="mb-4">
          <Notice tone="blue">
            لا يوجد حساب Instagram متصل ومفعّل، لذلك لن يُنشر شيء حتى إن اعتُمد المحتوى. <Link href="/integrations" className="underline">التكاملات</Link>
          </Notice>
        </div>
      ) : !publishing.canPublish ? (
        <div className="mb-4"><Notice>الحساب @{publishing.account?.username} متصل لكنه لم يمنح صلاحية النشر.</Notice></div>
      ) : null}
      {item.lastError && (
        <div className="mb-4"><Notice tone="red">آخر خطأ: {t.errors[item.lastError.code] ?? item.lastError.message}</Notice></div>
      )}
      <AutoRefresh active={Boolean(activePublication)} intervalMs={5000} />
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
            <CardTitle>الصورة</CardTitle>
            {imageUrl ? (
              <img src={imageUrl} alt="" className="mb-3 max-h-72 w-full rounded-xl object-contain" />
            ) : current?.mediaAssetId ? (
              <p className="mb-3 text-sm text-ink-400">الصورة مرفقة (المعاينة غير متاحة).</p>
            ) : (
              <p className="mb-3 text-sm text-ink-400">لا توجد صورة. منشورات Instagram تحتاج صورة JPEG.</p>
            )}
            {canWrite && !finished && !activePublication && (
              <MediaPicker contentId={item.id} hasImage={Boolean(current?.mediaAssetId)} storageReady={storageReady} locked={locked} />
            )}
          </Card>
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

      {publications.length > 0 && (
        <>
          <h2 className="mb-3 mt-8 text-lg font-semibold">عمليات النشر</h2>
          <ul className="flex flex-col gap-2 text-sm">
            {publications.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 rounded-xl bg-ink-850 px-4 py-3">
                <Badge tone={p.status === "published" ? "green" : p.status === "failed" || p.status === "needs_review" ? "red" : "blue"}>
                  {t.publicationStatus[p.status] ?? p.status}
                </Badge>
                {p.permalink && (
                  <a href={p.permalink} target="_blank" rel="noopener noreferrer" className="ltr text-accent-400 underline">
                    عرض على Instagram
                  </a>
                )}
                {p.lastError && <span className="text-xs text-ink-400">{p.lastError.message}</span>}
                <span className="ms-auto text-xs text-ink-400">{formatDate(p.publishedAt ?? p.createdAt, org.timezone)}</span>
              </li>
            ))}
          </ul>
        </>
      )}

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
            {v.mediaAssetId && <p className="mt-1 text-xs text-ink-400">🖼 مع صورة</p>}
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
