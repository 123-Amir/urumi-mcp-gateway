// SSRF guard for admin-supplied upstream URLs.
// Threat: an admin (or a phished admin session) registers http://169.254.169.254/... and the
// gateway, which sits inside the cluster, fetches cloud credentials on their behalf.
//
// Policy
//  1. scheme must be http/https, no user:pass@ in URL
//  2. ALWAYS blocked (no override): link-local/metadata (169.254.0.0/16, fe80::/10, fd00:ec2::254),
//     0.0.0.0/8, multicast/reserved, metadata hostnames
//  3. loopback + private ranges (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7) are blocked
//     UNLESS the hostname matches an explicit allowlist (cluster-internal service names) or
//     allowPrivate=true (local dev only).
//  4. Every DNS answer is checked (A + AAAA), so a hostname that resolves to a blocked IP is caught.
// Known limit: DNS rebinding between check and connect (TOCTOU). We re-run the check on every
// upstream connect, and NetworkPolicy egress rules are the second layer.
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

const META_HOSTS = new Set(['metadata.google.internal', 'metadata', 'instance-data', 'metadata.azure.com']);

function v4ToInt(ip) { return ip.split('.').reduce((a, o) => (a << 8n) + BigInt(o), 0n); }
const inV4 = (ip, cidr) => {
  const [base, bits] = cidr.split('/');
  const mask = ((1n << 32n) - 1n) ^ ((1n << BigInt(32 - Number(bits))) - 1n);
  return (v4ToInt(ip) & mask) === (v4ToInt(base) & mask);
};

// -> 'blocked' | 'private' | 'public'
export function classifyIp(ip) {
  const kind = isIP(ip);
  if (kind === 4) {
    if (['0.0.0.0/8', '169.254.0.0/16', '224.0.0.0/4', '240.0.0.0/4'].some((c) => inV4(ip, c))) return 'blocked';
    if (['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10'].some((c) => inV4(ip, c))) return 'private';
    return 'public';
  }
  if (kind === 6) {
    const l = ip.toLowerCase();
    // IPv4-mapped (::ffff:a.b.c.d) must be judged by the embedded v4 address, else it is a bypass.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l);
    if (mapped) return classifyIp(mapped[1]);
    const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(l);
    if (hexMapped) {
      const n = (parseInt(hexMapped[1], 16) << 16) | parseInt(hexMapped[2], 16);
      return classifyIp([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
    }
    if (l === '::' || l.startsWith('ff')) return 'blocked';
    if (l === '::1') return 'private';
    if (/^fe[89ab]/.test(l)) return 'blocked';        // fe80::/10 link-local
    if (l.startsWith('fd00:ec2')) return 'blocked';   // AWS IMDS over IPv6
    if (/^f[cd]/.test(l)) return 'private';           // fc00::/7 ULA
    return 'public';
  }
  return 'blocked';
}

export function hostAllowed(host, allowlist) {
  const h = host.toLowerCase();
  return allowlist.some((p) => {
    const pat = p.trim().toLowerCase();
    if (!pat) return false;
    return pat.startsWith('.') ? h.endsWith(pat) : h === pat; // ".svc.cluster.local" = suffix, otherwise exact
  });
}

export class UrlRejected extends Error {}

export async function assertSafeUpstreamUrl(rawUrl, { allowlist = [], allowPrivate = false, resolver = lookup } = {}) {
  let u;
  try { u = new URL(rawUrl); } catch { throw new UrlRejected('Invalid URL'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new UrlRejected('Only http/https URLs are allowed');
  if (u.username || u.password) throw new UrlRejected('Credentials in URL are not allowed; use the credential field');

  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (META_HOSTS.has(host)) throw new UrlRejected('Cloud metadata hosts are blocked');

  let addrs;
  if (isIP(host)) addrs = [host];
  else {
    try { addrs = (await resolver(host, { all: true })).map((r) => r.address); }
    catch { throw new UrlRejected('Host does not resolve'); }
    if (!addrs.length) throw new UrlRejected('Host does not resolve');
  }

  const permitted = allowPrivate || hostAllowed(host, allowlist);
  for (const ip of addrs) {
    const c = classifyIp(ip);
    if (c === 'blocked') throw new UrlRejected('Destination address is blocked (metadata/link-local/reserved)');
    if (c === 'private' && !permitted) throw new UrlRejected('Private/internal destination is not on the upstream allowlist');
  }
  return u;
}
