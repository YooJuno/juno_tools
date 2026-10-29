import {activate} from '../gnome-system-monitor/activation.js';

const uuid = 'system-monitor@juno-tools';
function check(value, message) { if (!value) throw new Error(message); }
function rejects(action, pattern) {
    let error;
    try { action(); } catch (reason) { error = reason; }
    check(error && pattern.test(error.message), `Expected ${pattern}, got ${error?.message}`);
}
class Settings {
    constructor() {
        this.values = {'allow-extension-installation': true, 'enabled-extensions': ['keep@enabled'],
            'disabled-extensions': [uuid, 'keep@disabled'], 'disable-user-extensions': true};
        this.locked = new Set();
        this.pending = new Map();
        this.writes = 0;
    }
    get_boolean(key) { return this.values[key]; }
    get_strv(key) { return [...this.values[key]]; }
    is_writable(key) { return !this.locked.has(key); }
    delay() { this.delayed = true; }
    set_strv(key, value) { return this.set_boolean(key, value); }
    set_boolean(key, value) {
        this.writes++;
        if (!this.is_writable(key) || this.fail === key) return false;
        this.pending.set(key, value);
        return true;
    }
    apply() {
        if (!this.ignoreApply)
            for (const [key, value] of this.pending) this.values[key] = value;
        this.pending.clear();
    }
    revert() { this.pending.clear(); }
}
const settings = new Settings();
const before = JSON.stringify(settings.values);
activate(settings, uuid, true);
check(settings.writes === 0 && JSON.stringify(settings.values) === before, 'Preflight modified settings');
activate(settings, uuid);
check(JSON.stringify(settings.get_strv('enabled-extensions')) === JSON.stringify(['keep@enabled', uuid]), 'Other enabled choices were lost');
check(JSON.stringify(settings.get_strv('disabled-extensions')) === JSON.stringify(['keep@disabled']), 'Other disabled choices were lost');
check(!settings.get_boolean('disable-user-extensions'), 'Requested global enable was not saved');
settings.locked = new Set(['enabled-extensions', 'disabled-extensions', 'disable-user-extensions']);
const writes = settings.writes;
activate(settings, uuid);
check(settings.writes === writes, 'Already-correct locked settings should not be rewritten');

const locked = new Settings();
locked.locked.add('disable-user-extensions');
rejects(() => activate(locked, uuid), /locked by system policy/);
check(locked.writes === 0, 'A later locked key leaves earlier keys partially changed');

const blocked = new Settings();
blocked.values['allow-extension-installation'] = false;
rejects(() => activate(blocked, uuid), /disabled by system policy/);
check(blocked.writes === 0, 'Installation policy was bypassed');
activate(blocked, uuid, false, false);
check(blocked.get_strv('enabled-extensions').includes(uuid), 'User-installation policy incorrectly blocks an administrator-installed system extension');
const lockedSystem = new Settings();
lockedSystem.values['allow-extension-installation'] = false;
lockedSystem.locked.add('enabled-extensions');
rejects(() => activate(lockedSystem, uuid, false, false), /locked by system policy/);
check(lockedSystem.writes === 0, 'System activation bypassed a locked setting');

const failed = new Settings();
failed.fail = 'disabled-extensions';
rejects(() => activate(failed, uuid), /Could not save/);
check(JSON.stringify(failed.values) === before && !failed.pending.size, 'Failed delayed write was not reverted');

const ignored = new Settings();
ignored.ignoreApply = true;
rejects(() => activate(ignored, uuid), /did not match/);
print('Activation regressions passed: policy locks, preflight, idempotence, delayed rollback and write verification.');
