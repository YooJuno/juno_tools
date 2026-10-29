// Run with: gjs -m tests/collector-smoke.js
import GLib from 'gi://GLib';
import {SystemMonitor} from '../gnome-system-monitor/monitor.js';

const loop = new GLib.MainLoop(null, false);
let failed = false;
function check(condition, message) {
    if (!condition)
        throw new Error(message);
}
async function run() {
    const monitor = new SystemMonitor();
    try {
        const first = await monitor.sample('/', true);
        check(first.memory?.total > 0, 'Memory data missing');
        check(first.disk?.total > 0, 'Filesystem data missing');
        check(first.cpu?.utilization === null, 'First CPU sample should be unavailable');
        await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        }));
        const second = await monitor.sample('/', false);
        check(Number.isFinite(second.cpu?.utilization) && second.cpu.utilization >= 0 && second.cpu.utilization <= 100, 'CPU delta missing');
        check(second.gpus.length === 0, 'GPU polling was not disabled');
        const invalid = await monitor.sample('/__juno_monitor_missing_path__', false);
        check(invalid.disk === null && invalid.errors.disk, 'Invalid path must fail independently');
        check(invalid.memory?.total > 0, 'Disk failure must not break memory collection');
        print(JSON.stringify({cpu: second.cpu, memoryPercent: second.memory.percent,
            gpus: first.gpus?.map(({uuid, ...gpu}) => gpu), gpuError: first.errors.gpus ?? null,
            disk: {source: second.disk.mount?.source, percent: second.disk.percent, read: second.disk.read, write: second.disk.write}}));
    } finally {
        monitor.stop();
    }
    const cancelled = new SystemMonitor();
    const pending = cancelled.sample('/', true);
    cancelled.stop();
    await pending;
    print('Collector smoke test passed (including cancellation and independent failures).');
}
run().catch(error => {
    failed = true;
    printerr(error.stack);
}).finally(() => loop.quit());
loop.run();
if (failed)
    imports.system.exit(1);
