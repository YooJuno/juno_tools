import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {formatBytes, formatPercent} from './metrics.js';
import {SystemMonitor} from './monitor.js';

const METRICS = [['cpu', 'CPU'], ['gpu', 'GPU'], ['memory', 'MEM'], ['disk', 'SSD']];
const temperature = value => value === null || value === undefined ? '—' : `${Math.round(value)} °C`;

export default class JunoSystemMonitor extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._monitor = new SystemMonitor();
        this._alive = true;
        this._busy = false;
        this._timer = 0;
        this._button = new PanelMenu.Button(0.5, 'Juno System Monitor');
        this._button.accessible_name = 'CPU, GPU, memory and storage status';
        const box = new St.BoxLayout({style_class: 'juno-monitor-panel'});
        this._labels = {};
        this._groups = {};
        for (const [key, title] of METRICS) {
            const group = new St.BoxLayout({style_class: 'juno-monitor-metric'});
            group.add_child(new St.Label({text: title, style_class: 'juno-monitor-caption', y_align: Clutter.ActorAlign.CENTER}));
            const label = new St.Label({text: '—', style_class: 'juno-monitor-value', y_align: Clutter.ActorAlign.CENTER});
            group.add_child(label);
            box.add_child(group);
            this._labels[key] = label;
            this._groups[key] = group;
        }
        this._button.add_child(box);
        // Index zero of the right box places us between the centered clock and tray.
        Main.panel.addToStatusArea(this.uuid, this._button, 0, 'right');
        this._buildMenu();
        this._settings.connectObject('changed', () => {
            this._updateVisibility();
            this._restartTimer();
        }, this);
        this._updateVisibility();
        this._restartTimer();
    }

    _buildMenu() {
        const title = new PopupMenu.PopupMenuItem('Juno System Monitor', {reactive: false});
        title.add_style_class_name('juno-monitor-title');
        this._button.menu.addMenuItem(title);
        this._rows = {};
        for (const [key, label] of [
            ['cpu', 'CPU'], ['cpuTemp', 'CPU temperature'], ['gpu', 'GPU'], ['gpuMem', 'GPU memory'],
            ['gpuTemp', 'GPU temperature'], ['memory', 'Memory'], ['swap', 'Swap'],
            ['disk', 'Storage'], ['diskFree', 'Free space'], ['diskRead', 'Read'],
            ['diskWrite', 'Write'], ['diskBusy', 'Disk activity'],
        ]) {
            const row = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
            row.add_child(new St.Label({text: label, x_expand: true, style_class: 'juno-monitor-row-caption'}));
            const value = new St.Label({text: '—', style_class: 'juno-monitor-detail', x_align: Clutter.ActorAlign.END});
            row.add_child(value);
            this._button.menu.addMenuItem(row);
            this._rows[key] = {row, value};
        }
        this._button.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const status = new PopupMenu.PopupMenuItem('Reading sensors…', {reactive: false});
        status.label.add_style_class_name('juno-monitor-status');
        this._button.menu.addMenuItem(status);
        this._status = status.label;
        this._button.menu.addAction('Settings…', () => this.openPreferences());
    }

    _updateVisibility() {
        for (const [key] of METRICS)
            this._groups[key].visible = this._settings.get_boolean(`show-${key}`);
        // Keep settings reachable if all four items were turned off.
        this._groups.cpu.visible ||= !METRICS.some(([key]) => this._groups[key].visible);
    }

    _restartTimer() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._refresh();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this._settings.get_int('refresh-interval'), () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    async _refresh() {
        if (this._busy || !this._alive)
            return;
        this._busy = true;
        const monitor = this._monitor;
        try {
            const sample = await monitor.sample(this._settings.get_string('disk-path'), this._settings.get_boolean('show-gpu'));
            if (this._alive && this._monitor === monitor)
                this._render(sample);
        } catch (error) {
            if (this._alive && this._monitor === monitor) {
                this._status.text = 'Sensor read failed; retrying…';
                console.error(`[${this.uuid}] ${error.message}`);
            }
        } finally {
            if (this._monitor === monitor)
                this._busy = false;
        }
    }

    _render(sample) {
        this._lastSample = sample;
        const gpuIndex = this._settings.get_int('gpu-index');
        const gpus = sample.gpus ?? [];
        const gpu = gpus[gpuIndex] ?? null;
        const disk = sample.disk;
        const memory = sample.memory;
        const values = {cpu: sample.cpu?.utilization, gpu: gpu?.utilization, memory: memory?.percent, disk: disk?.percent};
        for (const [key] of METRICS) {
            this._labels[key].text = formatPercent(values[key]);
            this._labels[key].remove_style_class_name('juno-monitor-warning');
            this._labels[key].remove_style_class_name('juno-monitor-critical');
            if (values[key] >= 90)
                this._labels[key].add_style_class_name('juno-monitor-critical');
            else if (values[key] >= 75)
                this._labels[key].add_style_class_name('juno-monitor-warning');
        }
        const rowValues = {
            cpu: formatPercent(values.cpu), cpuTemp: temperature(sample.cpu?.temperature),
            gpu: gpu ? `${gpu.name} · ${formatPercent(gpu.utilization)}` : 'Unavailable',
            gpuMem: gpu ? `${formatBytes(gpu.memoryUsed)} / ${formatBytes(gpu.memoryTotal)}` : '—',
            gpuTemp: temperature(gpu?.temperature),
            memory: memory ? `${formatBytes(memory.used)} / ${formatBytes(memory.total)}` : '—',
            swap: memory ? `${formatBytes(memory.swapUsed)} / ${formatBytes(memory.swapTotal)}` : '—',
            disk: disk ? `${disk.path} · ${formatBytes(disk.used)} / ${formatBytes(disk.total)}` : '—',
            diskFree: formatBytes(disk?.free),
            diskRead: disk?.read === null || !disk ? '—' : `${formatBytes(disk.read)}/s`,
            diskWrite: disk?.write === null || !disk ? '—' : `${formatBytes(disk.write)}/s`,
            diskBusy: formatPercent(disk?.busy),
        };
        for (const [key, value] of Object.entries(rowValues))
            this._rows[key].value.text = value;
        for (const key of ['gpu', 'gpuMem', 'gpuTemp'])
            this._rows[key].row.visible = this._settings.get_boolean('show-gpu');
        const issues = Object.keys(sample.errors).map(key => `${key}: unavailable`);
        if (!gpu && this._settings.get_boolean('show-gpu'))
            issues.push(gpus.length ? `GPU index ${gpuIndex} unavailable` : 'GPU: NVIDIA/AMD sensor unavailable');
        this._status.text = issues.length ? issues.join(' · ') : `Every ${this._settings.get_int('refresh-interval')} s · ${disk?.mount?.source ?? 'storage'}`;
        this._button.accessible_name = METRICS.filter(([key]) => this._groups[key].visible)
            .map(([key, title]) => `${title} ${formatPercent(values[key])}`).join(', ');
    }

    disable() {
        this._alive = false;
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        this._settings?.disconnectObject(this);
        this._monitor?.stop();
        this._button?.destroy();
        this._button = null;
        this._settings = null;
        this._monitor = null;
        this._labels = null;
        this._groups = null;
        this._rows = null;
        this._status = null;
        this._lastSample = null;
    }
}
