import { redirect } from "next/navigation";
import { Card, Notice, buttonClass } from "@/components/ui";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "إنشاء مؤسسة" };

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const session = await getSession();
  if (!session) redirect("/sign-in");
  if (session.info.organizationId) redirect("/");
  const { error } = await searchParams;
  return (
    <div className="grid min-h-dvh place-items-center px-4">
      <Card className="w-full max-w-md">
        <h1 className="mb-2 text-xl font-bold">أنشئ مؤسستك</h1>
        <p className="mb-5 text-sm text-ink-400">ستكون المالك، ويُنشأ الوكلاء وسياسات الموافقة الافتراضية (الأكثر أمانًا) تلقائيًا.</p>
        {error && <div className="mb-4"><Notice tone="red">الاسم غير صالح.</Notice></div>}
        <form action="/api/v1/orgs" method="post" className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm">
            اسم المؤسسة
            <input name="name" required minLength={2} maxLength={120} className="rounded-xl border border-ink-700 bg-ink-900 px-3 py-2" />
          </label>
          <button type="submit" className={buttonClass("gold")}>إنشاء</button>
        </form>
      </Card>
    </div>
  );
}
