import express from 'express';
import { Router } from 'express';
import { makeAuth, makeLoginLimiter, securityHeaders, errorHandler } from './http/middleware.js';
import { authRoutes } from './routes/auth.js';
import { serverRoutes } from './routes/servers.js';
import { teamRoutes } from './routes/team.js';
import { miscRoutes } from './routes/misc.js';
import { mountMcp } from './gateway/mcpEndpoint.js';
import { UpstreamManager } from './gateway/upstreams.js';
import { GatewayService } from './gateway/service.js';

export function createApp({ db, config, logger }) {
  const manager = new UpstreamManager({ db, secretKey: config.encryptionKey, ssrf: config.upstream, timeouts: config.timeouts, logger });
  const service = new GatewayService({ db, manager, logger, limits: { maxResultBytes: config.maxResultBytes, maxArgBytes: config.maxArgBytes } });
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(securityHeaders);

  // Health: liveness = process alive; readiness = DB usable. Readiness does NOT depend on upstreams (a dead upstream must not make the gateway "unready").
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.get('/readyz', (req, res) => { try { db.raw.prepare('SELECT 1').get(); res.json({ ready: true }); } catch { res.status(503).json({ ready: false }); } });

  const mw = makeAuth({ db, config });
  const limiter = makeLoginLimiter(config.loginRateLimit);
  const api = Router();
  api.use(express.json({ limit: '64kb' }));
  api.use('/auth', authRoutes({ db, config, logger, limiter, mw })); // login (public) then attach+csrf inside the router
  api.use(mw.attach, mw.csrf);                                          // everything below: identify caller + CSRF for cookie auth
  api.use('/servers', serverRoutes({ db, config, manager, logger, mw }));
  const team = teamRoutes({ db, logger, mw });
  api.use('/users', team.users);
  api.use('/keys', mw.requireAuth, team.keys);
  api.use('/', mw.requireAuth, miscRoutes({ db, service, mw }));
  api.use((req, res) => res.status(404).json({ error: 'not_found' }));
  app.use('/api', api);

  mountMcp(app, { db, service, config, logger });
  app.use(errorHandler(logger));
  return { app, manager, service };
}
