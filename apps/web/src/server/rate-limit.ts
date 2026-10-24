/**
 * Fixed-window, in-memory rate limiter. It limits per server instance only.
 * For several instances (e.g. Vercel scaling out) move this to a shared store;
 * see docs/operations/deployment.md.
 */
const buckets = new Map<string, { count: number; resetAt: number }>();

export function checkRateLimit(key: string, limit: number, windowMs: number, now = Date.now()) {
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    if (buckets.size > 10_000) {
      for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
    }
    return { allowed: true, retryAfterMs: 0 };
  }
  b.count++;
  return { allowed: b.count <= limit, retryAfterMs: b.resetAt - now };
}
