import { Router } from 'express';
import { z } from 'zod';
import { runAgent, AgentAborted } from '../chat/agent.js';
import { ProviderError } from '../chat/providers.js';

export function chatRoutes({ db, config, service, provider, logger, now }) {
  const r = Router();
  const body = z.object({
    // The client may only send user/assistant turns. It can NOT send `system` or `tool` messages, so it cannot forge tool
    // results or override the system prompt. (Server-side history is not stored: conversations stay in the browser.)
    messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(8000) }).strict()).min(1).max(20),
  }).strict();
  const hits = new Map(); // userId -> timestamps, sliding 60s window: bounds LLM spend per user
  const allowed = (uid) => { const t = Date.now(); const a = (hits.get(uid) ?? []).filter((x) => t - x < 60_000); if (a.length >= config.chat.ratePerMin) { hits.set(uid, a); return false; } a.push(t); hits.set(uid, a); return true; };

  r.get('/info', (req, res) => res.json({ mode: provider.mode, model: provider.model, mock: provider.mode === 'mock' }));

  r.post('/', async (req, res, next) => {
    try {
      const { messages } = body.parse(req.body);
      if (messages.at(-1).role !== 'user') return res.status(400).json({ error: 'bad_request', message: 'last message must be from the user' });
      const user = req.auth.user;
      if (!allowed(user.id)) return res.status(429).json({ error: 'rate_limited' });
      const ac = new AbortController();
      res.on('close', () => { if (!res.writableFinished) ac.abort(); }); // browser went away => stop spending tokens / calling tools
      const signal = AbortSignal.any([ac.signal, AbortSignal.timeout(config.chat.totalTimeoutMs)]);
      const reauth = () => { const k = db.getKey(user.keyId), u = db.getUser(user.id); return !!k && !k.revoked_at && !!u && !u.disabled; };
      const out = await runAgent({ provider, service, user, history: messages, signal, reauth, limits: config.chat, now });
      res.json({ reply: out.reply, toolCalls: out.trace, steps: out.steps, stoppedEarly: out.stoppedEarly, mode: provider.mode, model: provider.model, mock: provider.mode === 'mock' });
    } catch (e) {
      if (e instanceof AgentAborted) return res.status(401).json({ error: 'session_ended' });
      if (e instanceof ProviderError) { logger.warn('llm_error', { error: e.message }); return res.status(502).json({ error: 'llm_error', message: e.message }); }
      if (e?.name === 'TimeoutError') return res.status(504).json({ error: 'chat_timeout' });
      if (e?.name === 'AbortError') return; // client disconnected
      next(e);
    }
  });
  return r;
}
