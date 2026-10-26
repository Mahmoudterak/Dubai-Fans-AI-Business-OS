import { createServer, type Server } from "node:http";

/**
 * Liveness for hosts that need an HTTP port (e.g. a Render Web Service).
 * Healthy = every loop finished an iteration without a database error recently.
 * Returns no tenant data.
 */
export class WorkerHealth {
  private readonly lastOk = new Map<string, number>();
  private readonly startedAt = Date.now();

  constructor(
    private readonly loops: string[],
    private readonly staleAfterMs = 3 * 60_000,
  ) {}

  ok(loop: string) {
    this.lastOk.set(loop, Date.now());
  }

  snapshot(extra: Record<string, unknown> = {}) {
    const now = Date.now();
    const loops = Object.fromEntries(
      this.loops.map((l) => {
        const at = this.lastOk.get(l);
        // A loop that never succeeded is only unhealthy once the grace period has passed.
        const age = at ? now - at : now - this.startedAt;
        return [l, { ageSeconds: Math.round(age / 1000), healthy: age <= this.staleAfterMs }];
      }),
    );
    const healthy = Object.values(loops).every((l) => l.healthy);
    return { status: healthy ? "ok" : "degraded", uptimeSeconds: Math.round((now - this.startedAt) / 1000), loops, ...extra };
  }

  listen(port: number, extra: () => Record<string, unknown>): Server {
    const server = createServer((req, res) => {
      if (req.method === "GET" && (req.url === "/healthz" || req.url === "/")) {
        const body = this.snapshot(extra());
        res.writeHead(body.status === "ok" ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(body));
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
    });
    // No host: listens on all interfaces, IPv4 and IPv6 (Render needs 0.0.0.0; local tools may use ::1).
    server.listen(port);
    return server;
  }
}
