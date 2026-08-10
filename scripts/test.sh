#!/usr/bin/env bash
#
# Runs one confidential round end to end against a live deployment.
#
# This is the test that cannot be run locally and cannot be faked: it proves that the ECIES
# ciphertext produced by the browser's lib/ecies.ts is decryptable by go-ethereum's ecies package
# inside a real enclave. Every other test in this repository proves internal consistency, which two
# identically wrong implementations would also pass.
#
# The work is in scripts/e2e/round.ts, which imports the *browser* modules directly rather than
# reimplementing them — so if the organisation console would fail, this fails the same way.
#
#   ./scripts/test.sh
#
# Requires: a funded Coston2 deployer key, a reachable proxy, and a TEE machine in PRODUCTION.
# Costs a small amount of real testnet C2FLR. Check ./scripts/check-tee-status.sh first.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

[[ -f .env ]] || { echo "error: .env not found. Copy .env.example and fill it in." >&2; exit 1; }

# Let an explicit environment value survive sourcing.
#
# `set -a; source .env` overwrites the environment, including with the *empty* values .env.example
# ships. So `EXT_PROXY_URL=… ./scripts/test.sh` would silently lose its argument and then fail
# claiming the variable was never set. Remember it first, restore it after.
_PRESET_PROXY_URL="${EXT_PROXY_URL:-}"

# shellcheck disable=SC1091
set -a; source .env; set +a

[[ -n "$_PRESET_PROXY_URL" ]] && EXT_PROXY_URL="$_PRESET_PROXY_URL"

# FIDENSUR_CONTRACT lives here, written by pre-build.sh — not in .env.
[[ -f config/extension.env ]] && { set -a; source config/extension.env; set +a; }

: "${CHAIN_URL:?CHAIN_URL must be set in .env}"
: "${EXT_PROXY_URL:?EXT_PROXY_URL must be set in .env}"
: "${DEPLOYMENT_PRIVATE_KEY:?DEPLOYMENT_PRIVATE_KEY must be set in .env}"
: "${FIDENSUR_CONTRACT:?FIDENSUR_CONTRACT must be set in config/extension.env}"
export CHAIN_URL EXT_PROXY_URL DEPLOYMENT_PRIVATE_KEY FIDENSUR_CONTRACT

BUILD_DIR="${TMPDIR:-/tmp}/fidensur-e2e"
BUNDLE="$BUILD_DIR/round.mjs"
ESBUILD="$ROOT/frontend/node_modules/.bin/esbuild"

[[ -x "$ESBUILD" ]] || {
  echo "error: esbuild not found. Run 'npm install' in frontend/ first." >&2
  exit 1
}

# Bundle rather than running the TypeScript directly.
#
# Node can execute .ts with --experimental-transform-types, but resolving viem's several thousand
# ESM files takes over 100 seconds on a cold filesystem — and it is pure I/O wait, so a faster CPU
# does not help. esbuild reads them once and emits a single tree-shaken file that starts in
# under ten seconds. Bundling also handles the TypeScript enums that type-stripping cannot.
mkdir -p "$BUILD_DIR"

NEWEST=$(find scripts/e2e frontend/lib -name '*.ts' -newer "$BUNDLE" -print -quit 2>/dev/null || true)
if [[ ! -f "$BUNDLE" || -n "$NEWEST" ]]; then
  echo "bundling scripts/e2e/round.ts (slow on a cold cache; cached afterwards)..."
  # NODE_PATH is required: dependencies live in frontend/node_modules, but the entry point is
  # scripts/e2e/round.ts. esbuild resolves bare imports from the importing file's own directory
  # upward, and nothing above scripts/ has a node_modules — so `viem` is unresolvable without it.
  # The frontend/lib modules resolve on their own; only this file's own imports need the hint.
  #
  # It has to be the environment variable, not a flag: `nodePaths` exists in esbuild's JS API but
  # the CLI has no `--node-paths`, and passing one fails with "Invalid build flag".
  NODE_PATH="$ROOT/frontend/node_modules" \
  "$ESBUILD" scripts/e2e/round.ts \
    --bundle \
    --platform=node \
    --format=esm \
    --target=node22 \
    --node-paths="$ROOT/frontend/node_modules" \
    --outfile="$BUNDLE" \
    --log-level=warning
else
  echo "reusing cached bundle ($BUNDLE)"
fi

echo
exec node "$BUNDLE"
