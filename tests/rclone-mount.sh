#!/usr/bin/env bash
# Verifies `rclone mount` against the WebDAV layer: directory listing, whole-file
# reads, ranged reads through the kernel, writes committed on close, and the
# server-side immutability refusal surfacing as a write error.
#
# Uses the in-memory mock gateway, so no Proton account or network is involved.
# Mounts under $T only; nothing outside the work directory is touched.
set -uo pipefail
CLI_DIR="$(cd "$(dirname "$0")/.." && pwd)"
T="${1:-/tmp/pdrclone-mount}"
rm -rf "$T"; mkdir -p "$T/mnt" "$T/src" "$T/vfs-cache"
export PATH="$CLI_DIR/../../tools/bun/bin:$PATH"
export TZ=UTC

MOCK_PID=""; MOUNT_PID=""
cleanup() {
  if mountpoint -q "$T/mnt" 2>/dev/null; then fusermount3 -u "$T/mnt" 2>/dev/null || true; fi
  [ -n "$MOUNT_PID" ] && kill "$MOUNT_PID" 2>/dev/null
  [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null
  for p in $(pgrep -f -- "$T/dav.sock" 2>/dev/null); do [ "$p" = "$$" ] || kill -9 "$p" 2>/dev/null; done
  return 0
}
trap cleanup EXIT

command -v fusermount3 >/dev/null || { echo "SKIP: fusermount3 not available"; exit 0; }

( cd "$CLI_DIR" && bun run src/service/serveMock.ts --socket "$T/dav.sock" --control "$T/ctl.sock" > "$T/mock.log" 2>&1 & echo $! > "$T/mock.pid" )
MOCK_PID=$(cat "$T/mock.pid")
for _ in $(seq 1 100); do [ -S "$T/dav.sock" ] && break; sleep 0.1; done
[ -S "$T/dav.sock" ] || { echo "mock did not start"; cat "$T/mock.log"; exit 1; }

ctl()      { curl -s --unix-socket "$T/ctl.sock" -X POST -H 'content-type: application/json' -d "$2" "http://localhost$1" >/dev/null; }
entry()    { curl -s --unix-socket "$T/ctl.sock" -X POST http://localhost/snapshot | python3 -c "import json,sys; print(json.load(sys.stdin)['tree'].get(sys.argv[1],''))" "$1"; }

cat > "$T/rclone.conf" <<EOF
[mock]
type = webdav
url = http://localhost/
vendor = nextcloud
nextcloud_chunk_size = 0
unix_socket = $T/dav.sock
EOF

# Seed content to read through the mount. The control API carries text, so the
# readable fixture is ASCII; the binary file is used for the write test.
head -c 1048576 /dev/urandom > "$T/src/movie.bin"
ctl /seed-file '{"path":"/readme.txt","content":"the quick brown fox jumps over the lazy dog"}'
ctl /seed-file '{"path":"/dir/inner.txt","content":"inner file"}'

pass=0; fail=0
check(){ if eval "$2"; then echo "PASS: $1"; pass=$((pass+1)); else echo "FAIL: $1"; fail=$((fail+1)); fi; }

# --vfs-write-back 1s keeps the writeback delay short enough to observe; the
# default is 5s, and unmounting sooner than that would discard the upload and
# make an immutability assertion pass for the wrong reason.
# --cache-dir keeps the VFS cache inside the work directory. Without it rclone
# uses a shared default cache, where a file whose upload was refused stays dirty
# and is retried by LATER mount sessions -- which both leaks state between runs
# and shadows the remote's real content on read.
rclone --config "$T/rclone.conf" mount mock:/ "$T/mnt" \
  --cache-dir "$T/vfs-cache" \
  --vfs-cache-mode full --vfs-cache-max-age 1h --vfs-write-back 1s --dir-cache-time 1s --no-modtime \
  --log-file "$T/mount.log" --log-level INFO &
MOUNT_PID=$!
for _ in $(seq 1 150); do mountpoint -q "$T/mnt" && break; sleep 0.2; done
mountpoint -q "$T/mnt" || { echo "FAIL: mount did not come up"; tail -20 "$T/mount.log"; exit 1; }
echo "mounted at $T/mnt"

# ---- reads ---------------------------------------------------------------
check "directory listing visible through the mount" 'ls "$T/mnt" | grep -q readme.txt'
check "subdirectory listed" 'ls "$T/mnt" | grep -q dir'
check "nested file readable" '[ "$(cat "$T/mnt/dir/inner.txt")" = "inner file" ]'
check "whole-file read is correct" '[ "$(cat "$T/mnt/readme.txt")" = "the quick brown fox jumps over the lazy dog" ]'
check "file size reported correctly" '[ "$(stat -c %s "$T/mnt/readme.txt")" -eq 43 ]'
# Ranged read through the kernel: bytes 4..8 == "quick"
check "ranged read through the kernel returns the right bytes" '[ "$(dd if="$T/mnt/readme.txt" bs=1 skip=4 count=5 2>/dev/null)" = "quick" ]'
check "tail-end ranged read is correct" '[ "$(dd if="$T/mnt/readme.txt" bs=1 skip=40 count=3 2>/dev/null)" = "dog" ]'

# ---- writes --------------------------------------------------------------
cp "$T/src/movie.bin" "$T/mnt/movie.bin"
sync
# The VFS uploads asynchronously after the writeback delay, so poll for the
# commit rather than assuming close() already flushed it.
for _ in $(seq 1 150); do [ -n "$(entry /movie.bin)" ] && break; sleep 0.2; done
echo "   /movie.bin => $(entry /movie.bin)"
check "file written through the mount is committed remotely" '[[ "$(entry /movie.bin)" == file* ]]'
check "written file has the correct SHA-1 remotely" '[[ "$(entry /movie.bin)" == *"sha1=$(sha1sum "$T/src/movie.bin" | cut -d" " -f1)"* ]]'
check "written file reads back byte-identical through the mount" 'cmp -s "$T/src/movie.bin" "$T/mnt/movie.bin"'

mkdir -p "$T/mnt/newdir"
check "mkdir through the mount creates a remote collection" '[ "$(entry /newdir)" = "dir" ]'

# ---- immutability through the mount -------------------------------------
# Overwriting existing committed content must be refused by the server. With
# --vfs-cache-mode full the local write() and close() succeed immediately and the
# upload happens later, so the refusal surfaces asynchronously in the rclone log
# and the file stays in the local cache -- it is NOT an error returned to the
# writing program. Wait for the upload attempt before asserting anything.
ORIGINAL_SHA=$(printf 'the quick brown fox jumps over the lazy dog' | sha1sum | cut -d' ' -f1)
printf 'different content entirely' > "$T/mnt/readme.txt"
sync
for _ in $(seq 1 150); do grep -qiE "readme.txt.*(412|Precondition|Immutable|failed to upload|upload failed)" "$T/mount.log" && break; sleep 0.2; done
echo "   upload attempts for readme.txt:"; grep -i "readme.txt" "$T/mount.log" | tail -4 | sed 's/^/     /'
check "the server refusal is reported in the mount log" 'grep -qiE "readme.txt.*(412|Precondition|Immutable|failed to upload|upload failed)" "$T/mount.log"'
check "remote content survives an overwrite attempt through the mount" '[[ "$(entry /readme.txt)" == *"sha1=$ORIGINAL_SHA"* ]]'
check "the remote was never left with the new content" '[[ "$(entry /readme.txt)" != *"$(printf "different content entirely" | sha1sum | cut -d" " -f1)"* ]]'

fusermount3 -u "$T/mnt"
for _ in $(seq 1 50); do mountpoint -q "$T/mnt" || break; sleep 0.2; done
check "unmounted cleanly" '! mountpoint -q "$T/mnt"'

echo; echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
