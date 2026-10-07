#!/usr/bin/env bash
# Verifies a deployed GiftVault on Sourcify and on BscScan (Etherscan v2 API, chain 56).
#
#   ./verify.sh <vault-address>
#
# BscScan needs the exact constructor arguments. They are cut from the vault's own creation transaction, after
# checking that everything before them is byte for byte this checkout's compiled GiftVault, so they cannot drift
# from what was deployed. ETHERSCAN_API_KEY comes from the repo-root .env and is never printed or put on a command
# line. Etherscan's free plan refused chain 56 when checked on 2026-10-07, so the BscScan half needs a paid plan;
# Sourcify needs no key and runs first.
set -euo pipefail

cd "$(dirname "$0")"

ENV_FILE="../../.env"
CONTRACT="src/GiftVault.sol:GiftVault"

usage() {
    echo "usage: ./verify.sh <vault-address>" >&2
    exit 2
}

find_tool() {
    for candidate in "$1" "$HOME/.foundry/bin/$1" "$HOME/.foundry/bin/$1.exe"; do
        if command -v "$candidate" >/dev/null 2>&1; then
            echo "$candidate"
            return 0
        fi
    done
    echo "verify: $1 not found. Install Foundry from https://getfoundry.sh and run foundryup." >&2
    exit 1
}

lower() {
    printf '%s' "$1" | tr 'A-Z' 'a-z'
}

[ $# -eq 1 ] || usage
vault="$1"
if [[ ! "$vault" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
    echo "verify: \"$vault\" is not an address" >&2
    exit 2
fi
FORGE="$(find_tool forge)"
CAST="$(find_tool cast)"
command -v curl >/dev/null 2>&1 || { echo "verify: curl not found" >&2; exit 1; }

if [ ! -f "$ENV_FILE" ]; then
    echo "verify: $ENV_FILE not found. Copy .env.example to .env at the repo root and fill it in." >&2
    exit 1
fi
# Tracing stays off while the .env is loaded, so even `bash -x verify.sh` cannot print a key.
set +x
set -a
# Windows line endings are stripped first; otherwise a carriage return would end up inside every value.
eval "$(tr -d '\r' < "$ENV_FILE")"
set +a
if [ -z "${ETHERSCAN_API_KEY:-}" ]; then
    echo "verify: ETHERSCAN_API_KEY is empty in $ENV_FILE" >&2
    exit 1
fi

# rpc aliases come from foundry.toml: bsc for current state, bsc_archive for an old transaction.
if [ "$("$CAST" code "$vault" --rpc-url bsc)" = "0x" ]; then
    echo "verify: no contract at $vault on BSC" >&2
    exit 1
fi

echo "verify: Sourcify"
"$FORGE" verify-contract "$vault" "$CONTRACT" --chain 56 --verifier sourcify --watch

echo "verify: finding the creation transaction"
# The request goes to curl as a config on stdin, so the key never appears in the process list.
response="$(printf '%s\n' \
    'url = "https://api.etherscan.io/v2/api"' \
    'get' \
    'data = "chainid=56"' \
    'data = "module=contract"' \
    'data = "action=getcontractcreation"' \
    "data = \"contractaddresses=$vault\"" \
    "data = \"apikey=$ETHERSCAN_API_KEY\"" | curl -sS --max-time 30 -K -)"
creation_tx="$(printf '%s' "$response" | grep -o '"txHash":"0x[0-9a-fA-F]\{64\}"' | head -n 1 | cut -d'"' -f4 || true)"
if [ -z "$creation_tx" ]; then
    echo "verify: Etherscan did not return the creation transaction. It answered: ${response//$ETHERSCAN_API_KEY/<key>}" >&2
    exit 1
fi

created="$("$CAST" receipt "$creation_tx" contractAddress --rpc-url bsc_archive)"
if [ "$(lower "$created")" != "$(lower "$vault")" ]; then
    echo "verify: $creation_tx did not create $vault directly (receipt says \"$created\")." >&2
    exit 1
fi
input="$(lower "$("$CAST" tx "$creation_tx" input --rpc-url bsc_archive)")"
bytecode="$(lower "$("$FORGE" inspect "$CONTRACT" bytecode)")"
case "$input" in
    "$bytecode"?*) ;;
    *)
        echo "verify: $creation_tx does not start with this checkout's GiftVault bytecode." >&2
        echo "        Check out the commit that was deployed, run ./install-deps.sh, and try again." >&2
        exit 1
        ;;
esac
constructor_args="0x${input#"$bytecode"}"
echo "verify: constructor arguments from $creation_tx (owner, relayer, tokens):"
"$CAST" abi-decode "constructor()(address,address,address[])" "$constructor_args"

echo "verify: BscScan"
"$FORGE" verify-contract "$vault" "$CONTRACT" --chain 56 --verifier etherscan \
    --constructor-args "$constructor_args" --watch
