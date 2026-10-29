#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
test_dir="$(mktemp -d)"
trap 'rm -rf -- "$test_dir"' EXIT
export XDG_DATA_HOME="$test_dir/data"
export XDG_CONFIG_HOME="$test_dir/config"
export GSETTINGS_BACKEND=keyfile
mkdir -p "$test_dir/bin"

# Simulate the first-login discovery gap without touching the running desktop.
cat > "$test_dir/bin/gnome-extensions" <<'SH'
#!/usr/bin/env bash
if [[ "$1" == 'info' ]]; then
    exit 1
fi
echo 'Unexpected attempt to enable an undiscovered extension' >&2
exit 97
SH
chmod +x "$test_dir/bin/gnome-extensions"
export PATH="$test_dir/bin:$PATH"

state() {
    gjs -c '
        const s = new imports.gi.Gio.Settings({schema_id: "org.gnome.shell"});
        print(JSON.stringify({enabled: s.get_strv("enabled-extensions"),
            disabled: s.get_strv("disabled-extensions"),
            globallyDisabled: s.get_boolean("disable-user-extensions")}));
    '
}

gsettings set org.gnome.shell enabled-extensions "['keep-enabled@example.com']"
gsettings set org.gnome.shell disabled-extensions "['system-monitor@juno-tools', 'keep-disabled@example.com']"
gsettings set org.gnome.shell disable-user-extensions true
gsettings set org.gnome.shell allow-extension-installation true
before="$(state)"
bash "$repo_dir/gnome-system-monitor/install.sh"
[[ "$(state)" == "$before" ]] || { echo 'Install without --enable changed settings' >&2; exit 1; }
destination="$XDG_DATA_HOME/gnome-shell/extensions/system-monitor@juno-tools"
echo 'keep this user file' > "$destination/local-note.txt"

bash "$repo_dir/gnome-system-monitor/install.sh" --enable
first="$(state)"
bash "$repo_dir/gnome-system-monitor/install.sh" --enable
[[ "$(state)" == "$first" ]] || { echo 'Repeated install changed activation state' >&2; exit 1; }
gjs -c '
    const s = new imports.gi.Gio.Settings({schema_id: "org.gnome.shell"});
    if (JSON.stringify(s.get_strv("enabled-extensions")) !==
        JSON.stringify(["keep-enabled@example.com", "system-monitor@juno-tools"]))
        throw new Error("Activation did not preserve other enabled extensions");
    if (JSON.stringify(s.get_strv("disabled-extensions")) !==
        JSON.stringify(["keep-disabled@example.com"]))
        throw new Error("Activation did not preserve other disabled extensions");
    if (s.get_boolean("disable-user-extensions"))
        throw new Error("User extensions remain globally disabled");
'
[[ -f "$XDG_DATA_HOME/gnome-shell/extensions/system-monitor@juno-tools/schemas/gschemas.compiled" ]]
cmp "$repo_dir/gnome-system-monitor/nvidia.js" \
    "$XDG_DATA_HOME/gnome-shell/extensions/system-monitor@juno-tools/nvidia.js"
for icon in cpu gpu memory disk; do
    cmp "$repo_dir/gnome-system-monitor/icons/$icon-symbolic.svg" \
        "$XDG_DATA_HOME/gnome-shell/extensions/system-monitor@juno-tools/icons/$icon-symbolic.svg"
done
[[ "$(cat "$destination/local-note.txt")" == 'keep this user file' ]] || { echo 'Update removed unrelated files' >&2; exit 1; }

gsettings set org.gnome.shell allow-extension-installation false
before="$(state)"
if XDG_DATA_HOME="$test_dir/blocked-data" bash "$repo_dir/gnome-system-monitor/install.sh" --enable > "$test_dir/blocked.log" 2>&1; then
    echo 'Installation policy was ignored' >&2
    exit 1
fi
[[ ! -e "$test_dir/blocked-data/gnome-shell/extensions/system-monitor@juno-tools" ]]
[[ "$(state)" == "$before" ]]
gsettings set org.gnome.shell allow-extension-installation true

# Fail exactly the final rename after the original directory was backed up.
# The EXIT handler must restore that original directory, not a partial copy.
inode="$(stat -c %i "$destination")"
cat > "$test_dir/bin/mv" <<'SH'
#!/usr/bin/env bash
for argument in "$@"; do
    if [[ "$argument" == */.juno-monitor-stage.* ]]; then exit 97; fi
done
exec /usr/bin/mv "$@"
SH
chmod +x "$test_dir/bin/mv"
if bash "$repo_dir/gnome-system-monitor/install.sh" > "$test_dir/rollback.log" 2>&1; then
    echo 'Injected installation failure was not detected' >&2
    exit 1
fi
rm "$test_dir/bin/mv"
[[ "$(stat -c %i "$destination")" == "$inode" ]] || { echo 'Previous installation was not restored' >&2; exit 1; }
[[ "$(cat "$destination/local-note.txt")" == 'keep this user file' ]]
[[ -z "$(find "$XDG_DATA_HOME/gnome-shell" -maxdepth 1 -name '.juno-monitor-*' -print)" ]]
if bash "$repo_dir/gnome-system-monitor/install.sh" --invalid >/dev/null 2>&1; then
    echo 'Unexpected argument was accepted' >&2
    exit 1
fi
echo 'Installer smoke test passed (first login, policy, persistence, preservation, idempotence and rollback).'
