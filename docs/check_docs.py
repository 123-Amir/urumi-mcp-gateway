#!/usr/bin/env python3
"""Verifies that the documentation only claims things the repository can back up. Exit 1 on any finding.
  * every repo path mentioned in `backticks` or markdown links exists
  * every citation  path.test.js -> "title fragment"  points at a real file that really contains that fragment
  * every code block headed  `// from: path`  (or `# from: path`) is an exact excerpt of that file
  * every `ENV_VAR` mentioned exists somewhere in the code/chart/scripts
  * every `make target` exists in the Makefile
  * (--run-tests) test counts quoted in the docs equal the real counts from running the suites
"""
import os, re, subprocess, sys
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
DOCS = ['README.md'] + sorted(f'docs/{f}' for f in os.listdir(os.path.join(ROOT, 'docs')) if f.endswith('.md') and f != 'E2E_LAST_RUN.md')
TOP = r'(?:gateway|woo-mcp|demo-mcp|dashboard|charts|scripts|e2e|docs|deploy)'
findings = []; checked = {'paths': 0, 'citations': 0, 'excerpts': 0, 'envvars': 0, 'make': 0, 'counts': 0}
def bad(doc, msg): findings.append(f'{doc}: {msg}')
def read(p): return open(os.path.join(ROOT, p), errors='replace').read()
def src_text(p): return read(p).replace("\\'", "'")   # JS sources escape quotes inside single-quoted test titles

# identifiers that exist in code/chart/scripts (for the env var check)
corpus = ''
for base in ('gateway/src', 'woo-mcp/src', 'demo-mcp/src', 'charts/urumi', 'scripts', 'e2e', 'deploy', 'dashboard/vite.config.js', 'Makefile', 'gateway/Dockerfile'):
    p = os.path.join(ROOT, base)
    for dp, _, fs in (os.walk(p) if os.path.isdir(p) else [(os.path.dirname(p), [], [os.path.basename(p)])]):
        for f in fs:
            if not f.endswith(('.png', '.woff2')): corpus += open(os.path.join(dp, f), errors='replace').read()
envnames = set(re.findall(r'\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b', corpus))
make_targets = set(re.findall(r'^([a-z0-9-]+):', read('Makefile'), re.M))
NOT_ENV = {'SIGKILL', 'SIGTERM'}  # (none needed so far; kept explicit)

for doc in DOCS:
    t = read(doc)
    nocode = re.sub(r'```.*?```', '', t, flags=re.S)
    # --- paths in backticks and links
    for tok in re.findall(r'`([^`\n]+)`', nocode) + re.findall(r'\]\(([^)#\s]+)\)', nocode):
        tok = tok.strip().rstrip('.,;:')
        if re.fullmatch(rf'{TOP}/[^\s*<>${{}}|]*', tok) or tok in ('README.md', 'Makefile'):
            checked['paths'] += 1
            base = os.path.join(ROOT, os.path.dirname(doc), tok) if not tok.startswith(tuple(['gateway', 'woo-mcp', 'demo-mcp', 'dashboard', 'charts', 'scripts', 'e2e', 'docs', 'deploy'])) and tok not in ('README.md', 'Makefile') else os.path.join(ROOT, tok)
            if not os.path.exists(base): bad(doc, f'path does not exist: {tok}')
        elif re.fullmatch(r'(?:\.\./)?[A-Z_]+\.md|[A-Z_]+\.md', tok):
            checked['paths'] += 1
            if not (os.path.exists(os.path.join(ROOT, 'docs', tok)) or os.path.exists(os.path.join(ROOT, tok)) or os.path.exists(os.path.join(ROOT, os.path.dirname(doc), tok))): bad(doc, f'doc link target missing: {tok}')
    # --- test citations (anywhere, including tables)
    for path, frag in re.findall(r'([\w./-]+\.(?:js|jsx|mjs))\s*→\s*"([^"]+)"', t):
        checked['citations'] += 1
        if not os.path.exists(os.path.join(ROOT, path)): bad(doc, f'cited file missing: {path}'); continue
        if frag not in src_text(path): bad(doc, f'title fragment not found in {path}: "{frag}"')
    # --- excerpt blocks
    for lang, body in re.findall(r'```(\w*)\n(.*?)```', t, flags=re.S):
        m = re.match(r'(?://|#) from: (\S+)\n', body)
        if not m: continue
        checked['excerpts'] += 1; src = read(m.group(1)); srclines = {l.strip() for l in src.split('\n')}
        for line in body[m.end():].split('\n'):
            if line.strip() and line.strip() not in srclines: bad(doc, f'excerpt line not in {m.group(1)}: {line.strip()[:80]}')
    # --- env vars
    for tok in set(re.findall(r'`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)`', nocode)):
        checked['envvars'] += 1
        if tok not in envnames and tok not in NOT_ENV: bad(doc, f'`{tok}` is not used anywhere in code/chart/scripts')
    # --- make targets
    for tgt in re.findall(r'`make ([a-z0-9-]+)`', nocode) + re.findall(r'^make ([a-z0-9-]+)', nocode, re.M):
        checked['make'] += 1
        if tgt not in make_targets: bad(doc, f'make target missing: {tgt}')


# --- numeric claims: the number must be what the CODE says, AND the doc must still contain the phrase that quotes it
FACTS = [  # (what, code file, regex capturing the value, expected, doc, phrase the doc must contain)
 ('session absolute TTL (min)', 'gateway/src/config.js', r'SESSION_TTL_MINUTES, (\d+)', 480, 'docs/SYSTEM_DESIGN.md', 'Absolute lifetime 8 h'),
 ('session idle (min)', 'gateway/src/config.js', r'SESSION_IDLE_MINUTES, (\d+)', 60, 'docs/SYSTEM_DESIGN.md', 'idle timeout 1 h'),
 ('session defaults in README', 'gateway/src/config.js', r'SESSION_TTL_MINUTES, (\d+)', 480, 'README.md', '480 / 60'),
 ('connect timeout (ms)', 'gateway/src/config.js', r'UPSTREAM_CONNECT_TIMEOUT_MS, (\d+)', 5000, 'docs/SYSTEM_DESIGN.md', 'connect timeout (5 s)'),
 ('call timeout (ms)', 'gateway/src/config.js', r'UPSTREAM_CALL_TIMEOUT_MS, (\d+)', 30000, 'docs/SYSTEM_DESIGN.md', 'per-call timeout (30 s default)'),
 ('refresh interval (ms)', 'gateway/src/config.js', r'UPSTREAM_REFRESH_MS, (\d+)', 30000, 'docs/SYSTEM_DESIGN.md', 'background refresh (30 s)'),
 ('retry cooldown (ms)', 'gateway/src/config.js', r'UPSTREAM_RETRY_COOLDOWN_MS, (\d+)', 5000, 'docs/SYSTEM_DESIGN.md', 'a 5 s cooldown'),
 ('list timeout (ms)', 'gateway/src/config.js', r'UPSTREAM_LIST_TIMEOUT_MS, (\d+)', 8000, 'docs/INTERVIEW_PREP_HINGLISH.md', 'list 8 s'),
 ('chat max steps', 'gateway/src/config.js', r'CHAT_MAX_STEPS, (\d+)', 6, 'docs/INTERVIEW_PREP_HINGLISH.md', 'Max 6 steps'),
 ('chat calls per step', 'gateway/src/config.js', r'CHAT_MAX_CALLS_PER_STEP, (\d+)', 4, 'docs/SYSTEM_DESIGN.md', '4 calls per step'),
 ('chat rate per minute', 'gateway/src/config.js', r'CHAT_RATE_PER_MIN, (\d+)', 20, 'docs/THREAT_MODEL.md', '(20/min)'),
 ('chat total timeout (ms)', 'gateway/src/config.js', r'CHAT_TOTAL_TIMEOUT_MS, (\d+)', 120000, 'docs/SYSTEM_DESIGN.md', '120 s total'),
 ('chat tool result chars', 'gateway/src/config.js', r'CHAT_MAX_TOOL_RESULT_CHARS, (\d+)', 8000, 'docs/INTERVIEW_PREP_HINGLISH.md', '8000 chars'),
 ('login failures per window', 'gateway/src/config.js', r'LOGIN_MAX_FAILURES, (\d+)', 10, 'docs/THREAT_MODEL.md', '10 failures/min/IP'),
 ('max tool result bytes', 'gateway/src/config.js', r'MAX_TOOL_RESULT_BYTES, (\d+) \* 1024', 256, 'docs/THREAT_MODEL.md', '(256 KB)'),
 ('description cap', 'gateway/src/gateway/upstreams.js', r'MAX_DESC = (\d+)', 600, 'docs/THREAT_MODEL.md', 'capped at 600 characters'),
 ('schema cap (KB)', 'gateway/src/gateway/upstreams.js', r'MAX_SCHEMA_BYTES = (\d+) \* 1024', 16, 'docs/THREAT_MODEL.md', 'over 16 KB'),
 ('tools per server', 'gateway/src/gateway/upstreams.js', r'MAX_TOOLS_PER_SERVER = (\d+)', 200, 'docs/THREAT_MODEL.md', 'at most 200 tools'),
 ('active keys per user', 'gateway/src/routes/team.js', r'MAX_ACTIVE_KEYS = (\d+)', 10, 'docs/SYSTEM_DESIGN.md', 'Up to 10 active keys'),
 ('model tool limit', 'gateway/src/chat/providers.js', r'MAX_TOOLS = (\d+)', 128, 'README.md', 'at most 128 tools'),
]
for what, codefile, rx, expected, doc, phrase in FACTS:
    checked['facts'] = checked.get('facts', 0) + 1
    m = re.search(rx, read(codefile))
    if not m or int(m.group(1)) != expected: bad(doc, f'FACT "{what}": code now says {m.group(1) if m else "?"} (docs assume {expected}); update the docs')
    if phrase not in read(doc): bad(doc, f'FACT "{what}": phrase no longer in the doc: "{phrase}"')

# --- test counts quoted in docs vs reality (opt-in: runs the suites)
if '--run-tests' in sys.argv:
    def run(cwd, rx):
        out = subprocess.run(['npm', 'test'], cwd=os.path.join(ROOT, cwd), capture_output=True, text=True).stdout
        return int(re.search(rx, out).group(1))
    real = {'gateway': run('gateway', r'# tests (\d+)'), 'woo-mcp': run('woo-mcp', r'# tests (\d+)'), 'demo-mcp': run('demo-mcp', r'# tests (\d+)'), 'dashboard': run('dashboard', r'Tests\s+(\d+) passed')}
    total = sum(real.values()); print('real test counts:', real, 'total', total)
    rd = read('README.md'); m = re.search(r'gateway (\d+), woo-mcp (\d+), demo-mcp (\d+), dashboard (\d+) tests', rd)
    checked['counts'] += 1
    if not m or [int(x) for x in m.groups()] != [real['gateway'], real['woo-mcp'], real['demo-mcp'], real['dashboard']]: bad('README.md', f'per-package counts differ from reality {real}')
    for doc in DOCS:
        for n in re.findall(r'(\d+) automated tests', read(doc)):
            checked['counts'] += 1
            if int(n) != total: bad(doc, f'says {n} automated tests, real total is {total}')

print('checked:', ', '.join(f'{v} {k}' for k, v in checked.items()))
for f in findings: print('  FINDING:', f)
print('docs consistent with the repository' if not findings else f'{len(findings)} finding(s)')
sys.exit(1 if findings else 0)
