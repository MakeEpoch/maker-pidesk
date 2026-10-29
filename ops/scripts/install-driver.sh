#!/usr/bin/env bash
# Explicit first-time driver installation; normal application deploy never calls this.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
[[ $(uname -s) == Linux && $EUID == 0 ]] || { echo 'Run as root on the target Raspberry Pi.' >&2; exit 1; }
case $(uname -m) in aarch64|armv7l) ;; *) echo 'Raspberry Pi ARM host required.' >&2; exit 1;; esac
version=$(uname -r)
[[ -f "/lib/modules/$version/build/Makefile" ]] || { echo "Install headers matching $version first." >&2; exit 1; }
command -v dtc >/dev/null
build=$(mktemp -d /var/tmp/pidesk-driver.XXXXXX)
trap 'rm -rf "$build"' EXIT
cp "$root/driver/kedei/"{fb_kedei62_linux618.c,fbtft.h,Makefile,kedei62-native.dts} "$build/"
make -C "/lib/modules/$version/build" M="$build" modules -j2
dtc -@ -I dts -O dtb -o "$build/kedei62-native.dtbo" "$build/kedei62-native.dts"
backup=$(mktemp -d /var/backups/pidesk-driver.XXXXXX)
for path in "/lib/modules/$version/updates/fb_kedei62_linux618.ko" /boot/firmware/overlays/kedei62-native.dtbo /usr/local/src/kedei62-driver; do
  [[ ! -e "$path" ]] || cp -a --parents "$path" "$backup/"
done
install -d /usr/local/src/kedei62-driver
install -m 644 "$root/driver/kedei/"{fb_kedei62_linux618.c,fbtft.h,Makefile,kedei62-native.dts,LICENSE} /usr/local/src/kedei62-driver/
install -D -m 644 "$build/fb_kedei62_linux618.ko" "/lib/modules/$version/updates/fb_kedei62_linux618.ko"
install -m 644 "$build/kedei62-native.dtbo" /boot/firmware/overlays/
for helper in kedei62-console kedei62-rebuild pidesk-kedei-start; do install -m 755 "$root/driver/kedei/bin/$helper" "/usr/local/sbin/$helper"; done
install -m 644 "$root/ops/deploy/systemd/"{pidesk-kedei.service,pidesk-kedei.timer} /etc/systemd/system/
depmod -a "$version"
systemctl daemon-reload
systemctl enable --now pidesk-kedei.timer
printf 'Driver installed. Boot config was not edited. Backup: %s\n' "$backup"
