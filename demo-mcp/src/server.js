import { createApp } from './app.js';
const token = process.env.MCP_AUTH_TOKEN; const mode = process.env.MODE;
if (!token || !mode) { console.error('MODE (utils|notes) and MCP_AUTH_TOKEN are required'); process.exit(1); }
const srv = createApp({ mode, token }).listen(Number(process.env.PORT ?? 3000), () => console.log(JSON.stringify({ level: 'info', msg: 'listening', mode })));
process.on('SIGTERM', () => srv.close(() => process.exit(0)));
