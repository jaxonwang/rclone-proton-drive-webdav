#!/usr/bin/env bash
# Wire-level tests: assert what a client actually receives on the socket.
#
# These exist because the in-process suites call handleRequest directly and
# inspect the returned Response object, so they cannot see how the runtime frames
# it. Measured on Bun 1.3.14: a response body that errors BEFORE its first chunk
# is sent as `200 OK` with a cleanly terminated empty chunked body -- a failed
# download indistinguishable from a successful empty file -- while a body that
# errors after data has flowed resets the connection. Bun also computes its own
# Content-Length and ignores any set by the handler, so there is no header-level
# length contract to rely on.
set -uo pipefail
CLI_DIR="$(cd "$(dirname "$0")/.." && pwd)"
T="${1:-/tmp/pdrclone-wire}"
rm -rf "$T"; mkdir -p "$T"
export PATH="$CLI_DIR/../../tools/bun/bin:$PATH"

# `bun run` forks a child that does not die with its parent, so killing only the
# tracked PID leaks one service process per boot. Also reap anything still bound
# to this suite's socket, which is unique to its temp dir.
reap_sockets() {
  for p in $(pgrep -f -- "$T/dav.sock" 2>/dev/null); do
    [ "$p" = "$$" ] || kill -9 "$p" 2>/dev/null
  done
  return 0
}
cleanup() { [ -f "$T/mock.pid" ] && kill "$(cat "$T/mock.pid")" 2>/dev/null; reap_sockets; }
trap cleanup EXIT

( cd "$CLI_DIR" && bun run src/service/serveMock.ts --socket "$T/dav.sock" --control "$T/ctl.sock" > "$T/mock.log" 2>&1 & echo $! > "$T/mock.pid" )
for _ in $(seq 1 100); do [ -S "$T/dav.sock" ] && break; sleep 0.1; done
[ -S "$T/dav.sock" ] || { echo "mock did not start"; cat "$T/mock.log"; exit 1; }

python3 - "$T" <<'PY'
import json, socket, sys
T = sys.argv[1]
passed = failed = 0

def check(name, cond, detail=""):
    global passed, failed
    if cond:
        print(f"PASS: {name}"); passed += 1
    else:
        print(f"FAIL: {name}" + (f" -- {detail}" if detail else "")); failed += 1

def ctl(path, body):
    s = socket.socket(socket.AF_UNIX); s.connect(f"{T}/ctl.sock")
    b = json.dumps(body).encode()
    s.sendall(f"POST {path} HTTP/1.1\r\nHost: l\r\nContent-Type: application/json\r\nContent-Length: {len(b)}\r\nConnection: close\r\n\r\n".encode() + b)
    s.recv(65536); s.close()

def dechunk(raw):
    """Decode chunked framing. Returns (payload, terminated)."""
    out, i = b"", 0
    while True:
        j = raw.find(b"\r\n", i)
        if j < 0:
            return out, False
        try:
            n = int(raw[i:j].split(b";")[0], 16)
        except ValueError:
            return out, False
        if n == 0:
            return out, True
        out += raw[j + 2 : j + 2 + n]
        i = j + 2 + n + 2

def get(path):
    s = socket.socket(socket.AF_UNIX); s.connect(f"{T}/dav.sock")
    s.sendall(f"GET {path} HTTP/1.1\r\nHost: l\r\nConnection: close\r\n\r\n".encode())
    buf, reset = b"", False
    try:
        while True:
            c = s.recv(65536)
            if not c: break
            buf += c
    except (ConnectionResetError, OSError):
        reset = True
    s.close()
    head, _, raw = buf.partition(b"\r\n\r\n")
    h = head.decode(errors="replace")
    if "chunked" in h.lower():
        payload, terminated = dechunk(raw)
    else:
        payload, terminated = raw, True
    # advertised length, if the runtime chose to send one
    adv = None
    for line in h.split("\r\n"):
        if line.lower().startswith("content-length:"):
            adv = int(line.split(":", 1)[1])
    return h, payload, reset, terminated, adv

SIZE = 300000
ctl("/seed-file", {"path": "/w.bin", "content": "A" * SIZE})

head, body, reset, terminated, adv = get("/w.bin")
check("healthy download returns 200", head.startswith("HTTP/1.1 200"), head.split("\r\n")[0])
check("healthy download delivers every byte", len(body) == SIZE, f"got {len(body)} of {SIZE}")

# Failure BEFORE any byte. This is the dangerous case: measured on Bun, erroring a
# body before its first chunk produces 200 OK with a cleanly terminated EMPTY
# body, i.e. a failed download that looks like a successful empty file. The
# gateway therefore commits the first byte before the response exists, so this has
# to surface as an error status instead.
ctl("/faults", {"dropGetAfterBytes": 0})
head, body, reset, terminated, adv = get("/w.bin")
status = head.split("\r\n")[0] if head else "(no response)"
check("failure before the first byte is an error status, not 200", not status.startswith("HTTP/1.1 200"), status)
check("...and delivers no file content", len(body) == 0 or not status.startswith("HTTP/1.1 200"), f"status={status} bodylen={len(body)}")

# Failure AFTER bytes have flowed. Note what is NOT guaranteed: for a small body
# Bun buffers the whole response and still emits a clean chunked terminator, so
# framing alone does not always reveal the truncation. What IS guaranteed is that
# the delivered length is short of the size advertised by PROPFIND, which is the
# comparison rclone makes (and which tests/rclone-faults.sh exercises end to end).
ctl("/faults", {"dropGetAfterBytes": 100000})
head, body, reset, terminated, adv = get("/w.bin")
status = head.split("\r\n")[0] if head else "(no response)"
check("mid-transfer failure does not deliver the whole file", len(body) < SIZE, f"bodylen={len(body)} of {SIZE}")
check("mid-transfer failure never advertises the full length", adv is None or adv == len(body), f"advertised={adv} delivered={len(body)}")
print(f"     (note: reset={reset} clean_terminator={terminated} -- framing is not a reliable signal here)")

# A genuinely empty file must still be a clean success, not caught by the above.
ctl("/faults", {"dropGetAfterBytes": None})
ctl("/seed-file", {"path": "/empty.bin", "content": ""})
head, body, reset, terminated, adv = get("/empty.bin")
check("empty file is a clean 200", head.startswith("HTTP/1.1 200"), head.split("\r\n")[0])
check("empty file delivers zero bytes", len(body) == 0, f"bodylen={len(body)}")

print()
print(f"RESULT: {passed} passed, {failed} failed")
sys.exit(0 if failed == 0 else 1)
PY
