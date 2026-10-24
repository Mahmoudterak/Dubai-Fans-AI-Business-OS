import { createHash } from "node:crypto";

/** Deterministic JSON: object keys sorted recursively, undefined dropped. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/**
 * Fingerprint of the exact action a human reviewed. Any change to the payload
 * (text, audience, budget, target account, schedule) gives a different hash,
 * which invalidates the approval at execution time.
 */
export function actionFingerprint(actionType: string, payload: unknown): string {
  return createHash("sha256")
    .update(actionType)
    .update("\n")
    .update(canonicalJson(payload))
    .digest("hex");
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
