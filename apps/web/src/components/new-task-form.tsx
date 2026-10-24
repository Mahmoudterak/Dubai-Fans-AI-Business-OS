"use client";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { api, errorText } from "@/lib/client-api";
import { t } from "@/i18n/ar";
import { buttonClass, Card, Notice } from "./ui";

type ContentOption = { id: string; title: string };

const inputClass = "rounded-xl border border-ink-700 bg-ink-900 px-3 py-2 text-sm";

export function NewTaskForm({ content, aiConfigured, initialType }: { content: ContentOption[]; aiConfigured: boolean; initialType?: string }) {
  const router = useRouter();
  const key = useRef(crypto.randomUUID());
  const [type, setType] = useState(initialType ?? "ceo.plan");
  const [goal, setGoal] = useState("");
  const [contentItemId, setContentItemId] = useState(content[0]?.id ?? "");
  const [instructions, setInstructions] = useState("");
  const [days, setDays] = useState(30);
  const [priority, setPriority] = useState("normal");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsAi = type === "ceo.plan" || type === "marketing.draft_content";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const input =
      type === "ceo.plan" ? { goal } : type === "marketing.draft_content" ? { contentItemId, instructions: instructions || undefined } : type === "finance.ai_usage_report" ? { days } : {};
    try {
      const data = await api<{ task: { id: string } }>("/tasks", { body: { type, input, priority }, idempotencyKey: key.current });
      router.push(`/tasks/${data.task.id}`);
    } catch (err) {
      key.current = crypto.randomUUID();
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <Card className="mb-6">
      <form onSubmit={submit} className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          نوع المهمة
          <select className={inputClass} value={type} onChange={(e) => setType(e.target.value)}>
            {Object.entries(t.taskTypes).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          الأولوية
          <select className={inputClass} value={priority} onChange={(e) => setPriority(e.target.value)}>
            {Object.entries(t.priority).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </label>

        {type === "ceo.plan" && (
          <label className="flex flex-col gap-1 text-sm md:col-span-2">
            ما الذي تريد إنجازه؟
            <textarea required minLength={5} maxLength={2000} rows={3} className={inputClass} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="مثال: افحص حالة النظام وجهّز تقرير تكاليف الذكاء الاصطناعي لهذا الشهر" />
            <span className="text-xs text-ink-400">سيقترح المدير التنفيذي خطة، ولن تُنشأ أي مهمة فرعية قبل موافقتك.</span>
          </label>
        )}
        {type === "marketing.draft_content" && (
          <>
            <label className="flex flex-col gap-1 text-sm">
              المحتوى
              {content.length ? (
                <select required className={inputClass} value={contentItemId} onChange={(e) => setContentItemId(e.target.value)}>
                  {content.map((c) => (
                    <option key={c.id} value={c.id}>{c.title}</option>
                  ))}
                </select>
              ) : (
                <span className="text-xs text-amber-300">أنشئ محتوى أولًا من استوديو المحتوى.</span>
              )}
            </label>
            <label className="flex flex-col gap-1 text-sm">
              تعليمات إضافية
              <input maxLength={2000} className={inputClass} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
            </label>
          </>
        )}
        {type === "finance.ai_usage_report" && (
          <label className="flex flex-col gap-1 text-sm">
            عدد الأيام
            <input type="number" min={1} max={90} className={inputClass} value={days} onChange={(e) => setDays(Number(e.target.value))} />
          </label>
        )}

        <div className="flex flex-col gap-2 md:col-span-2">
          {needsAi && !aiConfigured && <Notice>هذه المهمة تحتاج مزود ذكاء اصطناعي غير مُعدّ حاليًا، وستفشل برسالة واضحة إن أنشأتها.</Notice>}
          {error && <Notice tone="red">{error}</Notice>}
          <div>
            <button type="submit" disabled={busy || (type === "marketing.draft_content" && !content.length)} className={buttonClass("gold")}>
              {busy ? "…" : "إنشاء المهمة"}
            </button>
          </div>
        </div>
      </form>
    </Card>
  );
}
