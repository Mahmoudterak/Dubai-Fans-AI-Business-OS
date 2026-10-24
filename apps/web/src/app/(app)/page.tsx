import Link from "next/link";
import { Activity, Bot, CheckCircle2, Cpu, Plug, ShieldCheck } from "lucide-react";
import { getDashboard } from "@dfos/orchestrator";
import { Badge, Card, CardTitle, EmptyState, LinkButton, Notice, PageHeader, Stat } from "@/components/ui";
import { formatDate, formatUsd } from "@/components/status";
import { t } from "@/i18n/ar";
import { requirePageCtx } from "@/server/session";

export const metadata = { title: "لوحة التحكم" };

export default async function DashboardPage() {
  const { ctx } = await requirePageCtx();
  const d = await getDashboard(ctx);
  const tz = d.organization?.timezone ?? "Asia/Dubai";
  const n = (s: string) => d.tasks.byStatus[s] ?? 0;
  const active = n("queued") + n("running") + n("retrying");
  const workerAge = d.worker.lastClaimAt ? Date.now() - new Date(d.worker.lastClaimAt).getTime() : null;

  return (
    <>
      <PageHeader
        title={d.organization?.name ?? t.nav.dashboard}
        description="كل الأرقام هنا من قاعدة البيانات مباشرة. لا توجد بيانات توضيحية."
        actions={<LinkButton href="/tasks?new=1" variant="gold">مهمة جديدة</LinkButton>}
      />

      {d.organization?.agentsPaused && (
        <div className="mb-4">
          <Notice tone="red">جميع الوكلاء متوقفون (مفتاح الإيقاف مفعّل). يمكن إعادة التشغيل من الإعدادات.</Notice>
        </div>
      )}
      {!d.ai.configured && (
        <div className="mb-4">
          <Notice>
            توليد المحتوى والتخطيط بالذكاء الاصطناعي غير متاح: {d.ai.reason}. بقية النظام يعمل. راجع docs/operations/deployment.md لإعداد المزود.
          </Notice>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="مهام جارية" value={active} hint={`${n("running")} قيد التنفيذ الآن`} />
        <Stat label="بانتظار الموافقة" value={d.approvals.pending} tone={d.approvals.pending ? "gold" : undefined} hint={<Link className="underline" href="/approvals">مركز الموافقات</Link>} />
        <Stat label="فشلت خلال 24 ساعة" value={d.tasks.failedLast24h} tone={d.tasks.failedLast24h ? "red" : undefined} />
        <Stat label="مكتملة (الإجمالي)" value={n("succeeded")} tone="green" />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card>
          <CardTitle icon={<Cpu className="size-4" />}>استخدام الذكاء الاصطناعي (30 يومًا)</CardTitle>
          {d.ai.configured ? (
            <p className="mb-3 text-sm text-ink-400">
              المزود مُعدّ: <span className="ltr">{d.ai.model}</span>
            </p>
          ) : (
            <Badge tone="amber">غير مُعدّ</Badge>
          )}
          <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
            <div><dt className="text-ink-400">الاستدعاءات</dt><dd className="ltr text-end text-lg font-semibold">{d.ai.last30d.calls}</dd></div>
            <div><dt className="text-ink-400">التكلفة المعروفة</dt><dd className="ltr text-end text-lg font-semibold">{formatUsd(d.ai.last30d.knownCostUsd)}</dd></div>
            <div><dt className="text-ink-400">رموز الإدخال</dt><dd className="ltr text-end">{d.ai.last30d.inputTokens.toLocaleString("en")}</dd></div>
            <div><dt className="text-ink-400">رموز الإخراج</dt><dd className="ltr text-end">{d.ai.last30d.outputTokens.toLocaleString("en")}</dd></div>
          </dl>
          {d.ai.last30d.unpricedCalls > 0 && (
            <p className="mt-3 text-xs text-amber-300">{d.ai.last30d.unpricedCalls} استدعاء دون سعر مُعدّ: تكلفتها غير محسوبة.</p>
          )}
        </Card>

        <Card>
          <CardTitle icon={<Activity className="size-4" />}>حالة النظام</CardTitle>
          <ul className="flex flex-col gap-3 text-sm">
            <li className="flex items-center justify-between">
              <span>قاعدة البيانات</span>
              <Badge tone="green">متصلة</Badge>
            </li>
            <li className="flex items-center justify-between gap-2">
              <span>العامل الخلفي</span>
              {workerAge === null ? (
                <Badge>لم يعمل بعد</Badge>
              ) : (
                <span className="text-xs text-ink-400">آخر مهمة استلمها: {formatDate(d.worker.lastClaimAt, tz)}</span>
              )}
            </li>
            <li className="flex items-center justify-between">
              <span>الوكلاء</span>
              {d.organization?.agentsPaused ? <Badge tone="red">متوقفون</Badge> : <Badge tone="green">مفعّلون</Badge>}
            </li>
          </ul>
          <p className="mt-4 text-xs text-ink-400">
            تُنفَّذ المهام في العامل الخلفي. إن بقيت المهام في الطابور، تأكد من تشغيله: <code className="ltr">pnpm dev:worker</code>
          </p>
        </Card>

        <Card>
          <CardTitle icon={<Plug className="size-4" />}>التكاملات</CardTitle>
          <ul className="flex flex-col gap-3 text-sm">
            {d.integrations.map((i) => (
              <li key={i.provider} className="flex items-center justify-between">
                <span>{i.name}</span>
                <Badge tone={i.connected ? "green" : "neutral"}>{i.connected ? "متصل" : "غير متصل"}</Badge>
              </li>
            ))}
          </ul>
          <LinkButton href="/integrations" variant="ghost" className="mt-4 w-full">التفاصيل</LinkButton>
        </Card>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardTitle icon={<Bot className="size-4" />}>المحتوى</CardTitle>
          {Object.keys(d.content.byStatus).length === 0 ? (
            <EmptyState title="لا يوجد محتوى بعد" action={<LinkButton href="/content?new=1">إنشاء محتوى</LinkButton>} />
          ) : (
            <div className="flex flex-wrap gap-2">
              {Object.entries(d.content.byStatus).map(([s, c]) => (
                <Badge key={s}>
                  {t.contentStatus[s as keyof typeof t.contentStatus] ?? s}: <span className="ltr">{c}</span>
                </Badge>
              ))}
            </div>
          )}
          <p className="mt-4 text-xs text-ink-400">أداء الحملات والعملاء المحتملون يظهرون هنا بعد ربط Instagram (المرحلة 6) وتفعيل CRM (المرحلة 7).</p>
        </Card>

        <Card>
          <CardTitle icon={<ShieldCheck className="size-4" />} action={<Link href="/settings#audit" className="text-xs text-accent-400">السجل الكامل</Link>}>
            آخر الأحداث المهمة
          </CardTitle>
          {d.recentEvents.length === 0 ? (
            <EmptyState title="لا توجد أحداث" icon={<CheckCircle2 className="size-6" />} />
          ) : (
            <ul className="flex flex-col divide-y divide-ink-700/60 text-sm">
              {d.recentEvents.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-3 py-2">
                  <span className="ltr truncate text-ink-300">{e.action}</span>
                  <span className="shrink-0 text-xs text-ink-400">{formatDate(e.createdAt, tz)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
