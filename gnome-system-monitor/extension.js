import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
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
        this._button.add_style_class_name('juno-monitor-button');
        this._button.accessible_name = 'CPU, GPU, memory and storage status';
        const box = new St.BoxLayout({style_class: 'juno-monitor-panel'});
        this._labels = {};
        this._groups = {};
        for (const [key, title] of METRICS) {
            const group = new St.BoxLayout({style_class: 'juno-monitor-metric'});
            group.accessible_name = title;
            group.add_child(this._icon(key, 'juno-monitor-panel-icon'));
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

    _icon(key, styleClass) {
        return new St.Icon({
            gicon: new Gio.FileIcon({file: this.dir.get_child(`icons/${key}-symbolic.svg`)}),
            style_class: styleClass,
            y_align: Clutter.ActorAlign.CENTER,
        });
    }

    _buildMenu() {
        // Plain St actors inherit the menu foreground without disabled-item styling.
        const content = new St.BoxLayout({vertical: true, style_class: 'juno-monitor-content'});
        const heading = new St.BoxLayout({style_class: 'juno-monitor-heading'});
        heading.add_child(new St.Label({text: 'System Monitor', x_expand: true, style_class: 'juno-monitor-title'}));
        this._intervalLabel = new St.Label({text: '', opacity: 210, y_align: Clutter.ActorAlign.CENTER});
        heading.add_child(this._intervalLabel);
        content.add_child(heading);
        this._sections = {};
        for (const [key, title] of [['cpu', 'CPU'], ['gpu', 'GPU'], ['memory', 'Memory'], ['disk', 'Storage']]) {
            const section = new St.BoxLayout({vertical: true, style_class: 'juno-monitor-section'});
            const header = new St.BoxLayout({style_class: 'juno-monitor-section-header'});
            header.add_child(this._icon(key, 'juno-monitor-menu-icon'));
            const titleLabel = new St.Label({text: title, x_expand: true, style_class: 'juno-monitor-section-title'});
            titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            header.add_child(titleLabel);
            const value = new St.Label({text: '—', style_class: 'juno-monitor-section-value'});
            header.add_child(value);
            section.add_child(header);
            const details = [];
            for (let index = 0; index < (key === 'cpu' ? 1 : 2); index++) {
                const label = new St.Label({text: '—', x_expand: true, opacity: 225, style_class: 'juno-monitor-secondary'});
                label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                section.add_child(label);
                details.push(label);
            }
            content.add_child(section);
            this._sections[key] = {section, titleLabel, value, details};
        }
        this._status = new St.Label({text: '', visible: false, style_class: 'juno-monitor-secondary'});
        this._status.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        content.add_child(this._status);
        this._button.menu.box.add_child(content);
        this._button.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const settings = new PopupMenu.PopupImageMenuItem('Settings…', 'emblem-system-symbolic');
        settings.connect('activate', () => this.openPreferences());
        this._button.menu.addMenuItem(settings);
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
                this._status.visible = true;
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
            this._sections[key].value.text = formatPercent(values[key]);
            this._labels[key].remove_style_class_name('juno-monitor-warning');
            this._labels[key].remove_style_class_name('juno-monitor-critical');
            if (values[key] >= 90)
                this._labels[key].add_style_class_name('juno-monitor-critical');
            else if (values[key] >= 75)
                this._labels[key].add_style_class_name('juno-monitor-warning');
        }
        const rate = value => value === null || value === undefined ? '—' : `${formatBytes(value)}/s`;
        const details = {
            cpu: [`Temperature ${temperature(sample.cpu?.temperature)}`],
            gpu: [gpu ? `VRAM ${formatBytes(gpu.memoryUsed)} / ${formatBytes(gpu.memoryTotal)} · ${temperature(gpu.temperature)}` : 'Sensor unavailable',
                gpu?.name ?? 'NVIDIA / AMD sensors supported'],
            memory: [memory ? `${formatBytes(memory.used)} / ${formatBytes(memory.total)}` : 'Sensor unavailable',
                memory ? `Swap ${formatBytes(memory.swapUsed)} / ${formatBytes(memory.swapTotal)}` : '—'],
            disk: [disk ? `${formatBytes(disk.used)} / ${formatBytes(disk.total)} · ${formatBytes(disk.free)} free` : 'Sensor unavailable',
                `↓ ${rate(disk?.read)}  ↑ ${rate(disk?.write)} · I/O ${formatPercent(disk?.busy)}`],
        };
        for (const [key, lines] of Object.entries(details))
            lines.forEach((line, index) => { this._sections[key].details[index].text = line; });
        this._sections.gpu.section.visible = this._settings.get_boolean('show-gpu');
        this._intervalLabel.text = `${this._settings.get_int('refresh-interval')} s`;
        this._sections.disk.titleLabel.text = disk ? `Storage · ${disk.path}` : 'Storage';
        this._sections.disk.section.accessible_name = disk ? `Storage ${disk.path}` : 'Storage unavailable';
        const issues = Object.keys(sample.errors).map(key => `${key}: unavailable`);
        if (!gpu && this._settings.get_boolean('show-gpu'))
            issues.push(gpus.length ? `GPU index ${gpuIndex} unavailable` : 'GPU: NVIDIA/AMD sensor unavailable');
        this._status.text = issues.join(' · ');
        this._status.visible = issues.length > 0;
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
        this._sections = null;
        this._intervalLabel = null;
        this._status = null;
        this._lastSample = null;
    }
}
