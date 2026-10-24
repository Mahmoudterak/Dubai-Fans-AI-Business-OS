import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { listApprovalsQuery } from "@dfos/contracts";
import { listApprovals } from "@dfos/orchestrator";
import { cn, EmptyState, PageHeader, Table, Td } from "@/components/ui";
import { ApprovalStatus, formatDate, RiskBadge } from "@/components/status";
import { t } from "@/i18n/ar";
import { requirePageCtx } from "@/server/session";

export const metadata = { title: "مركز الموافقات" };

const TABS = [
  { key: "pending", label: "المنتظرة" },
  { key: "approved", label: "المعتمدة" },
  { key: "executed", label: "المنفّذة" },
  { key: "", label: "الكل" },
];

export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { ctx } = await requirePageCtx();
  const sp = await searchParams;
  const status = sp.status ?? "pending";
  const parsed = listApprovalsQuery.safeParse({ ...sp, status: status || undefined });
  const rows = await listApprovals(ctx, parsed.success ? parsed.data : { limit: 25, offset: 0 });

  return (
    <>
      <PageHeader
        title={t.nav.approvals}
        description="لا يُنشر محتوى ولا تُرسل رسالة ولا يُنفَّذ إجراء حساس قبل موافقة بشرية. كل موافقة مرتبطة ببصمة النسخة التي راجعتها."
      />
      <nav className="mb-4 flex gap-2 overflow-x-auto">
        {TABS.map((tab) => (
          <Link
            key={tab.key}
            href={`/approvals?status=${tab.key}`}
            className={cn("rounded-full px-4 py-1.5 text-sm", status === tab.key ? "bg-ink-700 text-ink-100" : "text-ink-400 hover:text-ink-100")}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
      {rows.length === 0 ? (
        <EmptyState
          icon={<CheckCircle2 className="size-8" />}
          title="لا توجد طلبات في هذه القائمة"
          description="تظهر الطلبات هنا عندما يُرسَل محتوى للمراجعة أو يقترح المدير التنفيذي خطة."
        />
      ) : (
        <Table head={["الطلب", "الإجراء", "الخطورة", "الحالة", "طلبه", "التاريخ"]}>
          {rows.map((a) => (
            <tr key={a.id} className="hover:bg-ink-800/60">
              <Td>
                <Link href={`/approvals/${a.id}`} className="font-medium hover:text-accent-400">{a.title}</Link>
                {a.summary && <span className="block text-xs text-ink-400">{a.summary}</span>}
              </Td>
              <Td><span className="ltr text-xs">{a.actionType}</span></Td>
              <Td><RiskBadge s={a.riskLevel} /></Td>
              <Td><ApprovalStatus s={a.status} /></Td>
              <Td><span className="ltr text-xs text-ink-400">{a.requestedByType === "agent" ? a.requestedById : "مستخدم"}</span></Td>
              <Td className="text-xs text-ink-400">{formatDate(a.createdAt)}</Td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}
