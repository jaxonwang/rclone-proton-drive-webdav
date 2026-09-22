#!/usr/bin/env bash
# Builds a self-contained workspace for the Proton Drive WebDAV service.
#
#   scripts/setup.sh [workspace-dir]     (default: ./workspace)
#
# Everything is confined to the workspace directory: an isolated Bun toolchain,
# a clone of Proton's official SDK/CLI sources, and this service copied into it.
# No system packages are installed and nothing outside the workspace is touched.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WS="${1:-$REPO_DIR/workspace}"

BUN_VERSION="1.3.14"   # the Bun version the official CLI is built with
SDK_TAG="cli/v0.8.0"   # Proton Drive CLI release this service is developed against
SDK_REPO="https://github.com/ProtonDriveApps/sdk.git"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)  BUN_TARGET="linux-x64" ;;
  Linux-aarch64) BUN_TARGET="linux-aarch64" ;;
  Darwin-arm64)  BUN_TARGET="darwin-aarch64" ;;
  Darwin-x86_64) BUN_TARGET="darwin-x64" ;;
  *) echo "Unsupported platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

echo "workspace: $WS"
mkdir -p "$WS/tools"

# --- 1. isolated Bun -------------------------------------------------------
# The official CLI is Bun-native (Bun.file, bun:sqlite, Bun.secrets), so this
# service is too. Bun is installed inside the workspace, not system-wide.
if [ ! -x "$WS/tools/bun/bin/bun" ]; then
  echo "==> fetching Bun $BUN_VERSION ($BUN_TARGET)"
  ( cd "$WS/tools"
    curl -fsSL -o bun.zip \
      "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-${BUN_TARGET}.zip"
    rm -rf bun "bun-${BUN_TARGET}"
    unzip -q bun.zip
    mkdir -p bun/bin
    mv "bun-${BUN_TARGET}/bun" bun/bin/bun
    chmod +x bun/bin/bun
    rm -rf "bun-${BUN_TARGET}" bun.zip )
fi
export PATH="$WS/tools/bun/bin:$PATH"
echo "    bun $(bun --version)"

# --- 2. Proton's official sources -----------------------------------------
# Cloned, never vendored: this repository contains no Proton code.
if [ ! -d "$WS/sdk/.git" ]; then
  echo "==> cloning Proton Drive SDK at $SDK_TAG"
  git clone -q --depth 1 --branch "$SDK_TAG" "$SDK_REPO" "$WS/sdk"
fi
echo "    sdk $(git -C "$WS/sdk" describe --tags --always)"

# --- 3. drop this service into the CLI workspace --------------------------
# It lives inside cli/ because it imports the CLI's account, credential, cache
# and event modules directly. See README section "Why this shape".
echo "==> installing service and tests"
rm -rf "$WS/sdk/cli/src/service" "$WS/sdk/cli/tests"
cp -r "$REPO_DIR/src/service" "$WS/sdk/cli/src/service"
cp -r "$REPO_DIR/tests" "$WS/sdk/cli/tests"

# --- 4. dependencies (three workspaces) -----------------------------------
echo "==> installing dependencies (a few minutes on a cold cache)"
for pkg in cli client/js incubating/account/js; do
  echo "    $pkg"
  if ! ( cd "$WS/sdk/$pkg" && bun install > "$WS/install-$(echo "$pkg" | tr / _).log" 2>&1 ); then
    echo "bun install failed in $pkg; see $WS/install-$(echo "$pkg" | tr / _).log" >&2
    tail -20 "$WS/install-$(echo "$pkg" | tr / _).log" >&2
    exit 1
  fi
done

# --- 5. typecheck ---------------------------------------------------------
echo "==> typechecking"
( cd "$WS/sdk/cli" && bun ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json )

cat <<EOF

Ready.

  Run the test suites (no Proton account needed):
    cd $WS/sdk/cli && bash tests/run-all.sh

  Build a standalone binary:
    cd $WS/sdk/cli && CLI_APP_VERSION_NAME=external-drive-rclone \\
      CLI_VERSION=0.1.0 JS_VERSION=0.21.0 bun ./scripts/build-cli.mjs src/service/serve.ts
    # -> release/serve

  Start the service against an existing Proton Drive CLI session:
    cd $WS/sdk/cli && PROTON_DRIVE_CACHE_DIR=... bun run src/service/serve.ts

See the README for the rclone configuration, which is not optional.
EOF
