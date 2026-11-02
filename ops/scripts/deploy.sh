#!/usr/bin/env bash
set -euo pipefail
# Credentials are scoped to SSH processes and must never be printed by shell tracing.
set +x
root=$(cd "$(dirname "$0")/../.." && pwd)
env_file=${PIDESK_DEPLOY_ENV_FILE:-"$root/.env.deploy.local"}
if [[ -f "$env_file" ]]; then
  # Private, trusted checkout-local shell assignments; not part of release archives.
  source "$env_file"
fi
target=${1:-${PIDESK_DEPLOY_HOST:-}}
[[ -n "$target" && "$target" != -* && "$target" =~ ^[a-zA-Z0-9_.@:-]+$ ]] || { echo 'Usage: make deploy HOST=pi@<address>, or configure .env.deploy.local' >&2; exit 1; }
port=${PIDESK_DEPLOY_PORT:-22}
[[ "$port" =~ ^[0-9]+$ && ${#port} -le 5 ]] && ((10#$port >= 1 && 10#$port <= 65535)) || { echo 'Invalid deployment SSH port.' >&2; exit 1; }
password=${PIDESK_DEPLOY_PASSWORD:-}
sudo_password=${PIDESK_DEPLOY_SUDO_PASSWORD-$password}
key=${PIDESK_DEPLOY_KEY:-}
# Do not send credentials saved for this Pi to a different command-line target.
if [[ -n "${PIDESK_DEPLOY_HOST:-}" && "$target" != "$PIDESK_DEPLOY_HOST" ]]; then
  password=; sudo_password=; key=
fi
ssh_options=(-o ConnectTimeout=10 -p "$port")
scp_options=(-o ConnectTimeout=10 -P "$port")
if [[ -n "${PIDESK_DEPLOY_KNOWN_HOSTS:-}" ]]; then
  known_hosts=$PIDESK_DEPLOY_KNOWN_HOSTS
  [[ "$known_hosts" = /* ]] || known_hosts="$root/$known_hosts"
  mkdir -p "$(dirname "$known_hosts")"
  ssh_options+=(-o "UserKnownHostsFile=$known_hosts" -o StrictHostKeyChecking=accept-new)
  scp_options+=(-o "UserKnownHostsFile=$known_hosts" -o StrictHostKeyChecking=accept-new)
fi
if [[ -n "$key" ]]; then
  [[ "$key" = /* ]] || key="$root/$key"
  ssh_options+=(-i "$key")
  scp_options+=(-i "$key")
fi
if [[ -n "$password" ]]; then
  command -v sshpass >/dev/null || { echo 'Password deployment needs sshpass on the development machine.' >&2; exit 1; }
fi
run_ssh() {
  if [[ -n "$password" ]]; then
    SSHPASS="$password" sshpass -e ssh "${ssh_options[@]}" "$@"
  else
    ssh "${ssh_options[@]}" "$@"
  fi
}
run_scp() {
  if [[ -n "$password" ]]; then
    SSHPASS="$password" sshpass -e scp "${scp_options[@]}" "$@"
  else
    scp "${scp_options[@]}" "$@"
  fi
}
release=$(python3 "$root/ops/scripts/package.py")
remote=$(run_ssh "$target" 'mktemp -d /tmp/pidesk-deploy.XXXXXX')
[[ "$remote" =~ ^/tmp/pidesk-deploy\.[a-zA-Z0-9]+$ ]] || { echo 'Unexpected remote staging path.' >&2; exit 1; }
run_scp "$release" "$target:$remote/release.tar.gz"
if [[ -n "$sudo_password" ]]; then
  # stdin travels over SSH to sudo; passwords never become remote command arguments.
  printf '%s\n' "$sudo_password" | run_ssh -T "$target" "set -eu; tar -xzf '$remote/release.tar.gz' -C '$remote'; sudo -S -p '' bash '$remote/ops/scripts/install.sh'"
else
  run_ssh -t "$target" "set -eu; tar -xzf '$remote/release.tar.gz' -C '$remote'; sudo bash '$remote/ops/scripts/install.sh'"
fi
run_ssh "$target" "rm -rf '$remote'"
