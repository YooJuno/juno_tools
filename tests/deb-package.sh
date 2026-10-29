#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
version="$(gjs -c 'print(JSON.parse(new TextDecoder().decode(imports.gi.GLib.file_get_contents(ARGV[0])[1])).version)' "$repo_dir/package.json")"
package="${1:-$repo_dir/dist/juno-system-monitor_${version}_all.deb}"
test_dir="$(mktemp -d)"
trap 'rm -rf -- "$test_dir"' EXIT
dpkg-deb -x "$package" "$test_dir/root"
dpkg-deb -e "$package" "$test_dir/control"
[[ "$(dpkg-deb -f "$package" Package)" == juno-system-monitor ]]
[[ "$(dpkg-deb -f "$package" Architecture)" == all ]]
[[ "$(cat "$test_dir/control/triggers")" == 'activate /usr/share/glib-2.0/schemas' ]]
[[ ! -e "$test_dir/control/postinst" && ! -e "$test_dir/control/postrm" ]]
extension="$test_dir/root/usr/share/gnome-shell/extensions/system-monitor@juno-tools"
for file in extension.js monitor.js metrics.js nvidia.js prefs.js metadata.json stylesheet.css; do
    cmp "$repo_dir/gnome-system-monitor/$file" "$extension/$file"
done
[[ ! -e "$extension/schemas" && ! -e "$extension/activation.js" ]]
cmp "$repo_dir/packaging/juno-system-monitor" "$test_dir/root/usr/bin/juno-system-monitor"
cmp "$repo_dir/gnome-system-monitor/activation.js" "$test_dir/root/usr/share/juno-system-monitor/activation.js"
cmp "$repo_dir/packaging/juno-system-monitor.desktop" "$test_dir/root/usr/share/applications/juno-system-monitor.desktop"
[[ ! -e "$test_dir/root/usr/share/glib-2.0/schemas/gschemas.compiled" ]]
desktop-file-validate "$test_dir/root/usr/share/applications/juno-system-monitor.desktop"
python3 - "$package" <<'PY'
import io, subprocess, sys, tarfile
data = subprocess.check_output(['dpkg-deb', '--fsys-tarfile', sys.argv[1]])
with tarfile.open(fileobj=io.BytesIO(data)) as archive:
    for item in archive:
        assert item.uid == item.gid == 0, item.name
        assert not item.mode & 0o6000, item.name
        assert item.name in ('.', './', './usr') or item.name.startswith('./usr/'), item.name
PY
export XDG_DATA_HOME="$test_dir/data"
export XDG_CONFIG_HOME="$test_dir/config"
export GSETTINGS_BACKEND=keyfile
export GSETTINGS_SCHEMA_DIR="$test_dir/root/usr/share/glib-2.0/schemas"
glib-compile-schemas --strict "$GSETTINGS_SCHEMA_DIR"
gjs -c 'const Gio=imports.gi.Gio; const s=new Gio.Settings({schema_id:"org.gnome.shell.extensions.juno-system-monitor"}); if(s.get_int("refresh-interval")!==2) throw new Error("System schema missing");'
helper="$test_dir/root/usr/bin/juno-system-monitor"
"$helper" --help
# The admin-installed package can be activated when new user installs are
# prohibited; writable locks are tested separately by activation-regression.js.
gsettings set org.gnome.shell allow-extension-installation false
"$helper" enable
gjs -c 'const s=new imports.gi.Gio.Settings({schema_id:"org.gnome.shell"}); if(!s.get_strv("enabled-extensions").includes("system-monitor@juno-tools")) throw new Error("Activation not saved");'
user_install="$XDG_DATA_HOME/gnome-shell/extensions/system-monitor@juno-tools"
mkdir -p "$user_install"
cp "$extension/metadata.json" "$user_install/metadata.json"
echo 'preserve user file' > "$user_install/marker"
if "$helper" enable > "$test_dir/shadow.log" 2>&1; then
    echo 'Shadowing user install was not detected' >&2
    exit 1
fi
"$helper" migrate
[[ ! -e "$user_install" ]]
[[ "$(find "$XDG_DATA_HOME/juno-system-monitor/backups" -name marker | wc -l)" == 1 ]]
echo 'Debian package tests passed: payload, ownership, schema trigger, user activation and backup migration.'
