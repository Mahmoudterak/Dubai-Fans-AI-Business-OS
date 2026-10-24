export const metadata = { title: "طلب حذف البيانات" };

/** Public status page Meta links users to after a data deletion request. */
export default async function DataDeletionPage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const { code } = await searchParams;
  const valid = code && /^[0-9a-f-]{36}$/.test(code);
  return (
    <div className="grid min-h-dvh place-items-center px-4 text-center">
      <div className="max-w-md">
        <h1 className="text-xl font-bold">طلب حذف البيانات</h1>
        {valid ? (
          <p className="mt-3 text-ink-300">
            تم استلام الطلب وحُذف تفويض Instagram المخزن لهذا الحساب. رقم التأكيد: <span className="ltr font-mono">{code}</span>
          </p>
        ) : (
          <p className="mt-3 text-ink-400">رقم تأكيد غير صالح.</p>
        )}
      </div>
    </div>
  );
}
