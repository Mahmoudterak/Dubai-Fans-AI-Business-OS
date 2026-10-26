import { can } from "@dfos/domain";
import { getOrganization, listAuditLogs, listMembers } from "@dfos/orchestrator";
import { ActionButton } from "@/components/action-button";
import { BudgetForm } from "@/components/settings-forms";
import { Badge, Card, CardTitle, KeyValue, Notice, PageHeader, Table, Td } from "@/components/ui";
import { formatDate, formatUsd } from "@/components/status";
import { t } from "@/i18n/ar";
import { requirePageCtx } from "@/server/session";

export const metadata = { title: "الإعدادات والتدقيق" };

export default async function SettingsPage() {
  const { ctx } = await requirePageCtx();
  const role = ctx.actor.type === "user" ? ctx.actor.role : "viewer";
  const [org, members] = await Promise.all([getOrganization(ctx), listMembers(ctx)]);
  const audit = can(role, "audit.read") ? await listAuditLogs(ctx, { limit: 50, offset: 0 }) : null;
  const canManage = can(role, "org.manage");

  return (
    <>
      <PageHeader title={t.nav.settings} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardTitle>المؤسسة</CardTitle>
          <KeyValue
            items={[
              ["الاسم", org.name],
              ["المنطقة الزمنية", <span key="tz" className="ltr">{org.timezone}</span>],
              ["ميزانية الذكاء الاصطناعي الشهرية", org.aiMonthlyBudgetUsd ? formatUsd(org.aiMonthlyBudgetUsd) : "بدون حد"],
              ["حالة الوكلاء", org.agentsPaused ? <Badge key="p" tone="red">متوقفون</Badge> : <Badge key="p" tone="green">يعملون</Badge>],
            ]}
          />
          {canManage && (
            <div className="mt-5 flex flex-col gap-4 border-t border-ink-700 pt-5">
              <div>
                <p className="mb-2 text-sm font-semibold">مفتاح الإيقاف (Kill Switch)</p>
                <p className="mb-3 text-xs text-ink-400">يوقف استلام أي مهمة جديدة لكل الوكلاء فورًا. المهام الجارية تكمل محاولتها الحالية.</p>
                <ActionButton
                  path="/settings"
                  method="PATCH"
                  body={{ agentsPaused: !org.agentsPaused }}
                  variant={org.agentsPaused ? "primary" : "danger"}
                  confirm={org.agentsPaused ? undefined : "إيقاف جميع الوكلاء؟"}
                >
                  {org.agentsPaused ? "إعادة تشغيل الوكلاء" : "إيقاف جميع الوكلاء"}
                </ActionButton>
              </div>
              <BudgetForm current={org.aiMonthlyBudgetUsd} />
              <div>
                <p className="mb-2 text-sm font-semibold">قاعدة «أربع أعين»</p>
                <p className="mb-3 text-xs text-ink-400">
                  عند التفعيل لا يستطيع أحد اعتماد طلب أرسله بنفسه أو محتوى كتبه أو عدّله. الرفض وطلب التعديلات مسموحان دائمًا. الحالة الحالية:{" "}
                  {org.requireDistinctApprover ? "مفعّلة" : "غير مفعّلة (يمكن للمستخدم المخوّل اعتماد عمله)"}.
                </p>
                <ActionButton path="/settings" method="PATCH" body={{ requireDistinctApprover: !org.requireDistinctApprover }} variant="ghost">
                  {org.requireDistinctApprover ? "إلغاء قاعدة أربع أعين" : "تفعيل قاعدة أربع أعين"}
                </ActionButton>
              </div>
            </div>
          )}
        </Card>

        <Card>
          <CardTitle>المستخدمون والأدوار</CardTitle>
          <ul className="flex flex-col divide-y divide-ink-700/60 text-sm">
            {members.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-3 py-2">
                <span>
                  <span className="block font-medium">{m.displayName}</span>
                  <span className="ltr block text-end text-xs text-ink-400">{m.email}</span>
                </span>
                <Badge tone={m.role === "owner" ? "gold" : m.role === "approver" ? "blue" : "neutral"}>{t.role[m.role]}</Badge>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-ink-400">
            الأدوار: المالك (كل الصلاحيات) · المدير · المعتمِد (يعتمد وينشر) · العضو (يُنشئ ويحرر) · المشاهد (قراءة فقط). دعوة المستخدمين تتم عبر Clerk عند تفعيله.
          </p>
        </Card>
      </div>

      <Card className="mt-4">
        <CardTitle>السياسات</CardTitle>
        <Notice tone="blue">
          السياسة الافتراضية الأكثر أمانًا مفعّلة: النشر، الرسائل الخارجية، تعديل ميزانيات الإعلانات، وإنشاء مهام فرعية من خطة المدير التنفيذي كلها تتطلب موافقة بشرية. لا يمكن لأي وكيل اعتماد طلب. قاعدة «أربع أعين»: {org.requireDistinctApprover ? "مفعّلة" : "غير مفعّلة"}.
        </Notice>
      </Card>

      <section id="audit" className="mt-8">
        <h2 className="mb-3 text-lg font-semibold">سجل التدقيق</h2>
        {!audit ? (
          <Notice>ليست لديك صلاحية عرض سجل التدقيق.</Notice>
        ) : (
          <Table head={["الوقت", "الفاعل", "الإجراء", "الهدف", "معرّف الطلب"]}>
            {audit.map((e) => (
              <tr key={e.id}>
                <Td className="text-xs text-ink-400">{formatDate(e.createdAt, org.timezone)}</Td>
                <Td><span className="ltr text-xs">{e.actorType}:{e.actorId?.slice(0, 18)}</span></Td>
                <Td><span className="ltr text-xs">{e.action}</span></Td>
                <Td><span className="ltr text-xs text-ink-400">{e.targetType}{e.targetId ? `/${e.targetId.slice(0, 8)}` : ""}</span></Td>
                <Td><span className="ltr text-[10px] text-ink-400">{e.requestId?.slice(0, 8) ?? "—"}</span></Td>
              </tr>
            ))}
          </Table>
        )}
        <p className="mt-2 text-xs text-ink-400">السجل للإضافة فقط: قاعدة البيانات ترفض تعديل أو حذف أي سطر.</p>
      </section>
    </>
  );
}
