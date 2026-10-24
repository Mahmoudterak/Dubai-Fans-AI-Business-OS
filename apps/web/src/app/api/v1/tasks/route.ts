import { createTaskBody, listTasksQuery } from "@dfos/contracts";
import { createTask, listTasks } from "@dfos/orchestrator";
import { respond, route } from "@/server/api";

export const GET = route({ permission: "tasks.read", query: listTasksQuery }, ({ ctx, query }) => listTasks(ctx, query));

/** Tasks run in the background worker: 202 Accepted, then poll GET /tasks/:id. */
export const POST = route(
  { permission: "tasks.create", body: createTaskBody, idempotent: true, rateLimit: 30 },
  async ({ ctx, body, idempotencyKey }) => {
    const { task, deduplicated } = await createTask(ctx, body, { idempotencyKey });
    return respond(deduplicated ? 200 : 202, { task, statusUrl: `/api/v1/tasks/${task.id}` });
  },
);
