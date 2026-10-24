import { isMetaConfigured } from "@dfos/config";
import { requirePermission } from "@dfos/orchestrator";
import { Badge, Card, Notice, PageHeader } from "@/components/ui";
import { t } from "@/i18n/ar";
import { requirePageCtx } from "@/server/session";

export const metadata = { title: "التكاملات" };

const PROVIDERS = [
  {
    key: "meta",
    name: "Instagram / Meta",
    phase: "المرحلة 6 (التالية بعد استوديو المحتوى)",
    description: "تفويض OAuth رسمي، الحسابات المسموح بها، نشر المحتوى المعتمد، واستقبال Webhooks الرسائل والتفاعل.",
    env: ["META_APP_ID", "META_APP_SECRET", "META_REDIRECT_URI", "META_WEBHOOK_VERIFY_TOKEN"],
    permissions: ["instagram_basic", "instagram_content_publish", "pages_show_list", "pages_read_engagement", "instagram_manage_messages", "business_management"],
  },
  { key: "whatsapp", name: "WhatsApp Business Platform", phase: "لم يُجدول بعد", description: "Webhooks، الردود المسموح بها، القوالب وفترات المراسلة.", env: [], permissions: [] },
  { key: "tiktok", name: "TikTok", phase: "لم يُجدول بعد", description: "النشر وقراءة البيانات وفق واجهات TikTok المعتمدة.", env: [], permissions: [] },
  { key: "google_ads", name: "Google Ads", phase: "لم يُجدول بعد", description: "قراءة الحملات والتكاليف والتحويلات، ثم إدارة الإنفاق بحدود وموافقات.", env: [], permissions: [] },
];

export default async function IntegrationsPage() {
  const { ctx } = await requirePageCtx();
  requirePermission(ctx, "integrations.read");
  const metaApp = isMetaConfigured();

  return (
    <>
      <PageHeader title={t.nav.integrations} description="الحالة هنا حقيقية. لا يُعرض أي حساب على أنه متصل قبل إتمام تفويض فعلي عبر الواجهات الرسمية." />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {PROVIDERS.map((p) => (
          <Card key={p.key}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="ltr text-start text-lg font-bold">{p.name}</h2>
                <p className="text-xs text-ink-400">{p.phase}</p>
              </div>
              <Badge>غير متصل</Badge>
            </div>
            <p className="mt-3 text-sm text-ink-300">{p.description}</p>
            {p.key === "meta" && (
              <div className="mt-4 flex flex-col gap-3 text-sm">
                <p>
                  تطبيق Meta:{" "}
                  {metaApp ? <Badge tone="green">متغيرات البيئة موجودة</Badge> : <Badge tone="amber">غير مُعدّ</Badge>}
                </p>
                <div>
                  <p className="mb-1 text-ink-400">متغيرات البيئة المطلوبة:</p>
                  <div className="flex flex-wrap gap-1">{p.env.map((e) => <Badge key={e}><span className="ltr">{e}</span></Badge>)}</div>
                </div>
                <div>
                  <p className="mb-1 text-ink-400">الصلاحيات التي سيطلبها التطبيق (تخضع لمراجعة Meta):</p>
                  <div className="flex flex-wrap gap-1">{p.permissions.map((e) => <Badge key={e} tone="blue"><span className="ltr">{e}</span></Badge>)}</div>
                </div>
                <Notice tone="blue">
                  زر الاتصال يُضاف مع تنفيذ OAuth في المرحلة 6. يتطلب حساب Instagram احترافيًا (Business أو Creator) مرتبطًا بصفحة Facebook. الخطوات في docs/operations/meta-setup.md.
                </Notice>
              </div>
            )}
          </Card>
        ))}
      </div>
    </>
  );
}
