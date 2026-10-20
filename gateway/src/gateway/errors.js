import { scrub } from '../logger.js';
export class GatewayError extends Error {
  // code is a stable machine-readable category used in audit logs: unknown_tool | unreachable | timeout | upstream_error | malformed | invalid_arguments
  constructor(code, message) { super(message); this.code = code; }
}
export const errorResult = (text) => ({ isError: true, content: [{ type: 'text', text: `[gateway] ${text}` }] });
export const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n) + '…' : String(s));
export const safeText = (s, n = 160) => clip(scrub(String(s).replace(/[\u0000-\u001F\u007F]+/g, ' ')), n);
