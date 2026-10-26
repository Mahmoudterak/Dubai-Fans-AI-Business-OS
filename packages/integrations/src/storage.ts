import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getEnv, getStorageStatus, type ServerEnv } from "@dfos/config";
import { AppError } from "@dfos/domain";

/**
 * Private object storage. Objects are never public; Meta and the UI get
 * short-lived signed GET links instead.
 */
export interface StorageProvider {
  readonly name: string;
  /** Whether signed links are reachable from the public internet (required by Meta). */
  readonly publiclyReachable: boolean;
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Size in bytes, or null if the object does not exist. */
  head(key: string): Promise<{ size: number } | null>;
  signedGetUrl(key: string, ttlSeconds: number): Promise<string>;
  delete(key: string): Promise<void>;
}

const LOCAL_HOST = /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i;

export class S3StorageProvider implements StorageProvider {
  readonly name = "s3";
  readonly publiclyReachable: boolean;
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(env: ServerEnv) {
    const endpoint = env.OBJECT_STORAGE_ENDPOINT!;
    this.bucket = env.OBJECT_STORAGE_BUCKET!;
    this.publiclyReachable = !LOCAL_HOST.test(new URL(endpoint).hostname);
    this.client = new S3Client({
      endpoint,
      region: env.OBJECT_STORAGE_REGION,
      forcePathStyle: env.OBJECT_STORAGE_FORCE_PATH_STYLE === "true",
      credentials: { accessKeyId: env.OBJECT_STORAGE_ACCESS_KEY_ID!, secretAccessKey: env.OBJECT_STORAGE_SECRET_ACCESS_KEY! },
    });
  }

  async put(key: string, body: Uint8Array, contentType: string) {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType, CacheControl: "private, max-age=0" }),
    );
  }

  async head(key: string) {
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: Number(r.ContentLength ?? 0) };
    } catch (e) {
      const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) return null;
      throw e;
    }
  }

  signedGetUrl(key: string, ttlSeconds: number) {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: ttlSeconds });
  }

  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

/** TEST ONLY: in-memory storage. Its links are not reachable by Meta. */
export class MemoryStorageProvider implements StorageProvider {
  readonly name = "memory";
  readonly objects = new Map<string, { body: Uint8Array; contentType: string }>();
  constructor(readonly publiclyReachable = false) {}
  async put(key: string, body: Uint8Array, contentType: string) {
    this.objects.set(key, { body, contentType });
  }
  async head(key: string) {
    const o = this.objects.get(key);
    return o ? { size: o.body.byteLength } : null;
  }
  async signedGetUrl(key: string, ttlSeconds: number) {
    return `https://storage.test/${encodeURIComponent(key)}?expires=${ttlSeconds}`;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

let override: StorageProvider | undefined;

/** Tests inject a provider here. */
export function setStorageProvider(p: StorageProvider | undefined) {
  override = p;
}

export function getStorageProvider(env: ServerEnv = getEnv()): StorageProvider {
  if (override) return override;
  const status = getStorageStatus(env);
  if (!status.ready) {
    throw new AppError("storage_not_configured", `Object storage is not configured (missing: ${status.missing.join(", ")})`);
  }
  return new S3StorageProvider(env);
}

export function isStorageAvailable(env: ServerEnv = getEnv()) {
  return Boolean(override) || getStorageStatus(env).ready;
}
