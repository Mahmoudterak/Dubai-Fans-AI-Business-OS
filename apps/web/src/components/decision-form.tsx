"use client";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { api, errorText } from "@/lib/client-api";
import { buttonClass, Notice } from "./ui";

/**
 * Sends the fingerprint the reviewer is looking at. If the action changed since the
 * page loaded, the server refuses and the reviewer must look again.
 */
export function DecisionForm({ approvalId, fingerprint }: { approvalId: string; fingerprint: string }) {
  const router = useRouter();
  const key = useRef(crypto.randomUUID());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(action: "approve" | "reject" | "request-changes") {
    if (action === "request-changes" && !note.trim()) {
      setError("اكتب الملاحظات المطلوبة قبل طلب التعديلات.");
      return;
    }
    setBusy(action);
    setError(null);
    try {
      await api(`/approvals/${approvalId}/${action}`, { body: { fingerprint, note: note.trim() || undefined }, idempotencyKey: `${key.current}-${action}` });
      router.refresh();
    } catch (e) {
      key.current = crypto.randomUUID();
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        ملاحظات (اختيارية، ومطلوبة عند طلب التعديلات)
        <textarea rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} className="rounded-xl border border-ink-700 bg-ink-900 px-3 py-2" />
      </label>
      {error && <Notice tone="red">{error}</Notice>}
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={!!busy} onClick={() => decide("approve")} className={buttonClass("gold")}>{busy === "approve" ? "…" : "اعتماد"}</button>
        <button type="button" disabled={!!busy} onClick={() => decide("request-changes")} className={buttonClass("ghost")}>{busy === "request-changes" ? "…" : "طلب تعديلات"}</button>
        <button type="button" disabled={!!busy} onClick={() => decide("reject")} className={buttonClass("danger")}>{busy === "reject" ? "…" : "رفض"}</button>
      </div>
    </div>
  );
}
