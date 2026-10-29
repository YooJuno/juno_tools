// Deterministic collector policy tests; no GPU or filesystem mutation required.
import GLib from 'gi://GLib';
import {SystemMonitor} from '../gnome-system-monitor/monitor.js';

const loop = new GLib.MainLoop(null, false);
let failed = false;
const delay = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));
function check(condition, message) {
    if (!condition)
        throw new Error(message);
}

class FakeMonitor extends SystemMonitor {
    constructor() {
        super();
        this._nvidiaSampler.stop();
        this.calls = [];
        this.cpuTicks = 0;
        this.diskTicks = 0;
        this.pauses = 0;
        this.gpuInterval = null;
        this._nvidiaSampler = {
            stop() {},
            pause: () => this.pauses++,
            sample: async interval => { this.gpuInterval = interval; return []; },
        };
    }

    async _readText(path) {
        this.calls.push(`read:${path}`);
        if (path === '/proc/stat') {
            this.cpuTicks++;
            return `cpu ${100 + this.cpuTicks * 10} 0 50 ${1000 + this.cpuTicks * 10} 0 0 0 0 0 0`;
        }
        if (path === '/proc/meminfo')
            return 'MemTotal: 1000 kB\nMemAvailable: 600 kB\nSwapTotal: 200 kB\nSwapFree: 150 kB';
        if (path === '/proc/self/mountinfo')
            return '30 1 259:2 / / rw - ext4 /dev/nvme0n1p2 rw\n40 30 8:1 / /media/Drive rw - ext4 /dev/sda1 rw';
        if (path === '/sys/dev/block/259:2/stat' || path === '/sys/dev/block/8:1/stat') {
            this.diskTicks++;
            return `1 0 ${100 + this.diskTicks * 2} 5 3 0 ${200 + this.diskTicks * 4} 4 0 ${100 + this.diskTicks} 120`;
        }
        if (path === '/sys/class/hwmon/hwmon0/name')
            return 'coretemp';
        if (path === '/sys/class/hwmon/hwmon0/temp1_input')
            return '60000';
        if (path === '/sys/class/hwmon/hwmon0/temp2_input')
            return '70000';
        if (path === '/sys/class/drm/card0/device/vendor')
            return '0x1002';
        if (path === '/sys/class/drm/card0/device/uevent')
            return 'DRIVER=amdgpu\nPCI_SLOT_NAME=0000:04:00.0';
        if (path === '/sys/class/drm/card0/device/gpu_busy_percent')
            return '33';
        if (path === '/sys/class/drm/card0/device/mem_info_vram_used')
            return '1024';
        if (path === '/sys/class/drm/card0/device/mem_info_vram_total')
            return '4096';
        throw new Error(`Unexpected read: ${path}`);
    }

    async _children(path) {
        this.calls.push(`children:${path}`);
        if (path === '/sys/class/hwmon')
            return ['hwmon0'];
        if (path === '/sys/class/hwmon/hwmon0')
            return ['temp1_input', 'temp2_input'];
        if (path === '/sys/class/drm')
            return ['card0'];
        throw new Error(`Unexpected enumeration: ${path}`);
    }

    async _pathDevice(path) {
        this.calls.push(`device:${path}`);
        return path === '/alias' ? '8:1' : '259:2';
    }

    async _filesystemInfo(path) {
        this.calls.push(`filesystem:${path}`);
        if (path === '/missing')
            throw new Error('Missing filesystem');
        if (path === '/hung')
            return new Promise(() => {});
        return {get_attribute_uint64: key => key === 'filesystem::size' ? 10000 : 4000};
    }

    count(value) {
        return this.calls.filter(call => call === value).length;
    }
}

async function policies() {
    const monitor = new FakeMonitor();
    try {
        const hidden = await monitor.sample('/', false, {details: false, includeCpu: false, includeMemory: false, includeDisk: false});
        check(monitor.calls.length === 0, 'Hidden sensors still perform I/O');
        check(hidden.cpu === null && hidden.memory === null && hidden.disk === null && hidden.gpus.length === 0, 'Hidden sensors have bogus values');
        check(Object.keys(hidden.errors).length === 0, 'Hidden sensors report false errors');
        const first = await monitor.sample('/', false, {details: false});
        const second = await monitor.sample('/', false, {details: false});
        check(first.cpu.utilization === null && Number.isFinite(second.cpu.utilization), 'CPU delta collection changed');
        check(second.cpu.temperature === null && second.disk.read === null, 'Closed menu exposes stale detail readings');
        check(monitor.count('filesystem:/') === 1, 'Closed-menu capacity is queried every tick');
        check(!monitor.calls.some(call => call.includes('hwmon') || call.includes('mountinfo') || call.includes('/stat') && !call.endsWith('/proc/stat')), 'Closed menu polls optional sensors');
        const detailed = await monitor.sample('/', false, {details: true});
        check(detailed.cpu.temperature === 70, 'Highest CPU temperature missing');
        check(detailed.disk.read === null, 'Opening menu reports an I/O rate without a baseline');
        const next = await monitor.sample('/', false, {details: true});
        check(next.disk.read > 0, 'Detailed disk delta missing');
        check(monitor.count('read:/proc/self/mountinfo') === 1, 'Mount map is reparsed every tick');
        check(monitor.count('read:/sys/class/hwmon/hwmon0/temp1_input') === 1, 'Temperature cache is unused');
        await monitor.sample('/', false, {details: false});
        const reopened = await monitor.sample('/', false, {details: true});
        check(reopened.disk.read === null, 'I/O baseline spans the entire closed-menu period');
        await monitor.sample('/', false, {details: false, includeCpu: false});
        check((await monitor.sample('/', false, {details: false})).cpu.utilization === null, 'CPU baseline survives skipped collection');
        const missing = await monitor.sample('/missing', false, {details: false});
        check(missing.disk === null && missing.errors.disk && missing.memory.total > 0, 'Filesystem failure is not isolated');
        await monitor.sample('/missing', false, {details: false});
        check(monitor.count('filesystem:/missing') === 1, 'Failed filesystem has no retry delay');
        check((await monitor.sample('/', false, {details: false})).disk.total > 0, 'Changing the path is blocked by a previous path failure');
        monitor.pause();
        check(monitor._cpuPrevious === null && monitor._diskState === null, 'Paused monitoring retains stale delta baselines');
    } finally {
        monitor.stop();
    }
}

async function jetsonCpuTemperature() {
    const monitor = new FakeMonitor();
    // Thor exposes the CPU_MAX sensor through cpu-thermal, independently of
    // hwmon. Zone numbers are discovery order, not a stable sensor identity.
    const sensors = new Map([
        ['0', ['gpu-thermal', '99000']],
        ['2', ['soc012-thermal', '98000']],
        ['3', ['tj-thermal', '97000']],
        ['7', ['cpu-thermal', '53125']],
        ['8', ['CPU-therm', '51000']],
        ['9', ['cpu_thermal', 'N/A']],
        ['10', ['board-thermal', '96000']],
    ]);
    const read = monitor._readText.bind(monitor);
    monitor._readText = async path => {
        const match = path.match(/^\/sys\/class\/thermal\/thermal_zone(\d+)\/(type|temp)$/);
        if (match) {
            monitor.calls.push(`read:${path}`);
            const sensor = sensors.get(match[1]);
            const value = sensor?.[match[2] === 'type' ? 0 : 1];
            if (value === null || value === undefined)
                throw new Error('Sensor is unavailable');
            return value;
        }
        if (path === '/sys/class/hwmon/hwmon0/name') {
            monitor.calls.push(`read:${path}`);
            return 'ina3221'; // An unrelated hwmon sensor must be ignored.
        }
        return read(path);
    };
    const children = monitor._children.bind(monitor);
    let noHwmon = false;
    monitor._children = async path => {
        if (path === '/sys/class/thermal') {
            monitor.calls.push(`children:${path}`);
            return [...sensors.keys()].map(index => `thermal_zone${index}`).concat('cooling_device0');
        }
        if (noHwmon && path === '/sys/class/hwmon')
            throw new Error('No hwmon interface');
        return children(path);
    };
    try {
        check(await monitor._cpuTemperature() === 53.125, 'Jetson CPU thermal-zone temperature missing');
        check(monitor._temperaturePaths.length === 3, 'GPU, SoC or junction sensor selected as CPU temperature');
        for (const index of ['0', '2', '3', '10'])
            check(monitor.count(`read:/sys/class/thermal/thermal_zone${index}/temp`) === 0,
                'An unrelated thermal sensor is polled');
        const calls = monitor.calls.length;
        check(await monitor._cpuTemperature() === 53.125 && monitor.calls.length === calls,
            'Thermal-zone temperature bypasses the five-second cache');
        monitor._temperatureAt = -Infinity;
        sensors.get('7')[1] = '54250';
        check(await monitor._cpuTemperature() === 54.25, 'Thermal-zone reading does not refresh');
        check(monitor.count('children:/sys/class/thermal') === 1,
            'Thermal-zone discovery bypasses the sixty-second cache');
        monitor._temperatureAt = -Infinity;
        sensors.get('7')[1] = null;
        sensors.get('8')[1] = '-256000';
        check(await monitor._cpuTemperature() === null,
            'Unreadable/invalid CPU sensors reuse an old value or another component temperature');
        noHwmon = true;
        monitor._temperatureAt = monitor._temperatureDiscoveryAt = -Infinity;
        sensors.get('7')[1] = '42000';
        check(await monitor._cpuTemperature() === 42, 'Thermal zones depend on hwmon being available');
    } finally { monitor.stop(); }
}

async function gpuPolicy() {
    const monitor = new FakeMonitor();
    try {
        const options = {details: false, includeCpu: false, includeMemory: false, includeDisk: false, refreshInterval: 7};
        const compact = await monitor.sample('/', true, options);
        check(monitor.gpuInterval === 7, 'GPU stream did not receive the requested interval');
        check(compact.gpus[0].utilization === 33 && compact.gpus[0].memoryUsed === null, 'Compact AMD data is wrong');
        check(compact.gpus[0].deviceId === '0000:04:00.0', 'AMD identity is tied to a changeable card index');
        check(!monitor.calls.some(call => call.includes('mem_info_vram')), 'Closed menu polls AMD VRAM');
        const detailed = await monitor.sample('/', true, {...options, details: true});
        check(detailed.gpus[0].memoryUsed === 1024 && detailed.gpus[0].memoryTotal === 4096, 'Detailed AMD VRAM is missing');
        await monitor.sample('/', false, options);
        check(monitor.pauses === 1, 'Turning off GPU does not pause the NVIDIA process');
    } finally {
        monitor.stop();
    }
}

async function hungFilesystem() {
    const monitor = new FakeMonitor();
    try {
        const start = GLib.get_monotonic_time();
        const result = await monitor.sample('/hung', false, {details: false});
        check((GLib.get_monotonic_time() - start) / 1000 < 3500, 'Hung filesystem blocks the entire update');
        check(result.errors.disk?.includes('timed out') && result.memory.total > 0, 'Hung filesystem hides healthy sensors');
        for (let index = 0; index < 3; index++)
            await monitor.sample('/hung', false, {details: false});
        check(monitor.count('filesystem:/hung') === 1, 'Hung filesystem queues duplicate workers');
    } finally {
        monitor.stop();
    }
    check(monitor._tasks.size === 0, 'Stopped monitor retains pending task timers');
}

async function optionalSensorTimeout() {
    const monitor = new FakeMonitor();
    let attempts = 0;
    monitor._cpuTemperature = () => { attempts++; return new Promise(() => {}); };
    try {
        const options = {includeMemory: false, includeDisk: false};
        const first = await monitor.sample('/', false, options);
        const second = await monitor.sample('/', false, options);
        check(first.cpu.temperature === null && Number.isFinite(second.cpu.utilization), 'Hung temperature sensor breaks CPU usage');
        check(attempts === 1, 'Hung optional sensor queues duplicate workers');
    } finally {
        monitor.stop();
    }
}

async function symlinkDevice() {
    const monitor = new FakeMonitor();
    try {
        const compact = await monitor.sample('/alias', false, {details: false});
        check(compact.disk.total > 0 && !monitor.calls.some(call => call.startsWith('device:') || call.includes('mountinfo')), 'Closed-menu symlink path performs mount discovery');
        const first = await monitor.sample('/alias', false, {details: true});
        check(first.disk.mount.device === '8:1' && first.disk.mount.source === '/dev/sda1', 'Symlink path uses the lexical parent block device');
        check(monitor.count('read:/sys/dev/block/8:1/stat') === 1 && monitor.count('read:/sys/dev/block/259:2/stat') === 0, 'Symlink I/O reads the wrong device');
        await monitor.sample('/alias', false, {details: true});
        check(monitor.count('device:/alias') === 1 && monitor.count('read:/proc/self/mountinfo') === 1, 'Symlink mount discovery is not cached');
    } finally {
        monitor.stop();
    }
}

async function pendingPathLimit() {
    const monitor = new FakeMonitor();
    monitor._filesystemInfo = path => { monitor.calls.push(`filesystem:${path}`); return new Promise(() => {}); };
    const options = {details: false, includeCpu: false, includeMemory: false};
    const pending = [];
    for (let index = 0; index < 4; index++)
        pending.push(monitor.sample(`/slow-${index}`, false, options));
    await delay(10);
    const extra = await monitor.sample('/slow-4', false, {details: false});
    check(extra.errors.disk?.includes('Too many pending') && extra.cpu && extra.memory.total > 0, 'Pending filesystem limit blocks healthy sensors');
    check(monitor.calls.filter(call => call.startsWith('filesystem:')).length === 4, 'Changing paths queues unbounded blocked workers');
    monitor.stop();
    await Promise.all(pending);
}

async function hungAmdIsolation() {
    const monitor = new FakeMonitor();
    let attempts = 0;
    monitor._amdGpus = () => { attempts++; return new Promise(() => {}); };
    monitor._nvidiaSampler.sample = async () => [{id: '0', name: 'NVIDIA test', utilization: 22}];
    try {
        const options = {details: false, includeCpu: false, includeMemory: false, includeDisk: false};
        const first = await monitor.sample('/', true, options);
        const second = await monitor.sample('/', true, options);
        check(first.gpus[0].name === 'NVIDIA test' && second.gpus[0].utilization === 22, 'Hung AMD backend hides healthy NVIDIA readings');
        check(attempts === 1, 'Hung AMD backend queues duplicate sensor reads');
    } finally {
        monitor.stop();
    }
}

async function concurrentAndStop() {
    const monitor = new FakeMonitor();
    let resolveRead;
    let attempts = 0;
    monitor._readText = () => { attempts++; return new Promise(resolve => { resolveRead = resolve; }); };
    const options = {details: false, includeMemory: false, includeDisk: false};
    const first = monitor.sample('/', false, options);
    const second = monitor.sample('/', false, options);
    await delay(10);
    check(attempts === 1, 'Concurrent requests duplicate the same sensor read');
    resolveRead('cpu 100 0 0 1000 0 0 0 0');
    await Promise.all([first, second]);
    const pending = monitor.sample('/', false, options);
    await delay(10);
    monitor.stop();
    await pending;
    const before = attempts;
    await monitor.sample('/', false, options);
    check(attempts === before, 'Stopped monitor starts new I/O');
    check(monitor._tasks.size === 0 && monitor._files.size === 0, 'Stop does not release task/file caches');
    monitor.stop();
}

async function lateResultsAndStop() {
    const stopped = new SystemMonitor();
    stopped.stop();
    await stopped._readText('/proc/stat').catch(() => null);
    check(stopped._files.size === 0, 'A late caller recreates file objects after stop');

    const cpu = new FakeMonitor();
    let releaseCpu;
    cpu._readText = () => new Promise(resolve => { releaseCpu = resolve; });
    await cpu._runTask('cpu', () => cpu._cpu(false), 10).catch(() => null);
    releaseCpu('cpu 100 0 0 1000 0 0 0 0');
    await delay(10);
    check(cpu._cpuPrevious === null, 'Expired CPU read seeds the next utilization delta');
    cpu.stop();

    const disk = new FakeMonitor();
    let releaseDisk;
    disk._filesystemInfo = () => new Promise(resolve => { releaseDisk = resolve; });
    await disk._runTask('disk:/', () => disk._disk('/', false), 10).catch(() => null);
    releaseDisk({get_attribute_uint64: key => key === 'filesystem::size' ? 10000 : 4000});
    await delay(10);
    check(disk._diskState === null, 'Expired filesystem read revives its invalidated cache');
    disk.stop();

    const temperature = new FakeMonitor();
    const releaseDiscovery = [];
    temperature._children = () => new Promise(resolve => { releaseDiscovery.push(resolve); });
    const pending = temperature._cpuTemperature();
    temperature.stop();
    for (const release of releaseDiscovery)
        release(['hwmon0', 'thermal_zone7']);
    await pending;
    check(temperature.calls.length === 0 && temperature._temperaturePaths.length === 0,
        'Stopped discovery launches more I/O or revives its cache');
}

async function gpuIdentityAndValidation() {
    const monitor = new FakeMonitor();
    let failNvidia = false;
    let failAmd = false;
    monitor._nvidiaSampler.sample = async () => {
        if (failNvidia) throw new Error('NVIDIA offline');
        return [{id: '0', name: 'Selected NVIDIA', utilization: 22}];
    };
    monitor._amdGpus = async () => {
        if (failAmd) throw new Error('AMD offline');
        return [{id: 'card0', name: 'Other AMD', utilization: 77}];
    };
    try {
        const first = await monitor._gpu(false, 2);
        check(first[0].name === 'Selected NVIDIA' && first[1].name === 'Other AMD', 'Initial device order changed');
        failNvidia = true;
        const missing = await monitor._gpu(false, 2);
        check(missing[0].name === 'Selected NVIDIA' && missing[0].unavailable && missing[0].utilization === null,
            'A backend failure silently substitutes another GPU');
        check(missing[1].utilization === 77, 'Healthy AMD reading was lost');
        failNvidia = false;
        const recovered = await monitor._gpu(false, 2);
        check(recovered[0].utilization === 22 && !recovered[0].unavailable, 'Recovered GPU did not regain its own slot');
        failAmd = true;
        const amdMissing = await monitor._gpu(false, 2);
        check(amdMissing[0].utilization === 22 && amdMissing[1].unavailable, 'AMD failure changed GPU selection');
    } finally { monitor.stop(); }

    const malformed = new FakeMonitor();
    const originalRead = malformed._readText.bind(malformed);
    malformed._readText = path => path.endsWith('gpu_busy_percent') ? Promise.resolve('101') :
        path.endsWith('mem_info_vram_used') ? Promise.resolve('-5') : originalRead(path);
    try {
        const [gpu] = await malformed._amdGpus(true);
        check(gpu.utilization === null && gpu.memoryUsed === null, 'Corrupt AMD readings appear as real utilization/bytes');
    } finally { malformed.stop(); }

    const renumbered = new FakeMonitor();
    let rows = [{id: '0', uuid: 'GPU-A', name: 'Selected A', utilization: 11},
        {id: '1', uuid: 'GPU-B', name: 'Other B', utilization: 22}];
    renumbered._nvidiaSampler.sample = async () => rows;
    renumbered._amdGpus = async () => [];
    try {
        await renumbered._gpu(false, 2);
        rows = [{id: '0', uuid: 'GPU-B', name: 'Other B', utilization: 77}];
        const after = await renumbered._gpu(false, 2);
        check(after[0].name === 'Selected A' && after[0].unavailable && after[1].utilization === 77,
            'NVIDIA driver reindexing silently changes the selected physical GPU');
    } finally { renumbered.stop(); }
}

async function run() {
    await policies();
    await jetsonCpuTemperature();
    await gpuPolicy();
    await hungFilesystem();
    await optionalSensorTimeout();
    await symlinkDevice();
    await pendingPathLimit();
    await hungAmdIsolation();
    await concurrentAndStop();
    await lateResultsAndStop();
    await gpuIdentityAndValidation();
    const monitor = new FakeMonitor();
    for (let index = 0; index < 150; index++)
        monitor._file(`/unused/${index}`);
    check(monitor._files.size <= 128, 'Preference path changes grow the file cache without limit');
    monitor.stop();
    print('Monitor regressions passed: CPU thermal zones (including Jetson Thor), lazy collection, caching, failure isolation, GPU pause, deadlines, symlink devices, pending-query limits, coalescing and cleanup.');
}
const guard = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 15, () => {
    failed = true;
    printerr('Monitor regression test timed out');
    loop.quit();
    return GLib.SOURCE_REMOVE;
});
run().catch(error => {
    failed = true;
    printerr(`${error.message}\n${error.stack}`);
}).finally(() => {
    if (GLib.MainContext.default().find_source_by_id(guard))
        GLib.source_remove(guard);
    loop.quit();
});
loop.run();
if (failed)
    imports.system.exit(1);
