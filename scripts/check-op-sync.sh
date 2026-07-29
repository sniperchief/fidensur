#!/usr/bin/env bash
#
# Verifies that the OPType/OPCommand identifiers agree across all three places they are declared.
#
# The FCC routing model links a contract to an extension by two bytes32 identifiers, and those
# identifiers are written out independently in three files:
#
#   contracts/Fidensur.sol                  bytes32("ALLOC"), bytes32("COMPUTE"), ...
#   extension/internal/config/config.go     OPTypeAlloc = "ALLOC", ...
#   extension/pkg/types/register.go         OPType: "ALLOC", OPCommand: "COMPUTE", ...
#
# Nothing in either toolchain checks that they match. A drift compiles cleanly on both sides and
# fails at runtime as an HTTP 501 "unsupported op command" from inside a TEE — which is about the
# most inconvenient place to discover a typo. Hence this script, which belongs in CI.
#
# Usage: ./scripts/check-op-sync.sh

set -euo pipefail

cd "$(dirname "$0")/.."

SOL="contracts/Fidensur.sol"
GO_CONFIG="extension/internal/config/config.go"
GO_REGISTER="extension/pkg/types/register.go"

for f in "$SOL" "$GO_CONFIG" "$GO_REGISTER"; do
  [[ -f "$f" ]] || { echo "missing file: $f" >&2; exit 1; }
done

fail=0

# The identifiers the three layers must agree on. Keep this list in step with the contract.
IDENTIFIERS=(ALLOC COMPUTE DISCLOSE ATTEST)

echo "Checking OPType/OPCommand identifier sync"
echo

for id in "${IDENTIFIERS[@]}"; do
  # Solidity: bytes32("ALLOC")
  in_sol=$(grep -c "bytes32(\"${id}\")" "$SOL" || true)

  # Go config: OPTypeAlloc = "ALLOC"
  in_config=$(grep -cE "=[[:space:]]*\"${id}\"" "$GO_CONFIG" || true)

  # Go register: OPType: "ALLOC" or OPCommand: "COMPUTE"
  in_register=$(grep -cE "(OPType|OPCommand):[[:space:]]*\"${id}\"" "$GO_REGISTER" || true)

  if (( in_sol > 0 && in_config > 0 && in_register > 0 )); then
    printf '  ok    %-10s solidity=%d config=%d register=%d\n' "$id" "$in_sol" "$in_config" "$in_register"
  else
    printf '  FAIL  %-10s solidity=%d config=%d register=%d\n' "$id" "$in_sol" "$in_config" "$in_register"
    fail=1
  fi
done

echo

# bytes32 string literals hold at most 31 bytes. A longer identifier is silently truncated by
# Solidity, so the contract and the extension would hash different values and never route.
echo "Checking identifier lengths (bytes32 holds 31 bytes)"
for id in "${IDENTIFIERS[@]}"; do
  len=${#id}
  if (( len > 31 )); then
    printf '  FAIL  %-10s %d bytes — exceeds the bytes32 limit\n' "$id" "$len"
    fail=1
  else
    printf '  ok    %-10s %d bytes\n' "$id" "$len"
  fi
done

echo

# Catch an identifier added to the contract but not to this script's list.
echo "Checking for identifiers the contract declares but this script does not track"
while read -r found; do
  tracked=0
  for id in "${IDENTIFIERS[@]}"; do
    [[ "$found" == "$id" ]] && tracked=1 && break
  done
  if (( tracked == 0 )); then
    # TEE_ACTION_RESULT is the signature domain prefix, not a routing identifier — it has no
    # counterpart in the Go config and is expected here.
    if [[ "$found" != "TEE_ACTION_RESULT" ]]; then
      printf '  FAIL  %s is declared in %s but not tracked by this script\n' "$found" "$SOL"
      fail=1
    fi
  fi
done < <(grep -oE 'bytes32\("[A-Z_]+"\)' "$SOL" | sed -E 's/bytes32\("(.*)"\)/\1/' | sort -u)

echo

if (( fail )); then
  echo "FAILED: identifiers are out of sync." >&2
  echo "A mismatch produces a runtime 501 from the extension with no compile-time signal." >&2
  exit 1
fi

echo "All identifiers are in sync."
