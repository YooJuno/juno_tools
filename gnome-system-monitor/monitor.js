import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {clamp, cpuUsage, diskRates, findMount, parseCpu, parseDiskstats, parseMemory, parseNvidia} from './metrics.js';

function readText(path, cancellable) {
    return new Promise((resolve, reject) => {
        const file = Gio.File.new_for_path(path);
        file.load_contents_async(cancellable, (source, result) => {
            try {
                const [, contents] = source.load_contents_finish(result);
                resolve(new TextDecoder().decode(contents));
            } catch (error) {
                reject(error);
            }
        });
    });
}

async function optionalText(path, cancellable) {
    try {
        return (await readText(path, cancellable)).trim();
    } catch {
        return null;
    }
}

function children(path, cancellable) {
    return new Promise((resolve, reject) => {
        Gio.File.new_for_path(path).enumerate_children_async(
            'standard::name', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT,
            cancellable, async (source, result) => {
                let enumerator;
                try {
                    enumerator = source.enumerate_children_finish(result);
                    const names = [];
                    let batch;
                    do {
                        batch = await new Promise((ok, fail) => enumerator.next_files_async(
                            64, GLib.PRIORITY_DEFAULT, cancellable, (object, response) => {
                                try { ok(object.next_files_finish(response)); } catch (error) { fail(error); }
                            }));
                        names.push(...batch.map(info => info.get_name()));
                    } while (batch.length);
                    resolve(names);
                } catch (error) {
                    reject(error);
                } finally {
                    enumerator?.close_async(GLib.PRIORITY_DEFAULT, null, (object, response) => {
                        try { object.close_finish(response); } catch { /* Already cancelled. */ }
                    });
                }
            });
    });
}

function filesystemInfo(path, cancellable) {
    return new Promise((resolve, reject) => {
        Gio.File.new_for_path(path).query_filesystem_info_async(
            'filesystem::size,filesystem::free', GLib.PRIORITY_DEFAULT, cancellable,
            (source, result) => {
                try { resolve(source.query_filesystem_info_finish(result)); } catch (error) { reject(error); }
            });
    });
}

function readNumber(text) {
    return text !== null && text !== '' && Number.isFinite(Number(text)) ? Number(text) : null;
}

export class SystemMonitor {
    constructor() {
        this._cancellable = new Gio.Cancellable();
        this._processes = new Set();
        this._cpuPrevious = null;
        this._diskPrevious = null;
        this._temperaturePaths = null;
        this._amdPaths = null;
        this._nvidia = GLib.find_program_in_path('nvidia-smi');
    }

    stop() {
        this._cancellable.cancel();
        for (const process of this._processes)
            process.force_exit();
        this._processes.clear();
    }

    async sample(path = '/', includeGpu = true) {
        const results = await Promise.allSettled([
            this._cpu(), this._memory(), includeGpu ? this._gpu() : Promise.resolve([]), this._disk(path),
        ]);
        const keys = ['cpu', 'memory', 'gpus', 'disk'];
        const snapshot = {errors: {}};
        results.forEach((result, index) => {
            if (result.status === 'fulfilled')
                snapshot[keys[index]] = result.value;
            else {
                snapshot[keys[index]] = null;
                snapshot.errors[keys[index]] = result.reason.message;
            }
        });
        return snapshot;
    }

    async _cpu() {
        const current = parseCpu(await readText('/proc/stat', this._cancellable));
        const utilization = cpuUsage(this._cpuPrevious, current);
        this._cpuPrevious = current;
        const temperature = await this._cpuTemperature();
        return {utilization, temperature};
    }

    async _cpuTemperature() {
        if (this._temperaturePaths === null) {
            this._temperaturePaths = [];
            const devices = await children('/sys/class/hwmon', this._cancellable).catch(() => []);
            for (const device of devices) {
                const base = `/sys/class/hwmon/${device}`;
                const name = await optionalText(`${base}/name`, this._cancellable);
                if (!['coretemp', 'k10temp', 'zenpower', 'cpu_thermal'].includes(name))
                    continue;
                const files = await children(base, this._cancellable).catch(() => []);
                this._temperaturePaths.push(...files.filter(file => /^temp\d+_input$/.test(file)).map(file => `${base}/${file}`));
            }
        }
        const values = (await Promise.all(this._temperaturePaths.map(path => optionalText(path, this._cancellable))))
            .map(readNumber).filter(value => value !== null && value > 0 && value < 150000);
        return values.length ? Math.max(...values) / 1000 : null;
    }

    async _memory() {
        return parseMemory(await readText('/proc/meminfo', this._cancellable));
    }

    async _nvidiaGpus() {
        if (!this._nvidia)
            return [];
        const process = Gio.Subprocess.new([
            this._nvidia, '--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu',
            '--format=csv,noheader,nounits',
        ], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        this._processes.add(process);
        const timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
            process.force_exit();
            return GLib.SOURCE_REMOVE;
        });
        try {
            const output = await new Promise((resolve, reject) => {
                process.communicate_utf8_async(null, this._cancellable, (source, result) => {
                    try {
                        const [, stdout, stderr] = source.communicate_utf8_finish(result);
                        if (!source.get_successful())
                            throw new Error(stderr.trim() || 'nvidia-smi unavailable');
                        resolve(stdout);
                    } catch (error) { reject(error); }
                });
            });
            return parseNvidia(output);
        } finally {
            // The timeout may already have removed itself.
            if (GLib.MainContext.default().find_source_by_id(timeout))
                GLib.source_remove(timeout);
            this._processes.delete(process);
        }
    }

    async _amdGpus() {
        if (this._amdPaths === null) {
            const cards = await children('/sys/class/drm', this._cancellable).catch(() => []);
            this._amdPaths = [];
            for (const card of cards.filter(name => /^card\d+$/.test(name)).sort()) {
                const base = `/sys/class/drm/${card}/device`;
                if (await optionalText(`${base}/vendor`, this._cancellable) === '0x1002')
                    this._amdPaths.push({card, base});
            }
        }
        return Promise.all(this._amdPaths.map(async ({card, base}) => {
            const [busy, used, total] = await Promise.all(['gpu_busy_percent', 'mem_info_vram_used', 'mem_info_vram_total']
                .map(file => optionalText(`${base}/${file}`, this._cancellable)));
            return {
                id: card, name: `AMD ${card}`, utilization: readNumber(busy),
                memoryUsed: readNumber(used), memoryTotal: readNumber(total), temperature: null,
            };
        }));
    }

    async _gpu() {
        const results = await Promise.allSettled([this._nvidiaGpus(), this._amdGpus()]);
        const gpus = results.filter(result => result.status === 'fulfilled').flatMap(result => result.value);
        if (!gpus.length && results.some(result => result.status === 'rejected'))
            throw new Error('GPU query failed; check the driver and nvidia-smi');
        return gpus;
    }

    async _disk(path) {
        path = GLib.canonicalize_filename(path, '/');
        const [info, mounts, counters] = await Promise.all([
            filesystemInfo(path, this._cancellable), readText('/proc/self/mountinfo', this._cancellable),
            readText('/proc/diskstats', this._cancellable),
        ]);
        const mount = findMount(mounts, path);
        const total = info.get_attribute_uint64('filesystem::size');
        const free = info.get_attribute_uint64('filesystem::free');
        if (total <= 0)
            throw new Error('Filesystem capacity unavailable');
        const current = mount ? parseDiskstats(counters, mount.device) : null;
        const now = GLib.get_monotonic_time() / 1e6;
        const previous = this._diskPrevious;
        const rates = diskRates(previous?.path === path ? previous?.counters : null, current, now - (previous?.time ?? now));
        this._diskPrevious = {path, time: now, counters: current};
        return {path, mount, total, free, used: total - free, percent: clamp((total - free) / total * 100), ...rates};
    }
}
