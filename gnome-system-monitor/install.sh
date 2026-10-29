#!/usr/bin/env bash
set -euo pipefail

source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
uuid='system-monitor@juno-tools'
destination="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$uuid"

if [[ $# -gt 1 || ( $# -eq 1 && "$1" != '--enable' ) ]]; then
    echo 'Usage: bash install.sh [--enable]' >&2
    exit 1
fi

if [[ ${EUID} -eq 0 ]]; then
    echo 'Run this installer as your desktop user, without sudo.' >&2
    exit 1
fi
for tool in glib-compile-schemas gnome-extensions; do
    command -v "$tool" >/dev/null || { echo "Missing required command: $tool" >&2; exit 1; }
done
if [[ "${1:-}" == '--enable' ]]; then
    command -v gjs >/dev/null || { echo 'Missing required command: gjs' >&2; exit 1; }
fi
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
    # GNOME only discovers new directories at login. Persist the choice even
    # when the running Shell does not know this UUID yet; preserve other choices.
    gjs -c '
        const Gio = imports.gi.Gio;
        const settings = new Gio.Settings({schema_id: "org.gnome.shell"});
        const uuid = ARGV[0];
        const enabled = settings.get_strv("enabled-extensions");
        if (!enabled.includes(uuid))
            settings.set_strv("enabled-extensions", [...enabled, uuid]);
        settings.set_strv("disabled-extensions",
            settings.get_strv("disabled-extensions").filter(item => item !== uuid));
        settings.set_boolean("disable-user-extensions", false);
        Gio.Settings.sync();
    ' "$uuid"
    echo 'Activation saved; user extensions are enabled globally.'
    if ! gnome-extensions info "$uuid" >/dev/null 2>&1; then
        echo 'This GNOME session has not discovered the new extension yet.'
        echo 'Log out and back in once. The monitor will start automatically.'
    elif gnome-extensions enable "$uuid"; then
        echo 'Extension enabled.'
    else
        echo 'Activation is saved. Log out and back in to load the installed code.'
        echo "If it still does not appear, check: gnome-extensions info $uuid"
    fi
else
    echo 'Log out/in if this is the first install, then enable with:'
    echo "  gnome-extensions enable $uuid"
fi
if [[ "${1:-}" != '--enable' && "$(gsettings get org.gnome.shell disable-user-extensions)" == 'true' ]]; then
    echo 'User extensions are currently disabled globally. Turn on Extensions in the Extensions app to show the monitor.'
fi
echo "Settings: gnome-extensions prefs $uuid"
