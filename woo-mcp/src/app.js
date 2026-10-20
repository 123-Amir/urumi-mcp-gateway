import express from 'express';
import { WcClient } from './wc.js';
import { buildWooServer } from './tools.js';
import { mountMcp } from './mcpHttp.js';

export function createApp(cfg, deps = {}) {
  const wc = deps.wc ?? new WcClient({ baseUrl: cfg.wcBaseUrl, key: cfg.wcKey, secret: cfg.wcSecret, timeoutMs: cfg.wcTimeoutMs, forwardHttps: cfg.wcForwardHttps });
  const log = deps.log ?? ((m, d) => console.error(JSON.stringify({ level: 'error', msg: m, detail: String(d).slice(0, 200) })));
  const app = express(); app.disable('x-powered-by');
  mountMcp(app, { token: cfg.mcpToken, log, buildServer: () => buildWooServer({ wc, timezone: cfg.timezone, now: deps.now, log }) });
  return app;
}
