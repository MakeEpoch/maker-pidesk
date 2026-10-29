#!/usr/bin/env bash
set -euo pipefail
[[ $(uname -s) == Linux && $EUID == 0 ]] || { echo 'Run as root on Raspberry Pi OS.' >&2; exit 1; }
apt-get update
apt-get install -y python3 python3-pil python3-numpy python3-websocket
apt-get install -y chromium-headless-shell alsa-utils fonts-dejavu-core fonts-noto-cjk fonts-unifont curl
