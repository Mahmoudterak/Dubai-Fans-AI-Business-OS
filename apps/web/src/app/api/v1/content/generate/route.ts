import { generateContentBody } from "@dfos/contracts";
import { createTask } from "@dfos/orchestrator";
import { respond, route } from "@/server/api";

/** Queues a Marketing Agent task. Returns 202; the draft appears as new versions when the task succeeds. */
export const POST = route(
  { permission: "content.write", body: generateContentBody, idempotent: true, rateLimit: 20 },
  async ({ ctx, body, idempotencyKey }) => {
    const { task } = await createTask(
      ctx,
      {
        type: "marketing.draft_content",
        title: "كتابة مسودة محتوى بالذكاء الاصطناعي",
        input: { contentItemId: body.contentItemId, instructions: body.instructions },
        priority: "normal",
        dependsOn: [],
      },
      { idempotencyKey },
    );
    return respond(202, { task, statusUrl: `/api/v1/tasks/${task.id}` });
  },
);
