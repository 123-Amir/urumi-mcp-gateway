// Seed "first" servers (e.g. the WooCommerce MCP server) from config on boot. Idempotent: only inserts missing slugs.
import { encrypt } from './security/secretbox.js';
export function seedServers(db, config, logger) {
  for (const s of config.seedServers) {
    if (db.getServerBySlug(s.slug)) continue;
    db.createServer({ slug: s.slug, name: s.name, url: s.url, enabled: s.enabled ?? true,
      authType: s.authType ?? 'none', authHeaderName: s.authHeaderName ?? null,
      credentialEnc: s.credential ? encrypt(s.credential, config.encryptionKey) : null });
    logger.info('server_seeded', { server: s.slug });
  }
}
