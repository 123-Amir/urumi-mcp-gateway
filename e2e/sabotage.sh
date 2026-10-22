#!/usr/bin/env bash
# Mutation test for the e2e itself: inject one gateway bug at a time and require `e2e/run.mjs` to FAIL. A green e2e that cannot go red proves nothing.
# Every patched file and docs/E2E_LAST_RUN.md are restored afterwards (also on Ctrl-C/timeouts).
set -uo pipefail
cd "$(dirname "$0")/.."
cp docs/E2E_LAST_RUN.md /tmp/E2E_LAST_RUN.bak 2>/dev/null || true
FILES=(gateway/src/db/database.js gateway/src/gateway/service.js gateway/src/gateway/upstreams.js)
restore() { git checkout -q -- "${FILES[@]}"; cp /tmp/E2E_LAST_RUN.bak docs/E2E_LAST_RUN.md 2>/dev/null || true; }
trap restore EXIT
if ! git diff --quiet -- "${FILES[@]}"; then echo "refusing to run: uncommitted changes in ${FILES[*]}"; exit 2; fi

missed=0
sab() { # sab <label> <file> <expected-failing-check-substring> <old> <new>
  python3 - "$2" "$4" "$5" <<'PY'
import sys
p, old, new = sys.argv[1:4]; s = open(p).read(); assert old in s, 'sabotage target not found: ' + old[:60]; open(p, 'w').write(s.replace(old, new, 1))
PY
  out=$(timeout 60 node --disable-warning=ExperimentalWarning e2e/run.mjs 2>&1); rc=$?
  if [ $rc -ne 0 ] && grep -q "FAIL.*$3" <<<"$out"; then echo "CAUGHT  $1  -> $(grep -m1 -o "FAIL .*" <<<"$out" | cut -c1-90)"
  else echo "MISSED  $1  (exit=$rc)"; missed=$((missed+1)); fi
  git checkout -q -- "$2"
}
sab "revocation ignored"                  gateway/src/db/database.js        "revoked key"          "if (!row || row.revoked_at || row.disabled) return null;" "if (!row || row.disabled) return null;"
sab "chat tool calls not audited"         gateway/src/gateway/service.js    "appear in the audit"  "    this.db.audit({ userId: user.id" "    if (source !== 'chat') this.db.audit({ userId: user.id"
sab "dead upstream tools still listed"    gateway/src/gateway/upstreams.js  "hidden while it is down" "      if (st?.status === 'connected') out.push(...st.tools);" "      if (st) out.push(...st.tools);"
sab "per-user tool filter removed"        gateway/src/gateway/service.js    "tool permissions"     "      .filter((t) => !this.db.isToolDenied(user, t.slug, t.tool)) // hidden, not just rejected" "      // filter removed"
sab "disabled servers keep serving tools" gateway/src/gateway/upstreams.js  "no longer"            "    if (!server || !server.enabled) throw new GatewayError('unknown_tool', 'Tool not available');" "    if (!server) throw new GatewayError('unknown_tool', 'Tool not available');"
echo; [ $missed -eq 0 ] && echo "all injected gateway bugs were detected by the e2e" || echo "$missed bug(s) NOT detected"
exit $missed
