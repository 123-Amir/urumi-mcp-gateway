// Thin WooCommerce REST API (v3) client. Why REST (vs WP-CLI / direct DB):
//  * documented, versioned, stable contract; WooCommerce itself enforces validation, permissions and hooks
//  * works over the network, so this MCP server needs NO shell access, NO DB credentials and NO write access to WP files
//  * credentials are a WC consumer key/secret that can be scoped (read/write) and revoked from wp-admin
// WP-CLI would need `kubectl exec`-style access into the WP pod (broad privileges); direct SQL bypasses WooCommerce logic.
export class WcError extends Error {
  constructor(kind, message, status) { super(message); this.kind = kind; this.status = status; }
}
const MAX_BODY = 1_000_000;

export class WcClient {
  constructor({ baseUrl, key, secret, timeoutMs = 10_000, forwardHttps = false, fetchImpl = fetch }) {
    Object.assign(this, { baseUrl: baseUrl.replace(/\/+$/, ''), timeoutMs, forwardHttps, fetchImpl });
    this.auth = 'Basic ' + Buffer.from(`${key}:${secret}`).toString('base64');
  }
  async request(method, path, { query, body } = {}) {
    const url = new URL(`${this.baseUrl}/wp-json/wc/v3${path}`);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    // WooCommerce accepts key/secret via Basic auth only when it believes the request is HTTPS. In-cluster we talk plain HTTP
    // to the WordPress Service, so the chart sets WC_FORWARD_HTTPS=true and wp-config trusts this header (documented tradeoff).
    const headers = { Authorization: this.auth, Accept: 'application/json', ...(this.forwardHttps ? { 'X-Forwarded-Proto': 'https' } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) };
    let res, text;
    try {
      res = await this.fetchImpl(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error' });
      text = await res.text();
    } catch (e) {
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new WcError('timeout', `WooCommerce did not answer within ${this.timeoutMs}ms`);
      throw new WcError('network', `Cannot reach WooCommerce (${e?.cause?.code ?? e?.message ?? 'network error'})`);
    }
    if (text.length > MAX_BODY) throw new WcError('too_large', 'WooCommerce response too large');
    let json; try { json = text ? JSON.parse(text) : null; } catch { throw new WcError('malformed', `WooCommerce returned a non-JSON response (HTTP ${res.status})`, res.status); }
    if (!res.ok) {
      const msg = typeof json?.message === 'string' ? json.message.replace(/<[^>]*>/g, '').slice(0, 200) : `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 403) throw new WcError('auth', `WooCommerce rejected the API credentials (HTTP ${res.status})`, res.status);
      if (res.status === 404) throw new WcError('not_found', msg || 'Not found', 404);
      throw new WcError('wc_error', `WooCommerce error: ${msg}`, res.status);
    }
    return json;
  }
}
