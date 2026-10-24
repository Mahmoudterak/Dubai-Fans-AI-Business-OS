import { describe, expect, it } from "vitest";
import { buildOpenApi } from "../../apps/web/src/server/openapi";
import { checkRateLimit } from "../../apps/web/src/server/rate-limit";

describe("OpenAPI document", () => {
  const doc = buildOpenApi("http://localhost:3000");

  it("documents every required /api/v1 route from the spec", () => {
    const required = [
      ["/agents", "get"],
      ["/agents/{key}", "get"],
      ["/agents/{key}/runs", "get"],
      ["/tasks", "post"],
      ["/tasks", "get"],
      ["/tasks/{id}", "get"],
      ["/tasks/{id}/events", "get"],
      ["/tasks/{id}/cancel", "post"],
      ["/approvals", "get"],
      ["/approvals/{id}", "get"],
      ["/approvals/{id}/approve", "post"],
      ["/approvals/{id}/reject", "post"],
      ["/approvals/{id}/request-changes", "post"],
      ["/content", "get"],
      ["/content", "post"],
      ["/content/generate", "post"],
      ["/content/{id}/submit", "post"],
      ["/content/{id}/schedule", "post"],
      ["/content/{id}/publish", "post"],
      ["/integrations", "get"],
    ] as const;
    for (const [path, method] of required) {
      expect(doc.paths[path]?.[method], `${method.toUpperCase()} ${path}`).toBeDefined();
    }
  });

  it("task creation is documented as 202 with an Idempotency-Key header and a JSON schema body", () => {
    const op = doc.paths["/tasks"]!.post as { responses: Record<string, unknown>; parameters: Array<{ name: string }>; requestBody: { content: Record<string, { schema: { properties?: object } }> } };
    expect(op.responses["202"]).toBeDefined();
    expect(op.parameters.map((p) => p.name)).toContain("Idempotency-Key");
    expect(op.requestBody.content["application/json"]!.schema.properties).toHaveProperty("type");
  });
});

describe("rate limiter", () => {
  it("allows up to the limit per window, then blocks until the window resets", () => {
    const key = `k-${Math.random()}`;
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) expect(checkRateLimit(key, 3, 60_000, t0).allowed).toBe(true);
    const blocked = checkRateLimit(key, 3, 60_000, t0 + 1000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBe(59_000);
    expect(checkRateLimit(key, 3, 60_000, t0 + 60_001).allowed).toBe(true);
  });
});
