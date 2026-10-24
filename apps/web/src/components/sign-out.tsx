"use client";
import { t } from "@/i18n/ar";

export function SignOutButton() {
  return (
    <form action="/api/v1/auth/sign-out" method="post" className="mt-3">
      <button type="submit" className="text-xs text-ink-400 underline-offset-4 hover:text-ink-100 hover:underline">
        {t.common.signOut}
      </button>
    </form>
  );
}
