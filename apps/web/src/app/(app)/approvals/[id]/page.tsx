import Link from "next/link";
import { notFound } from "next/navigation";
import { can, isAppError } from "@dfos/domain";
import { isStorageAvailable } from "@dfos/integrations";
import { CONTENT_PUBLISH_ACTION, getApproval, getMediaPreviewUrl } from "@dfos/orchestrator";
import { DecisionForm } from "@/components/decision-form";
import { Badge, Card, CardTitle, KeyValue, Notice, PageHeader, Pre } from "@/components/ui";
import { ApprovalStatus, formatDate, RiskBadge } from "@/components/status";
import { t } from "@/i18n/ar";
import { requirePageCtx } from "@/server/session";

export const metadata = { title: "طلب موافقة" };

interface PlanPayload {
  summary: string;
  subtasks: Array<{ title: string; type: string; agent: string; rationale: string; input: Record<string, unknown>; dependsOnIndex: number[] }>;
}

function Preview({ actionType, payload, imageUrl }: { actionType: string; payload: Record<string, unknown>; imageUrl: string | null }) {
  if (actionType === CONTENT_PUBLISH_ACTION) {
    const p = payload as { body: string; hashtags: string[]; cta: string | null; platform: string; format: string; audience: string | null; scheduledAt: string | null; versionNumber: number; media?: { id: string } | null };
    return (
      <div className="flex flex-col gap-4">
        {imageUrl ? (
          <img src={imageUrl} alt="" className="max-h-80 w-full rounded-xl object-contain" />
        ) : p.media ? (
          <p className="text-sm text-ink-400">صورة مرفقة (المعاينة غير متاحة)</p>
        ) : (
          <p className="text-sm text-amber-300">بلا صورة: النشر على Instagram سيرفض حتى تُرفق صورة.</p>
        )}
        <KeyValue
          items={[
            ["المنصة", t.platform[p.platform as keyof typeof t.platform] ?? p.platform],
            ["النوع", t.format[p.format as keyof typeof t.format] ?? p.format],
            ["الجمهور", p.audience ?? "—"],
            ["موعد النشر", p.scheduledAt ? formatDate(p.scheduledAt) : "فور الاعتماد (يدويًا)"],
            ["رقم الإصدار", <span key="v" className="ltr">{p.versionNumber}</span>],
          ]}
        />
        <div className="whitespace-pre-wrap rounded-xl border border-ink-700 bg-ink-900 p-4 leading-8">{p.body}</div>
        {p.hashtags.length > 0 && <p className="text-sm text-accent-400">{p.hashtags.join(" ")}</p>}
        {p.cta && <p className="text-sm"><span className="text-ink-400">الدعوة لاتخاذ إجراء: </span>{p.cta}</p>}
      </div>
    );
  }
  if (actionType === "tasks.create_subtasks") {
    const p = payload as unknown as PlanPayload;
    return (
      <div className="flex flex-col gap-3">
        <p className="text-ink-300">{p.summary}</p>
        <ol className="flex flex-col gap-2">
          {p.subtasks.map((s, i) => (
            <li key={i} className="rounded-xl border border-ink-700 bg-ink-900 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="ltr text-ink-400">#{i + 1}</span>
                <span className="font-semibold">{s.title}</span>
                <Badge tone="blue"><span className="ltr">{s.agent}</span></Badge>
                <Badge>{t.taskTypes[s.type] ?? s.type}</Badge>
                {s.dependsOnIndex.length > 0 && <Badge tone="purple">بعد: {s.dependsOnIndex.map((d) => `#${d + 1}`).join("، ")}</Badge>}
              </div>
              {s.rationale && <p className="mt-1 text-ink-400">{s.rationale}</p>}
            </li>
          ))}
        </ol>
      </div>
    );
  }
  return <Pre value={payload} />;
}

export default async function ApprovalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx } = await requirePageCtx();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  let data;
  try {
    data = await getApproval(ctx, id);
  } catch (e) {
    if (isAppError(e) && e.code === "not_found") notFound();
    throw e;
  }
  const { approval, events, decidedBy, stale } = data;
  const mediaId = (approval.payload as { media?: { id?: string } | null }).media?.id;
  let imageUrl: string | null = null;
  if (mediaId && isStorageAvailable()) {
    try {
      imageUrl = (await getMediaPreviewUrl(ctx, mediaId)).url;
    } catch {
      imageUrl = null;
    }
  }
  const role = ctx.actor.type === "user" ? ctx.actor.role : "viewer";
  const canDecide = can(role, "approvals.decide") && approval.status === "pending";

  return (
    <>
      <PageHeader title={approval.title} description={approval.summary ?? undefined} actions={<ApprovalStatus s={approval.status} />} />
      {stale && approval.status === "pending" && (
        <div className="mb-4"><Notice tone="red">تغيّر المحتوى بعد إرساله للمراجعة. لا يمكن اعتماد هذا الطلب، ويجب إعادة الإرسال.</Notice></div>
      )}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardTitle>ما الذي سيُنفَّذ بالضبط</CardTitle>
          <Preview actionType={approval.actionType} payload={approval.payload} imageUrl={imageUrl} />
        </Card>
        <div className="flex flex-col gap-4">
          <Card>
            <CardTitle>التفاصيل</CardTitle>
            <KeyValue
              items={[
                ["الإجراء", <span key="a" className="ltr text-xs">{approval.actionType}</span>],
                ["الخطورة", <RiskBadge key="r" s={approval.riskLevel} />],
                ["طلبه", <span key="b" className="ltr text-xs">{approval.requestedById}</span>],
                ["التاريخ", formatDate(approval.createdAt)],
                ["البصمة", <span key="f" className="ltr break-all font-mono text-[10px] text-ink-400">{approval.fingerprint}</span>],
              ]}
            />
            {approval.taskId && <Link className="mt-4 block text-sm text-accent-400" href={`/tasks/${approval.taskId}`}>← المهمة المرتبطة</Link>}
            {approval.contentItemId && <Link className="mt-2 block text-sm text-accent-400" href={`/content/${approval.contentItemId}`}>← المحتوى المرتبط</Link>}
          </Card>
          {canDecide && !stale && (
            <Card>
              <CardTitle>القرار</CardTitle>
              <DecisionForm approvalId={approval.id} fingerprint={approval.fingerprint} />
            </Card>
          )}
          {decidedBy && (
            <Card>
              <CardTitle>القرار المسجَّل</CardTitle>
              <p className="text-sm">{decidedBy.displayName} · {formatDate(approval.decidedAt)}</p>
              {approval.decisionNote && <p className="mt-2 text-sm text-ink-300">{approval.decisionNote}</p>}
            </Card>
          )}
        </div>
      </div>
      <h2 className="mb-3 mt-8 text-lg font-semibold">سجل القرارات</h2>
      <ul className="flex flex-col gap-2 text-sm">
        {events.map((e) => (
          <li key={e.id} className="flex flex-wrap items-center gap-2 rounded-xl bg-ink-850 px-4 py-2">
            <ApprovalStatus s={e.type === "requested" ? "pending" : e.type} />
            <span className="ltr text-xs text-ink-400">{e.actorId}</span>
            <span className="text-xs text-ink-400">{formatDate(e.createdAt)}</span>
            {e.note && <span className="text-ink-300">— {e.note}</span>}
          </li>
        ))}
      </ul>
    </>
  );
}
