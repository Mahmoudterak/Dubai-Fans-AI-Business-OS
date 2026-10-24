"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, errorText } from "@/lib/client-api";
import { buttonClass, Notice } from "./ui";

export function BudgetForm({ current }: { current: string | null }) {
  const router = useRouter();
  const [value, setValue] = useState(current ? String(Number(current)) : "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/settings", { method: "PATCH", body: { aiMonthlyBudgetUsd: value ? Number(value) : null } });
      router.refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-2">
      <label className="text-sm font-semibold" htmlFor="budget">ميزانية الذكاء الاصطناعي الشهرية (دولار)</label>
      <p className="text-xs text-ink-400">تُطبَّق فقط عند إعداد أسعار النموذج (AI_PRICE_*). اتركها فارغة لإلغاء الحد.</p>
      <div className="flex gap-2">
        <input id="budget" type="number" min={0.01} step={0.01} value={value} onChange={(e) => setValue(e.target.value)} className="ltr w-40 rounded-xl border border-ink-700 bg-ink-900 px-3 py-2 text-sm" />
        <button disabled={busy} className={buttonClass("ghost")} type="submit">{busy ? "…" : "حفظ"}</button>
      </div>
      {error && <Notice tone="red">{error}</Notice>}
    </form>
  );
}
