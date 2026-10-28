#!/usr/bin/env bash
set -euo pipefail

source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
uuid='system-monitor@juno-tools'
destination="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$uuid"

if [[ ${EUID} -eq 0 ]]; then
    echo 'Run this installer as your desktop user, without sudo.' >&2
    exit 1
fi
for tool in glib-compile-schemas gnome-extensions; do
    command -v "$tool" >/dev/null || { echo "Missing required command: $tool" >&2; exit 1; }
done
shell_version="$(gnome-shell --version)"
if [[ ! "$shell_version" =~ ^GNOME\ Shell\ 46([.]|$) ]]; then
    echo "Supported: GNOME Shell 46 (Ubuntu 24.04). Found: $shell_version" >&2
    exit 1
fi

staging="$(mktemp -d)"
trap 'rm -rf -- "$staging"' EXIT
mkdir -p "$staging/schemas"
for file in metadata.json extension.js monitor.js metrics.js prefs.js stylesheet.css; do
    cp -- "$source_dir/$file" "$staging/$file"
done
cp -- "$source_dir"/schemas/*.gschema.xml "$staging/schemas/"
glib-compile-schemas --strict "$staging/schemas"
mkdir -p -- "$destination"
cp -r -- "$staging/." "$destination/"
echo "Installed: $destination"

if [[ "${1:-}" == '--enable' ]]; then
    if gnome-extensions enable "$uuid"; then
        echo 'Extension enabled.'
    else
        echo 'GNOME has not discovered the new extension yet. Log out/in, then run:'
        echo "  gnome-extensions enable $uuid"
    fi
else
    echo 'Log out/in if this is the first install, then enable with:'
    echo "  gnome-extensions enable $uuid"
fi
if [[ "$(gsettings get org.gnome.shell disable-user-extensions)" == 'true' ]]; then
    echo 'User extensions are currently disabled globally. Turn on Extensions in the Extensions app to show the monitor.'
fi
echo "Settings: gnome-extensions prefs $uuid"
