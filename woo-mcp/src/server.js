import { createApp } from './app.js';
const need = (k) => { const v = process.env[k]; if (!v) { console.error(`Missing required env ${k}`); process.exit(1); } return v; };
const cfg = {
  wcBaseUrl: need('WC_BASE_URL'), wcKey: need('WC_CONSUMER_KEY'), wcSecret: need('WC_CONSUMER_SECRET'), mcpToken: need('MCP_AUTH_TOKEN'),
  wcTimeoutMs: Number(process.env.WC_TIMEOUT_MS ?? 10000), wcForwardHttps: process.env.WC_FORWARD_HTTPS === 'true',
  timezone: process.env.WC_TIMEZONE ?? 'UTC', port: Number(process.env.PORT ?? 3000),
};
const srv = createApp(cfg).listen(cfg.port, () => console.log(JSON.stringify({ level: 'info', msg: 'listening', port: cfg.port })));
process.on('SIGTERM', () => srv.close(() => process.exit(0)));
