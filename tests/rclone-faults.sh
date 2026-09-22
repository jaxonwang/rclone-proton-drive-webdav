#!/usr/bin/env bash
# Fault-injection suite: interrupted uploads and own-draft recovery, other-client
# drafts and scoped consent, transient failures, checksum mismatch, interrupted
# downloads, revoked session, and service restart.
#
# Network failures are simulated inside the mock gateway (stream aborts, error
# codes). Nothing touches the machine's network configuration.
#
# State is asserted by parsing the control endpoint's JSON, never by grepping raw
# JSON text (the payload is compact, so substring matches are unreliable).
set -uo pipefail
CLI_DIR="$(cd "$(dirname "$0")/.." && pwd)"
T="${1:-/tmp/pdrclone-faults}"
rm -rf "$T"; mkdir -p "$T/src" "$T/dst"
export PATH="$CLI_DIR/../../tools/bun/bin:$PATH"
export TZ=UTC

MOCK_PID=""
start_mock() {
  ( cd "$CLI_DIR" && bun run src/service/serveMock.ts --socket "$T/dav.sock" --control "$T/ctl.sock" $1 >> "$T/mock.log" 2>&1 & echo $! > "$T/mock.pid" )
  MOCK_PID=$(cat "$T/mock.pid")
  for _ in $(seq 1 100); do [ -S "$T/dav.sock" ] && return 0; sleep 0.1; done
  echo "mock did not start"; cat "$T/mock.log"; exit 1
}
# `bun run` forks a child that does not die with its parent, so killing only the
# tracked PID leaks one service process per boot. Also reap anything still bound
# to this suite's socket, which is unique to its temp dir.
reap_sockets() {
  for p in $(pgrep -f -- "$T/dav.sock" 2>/dev/null); do
    [ "$p" = "$$" ] || kill -9 "$p" 2>/dev/null
  done
  return 0
}
stop_mock() { [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null; reap_sockets; rm -f "$T/dav.sock" "$T/ctl.sock"; sleep 0.2; }
trap stop_mock EXIT

ctl()      { curl -s --unix-socket "$T/ctl.sock" -X POST -H 'content-type: application/json' -d "$2" "http://localhost$1" >/dev/null; }
snapshot() { curl -s --unix-socket "$T/ctl.sock" -X POST http://localhost/snapshot; }
# entry <path> -> the snapshot value for that path ("" when absent)
entry()    { snapshot | python3 -c "import json,sys; print(json.load(sys.stdin)['tree'].get(sys.argv[1],''))" "$1"; }
# count_drafts -> number of draft entries in the whole tree
count_drafts() { snapshot | python3 -c "import json,sys; print(sum(1 for v in json.load(sys.stdin)['tree'].values() if v.startswith('draft')))"; }

cat > "$T/rclone.conf" <<EOF
[mock]
type = webdav
url = http://localhost/
vendor = nextcloud
nextcloud_chunk_size = 0
unix_socket = $T/dav.sock
EOF
R=(rclone --config "$T/rclone.conf")
out()  { "${R[@]}" "$@" 2>&1 || true; }
sout() { "${R[@]}" "$@" 2>/dev/null || true; }
# NO_RETRY pins rclone to a single attempt. Without it rclone's own retries
# recover an injected interruption inside one invocation -- correct behaviour,
# but it hides the intermediate state these tests need to observe.
NO_RETRY=(--retries 1 --low-level-retries 1)

pass=0; fail=0
check(){ if eval "$2"; then echo "PASS: $1"; pass=$((pass+1)); else echo "FAIL: $1"; fail=$((fail+1)); fi; }

head -c 2000000 /dev/urandom > "$T/src/payload.bin"
SRC_SHA=$(sha1sum "$T/src/payload.bin" | cut -d' ' -f1)

start_mock "--client-uid sdk-js-cli-mock"

# ---- 1. interrupted upload leaves a draft; retry recovers it ----------------
echo "== 1. interrupted upload (connection drops after 500KB) =="
ctl /faults '{"dropPutAfterBytes":500000}'
out copy "$T/src/payload.bin" mock:/ "${NO_RETRY[@]}" >/dev/null
echo "   /payload.bin => $(entry /payload.bin)"
check "interrupted upload did not commit a file" '[[ "$(entry /payload.bin)" != file* ]]'
check "interrupted upload left a draft owned by this client" '[[ "$(entry /payload.bin)" == "draft client=sdk-js-cli-mock"* ]]'
echo "== retry after interruption (own draft auto-recovered, no broad delete) =="
out copy "$T/src/payload.bin" mock:/ >/dev/null
echo "   /payload.bin => $(entry /payload.bin)"
check "retry committed the file with the correct SHA-1" '[[ "$(entry /payload.bin)" == "file sha1=$SRC_SHA"* ]]'
check "no draft left behind" '[ "$(count_drafts)" -eq 0 ]'
check "content verifies end-to-end after recovery" 'out check "$T/src" mock:/ --checksum | grep -q "0 differences found"'
echo "== rclone's own retry recovers an interruption inside one invocation =="
stop_mock; start_mock "--client-uid sdk-js-cli-mock"
ctl /faults '{"dropPutAfterBytes":500000}'
out copy "$T/src/payload.bin" mock:/ >/dev/null
echo "   /payload.bin => $(entry /payload.bin)"
check "single copy invocation self-heals after an interruption" '[[ "$(entry /payload.bin)" == "file sha1=$SRC_SHA"* ]]'
check "self-healed upload left no draft" '[ "$(count_drafts)" -eq 0 ]'

# ---- 2. another client's draft ---------------------------------------------
echo
echo "== 2. another client's draft: refused without consent =="
ctl /seed-draft '{"path":"/other.bin","clientUid":"sdk-js-cli-SOMEONE-ELSE"}'
head -c 1000 /dev/urandom > "$T/src/other.bin"
CONFLICT_OUT=$(out copy "$T/src/other.bin" mock:/ "${NO_RETRY[@]}")
echo "$CONFLICT_OUT" | tail -2
check "upload is refused" '[[ "$(entry /other.bin)" != file* ]]'
check "refusal cites the unfinished upload / 409" 'echo "$CONFLICT_OUT" | grep -qiE "409|unfinished upload"'
check "the other client's draft is left intact" '[[ "$(entry /other.bin)" == "draft client=sdk-js-cli-SOMEONE-ELSE"* ]]'

echo "== 2b. replaced ONLY with explicit, path-scoped consent =="
stop_mock; start_mock "--client-uid sdk-js-cli-mock --override-draft-path /other.bin"
ctl /seed-draft '{"path":"/other.bin","clientUid":"sdk-js-cli-SOMEONE-ELSE"}'
ctl /seed-draft '{"path":"/untouched.bin","clientUid":"sdk-js-cli-SOMEONE-ELSE"}'
head -c 1000 /dev/urandom > "$T/src/untouched.bin"
out copy "$T/src/other.bin" mock:/ >/dev/null
echo "   /other.bin     => $(entry /other.bin)"
check "consented path uploads" '[[ "$(entry /other.bin)" == file* ]]'
out copy "$T/src/untouched.bin" mock:/ >/dev/null
echo "   /untouched.bin => $(entry /untouched.bin)"
check "consent did NOT extend to any other path" '[[ "$(entry /untouched.bin)" == "draft client=sdk-js-cli-SOMEONE-ELSE"* ]]'
rm -f "$T/src/other.bin" "$T/src/untouched.bin"

# ---- 3. transient failures are retried ------------------------------------
echo
echo "== 3. transient upstream failures (two 503s) =="
stop_mock; start_mock "--client-uid sdk-js-cli-mock"
printf 'retry me' > "$T/src/retry.txt"
# transientFailuresFor pins the injected failures to the PUT. Without it the
# faults were consumed by the preceding PROPFIND, so this never exercised upload
# retry at all -- it passed while testing nothing.
ctl /faults '{"transientFailures":2,"transientFailuresFor":"put"}'
out copy "$T/src/retry.txt" mock:/ --low-level-retries 10 >/dev/null
echo "   /retry.txt => $(entry /retry.txt)"
check "upload succeeds despite transient 503s" '[[ "$(entry /retry.txt)" == file* ]]'
check "the injected upload failures were actually consumed" '[ "$(curl -s --unix-socket "$T/ctl.sock" -X POST http://localhost/snapshot | python3 -c "import json,sys; print(sum(1 for c in json.load(sys.stdin)[\"calls\"] if c.startswith(\"put \")))")" -ge 3 ]'
rm -f "$T/src/retry.txt"

# ---- 4. checksum mismatch is never silently accepted ----------------------
echo
echo "== 4. checksum mismatch reported by the remote =="
stop_mock; start_mock "--client-uid sdk-js-cli-mock"
out copy "$T/src/payload.bin" mock:/ >/dev/null
ctl /faults '{"corruptSha1ForPath":"/payload.bin"}'
MISMATCH_OUT=$(out check "$T/src" mock:/ --checksum)
echo "$MISMATCH_OUT" | tail -4
check "rclone does NOT report the files as equal" '! echo "$MISMATCH_OUT" | grep -q "0 differences found"'
check "rclone reports a hash difference" 'echo "$MISMATCH_OUT" | grep -qiE "differences found|hash differ|md5/sha1 differ"'
# The previous form (grep -qvi "unchanged") matched any line that is not
# "unchanged" and so could never fail. Assert on the remote state instead: with a
# mismatching checksum and --checksum, rclone must attempt a transfer, which the
# immutable remote then refuses -- so the content stays put and an error is shown.
# With a wrong digest reported for existing content, an immutable remote must
# refuse the upload rather than skip it as identical. rclone additionally runs
# "Removing failed copy" -- a SECOND deletion path, separate from the cleanup
# DELETE in updateSimple -- so the guard has to hold here too.
MISMATCH_COPY=$(out copy "$T/src" mock:/ --checksum -v)
echo "$MISMATCH_COPY" | grep -iE "412|Precondition|Immutable|differ|Removing failed" | tail -3 | sed 's/^/     /'
check "the upload is refused, not skipped as identical" 'echo "$MISMATCH_COPY" | grep -qiE "412|Precondition|Immutable"'
check "rclone is not told the files are identical" '! echo "$MISMATCH_COPY" | grep -qi "unchanged skipping"'
check "the existing remote content survives a digest mismatch" '[[ "$(entry /payload.bin)" == "file sha1=$SRC_SHA"* ]]'
ctl /faults '{"corruptSha1ForPath":null}'

# ---- 5. interrupted download ---------------------------------------------
echo
echo "== 5. interrupted download (connection drops after 300KB) =="
rm -rf "$T/dst"; mkdir -p "$T/dst"
ctl /faults '{"dropGetAfterBytes":300000}'
out copy mock:/payload.bin "$T/dst" "${NO_RETRY[@]}" >/dev/null
if [ -f "$T/dst/payload.bin" ]; then echo "   local size: $(stat -c %s "$T/dst/payload.bin") of $(stat -c %s "$T/src/payload.bin")"; else echo "   no local file left"; fi
check "partial download is not left as a complete-looking file" '! cmp -s "$T/src/payload.bin" "$T/dst/payload.bin"'
echo "== download retry =="
out copy mock:/payload.bin "$T/dst" >/dev/null
check "download retry is byte-identical" 'cmp -s "$T/src/payload.bin" "$T/dst/payload.bin"'

# ---- 6. revoked session --------------------------------------------------
echo
echo "== 6. revoked session (401 from the remote) =="
ctl /faults '{"sessionRevoked":true}'
printf hi > "$T/src/after-revoke.txt"
REVOKE_OUT=$(out copy "$T/src/after-revoke.txt" mock:/ "${NO_RETRY[@]}")
echo "$REVOKE_OUT" | tail -3
check "upload fails (no false success)" '[[ "$(entry /after-revoke.txt)" != file* ]]'
check "failure is reported to the user" 'echo "$REVOKE_OUT" | grep -qiE "401|revoked|error|failed"'
ctl /faults '{"sessionRevoked":false}'
out copy "$T/src/after-revoke.txt" mock:/ >/dev/null
check "recovers once the session is valid again" '[[ "$(entry /after-revoke.txt)" == file* ]]'

# A revoked session must be reported as NON-retryable, or an unattended run with
# --retries N replays the whole command N times, re-reading every source byte and
# never progressing. 401 is deliberately outside rclone's webdav retry set.
ctl /faults '{"sessionRevoked":true}'
printf hello > "$T/src/revoke-retry.txt"
RETRY_OUT=$("${R[@]}" copy "$T/src" mock:/retrydest --checksum --immutable --transfers 1 --retries 5 --low-level-retries 2 2>&1 || true)
check "the revoked session surfaces as 401" 'echo "$RETRY_OUT" | grep -q "401"'
check "rclone did NOT replay the command (no second attempt)" '! echo "$RETRY_OUT" | grep -qE "Attempt 2/5|Attempt 3/5"'
check "nothing was written while revoked" '[[ "$(entry /retrydest/revoke-retry.txt)" != file* ]]'
ctl /faults '{"sessionRevoked":false}'

# ---- 7. service restart --------------------------------------------------
echo
echo "== 7. service restart =="
stop_mock; start_mock "--client-uid sdk-js-cli-mock"
check "service restarts and serves requests again" 'out lsjson mock:/ >/dev/null 2>&1'
check "socket is recreated owner-only" '[ "$(stat -c %A "$T/dav.sock")" = "srw-------" ]'
echo "   (the mock holds state in memory, so a restart empties it by design;"
echo "    the real service keeps all state in Proton and reloads the session from disk)"

echo; echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
