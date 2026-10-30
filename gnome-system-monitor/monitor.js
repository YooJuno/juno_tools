import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {clamp, cpuUsage, diskRates, findMount, parseBlockStat, parseCpu, parseMemory} from './metrics.js';
import {NvidiaSampler} from './nvidia.js';

const decoder = new TextDecoder();
const CAPACITY_CACHE_SECONDS = 10;
const MOUNT_CACHE_SECONDS = 30;
const SENSOR_DISCOVERY_SECONDS = 60;
const TEMPERATURE_CACHE_SECONDS = 5;
const IO_TIMEOUT_MS = 1200;
const PROGRESS_DELAY_MS = 50;
const CPU_HWMON_NAMES = new Set(['coretemp', 'k10temp', 'zenpower', 'cpu_thermal', 'cpu-thermal']);
const CPU_THERMAL_TYPES = new Set(['cpu-thermal', 'cpu_thermal', 'cpu-therm', 'x86_pkg_temp']);
const nowSeconds = () => GLib.get_monotonic_time() / 1e6;

function readNumber(text) {
    return text !== null && text !== '' && Number.isFinite(Number(text)) ? Number(text) : null;
}

export class SystemMonitor {
    constructor() {
        this._cancellable = new Gio.Cancellable();
        this._files = new Map();
        this._tasks = new Map();
        this._retryAfter = new Map();
        this._stopped = false;
        this._cpuPrevious = null;
        this._cpuGeneration = 0;
        this._diskState = null;
        this._temperaturePaths = [];
        this._temperatureDiscoveryAt = -Infinity;
        this._temperature = null;
        this._temperatureAt = -Infinity;
        this._temperatureGeneration = 0;
        this._amdPaths = [];
        this._amdDiscoveryAt = -Infinity;
        this._gpuSlots = new Map();
        this._nvidiaSampler = new NvidiaSampler(GLib.find_program_in_path('nvidia-smi'));
    }

    stop() {
        if (this._stopped)
            return;
        this._stopped = true;
        this._cpuGeneration++;
        this._temperatureGeneration++;
        this._nvidiaSampler.stop();
        for (const task of this._tasks.values()) {
            if (task.timeout)
                GLib.source_remove(task.timeout);
            task.timeout = 0;
            task.reject(new Error('Monitor stopped'));
        }
        this._tasks.clear();
        this._retryAfter.clear();
        this._cancellable.cancel();
        this._files.clear();
        this._gpuSlots.clear();
        this._cpuPrevious = this._diskState = this._temperature = null;
        this._temperaturePaths = this._amdPaths = [];
    }

    pauseGpu() {
        this._nvidiaSampler.pause();
    }

    pause() {
        this.pauseGpu();
        this._cpuPrevious = this._diskState = null;
        this._cpuGeneration++;
        this._temperatureGeneration++;
    }

    _file(path) {
        if (this._stopped)
            throw new Error('Monitor stopped');
        let file = this._files.get(path);
        if (!file) {
            // A path can be changed repeatedly in preferences; bound the cache.
            if (this._files.size >= 128)
                this._files.delete(this._files.keys().next().value);
            file = Gio.File.new_for_path(path);
            this._files.set(path, file);
        }
        return file;
    }

    _readText(path) {
        return new Promise((resolve, reject) => {
            this._file(path).load_contents_async(this._cancellable, (source, result) => {
                try {
                    const [, contents] = source.load_contents_finish(result);
                    resolve(decoder.decode(contents));
                } catch (error) { reject(error); }
            });
        });
    }

    async _optionalText(path) {
        try {
            return (await this._readText(path)).trim();
        } catch {
            return null;
        }
    }

    _children(path) {
        return new Promise((resolve, reject) => {
            this._file(path).enumerate_children_async(
                'standard::name', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT,
                this._cancellable, async (source, result) => {
                    let enumerator;
                    try {
                        enumerator = source.enumerate_children_finish(result);
                        const names = [];
                        let batch;
                        do {
                            batch = await new Promise((ok, fail) => enumerator.next_files_async(
                                64, GLib.PRIORITY_DEFAULT, this._cancellable, (object, response) => {
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

    _filesystemInfo(path) {
        return new Promise((resolve, reject) => {
            this._file(path).query_filesystem_info_async(
                'filesystem::size,filesystem::free', GLib.PRIORITY_DEFAULT, this._cancellable,
                (source, result) => {
                    try { resolve(source.query_filesystem_info_finish(result)); } catch (error) { reject(error); }
                });
        });
    }

    _pathDevice(path) {
        return new Promise((resolve, reject) => {
            this._file(path).query_info_async('unix::device', Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT, this._cancellable, (source, result) => {
                    try {
                        const info = source.query_info_finish(result);
                        if (!info.has_attribute('unix::device')) {
                            resolve(null);
                            return;
                        }
                        const device = info.get_attribute_uint32('unix::device');
                        // Linux dev_t encoding in the uint32 attribute GIO exposes.
                        const major = (device >>> 8) & 0xfff;
                        const minor = (device & 0xff) | ((device >>> 12) & 0xfff00);
                        resolve(`${major}:${minor}`);
                    } catch (error) { reject(error); }
                });
        });
    }

    _resolveMount(text, path, device) {
        const lexical = findMount(text, path);
        if (!device || lexical?.device === device)
            return lexical;
        // query_info follows symlinks. Match the target device when the selected
        // path's lexical parent mount belongs to a different filesystem.
        for (const line of text.split('\n')) {
            const fields = line.split(' - ')[0].split(' ');
            if (fields[2] !== device || !fields[4])
                continue;
            const mountPath = fields[4].replace(/\\([0-7]{3})/g,
                (_, code) => String.fromCharCode(parseInt(code, 8)));
            const mount = findMount(line, mountPath);
            if (mount)
                return mount;
        }
        return null;
    }

    _runTask(key, operation, timeoutMs = IO_TIMEOUT_MS) {
        if (this._stopped)
            return Promise.reject(new Error('Monitor stopped'));
        const existing = this._tasks.get(key);
        if (existing)
            return existing.promise;
        if (key.startsWith('disk:') && [...this._tasks.keys()].filter(name => name.startsWith('disk:')).length >= 4)
            return Promise.reject(new Error('Too many pending filesystem queries'));
        const failure = key === 'gpus' ? null : this._retryAfter.get(key);
        if (failure && nowSeconds() < failure.until)
            return Promise.reject(failure.error);
        const task = {timeout: 0, promise: null, reject: null};
        task.promise = new Promise((resolve, reject) => {
            task.reject = reject;
            task.timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
                task.timeout = 0;
                // Late completion must not seed a new delta or revive a cache
                // whose visible result has already been declared unavailable.
                if (key === 'cpu') {
                    this._cpuPrevious = null;
                    this._cpuGeneration++;
                } else if (key === 'cpu-temperature') {
                    this._temperatureAt = -Infinity;
                    this._temperatureGeneration++;
                } else if (key.startsWith('disk:') && this._diskState?.path === key.slice(5)) {
                    this._diskState = null;
                }
                // Keep the unfinished operation registered. A slow/unreachable
                // filesystem must not queue another blocking worker every tick.
                reject(new Error(`${key} sensor timed out`));
                return GLib.SOURCE_REMOVE;
            });
            const finish = () => {
                if (task.timeout)
                    GLib.source_remove(task.timeout);
                task.timeout = 0;
                if (this._tasks.get(key) === task)
                    this._tasks.delete(key);
            };
            Promise.resolve().then(() => {
                if (this._stopped)
                    throw new Error('Monitor stopped');
                return operation();
            }).then(value => {
                finish();
                this._retryAfter.delete(key);
                resolve(value);
            }, error => {
                finish();
                if (!this._stopped && key !== 'gpus') {
                    if (this._retryAfter.size >= 128)
                        this._retryAfter.delete(this._retryAfter.keys().next().value);
                    this._retryAfter.set(key, {until: nowSeconds() + 5, error});
                }
                reject(error);
            });
        });
        this._tasks.set(key, task);
        return task.promise;
    }

    async sample(path = '/', includeGpu = true, options = {}) {
        path = GLib.canonicalize_filename(path, '/');
        const {details = true, includeCpu = true, includeMemory = true, includeDisk = true, refreshInterval = 2} = options;
        if (!includeCpu) {
            this._cpuPrevious = null;
            this._cpuGeneration++;
        }
        if (!includeDisk || !details) {
            if (this._diskState) {
                this._diskState.previous = null;
                this._diskState.details = false;
            }
        }
        if (!includeGpu)
            this._nvidiaSampler.pause();
        const requests = [
            includeCpu ? this._runTask('cpu', () => this._cpu(details)) : Promise.resolve(null),
            includeMemory ? this._runTask('memory', () => this._memory()) : Promise.resolve(null),
            includeGpu ? this._runTask('gpus', () => this._gpu(details, refreshInterval), 3500) : Promise.resolve([]),
            includeDisk ? this._runTask(`disk:${path}`, () => this._disk(path, details)) : Promise.resolve(null),
        ];
        const keys = ['cpu', 'memory', 'gpus', 'disk'];
        const snapshot = {errors: {}};
        const pending = new Set(keys);
        const notify = typeof options.onProgress === 'function' ? options.onProgress : null;
        let progressSource = 0;
        const settled = key => {
            pending.delete(key);
            if (!notify || this._stopped || progressSource || !pending.size)
                return;
            // Batch partial results. Fast samples cancel this before it fires,
            // so the normal path still renders once; slow sensors cannot hide
            // readings that have already completed.
            progressSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PROGRESS_DELAY_MS, () => {
                progressSource = 0;
                if (!this._stopped && pending.size) {
                    try {
                        notify({...snapshot, errors: {...snapshot.errors}, pending: [...pending]});
                    } catch { /* A preview failure must not lose the final result. */ }
                }
                return GLib.SOURCE_REMOVE;
            });
        };
        try {
            await Promise.all(requests.map((request, index) => request.then(value => {
                snapshot[keys[index]] = value;
            }, error => {
                snapshot[keys[index]] = null;
                snapshot.errors[keys[index]] = error?.message ?? String(error);
            }).then(() => settled(keys[index]))));
            return snapshot;
        } finally {
            if (progressSource)
                GLib.source_remove(progressSource);
        }
    }

    async _cpu(details) {
        const generation = this._cpuGeneration;
        const current = parseCpu(await this._readText('/proc/stat'));
        const utilization = generation === this._cpuGeneration ? cpuUsage(this._cpuPrevious, current) : null;
        if (generation === this._cpuGeneration)
            this._cpuPrevious = current;
        if (this._stopped || generation !== this._cpuGeneration)
            return {utilization: null, temperature: null};
        // An optional temperature driver can stall; keep CPU usage available anyway.
        const temperature = !details ? null : nowSeconds() - this._temperatureAt < TEMPERATURE_CACHE_SECONDS
            ? this._temperature
            : await this._runTask('cpu-temperature', () => this._cpuTemperature(), 500).catch(() => null);
        return {utilization, temperature};
    }

    async _cpuTemperature() {
        const generation = this._temperatureGeneration;
        const now = nowSeconds();
        if (now - this._temperatureAt < TEMPERATURE_CACHE_SECONDS)
            return this._temperature;
        if (now - this._temperatureDiscoveryAt >= SENSOR_DISCOVERY_SECONDS) {
            const [devices, zones] = await Promise.all([
                this._children('/sys/class/hwmon').catch(() => []),
                this._children('/sys/class/thermal').catch(() => []),
            ]);
            if (this._stopped || generation !== this._temperatureGeneration)
                return null;
            const paths = await Promise.all([
                ...devices.filter(device => /^hwmon\d+$/.test(device)).map(async device => {
                    const base = `/sys/class/hwmon/${device}`;
                    const name = await this._optionalText(`${base}/name`);
                    if (!CPU_HWMON_NAMES.has(name))
                        return [];
                    const files = await this._children(base).catch(() => []);
                    return files.filter(file => /^temp\d+_input$/.test(file)).map(file => `${base}/${file}`);
                }),
                ...zones.filter(zone => /^thermal_zone\d+$/.test(zone)).map(async zone => {
                    const base = `/sys/class/thermal/${zone}`;
                    const type = await this._optionalText(`${base}/type`);
                    // Thor's cpu-thermal reports CPU_MAX. Match sensor identity,
                    // never zone number or the hottest GPU/SoC/junction sensor.
                    return CPU_THERMAL_TYPES.has(type?.toLowerCase()) ? [`${base}/temp`] : [];
                }),
            ]);
            if (this._stopped || generation !== this._temperatureGeneration)
                return null;
            this._temperaturePaths = paths.flat();
            this._temperatureDiscoveryAt = now;
        }
        const values = (await Promise.all(this._temperaturePaths.map(path => this._optionalText(path))))
            .map(readNumber).filter(value => value !== null && value > 0 && value < 150000);
        if (this._stopped || generation !== this._temperatureGeneration)
            return null;
        this._temperature = values.length ? Math.max(...values) / 1000 : null;
        this._temperatureAt = now;
        return this._temperature;
    }

    async _memory() {
        return parseMemory(await this._readText('/proc/meminfo'));
    }

    async _amdGpus(details) {
        const now = nowSeconds();
        if (now - this._amdDiscoveryAt >= SENSOR_DISCOVERY_SECONDS) {
            const cards = await this._children('/sys/class/drm').catch(() => []);
            if (this._stopped)
                return [];
            const paths = await Promise.all(cards.filter(name => /^card\d+$/.test(name)).sort().map(async card => {
                const base = `/sys/class/drm/${card}/device`;
                if (await this._optionalText(`${base}/vendor`) !== '0x1002')
                    return null;
                const uevent = await this._optionalText(`${base}/uevent`);
                const slot = uevent?.match(/^PCI_SLOT_NAME=(.+)$/m)?.[1];
                return {card, base, deviceId: slot ?? card};
            }));
            if (this._stopped)
                return [];
            this._amdPaths = paths.filter(Boolean);
            this._amdDiscoveryAt = now;
        }
        return Promise.all(this._amdPaths.map(async ({card, base, deviceId}) => {
            const files = details ? ['gpu_busy_percent', 'mem_info_vram_used', 'mem_info_vram_total'] : ['gpu_busy_percent'];
            const [busy, used, total] = await Promise.all(files.map(file => this._optionalText(`${base}/${file}`)));
            const utilization = readNumber(busy);
            const bytes = value => {
                const number = readNumber(value);
                return number !== null && number >= 0 ? number : null;
            };
            return {
                id: card, deviceId, name: `AMD ${card}`,
                utilization: utilization !== null && utilization >= 0 && utilization <= 100 ? utilization : null,
                memoryUsed: details ? bytes(used) : null,
                memoryTotal: details ? bytes(total) : null, temperature: null,
            };
        }));
    }

    async _gpu(details, refreshInterval) {
        // A negative discovery result is valid for the same TTL as a positive
        // one; do not create a task/deadline per tick on NVIDIA-only machines.
        const noAmd = this._amdPaths.length === 0 && nowSeconds() - this._amdDiscoveryAt < SENSOR_DISCOVERY_SECONDS;
        const results = await Promise.allSettled([
            this._nvidiaSampler.sample(refreshInterval),
            noAmd ? Promise.resolve([]) : this._runTask('amd-gpus', () => this._amdGpus(details), 750),
        ]);
        if (this._stopped)
            throw new Error('Monitor stopped');
        const current = new Map();
        results.forEach((result, backend) => {
            if (result.status !== 'fulfilled')
                return;
            const source = backend === 0 ? 'nvidia' : 'amd';
            result.value.forEach((row, index) => {
                const key = `${source}:${row.uuid ?? row.deviceId ?? row.id ?? index}`;
                if (!this._gpuSlots.has(key) && this._gpuSlots.size >= 256)
                    return;
                const value = {...row, source, unavailable: false};
                this._gpuSlots.set(key, {id: value.id, uuid: value.uuid, deviceId: value.deviceId, name: value.name, source});
                current.set(key, value);
            });
        });
        if (!this._gpuSlots.size && results.some(result => result.status === 'rejected'))
            throw new Error('GPU query failed; check the driver and nvidia-smi');
        // Preserve selected indexes through a backend failure/disconnection.
        // Never silently substitute another card's utilization for that GPU.
        return [...this._gpuSlots].map(([key, device]) => current.get(key) ?? {
            ...device, utilization: null, memoryUsed: null, memoryTotal: null,
            temperature: null, unavailable: true,
        });
    }

    async _disk(path, details) {
        const now = nowSeconds();
        if (this._diskState?.path !== path)
            this._diskState = {path, capacity: null, capacityAt: -Infinity, details: false,
                mount: null, mountAt: -Infinity, blockAvailable: null, previous: null};
        const state = this._diskState;
        // Refresh once when opening details, then cache capacity independently
        // of the live I/O counters. Avoid statfs on every open-menu refresh.
        if ((details && !state.details) || now - state.capacityAt >= CAPACITY_CACHE_SECONDS) {
            const info = await this._filesystemInfo(path);
            if (this._stopped)
                throw new Error('Monitor stopped');
            const total = info.get_attribute_uint64('filesystem::size');
            const free = info.get_attribute_uint64('filesystem::free');
            if (!Number.isFinite(total) || !Number.isFinite(free) || total <= 0 || free < 0 || free > total)
                throw new Error('Filesystem capacity unavailable');
            state.capacity = {total, free, used: total - free, percent: clamp((total - free) / total * 100)};
            state.capacityAt = now;
        }
        state.details = details;
        let rates = {read: null, write: null, busy: null};
        if (details) {
            if (now - state.mountAt >= MOUNT_CACHE_SECONDS) {
                const [mounts, device] = await Promise.all([
                    this._readText('/proc/self/mountinfo'), this._pathDevice(path).catch(() => null),
                ]);
                if (this._stopped)
                    throw new Error('Monitor stopped');
                const mount = this._resolveMount(mounts, path, device);
                if (state.mount?.id !== mount?.id || state.mount?.device !== mount?.device)
                    state.previous = null;
                state.mount = mount;
                state.mountAt = now;
                state.blockAvailable = null;
            }
            const mount = state.mount;
            const hadPrevious = state.previous !== null;
            const counters = mount && state.blockAvailable !== false ? await this._optionalText(`/sys/dev/block/${mount.device}/stat`) : null;
            const name = mount?.source?.split('/').pop() ?? '';
            const current = counters === null ? null : parseBlockStat(counters, mount.device, name);
            const time = nowSeconds();
            rates = diskRates(state.previous?.counters, current, time - (state.previous?.time ?? time));
            state.previous = current ? {counters: current, time} : null;
            state.blockAvailable = current !== null;
            if (!current && hadPrevious)
                state.mountAt = -Infinity;
        } else {
            state.previous = null;
        }
        return {path, mount: state.mount, ...state.capacity, ...rates};
    }
}
