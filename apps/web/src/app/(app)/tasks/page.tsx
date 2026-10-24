import Link from "next/link";
import { ListChecks } from "lucide-react";
import { desc, eq } from "drizzle-orm";
import { getAiConfigStatus } from "@dfos/config";
import { listTasksQuery } from "@dfos/contracts";
import { contentItems } from "@dfos/db";
import { can, TASK_STATUSES } from "@dfos/domain";
import { listTasks } from "@dfos/orchestrator";
import { NewTaskForm } from "@/components/new-task-form";
import { EmptyState, LinkButton, PageHeader, Table, Td, buttonClass } from "@/components/ui";
import { formatDate, TaskStatus } from "@/components/status";
import { t } from "@/i18n/ar";
import { requirePageCtx } from "@/server/session";

export const metadata = { title: "مركز المهام" };

export default async function TasksPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { ctx } = await requirePageCtx();
  const sp = await searchParams;
  const q = listTasksQuery.safeParse(sp);
  const query = q.success ? q.data : listTasksQuery.parse({});
  const { items, total } = await listTasks(ctx, query);
  const role = ctx.actor.type === "user" ? ctx.actor.role : "viewer";
  const showForm = Boolean(sp.new) && can(role, "tasks.create");
  const content = showForm
    ? await ctx.db
        .select({ id: contentItems.id, title: contentItems.title })
        .from(contentItems)
        .where(eq(contentItems.organizationId, ctx.organizationId))
        .orderBy(desc(contentItems.updatedAt))
        .limit(50)
    : [];

  const pageLink = (offset: number) => {
    const p = new URLSearchParams(Object.entries({ ...sp, offset: String(offset) }).filter(([, v]) => v) as [string, string][]);
    return `/tasks?${p}`;
  };

  return (
    <>
      <PageHeader
        title={t.nav.tasks}
        description="كل مهمة تمر بدورة حياة واضحة وتُسجَّل أحداثها. المهام الطويلة تُنفَّذ في العامل الخلفي."
        actions={can(role, "tasks.create") && !showForm ? <LinkButton href="/tasks?new=1" variant="gold">مهمة جديدة</LinkButton> : undefined}
      />
      {showForm && (
        <NewTaskForm content={content} aiConfigured={getAiConfigStatus().configured} initialType={sp.new === "ceo" ? "ceo.plan" : undefined} />
      )}

      <form className="mb-4 flex flex-wrap items-end gap-2" action="/tasks">
        <input name="q" defaultValue={query.q} placeholder="بحث في العناوين" className="rounded-xl border border-ink-700 bg-ink-900 px-3 py-2 text-sm" />
        <select name="status" defaultValue={query.status ?? ""} className="rounded-xl border border-ink-700 bg-ink-900 px-3 py-2 text-sm">
          <option value="">كل الحالات</option>
          {TASK_STATUSES.map((s) => (
            <option key={s} value={s}>{t.taskStatus[s]}</option>
          ))}
        </select>
        {query.agent && <input type="hidden" name="agent" value={query.agent} />}
        <button className={buttonClass("ghost")} type="submit">تصفية</button>
        {(query.q || query.status || query.agent) && <Link href="/tasks" className="text-sm text-ink-400">مسح</Link>}
      </form>

      {items.length === 0 ? (
        <EmptyState
          icon={<ListChecks className="size-8" />}
          title="لا توجد مهام"
          description="أنشئ مهمة، أو شغّل فحص الصحة من مركز الوكلاء."
          action={can(role, "tasks.create") ? <LinkButton href="/tasks?new=1">مهمة جديدة</LinkButton> : undefined}
        />
      ) : (
        <>
          <Table head={["العنوان", "النوع", "الحالة", "الأولوية", "المحاولات", "أُنشئت"]}>
            {items.map((task) => (
              <tr key={task.id} className="hover:bg-ink-800/60">
                <Td>
                  <Link href={`/tasks/${task.id}`} className="font-medium text-ink-100 hover:text-accent-400">{task.title}</Link>
                  {task.parentTaskId && <span className="block text-xs text-ink-400">مهمة فرعية</span>}
                </Td>
                <Td className="text-ink-300">{t.taskTypes[task.type] ?? task.type}</Td>
                <Td><TaskStatus s={task.status} /></Td>
                <Td className="text-ink-300">{t.priority[task.priority]}</Td>
                <Td><span className="ltr">{task.attempts}/{task.maxAttempts}</span></Td>
                <Td className="text-xs text-ink-400">{formatDate(task.createdAt)}</Td>
              </tr>
            ))}
          </Table>
          <div className="mt-3 flex items-center justify-between text-sm text-ink-400">
            <span>الإجمالي: <span className="ltr">{total}</span></span>
            <span className="flex gap-3">
              {query.offset > 0 && <Link href={pageLink(Math.max(0, query.offset - query.limit))}>السابق</Link>}
              {query.offset + items.length < total && <Link href={pageLink(query.offset + query.limit)}>التالي</Link>}
            </span>
          </div>
        </>
      )}
    </>
  );
}
