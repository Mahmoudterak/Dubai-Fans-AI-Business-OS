import type { z } from "zod";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ProviderRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  maxOutputTokens: number;
  /** Ask the provider for JSON output when it supports it. */
  json: boolean;
  signal: AbortSignal;
}

export interface ProviderResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface AiProvider {
  readonly name: string;
  complete(req: ProviderRequest): Promise<ProviderResponse>;
}

export interface UsageRecord {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  costSource: "configured_price" | "unknown";
  latencyMs: number;
  success: boolean;
  errorCode?: string;
}

export interface StructuredRequest<T extends z.ZodType> {
  /** Agent instructions. Never mixed with user or external text. */
  system: string;
  /** User/external input. Wrap external text with `untrusted()`. */
  prompt: string;
  schema: T;
  model?: string;
  maxOutputTokens?: number;
  /** Remaining budget for this run in USD. Only enforced when prices are configured. */
  remainingBudgetUsd?: number | null;
}

export interface StructuredResult<T> {
  data: T;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  latencyMs: number;
}
