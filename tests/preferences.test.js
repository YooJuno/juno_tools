import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../gnome-system-monitor/prefs.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace('export default class JunoMonitorPreferences', 'class JunoMonitorPreferences');

function fixture() {
    const entries = [];
    class Widget {
        constructor(options = {}) { Object.assign(this, options); this.signals = new Map(); this.classes = new Set(); }
        add() {}
        connect(name, callback) { this.signals.set(name, callback); }
        emit(name) { this.signals.get(name)?.(this); }
        add_css_class(name) { this.classes.add(name); }
        remove_css_class(name) { this.classes.delete(name); }
        set_tooltip_text(value) { this.tooltip = value; }
        set_default_size() {}
    }
    const settings = {path: '/', writable: true, writes: [],
        get_string() { return this.path; }, is_writable() { return this.writable; }, bind() {},
        set_string(_key, value) { if (!this.writable) return false; this.path = value; this.writes.push(value); return true; }};
    const reads = [];
    const timers = new Map();
    let timer = 0;
    const context = {
        ExtensionPreferences: class {},
        Adw: {PreferencesPage: Widget, PreferencesGroup: Widget, SwitchRow: Widget, SpinRow: Widget,
            EntryRow: class extends Widget { constructor(options) { super(options); entries.push(this); } }},
        Gtk: {Adjustment: Widget},
        Gio: {SettingsBindFlags: {DEFAULT: 0}, FileQueryInfoFlags: {NONE: 0},
            Cancellable: class { cancel() { this.cancelled = true; } },
            File: {new_for_path: path => ({
                query_info_async(_attributes, _flags, _priority, cancellable, callback) {
                    reads.push({path, cancellable, complete(valid = true) {
                        callback({query_info_finish() { if (!valid) throw new Error('inaccessible'); return {}; }}, {});
                    }});
                },
                query_exists() { throw new Error('Synchronous filesystem checks must not run on the UI thread'); },
            })}},
        GLib: {PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false,
            timeout_add(_priority, _ms, callback) { timers.set(++timer, callback); return timer; },
            source_remove(id) { timers.delete(id); }},
    };
    vm.runInNewContext(`${source}\nglobalThis.PreferencesUnderTest = JunoMonitorPreferences;`, context);
    const preferences = new context.PreferencesUnderTest();
    preferences.getSettings = () => settings;
    const window = new Widget();
    preferences.fillPreferencesWindow(window);
    return {settings, window, path: entries[0], reads, timers,
        apply(value) { entries[0].text = value; entries[0].emit('changed'); entries[0].emit('apply'); },
        expire() { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } }};
}

test('storage path validation is asynchronous and saves only a completed valid request', () => {
    const f = fixture();
    f.apply('/home');
    assert.equal(f.settings.path, '/');
    assert.equal(f.path.sensitive, false);
    f.reads[0].complete();
    assert.equal(f.settings.path, '/home');
    assert.equal(f.path.sensitive, true);
    assert.equal(f.timers.size, 0);
    f.apply('relative/path');
    assert.equal(f.reads.length, 1);
    assert.equal(f.path.classes.has('error'), true);
});

test('editing or closing prevents late validation from overwriting settings', () => {
    const f = fixture();
    f.apply('/old');
    f.path.text = '/new';
    f.path.emit('changed');
    assert.equal(f.reads[0].cancellable.cancelled, true);
    f.reads[0].complete();
    assert.equal(f.settings.path, '/');
    f.path.emit('apply');
    f.window.emit('close-request');
    assert.equal(f.timers.size, 0);
    assert.equal(f.reads[1].cancellable.cancelled, true);
    f.reads[1].complete();
    assert.deepEqual(f.settings.writes, []);
});

test('a timed-out filesystem check does not enqueue more workers or save its late result', () => {
    const f = fixture();
    f.apply('/slow');
    f.expire();
    assert.equal(f.path.sensitive, true);
    assert.equal(f.reads[0].cancellable.cancelled, true);
    f.path.emit('apply');
    assert.equal(f.reads.length, 1);
    f.reads[0].complete();
    assert.equal(f.settings.path, '/');
    f.apply('/valid');
    f.reads[1].complete();
    assert.equal(f.settings.path, '/valid');
});

test('locked settings reject path changes before filesystem access', () => {
    const f = fixture();
    f.settings.writable = false;
    f.apply('/home');
    assert.equal(f.reads.length, 0);
    assert.equal(f.path.classes.has('error'), true);
});
