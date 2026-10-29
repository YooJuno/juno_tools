#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
version="${1:-$(gjs -c 'print(JSON.parse(new TextDecoder().decode(imports.gi.GLib.file_get_contents(ARGV[0])[1])).version)' "$repo_dir/package.json")}"
output_dir="${2:-$repo_dir/dist}"
bash "$repo_dir/packaging/build-deb.sh" "$version" "$output_dir"
bash "$repo_dir/gnome-system-monitor/pack.sh" "$output_dir"
sed "s/@VERSION@/$version/g" "$repo_dir/packaging/INSTALL.ko.md" > "$output_dir/INSTALL.ko.md"
(
    cd -- "$output_dir"
    sha256sum "juno-system-monitor_${version}_all.deb" \
        'system-monitor@juno-tools.shell-extension.zip' INSTALL.ko.md > SHA256SUMS
)
