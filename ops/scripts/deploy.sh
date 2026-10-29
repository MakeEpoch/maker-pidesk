#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
target=${1:-}
[[ -n "$target" && "$target" != -* && "$target" =~ ^[a-zA-Z0-9_.@:-]+$ ]] || { echo 'Usage: bash ops/scripts/deploy.sh pi@<address>' >&2; exit 1; }
release=$(python3 "$root/ops/scripts/package.py")
remote=$(ssh "$target" 'mktemp -d /tmp/pidesk-deploy.XXXXXX')
[[ "$remote" =~ ^/tmp/pidesk-deploy\.[a-zA-Z0-9]+$ ]] || { echo 'Unexpected remote staging path.' >&2; exit 1; }
scp "$release" "$target:$remote/release.tar.gz"
ssh -t "$target" "set -eu; tar -xzf '$remote/release.tar.gz' -C '$remote'; sudo bash '$remote/ops/scripts/install.sh'"
ssh "$target" "rm -rf '$remote'"
