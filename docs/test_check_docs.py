#!/usr/bin/env python3
"""Mutation test for check_docs.py: copy the repo, plant ONE documentation lie at a time, require the checker to report it."""
import os, re, shutil, subprocess, sys, tempfile
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
def fresh():
    d = tempfile.mkdtemp(); dst = os.path.join(d, 'repo')
    shutil.copytree(ROOT, dst, ignore=shutil.ignore_patterns('node_modules', 'dist', '.git', '*.db*'))
    for pkg in ('gateway', 'woo-mcp', 'demo-mcp', 'dashboard'): os.symlink(os.path.join(ROOT, pkg, 'node_modules'), os.path.join(dst, pkg, 'node_modules'))
    return d, dst
def edit(dst, rel, fn): p = os.path.join(dst, rel); s = open(p).read(); n = fn(s); assert n != s, 'mutation changed nothing'; open(p, 'w').write(n)
CASES = [
  ('invented file path', 'README.md', lambda s: s + '\nSee `gateway/src/does_not_exist.js`.\n', [], 'path does not exist'),
  ('invented test title', 'docs/INTERVIEW_PREP_HINGLISH.md', lambda s: s.replace('revoking a key kills its live dashboard session', 'revoking a key makes coffee', 1), [], 'title fragment not found'),
  ('doctored code excerpt', 'docs/INTERVIEW_PREP_HINGLISH.md', lambda s: s.replace('if (!row || row.revoked_at || row.disabled) return null;', 'if (!row) return null;', 1), [], 'excerpt line not in'),
  ('invented env var', 'README.md', lambda s: s + '\nSet `TOTALLY_MADE_UP_VAR` to tune it.\n', [], 'not used anywhere'),
  ('invented make target', 'README.md', lambda s: s + '\nRun `make deploy-everything`.\n', [], 'make target missing'),
  ('code changed, doc stale', 'gateway/src/config.js', lambda s: s.replace('UPSTREAM_RETRY_COOLDOWN_MS, 5000', 'UPSTREAM_RETRY_COOLDOWN_MS, 4000', 1), [], 'FACT .retry cooldown'),
  ('wrong test count', 'README.md', lambda s: s.replace('gateway 72,', 'gateway 71,', 1), ['--run-tests'], 'differ from reality'),
]
missed = 0
for name, rel, fn, args, expect in CASES:
    d, dst = fresh()
    try:
        edit(dst, rel, fn)
        r = subprocess.run([sys.executable, os.path.join(dst, 'docs', 'check_docs.py'), *args], capture_output=True, text=True)
        ok = r.returncode != 0 and re.search(expect, r.stdout) is not None
        print(('CAUGHT ' if ok else 'MISSED ') + f'{name:24s} expected /{expect}/'); missed += not ok
    finally: shutil.rmtree(d, ignore_errors=True)
print(f'\n{len(CASES) - missed}/{len(CASES)} planted documentation lies detected'); sys.exit(1 if missed else 0)
