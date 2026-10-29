#!/usr/bin/env bash
# Install application only. Existing weather/settings/driver remain in place.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
[[ $(uname -s) == Linux && $EUID == 0 ]] || { echo 'Run as root on Raspberry Pi OS.' >&2; exit 1; }
runtime_user=$(python3 - "$root" <<'PYCODE'
import json, os, sys
path = "/etc/pidesk-dashboard.json"
if not os.path.isfile(path): path = os.path.join(sys.argv[1], "app/config/pidesk.example.json")
with open(path, encoding="utf-8") as f: value = json.load(f).get("runtime_user", "pi")
if not isinstance(value, str) or not value or value.startswith("-"):
    raise SystemExit("Invalid runtime_user in configuration")
print(value)
PYCODE
)
id -- "$runtime_user" >/dev/null
[[ $(id -u -- "$runtime_user") != 0 ]] || { echo 'runtime_user must not be root' >&2; exit 1; }
python3 -c 'import PIL, numpy, websocket'
command -v chromium-headless-shell >/dev/null
command -v aplay >/dev/null
command -v curl >/dev/null
systemctl cat pidesk-kedei.service >/dev/null || { echo 'Install the display driver/service first; see docs/deployment.md.' >&2; exit 1; }
app=/opt/pidesk-dashboard
unit=/etc/systemd/system/pidesk-html.service
backup=$(mktemp -d /var/backups/pidesk-install.XXXXXX)
stage=$(mktemp -d /opt/pidesk-stage.XXXXXX)
trap 'rm -rf "$stage"' EXIT
was_active=false
systemctl is-active --quiet pidesk-html.service && was_active=true
had_app=false
had_unit=false
[[ ! -d "$app" ]] || { cp -a "$app" "$backup/application"; had_app=true; }
[[ ! -f "$unit" ]] || { cp -a "$unit" "$backup/pidesk-html.service"; had_unit=true; }
cp -R "$root/app/src" "$stage/src"
# 前端源码在 app/web，安装时放回包内，运行时用 __file__.parent/"web" 定位
cp -R "$root/app/web" "$stage/src/pidesk/web"
cp "$root/README.md" "$root/pyproject.toml" "$stage/"
find "$stage" -type d -name __pycache__ -prune -exec rm -rf {} +
rollback() {
  trap - ERR
  systemctl stop pidesk-html.service || true
  rm -rf "$app"
  if $had_app; then cp -a "$backup/application" "$app"; fi
  if $had_unit; then cp -a "$backup/pidesk-html.service" "$unit"; else rm -f "$unit"; fi
  systemctl daemon-reload
  if $was_active; then systemctl start pidesk-html.service; fi
  echo "Install failed; previous application restored. Backup: $backup" >&2
}
trap rollback ERR
if systemctl cat pidesk-html.service >/dev/null 2>&1; then
  systemctl stop pidesk-html.service
fi
rm -rf "$app"
mv "$stage" "$app"
if [[ ! -f /etc/pidesk-dashboard.json ]]; then
  install -m 644 "$root/app/config/pidesk.example.json" /etc/pidesk-dashboard.json
fi
install -m 644 "$root/ops/deploy/systemd/pidesk-html.service" "$unit"
systemctl daemon-reload
systemctl start pidesk-html.service
ready=false
for ((attempt=0; attempt<30; attempt++)); do
  if systemctl is-active --quiet pidesk-html.service && [[ -s /run/pidesk-html/metrics.json ]] && curl -fsS --max-time 2 http://127.0.0.1:8765/api/state >/dev/null; then
    ready=true
    break
  fi
  sleep 1
done
$ready || { echo 'Display startup check failed.' >&2; false; }
systemctl enable pidesk-html.service
trap - ERR
printf 'Installed. Config preserved. Backup: %s\n' "$backup"
