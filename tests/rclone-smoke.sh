#!/usr/bin/env bash
# End-to-end: real rclone <-> WebDAV layer <-> in-memory mock gateway.
# No Proton account, no network. Usage: tests/rclone-smoke.sh [workdir]
#
# Note on assertions: rclone exits non-zero when it (correctly) refuses work, so
# output is captured into a variable first rather than piped, otherwise pipefail
# turns an expected failure into a false negative. Timestamps are compared with
# TZ=UTC because `rclone lsl` renders local time.
set -uo pipefail
CLI_DIR="$(cd "$(dirname "$0")/.." && pwd)"
T="${1:-/tmp/pdrclone-smoke}"
rm -rf "$T"; mkdir -p "$T/src/sub" "$T/dst"
export PATH="$CLI_DIR/../../tools/bun/bin:$PATH"
export TZ=UTC

cleanup() { [ -f "$T/mock.pid" ] && kill "$(cat "$T/mock.pid")" 2>/dev/null; }
trap cleanup EXIT

( cd "$CLI_DIR" && bun run src/service/serveMock.ts --socket "$T/dav.sock" --control "$T/ctl.sock" > "$T/mock.log" 2>&1 & echo $! > "$T/mock.pid" )
for _ in $(seq 1 100); do [ -S "$T/dav.sock" ] && break; sleep 0.1; done
[ -S "$T/dav.sock" ] || { echo "mock did not start"; cat "$T/mock.log"; exit 1; }
echo "socket: $(stat -c '%A %U' "$T/dav.sock")"

cat > "$T/rclone.conf" <<EOF
[mock]
type = webdav
url = http://localhost/
vendor = nextcloud
nextcloud_chunk_size = 0
unix_socket = $T/dav.sock
EOF
R=(rclone --config "$T/rclone.conf")
# out():  combined stdout+stderr, for grep-style assertions.
# sout(): stdout ONLY, for assertions that compare exact output. rclone logs a
#         NOTICE to stderr on every call because nextcloud_chunk_size=0, so
#         merging stderr would corrupt any exact comparison.
out()  { "${R[@]}" "$@" 2>&1 || true; }
sout() { "${R[@]}" "$@" 2>/dev/null || true; }

head -c 3000000 /dev/urandom > "$T/src/big.bin"
echo "hello proton" > "$T/src/hello.txt"
printf "nested" > "$T/src/sub/n.txt"
touch -d '2023-05-06T07:08:09Z' "$T/src/hello.txt"

pass=0; fail=0
ok()   { echo "PASS: $1"; pass=$((pass+1)); }
bad()  { echo "FAIL: $1"; fail=$((fail+1)); }
check(){ if eval "$2"; then ok "$1"; else bad "$1"; fi; }

echo "== copy =="; out copy "$T/src" mock:/ -v --immutable | tail -3
check "copy uploaded 3 files" '[ "$(sout ls mock:/ | wc -l)" -eq 3 ]'
echo "== lsl (TZ=UTC) =="; sout lsl mock:/
check "mtime preserved via X-OC-Mtime" 'sout lsl mock:/hello.txt | grep -q "2023-05-06 07:08:09"'
echo "== hashsum =="; sout hashsum SHA1 mock:/ | tee "$T/remote.sha1"
check "remote SHA1 matches local" '( cd "$T/src" && sha1sum big.bin hello.txt sub/n.txt | sort ) | diff -q - <(sort "$T/remote.sha1")'
check "rclone check --checksum: 0 differences" 'out check "$T/src" mock:/ --checksum | grep -q "0 differences found"'
check "re-copy transfers nothing" 'out copy "$T/src" mock:/ -v --immutable | grep -qE "Transferred:[[:space:]]+0 B"'
check "ranged cat (offset 6 count 6) == proton" '[ "$(sout cat mock:/hello.txt --offset 6 --count 6)" = "proton" ]'
check "download round-trip byte-identical" 'out copy mock:/ "$T/dst" -q >/dev/null; cmp -s "$T/src/big.bin" "$T/dst/big.bin" && cmp -s "$T/src/sub/n.txt" "$T/dst/sub/n.txt"'
echo "== about =="; out about mock:/ | head -3
check "about reports usage" 'out about mock:/ | grep -q "Used:"'

# ---- immutability against a modified source --------------------------------
echo "changed content" > "$T/src/hello.txt"; touch -d '2023-06-01T00:00:00Z' "$T/src/hello.txt"
echo "== rclone --immutable (client-side refusal) =="; out copy "$T/src" mock:/ --immutable | tail -2
check "rclone --immutable refuses modified file" 'out copy "$T/src" mock:/ --immutable | grep -q "immutable file modified"'

echo "== server-side refusal WITHOUT rclone --immutable =="; out copy "$T/src" mock:/ | tail -4
check "server refuses overwrite (412)" 'out copy "$T/src" mock:/ | grep -q "412"'
# rclone discards the error from its post-failure cleanup DELETE (`_ = o.Remove(ctx)`),
# so the evidence that the guard fired is in the service log, not rclone's output.
check "service logged a blocked cleanup DELETE" 'grep -q "Refusing DELETE /hello.txt" "$T/mock.log"'
# Fetch the call log once and fail loudly if it cannot be read, rather than
# letting an unreachable control socket satisfy a negative assertion.
CALLS=$(curl -sf --unix-socket "$T/ctl.sock" -X POST http://localhost/snapshot \
        | python3 -c 'import json,sys; print("\n".join(json.load(sys.stdin)["calls"]))')
check "control socket readable (guards the next assertion)" '[ -n "$CALLS" ]'
check "gateway remove() was never reached for the protected path" '! echo "$CALLS" | grep -qx "remove /hello.txt"'
check "remote content SURVIVES refused overwrite" '[ "$(sout cat mock:/hello.txt)" = "hello proton" ]'
check "remote SHA1 still the original" 'sout hashsum SHA1 mock:/hello.txt | grep -q a999fb8f36ac292168de3c849e0e5473963613ed'
echo "hello proton" > "$T/src/hello.txt"; touch -d '2023-05-06T07:08:09Z' "$T/src/hello.txt"

# ---- explicit deletion still works ---------------------------------------
check "explicit deletefile works (guard is narrow)" 'out copy "$T/src" mock:/ -q >/dev/null; out deletefile mock:/sub/n.txt >/dev/null; ! out ls mock:/sub | grep -q n.txt'

echo "== mkdir/move/delete/rmdir =="
check "mkdir" 'out mkdir mock:/newdir >/dev/null; out lsd mock:/ | grep -q newdir'
check "moveto file" 'printf x > "$T/src/mv.txt"; out copy "$T/src/mv.txt" mock:/ -q >/dev/null; out moveto mock:/mv.txt mock:/newdir/moved.txt >/dev/null; out ls mock:/newdir | grep -q moved.txt'
check "deletefile" 'out deletefile mock:/newdir/moved.txt >/dev/null; ! out ls mock:/newdir | grep -q moved.txt'
check "rmdir" 'out rmdir mock:/newdir >/dev/null; ! out lsd mock:/ | grep -q newdir'

echo "== final snapshot =="
curl -s --unix-socket "$T/ctl.sock" -X POST http://localhost/snapshot \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); [print("  ",k,"=>",v) for k,v in sorted(d["tree"].items())]; print("   gateway calls:",len(d["calls"]))'
echo; echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
