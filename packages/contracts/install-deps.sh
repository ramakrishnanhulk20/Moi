#!/bin/sh
# Installs the pinned Solidity libraries into lib/. lib/ is not committed and the
# libraries are not git submodules, so a fresh clone runs this once before forge build.
set -eu

OZ_TAG="v5.7.0"
FORGE_STD_TAG="v1.17.0"

cd "$(dirname "$0")"

FORGE=""
for candidate in forge "$HOME/.foundry/bin/forge" "$HOME/.foundry/bin/forge.exe"; do
    if command -v "$candidate" >/dev/null 2>&1; then
        FORGE="$candidate"
        break
    fi
done
if [ -z "$FORGE" ]; then
    echo "install-deps: forge not found. Install Foundry from https://getfoundry.sh and run foundryup." >&2
    exit 1
fi

# install_dep <dir> <repo> <tag>
install_dep() {
    dir="lib/$1"
    want="${3#v}"
    if [ -d "$dir" ]; then
        if grep -q "\"version\": \"$want\"" "$dir/package.json" 2>/dev/null; then
            echo "install-deps: $1 already at $3"
            return 0
        fi
        echo "install-deps: $dir exists but is not $3. Delete it and run this script again." >&2
        exit 1
    fi
    "$FORGE" install --no-git "$2@$3"
    if ! grep -q "\"version\": \"$want\"" "$dir/package.json"; then
        echo "install-deps: $dir did not install at $3." >&2
        exit 1
    fi
}

install_dep openzeppelin-contracts OpenZeppelin/openzeppelin-contracts "$OZ_TAG"
install_dep forge-std foundry-rs/forge-std "$FORGE_STD_TAG"
echo "install-deps: done"
