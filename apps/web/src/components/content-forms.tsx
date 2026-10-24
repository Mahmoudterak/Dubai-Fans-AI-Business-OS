"use client";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { api, errorText } from "@/lib/client-api";
import { t } from "@/i18n/ar";
import { buttonClass, Card, Notice } from "./ui";

const input = "rounded-xl border border-ink-700 bg-ink-900 px-3 py-2 text-sm";
const splitTags = (s: string) => s.split(/[\s,،]+/).map((x) => x.trim()).filter(Boolean);

function useSubmit() {
  const key = useRef(crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(fn: (key: string) => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try {
      const r = await fn(key.current);
      key.current = crypto.randomUUID();
      return r;
    } catch (e) {
      key.current = crypto.randomUUID();
      setError(errorText(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

export function NewContentForm() {
  const router = useRouter();
  const { busy, error, run } = useSubmit();
  const [f, setF] = useState({ title: "", platform: "instagram", format: "post", audience: "", goal: "", tone: "", body: "", hashtags: "", cta: "" });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const data = await run((key) =>
      api<{ id: string }>("/content", {
        body: {
          title: f.title,
          platform: f.platform,
          format: f.format,
          audience: f.audience || undefined,
          goal: f.goal || undefined,
          tone: f.tone || undefined,
          body: f.body,
          hashtags: splitTags(f.hashtags),
          cta: f.cta || undefined,
        },
        idempotencyKey: key,
      }),
    );
    if (data) router.push(`/content/${data.id}`);
  }

  return (
    <Card className="mb-6">
      <form onSubmit={submit} className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm md:col-span-3">
          العنوان الداخلي
          <input required maxLength={200} className={input} value={f.title} onChange={set("title")} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          المنصة
          <select className={input} value={f.platform} onChange={set("platform")}>
            {Object.entries(t.platform).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          نوع المحتوى
          <select className={input} value={f.format} onChange={set("format")}>
            {Object.entries(t.format).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          النبرة
          <input maxLength={100} className={input} value={f.tone} onChange={set("tone")} placeholder="ودّية، فاخرة، مرحة…" />
        </label>
        <label className="flex flex-col gap-1 text-sm md:col-span-2">
          الجمهور المستهدف
          <input maxLength={500} className={input} value={f.audience} onChange={set("audience")} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          الهدف
          <input maxLength={500} className={input} value={f.goal} onChange={set("goal")} />
        </label>
        <label className="flex flex-col gap-1 text-sm md:col-span-3">
          النص (أو موجز يكتب منه وكيل التسويق)
          <textarea required rows={5} maxLength={5000} className={input} value={f.body} onChange={set("body")} />
        </label>
        <label className="flex flex-col gap-1 text-sm md:col-span-2">
          الوسوم
          <input className={input} value={f.hashtags} onChange={set("hashtags")} placeholder="#دبي #صيف" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          الدعوة لاتخاذ إجراء
          <input maxLength={300} className={input} value={f.cta} onChange={set("cta")} />
        </label>
        <div className="md:col-span-3">
          {error && <div className="mb-3"><Notice tone="red">{error}</Notice></div>}
          <button disabled={busy} className={buttonClass("gold")} type="submit">{busy ? "…" : "حفظ كمسودة"}</button>
        </div>
      </form>
    </Card>
  );
}

export function VersionEditor({ contentId, initial, locked }: { contentId: string; initial: { body: string; hashtags: string[]; cta: string | null }; locked: boolean }) {
  const router = useRouter();
  const { busy, error, run } = useSubmit();
  const [body, setBody] = useState(initial.body);
  const [tags, setTags] = useState(initial.hashtags.join(" "));
  const [cta, setCta] = useState(initial.cta ?? "");
  const [note, setNote] = useState<string | null>(null);
  const dirty = body !== initial.body || tags !== initial.hashtags.join(" ") || cta !== (initial.cta ?? "");

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const r = await run((key) =>
      api<{ approvalsInvalidated: number }>(`/content/${contentId}/versions`, { body: { body, hashtags: splitTags(tags), cta: cta || undefined }, idempotencyKey: key }),
    );
    if (r) {
      setNote(r.approvalsInvalidated ? "حُفظ إصدار جديد، وأُبطلت الموافقة السابقة. أعد الإرسال للمراجعة." : "حُفظ إصدار جديد.");
      router.refresh();
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-3">
      {locked && <Notice>المحتوى قيد المراجعة أو معتمد. أي تعديل يُبطل الموافقة ويعيده إلى مسودة.</Notice>}
      <textarea rows={8} maxLength={5000} className={`${input} leading-8`} value={body} onChange={(e) => setBody(e.target.value)} required />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <input className={input} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="الوسوم" />
        <input className={input} value={cta} onChange={(e) => setCta(e.target.value)} placeholder="الدعوة لاتخاذ إجراء" maxLength={300} />
      </div>
      {error && <Notice tone="red">{error}</Notice>}
      {note && <Notice tone="blue">{note}</Notice>}
      <div>
        <button disabled={busy || !dirty} className={buttonClass("primary")} type="submit">{busy ? "…" : "حفظ كإصدار جديد"}</button>
      </div>
    </form>
  );
}

export function GenerateForm({ contentId, aiConfigured }: { contentId: string; aiConfigured: boolean }) {
  const router = useRouter();
  const { busy, error, run } = useSubmit();
  const [instructions, setInstructions] = useState("");
  if (!aiConfigured) {
    return <Notice>توليد المسودات يحتاج إعداد مزود الذكاء الاصطناعي (AI_PROVIDER و AI_GATEWAY_API_KEY و AI_DEFAULT_MODEL). يمكنك الكتابة يدويًا في الأثناء.</Notice>;
  }
  async function go(e: React.FormEvent) {
    e.preventDefault();
    const r = await run((key) => api<{ task: { id: string } }>("/content/generate", { body: { contentItemId: contentId, instructions: instructions || undefined }, idempotencyKey: key }));
    if (r) router.push(`/tasks/${r.task.id}`);
  }
  return (
    <form onSubmit={go} className="flex flex-col gap-3">
      <input className={input} value={instructions} onChange={(e) => setInstructions(e.target.value)} maxLength={2000} placeholder="تعليمات لوكيل التسويق (اختياري)" />
      {error && <Notice tone="red">{error}</Notice>}
      <div>
        <button disabled={busy} className={buttonClass("ghost")} type="submit">{busy ? "…" : "اكتب نسخًا بالذكاء الاصطناعي"}</button>
      </div>
      <p className="text-xs text-ink-400">تُنفَّذ في الخلفية وتُضاف النسخ كإصدارات جديدة. لن يُنشر شيء دون موافقة.</p>
    </form>
  );
}

export function ScheduleForm({ contentId, current, timezone }: { contentId: string; current: string | null; timezone: string }) {
  const router = useRouter();
  const { busy, error, run } = useSubmit();
  const [value, setValue] = useState(current ? current.slice(0, 16) : "");
  async function go(e: React.FormEvent) {
    e.preventDefault();
    // datetime-local has no zone: interpret it in the browser's zone and send ISO with offset.
    const iso = new Date(value).toISOString();
    const r = await run((key) => api(`/content/${contentId}/schedule`, { body: { scheduledAt: iso }, idempotencyKey: key }));
    if (r) router.refresh();
  }
  return (
    <form onSubmit={go} className="flex flex-col gap-2">
      <input type="datetime-local" required className={`${input} ltr`} value={value} onChange={(e) => setValue(e.target.value)} />
      <p className="text-xs text-ink-400">الوقت بتوقيت جهازك. تعرض المنصة المواعيد بتوقيت {timezone}. تغيير الموعد يُبطل الموافقة.</p>
      {error && <Notice tone="red">{error}</Notice>}
      <div><button disabled={busy} className={buttonClass("ghost")} type="submit">{busy ? "…" : "حفظ الموعد"}</button></div>
    </form>
  );
}
