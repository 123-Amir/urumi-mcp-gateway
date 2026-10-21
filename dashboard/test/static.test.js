import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const files = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? files(p) : /\.(jsx?|html)$/.test(p) ? [p] : []; });
const SRC = [...files('src'), 'index.html'];
// comments may legitimately SAY "never use localStorage"; only scan real code
const code = (f) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

// Guard rails for the security rules in the brief: no browser storage, no raw HTML injection, no eval, no key in URLs.
test.each([
  ['localStorage', /localStorage/], ['sessionStorage', /sessionStorage/], ['IndexedDB', /indexedDB/i], ['document.cookie', /document\.cookie/],
  ['dangerouslySetInnerHTML', /dangerouslySetInnerHTML/], ['innerHTML', /\.innerHTML/], ['eval / new Function', /\beval\(|new Function\(/],
  ['external http(s) resources', /(?:src|href)=["']https?:\/\//],
])('source never uses %s', (_n, re) => {
  const hits = SRC.filter((f) => re.test(code(f)));
  expect(hits).toEqual([]);
});
test('the API key variable goes into exactly ONE request body (login) and the UI never builds an Authorization header', () => {
  const src = code('src/api.js');
  expect(src.match(/\{\s*apiKey\s*\}/g)).toHaveLength(1);
  expect(src).not.toMatch(/Authorization/i);
});
