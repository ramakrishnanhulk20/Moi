#!/usr/bin/env bash
# Deploys GiftVault through script/Deploy.s.sol. Every gift token is checked on chain before anything is sent.
#
#   ./deploy.sh fork <anvil-rpc-url>    rehearsal on a local anvil fork of BSC mainnet
#   ./deploy.sh bsc --i-am-sure         the real BSC mainnet deploy
#
# Reads DEPLOYER_PRIVATE_KEY, MOI_RELAYER_ADDRESS and MOI_OWNER_ADDRESS from the repo-root .env and never prints
# them. The fork target refuses any node that is not anvil, so it cannot reach a real network by mistake.
set -euo pipefail

cd "$(dirname "$0")"

ENV_FILE="../../.env"

usage() {
    echo "usage: ./deploy.sh fork <anvil-rpc-url>" >&2
    echo "       ./deploy.sh bsc --i-am-sure" >&2
    exit 2
}

find_tool() {
    for candidate in "$1" "$HOME/.foundry/bin/$1" "$HOME/.foundry/bin/$1.exe"; do
        if command -v "$candidate" >/dev/null 2>&1; then
            echo "$candidate"
            return 0
        fi
    done
    echo "deploy: $1 not found. Install Foundry from https://getfoundry.sh and run foundryup." >&2
    exit 1
}

[ $# -ge 1 ] || usage
FORGE="$(find_tool forge)"
CAST="$(find_tool cast)"

case "$1" in
    fork)
        [ $# -eq 2 ] || usage
        rpc="$2"
        if ! client="$("$CAST" client --rpc-url "$rpc" 2>/dev/null)"; then
            echo "deploy: no node answered at $rpc" >&2
            exit 1
        fi
        case "$client" in
            anvil/*) ;;
            *)
                echo "deploy: $rpc is not an anvil node (it reports \"$client\"). For mainnet use: ./deploy.sh bsc --i-am-sure" >&2
                exit 1
                ;;
        esac
        # Rehearsals keep chain id 56, so their records would look like a real deploy if they landed in broadcast/.
        FOUNDRY_BROADCAST="$(mktemp -d)"
        export FOUNDRY_BROADCAST
        ;;
    bsc)
        if [ $# -ne 2 ] || [ "$2" != "--i-am-sure" ]; then
            echo "deploy: this deploys to BSC mainnet and spends real BNB. Run: ./deploy.sh bsc --i-am-sure" >&2
            exit 2
        fi
        # Alias from foundry.toml [rpc_endpoints].
        rpc="bsc"
        ;;
    *)
        usage
        ;;
esac

if [ ! -f "$ENV_FILE" ]; then
    echo "deploy: $ENV_FILE not found. Copy .env.example to .env at the repo root and fill it in." >&2
    exit 1
fi
# Tracing stays off while the .env is loaded, so even `bash -x deploy.sh` cannot print a key.
set +x
set -a
# Windows line endings are stripped first; otherwise a carriage return would end up inside every value.
eval "$(tr -d '\r' < "$ENV_FILE")"
set +a
for key in DEPLOYER_PRIVATE_KEY MOI_RELAYER_ADDRESS; do
    if [ -z "${!key:-}" ]; then
        echo "deploy: $key is empty in $ENV_FILE" >&2
        exit 1
    fi
done

echo "deploy: target $1, chain id $("$CAST" chain-id --rpc-url "$rpc")"
"$FORGE" script script/Deploy.s.sol:Deploy --rpc-url "$rpc" --broadcast --slow --legacy

if [ "$1" = "bsc" ]; then
    echo "deploy: next, run ./verify.sh <the GiftVault address above>"
fi
