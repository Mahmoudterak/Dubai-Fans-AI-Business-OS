import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { Network } from "lucide-react";
import { getAuthMode } from "@dfos/auth";
import { getDb, users } from "@dfos/db";
import { Card, Notice } from "@/components/ui";
import { t } from "@/i18n/ar";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "تسجيل الدخول" };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const mode = getAuthMode();
  if (await getSession()) redirect("/");
  const { error } = await searchParams;

  let content: React.ReactNode;
  if (mode === "clerk") {
    const { SignIn } = await import("@clerk/nextjs");
    content = <SignIn routing="path" path="/sign-in" />;
  } else if (mode === "dev") {
    const devUsers = await getDb().select().from(users).where(eq(users.authProvider, "dev"));
    content = (
      <div className="flex flex-col gap-4">
        <Notice>
          وضع التطوير: تسجيل دخول تجريبي دون كلمة مرور. لا يعمل في الإنتاج ويتوقف تلقائيًا عند إعداد Clerk.
        </Notice>
        {error && <Notice tone="red">تعذّر تسجيل الدخول.</Notice>}
        {devUsers.length === 0 ? (
          <Notice tone="blue">
            لا يوجد مستخدمون تجريبيون بعد. شغّل <code className="ltr">pnpm db:seed</code> ثم حدّث الصفحة.
          </Notice>
        ) : (
          devUsers.map((u) => (
            <form key={u.id} action="/api/v1/auth/dev-login" method="post">
              <input type="hidden" name="userId" value={u.id} />
              <button className="w-full rounded-xl border border-ink-700 bg-ink-800 px-4 py-3 text-start hover:border-accent-500" type="submit">
                <span className="block font-semibold">{u.displayName}</span>
                <span className="ltr block text-end text-xs text-ink-400">{u.email}</span>
              </button>
            </form>
          ))
        )}
      </div>
    );
  } else {
    content = (
      <Notice tone="red">
        لم يُعدّ مزود المصادقة. أضف <code className="ltr">CLERK_SECRET_KEY</code> و
        <code className="ltr">NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY</code> في متغيرات البيئة (راجع docs/operations/deployment.md).
      </Notice>
    );
  }

  return (
    <div className="grid min-h-dvh place-items-center px-4 py-10">
      <Card className="w-full max-w-md">
        <div className="mb-6 flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-xl bg-gold-500 text-ink-950">
            <Network className="size-5" />
          </span>
          <div>
            <h1 className="text-xl font-bold">{t.appName}</h1>
            <p className="text-sm text-ink-400">{t.appTagline}</p>
          </div>
        </div>
        {content}
      </Card>
    </div>
  );
}
