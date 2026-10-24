import { untrusted } from "@dfos/ai";
import { marketingDraftOutput } from "@dfos/contracts";
import { addContentVersion } from "../content";
import { loadContentPublishPayload } from "../content-payload";
import type { TaskHandler } from "./types";

const SYSTEM = `You are the marketing agent of "Dubai Fans", a business in Dubai.
Write social media content in the language of the brief (default: Gulf-friendly Modern Standard Arabic).
Respect the platform and format. Keep claims factual: never invent prices, discounts, awards or statistics
that are not in the brief. Produce 1-3 distinct variants.
Return JSON: {"variants": [{"body": string, "hashtags": string[], "cta": string}], "notes": string}`;

export const marketingDraftContent: TaskHandler = async (h) => {
  await h.requireTool("content.create_version");
  const contentItemId = String(h.task.input.contentItemId);
  const { item, version } = await loadContentPublishPayload(h.db, h.org.id, contentItemId);

  const brief = {
    title: item.title,
    platform: item.platform,
    format: item.format,
    audience: item.audience,
    goal: item.goal,
    tone: item.tone,
    currentText: version.body,
  };
  const out = await h.ai.generateStructured({
    system: SYSTEM,
    prompt: [
      untrusted("content_brief", JSON.stringify(brief)),
      h.task.input.instructions ? untrusted("manager_instructions", String(h.task.input.instructions)) : "",
    ].join("\n\n"),
    schema: marketingDraftOutput,
    model: h.agent.model ?? undefined,
    remainingBudgetUsd: h.remainingBudgetUsd,
  });

  const created: number[] = [];
  const ctx = { db: h.db, organizationId: h.org.id, actor: h.actor };
  // The first variant becomes current; the rest are kept as alternative versions.
  for (const [i, v] of out.data.variants.entries()) {
    const hashtags = v.hashtags.map((t) => t.replace(/\s+/g, "")).filter((t) => /^#?[\p{L}\p{N}_]{1,60}$/u.test(t));
    const { version: saved } = await addContentVersion(ctx, contentItemId, { body: v.body, hashtags, cta: v.cta }, {
      source: "ai",
      agentRunId: h.runId,
      makeCurrent: i === 0,
    });
    created.push(saved.versionNumber);
  }
  return {
    kind: "succeeded",
    summary: `تمت كتابة ${created.length} نسخ للمحتوى "${item.title}"`,
    result: { contentItemId, versionNumbers: created, notes: out.data.notes ?? null },
  };
};
