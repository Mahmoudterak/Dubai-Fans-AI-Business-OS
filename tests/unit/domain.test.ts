import { describe, expect, it } from "vitest";
import {
  actionFingerprint,
  can,
  canTransitionApproval,
  canTransitionTask,
  canonicalJson,
  ROLES,
  TASK_STATUSES,
} from "@dfos/domain";
import { validatePlan } from "@dfos/orchestrator";
import { redact } from "@dfos/observability";
import { getAiConfigStatus, getEnv, isDevAuthAllowed } from "@dfos/config";

describe("task state machine", () => {
  it("allows the happy path and blocks nonsense", () => {
    expect(canTransitionTask("queued", "running")).toBe(true);
    expect(canTransitionTask("running", "succeeded")).toBe(true);
    expect(canTransitionTask("running", "waiting_approval")).toBe(true);
    expect(canTransitionTask("waiting_approval", "queued")).toBe(true);
    expect(canTransitionTask("queued", "succeeded")).toBe(false);
    expect(canTransitionTask("waiting_approval", "succeeded")).toBe(false);
    expect(canTransitionTask("cancelled", "queued")).toBe(false);
  });
  it("terminal states have no exits", () => {
    for (const to of TASK_STATUSES) {
      expect(canTransitionTask("succeeded", to)).toBe(false);
      expect(canTransitionTask("cancelled", to)).toBe(false);
    }
  });
});

describe("approval state machine", () => {
  it("rejected can never become approved; executed is final", () => {
    expect(canTransitionApproval("rejected", "approved")).toBe(false);
    expect(canTransitionApproval("executed", "approved")).toBe(false);
    expect(canTransitionApproval("executed", "executed")).toBe(false);
    expect(canTransitionApproval("pending", "executed")).toBe(false); // must be approved first
    expect(canTransitionApproval("approved", "executed")).toBe(true);
  });
});

describe("fingerprints", () => {
  it("ignores key order but not values", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
    const a = actionFingerprint("content.publish", { body: "x", budget: 10 });
    expect(actionFingerprint("content.publish", { budget: 10, body: "x" })).toBe(a);
    expect(actionFingerprint("content.publish", { body: "x", budget: 11 })).not.toBe(a);
    expect(actionFingerprint("messages.send", { body: "x", budget: 10 })).not.toBe(a);
  });
});

describe("RBAC", () => {
  it("only owner, admin and approver can decide approvals", () => {
    const deciders = ROLES.filter((r) => can(r, "approvals.decide"));
    expect(deciders.sort()).toEqual(["admin", "approver", "owner"]);
  });
  it("viewers are read-only", () => {
    expect(can("viewer", "tasks.create")).toBe(false);
    expect(can("viewer", "content.write")).toBe(false);
    expect(can("viewer", "tasks.read")).toBe(true);
  });
  it("only owners manage the organization", () => {
    expect(can("admin", "org.manage")).toBe(false);
    expect(can("owner", "org.manage")).toBe(true);
  });
});

describe("log redaction", () => {
  it("hides secrets by key and by value pattern", () => {
    const out = redact({
      accessToken: "abc",
      nested: { apiKey: "k", ok: "visible" },
      header: "Bearer eyJhbGciOi.payload.sig",
      text: "key sk-ant-abcdefghijklmnopqrstuvwxyz",
    }) as Record<string, unknown>;
    expect(out.accessToken).toBe("[REDACTED]");
    expect((out.nested as Record<string, unknown>).apiKey).toBe("[REDACTED]");
    expect((out.nested as Record<string, unknown>).ok).toBe("visible");
    expect(out.header).not.toContain("eyJ");
    expect(out.text).not.toContain("abcdefghijklmnop");
  });
});

describe("config", () => {
  it("reports why AI is not configured", () => {
    expect(getAiConfigStatus(getEnv({ NODE_ENV: "development" }))).toEqual({ configured: false, reason: "AI_PROVIDER is not set" });
    expect(getAiConfigStatus(getEnv({ NODE_ENV: "development", AI_PROVIDER: "anthropic" })).configured).toBe(false);
    expect(
      getAiConfigStatus(getEnv({ NODE_ENV: "development", AI_PROVIDER: "anthropic", AI_GATEWAY_API_KEY: "x", AI_DEFAULT_MODEL: "m" })).configured,
    ).toBe(true);
  });
  it("mock provider and dev auth are refused outside their environments", () => {
    expect(getAiConfigStatus(getEnv({ NODE_ENV: "production", AI_PROVIDER: "mock" })).configured).toBe(false);
    expect(isDevAuthAllowed(getEnv({ NODE_ENV: "production", DEV_AUTH_ENABLED: "true" }))).toBe(false);
    expect(isDevAuthAllowed(getEnv({ NODE_ENV: "development" }))).toBe(true);
  });
});

describe("CEO plan validation", () => {
  const sub = (o: Partial<{ title: string; agent: string; type: string; input: Record<string, unknown>; dependsOnIndex: number[] }>) => ({
    title: "t",
    agent: "operations",
    type: "operations.health_check",
    rationale: "",
    input: {},
    dependsOnIndex: [],
    ...o,
  });
  it("drops unknown types, wrong agents, bad input, unknown content and orphaned dependents", () => {
    const { accepted, rejected } = validatePlan(
      [
        sub({ title: "ok" }),
        sub({ title: "wrong agent", agent: "finance" }),
        sub({ title: "bad type", type: "shell.exec" }),
        sub({ title: "bad input", agent: "finance", type: "finance.ai_usage_report", input: { days: 999 } }),
        sub({ title: "unknown content", agent: "marketing", type: "marketing.draft_content", input: { contentItemId: "00000000-0000-4000-8000-000000000000" } }),
        sub({ title: "depends on rejected", dependsOnIndex: [2] }),
        sub({ title: "depends on ok", agent: "finance", type: "finance.ai_usage_report", input: { days: 7 }, dependsOnIndex: [0] }),
      ],
      new Set(),
    );
    expect(accepted.map((a) => a.title)).toEqual(["ok", "depends on ok"]);
    expect(accepted[1]!.dependsOnIndex).toEqual([0]);
    expect(rejected).toHaveLength(5);
  });
});
