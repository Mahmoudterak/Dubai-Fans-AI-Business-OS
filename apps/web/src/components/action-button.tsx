"use client";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition, type ReactNode } from "react";
import { api, errorText } from "@/lib/client-api";
import { buttonClass, type ButtonVariant } from "./ui";

/**
 * Button that calls one API action and refreshes the page data.
 * The idempotency key is fixed per button instance, so double clicks are harmless.
 */
export function ActionButton({
  path,
  body,
  method = "POST",
  children,
  variant = "primary",
  confirm,
  goToTask,
  className,
}: {
  path: string;
  body?: unknown;
  method?: "POST" | "PATCH";
  children: ReactNode;
  variant?: ButtonVariant;
  confirm?: string;
  /** After success, open the task returned by the API (`{ task: { id } }`). */
  goToTask?: boolean;
  className?: string;
}) {
  const router = useRouter();
  const key = useRef<string>(crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();

  async function run() {
    if (confirm && !window.confirm(confirm)) return;
    setBusy(true);
    setError(null);
    try {
      const data = await api(path, { method, body: body ?? {}, idempotencyKey: key.current });
      key.current = crypto.randomUUID();
      const taskId = goToTask ? (data as { task?: { id?: string } } | null)?.task?.id : undefined;
      const to = taskId ? `/tasks/${taskId}` : undefined;
      startTransition(() => (to ? router.push(to) : router.refresh()));
    } catch (e) {
      key.current = crypto.randomUUID();
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col gap-1">
      <button type="button" onClick={run} disabled={busy} className={buttonClass(variant, className)}>
        {busy ? "…" : children}
      </button>
      {error && <span role="alert" className="max-w-xs text-xs text-rose-300">{error}</span>}
    </span>
  );
}
