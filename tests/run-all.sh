#!/usr/bin/env bash
# Runs every suite and prints one summary. Usage: tests/run-all.sh
# Requires: the isolated Bun toolchain at ../../tools/bun/bin, rclone on PATH.
set -uo pipefail
CLI_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$CLI_DIR/../../tools/bun/bin:$PATH"
cd "$CLI_DIR"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="/tmp/pdrclone-testrun-$STAMP"
mkdir -p "$OUT"
echo "logs: $OUT"
echo

total_pass=0; total_fail=0; suites_failed=0

run_suite() { # name, command...
  local name="$1"; shift
  echo "=============================================================="
  echo "SUITE: $name"
  echo "=============================================================="
  local log="$OUT/$name.log"
  "$@" > "$log" 2>&1
  local rc=$?
  local line
  line=$(grep -E '^RESULT:' "$log" | tail -1)
  grep -E '^(FAIL|SKIP)' "$log" || true
  if [ -z "$line" ]; then
    echo "  no RESULT line (suite crashed). Last output:"
    tail -15 "$log" | sed 's/^/    /'
    suites_failed=$((suites_failed+1))
    return
  fi
  echo "  $line"
  local p f
  p=$(echo "$line" | sed -E 's/^RESULT: ([0-9]+) passed.*/\1/')
  f=$(echo "$line" | sed -E 's/.* ([0-9]+) failed$/\1/')
  total_pass=$((total_pass + p)); total_fail=$((total_fail + f))
  [ "$rc" -ne 0 ] && suites_failed=$((suites_failed+1))
  echo
}

echo "--- typecheck ---"
if bun ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json > "$OUT/typecheck.log" 2>&1; then
  echo "  typecheck clean"
else
  echo "  TYPECHECK FAILED:"; grep 'error TS' "$OUT/typecheck.log" | head -20 | sed 's/^/    /'
  suites_failed=$((suites_failed+1))
fi
echo

run_suite webdav-protocol bun run tests/webdav-protocol-tests.ts
run_suite sdk-gateway  bun run tests/sdk-gateway-tests.ts
run_suite session      bun run tests/session-tests.ts
run_suite rclone-smoke bash tests/rclone-smoke.sh  "$OUT/smoke"
run_suite rclone-faults bash tests/rclone-faults.sh "$OUT/faults"
run_suite rclone-mount bash tests/rclone-mount.sh  "$OUT/mount"
run_suite wire         bash tests/wire-tests.sh    "$OUT/wire"
run_suite reboot-resume bash tests/reboot-resume.sh "$OUT/reboot"

echo "=============================================================="
echo "TOTAL: $total_pass passed, $total_fail failed across 8 suites"
echo "suites with a non-zero exit: $suites_failed"
echo "logs kept in $OUT"
echo "=============================================================="
[ "$total_fail" -eq 0 ] && [ "$suites_failed" -eq 0 ]
