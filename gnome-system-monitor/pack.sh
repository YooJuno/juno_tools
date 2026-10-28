#!/usr/bin/env bash
set -euo pipefail
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
output_dir="${1:-$source_dir/../dist}"
mkdir -p -- "$output_dir"
output_dir="$(cd -- "$output_dir" && pwd)"
gnome-extensions pack "$source_dir" --force --out-dir "$output_dir" \
    --extra-source=monitor.js --extra-source=metrics.js
echo "$output_dir/system-monitor@juno-tools.shell-extension.zip"
