import { createHmac, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEnv } from "@dfos/config";
import {
  EncryptedDbSecretStore,
  inspectImage,
  instagramAspectOk,
  loadKeyRing,
  mediaStorageKey,
  MetaInstagramClient,
  normalizeInstagramWebhook,
  parseSignedRequest,
  safeDisplayName,
  sanitize,
  verifyChallenge,
  verifyMetaSignature,
} from "@dfos/integrations";
import { redact } from "@dfos/observability";
import { freshDb, setupOrg } from "../helpers";
import { makeJpeg } from "../meta-fake";

let t: Awaited<ReturnType<typeof freshDb>>;
beforeAll(async () => {
  t = await freshDb();
});
afterAll(() => t.close());

const keyEnv = (key = randomBytes(32).toString("base64"), extra: Record<string, string> = {}) =>
  getEnv({ NODE_ENV: "test", SECRETS_ENCRYPTION_KEY: key, ...extra });

describe("encrypted secret store", () => {
  it("round-trips, stores only ciphertext, and binds secrets to their org", async () => {
    const A = await setupOrg(t.db);
    const B = await setupOrg(t.db);
    const store = new EncryptedDbSecretStore(t.db, loadKeyRing(keyEnv()));
    const ref = await store.put(A.org.id, "IGAAsecret-value-1234567890abcdef");
    expect(await store.get(A.org.id, ref)).toBe("IGAAsecret-value-1234567890abcdef");
    const raw = await t.client.query<{ ciphertext: string }>("select ciphertext from integration_secrets where ref = $1", [ref]);
    expect(raw.rows[0]!.ciphertext).not.toContain("IGAA");
    await expect(store.get(B.org.id, ref)).rejects.toMatchObject({ code: "not_found" });
  });

  it("detects tampering and wrong keys", async () => {
    const A = await setupOrg(t.db);
    const store = new EncryptedDbSecretStore(t.db, loadKeyRing(keyEnv()));
    const ref = await store.put(A.org.id, "value");
    const other = new EncryptedDbSecretStore(t.db, loadKeyRing(keyEnv()));
    await expect(other.get(A.org.id, ref)).rejects.toMatchObject({ code: "internal_error" });
    await t.client.query("update integration_secrets set ciphertext = $1 where ref = $2", [Buffer.from("tampered").toString("base64"), ref]);
    await expect(store.get(A.org.id, ref)).rejects.toMatchObject({ code: "internal_error" });
  });

  it("supports key rotation through previous keys", async () => {
    const A = await setupOrg(t.db);
    const oldKey = randomBytes(32).toString("base64");
    const v1 = new EncryptedDbSecretStore(t.db, loadKeyRing(keyEnv(oldKey)));
    const ref = await v1.put(A.org.id, "rotate-me");
    const v2 = new EncryptedDbSecretStore(t.db, loadKeyRing(keyEnv(randomBytes(32).toString("base64"), { SECRETS_KEY_VERSION: "2", SECRETS_PREVIOUS_KEYS: `1:${oldKey}` })));
    expect(await v2.get(A.org.id, ref)).toBe("rotate-me");
    await v2.replace(A.org.id, ref, "rotated");
    const raw = await t.client.query<{ key_version: number }>("select key_version from integration_secrets where ref = $1", [ref]);
    expect(raw.rows[0]!.key_version).toBe(2);
  });

  it("refuses to run without a valid key", () => {
    expect(() => loadKeyRing(getEnv({ NODE_ENV: "test" }))).toThrow();
    expect(() => loadKeyRing(getEnv({ NODE_ENV: "test", SECRETS_ENCRYPTION_KEY: "short" }))).toThrow();
  });
});

describe("webhook verification", () => {
  const secret = "s3cret";
  const raw = Buffer.from('{"object":"instagram","entry":[]}');
  const good = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;

  it("accepts only the exact HMAC of the raw body", () => {
    expect(verifyMetaSignature(raw, good, secret)).toBe(true);
    expect(verifyMetaSignature(raw, good.toUpperCase(), secret)).toBe(false);
    expect(verifyMetaSignature(raw, null, secret)).toBe(false);
    expect(verifyMetaSignature(raw, "sha1=abc", secret)).toBe(false);
    expect(verifyMetaSignature(raw, "sha256=zz", secret)).toBe(false);
    expect(verifyMetaSignature(Buffer.from(raw.toString() + " "), good, secret)).toBe(false);
  });

  it("verification handshake echoes the challenge only with the right token", () => {
    const p = (q: string) => new URLSearchParams(q);
    expect(verifyChallenge(p("hub.mode=subscribe&hub.verify_token=tok&hub.challenge=1158201444"), "tok")).toBe("1158201444");
    expect(verifyChallenge(p("hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1"), "tok")).toBeNull();
    expect(verifyChallenge(p("hub.mode=other&hub.verify_token=tok&hub.challenge=1"), "tok")).toBeNull();
    expect(verifyChallenge(p("hub.mode=subscribe&hub.verify_token=tok&hub.challenge=<script>"), "tok")).toBeNull();
    expect(verifyChallenge(p("hub.mode=subscribe&hub.verify_token=&hub.challenge=1"), undefined)).toBeNull();
  });

  it("dedupe keys: message id, object id, or a stable hash", () => {
    const events = normalizeInstagramWebhook({
      object: "instagram",
      entry: [
        { id: "1", time: 5, changes: [{ field: "comments", value: { id: "c9" } }, { field: "mentions", value: { media_id: "m1" } }] },
        { id: "1", time: 6, messaging: [{ sender: { id: "a" }, recipient: { id: "1" }, timestamp: 1, message: { mid: "mid.1", text: "hi" } }] },
      ],
    });
    expect(events.map((e) => e.dedupeKey)).toEqual([
      "ig:1:comments:c9",
      expect.stringMatching(/^ig:1:mentions:h:[a-f0-9]{64}$/),
      "ig:1:messages:mid.1",
    ]);
    const again = normalizeInstagramWebhook({ object: "instagram", entry: [{ id: "1", time: 5, changes: [{ field: "mentions", value: { media_id: "m1" } }] }] });
    expect(again[0]!.dedupeKey).toBe(events[1]!.dedupeKey);
    expect(normalizeInstagramWebhook({ object: "page", entry: [{ id: "1" }] })).toEqual([]);
    expect(normalizeInstagramWebhook("nope")).toEqual([]);
  });

  it("signed_request is verified with the app secret", () => {
    const payload = Buffer.from(JSON.stringify({ algorithm: "HMAC-SHA256", user_id: "42" })).toString("base64url");
    const sig = createHmac("sha256", secret).update(payload).digest("base64url");
    expect(parseSignedRequest(`${sig}.${payload}`, secret)).toMatchObject({ user_id: "42" });
    expect(parseSignedRequest(`${sig}.${payload}`, "other")).toBeNull();
    expect(parseSignedRequest("garbage", secret)).toBeNull();
  });
});

describe("media validation", () => {
  it("accepts JPEG and reads its size; rejects other types, oversize and empty files", () => {
    const info = inspectImage(makeJpeg(1080, 1350), 1024 * 1024);
    expect(info).toMatchObject({ contentType: "image/jpeg", width: 1080, height: 1350 });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(() => inspectImage(png, 1024)).toThrow(/JPEG/);
    expect(() => inspectImage(makeJpeg(10, 10, 2000), 100)).toThrow(/larger/);
    expect(() => inspectImage(new Uint8Array(), 100)).toThrow(/Empty/);
    expect(() => inspectImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 2]), 100)).toThrow(/dimensions/);
  });

  it("Instagram aspect ratio limits and safe names", () => {
    expect(instagramAspectOk(1080, 1350)).toBe(true); // 4:5
    expect(instagramAspectOk(1910, 1000)).toBe(true); // 1.91:1
    expect(instagramAspectOk(1000, 2000)).toBe(false);
    expect(mediaStorageKey("org", "id", "jpg")).toBe("orgs/org/media/id.jpg");
    expect(safeDisplayName("../../etc/passwd<script>.jpg")).not.toMatch(/[/<>]/);
  });
});

describe("Meta client hygiene", () => {
  it("authorize URL follows Business Login for Instagram", () => {
    const c = new MetaInstagramClient({ env: getEnv({ NODE_ENV: "test", META_APP_ID: "99", META_REDIRECT_URI: "https://x.test/cb" }) });
    const u = new URL(c.buildAuthorizeUrl("STATE123"));
    expect(u.host).toBe("www.instagram.com");
    expect(u.searchParams.get("client_id")).toBe("99");
    expect(u.searchParams.get("redirect_uri")).toBe("https://x.test/cb");
    expect(u.searchParams.get("state")).toBe("STATE123");
  });

  it("errors never carry tokens or URLs, and logs redact them", async () => {
    const c = new MetaInstagramClient({
      env: getEnv({ NODE_ENV: "test" }),
      fetch: async () => new Response(JSON.stringify({ error: { message: "bad token IGAAabcdefghijklmnopqrstuv at https://graph.instagram.com/x?access_token=IGAAzzzzzzzzzzzzzzzzzzzz", code: 190 } }), { status: 400 }),
    });
    const err = (await c.getMe("IGAAsecret0000000000000000").catch((e: Error) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toMatch(/IGAA|https?:/);
    expect(sanitize("token EAAabcdefghijklmnopqrstuvwxyz")).not.toContain("EAAabc");
    const logged = JSON.stringify(redact({ msg: "GET /me?access_token=IGAAqqqqqqqqqqqqqqqqqqqqq&fields=id", nested: { client_secret: "x" } }));
    expect(logged).not.toMatch(/IGAAq|"x"/);
  });

  it("network failures are marked retryable and ambiguous", async () => {
    const c = new MetaInstagramClient({ env: getEnv({ NODE_ENV: "test" }), fetch: async () => { throw new TypeError("fetch failed"); } });
    const err = (await c.publishContainer("IGAAtoken", "1", "c").catch((e) => e)) as { retryable: boolean; isAmbiguous: boolean };
    expect(err.retryable).toBe(true);
    expect(err.isAmbiguous).toBe(true);
  });
});
