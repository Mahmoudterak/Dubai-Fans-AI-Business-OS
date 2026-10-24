import Link from "next/link";

export default function NotFound() {
  return (
    <div className="grid min-h-dvh place-items-center px-4 text-center">
      <div>
        <p className="ltr text-5xl font-bold text-gold-400">404</p>
        <p className="mt-2 text-ink-300">الصفحة أو العنصر غير موجود، أو لا تملك صلاحية الوصول إليه.</p>
        <Link href="/" className="mt-4 inline-block text-accent-400">العودة للوحة التحكم</Link>
      </div>
    </div>
  );
}
