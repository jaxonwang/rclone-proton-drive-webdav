#!/usr/bin/env bash
# One copy pass to Proton Drive through the WebDAV bridge.
#
# Invoked repeatedly by proton-rclone-copy.timer. Nothing is checkpointed
# locally: each run re-derives what is left from the remote, so it is safe to
# kill at any point. That is also why the TIMER, not --retries, is what makes the
# job survive a reboot.
set -uo pipefail

# --- configure -------------------------------------------------------------
STATE="$HOME/.local/state/proton-rclone"
SRC="$HOME/media"                      # source tree
DST="protondrive-sdk:media"            # remote, see rclone.conf.example
SOCK="$STATE/dav.sock"                 # must match PROTON_WEBDAV_SOCKET
CONF="$STATE/rclone.conf"
# Top-level entries that must exist in SRC. An unmounted filesystem presents as
# an empty directory, which is indistinguishable from "already uploaded".
REQUIRE_SUBDIRS=()
# ---------------------------------------------------------------------------

DONE="$STATE/COMPLETE"
mkdir -p "$STATE/logs"; chmod 700 "$STATE" "$STATE/logs"
LOG="$STATE/logs/copy-$(date -u +%Y%m%dT%H%M%SZ).log"
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$STATE/logs/runner.log"; }

# Once a pass has verified the whole tree, stop re-reading every local byte each
# time the timer fires. Delete the marker to force a fresh full pass.
if [ -f "$DONE" ]; then
  log "COMPLETE present; nothing to do (rm $DONE to force a pass)"
  exit 0
fi

# --- source guards ---------------------------------------------------------
if [ ! -d "$SRC" ]; then log "ABORT: source $SRC is not a directory"; exit 75; fi
if ! findmnt -T "$SRC" >/dev/null 2>&1; then log "ABORT: $SRC is not on a mounted filesystem"; exit 75; fi
for d in "${REQUIRE_SUBDIRS[@]:-}"; do
  [ -z "$d" ] && continue
  if [ ! -d "$SRC/$d" ]; then log "ABORT: expected subtree missing: $d"; exit 75; fi
done

# --- the bridge must be up -------------------------------------------------
for _ in $(seq 1 120); do [ -S "$SOCK" ] && break; sleep 2; done
if [ ! -S "$SOCK" ]; then log "ABORT: bridge socket $SOCK never appeared"; exit 76; fi

# --- copy ------------------------------------------------------------------
# --checksum      real SHA-1 comparison; the only hash Proton and rclone share.
# --immutable     never replace committed content; a differing file is an error.
# --transfers 1   above 40 MiB in flight the SDK admits one file anyway, and a
#                 surplus PUT blocks on an untimed capacity wait.
# --timeout 0     MANDATORY. A PUT is answered only after Proton commits, and the
#                 default 5m idle timeout kills any slower upload. See README.
# --low-level-retries 1
#                 each retry re-sends the WHOLE file (no byte-level resume), so
#                 the default of 10 is very expensive. The timer retries instead.
log "starting pass -> $LOG"
rclone copy "$SRC" "$DST" \
  --config "$CONF" \
  --checksum --immutable \
  --transfers 1 --retries 2 --low-level-retries 1 \
  --timeout 0 \
  --log-file "$LOG" --log-level INFO --stats 5m
rc=$?
log "rclone exit=$rc"

if [ "$rc" -eq 0 ]; then
  # Exit 0 only means THIS pass's frozen work set is done. rclone fixes that set
  # when it finishes listing -- which for a large tree happens minutes into a run
  # that lasts days -- so anything added to the source afterwards is NOT in it.
  # Writing the marker on exit 0 alone would stop the timer and bury those files
  # silently. Verify against the LIVE source instead of trusting the exit code.
  want=$(find "$SRC" -type f | wc -l)
  got=$(rclone --config "$CONF" size "$DST" --json 2>/dev/null \
        | python3 -c 'import json,sys; print(json.load(sys.stdin)["count"])' 2>/dev/null || echo -1)
  if [ "$got" = "$want" ]; then
    date -u +%Y-%m-%dT%H:%M:%SZ > "$DONE"
    log "pass completed and remote count matches the live source ($got); wrote $DONE"
  else
    log "NOT writing $DONE: remote has $got file(s), live source has $want; another pass will run"
    exit 70
  fi
else
  log "pass incomplete (exit $rc); the timer will run again"
fi
exit "$rc"
