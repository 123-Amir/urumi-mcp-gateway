export function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
export function sessionCookie(cfg, token, maxAgeSec) {
  const a = [`${cfg.cookie.name}=${token}`, 'Path=/', 'HttpOnly', `SameSite=${cfg.cookie.sameSite}`, `Max-Age=${maxAgeSec}`];
  if (cfg.cookie.secure) a.push('Secure');
  return a.join('; ');
}
export const clearCookie = (cfg) => sessionCookie(cfg, '', 0);
