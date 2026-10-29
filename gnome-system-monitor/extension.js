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
const setText = (actor, text) => {
    if (actor.text !== text)
        actor.text = text;
};
const setVisible = (actor, visible) => {
    if (actor.visible !== visible)
        actor.visible = visible;
};

export default class JunoSystemMonitor extends Extension {
    enable() {
        this._alive = true;
        this._busy = false;
        this._refreshQueued = false;
        this._revision = 0;
        this._timer = 0;
        this._settingsChangedId = 0;
        this._lastSample = null;
        this._lastSampleHasDetails = false;
        this._lastRefreshError = null;
        this._levels = {};
        try {
            this._settings = this.getSettings();
            this._monitor = new SystemMonitor();
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
            this._pausedIcon = new St.Icon({icon_name: 'emblem-system-symbolic', icon_size: 20,
                style_class: 'juno-monitor-panel-icon', visible: false});
            box.add_child(this._pausedIcon);
            this._button.add_child(box);
            // Index zero of the right box places us between the centered clock and tray.
            Main.panel.addToStatusArea(this.uuid, this._button, 0, 'right');
            this._buildMenu();
            this._settingsChangedId = this._settings.connect('changed', (_settings, key) => this._onSettingsChanged(key));
            this._button.menu.connect('open-state-changed', (_menu, open) => {
                if (!this._alive)
                    return;
                this._revision++;
                this._syncPolling();
                if (open) {
                    if (this._lastSampleHasDetails)
                        this._renderDetails(this._lastSample);
                    else
                        this._showDetailsLoading();
                    this._requestRefresh(true);
                }
            });
            this._updateVisibility();
            this._restartTimer();
            this._requestRefresh(true);
        } catch (error) {
            // A failed enable must not leave a timer, subprocess or panel actor.
            this.disable();
            throw error;
        }
    }

    _icon(key, styleClass) {
        return new St.Icon({
            gicon: new Gio.FileIcon({file: this.dir.get_child(`icons/${key}-symbolic.svg`)}),
            icon_size: 20,
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
        const visibility = Object.fromEntries(METRICS.map(([key]) => [key, this._settings.get_boolean(`show-${key}`)]));
        for (const [key] of METRICS) {
            if (visibility[key] && !this._groups[key].visible) {
                setText(this._labels[key], '—');
                this._setLevel(key, null);
            }
            setVisible(this._groups[key], visibility[key]);
        }
        setVisible(this._sections.gpu.section, this._settings.get_boolean('show-gpu'));
        const paused = !Object.values(visibility).some(Boolean);
        setVisible(this._pausedIcon, paused);
        if (paused)
            this._button.accessible_name = 'System Monitor: background monitoring paused';
    }

    _onSettingsChanged(key) {
        if (!this._alive)
            return;
        if (key === 'gpu-index' && this._lastSample) {
            // Every GPU is already in the snapshot; selecting one needs no I/O.
            this._render(this._lastSample, this._lastSampleHasDetails);
            return;
        }
        if (key === 'refresh-interval')
            this._restartTimer();
        if (key.startsWith('show-')) {
            if (key === 'show-gpu' && !this._settings.get_boolean(key))
                this._monitor.pauseGpu();
            this._updateVisibility();
            this._syncPolling();
            if (this._lastSample)
                this._render(this._lastSample, this._lastSampleHasDetails);
        }
        this._revision++;
        if (key === 'disk-path') {
            this._lastSample = null;
            this._lastSampleHasDetails = false;
            setText(this._labels.disk, '—');
            this._setLevel('disk', null);
            if (this._button.menu.isOpen)
                this._showDetailsLoading();
        }
        this._requestRefresh(true);
    }

    _restartTimer() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        if (!this._shouldPoll())
            return;
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this._settings.get_int('refresh-interval'), () => {
            if (!this._alive)
                return GLib.SOURCE_REMOVE;
            this._requestRefresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _shouldPoll() {
        return this._button.menu.isOpen || METRICS.some(([key]) => this._groups[key].visible);
    }

    _syncPolling() {
        if (!this._shouldPoll()) {
            if (this._timer)
                GLib.source_remove(this._timer);
            this._timer = 0;
            this._monitor.pause();
        } else if (!this._timer) {
            this._restartTimer();
        }
    }

    _requestRefresh(urgent = false) {
        if (!this._alive || !this._shouldPoll())
            return;
        if (this._busy) {
            // Coalesce user changes, but do not turn slow periodic polls into a
            // continuously busy loop by queueing a second poll on every tick.
            this._refreshQueued ||= urgent;
            return;
        }
        this._refresh();
    }

    async _refresh() {
        if (this._busy || !this._alive)
            return;
        this._busy = true;
        this._refreshQueued = false;
        const monitor = this._monitor;
        const revision = this._revision;
        const details = this._button.menu.isOpen;
        const options = {
            details,
            includeCpu: details || this._groups.cpu.visible,
            includeMemory: details || this._groups.memory.visible,
            includeDisk: details || this._groups.disk.visible,
            refreshInterval: this._settings.get_int('refresh-interval'),
        };
        try {
            const sample = await monitor.sample(this._settings.get_string('disk-path'), this._settings.get_boolean('show-gpu'), options);
            if (this._alive && this._monitor === monitor && revision === this._revision) {
                this._lastRefreshError = null;
                this._render(sample, details);
            }
        } catch (error) {
            if (this._alive && this._monitor === monitor && revision === this._revision) {
                if (this._button.menu.isOpen) {
                    setText(this._status, 'Sensor read failed; retrying…');
                    setVisible(this._status, true);
                }
                if (this._lastRefreshError !== error.message)
                    console.error(`[${this.uuid}] ${error.message}`);
                this._lastRefreshError = error.message;
            }
        } finally {
            if (this._alive && this._monitor === monitor) {
                this._busy = false;
                if (this._refreshQueued) {
                    this._refreshQueued = false;
                    this._requestRefresh();
                }
            }
        }
    }

    _setLevel(key, value) {
        const level = value >= 90 ? 'juno-monitor-critical' : value >= 75 ? 'juno-monitor-warning' : null;
        if (this._levels[key] === level)
            return;
        if (this._levels[key])
            this._labels[key].remove_style_class_name(this._levels[key]);
        if (level)
            this._labels[key].add_style_class_name(level);
        this._levels[key] = level;
    }

    _sampleValues(sample) {
        const gpu = (sample.gpus ?? [])[this._settings.get_int('gpu-index')] ?? null;
        return {gpu, cpu: sample.cpu?.utilization, memory: sample.memory?.percent, disk: sample.disk?.percent};
    }

    _render(sample, hasDetails = true) {
        this._lastSample = sample;
        this._lastSampleHasDetails = hasDetails;
        const values = this._sampleValues(sample);
        const summary = [];
        for (const [key, title] of METRICS) {
            if (!this._groups[key].visible)
                continue;
            const value = key === 'gpu' ? values.gpu?.utilization : values[key];
            const text = formatPercent(value);
            setText(this._labels[key], text);
            this._setLevel(key, value);
            summary.push(`${title} ${text}`);
        }
        const accessibleName = summary.join(', ') || 'System Monitor: background monitoring paused';
        if (this._button.accessible_name !== accessibleName)
            this._button.accessible_name = accessibleName;
        if (this._button.menu.isOpen && hasDetails)
            this._renderDetails(sample);
    }

    _showDetailsLoading() {
        const path = this._settings.get_string('disk-path');
        setText(this._sections.disk.titleLabel, `Storage · ${path}`);
        setText(this._intervalLabel, `${this._settings.get_int('refresh-interval')} s`);
        for (const section of Object.values(this._sections)) {
            setText(section.value, '—');
            section.details.forEach((label, index) => setText(label, index === 0 ? 'Reading sensors…' : ''));
        }
        setText(this._status, this._lastRefreshError ? 'Sensor read failed; retrying…' : '');
        setVisible(this._status, Boolean(this._lastRefreshError));
    }

    _renderDetails(sample) {
        if (!sample)
            return;
        const values = this._sampleValues(sample);
        const gpu = values.gpu;
        const disk = sample.disk;
        const memory = sample.memory;
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
        for (const [key, lines] of Object.entries(details)) {
            if (key === 'gpu' && !this._settings.get_boolean('show-gpu'))
                continue;
            setText(this._sections[key].value, formatPercent(key === 'gpu' ? gpu?.utilization : values[key]));
            lines.forEach((line, index) => setText(this._sections[key].details[index], line));
        }
        setText(this._intervalLabel, `${this._settings.get_int('refresh-interval')} s`);
        setText(this._sections.disk.titleLabel, disk ? `Storage · ${disk.path}` : 'Storage');
        const storageName = disk ? `Storage ${disk.path}` : 'Storage unavailable';
        if (this._sections.disk.section.accessible_name !== storageName)
            this._sections.disk.section.accessible_name = storageName;
        const issues = Object.keys(sample.errors).map(key => `${key}: unavailable`);
        if ((!gpu || gpu.unavailable) && this._settings.get_boolean('show-gpu')) {
            const gpus = sample.gpus ?? [];
            const index = this._settings.get_int('gpu-index');
            issues.push(gpu?.unavailable ? `${gpu.name}: unavailable` :
                gpus.length ? `GPU index ${index} unavailable` : 'GPU: NVIDIA/AMD sensor unavailable');
        }
        setText(this._status, issues.join(' · '));
        setVisible(this._status, issues.length > 0);
    }

    disable() {
        this._alive = false;
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        this._refreshQueued = false;
        if (this._settingsChangedId)
            this._settings?.disconnect(this._settingsChangedId);
        this._settingsChangedId = 0;
        this._monitor?.stop();
        this._button?.destroy();
        this._button = null;
        this._settings = null;
        this._monitor = null;
        this._labels = null;
        this._groups = null;
        this._pausedIcon = null;
        this._sections = null;
        this._levels = null;
        this._intervalLabel = null;
        this._status = null;
        this._lastSample = null;
        this._lastSampleHasDetails = false;
        this._lastRefreshError = null;
    }
}
