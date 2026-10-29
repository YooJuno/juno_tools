import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class JunoMonitorPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        window.set_default_size(600, 650);
        const page = new Adw.PreferencesPage({title: 'System Monitor', icon_name: 'utilities-system-monitor-symbolic'});
        const display = new Adw.PreferencesGroup({title: 'Top bar', description: 'Shown between the clock and system indicators. Changes apply immediately.'});
        for (const [key, title] of [['cpu', 'CPU'], ['gpu', 'GPU'], ['memory', 'Memory'], ['disk', 'SSD / storage']]) {
            const row = new Adw.SwitchRow({title});
            settings.bind(`show-${key}`, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            display.add(row);
        }
        page.add(display);
        const sensors = new Adw.PreferencesGroup({title: 'Sensors'});
        const interval = new Adw.SpinRow({
            title: 'Refresh interval', subtitle: 'Seconds; a longer interval reduces sensor polling.',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 30, step_increment: 1}),
        });
        settings.bind('refresh-interval', interval, 'value', Gio.SettingsBindFlags.DEFAULT);
        sensors.add(interval);
        const path = new Adw.EntryRow({title: 'Storage path (for example / or /home)', show_apply_button: true});
        path.text = settings.get_string('disk-path');
        path.sensitive = settings.is_writable('disk-path');
        let pending = null;
        let generation = 0;
        let closed = false;
        const pathError = message => {
            path.add_css_class('error');
            path.set_tooltip_text(message);
        };
        path.connect('changed', () => {
            generation++;
            pending?.cancellable.cancel();
            path.remove_css_class('error');
            path.set_tooltip_text(null);
        });
        path.connect('apply', () => {
            const value = path.text.trim();
            if (!settings.is_writable('disk-path')) {
                pathError('This setting is locked by system policy.');
                return;
            }
            if (!value.startsWith('/')) {
                pathError('Enter an absolute path, for example / or /home.');
                return;
            }
            // A cancelled network filesystem query can still be finishing in a
            // worker. Do not enqueue another one until its callback returns.
            if (pending) {
                pathError('The previous path check is still finishing.');
                return;
            }
            const request = {cancellable: new Gio.Cancellable(), generation, timeout: 0, expired: false};
            pending = request;
            path.sensitive = false;
            request.timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                request.timeout = 0;
                request.expired = true;
                request.cancellable.cancel();
                if (!closed) {
                    path.sensitive = settings.is_writable('disk-path');
                    pathError('Path check timed out. The saved path was not changed.');
                }
                return GLib.SOURCE_REMOVE;
            });
            Gio.File.new_for_path(value).query_info_async('standard::type', Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT, request.cancellable, (source, result) => {
                    let valid = false;
                    try { valid = Boolean(source.query_info_finish(result)); } catch { /* Cancelled or inaccessible. */ }
                    if (request.timeout)
                        GLib.source_remove(request.timeout);
                    request.timeout = 0;
                    pending = null;
                    if (closed)
                        return;
                    path.sensitive = settings.is_writable('disk-path');
                    if (request.generation !== generation || request.expired)
                        return;
                    if (valid && settings.set_string('disk-path', value)) {
                        path.remove_css_class('error');
                        path.set_tooltip_text(null);
                    } else {
                        pathError('Path is unavailable or the setting is locked.');
                    }
                });
        });
        window.connect('close-request', () => {
            closed = true;
            generation++;
            if (pending) {
                pending.cancellable.cancel();
                if (pending.timeout)
                    GLib.source_remove(pending.timeout);
                pending.timeout = 0;
            }
            return false;
        });
        sensors.add(path);
        const gpu = new Adw.SpinRow({
            title: 'GPU index', subtitle: 'Detected device order; unavailable GPUs keep their slot until restart. Intel utilization is unavailable.',
            adjustment: new Gtk.Adjustment({lower: 0, upper: 31, step_increment: 1}),
        });
        settings.bind('gpu-index', gpu, 'value', Gio.SettingsBindFlags.DEFAULT);
        sensors.add(gpu);
        page.add(sensors);
        page.add(new Adw.PreferencesGroup({
            title: 'About the readings',
            description: 'MEM uses MemTotal − MemAvailable. SSD shows used filesystem capacity, regardless of drive type. Click the top bar for temperatures and disk I/O. Turn off all panel items to pause background monitoring; a settings icon remains. Unsupported readings show —. SMART health is not collected. NVIDIA polling can keep a laptop GPU awake; turn off GPU above to stop querying it.',
        }));
        window.add(page);
    }
}
