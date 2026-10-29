// Source installer helper; deliberately excluded from the extension ZIP.
import Gio from 'gi://Gio';
import System from 'system';

export function activationChanges(settings, uuid, checkInstallation = true) {
    if (checkInstallation && !settings.get_boolean('allow-extension-installation'))
        throw new Error('Extension installation is disabled by system policy');
    const enabled = settings.get_strv('enabled-extensions');
    const disabled = settings.get_strv('disabled-extensions');
    const changes = [];
    if (!enabled.includes(uuid))
        changes.push({key: 'enabled-extensions', type: 'strv', value: [...enabled, uuid]});
    if (disabled.includes(uuid))
        changes.push({key: 'disabled-extensions', type: 'strv', value: disabled.filter(item => item !== uuid)});
    if (settings.get_boolean('disable-user-extensions'))
        changes.push({key: 'disable-user-extensions', type: 'boolean', value: false});
    // Check every requested change before writing any of them. An already
    // correct locked setting does not need to be written again.
    for (const {key} of changes) {
        if (!settings.is_writable(key))
            throw new Error(`${key} is locked by system policy`);
    }
    return changes;
}

export function activate(settings, uuid, checkOnly = false, checkInstallation = true) {
    const changes = activationChanges(settings, uuid, checkInstallation);
    if (checkOnly || !changes.length)
        return;
    settings.delay();
    try {
        for (const {key, type, value} of changes) {
            if (!settings[`set_${type}`](key, value))
                throw new Error(`Could not save ${key}`);
        }
        settings.apply();
        Gio.Settings.sync();
        for (const {key, type, value} of changes) {
            if (JSON.stringify(settings[`get_${type}`](key)) !== JSON.stringify(value))
                throw new Error(`The saved ${key} did not match the requested state`);
        }
    } catch (error) {
        settings.revert();
        throw error;
    }
}

if (System.programPath && Gio.File.new_for_path(System.programPath).equal(Gio.File.new_for_uri(import.meta.url))) {
    try {
        const [mode, uuid] = ARGV;
        if (!['--check', '--apply', '--system-check', '--system-apply'].includes(mode) || !uuid)
            throw new Error('Usage: activation.js --check|--apply|--system-check|--system-apply UUID');
        activate(new Gio.Settings({schema_id: 'org.gnome.shell'}), uuid,
            mode.endsWith('check'), !mode.startsWith('--system-'));
    } catch (error) {
        printerr(`Activation failed: ${error.message}`);
        imports.system.exit(1);
    }
}
