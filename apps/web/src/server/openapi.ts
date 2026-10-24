import { z } from "zod";
import {
  approvalDecisionBody,
  attachMediaBody,
  contentVersionBody,
  updateConnectionBody,
  createContentBody,
  createTaskBody,
  generateContentBody,
  requestChangesBody,
  scheduleContentBody,
  updateAgentBody,
  updateOrgSettingsBody,
} from "@dfos/contracts";

const schema = (s: z.ZodType) => z.toJSONSchema(s, { io: "input", unrepresentable: "any" });

type Op = {
  summary: string;
  permission?: string;
  body?: z.ZodType;
  ok?: number;
  idempotent?: boolean;
  errors?: number[];
};

const ops: Record<string, Partial<Record<"get" | "post" | "patch", Op>>> = {
  "/health": { get: { summary: "Liveness and database check (public)" } },
  "/me": { get: { summary: "Current user, active organization and role" } },
  "/dashboard": { get: { summary: "Dashboard figures from the database", permission: "org.read" } },
  "/agents": { get: { summary: "List agents with real availability", permission: "agents.read" } },
  "/agents/{key}": {
    get: { summary: "Agent details", permission: "agents.read" },
    patch: { summary: "Enable/disable an agent (kill switch) or change limits", permission: "agents.manage", body: updateAgentBody, idempotent: true },
  },
  "/agents/{key}/runs": { get: { summary: "Agent run history", permission: "agents.read" } },
  "/tasks": {
    get: { summary: "List tasks (filter: status, agent, q; limit/offset)", permission: "tasks.read" },
    post: { summary: "Create a task. Runs in the background worker.", permission: "tasks.create", body: createTaskBody, ok: 202, idempotent: true },
  },
  "/tasks/{id}": { get: { summary: "Task with subtasks, dependencies and runs", permission: "tasks.read" } },
  "/tasks/{id}/events": { get: { summary: "Task event log", permission: "tasks.read" } },
  "/tasks/{id}/cancel": { post: { summary: "Cancel a queued, retrying or waiting task", permission: "tasks.cancel", idempotent: true, errors: [409] } },
  "/tasks/{id}/retry": { post: { summary: "Retry a failed task", permission: "tasks.create", idempotent: true, errors: [409] } },
  "/approvals": { get: { summary: "List approval requests", permission: "approvals.read" } },
  "/approvals/{id}": { get: { summary: "Approval with history and staleness flag", permission: "approvals.read" } },
  "/approvals/{id}/approve": { post: { summary: "Approve the exact fingerprint you reviewed", permission: "approvals.decide", body: approvalDecisionBody, idempotent: true, errors: [409] } },
  "/approvals/{id}/reject": { post: { summary: "Reject", permission: "approvals.decide", body: approvalDecisionBody, idempotent: true, errors: [409] } },
  "/approvals/{id}/request-changes": { post: { summary: "Request changes (note required)", permission: "approvals.decide", body: requestChangesBody, idempotent: true, errors: [409] } },
  "/content": {
    get: { summary: "List content items with current version", permission: "content.read" },
    post: { summary: "Create a content item with its first version", permission: "content.write", body: createContentBody, ok: 201, idempotent: true },
  },
  "/content/generate": { post: { summary: "Queue the Marketing Agent to draft versions", permission: "content.write", body: generateContentBody, ok: 202, idempotent: true } },
  "/content/{id}": { get: { summary: "Content with versions, approvals and publishing availability", permission: "content.read" } },
  "/content/{id}/versions": { post: { summary: "Save a new version (voids open approvals)", permission: "content.write", body: contentVersionBody, ok: 201, idempotent: true } },
  "/content/{id}/versions/{versionId}/select": { post: { summary: "Make a version current (voids open approvals)", permission: "content.write", idempotent: true } },
  "/content/{id}/submit": { post: { summary: "Submit current version for approval", permission: "content.write", ok: 201, idempotent: true, errors: [409] } },
  "/content/{id}/schedule": { post: { summary: "Set publish time (voids open approvals)", permission: "content.write", body: scheduleContentBody, idempotent: true } },
  "/content/{id}/publish": {
    post: {
      summary: "Start publishing approved content (checks run first; approval consumed once; worker confirms with Instagram)",
      permission: "content.publish",
      idempotent: true,
      errors: [409],
    },
  },
  "/integrations": { get: { summary: "Configuration readiness and real connections (no secrets)", permission: "integrations.read" } },
  "/integrations/meta/connect": { post: { summary: "Form POST: starts Instagram OAuth (303 to instagram.com, sets state cookie)", permission: "integrations.manage" } },
  "/integrations/meta/callback": { get: { summary: "OAuth callback: validates state + cookie, exchanges code server-side, 303 to /integrations" } },
  "/integrations/{id}": {
    get: { summary: "Connection details", permission: "integrations.read" },
    patch: { summary: "Pause/resume a connection (kill switch)", permission: "integrations.manage", body: updateConnectionBody, idempotent: true },
  },
  "/integrations/{id}/status": { get: { summary: "Connection status, scopes, token expiry, last error", permission: "integrations.read" } },
  "/integrations/{id}/sync": { post: { summary: "Re-read profile and 24h publishing quota", permission: "integrations.manage", idempotent: true, errors: [409] } },
  "/integrations/{id}/disconnect": { post: { summary: "Delete stored token and disconnect", permission: "integrations.manage", idempotent: true } },
  "/webhooks/meta": {
    get: { summary: "Meta verification handshake (hub.challenge); public" },
    post: { summary: "Meta events; X-Hub-Signature-256 required; 200 only after storing; public", errors: [401] },
  },
  "/webhooks/meta/deauthorize": { post: { summary: "Meta deauthorize callback (signed_request); public" } },
  "/webhooks/meta/data-deletion": { post: { summary: "Meta data deletion callback (signed_request) → { url, confirmation_code }; public" } },
  "/media": {
    get: { summary: "List uploaded images", permission: "content.read" },
    post: { summary: "Upload a JPEG (multipart field 'file'); stored privately", permission: "content.write", ok: 201 },
  },
  "/media/{id}": { get: { summary: "Image metadata and a 5-minute private preview link", permission: "content.read" } },
  "/content/{id}/media": { post: { summary: "Attach/remove the image (new version; voids open approvals)", permission: "content.write", body: attachMediaBody, ok: 201, idempotent: true } },
  "/audit": { get: { summary: "Append-only audit log", permission: "audit.read" } },
  "/settings": {
    get: { summary: "Organization settings", permission: "org.read" },
    patch: { summary: "Update settings: agentsPaused (kill switch), AI monthly budget, time zone", permission: "org.manage", body: updateOrgSettingsBody, idempotent: true },
  },
  "/members": { get: { summary: "Organization members", permission: "org.read" } },
};

const errorSchema = {
  type: "object",
  properties: {
    error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" }, details: {} }, required: ["code", "message"] },
    requestId: { type: "string" },
  },
};

export function buildOpenApi(baseUrl: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [path, methods] of Object.entries(ops)) {
    paths[path] = {};
    for (const [method, op] of Object.entries(methods)) {
      const params = [...path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string" } }));
      const responses: Record<string, unknown> = {
        [String(op!.ok ?? 200)]: { description: "Success. Body: { data, requestId }" },
        401: { description: "Not signed in", content: { "application/json": { schema: errorSchema } } },
        403: { description: "Missing permission or cross-origin request", content: { "application/json": { schema: errorSchema } } },
        404: { description: "Not found (also returned for other organizations' records)" },
        422: { description: "Validation failed" },
        429: { description: "Rate limited" },
      };
      for (const code of op!.errors ?? []) responses[String(code)] = { description: "Conflict: invalid state, approval invalid, or idempotency conflict", content: { "application/json": { schema: errorSchema } } };
      paths[path][method] = {
        summary: op!.summary,
        description: op!.permission ? `Requires permission \`${op!.permission}\`.` : undefined,
        parameters: [
          ...params,
          ...(op!.idempotent ? [{ name: "Idempotency-Key", in: "header", required: false, schema: { type: "string", minLength: 8, maxLength: 128 } }] : []),
        ],
        ...(op!.body ? { requestBody: { required: true, content: { "application/json": { schema: schema(op!.body) } } } } : {}),
        responses,
      };
    }
  }
  return {
    openapi: "3.1.0",
    info: { title: "Dubai Fans AI Business OS API", version: "1.0.0" },
    servers: [{ url: `${baseUrl}/api/v1` }],
    components: { securitySchemes: { session: { type: "apiKey", in: "cookie", name: "__session" } } },
    security: [{ session: [] }],
    paths,
  };
}
