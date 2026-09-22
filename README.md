# Proton Drive for rclone

A small local service that lets **stock rclone** talk to Proton Drive through
Proton's **official Drive SDK**, reusing a session you have already
authenticated with the official Proton Drive CLI.

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

**Minimum rclone version: 1.68.0**, the first release containing the webdav
`unix_socket` option.

---

## Setup

```bash
git clone <this repo> proton-rclone && cd proton-rclone
scripts/setup.sh                 # workspace/ : isolated Bun + Proton sources + this service
cd workspace/sdk/cli
bash tests/run-all.sh            # 283 checks, no Proton account required
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
- **Interrupted uploads resume.** An interruption commits nothing and leaves a
  Proton draft; retrying reuses it.
- **Existing content is protected by default.** Identical content is skipped
  without transferring; differing content is refused rather than overwritten.
  Set `PROTON_WEBDAV_IMMUTABLE=0` for new revisions instead (Proton keeps the
  previous one either way).
- **Another client's unfinished upload is never touched** unless you name that
  exact path. Broad deletion or trashing is never used as draft recovery.
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
   expose no hash; none is ever fabricated.
9. **No systemd unit and no auto-restart.** It does not survive reboot by design.
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

### Smaller ones

- A single-writer lock that exempted its own PID would steal its own lock; the
  stale-lock path also had a check-then-unlink race.
- An atomic-write helper with a fixed temp name and no cleanup on failure would
  silently stop persisting refreshed tokens, and leave plaintext credentials in a
  stray file.
- A startup refused because another client was active still created files in that
  client's data directory, because the check ran after the first write.

---

## Tests

No Proton account, no network dependency, no machine configuration changes.
Network failures are injected inside an in-memory gateway.

```
$ bash tests/run-all.sh
  typecheck clean
SUITE: webdav-protocol  RESULT: 79 passed, 0 failed
SUITE: sdk-gateway      RESULT: 91 passed, 0 failed
SUITE: session          RESULT: 52 passed, 0 failed
SUITE: rclone-smoke     RESULT: 20 passed, 0 failed
SUITE: rclone-faults    RESULT: 26 passed, 0 failed
SUITE: rclone-mount     RESULT: 15 passed, 0 failed
TOTAL: 283 passed, 0 failed across 6 suites
```

| Suite | What it drives |
|---|---|
| `webdav-protocol-tests.ts` | `handleRequest` directly: status codes, headers, XML |
| `sdk-gateway-tests.ts` | a `ProtonDriveClient` double mirroring the real stream and queue contracts |
| `session-tests.ts` | the real account module against a mock Proton API, synthetic credentials only |
| `rclone-smoke.sh` | real rclone: copy, check, hashsum, ranged cat, immutability |
| `rclone-faults.sh` | interrupted transfers, drafts, consent scoping, retries, revoked session |
| `rclone-mount.sh` | FUSE mount: listing, reads, kernel ranged reads, writes, immutability |

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
it had to `SIGKILL`; and the download double described above.

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
tests/                six suites; run-all.sh runs them and prints one summary
scripts/setup.sh      builds the workspace: Bun + Proton sources + this service
```

The WebDAV layer depends only on `gateway.ts`, never on the SDK, which is what
lets the protocol be tested against an in-memory fake and run against Proton
unchanged.

## License

MIT, see [LICENSE](LICENSE). Proton's SDK and CLI are fetched by
`scripts/setup.sh` and are not redistributed here; they are MIT licensed by
Proton AG. Use of Proton's hosted services remains subject to Proton's own terms.
