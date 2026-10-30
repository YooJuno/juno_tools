// Uses real CPU/RAM/storage reads and a deliberately unresponsive GPU fixture.
// No driver process or GPU/power configuration is changed.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const loop = new GLib.MainLoop(null, false);
let failed = false;
const nowMs = () => GLib.get_monotonic_time() / 1000;
const moduleUrl = Gio.File.new_for_commandline_arg(ARGV[0] ?? 'gnome-system-monitor/monitor.js').get_uri();
async function run() {
    const {SystemMonitor} = await import(moduleUrl);
    const monitor = new SystemMonitor();
    monitor._nvidiaSampler.stop();
    monitor._nvidiaSampler = {sample: () => new Promise(() => {}), pause() {}, stop() {}};
    const start = nowMs();
    let firstHealthyMs = null;
    let previews = 0;
    const ready = sample => {
        if (sample.memory?.total > 0 && sample.disk?.total > 0 && firstHealthyMs === null)
            firstHealthyMs = nowMs() - start;
    };
    try {
        const final = await monitor.sample('/', true, {details: false, onProgress: sample => {
            previews++;
            ready(sample);
        }});
        ready(final);
        print(JSON.stringify({module: moduleUrl, firstHealthyMs, completeMs: nowMs() - start,
            previews, gpuError: final.errors.gpus ?? null}));
    } finally { monitor.stop(); }
}
run().catch(error => { failed = true; printerr(error.stack); }).finally(() => loop.quit());
loop.run();
if (failed) imports.system.exit(1);
