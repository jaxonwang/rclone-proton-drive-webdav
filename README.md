# Proton Drive for rclone

A small local service that lets **stock rclone** talk to Proton Drive through
Proton's **official Drive SDK**, reusing a session you have already
authenticated with the official Proton Drive CLI.

It is a long-running foreground process, not a managed daemon: it ships no
systemd unit and does not survive logout or reboot.

```bash
rclone copy  ~/photos protondrive-sdk:photos --immutable -P
rclone check ~/photos protondrive-sdk:photos --checksum
rclone mount protondrive-sdk: ~/mnt/proton --vfs-cache-mode full
```

Unaffiliated with Proton AG. Not an official Proton product, and it uses no
Proton branding. It identifies itself to the API honestly as
`external-drive-rclone`, never as an official client, as Proton's SDK usage
guidelines require.

---

## Why this exists

rclone has a native `protondrive` backend. This is a different approach: rather
than reimplementing Proton's cryptography, it runs Proton's own SDK in a local
process and puts a WebDAV surface in front of it, so all encryption, integrity
verification and metadata handling stay inside code Proton maintains.

## Why this shape

**The SDK cannot log in.** Proton's Drive SDK deliberately ships no
authentication, no session management and no address provider. Its README is
explicit about that. The official CLI supplies exactly those pieces, so this
service imports them — the account module, credential stores, encrypted SQLite
caches and event provider — instead of reimplementing them. That is why it
installs into the CLI workspace as `cli/src/service/` rather than standing alone.

**A daemon, not a process per operation.** Shelling out to the CLI for each
rclone operation would re-authenticate, rebuild the crypto cache and refetch keys
every time. One long-lived process keeps the session, key cache and event cursor
warm. It never invokes the CLI binary.

**Why WebDAV.** rclone's WebDAV backend, driven with the right vendor quirks,
already carries everything needed: SHA-1 exchange, modification times, ranged
reads, sizes and listings. Writing a new Go backend would mean reimplementing
Proton's crypto outside the SDK.

Plain WebDAV alone is *not* enough, which is why the vendor setting matters:

| Need | Plain WebDAV | Used here |
|---|---|---|
| SHA-1 comparison | absent | ownCloud `oc:checksums` + `OC-Checksum` upload header |
| Modification time on upload | read-only | `X-OC-Mtime`, answered `X-OC-Mtime: accepted` |
| Ranged reads | optional | `Range` → `206` with `Content-Range` |
| Quota | optional | `quota-used-bytes` / `quota-available-bytes` |
| Hash recalculation | absent | Nextcloud `PATCH` + `X-Recalculate-Hash` |

---

## The rclone config is load-bearing

```ini
[protondrive-sdk]
type = webdav
url = http://localhost/
vendor = nextcloud
nextcloud_chunk_size = 0
unix_socket = /run/user/1000/proton-drive-webdav.sock
```

`url` is a placeholder; `unix_socket` decides where requests go. Point it at
`$XDG_RUNTIME_DIR/proton-drive-webdav.sock`.

**`vendor = nextcloud` is required, not cosmetic.** With `vendor = owncloud`
rclone advertises MD5 *and* SHA-1 for the remote, then picks the lowest-numbered
common hash, which is MD5. Proton only ever has a SHA-1, so
`rclone check --checksum` reports:

```
0 differences found
1 hashes could not be checked
1 matching files
```

That is a silent no-op. It was reproduced against deliberately corrupted data,
which was reported as matching. The nextcloud quirks set SHA-1 only, so the
common hash is SHA-1 and content really is compared — while still sending
`OC-Checksum` on upload, which `vendor = fastmail` does not.

**`nextcloud_chunk_size = 0` is required.** It disables rclone's Nextcloud
chunked-upload protocol, which this service does not implement, and it avoids
rclone's chunk-URL probe that fails against a non-Nextcloud URL layout. Expect
one `NOTICE: Chunked uploads are disabled...` line per invocation.

**rclone 1.68.0 minimum, 1.75.1 recommended.** Established by fetching
`backend/webdav/webdav.go` at every tag from v1.62.0 to v1.75.1: `unix_socket`
first appears in v1.68.0. Every nextcloud quirk this relies on (`hasOCSHA1`,
`useOCMtime`, `propsetMtime`, and `nextcloud_chunk_size = 0` disabling chunking)
is present from v1.64.0, so nothing pushes the floor higher. The
`PATCH X-Recalculate-Hash` quirk exists *only* from v1.75.1; below that rclone
never sends it and embeds the digest in `SetModTime` instead, which costs nothing
here because Proton's SHA-1 is intrinsic to the revision. So: degradation below
1.75.1, not breakage.

---

## Setup

```bash
git clone <this repo> proton-rclone && cd proton-rclone
scripts/setup.sh                 # workspace/ : isolated Bun + Proton sources + this service
cd workspace/sdk/cli
bash tests/run-all.sh            # 362 checks, no Proton account required
```

Then authenticate once with the official CLI, and start the service against the
same data directory:

```bash
PROTON_DRIVE_CACHE_DIR="$HOME/.local/state/proton-drive-cli" \
PROTON_DRIVE_CREDENTIALS_STORE=keychain \
PROTON_WEBDAV_SOCKET="$XDG_RUNTIME_DIR/proton-drive-webdav.sock" \
PROTON_WEBDAV_ROOT=/my-files \
  bun run src/service/serve.ts
```

| Variable | Meaning | Default |
|---|---|---|
| `PROTON_DRIVE_CACHE_DIR` | CLI data dir: session, caches, client UID, event cursor | XDG paths |
| `PROTON_DRIVE_CREDENTIALS_STORE` | `keychain` \| `pass` \| `unsafe_file` (same values as the CLI) | `keychain` |
| `PROTON_DRIVE_LOG_LEVEL` | `DEBUG`/`INFO`/`WARNING`/`ERROR` | `WARNING` |
| `PROTON_WEBDAV_SOCKET` | Unix socket path | `$XDG_RUNTIME_DIR/proton-drive-webdav.sock` |
| `PROTON_WEBDAV_ROOT` | Proton path served as `/` | `/my-files` |
| `PROTON_WEBDAV_IMMUTABLE` | `1` refuse overwriting existing content; `0` create new revisions | `1` |
| `PROTON_WEBDAV_OVERRIDE_DRAFT_PATH` | the one exact path where replacing **another client's** unfinished upload is authorised | unset |
| `PROTON_WEBDAV_ALLOW_CONCURRENT_CLIENT` | `1` to start even when another Proton client is active (not recommended) | unset |

The socket is mode `0600` under your runtime directory: no TCP port, no
password, and no way for another local user to reach it.

---

## What works

| Command | Notes |
|---|---|
| `ls`, `lsl`, `lsjson` | names, sizes, modification times |
| `hashsum SHA1` | Proton's stored SHA-1 per file |
| `copy` | both directions |
| `check --checksum` | real SHA-1 comparison |
| `cat --offset --count` | arbitrary byte ranges |
| `mount` | browse, read, seek, write |
| `about` | storage used and available |
| `mkdir`, `moveto`, `deletefile`, `rmdir` | |

Those have tests behind them. Other read-only commands should follow, since this
is a stock WebDAV remote, but they are not exercised here.

## Guarantees

- **Uploads are confirmed, not assumed.** Success is reported only after Proton
  commits the revision.
- **Interrupted uploads recover, but do not resume byte-wise.** An interruption
  commits nothing and leaves a Proton draft, which is invisible to listings, so a
  partial upload can never be mistaken for a complete file. Rerunning the same
  command completes it correctly — but it re-sends the whole file from byte zero,
  because the SDK replaces its own stale draft rather than continuing it. Measured:
  a 3,000,000-byte file interrupted after 913,408 bytes cost 3,000,000 bytes on the
  retry. Budget for that on a large file over a bad link.
- **Existing content is protected by default.** Identical content is skipped
  without transferring; differing content is refused rather than overwritten.
  Set `PROTON_WEBDAV_IMMUTABLE=0` for new revisions instead (Proton keeps the
  previous one either way).
- **Another client's unfinished upload is never touched** unless you name that
  exact path. Broad deletion or trashing is never used as draft recovery.
- **A dead session stops the run instead of grinding.** If Proton rejects the
  saved token, every request answers `401` with the remedy in the body. `401` is
  deliberately outside rclone's retry set, so an unattended
  `copy --retries 100 --checksum` stops at the first failure rather than replaying
  the whole tree a hundred times.
- **Deletes go to Proton's trash**, never a permanent delete.
- **One writer.** A lock makes exactly one process the owner of credential
  updates, and the service refuses to start while another Proton client is using
  the same data directory.
- **Credentials never appear** in logs, arguments, error bodies or artifacts.
  Permissions are checked and tightened, never widened.

## Limitations

1. **Not yet exercised against live Proton.** The SDK gateway is covered by
   contract tests against a `ProtonDriveClient` double, and the session layer
   against a mock Proton API. Treat first real use as a read-only trial.
2. **One Proton client at a time per data directory.** Two would share a
   rotating refresh token. The service also shares that directory's log and
   SQLite caches with the CLI.
3. **Modification times cannot be changed after upload.** Proton stores mtime
   inside the revision, so `rclone touch` fails. Times set during upload are kept
   exactly. Prefer `--checksum` for comparisons: a skipped file keeps its old
   remote timestamp, so a size+mtime comparison may keep re-offering it.
4. **No streaming uploads of unknown size**, so `rclone rcat` will not work.
   `copy`, `sync` and `mount` all supply a size.
5. **Server-side directory copy is unsupported** (`501`); rclone falls back to
   per-file copies.
6. **Mount writes report failures asynchronously.** With `--vfs-cache-mode full`
   the local write and close succeed and the upload happens later, so a refusal
   appears in the rclone log rather than as an error to the writing program, and
   the file stays in the VFS cache and is retried. Use a dedicated `--cache-dir`.
7. **Files are skipped, with a warning, when Proton cannot decrypt the name** or
   when the revision reports no clear-text size. Reporting size `0` would make
   rclone copy such a file as empty and call it done.
8. **SHA-1 only.** Proton has no MD5. Files whose revision carries no digest
   expose no hash, and none is ever fabricated. Be aware of what that means for
   verification: `rclone check --checksum` reports such a file as matching, on
   size alone, with exit 0. That is the same output shape as the `vendor = owncloud`
   trap described above, so treat "0 differences" as conditional on the remote
   actually having digests.
9. **No systemd unit and no auto-restart.** It does not survive logout or reboot.
   The default socket lives under `$XDG_RUNTIME_DIR`, which the system removes at
   last logout; the process would then still be running but unreachable, so it
   watches its own socket and exits if it disappears, releasing its locks. For an
   unattended long-running job, either enable lingering for the user or put the
   socket somewhere persistent.
10. **Photos, albums, sharing and trash browsing are not exposed.** One Drive
    subtree is served.

---

## Notable defects found while building this

Worth reading if you are integrating rclone with anything, not just Proton.

### rclone deletes the PUT target after *any* failed upload

`backend/webdav` runs `_ = o.Remove(ctx)` after a failed `PUT`, discarding the
result, to clear a partial object. That is right for a new object and destructive
when the server deliberately refused to overwrite an existing one: the cleanup
`DELETE` trashes the very file the refusal protected, and the retry then succeeds
into the freed name.

```
ERROR : Attempt 1/3 failed ... 412 Precondition Failed
ERROR : Attempt 2/3 succeeded          <-- the original file was gone
```

`overwriteGuard.ts` marks a path when a `PUT` fails while content exists there and
rejects a `DELETE` of that exact path for the next 15 seconds. A first version
armed only on `412`, which was not enough: rclone deletes after *any* failure, so
a transient `429`/`503`, an integrity failure, or a `PUT` aimed at an existing
collection (which trashes a whole subtree) all slipped through. rclone has a
second such path, `Removing failed copy`, run when its own post-transfer hash
check fails; the same guard covers it.

### The SDK never closes the download stream

`downloadToStream` calls `writer.releaseLock()` on success and leaves the writer
locked on failure — it never closes the stream. Ending it is the caller's job. An
implementation that used a `TransformStream` and relied on `flush` to run the
integrity check and end the body would hang forever and never verify anything,
and its failure path would call `abort()` on a stream the SDK still held locked.
A test double that closed the stream hid this completely.

### Ranged reads leaked the SDK's download slots

`getSeekableStream()` takes one of five download-queue slots and, unlike
`downloadToStream`, has no terminal hook that frees it — only an abort on the
signal it was created with. Five ranged reads exhausted the queue and every later
download blocked forever, which `rclone mount` hits within seconds. Each ranged
read now owns an `AbortController` fired on completion, error and cancellation.

### Erroring a response body is not always visible to the client

Measured on Bun 1.3.14 over a Unix socket: a response body that errors **before**
its first chunk is sent as `200 OK` with a cleanly terminated empty chunked body,
so a failed download is indistinguishable from a successful zero-byte file. Bun
also computes its own `Content-Length` and ignores the handler's, so there is no
header-level length contract to fall back on. Even a *late* error only resets the
connection once output has actually been flushed; for a small body the whole
response is buffered and still terminated cleanly.

So the first byte is committed before the response exists: a read does not return
until the transfer has produced a chunk, finished (an empty file), or failed. An
early failure becomes a real HTTP error status; a later one truncates a response
whose delivered length is short of the size advertised by `PROPFIND`, which is the
comparison rclone makes. `tests/wire-tests.sh` asserts this on the socket, because
in-process tests inspect a `Response` object and can never see framing.

### A legacy revision leaked a download slot on every ranged read

`getSeekableStream()` throws for revisions with no claimed block sizes — but it
registers its abort listener *after* that check, so nothing is listening and the
queue slot the downloader already took is held forever. Five ranged reads of such
files block every later download. Aborting cannot fix it; the only other release
hook is `downloadToStream`'s own `finally`, so that is driven deliberately with an
aborted signal and a sink that refuses data, making the SDK run its cleanup.

### A transient 4xx would have destroyed a valid session

The account module signs out on **any** 4xx from `/auth/v4/refresh` except 429,
with no retry because the refresh is a POST. That bucket includes 408, and
anything a captive portal, proxy or WAF injects. Acting on it as proof the session
is dead would end an unattended backup over a hotel Wi-Fi redirect. Sign-out now
preserves the session file and records a secret-free marker instead.

An earlier version renamed the file aside, which avoided deletion but minted a
fresh on-disk copy of `userKeyPassword` each time — derived from the account
password, and a valid passphrase for the user's OpenPGP keys indefinitely. So
repeated false positives accumulated live decryption credentials in cleartext.

### The official CLI can still become a second writer

It takes no lock on the session file, writes it in place, and runs happily when
its own `events.lock` is already held. Starting it *after* the service therefore
gives two processes one rotating refresh token, and whoever loses invalidates the
other. Startup checks can only see a CLI that is already running, so a save now
refuses to overwrite a session that changed underneath it. Do not run the official
CLI against the same `PROTON_DRIVE_CACHE_DIR` while the service is up.

### A reboot could leave the service unable to start, permanently

Lock files record a pid, and pid liveness cannot distinguish "still held" from
"pid recycled". That distinction matters most straight after a boot, which is
exactly when it is least reliable: pids are re-allocated from 1, so a lock
written by a service that itself started at boot has a real chance of naming a
pid now held by an unrelated daemon. The lock then looks live forever. For the
CLI's `events.lock` there was no escape at all except deleting the file by hand
or disabling the concurrency protection wholesale — so an unattended backup would
simply never run again after one bad shutdown.

No process survives a boot, so a lock file older than the current boot cannot be
held, whatever its pid resolves to now. Both locks use that test, and a lock
written during this boot is still honoured exactly as before. The stale
`events.lock` is removed only under that condition, which is also what the CLI's
own acquire path does for locks it considers stale.

### A power loss could leave plaintext credentials in a stray file, forever

The atomic-write helper unlinks its temp file on any in-process failure, but a
power loss between create and rename leaves it behind — holding a complete
plaintext session, including `userKeyPassword`, which is a valid passphrase for
the user's OpenPGP keys. Nothing ever removed it, so copies accumulated one per
hard stop. They are now pruned at startup, after the single-writer lock is held,
which is what makes "nobody is mid-write" true rather than hopeful.

### A dead session looked like a server error, so rclone ground on it

Proton rotates the refresh token on use: the new one is persisted only after the
call returns, so a power loss in that window leaves a token on disk that is
already spent. Startup cannot detect this, because "logged in" is decided from
local fields alone. The service therefore started cleanly and every operation
failed at the first refresh.

That failure used to surface as `500`/`502`. Both are in rclone's webdav retry
set; `401` is not. So `rclone copy --retries 100 --checksum` replayed the entire
command a hundred times, re-reading and re-hashing every source byte on each
pass, and never progressed. A sign-out latch now makes every subsequent request
answer `401` naming re-authentication as the remedy, and rclone stops after one
attempt. Verified end to end: rclone logs `Attempt 1/1` and gives up.

### An error message invited waiving a protection that was not the problem

When the SDK hits a name held by an unfinished upload it deletes its own draft
and retries. If that delete fails — a transient API error is enough — it skips
the retry and raises the same error it uses for *another client's* draft. The
service mapped that to a `409` asserting the draft belonged to another client and
naming `PROTON_WEBDAV_OVERRIDE_DRAFT_PATH` as the fix. Following that advice
would grant a standing override for a draft that was ours all along, on the
strength of a transient failure. Upstream compounds it by logging "conflict by
another client" precisely when the draft *is* its own. The message now states
that it may be our own draft, puts retrying first, and makes the override
conditional.

### Smaller ones

- A single-writer lock that exempted its own PID would steal its own lock; the
  stale-lock path also had a check-then-unlink race.
- An atomic-write helper with a fixed temp name and no cleanup on failure would
  silently stop persisting refreshed tokens, and leave plaintext credentials in a
  stray file.
- A startup refused because another client was active still created files in that
  client's data directory, because the check ran after the first write.
- A locked-but-present OS keyring can block `libsecret` on an unlock prompt no
  background process will answer, hanging startup while holding the lock; the
  credential load is now bounded by a timeout.
- The upload permit the SDK takes before a transfer had no cancellation path, so a
  disconnected client held it for the whole transfer and a queued request waited
  with no deadline. The request's abort signal is now passed through.
- A body-less `PUT` was treated as an empty upload even when the client declared a
  nonzero `Content-Length`, which is how a nonempty source ends up stored as empty.

---

## Tests

No Proton account, no network dependency, no machine configuration changes.
Network failures are injected inside an in-memory gateway.

```
$ bash tests/run-all.sh
  typecheck clean
SUITE: webdav-protocol  RESULT:  97 passed, 0 failed
SUITE: sdk-gateway      RESULT: 105 passed, 0 failed
SUITE: session          RESULT:  72 passed, 0 failed
SUITE: rclone-smoke     RESULT:  20 passed, 0 failed
SUITE: rclone-faults    RESULT:  29 passed, 0 failed
SUITE: rclone-mount     RESULT:  15 passed, 0 failed
SUITE: wire             RESULT:   8 passed, 0 failed
SUITE: reboot-resume    RESULT:  16 passed, 0 failed
TOTAL: 362 passed, 0 failed across 8 suites
```

| Suite | What it drives |
|---|---|
| `webdav-protocol-tests.ts` | `handleRequest` directly: status codes, headers, XML |
| `sdk-gateway-tests.ts` | a `ProtonDriveClient` double mirroring the real stream and queue contracts |
| `session-tests.ts` | the real account module against a mock Proton API, synthetic credentials only |
| `rclone-smoke.sh` | real rclone: copy, check, hashsum, ranged cat, immutability |
| `rclone-faults.sh` | interrupted transfers, drafts, consent scoping, retries, revoked session |
| `rclone-mount.sh` | FUSE mount: listing, reads, kernel ranged reads, writes, immutability |
| `wire-tests.sh` | raw socket: how failures are actually framed on the wire |
| `reboot-resume.sh` | a mid-transfer crash, then the same command rerun against the surviving remote state |

Covered explicitly: interrupted uploads, own-draft recovery, another client's
draft, scoped consent, process restart, token refresh and persistence,
unavailable keyring, expired and revoked sessions, committed-file conflicts,
checksum mismatches, download-slot exhaustion, zero-byte files, unsatisfiable
ranges and legacy revisions.

Several of the project's own tests were false-confidence and were fixed: a mount
assertion that unmounted before rclone's writeback so the write never reached the
server; a shared VFS cache that let a refused upload shadow the remote on a later
run; fault injection consumed by a `PROPFIND` before reaching the `PUT`; a
`grep -v` assertion that could never fail; a keyring test that accepted a process
it had to `SIGKILL`; and the download double described above. A ninth: the SDK double registered an
abort listener on the whole-file download path that the real SDK only registers
for seekable streams, which hid the slot leak above.

---

## Layout

```
src/service/
  gateway.ts          storage-agnostic interface + typed errors (the seam)
  paths.ts            POSIX path handling for WebDAV
  propfind.ts         WebDAV XML rendering (ownCloud/Nextcloud extensions)
  webdav.ts           protocol translation: PROPFIND/GET/PUT/PATCH/MKCOL/...
  overwriteGuard.ts   protects committed data from rclone's cleanup DELETE
  sessionStore.ts     credential store: single-writer lock, atomic 0600, quarantine
  bootstrap.ts        wires the SDK + account module + caches + events
  sdkGateway.ts       the real gateway over ProtonDriveClient
  mockGateway.ts      in-memory double with fault injection (tests only)
  serve.ts            production entry point (Unix socket)
  serveMock.ts        test entry point (+ control socket)
tests/                eight suites; run-all.sh runs them and prints one summary
scripts/setup.sh      builds the workspace: Bun + Proton sources + this service
```

The WebDAV layer depends only on `gateway.ts`, never on the SDK, which is what
lets the protocol be tested against an in-memory fake and run against Proton
unchanged.

## License

MIT, see [LICENSE](LICENSE). Proton's SDK and CLI are fetched by
`scripts/setup.sh` and are not redistributed here; they are MIT licensed by
Proton AG. Use of Proton's hosted services remains subject to Proton's own terms.
