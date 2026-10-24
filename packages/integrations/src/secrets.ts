import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getEnv, isSecretsKeyValid, type ServerEnv } from "@dfos/config";
import { integrationSecrets, type Database } from "@dfos/db";
import { AppError } from "@dfos/domain";

/**
 * Where integration credentials live. Callers only ever hold an opaque `ref`.
 * Values never appear in API responses, logs or plain database columns.
 */
export interface SecretStore {
  put(organizationId: string, value: string): Promise<string>;
  get(organizationId: string, ref: string): Promise<string>;
  replace(organizationId: string, ref: string, value: string): Promise<void>;
  delete(organizationId: string, ref: string): Promise<void>;
}

interface KeyRing {
  current: { version: number; key: Buffer };
  byVersion: Map<number, Buffer>;
}

export function loadKeyRing(env: ServerEnv = getEnv()): KeyRing {
  if (!isSecretsKeyValid(env)) {
    throw new AppError("integration_not_connected", "SECRETS_ENCRYPTION_KEY is missing or not 32 bytes (base64)");
  }
  const current = { version: env.SECRETS_KEY_VERSION, key: Buffer.from(env.SECRETS_ENCRYPTION_KEY!, "base64") };
  const byVersion = new Map<number, Buffer>([[current.version, current.key]]);
  for (const part of (env.SECRETS_PREVIOUS_KEYS ?? "").split(",").filter(Boolean)) {
    const [v, k] = part.split(":");
    const key = Buffer.from(k ?? "", "base64");
    if (v && key.length === 32) byVersion.set(Number(v), key);
  }
  return { current, byVersion };
}

/**
 * AES-256-GCM envelope stored in `integration_secrets`. The key is outside the database
 * (environment / host secret manager), and the organization id and ref are bound as
 * additional authenticated data, so a ciphertext cannot be moved to another org or row.
 */
export class EncryptedDbSecretStore implements SecretStore {
  private readonly keys: KeyRing;
  constructor(
    private readonly db: Database,
    keys?: KeyRing,
  ) {
    this.keys = keys ?? loadKeyRing();
  }

  private encrypt(organizationId: string, ref: string, value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.keys.current.key, iv);
    cipher.setAAD(Buffer.from(`${organizationId}:${ref}`));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return {
      keyVersion: this.keys.current.version,
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
  }

  async put(organizationId: string, value: string) {
    const ref = `sec_${randomUUID()}`;
    await this.db.insert(integrationSecrets).values({ ref, organizationId, ...this.encrypt(organizationId, ref, value) });
    return ref;
  }

  async get(organizationId: string, ref: string) {
    const [row] = await this.db
      .select()
      .from(integrationSecrets)
      .where(and(eq(integrationSecrets.ref, ref), eq(integrationSecrets.organizationId, organizationId)));
    if (!row) throw new AppError("not_found", "Secret not found");
    const key = this.keys.byVersion.get(row.keyVersion);
    if (!key) throw new AppError("internal_error", `No key for secret version ${row.keyVersion}`);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(row.iv, "base64"));
    decipher.setAAD(Buffer.from(`${organizationId}:${ref}`));
    decipher.setAuthTag(Buffer.from(row.authTag, "base64"));
    try {
      return Buffer.concat([decipher.update(Buffer.from(row.ciphertext, "base64")), decipher.final()]).toString("utf8");
    } catch {
      throw new AppError("internal_error", "Secret could not be decrypted (wrong key or tampered data)");
    }
  }

  async replace(organizationId: string, ref: string, value: string) {
    const [row] = await this.db
      .update(integrationSecrets)
      .set(this.encrypt(organizationId, ref, value))
      .where(and(eq(integrationSecrets.ref, ref), eq(integrationSecrets.organizationId, organizationId)))
      .returning({ ref: integrationSecrets.ref });
    if (!row) throw new AppError("not_found", "Secret not found");
  }

  async delete(organizationId: string, ref: string) {
    await this.db
      .delete(integrationSecrets)
      .where(and(eq(integrationSecrets.ref, ref), eq(integrationSecrets.organizationId, organizationId)));
  }
}
