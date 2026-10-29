import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const loop = new GLib.MainLoop(null, false);
let failed = false;
// From the repository root: gjs -m tools/benchmark.js [module-path] [samples] [gpu] [details] [delay-ms]
const moduleUrl = Gio.File.new_for_commandline_arg(ARGV[0] ?? `${GLib.get_current_dir()}/gnome-system-monitor/monitor.js`).get_uri();
const iterations = Number(ARGV[1] ?? 30);
const gpu = ARGV[2] === 'true';
const details = ARGV[3] === 'true';
const delayMs = Number(ARGV[4] ?? 0);
const timings = {};
const elapsed = [];
const quantile = (values, q) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))];
const pause = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));
const read = path => new TextDecoder().decode(Gio.File.new_for_path(path).load_contents(null)[1]);

async function run() {
    const {SystemMonitor} = await import(moduleUrl);
    const monitor = new SystemMonitor();
    for (const name of ['_cpu', '_cpuTemperature', '_memory', '_gpu', '_nvidiaGpus', '_disk']) {
        if (typeof monitor[name] !== 'function') continue;
        const original = monitor[name].bind(monitor);
        timings[name] = [];
        monitor[name] = async (...args) => {
            const start = GLib.get_monotonic_time();
            try { return await original(...args); }
            finally { timings[name].push((GLib.get_monotonic_time() - start) / 1000); }
        };
    }
    let last;
    try {
        // Exclude initial device discovery from steady-state measurements.
        for (let i = 0; i < 2; i++) await monitor.sample('/', gpu, {details});
        for (const values of Object.values(timings)) values.length = 0;
        for (let i = 0; i < iterations; i++) {
            const start = GLib.get_monotonic_time();
            last = await monitor.sample('/', gpu, {details});
            elapsed.push((GLib.get_monotonic_time() - start) / 1000);
            if (delayMs) await pause(delayMs);
        }
        print(JSON.stringify({module: moduleUrl, iterations, gpu, details,
            meanMs: elapsed.reduce((a, b) => a + b, 0) / elapsed.length,
            medianMs: quantile(elapsed, 0.5), p95Ms: quantile(elapsed, 0.95),
            methods: Object.fromEntries(Object.entries(timings).map(([name, values]) => [name,
                {calls: values.length, meanMs: values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0}])),
            memory: read('/proc/self/status').match(/^Vm(?:RSS|HWM):.+$/gm),
            errors: last.errors}));
    } finally { monitor.stop(); }
}
run().catch(error => { failed = true; printerr(error.stack); }).finally(() => loop.quit());
loop.run();
if (failed) imports.system.exit(1);
