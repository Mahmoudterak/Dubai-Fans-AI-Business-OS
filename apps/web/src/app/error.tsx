"use client";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="grid min-h-[60dvh] place-items-center px-4 text-center">
      <div>
        <p className="text-xl font-bold text-rose-300">حدث خطأ غير متوقع</p>
        <p className="mt-2 text-sm text-ink-400">تم تسجيل الخطأ. {error.digest && <span className="ltr">({error.digest})</span>}</p>
        <button onClick={reset} className="mt-4 rounded-xl bg-accent-500 px-4 py-2 text-sm font-semibold text-white">إعادة المحاولة</button>
      </div>
    </div>
  );
}
