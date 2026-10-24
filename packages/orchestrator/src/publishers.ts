import type { contentItems, contentVersions, Database } from "@dfos/db";
import type { ContentPlatform } from "@dfos/domain";

export interface PublishRequest {
  item: typeof contentItems.$inferSelect;
  version: typeof contentVersions.$inferSelect;
}

/**
 * A platform publisher. Real implementations call the platform's official API.
 * None are registered yet: Meta/Instagram arrives in phase 6. Until then every
 * publish attempt fails with `integration_not_connected` and no approval is used.
 */
export interface ContentPublisher {
  platform: ContentPlatform;
  isConnected(db: Database, organizationId: string): Promise<boolean>;
  publish(db: Database, organizationId: string, req: PublishRequest): Promise<{ externalId: string }>;
}

const registry = new Map<ContentPlatform, ContentPublisher>();

export function registerPublisher(p: ContentPublisher) {
  registry.set(p.platform, p);
}

export function unregisterPublisher(platform: ContentPlatform) {
  registry.delete(platform);
}

export function getPublisher(platform: ContentPlatform): ContentPublisher | undefined {
  return registry.get(platform);
}
