import Link from "next/link";
import { Crown } from "lucide-react";
import { can } from "@dfos/domain";
import { listAgents } from "@dfos/orchestrator";
import { ActionButton } from "@/components/action-button";
import { Badge, Card, PageHeader } from "@/components/ui";
import { formatDate } from "@/components/status";
import { t } from "@/i18n/ar";
import { requirePageCtx } from "@/server/session";

export const metadata = { title: "مركز الوكلاء" };

const availabilityTone = { ready: "green", disabled: "neutral", needs_ai_config: "amber", not_implemented: "neutral" } as const;

/** Task types that need no extra input and can be started with one click. */
const QUICK_TASKS: Record<string, { type: string; input: Record<string, unknown>; label: string }> = {
  operations: { type: "operations.health_check", input: {}, label: "تشغيل فحص الصحة" },
  finance: { type: "finance.ai_usage_report", input: { days: 30 }, label: "تقرير 30 يومًا" },
};

export default async function AgentsPage() {
  const { ctx } = await requirePageCtx();
  const agents = await listAgents(ctx);
  const role = ctx.actor.type === "user" ? ctx.actor.role : "viewer";
  const canManage = can(role, "agents.manage");
  const canCreate = can(role, "tasks.create");

  return (
    <>
      <PageHeader title={t.nav.agents} description="الحالة هنا حقيقية: الوكيل الذي لا يملك قدرة مبرمجة يظهر «غير متاح بعد»، ولا يُعرض أي ناتج غير منفّذ." />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {agents.map((a) => (
          <Card key={a.key} className={a.key === "ceo" ? "border-gold-500/40 md:col-span-2 xl:col-span-3" : undefined}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="flex items-center gap-2 text-lg font-bold">
                  {a.key === "ceo" && <Crown className="size-5 text-gold-400" />}
                  <span className="ltr">{a.name}</span>
                </h2>
                <p className="text-sm text-ink-300">{a.nameAr}</p>
              </div>
              <Badge tone={availabilityTone[a.availability]}>{t.availability[a.availability]}</Badge>
            </div>
            <p className="mt-3 text-sm text-ink-400">{a.descriptionAr}</p>

            <dl className="mt-4 grid grid-cols-3 gap-2 text-center text-xs">
              <div className="rounded-lg bg-ink-800 p-2"><dt className="text-ink-400">تشغيلات</dt><dd className="ltr text-base font-semibold">{a.stats.total}</dd></div>
              <div className="rounded-lg bg-ink-800 p-2"><dt className="text-ink-400">نجحت</dt><dd className="ltr text-base font-semibold text-emerald-300">{a.stats.succeeded}</dd></div>
              <div className="rounded-lg bg-ink-800 p-2"><dt className="text-ink-400">فشلت</dt><dd className="ltr text-base font-semibold text-rose-300">{a.stats.failed}</dd></div>
            </dl>
            <p className="mt-2 text-xs text-ink-400">آخر تشغيل: {formatDate(a.stats.lastRunAt)}</p>

            {a.taskTypes.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1">
                {a.tools.map((tool) => (
                  <Badge key={tool.tool} tone={tool.allowed ? "blue" : "neutral"}>
                    <span className="ltr">{tool.tool}</span>
                  </Badge>
                ))}
                <Badge>محاولات قصوى: <span className="ltr">{a.maxAttempts}</span></Badge>
              </div>
            )}

            <div className="mt-4 flex flex-wrap gap-2">
              {canManage && a.taskTypes.length > 0 && (
                <ActionButton
                  path={`/agents/${a.key}`}
                  method="PATCH"
                  body={{ enabled: !a.enabled }}
                  variant={a.enabled ? "danger" : "primary"}
                  confirm={a.enabled ? `إيقاف ${a.nameAr}؟ لن تُنفَّذ مهامه حتى إعادة التفعيل.` : undefined}
                >
                  {a.enabled ? "إيقاف الوكيل" : "تفعيل الوكيل"}
                </ActionButton>
              )}
              {canCreate && a.availability === "ready" && QUICK_TASKS[a.key] && (
                <ActionButton
                  path="/tasks"
                  body={{ type: QUICK_TASKS[a.key]!.type, input: QUICK_TASKS[a.key]!.input, title: QUICK_TASKS[a.key]!.label }}
                  variant="ghost"
                  goToTask
                >
                  {QUICK_TASKS[a.key]!.label}
                </ActionButton>
              )}
              {a.key === "ceo" && a.availability === "ready" && canCreate && (
                <Link href="/tasks?new=ceo" className="text-sm text-accent-400 underline-offset-4 hover:underline">اطلب خطة من المدير التنفيذي</Link>
              )}
              <Link href={`/tasks?agent=${a.key}`} className="self-center text-sm text-ink-400 hover:text-ink-100">سجل التشغيل ←</Link>
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}
