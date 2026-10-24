import Link from "next/link";
import { notFound } from "next/navigation";
import { can, CANCELLABLE_TASK_STATUSES, isAppError } from "@dfos/domain";
import { getTask, listTaskEvents } from "@dfos/orchestrator";
import { ActionButton } from "@/components/action-button";
import { AutoRefresh } from "@/components/auto-refresh";
import { Card, CardTitle, KeyValue, Notice, PageHeader, Pre, Table, Td } from "@/components/ui";
import { formatDate, formatUsd, TaskStatus } from "@/components/status";
import { t } from "@/i18n/ar";
import { requirePageCtx } from "@/server/session";

export const metadata = { title: "تفاصيل المهمة" };

export default async function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx } = await requirePageCtx();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  let data;
  try {
    data = await getTask(ctx, id);
  } catch (e) {
    if (isAppError(e) && e.code === "not_found") notFound();
    throw e;
  }
  const events = await listTaskEvents(ctx, id);
  const { task, subtasks, dependencies, runs } = data;
  const role = ctx.actor.type === "user" ? ctx.actor.role : "viewer";
  const inProgress = ["queued", "running", "retrying"].includes(task.status) || subtasks.some((s) => ["queued", "running", "retrying"].includes(s.status));

  return (
    <>
      <PageHeader
        title={task.title}
        description={t.taskTypes[task.type] ?? task.type}
        actions={
          <>
            <AutoRefresh active={inProgress} />
            {CANCELLABLE_TASK_STATUSES.includes(task.status) && can(role, "tasks.cancel") && (
              <ActionButton path={`/tasks/${task.id}/cancel`} variant="danger" confirm="إلغاء هذه المهمة؟">إلغاء</ActionButton>
            )}
            {task.status === "failed" && can(role, "tasks.create") && (
              <ActionButton path={`/tasks/${task.id}/retry`}>{t.common.retry}</ActionButton>
            )}
          </>
        }
      />

      {task.status === "waiting_approval" && task.approvalRequestId && (
        <div className="mb-4">
          <Notice>
            المهمة متوقفة بانتظار موافقة بشرية.{" "}
            <Link className="font-semibold underline" href={`/approvals/${task.approvalRequestId}`}>افتح طلب الموافقة</Link>
          </Notice>
        </div>
      )}
      {task.error && (
        <div className="mb-4">
          <Notice tone="red">
            <span className="ltr font-mono text-xs">{task.error.code}</span> — {task.error.message}
          </Notice>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardTitle>الملخص</CardTitle>
          <KeyValue
            items={[
              ["الحالة", <TaskStatus key="s" s={task.status} />],
              ["الوكيل", <span key="a" className="ltr">{task.agentKey}</span>],
              ["الأولوية", t.priority[task.priority]],
              ["المحاولات", <span key="t" className="ltr">{task.attempts} / {task.maxAttempts}</span>],
              ["أُنشئت", formatDate(task.createdAt)],
              ["بدأت", formatDate(task.startedAt)],
              ["انتهت", formatDate(task.finishedAt)],
              ["التشغيل التالي", task.status === "retrying" ? formatDate(task.runAfter) : "—"],
              ["معرّف التتبع", <span key="tr" className="ltr font-mono text-xs">{task.traceId}</span>],
              ["الميزانية", task.budgetUsd ? formatUsd(task.budgetUsd) : "بدون حد خاص"],
            ]}
          />
          {task.parentTaskId && (
            <p className="mt-4 text-sm"><Link className="text-accent-400" href={`/tasks/${task.parentTaskId}`}>← المهمة الأم</Link></p>
          )}
        </Card>
        <Card>
          <CardTitle>المدخلات</CardTitle>
          <Pre value={task.input} />
        </Card>
      </div>

      {(subtasks.length > 0 || dependencies.length > 0) && (
        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
          {subtasks.length > 0 && (
            <Card>
              <CardTitle>المهام الفرعية</CardTitle>
              <ul className="flex flex-col gap-2 text-sm">
                {subtasks.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-2">
                    <Link className="hover:text-accent-400" href={`/tasks/${s.id}`}>{s.title}</Link>
                    <TaskStatus s={s.status} />
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {dependencies.length > 0 && (
            <Card>
              <CardTitle>تعتمد على</CardTitle>
              <ul className="flex flex-col gap-2 text-sm">
                {dependencies.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-2">
                    <Link className="hover:text-accent-400" href={`/tasks/${d.id}`}>{d.title}</Link>
                    <TaskStatus s={d.status} />
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}

      {task.result && (
        <Card className="mt-4">
          <CardTitle>النتيجة</CardTitle>
          <Pre value={task.result} />
        </Card>
      )}

      <h2 className="mb-3 mt-8 text-lg font-semibold">تشغيلات الوكيل</h2>
      {runs.length === 0 ? (
        <p className="text-sm text-ink-400">لم يُشغَّل بعد.</p>
      ) : (
        <Table head={["المحاولة", "الحالة", "المدة", "النموذج", "الرموز (إدخال/إخراج)", "التكلفة", "الملخص / الخطأ"]}>
          {runs.map((r) => (
            <tr key={r.id}>
              <Td><span className="ltr">{r.attempt}</span></Td>
              <Td>{r.status === "succeeded" ? "نجح" : r.status === "failed" ? "فشل" : "جارٍ"}</Td>
              <Td><span className="ltr">{r.durationMs !== null ? `${r.durationMs} ms` : "—"}</span></Td>
              <Td><span className="ltr text-xs">{r.model ?? "—"}</span></Td>
              <Td><span className="ltr">{r.inputTokens ?? 0} / {r.outputTokens ?? 0}</span></Td>
              <Td><span className="ltr">{formatUsd(r.costUsd)}</span></Td>
              <Td className="max-w-sm text-xs">{r.summary ?? (r.error ? <span className="text-rose-300">{r.error.code}: {r.error.message}</span> : "—")}</Td>
            </tr>
          ))}
        </Table>
      )}

      <h2 className="mb-3 mt-8 text-lg font-semibold">سجل الأحداث</h2>
      <ol className="relative flex flex-col gap-3 border-s border-ink-700 ps-5">
        {events.map((e) => (
          <li key={e.id} className="text-sm">
            <span className="absolute -start-1.5 mt-1.5 size-3 rounded-full bg-accent-500" />
            <div className="flex flex-wrap items-center gap-2">
              <span className="ltr font-mono text-xs text-ink-300">{e.type}</span>
              {e.toStatus && <TaskStatus s={e.toStatus} />}
              <span className="text-xs text-ink-400">{formatDate(e.createdAt)}</span>
              <span className="ltr text-xs text-ink-400">{e.actorId}</span>
            </div>
            {e.message && <p className="mt-1 text-ink-300">{e.message}</p>}
          </li>
        ))}
      </ol>
    </>
  );
}
