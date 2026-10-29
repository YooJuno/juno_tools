#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
version="${1:-$(gjs -c 'print(JSON.parse(new TextDecoder().decode(imports.gi.GLib.file_get_contents(ARGV[0])[1])).version)' "$repo_dir/package.json")}"
output_dir="${2:-$repo_dir/dist}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Expected version X.Y.Z' >&2; exit 1; }
mkdir -p -- "$output_dir"
output_dir="$(cd -- "$output_dir" && pwd -P)"
stage="$(mktemp -d)"
trap 'rm -rf -- "$stage"' EXIT
uuid='system-monitor@juno-tools'
extension="$stage/usr/share/gnome-shell/extensions/$uuid"
install -d "$stage/DEBIAN" "$extension/icons" "$stage/usr/share/glib-2.0/schemas" \
    "$stage/usr/share/juno-system-monitor" "$stage/usr/bin" \
    "$stage/usr/share/applications" "$stage/usr/share/doc/juno-system-monitor"
for file in metadata.json extension.js monitor.js metrics.js nvidia.js prefs.js stylesheet.css; do
    install -m 644 "$repo_dir/gnome-system-monitor/$file" "$extension/$file"
done
install -m 644 "$repo_dir/gnome-system-monitor"/icons/*.svg "$extension/icons/"
# System extensions use GNOME's default schema source. The GLib package owns
# the schema-directory trigger; never ship a shared gschemas.compiled cache.
install -m 644 "$repo_dir/gnome-system-monitor"/schemas/*.gschema.xml "$stage/usr/share/glib-2.0/schemas/"
glib-compile-schemas --strict "$stage/usr/share/glib-2.0/schemas"
if [[ -f "$stage/usr/share/glib-2.0/schemas/gschemas.compiled" ]]; then
    rm -- "$stage/usr/share/glib-2.0/schemas/gschemas.compiled"
fi
install -m 644 "$repo_dir/gnome-system-monitor/activation.js" "$stage/usr/share/juno-system-monitor/activation.js"
install -m 755 "$repo_dir/packaging/juno-system-monitor" "$stage/usr/bin/juno-system-monitor"
install -m 644 "$repo_dir/packaging/juno-system-monitor.desktop" "$stage/usr/share/applications/"
install -m 644 "$repo_dir/README.md" "$stage/usr/share/doc/juno-system-monitor/README.md"
cat > "$stage/DEBIAN/control" <<EOF
Package: juno-system-monitor
Version: $version
Section: utils
Priority: optional
Architecture: all
Maintainer: YooJuno <87231813+YooJuno@users.noreply.github.com>
Depends: gnome-shell (>= 46~), gnome-shell (<< 47~), gjs (>= 1.80), gir1.2-adw-1 (>= 1.4), gir1.2-gtk-4.0, libglib2.0-bin, dconf-gsettings-backend | gsettings-backend
Homepage: https://github.com/YooJuno/juno_tools
Description: Compact CPU, GPU, memory and storage indicators for GNOME 46
 Displays resource utilization in the GNOME top bar and detailed sensor readings
 on demand. Intended for Ubuntu 24.04. NVIDIA drivers are optional and are not
 installed or modified by this package. Activation is performed by the user.
EOF
echo 'activate /usr/share/glib-2.0/schemas' > "$stage/DEBIAN/triggers"
cat > "$stage/usr/share/doc/juno-system-monitor/copyright" <<'EOF'
Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: juno_tools
Source: https://github.com/YooJuno/juno_tools

Files: *
Copyright: 2026 YooJuno
License: Unspecified
 The upstream repository has not selected a public license.
 This packaging preserves that state and does not add a license grant.
EOF
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git -C "$repo_dir" log -1 --format=%ct 2>/dev/null || date +%s)}"
dpkg-deb --root-owner-group -Zxz --build "$stage" "$output_dir/juno-system-monitor_${version}_all.deb"
