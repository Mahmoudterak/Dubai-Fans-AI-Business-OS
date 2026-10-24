"use client";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { api, ApiError, errorText } from "@/lib/client-api";
import { buttonClass, Notice } from "./ui";

/**
 * Uploads a JPEG to private storage, then attaches it to the content as a new version.
 * Attaching an image changes the approved fingerprint, so any open approval is voided.
 */
export function MediaPicker({ contentId, hasImage, storageReady, locked }: { contentId: string; hasImage: boolean; storageReady: boolean; locked: boolean }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!storageReady) {
    return <Notice>رفع الصور يحتاج إعداد تخزين الملفات (OBJECT_STORAGE_*). راجع docs/operations/meta-setup.md.</Notice>;
  }

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("file", file);
      const res = await fetch("/api/v1/media", { method: "POST", body: fd, credentials: "same-origin" });
      const json = (await res.json()) as { data?: { id: string }; error?: { code: string; message: string } };
      if (!res.ok || !json.data) throw new ApiError(json.error?.code ?? "internal_error", json.error?.message ?? "Upload failed");
      await api(`/content/${contentId}/media`, { body: { mediaAssetId: json.data.id } });
      router.refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api(`/content/${contentId}/media`, { body: { mediaAssetId: null } });
      router.refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {locked && <p className="text-xs text-amber-300">تغيير الصورة يُبطل الموافقة الحالية.</p>}
      <input
        ref={input}
        type="file"
        accept="image/jpeg"
        disabled={busy}
        onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
        className="text-sm file:me-3 file:rounded-lg file:border-0 file:bg-ink-700 file:px-3 file:py-1.5 file:text-ink-100"
      />
      <p className="text-xs text-ink-400">JPEG فقط، حتى 8 ميغابايت، نسبة العرض إلى الارتفاع بين 4:5 و 1.91:1 (متطلبات Instagram).</p>
      {hasImage && (
        <div>
          <button type="button" disabled={busy} onClick={remove} className={buttonClass("ghost")}>إزالة الصورة</button>
        </div>
      )}
      {busy && <span className="text-xs text-ink-400">جارٍ الرفع…</span>}
      {error && <Notice tone="red">{error}</Notice>}
    </div>
  );
}
