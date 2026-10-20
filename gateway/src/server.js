import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { openDb } from './db/database.js';
import { createApp } from './app.js';
import { seedServers } from './seed.js';

const config = loadConfig();
const logger = createLogger({ level: config.logLevel });
if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true });
const db = openDb(config.dbPath);

if (config.bootstrap.apiKey && db.bootstrapAdmin({ email: config.bootstrap.email, rawKey: config.bootstrap.apiKey }))
  logger.info('bootstrap_admin_created', { email: config.bootstrap.email }); // never logs the key
else if (!db.countAdmins()) logger.warn('no_admin_exists: set BOOTSTRAP_ADMIN_API_KEY');
seedServers(db, config, logger);

const { app, manager } = createApp({ db, config, logger });
manager.start();
setInterval(() => db.purgeExpiredSessions(), 10 * 60_000).unref();
const server = app.listen(config.port, () => logger.info('listening', { port: config.port }));

const shutdown = (sig) => { logger.info('shutdown', { sig }); manager.stop(); server.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(1), 10_000).unref(); };
process.on('SIGTERM', () => shutdown('SIGTERM')); process.on('SIGINT', () => shutdown('SIGINT'));
