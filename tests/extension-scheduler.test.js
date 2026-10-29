import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {formatBytes, formatPercent} from '../gnome-system-monitor/metrics.js';

// Exercise the production scheduler without loading GNOME's GI/resource modules.
// Test actor/signal/clock behavior; real GNOME layout is verified separately.
const source = readFileSync(new URL('../gnome-system-monitor/extension.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace('export default class JunoSystemMonitor', 'class JunoSystemMonitor');
const flush = () => new Promise(resolve => setImmediate(resolve));
const keys = ['cpu', 'gpu', 'memory', 'disk'];

class Actor {
    constructor(properties = {}) {
        this.visible = true;
        this.text = '';
        this.children = [];
        this.signals = new Map();
        this.classes = new Set();
        this.classWrites = 0;
        Object.assign(this, properties);
    }
    get text() { return this._text; }
    set text(value) { this._text = value; this.textWrites = (this.textWrites ?? 0) + 1; }
    add_child(child) { this.children.push(child); }
    add_style_class_name(name) { this.classes.add(name); this.classWrites++; }
    remove_style_class_name(name) { this.classes.delete(name); this.classWrites++; }
    connect(name, callback) { const id = (this.lastSignalId ?? 0) + 1; this.lastSignalId = id; this.signals.set(id, {name, callback}); return id; }
    disconnect(id) { this.signals.delete(id); }
    emit(name, ...args) { for (const signal of this.signals.values()) if (signal.name === name) signal.callback(this, ...args); }
    destroy() { this.destroyed = true; this.signals.clear(); }
}

class Menu extends Actor {
    isOpen = false;
    open() { this.isOpen = true; this.emit('open-state-changed', true); }
    close() { this.isOpen = false; this.emit('open-state-changed', false); }
}

function fixture(initialSettings = {}) {
    const values = {'show-cpu': true, 'show-gpu': true, 'show-memory': true, 'show-disk': true,
        'disk-path': '/', 'refresh-interval': 2, 'gpu-index': 0, ...initialSettings};
    const settings = Object.assign(new Actor(), {
        get_boolean: key => values[key], get_int: key => values[key], get_string: key => values[key],
        set(key, value) { if (values[key] !== value) { values[key] = value; this.emit('changed', key); } },
    });
    const timers = new Map();
    const monitors = [];
    let timerId = 0;
    class Monitor {
        constructor() { this.calls = []; this.active = 0; this.maxActive = 0; monitors.push(this); }
        sample(path, includeGpu, options) {
            this.maxActive = Math.max(this.maxActive, ++this.active);
            return new Promise(resolve => this.calls.push({path, includeGpu, options,
                resolve: result => { this.active--; resolve(result); }}));
        }
        stop() { this.stopped = true; }
        pauseGpu() { this.gpuPaused = true; }
        pause() { this.paused = true; }
    }
    class Button extends Actor {
        constructor() { super(); this.menu = new Menu(); }
        destroy() { this.menu.close(); super.destroy(); }
    }
    const context = {
        Extension: class {}, SystemMonitor: Monitor, console, formatBytes, formatPercent,
        Clutter: {ActorAlign: {CENTER: 0}}, Gio: {FileIcon: class {}},
        St: {BoxLayout: Actor, Label: Actor, Icon: Actor}, PanelMenu: {Button},
        Main: {panel: {addToStatusArea() {}}},
        GLib: {PRIORITY_DEFAULT: 0, SOURCE_CONTINUE: true, SOURCE_REMOVE: false,
            timeout_add_seconds(_priority, seconds, callback) { timers.set(++timerId, {seconds, callback}); return timerId; },
            source_remove(id) { timers.delete(id); }},
    };
    vm.runInNewContext(`${source}\nglobalThis.ExtensionUnderTest = JunoSystemMonitor;`, context);
    const extension = new context.ExtensionUnderTest();
    Object.assign(extension, {uuid: 'scheduler@test', dir: {get_child: path => path}, getSettings: () => settings});
    // The popup's real actor layout is covered by the GNOME integration check.
    extension._buildMenu = function () {
        this._sections = Object.fromEntries(keys.map(key => [key, {section: new Actor(), titleLabel: new Actor(),
            value: new Actor(), details: [new Actor({text: 'untouched'}), new Actor({text: 'untouched'})]}]));
        this._intervalLabel = new Actor();
        this._status = new Actor();
    };
    extension.enable();
    return {extension, settings, monitors, timers,
        get monitor() { return monitors.at(-1); },
        tick() { assert.equal(timers.size, 1); [...timers.values()][0].callback(); },
    };
}

function snapshot(utilization = 10, path = '/') {
    return {cpu: {utilization, temperature: 70}, memory: {percent: 20, used: 20, total: 100, swapUsed: 0, swapTotal: 0},
        disk: {percent: 30, path, used: 30, total: 100, free: 70, read: 1, write: 2, busy: 1},
        gpus: [{name: 'Test GPU', utilization: 40, memoryUsed: 1, memoryTotal: 2, temperature: 50}], errors: {}};
}

test('periodic polls never overlap and urgent changes coalesce into one fresh sample', async () => {
    const f = fixture();
    f.tick(); f.tick();
    assert.equal(f.monitor.calls.length, 1);
    f.settings.set('show-memory', false);
    f.settings.set('disk-path', '/home');
    assert.equal(f.monitor.calls.length, 1);
    f.monitor.calls[0].resolve(snapshot(99));
    await flush();
    assert.equal(f.extension._labels.cpu.text, '—', 'stale settings must not render');
    assert.equal(f.monitor.calls.length, 2);
    assert.equal(f.monitor.calls[1].path, '/home');
    assert.equal(f.monitor.calls[1].options.includeMemory, false);
    f.monitor.calls[1].resolve(snapshot(12, '/home'));
    await flush();
    assert.equal(f.extension._labels.cpu.text, '12%');
    assert.equal(f.monitor.calls.length, 2, 'no periodic backlog should remain');
    assert.equal(f.monitor.maxActive, 1);
    f.extension.disable();
});

test('late completion from a disabled session cannot render or release the new session', async () => {
    const f = fixture();
    const oldMonitor = f.monitor;
    const oldButton = f.extension._button;
    f.extension.disable();
    assert.equal(oldMonitor.stopped, true);
    assert.equal(oldButton.destroyed, true);
    assert.equal(f.timers.size, 0);
    f.extension.enable();
    oldMonitor.calls[0].resolve(snapshot(99));
    await flush();
    assert.equal(f.extension._labels.cpu.text, '—');
    f.tick();
    assert.equal(f.monitor.calls.length, 1, 'the new session still has an active sample');
    f.monitor.calls[0].resolve(snapshot(11));
    await flush();
    assert.equal(f.extension._labels.cpu.text, '11%');
    f.extension.disable();
});

test('popup details are requested on opening and untouched by background updates', async () => {
    const f = fixture();
    assert.equal(f.monitor.calls[0].options.details, false);
    f.monitor.calls[0].resolve(snapshot());
    await flush();
    const detail = f.extension._sections.cpu.details[0];
    assert.equal(detail.text, 'untouched');
    f.extension._button.menu.open();
    assert.equal(f.monitor.calls[1].options.details, true);
    f.monitor.calls[1].resolve(snapshot());
    await flush();
    assert.equal(detail.text, 'Temperature 70 °C');
    f.extension._button.menu.close();
    const writes = detail.textWrites;
    f.tick();
    assert.equal(f.monitor.calls[2].options.details, false);
    f.monitor.calls[2].resolve(snapshot(25));
    await flush();
    assert.equal(f.extension._labels.cpu.text, '25%');
    assert.equal(detail.textWrites, writes);
    f.extension.disable();
});

test('GPU-off and interval changes schedule promptly without restarting unrelated timers', async () => {
    const f = fixture();
    const firstTimer = [...f.timers.keys()][0];
    f.settings.set('show-gpu', false);
    assert.equal(f.monitor.gpuPaused, true, 'GPU subprocess must be paused even while another sample is pending');
    assert.equal([...f.timers.keys()][0], firstTimer);
    f.settings.set('refresh-interval', 3);
    f.settings.set('refresh-interval', 5);
    assert.equal(f.timers.size, 1);
    assert.equal([...f.timers.values()][0].seconds, 5);
    f.monitor.calls[0].resolve(snapshot());
    await flush();
    assert.equal(f.monitor.calls.length, 2);
    assert.equal(f.monitor.calls[1].includeGpu, false);
    assert.equal(f.monitor.calls[1].options.refreshInterval, 5);
    assert.equal(f.extension._groups.gpu.visible, false);
    f.monitor.calls[1].resolve(snapshot());
    await flush();
    f.extension.disable();
});

test('all-off policy pauses background work while keeping settings reachable', async () => {
    const f = fixture(Object.fromEntries(keys.map(key => [`show-${key}`, false])));
    assert.equal(f.monitor.calls.length, 0);
    assert.equal(f.timers.size, 0);
    assert.equal(f.extension._pausedIcon.visible, true);
    assert.equal(f.extension._groups.cpu.visible, false);
    f.extension._button.menu.open();
    const detail = f.monitor.calls[0];
    assert.equal(detail.includeGpu, false);
    assert.equal(detail.options.details, true);
    assert.equal(detail.options.includeMemory, true);
    assert.equal(detail.options.includeDisk, true);
    detail.resolve(snapshot());
    await flush();
    f.extension._button.menu.close();
    assert.equal(f.timers.size, 0);
    const reads = f.monitor.calls.length;
    f.extension._requestRefresh(true);
    assert.equal(f.monitor.calls.length, reads);
    f.settings.set('show-memory', true);
    assert.equal(f.timers.size, 1);
    assert.equal(f.extension._pausedIcon.visible, false);
    assert.equal(f.monitor.calls.at(-1).options.includeCpu, false);
    assert.equal(f.monitor.calls.at(-1).options.includeMemory, true);
    f.monitor.calls.at(-1).resolve(snapshot());
    await flush();
    f.extension.disable();
});

test('unchanged panel readings avoid redundant text and style writes', async () => {
    const f = fixture();
    f.monitor.calls[0].resolve(snapshot(80));
    await flush();
    const labels = Object.values(f.extension._labels);
    const writes = labels.map(label => [label.textWrites, label.classWrites]);
    f.tick();
    f.monitor.calls[1].resolve(snapshot(80));
    await flush();
    assert.deepEqual(labels.map(label => [label.textWrites, label.classWrites]), writes);
    f.extension.disable();
});
