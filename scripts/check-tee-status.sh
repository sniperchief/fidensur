#!/usr/bin/env bash
#
# Answers "which side is broken?" for a Fidensur deployment, in about 30 seconds.
#
# Most FCC problems are client-side and look identical from the outside: instructions go out and
# nothing comes back. This checks the on-chain facts first, because they are authoritative — what
# the chain believes about your TEE machine is what the data providers act on, regardless of what
# your local stack is doing.
#
# The single most common cause is a stale URL. Data providers push to the address stored on-chain,
# so if your tunnel hostname rotated, the chain still points at the dead one and your queue stays
# empty forever with no error anywhere.
#
# Usage:
#   ./scripts/check-tee-status.sh              # contract + extension state
#   ./scripts/check-tee-status.sh <teeId>      # also check a registered TEE machine

set -euo pipefail

cd "$(dirname "$0")/.."

[[ -f .env ]] || { echo "error: .env not found." >&2; exit 1; }
# shellcheck disable=SC1091
set -a; source .env; set +a

[[ -f config/extension.env ]] && { set -a; source config/extension.env; set +a; }

TEE_ID="${1:-}"

: "${CHAIN_URL:?CHAIN_URL must be set}"
: "${TEE_MANAGER_ADDRESS:?TEE_MANAGER_ADDRESS must be set}"

# The live Coston2 FlareTeeManager. The previous deployment died on 22 Jul 2026, and a stale
# address is the top cause of FunctionNotFound and reverting register() calls — so check it
# explicitly rather than assuming .env is current.
LIVE_TEE_MANAGER=0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE

echo "=== Fidensur TEE status ==="
echo

# --- 1. Are we pointed at the live deployment? -----------------------------

echo "--- registry ---"
if [[ "${TEE_MANAGER_ADDRESS,,}" == "${LIVE_TEE_MANAGER,,}" ]]; then
  echo "  ok    TEE_MANAGER_ADDRESS is the live Coston2 deployment"
else
  echo "  FAIL  TEE_MANAGER_ADDRESS is $TEE_MANAGER_ADDRESS"
  echo "        expected $LIVE_TEE_MANAGER"
  echo "        A stale registry gives FunctionNotFound and a reverting register()."
fi

# --- 2. Does the contract's cached ID match our config? --------------------
#
# setExtensionId() caches the LOWEST matching ID, permanently. If registration ran twice, the tool
# may have reported a higher one — and config would then point the TEE node at an extension the
# contract never addresses. That surfaces as MachineManager.TooMany(), far from its cause.

echo
echo "--- extension ---"
if [[ -n "${FIDENSUR_CONTRACT:-}" ]]; then
  ON_CHAIN_ID=$(cast call "$FIDENSUR_CONTRACT" "extensionId()(uint256)" --rpc-url "$CHAIN_URL" 2>/dev/null | awk '{print $1}')
  echo "  contract:            $FIDENSUR_CONTRACT"
  echo "  extensionId() says:  ${ON_CHAIN_ID:-<unset>}"
  echo "  config says:         ${EXTENSION_ID:-<unset>}"

  if [[ -n "${EXTENSION_ID:-}" && -n "${ON_CHAIN_ID:-}" ]]; then
    if [[ "$ON_CHAIN_ID" == "$EXTENSION_ID" ]]; then
      echo "  ok    they match"
    else
      echo "  FAIL  MISMATCH — the contract only ever sends instructions under $ON_CHAIN_ID."
      echo "        Set EXTENSION_ID=$ON_CHAIN_ID in config/extension.env."
      echo "        The on-chain value is set-once and authoritative."
    fi
  fi

  TEE_ADDR=$(cast call "$FIDENSUR_CONTRACT" "teeAddress()(address)" --rpc-url "$CHAIN_URL" 2>/dev/null || echo "")
  if [[ "$TEE_ADDR" == "0x0000000000000000000000000000000000000000" || -z "$TEE_ADDR" ]]; then
    echo "  warn  teeAddress is unset — finalizeRound() will revert until it is set."
    echo "        After register-tee succeeds:"
    echo "          cast send $FIDENSUR_CONTRACT 'setTeeAddress(address)' <TEE_ID> \\"
    echo "            --rpc-url \$CHAIN_URL --private-key \$DEPLOYMENT_PRIVATE_KEY"
  else
    echo "  ok    teeAddress: $TEE_ADDR"
    [[ -z "$TEE_ID" ]] && TEE_ID="$TEE_ADDR"
  fi
else
  echo "  warn  FIDENSUR_CONTRACT unset — run ./scripts/pre-build.sh first"
fi

# --- 3. What does the chain believe about the TEE machine? -----------------

echo
echo "--- TEE machine ---"
if [[ -z "$TEE_ID" ]]; then
  echo "  none registered yet. After post-build, re-run with the machine address:"
  echo "    ./scripts/check-tee-status.sh <teeId>"
  exit 0
fi

echo "  teeId: $TEE_ID"

STATUS=$(cast call "$TEE_MANAGER_ADDRESS" "getTeeMachineStatus(address)(uint8)" "$TEE_ID" \
  --rpc-url "$CHAIN_URL" 2>/dev/null | awk '{print $1}' || echo "")

case "${STATUS:-}" in
  1) echo "  status: 1 = INITIALIZED — registered but not yet promoted" ;;
  2) echo "  status: 2 = PRODUCTION  — live and serving" ;;
  "") echo "  status: <unreadable> — is this address actually a registered machine?" ;;
  *) echo "  status: $STATUS (unrecognized)" ;;
esac

MACHINE=$(cast call "$TEE_MANAGER_ADDRESS" "getTeeMachine(address)((address,address,string))" "$TEE_ID" \
  --rpc-url "$CHAIN_URL" 2>/dev/null || echo "")
echo "  on-chain record: ${MACHINE:-<unreadable>}"

echo
echo "  Compare the URL above against what you are serving RIGHT NOW."
echo "  Data providers push to the on-chain URL. If your tunnel hostname rotated, the chain still"
echo "  points at the dead one — the queue stays empty and nothing anywhere reports an error."
echo "  Currently configured: ${EXT_PROXY_URL:-<unset>}"

if [[ "${STATUS:-}" == "1" ]]; then
  echo
  echo "  Stuck at INITIALIZED usually means one of:"
  echo "    * the on-chain URL is dead (rotated quick tunnel — use a named tunnel or reserved domain)"
  echo "    * tee-node is older than v0.0.22, so every data-provider vote is silently rejected"
  echo "    * the attestation challenge expired — re-run post-build with: register-tee -command rRap"
fi
