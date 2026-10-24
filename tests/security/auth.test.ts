import { afterEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "@dfos/config";
import { createDevSessionToken, verifyDevSessionToken } from "@dfos/auth";

const ORIGINAL = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL };
  resetEnvCache();
});

describe("dev session tokens", () => {
  it("round-trips a valid token", () => {
    const token = createDevSessionToken("11111111-1111-4111-8111-111111111111");
    expect(verifyDevSessionToken(token)).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("rejects tampered and expired tokens", () => {
    const token = createDevSessionToken("11111111-1111-4111-8111-111111111111");
    const [payload, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "22222222-2222-4222-8222-222222222222", exp: 9999999999 })).toString("base64url");
    expect(verifyDevSessionToken(`${forged}.${sig}`)).toBeNull();
    expect(verifyDevSessionToken(`${payload}.x${sig}`)).toBeNull();
    expect(verifyDevSessionToken(token, Date.now() + 13 * 3600_000)).toBeNull();
    expect(verifyDevSessionToken(undefined)).toBeNull();
  });

  it("is refused entirely in production", () => {
    const token = createDevSessionToken("11111111-1111-4111-8111-111111111111");
    process.env.NODE_ENV = "production";
    resetEnvCache();
    expect(verifyDevSessionToken(token)).toBeNull();
    expect(() => createDevSessionToken("11111111-1111-4111-8111-111111111111")).toThrow();
  });

  it("is refused when Clerk is configured", () => {
    const token = createDevSessionToken("11111111-1111-4111-8111-111111111111");
    process.env.CLERK_SECRET_KEY = "sk_test_x";
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_x";
    resetEnvCache();
    expect(verifyDevSessionToken(token)).toBeNull();
  });
});
