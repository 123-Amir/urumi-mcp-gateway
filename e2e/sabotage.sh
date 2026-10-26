#!/usr/bin/env bash
# Mutation test for the e2e itself: inject one gateway bug at a time and require `e2e/run.mjs` to FAIL. A green e2e that cannot go red proves nothing.
# Every patched file is restored afterwards (also on Ctrl-C/timeouts). docs/E2E_LAST_RUN.md is never touched.
set -uo pipefail
cd "$(dirname "$0")/.."
export E2E_REPORT="$(mktemp)"   # sabotaged runs write their (FAIL) report here, never into docs/
FILES=(gateway/src/db/database.js gateway/src/gateway/service.js gateway/src/gateway/upstreams.js gateway/src/routes/servers.js)
restore() { git checkout -q -- "${FILES[@]}"; rm -f "$E2E_REPORT"; }
trap restore EXIT
if ! git diff --quiet -- "${FILES[@]}"; then echo "refusing to run: uncommitted changes in ${FILES[*]}"; exit 2; fi

missed=0
sab() { # sab <label> <expected-failing-check-substring> <file> <old> <new> [<file> <old> <new> ...]
  local label=$1 expect=$2; shift 2
  python3 - "$@" <<'PY'
import sys
a = sys.argv[1:]
for i in range(0, len(a), 3):
    p, old, new = a[i:i + 3]; s = open(p).read(); assert old in s, 'sabotage target not found: ' + old[:60]; open(p, 'w').write(s.replace(old, new, 1))
PY
  out=$(timeout 60 node --disable-warning=ExperimentalWarning e2e/run.mjs 2>&1); rc=$?
  if [ $rc -ne 0 ] && grep -q "FAIL.*$expect" <<<"$out"; then echo "CAUGHT  $label  -> $(grep -m1 -o "FAIL .*" <<<"$out" | cut -c1-90)"
  else echo "MISSED  $label  (exit=$rc)"; missed=$((missed+1)); fi
  git checkout -q -- "${FILES[@]}"
}
sab "revocation ignored" "revoked key" gateway/src/db/database.js "if (!row || row.revoked_at || row.disabled) return null;" "if (!row || row.disabled) return null;"
sab "chat tool calls not audited" "appear in the audit" gateway/src/gateway/service.js "    this.db.audit({ userId: user.id" "    if (source !== 'chat') this.db.audit({ userId: user.id"
sab "dead upstream tools still listed" "hidden while it is down" gateway/src/gateway/upstreams.js "      if (st?.status === 'connected') out.push(...st.tools);" "      if (st) out.push(...st.tools);"
sab "per-user tool filter removed" "tool permissions" gateway/src/gateway/service.js "      .filter((t) => !this.db.isToolDenied(user, t.slug, t.tool)) // hidden, not just rejected" "      // filter removed"
# Disabled servers are protected by TWO independent layers (call() checks `enabled`; disabling also drops the cached connection/tools).
# Removing ONE layer is an equivalent mutant (the other still rejects), by design. So the honest test removes BOTH.
sab "disabled server callable (both layers removed)" "calling the disabled tool directly" \
  gateway/src/gateway/upstreams.js "    if (!server || !server.enabled) throw new GatewayError('unknown_tool', 'Tool not available');" "    if (!server) throw new GatewayError('unknown_tool', 'Tool not available');" \
  gateway/src/routes/servers.js "    manager.invalidate(cur.id);               // drop old connection => new url/credential/enabled takes effect now" "    // invalidate removed"
echo; [ $missed -eq 0 ] && echo "all injected gateway bugs were detected by the e2e" || echo "$missed bug(s) NOT detected"
exit $missed
