import express from 'express';
import { mountMcp } from './mcpHttp.js';
import { buildUtilsServer, buildNotesServer, createNotesStore } from './tools.js';
export function createApp({ mode, token, now }) {
  const app = express(); app.disable('x-powered-by');
  const store = createNotesStore();
  const buildServer = mode === 'utils' ? () => buildUtilsServer({ now }) : mode === 'notes' ? () => buildNotesServer(store) : null;
  if (!buildServer) throw new Error('MODE must be "utils" or "notes"');
  mountMcp(app, { token, buildServer });
  return app;
}
