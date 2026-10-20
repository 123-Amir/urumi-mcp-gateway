// LLM providers behind ONE tiny interface:   chat({ messages, tools, signal }) -> { content, tool_calls }
//   openai : any OpenAI-compatible /chat/completions endpoint (OpenAI itself, or Ollama/vLLM/LiteLLM by changing OPENAI_BASE_URL)
//   mock   : deterministic scripted "model" for demos/tests. It is NOT an LLM and every reply says so.
// The API key lives only in server env (Kubernetes Secret). It is never sent to the browser and never logged.
import { z } from 'zod';

export class ProviderError extends Error {}
const MAX_TOOLS = 128;          // OpenAI's per-request function limit
const MAX_RESPONSE_BYTES = 2_000_000;

const responseSchema = z.object({ choices: z.array(z.object({ message: z.object({
  content: z.string().nullable().optional(),
  tool_calls: z.array(z.object({ id: z.string().min(1).max(100), type: z.literal('function').optional(),
    function: z.object({ name: z.string().min(1).max(100), arguments: z.string().max(100_000) }) })).optional(),
}) })).min(1) });

export function openaiProvider({ apiKey, baseUrl, model, timeoutMs = 60_000, fetchImpl = fetch }) {
  const base = baseUrl.replace(/\/+$/, '');
  return {
    mode: 'openai', model,
    async chat({ messages, tools, signal }) {
      const body = { model, messages };
      if (tools.length) {
        body.tools = tools.slice(0, MAX_TOOLS).map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
        body.tool_choice = 'auto';
      }
      const sig = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
      let res, text;
      try {
        res = await fetchImpl(`${base}/chat/completions`, { method: 'POST', redirect: 'error', signal: sig, body: JSON.stringify(body),
          headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) } });
        text = await res.text();
      } catch (e) {
        if (signal?.aborted) throw e; // caller cancelled: let the abort propagate untouched
        if (e?.name === 'TimeoutError') throw new ProviderError(`LLM provider did not answer within ${timeoutMs}ms`);
        throw new ProviderError(`Cannot reach LLM provider (${e?.cause?.code ?? 'network error'})`);
      }
      if (!res.ok) {
        // Error bodies are NOT echoed: they can contain request fragments. Status is enough to act on.
        if (res.status === 401 || res.status === 403) throw new ProviderError('LLM provider rejected the API key');
        if (res.status === 429) throw new ProviderError('LLM provider rate limit reached, try again shortly');
        throw new ProviderError(`LLM provider error (HTTP ${res.status})`);
      }
      if (text.length > MAX_RESPONSE_BYTES) throw new ProviderError('LLM response too large');
      let parsed; try { parsed = responseSchema.parse(JSON.parse(text)); } catch { throw new ProviderError('LLM provider returned a malformed response'); }
      const m = parsed.choices[0].message;
      return { content: m.content ?? null, tool_calls: m.tool_calls?.length ? m.tool_calls.map((c) => ({ id: c.id, type: 'function', function: c.function })) : [] };
    },
  };
}

// ---------------- MOCK ----------------
export const MOCK_TAG = '[MOCK MODE: scripted, no LLM was used]';
const HELP = `${MOCK_TAG} I only understand a few demo phrases: "create a product called Blue Mug priced 199", "what orders came in today", "what is the date". Configure LLM_PROVIDER=openai for a real model.`;
const callOf = (name, args, i) => ({ id: `mock_${i}_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });

export function mockProvider() {
  return {
    mode: 'mock', model: 'scripted-mock',
    async chat({ messages, tools }) {
      const has = (n) => tools.some((t) => t.name === n);
      const lastUserIdx = messages.map((m) => m.role).lastIndexOf('user');
      const user = String(messages[lastUserIdx]?.content ?? '');
      const since = messages.slice(lastUserIdx + 1);
      const results = since.filter((m) => m.role === 'tool');
      const nameById = Object.fromEntries(since.filter((m) => m.tool_calls).flatMap((m) => m.tool_calls.map((c) => [c.id, c.function.name])));

      const create = /create (?:a |an )?(?:new )?product\s+(?:called|named)?\s*"?([^"]+?)"?\s+(?:priced?(?: at)?|for|at)\s*(?:₹|rs\.?|\$)?\s*(\d+(?:\.\d{1,2})?)/i.exec(user);
      const wantsOrders = /orders?/i.test(user) && /today/i.test(user);
      const wantsDate = /\b(date|time)\b/i.test(user);

      // step 1/2: decide which tool to call next, based on what has already been answered
      const done = new Set(results.map((r) => nameById[r.tool_call_id]));
      let next = null;
      if (create) { if (!done.has('woo__create_product')) next = has('woo__create_product') ? callOf('woo__create_product', { name: create[1].trim(), regular_price: create[2] }, results.length) : 'missing:woo__create_product'; }
      else if (wantsOrders) {
        if (!done.has('utils__current_date') && has('utils__current_date')) next = callOf('utils__current_date', { timezone: 'UTC' }, results.length); // two upstreams on purpose
        else if (!done.has('woo__list_orders')) next = has('woo__list_orders') ? callOf('woo__list_orders', { created_today: true }, results.length) : 'missing:woo__list_orders';
      } else if (wantsDate) { if (!done.has('utils__current_date')) next = has('utils__current_date') ? callOf('utils__current_date', {}, results.length) : 'missing:utils__current_date'; }
      else if (!results.length) return { content: HELP, tool_calls: [] };

      if (typeof next === 'string') return { content: `${MOCK_TAG} The tool "${next.slice(8)}" is not available to you (disabled, hidden or its server is unreachable).`, tool_calls: [] };
      if (next) return { content: null, tool_calls: [next] };
      // final answer: summarise tool results (this is string formatting, not reasoning)
      const lines = results.map((r) => { const n = nameById[r.tool_call_id] ?? 'tool'; let s = String(r.content); try { const j = JSON.parse(s); if (j?.orders) s = `${j.count} order(s) today: ` + j.orders.map((o) => `#${o.number} ${o.status} ${o.total} ${o.currency}`).join('; '); else if (j?.name) s = `created "${j.name}" (id ${j.id}, price ${j.price})`; else if (j?.date) s = `${j.date} ${j.time ?? ''} ${j.timezone}`.trim(); } catch { /* keep raw */ } return `- ${n}: ${s.slice(0, 300)}`; });
      return { content: `${MOCK_TAG}\n${lines.join('\n') || 'Done.'}`, tool_calls: [] };
    },
  };
}

export function createProvider(llm, deps = {}) {
  if (llm.provider === 'openai') return openaiProvider({ ...llm, fetchImpl: deps.fetch ?? fetch });
  return mockProvider();
}
