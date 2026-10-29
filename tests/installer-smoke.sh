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
before="$(state)"
bash "$repo_dir/gnome-system-monitor/install.sh"
[[ "$(state)" == "$before" ]] || { echo 'Install without --enable changed settings' >&2; exit 1; }

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
for icon in cpu gpu memory disk; do
    cmp "$repo_dir/gnome-system-monitor/icons/$icon-symbolic.svg" \
        "$XDG_DATA_HOME/gnome-shell/extensions/system-monitor@juno-tools/icons/$icon-symbolic.svg"
done
if bash "$repo_dir/gnome-system-monitor/install.sh" --invalid >/dev/null 2>&1; then
    echo 'Unexpected argument was accepted' >&2
    exit 1
fi
echo 'Installer smoke test passed (first login, persistence, preservation and idempotence).'
