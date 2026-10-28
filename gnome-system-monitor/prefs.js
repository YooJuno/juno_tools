import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
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
        path.connect('apply', () => {
            const value = path.text.trim();
            const valid = value.startsWith('/') && Gio.File.new_for_path(value).query_exists(null);
            if (valid) {
                settings.set_string('disk-path', value);
                path.remove_css_class('error');
            } else {
                path.add_css_class('error');
            }
        });
        sensors.add(path);
        const gpu = new Adw.SpinRow({
            title: 'GPU index', subtitle: '0 = first NVIDIA GPU, followed by AMD GPUs. Intel utilization is unavailable.',
            adjustment: new Gtk.Adjustment({lower: 0, upper: 31, step_increment: 1}),
        });
        settings.bind('gpu-index', gpu, 'value', Gio.SettingsBindFlags.DEFAULT);
        sensors.add(gpu);
        page.add(sensors);
        page.add(new Adw.PreferencesGroup({
            title: 'About the readings',
            description: 'MEM uses MemTotal − MemAvailable. SSD shows used filesystem capacity, regardless of drive type. Click the top bar for temperatures and disk I/O. Unsupported readings show —. SMART health is not collected. NVIDIA polling can keep a laptop GPU awake; turn off GPU above to stop querying it.',
        }));
        window.add(page);
    }
}
