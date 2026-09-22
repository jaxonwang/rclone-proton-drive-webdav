#!/usr/bin/env bash
# Does `rclone copy --checksum --immutable` resume correctly after a REBOOT that
# happened mid-transfer?
#
# Simulates the real thing: the service process dies abruptly, but the remote keeps
# both committed files AND the draft left by the interrupted upload (Proton does
# not forget a draft because the client died). The service is then restarted
# against the same persisted state and the SAME command is rerun.
#
# Answers three separate questions, because they have different answers:
#   1. are already-uploaded files skipped without re-transferring?
#   2. does the interrupted file complete, and is it a byte-level resume or a
#      restart from zero?
#   3. what happens if the persisted client UID is LOST in the reboot, so the
#      leftover draft now looks like another client's?
set -uo pipefail
CLI_DIR="$(cd "$(dirname "$0")/.." && pwd)"
T="${1:-/tmp/pdrclone-reboot}"
rm -rf "$T"; mkdir -p "$T/src"
export PATH="$CLI_DIR/../../tools/bun/bin:$PATH"
export TZ=UTC

UID_A="external-drive-rclone-aaaaaaaa-1111-2222-3333-444444444444"
UID_B="external-drive-rclone-bbbbbbbb-5555-6666-7777-888888888888"
STATE="$T/remote-state.json"

MOCK_PID=""
boot() { # $1 = client uid
  ( cd "$CLI_DIR" && bun run src/service/serveMock.ts \
      --socket "$T/dav.sock" --control "$T/ctl.sock" \
      --state "$STATE" --client-uid "$1" >> "$T/mock.log" 2>&1 & echo $! > "$T/mock.pid" )
  MOCK_PID=$(cat "$T/mock.pid")
  for _ in $(seq 1 100); do [ -S "$T/dav.sock" ] && return 0; sleep 0.1; done
  echo "service did not start"; cat "$T/mock.log"; exit 1
}
# Abrupt kill: a reboot does not let the process clean up.
# `bun run` forks a child that does not die with its parent, so killing only the
# tracked PID leaks one service process per boot. Also reap anything still bound
# to this suite's socket, which is unique to its temp dir.
reap_sockets() {
  for p in $(pgrep -f -- "$T/dav.sock" 2>/dev/null); do
    [ "$p" = "$$" ] || kill -9 "$p" 2>/dev/null
  done
  return 0
}
crash() { [ -n "$MOCK_PID" ] && kill -9 "$MOCK_PID" 2>/dev/null; reap_sockets; rm -f "$T/dav.sock" "$T/ctl.sock"; sleep 0.3; }
trap crash EXIT

ctl()   { curl -s --unix-socket "$T/ctl.sock" -X POST -H 'content-type: application/json' -d "$2" "http://localhost$1" >/dev/null; }
entry() { curl -s --unix-socket "$T/ctl.sock" -X POST http://localhost/snapshot | python3 -c "import json,sys; print(json.load(sys.stdin)['tree'].get(sys.argv[1],''))" "$1"; }
calls() { curl -s --unix-socket "$T/ctl.sock" -X POST http://localhost/snapshot | python3 -c "import json,sys; print('\n'.join(json.load(sys.stdin)['calls']))"; }
state_has_draft() { python3 -c "import json,sys; d=json.load(open('$STATE')); print('yes' if d.get('drafts') else 'no')" 2>/dev/null || echo no; }
# Body bytes the SERVER actually received for a path since the last reset.
put_bytes() { curl -s --unix-socket "$T/ctl.sock" -X POST http://localhost/snapshot | python3 -c "import json,sys; print(json.load(sys.stdin).get('putBytes',{}).get(sys.argv[1],0))" "$1"; }

cat > "$T/rclone.conf" <<EOF
[protondrive-sdk]
type = webdav
url = http://localhost/
vendor = nextcloud
nextcloud_chunk_size = 0
unix_socket = $T/dav.sock
EOF
R=(rclone --config "$T/rclone.conf")
# The exact command under test, minus the log/stats noise.
copy()  { "${R[@]}" copy "$T/src" protondrive-sdk:dest --checksum --immutable \
            --transfers 1 --retries 100 --low-level-retries 20 2>&1 || true; }
# Pinned to a single attempt, so the interruption is observable instead of being
# self-healed inside one invocation.
copy1() { "${R[@]}" copy "$T/src" protondrive-sdk:dest --checksum --immutable \
            --transfers 1 --retries 1 --low-level-retries 1 2>&1 || true; }

pass=0; fail=0
check(){ if eval "$2"; then echo "PASS: $1"; pass=$((pass+1)); else echo "FAIL: $1"; fail=$((fail+1)); fi; }

# Two small files that will complete, one big file to interrupt.
printf 'first file\n'  > "$T/src/one.txt"
printf 'second file\n' > "$T/src/two.txt"
head -c 3000000 /dev/urandom > "$T/src/big.bin"
BIG_SHA=$(sha1sum "$T/src/big.bin" | cut -d' ' -f1)
BIG_SIZE=$(stat -c %s "$T/src/big.bin")

echo "=== 1. first run, interrupted partway through big.bin ==="
boot "$UID_A"
ctl /faults "{\"dropPutAfterBytes\":900000}"
copy1 | tail -2
echo "   /dest/one.txt => $(entry /dest/one.txt)"
echo "   /dest/big.bin => $(entry /dest/big.bin)"
check "small files committed before the interruption" '[[ "$(entry /dest/one.txt)" == file* && "$(entry /dest/two.txt)" == file* ]]'
check "interrupted file is NOT committed" '[[ "$(entry /dest/big.bin)" != file* ]]'
check "interrupted file left a draft owned by this service" '[[ "$(entry /dest/big.bin)" == "draft client=$UID_A"* ]]'

echo
echo "=== 2. reboot: kill -9 the service, restart with the same state and client UID ==="
crash
check "remote state survived the crash" '[ -f "$STATE" ]'
check "the draft survived the crash" '[ "$(state_has_draft)" = "yes" ]'
boot "$UID_A"
ctl /reset-calls '{}'
echo "   rerunning the same command..."
SECOND=$(copy)
echo "$SECOND" | grep -E "Transferred:|Errors:|Checks:" | tail -3 | sed 's/^/     /'

echo
echo "=== 3. what the rerun actually did ==="
CALLS=$(calls)
echo "$CALLS" | sed 's/^/     /' | head -12
check "completed files were NOT re-uploaded" '! echo "$CALLS" | grep -qx "put /dest/one.txt"'
check "completed files were NOT re-uploaded (second)" '! echo "$CALLS" | grep -qx "put /dest/two.txt"'
check "the interrupted file WAS uploaded again" 'echo "$CALLS" | grep -qx "put /dest/big.bin"'
check "the interrupted file is now committed with the correct SHA-1" '[[ "$(entry /dest/big.bin)" == "file sha1=$BIG_SHA"* ]]'
check "no draft is left behind" '[ "$(state_has_draft)" = "no" ]'
check "a following verification pass reports no differences" '"${R[@]}" check "$T/src" protondrive-sdk:dest --checksum 2>&1 | grep -q "0 differences found"'

# Byte-level resume, or restart from zero? Measured on the server: how many body
# bytes it received for that path during the rerun.
RESENT=$(put_bytes /dest/big.bin)
REMAINDER=$((BIG_SIZE - 913408))
echo "     rerun sent ${RESENT} body bytes for big.bin"
echo "     full file ${BIG_SIZE}; a byte-level resume would have sent only ~${REMAINDER}"
check "the rerun re-sent the WHOLE file, so there is no byte-level resume" '[ "$RESENT" -ge "$BIG_SIZE" ]'
check "...and definitely more than the remaining bytes" '[ "$RESENT" -gt "$REMAINDER" ]'

echo
echo "=== 4. reboot where the persisted client UID was LOST ==="
# Same remote state, but the service comes back with a different identity, so its
# own leftover draft now looks like another client's.
rm -rf "$T/src2"; mkdir -p "$T/src2"
head -c 500000 /dev/urandom > "$T/src2/orphan.bin"
crash
boot "$UID_A"
ctl /faults '{"dropPutAfterBytes":100000}'
"${R[@]}" copy "$T/src2" protondrive-sdk:orphans --checksum --immutable --transfers 1 --retries 1 --low-level-retries 1 >/dev/null 2>&1 || true
check "an interrupted upload left a draft" '[[ "$(entry /orphans/orphan.bin)" == draft* ]]'
crash
boot "$UID_B"
ORPHAN_OUT=$("${R[@]}" copy "$T/src2" protondrive-sdk:orphans --checksum --immutable --transfers 1 --retries 1 --low-level-retries 1 2>&1 || true)
echo "$ORPHAN_OUT" | tail -2 | sed 's/^/     /'
check "a draft from a lost identity blocks the upload instead of being silently replaced" '[[ "$(entry /orphans/orphan.bin)" == draft* ]]'
check "the refusal is actionable (names the override and the path)" 'echo "$ORPHAN_OUT" | grep -qiE "PROTON_WEBDAV_OVERRIDE_DRAFT_PATH|unfinished upload"'

echo
echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
