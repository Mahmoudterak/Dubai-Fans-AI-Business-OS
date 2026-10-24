import { AiProviderError } from "./errors";
import type { AiProvider, ProviderRequest, ProviderResponse } from "./types";

async function postJson(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal) {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    const aborted = signal.aborted;
    throw new AiProviderError(aborted ? "timeout" : "network", aborted ? "AI request timed out" : "AI provider unreachable", true, err);
  }
  const text = await res.text();
  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    // Do not include the response body verbatim: it may echo request content.
    throw new AiProviderError(`http_${res.status}`, `AI provider returned HTTP ${res.status}`, retryable);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new AiProviderError("bad_response", "AI provider returned invalid JSON", true);
  }
}

/** Anthropic Messages API. */
export function anthropicProvider(apiKey: string, baseUrl = "https://api.anthropic.com"): AiProvider {
  return {
    name: "anthropic",
    async complete(req: ProviderRequest): Promise<ProviderResponse> {
      const json = await postJson(
        `${baseUrl.replace(/\/$/, "")}/v1/messages`,
        { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        {
          model: req.model,
          max_tokens: req.maxOutputTokens,
          system: req.system,
          messages: req.messages,
        },
        req.signal,
      );
      const content = Array.isArray(json.content) ? (json.content as Array<{ type: string; text?: string }>) : [];
      const usage = (json.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
      return {
        text: content.filter((c) => c.type === "text").map((c) => c.text ?? "").join(""),
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        model: typeof json.model === "string" ? json.model : req.model,
      };
    },
  };
}

/** Any OpenAI-compatible chat completions endpoint (e.g. Vercel AI Gateway, OpenRouter, OpenAI). */
export function openAiCompatibleProvider(apiKey: string, baseUrl: string): AiProvider {
  return {
    name: "openai-compatible",
    async complete(req: ProviderRequest): Promise<ProviderResponse> {
      const json = await postJson(
        `${baseUrl.replace(/\/$/, "")}/chat/completions`,
        { authorization: `Bearer ${apiKey}` },
        {
          model: req.model,
          max_tokens: req.maxOutputTokens,
          messages: [{ role: "system", content: req.system }, ...req.messages],
          ...(req.json ? { response_format: { type: "json_object" } } : {}),
        },
        req.signal,
      );
      const choices = (json.choices ?? []) as Array<{ message?: { content?: string } }>;
      const usage = (json.usage ?? {}) as { prompt_tokens?: number; completion_tokens?: number };
      return {
        text: choices[0]?.message?.content ?? "",
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
        model: typeof json.model === "string" ? json.model : req.model,
      };
    },
  };
}

type MockResponder = (req: ProviderRequest) => ProviderResponse | Promise<ProviderResponse>;
let mockResponder: MockResponder | undefined;

/** TEST ONLY. Registers what the mock provider returns. */
export function setMockResponder(fn: MockResponder | undefined) {
  mockResponder = fn;
}

/** TEST ONLY. Refuses to run outside NODE_ENV=test (enforced in config too). */
export function mockProvider(): AiProvider {
  return {
    name: "mock",
    async complete(req) {
      if (process.env.NODE_ENV !== "test") throw new AiProviderError("mock_outside_test", "Mock provider is test-only", false);
      if (!mockResponder) throw new AiProviderError("mock_unset", "No mock responder registered", false);
      return mockResponder(req);
    },
  };
}
