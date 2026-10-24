import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditLogs, integrationConnections, integrationSecrets, oauthStates } from "@dfos/db";
import { resetEnvCache } from "@dfos/config";
import { EncryptedDbSecretStore } from "@dfos/integrations";
import {
  completeMetaConnect,
  disconnectConnection,
  listConnections,
  refreshExpiringTokens,
  revokeByExternalAccount,
  startMetaConnect,
  syncConnection,
} from "@dfos/orchestrator";
import { freshDb, setupOrg } from "../helpers";
import { FakeGraph, setMetaTestEnv } from "../meta-fake";

let t: Awaited<ReturnType<typeof freshDb>>;
let graph: FakeGraph;
beforeAll(async () => {
  setMetaTestEnv();
  t = await freshDb();
});
afterAll(() => t.close());
beforeEach(() => {
  setMetaTestEnv();
  graph = new FakeGraph();
});

const deps = () => ({ client: graph.client() });
const callback = (state: string, extra: Partial<{ code: string | null; error: string | null; errorReason: string | null; stateCookie: string | null }> = {}) => ({
  state,
  stateCookie: state,
  code: "AQB-test-code",
  error: null,
  errorReason: null,
  ...extra,
});

describe("Instagram OAuth", () => {
  it("connects: state is stored hashed, token is encrypted, nothing secret is returned", async () => {
    const { ctx, org } = await setupOrg(t.db);
    const { state, authorizeUrl } = await startMetaConnect(ctx("admin"), deps());
    const url = new URL(authorizeUrl);
    expect(url.origin + url.pathname).toBe("https://www.instagram.com/oauth/authorize");
    expect(url.searchParams.get("state")).toBe(state);
    expect(url.searchParams.get("scope")).toBe("instagram_business_basic,instagram_business_content_publish");
    expect(url.searchParams.get("response_type")).toBe("code");

    const rows = await t.db.select().from(oauthStates).where(eq(oauthStates.organizationId, org.id));
    expect(rows[0]!.stateHash).not.toBe(state);
    expect(rows[0]!.stateHash).toMatch(/^[a-f0-9]{64}$/);

    const conn = await completeMetaConnect(ctx("admin"), callback(state), deps());
    expect(conn.username).toBe(graph.username);
    expect(conn.canPublish).toBe(true);
    expect(conn).not.toHaveProperty("secretRef");
    expect(JSON.stringify(conn)).not.toMatch(/IGAA/);

    const [stored] = await t.db.select().from(integrationConnections).where(eq(integrationConnections.id, conn.id));
    expect(JSON.stringify(stored)).not.toMatch(/IGAA/);
    const secrets = await t.db.select().from(integrationSecrets).where(eq(integrationSecrets.organizationId, org.id));
    expect(secrets).toHaveLength(1);
    expect(JSON.stringify(secrets[0])).not.toMatch(/IGAA/);
    const token = await new EncryptedDbSecretStore(t.db).get(org.id, stored!.secretRef!);
    expect(token).toMatch(/^IGAAlong/);

    const audit = await t.db.select().from(auditLogs).where(eq(auditLogs.organizationId, org.id));
    expect(JSON.stringify(audit)).not.toMatch(/IGAA/);
    expect(audit.map((a) => a.action)).toContain("integration.connected");
    // The code is exchanged server-side for a long-lived token.
    expect(graph.calls).toContain("POST api.instagram.com/oauth/access_token");
    expect(graph.calls).toContain("GET graph.instagram.com/access_token");
  });

  it("a state can be used only once", async () => {
    const { ctx } = await setupOrg(t.db);
    const { state } = await startMetaConnect(ctx("admin"), deps());
    await completeMetaConnect(ctx("admin"), callback(state), deps());
    await expect(completeMetaConnect(ctx("admin"), callback(state), deps())).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rejects a state that does not match the browser cookie (CSRF)", async () => {
    const { ctx } = await setupOrg(t.db);
    const { state } = await startMetaConnect(ctx("admin"), deps());
    await expect(completeMetaConnect(ctx("admin"), callback(state, { stateCookie: "x".repeat(43) }), deps())).rejects.toMatchObject({ code: "forbidden" });
    await expect(completeMetaConnect(ctx("admin"), callback(state, { stateCookie: null }), deps())).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rejects expired, unknown and malformed states", async () => {
    const { ctx, org } = await setupOrg(t.db);
    const { state } = await startMetaConnect(ctx("admin"), deps());
    await t.db.update(oauthStates).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(oauthStates.organizationId, org.id));
    await expect(completeMetaConnect(ctx("admin"), callback(state), deps())).rejects.toMatchObject({ code: "forbidden" });
    await expect(completeMetaConnect(ctx("admin"), callback("U".repeat(43)), deps())).rejects.toMatchObject({ code: "forbidden" });
    await expect(completeMetaConnect(ctx("admin"), callback("bad"), deps())).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rejects a callback finished by a different user or organization", async () => {
    const A = await setupOrg(t.db);
    const B = await setupOrg(t.db);
    const { state } = await startMetaConnect(A.ctx("admin"), deps());
    await expect(completeMetaConnect(A.ctx("owner"), callback(state), deps())).rejects.toMatchObject({ code: "forbidden" });
    const { state: s2 } = await startMetaConnect(A.ctx("admin"), deps());
    await expect(completeMetaConnect(B.ctx("admin"), callback(s2), deps())).rejects.toMatchObject({ code: "forbidden" });
  });

  it("members and viewers cannot start a connection", async () => {
    const { ctx } = await setupOrg(t.db);
    await expect(startMetaConnect(ctx("member"), deps())).rejects.toMatchObject({ code: "forbidden" });
    await expect(startMetaConnect(ctx("viewer"), deps())).rejects.toMatchObject({ code: "forbidden" });
  });

  it("user denial consumes the state and stores nothing", async () => {
    const { ctx, org } = await setupOrg(t.db);
    const { state } = await startMetaConnect(ctx("admin"), deps());
    await expect(
      completeMetaConnect(ctx("admin"), callback(state, { code: null, error: "access_denied", errorReason: "user_denied" }), deps()),
    ).rejects.toMatchObject({ code: "integration_not_connected" });
    expect(await listConnections(ctx("admin"))).toHaveLength(0);
    const [s] = await t.db.select().from(oauthStates).where(eq(oauthStates.organizationId, org.id));
    expect(s!.usedAt).not.toBeNull();
  });

  it("Meta rejecting the code is reported clearly and stores nothing", async () => {
    const { ctx } = await setupOrg(t.db);
    const { state } = await startMetaConnect(ctx("admin"), deps());
    await expect(completeMetaConnect(ctx("admin"), callback(state, { code: "bad" }), deps())).rejects.toMatchObject({ code: "integration_error" });
    expect(await listConnections(ctx("admin"))).toHaveLength(0);
  });

  it("the basic permission is required", async () => {
    const { ctx } = await setupOrg(t.db);
    graph.permissions = ["instagram_business_content_publish"];
    const { state } = await startMetaConnect(ctx("admin"), deps());
    await expect(completeMetaConnect(ctx("admin"), callback(state), deps())).rejects.toMatchObject({ code: "integration_missing_permission" });
  });

  it("without the publish permission the account connects but cannot publish", async () => {
    const { ctx } = await setupOrg(t.db);
    graph.permissions = ["instagram_business_basic"];
    const { state } = await startMetaConnect(ctx("admin"), deps());
    const conn = await completeMetaConnect(ctx("admin"), callback(state), deps());
    expect(conn.canPublish).toBe(false);
  });

  it("an account already connected to another organization is refused", async () => {
    const A = await setupOrg(t.db);
    const B = await setupOrg(t.db);
    const { state } = await startMetaConnect(A.ctx("admin"), deps());
    await completeMetaConnect(A.ctx("admin"), callback(state), deps());
    const { state: s2 } = await startMetaConnect(B.ctx("admin"), deps());
    await expect(completeMetaConnect(B.ctx("admin"), callback(s2), deps())).rejects.toMatchObject({ code: "conflict" });
    // Org B cannot see A's connection.
    expect(await listConnections(B.ctx("admin"))).toHaveLength(0);
  });

  it("reconnecting replaces the token in place; disconnecting deletes it", async () => {
    const { ctx, org } = await setupOrg(t.db);
    const { state } = await startMetaConnect(ctx("admin"), deps());
    const first = await completeMetaConnect(ctx("admin"), callback(state), deps());
    const { state: s2 } = await startMetaConnect(ctx("admin"), deps());
    const second = await completeMetaConnect(ctx("admin"), callback(s2), deps());
    expect(second.id).toBe(first.id);
    expect(await t.db.select().from(integrationSecrets).where(eq(integrationSecrets.organizationId, org.id))).toHaveLength(1);

    const off = await disconnectConnection(ctx("admin"), first.id);
    expect(off.status).toBe("disconnected");
    expect(await t.db.select().from(integrationSecrets).where(eq(integrationSecrets.organizationId, org.id))).toHaveLength(0);
    await expect(syncConnection(ctx("admin"), first.id, deps())).rejects.toMatchObject({ code: "integration_not_connected" });
  });

  it("sync detects a revoked token and asks for reauthorization", async () => {
    const { ctx, org } = await setupOrg(t.db);
    const { state } = await startMetaConnect(ctx("admin"), deps());
    const conn = await completeMetaConnect(ctx("admin"), callback(state), deps());
    const [row] = await t.db.select().from(integrationConnections).where(eq(integrationConnections.id, conn.id));
    await new EncryptedDbSecretStore(t.db).replace(org.id, row!.secretRef!, "IGAArevoked-token-xxxxxxxxxxxxxxxx");
    await expect(syncConnection(ctx("admin"), conn.id, deps())).rejects.toMatchObject({ code: "integration_reauth_required" });
    const [after] = await t.db.select().from(integrationConnections).where(eq(integrationConnections.id, conn.id));
    expect(after!.status).toBe("expired");
  });

  it("refreshes tokens that expire soon and are at least a day old", async () => {
    const { ctx } = await setupOrg(t.db);
    const { state } = await startMetaConnect(ctx("admin"), deps());
    const conn = await completeMetaConnect(ctx("admin"), callback(state), deps());
    await t.db
      .update(integrationConnections)
      .set({ tokenObtainedAt: new Date(Date.now() - 50 * 86400_000), tokenExpiresAt: new Date(Date.now() + 3 * 86400_000) })
      .where(eq(integrationConnections.id, conn.id));
    expect(await refreshExpiringTokens(t.db, deps())).toBeGreaterThanOrEqual(1);
    const [after] = await t.db.select().from(integrationConnections).where(eq(integrationConnections.id, conn.id));
    expect(after!.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 50 * 86400_000);
  });

  it("deauthorize callback revokes the connection and deletes the token", async () => {
    const { ctx, org } = await setupOrg(t.db);
    const { state } = await startMetaConnect(ctx("admin"), deps());
    const conn = await completeMetaConnect(ctx("admin"), callback(state), deps());
    expect(await revokeByExternalAccount(t.db, graph.igUserId, "test")).toBe(1);
    const [after] = await t.db.select().from(integrationConnections).where(eq(integrationConnections.id, conn.id));
    expect(after!.status).toBe("revoked");
    expect(after!.secretRef).toBeNull();
    expect(await t.db.select().from(integrationSecrets).where(eq(integrationSecrets.organizationId, org.id))).toHaveLength(0);
  });

  it("missing configuration is reported, not faked", async () => {
    const { ctx } = await setupOrg(t.db);
    process.env.META_APP_SECRET = "";
    resetEnvCache();
    await expect(startMetaConnect(ctx("admin"), deps())).rejects.toMatchObject({ code: "integration_not_connected" });
  });
});
