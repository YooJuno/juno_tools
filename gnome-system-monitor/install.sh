#!/usr/bin/env bash
set -euo pipefail

source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
uuid='system-monitor@juno-tools'
destination="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$uuid"
shell_root="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell"

if [[ $# -gt 1 || ( $# -eq 1 && "$1" != '--enable' ) ]]; then
    echo 'Usage: bash install.sh [--enable]' >&2
    exit 1
fi

if [[ ${EUID} -eq 0 ]]; then
    echo 'Run this installer as your desktop user, without sudo.' >&2
    exit 1
fi
for tool in glib-compile-schemas gnome-extensions gsettings; do
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

if [[ "$shell_root" != /* ]]; then
    echo 'XDG_DATA_HOME must be an absolute path.' >&2
    exit 1
fi
if [[ "$(gsettings get org.gnome.shell allow-extension-installation)" != 'true' ]]; then
    echo 'Extension installation is disabled by system policy.' >&2
    exit 1
fi
if [[ "${1:-}" == '--enable' ]]; then
    gjs -m "$source_dir/activation.js" --check "$uuid"
fi
if [[ -L "$destination" || ( -e "$destination" && ! -d "$destination" ) ]]; then
    echo "Refusing to replace a symbolic link or non-directory: $destination" >&2
    exit 1
fi
for directory in schemas icons; do
    if [[ -L "$destination/$directory" ]]; then
        echo "Refusing to write through a symbolic link: $destination/$directory" >&2
        exit 1
    fi
done
mkdir -p -- "$shell_root/extensions"
# Stage on the destination filesystem. Validate a complete copy before replacing
# the live directory, preserving extra files from an earlier installation.
staging="$(mktemp -d "$shell_root/.juno-monitor-stage.XXXXXX")"
backup=''
restore=false
cleanup() {
    if [[ "$restore" == true && ! -e "$destination" && -n "$backup" ]]; then
        if ! mv --no-target-directory -- "$backup" "$destination"; then
            echo "Could not restore the previous install; it is preserved at $backup" >&2
        fi
    elif [[ "$restore" == true && -n "$backup" ]]; then
        # An interrupted successful rename may leave a nonempty backup. Keep
        # that recoverable copy; only remove an unused empty reservation.
        rmdir -- "$backup" 2>/dev/null || true
    fi
    if [[ -n "$staging" ]]; then rm -rf -- "$staging"; fi
    if [[ "$restore" == false && -n "$backup" ]]; then rm -rf -- "$backup"; fi
}
trap cleanup EXIT
if [[ -d "$destination" ]]; then
    cp -a -- "$destination/." "$staging/"
fi
mkdir -p "$staging/schemas" "$staging/icons"
for file in metadata.json extension.js monitor.js metrics.js nvidia.js prefs.js stylesheet.css; do
    cp --remove-destination -- "$source_dir/$file" "$staging/$file"
done
cp --remove-destination -- "$source_dir"/schemas/*.gschema.xml "$staging/schemas/"
cp --remove-destination -r -- "$source_dir/icons/." "$staging/icons/"
rm -f -- "$staging/schemas/gschemas.compiled"
glib-compile-schemas --strict "$staging/schemas"
if [[ -d "$destination" ]]; then
    backup="$(mktemp -d "$shell_root/.juno-monitor-backup.XXXXXX")"
    restore=true
    mv --no-target-directory -- "$destination" "$backup"
fi
mv --no-target-directory -- "$staging" "$destination"
staging=''
restore=false
echo "Installed: $destination"

if [[ "${1:-}" == '--enable' ]]; then
    # GNOME only discovers new directories at login. Persist the choice even
    # when the running Shell does not know this UUID yet; preserve other choices.
    gjs -m "$source_dir/activation.js" --apply "$uuid"
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
echo 'Updated code loads after a Shell restart (X11: Alt+F2, r, Enter) or logout/login.'
