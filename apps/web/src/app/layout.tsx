import type { Metadata, Viewport } from "next";
import { isClerkConfigured } from "@dfos/config";
import "./globals.css";

// System Arabic fonts (no build-time download). To self-host a brand font later,
// add it under public/fonts and reference it in globals.css.
export const metadata: Metadata = {
  title: { default: "Dubai Fans OS", template: "%s · Dubai Fans OS" },
  description: "نظام تشغيل الأعمال بوكلاء الذكاء الاصطناعي",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: "#0b1426", width: "device-width", initialScale: 1 };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const body = (
    <html lang="ar" dir="rtl">
      <body className="min-h-dvh">{children}</body>
    </html>
  );
  if (!isClerkConfigured()) return body;
  const { ClerkProvider } = await import("@clerk/nextjs");
  return <ClerkProvider>{body}</ClerkProvider>;
}
