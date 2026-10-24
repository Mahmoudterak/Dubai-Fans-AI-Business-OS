"use client";
import { t } from "@/i18n/ar";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/**
 * Calls /api/v1. Every mutating call carries an Idempotency-Key so a double
 * click or a network retry never runs the action twice.
 */
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
  const method = init.method ?? (init.body !== undefined ? "POST" : "GET");
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") headers["idempotency-key"] = init.idempotencyKey ?? crypto.randomUUID();
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: "same-origin",
  });
  const json = (await res.json().catch(() => ({}))) as { data?: T; error?: { code: string; message: string; details?: unknown }; requestId?: string };
  if (!res.ok || json.error) {
    const code = json.error?.code ?? "internal_error";
    throw new ApiError(code, json.error?.message ?? res.statusText, json.requestId, json.error?.details);
  }
  return json.data as T;
}

const fallbackError = "حدث خطأ غير متوقع";

export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    const label = t.errors[e.code] ?? fallbackError;
    return `${label}${e.message && e.code !== "internal_error" ? ` — ${e.message}` : ""}`;
  }
  return fallbackError;
}
