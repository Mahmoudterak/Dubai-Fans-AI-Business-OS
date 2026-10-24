import { can } from "@dfos/domain";
import { integrationsConfigStatus, listConnections, requirePermission } from "@dfos/orchestrator";
import { ActionButton } from "@/components/action-button";
import { Badge, Card, KeyValue, Notice, PageHeader, buttonClass } from "@/components/ui";
import { formatDate } from "@/components/status";
import { t } from "@/i18n/ar";
import { requirePageCtx } from "@/server/session";

export const metadata = { title: "التكاملات" };

const statusTone = { active: "green", expired: "amber", revoked: "red", error: "red", disconnected: "neutral" } as const;

const OTHERS = [
  { name: "WhatsApp Business Platform", description: "Webhooks، الردود المسموح بها، القوالب وفترات المراسلة." },
  { name: "TikTok", description: "النشر وقراءة البيانات وفق واجهات TikTok المعتمدة." },
  { name: "Google Ads", description: "قراءة الحملات والتكاليف، ثم إدارة الإنفاق بحدود وموافقات." },
];

function MissingVars({ vars }: { vars: string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {vars.map((v) => (
        <Badge key={v} tone="amber"><span className="ltr">{v}</span></Badge>
      ))}
    </div>
  );
}

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<{ connected?: string; error?: string }> }) {
  const { ctx } = await requirePageCtx();
  requirePermission(ctx, "integrations.read");
  const sp = await searchParams;
  const role = ctx.actor.type === "user" ? ctx.actor.role : "viewer";
  const canManage = can(role, "integrations.manage");
  const config = integrationsConfigStatus();
  const connections = (await listConnections(ctx)).filter((c) => c.provider === "instagram");
  const live = connections.filter((c) => c.status !== "disconnected");
  const past = connections.filter((c) => c.status === "disconnected");

  return (
    <>
      <PageHeader title={t.nav.integrations} description="الحالة هنا حقيقية من قاعدة البيانات. لا يظهر حساب متصلًا إلا بعد تفويض فعلي عبر Instagram." />

      {sp.connected && <div className="mb-4"><Notice tone="blue">تم ربط حساب Instagram بنجاح.</Notice></div>}
      {sp.error && (
        <div className="mb-4">
          <Notice tone="red">تعذّر إكمال الربط: {t.errors[sp.error] ?? t.errors.internal_error}</Notice>
        </div>
      )}

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="ltr text-start text-lg font-bold">Instagram</h2>
            <p className="text-xs text-ink-400">
              Instagram API with Instagram Login · <span className="ltr">{config.graphApiVersion}</span>
            </p>
          </div>
          {live.length === 0 && <Badge>غير متصل</Badge>}
        </div>

        {!config.meta.ready && (
          <div className="mt-4 flex flex-col gap-2 text-sm">
            <Notice>الربط غير متاح حتى تُضاف متغيرات البيئة التالية على الخادم (لا تُرسلها في المحادثة):</Notice>
            <MissingVars vars={config.meta.missing} />
          </div>
        )}

        {live.map((c) => (
          <div key={c.id} className="mt-5 rounded-xl border border-ink-700 bg-ink-900 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-semibold">
                <span className="ltr">@{c.username ?? c.externalAccountId}</span>
                {c.accountType && <span className="ms-2 text-xs text-ink-400">{c.accountType}</span>}
              </p>
              <div className="flex gap-2">
                <Badge tone={statusTone[c.status]}>{t.connectionStatus[c.status] ?? c.status}</Badge>
                {!c.enabled && <Badge tone="red">موقوف</Badge>}
                {c.canPublish ? <Badge tone="green">النشر متاح</Badge> : <Badge tone="amber">النشر غير متاح</Badge>}
              </div>
            </div>
            <div className="mt-4">
              <KeyValue
                items={[
                  ["الصلاحيات الممنوحة", <span key="s" className="ltr text-xs">{c.grantedScopes.join(", ") || "—"}</span>],
                  ["ينتهي التفويض", formatDate(c.tokenExpiresAt)],
                  ["آخر مزامنة", formatDate(c.lastSyncAt)],
                  ["آخر خطأ", c.lastError ? `${c.lastError.message}` : "—"],
                ]}
              />
            </div>
            {canManage && (
              <div className="mt-4 flex flex-wrap gap-2">
                {c.status === "active" && <ActionButton path={`/integrations/${c.id}/sync`} variant="ghost">مزامنة الآن</ActionButton>}
                <ActionButton path={`/integrations/${c.id}`} method="PATCH" body={{ enabled: !c.enabled }} variant={c.enabled ? "danger" : "primary"} confirm={c.enabled ? "إيقاف استخدام هذا الحساب في النشر والمزامنة؟" : undefined}>
                  {c.enabled ? "إيقاف مؤقت" : "إعادة التفعيل"}
                </ActionButton>
                {(c.status === "expired" || c.status === "error") && config.meta.ready && (
                  <form action="/api/v1/integrations/meta/connect" method="post">
                    <button type="submit" className={buttonClass("gold")}>إعادة الربط</button>
                  </form>
                )}
                <ActionButton path={`/integrations/${c.id}/disconnect`} variant="ghost" confirm="فصل الحساب وحذف التفويض المخزن؟">فصل الحساب</ActionButton>
              </div>
            )}
          </div>
        ))}

        {canManage && config.meta.ready && live.length === 0 && (
          <form action="/api/v1/integrations/meta/connect" method="post" className="mt-5">
            <button type="submit" className={buttonClass("gold")}>ربط حساب Instagram</button>
            <p className="mt-2 text-xs text-ink-400">ستنتقل إلى Instagram للموافقة، ثم تعود هنا. يتطلب حسابًا احترافيًا (Business أو Creator).</p>
          </form>
        )}

        <div className="mt-6 grid grid-cols-1 gap-3 border-t border-ink-700 pt-5 text-sm md:grid-cols-2">
          <div>
            <p className="mb-1 text-ink-400">Redirect URI</p>
            <p className="ltr break-all font-mono text-xs">{config.redirectUri ?? "— (META_REDIRECT_URI)"}</p>
          </div>
          <div>
            <p className="mb-1 text-ink-400">Webhook URL</p>
            <p className="ltr break-all font-mono text-xs">{config.webhookUrl}</p>
            {!config.webhookConfigured && <p className="mt-1 text-xs text-amber-300">META_WEBHOOK_VERIFY_TOKEN غير مُعدّ</p>}
          </div>
          <div>
            <p className="mb-1 text-ink-400">تخزين الصور (مطلوب للنشر)</p>
            {config.storage.ready ? <Badge tone="green">مُعدّ</Badge> : <MissingVars vars={config.storage.missing} />}
          </div>
          <div>
            <p className="mb-1 text-ink-400">مفتاح تشفير الأسرار</p>
            {config.secrets ? <Badge tone="green">مُعدّ</Badge> : <MissingVars vars={["SECRETS_ENCRYPTION_KEY"]} />}
          </div>
        </div>
        {past.length > 0 && <p className="mt-4 text-xs text-ink-400">حسابات مفصولة سابقًا: {past.map((c) => `@${c.username ?? c.externalAccountId}`).join("، ")}</p>}
      </Card>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        {OTHERS.map((p) => (
          <Card key={p.name}>
            <div className="flex items-start justify-between gap-2">
              <h2 className="ltr text-start font-bold">{p.name}</h2>
              <Badge>لم يُجدول بعد</Badge>
            </div>
            <p className="mt-2 text-sm text-ink-400">{p.description}</p>
          </Card>
        ))}
      </div>
    </>
  );
}
