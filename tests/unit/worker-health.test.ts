import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerHealth } from "../../apps/worker/src/health";

afterEach(() => vi.useRealTimers());

describe("worker health", () => {
  it("is healthy while every loop keeps reporting, degraded once one goes stale", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-26T00:00:00Z"));
    const h = new WorkerHealth(["queue", "maintenance"], 60_000);
    h.ok("queue");
    h.ok("maintenance");
    expect(h.snapshot().status).toBe("ok");

    vi.advanceTimersByTime(45_000);
    h.ok("queue"); // queue keeps working, maintenance stops reporting
    vi.advanceTimersByTime(30_000);
    const s = h.snapshot();
    expect(s.status).toBe("degraded");
    expect(s.loops.queue!.healthy).toBe(true);
    expect(s.loops.maintenance!.healthy).toBe(false);
  });

  it("gives loops a grace period after start before reporting them unhealthy", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-26T00:00:00Z"));
    const h = new WorkerHealth(["queue"], 60_000);
    expect(h.snapshot().status).toBe("ok");
    vi.advanceTimersByTime(61_000);
    expect(h.snapshot().status).toBe("degraded");
  });
});
