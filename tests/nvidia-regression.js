// Exercises real pipes/processes, including broken-driver and cancellation paths.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {NvidiaSampler} from '../gnome-system-monitor/nvidia.js';

const loop = new GLib.MainLoop(null, false);
const directory = GLib.dir_make_tmp('juno-nvidia-test-XXXXXX');
let serial = 0;
let failed = false;
const files = [];
const samplers = [];
const pause = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));
function check(condition, message) { if (!condition) throw new Error(message); }
async function rejects(promise, pattern) {
    let error;
    try { await promise; } catch (reason) { error = reason; }
    check(error && pattern.test(error.message), `Expected ${pattern}, got ${error?.message}`);
}
function program(body) {
    const file = `${directory}/fixture-${serial++}.py`;
    GLib.file_set_contents(file, `#!/usr/bin/env python3\nimport sys, time\n${body}\n`);
    Gio.File.new_for_path(file).set_attribute_uint32('unix::mode', 0o700, Gio.FileQueryInfoFlags.NONE, null);
    files.push(file);
    return file;
}
function sampler(file, options = {}) {
    const instance = new NvidiaSampler(file, {startupTimeoutMs: 1000, retryDelayMs: 500, ...options});
    samplers.push(instance);
    return instance;
}
function exists(pid) { return Gio.File.new_for_path(`/proc/${pid}`).query_exists(null); }
const row = '0, NVIDIA test GPU, 12, 64, 8192, 45, GPU-test-0';

async function run() {
    const absent = sampler(null);
    check((await absent.sample()).length === 0, 'No NVIDIA command must mean no NVIDIA devices');
    absent.stop();
    await rejects(absent.sample(), /stopped/);

    const starts = `${directory}/starts`;
    files.push(starts);
    const healthy = program(`with open(${JSON.stringify(starts)}, 'a') as f: f.write('start\\n')
sys.stdout.write('Xid diagnostic, not a GPU row\\n'); sys.stdout.flush()
data = (${JSON.stringify(`${row}\n1, NVIDIA second GPU, 34, 128, 4096, 50, GPU-test-1\n`)}).encode()
sys.stdout.buffer.write(data[:15]); sys.stdout.flush()
time.sleep(0.02)
sys.stdout.buffer.write(data[15:]); sys.stdout.flush()
while True: time.sleep(60)`);
    const cached = sampler(healthy);
    const first = await cached.sample(2);
    check(first.length === 2 && first[0].id === '0' && first[1].id === '1', 'Fragmented multi-GPU frame was not parsed');
    const firstPid = cached._run.process.get_identifier();
    for (let i = 0; i < 50; i++)
        check((await cached.sample(2))[1].utilization === 34, 'Cached GPU data changed unexpectedly');
    check(cached._run.process.get_identifier() === firstPid, 'Each refresh started another process');
    check(new TextDecoder().decode(GLib.file_get_contents(starts)[1]).trim() === 'start', 'Duplicate process launch');
    await cached.sample(3);
    const secondPid = cached._run.process.get_identifier();
    check(firstPid !== secondPid, 'Changed interval did not restart the loop');
    await pause(50);
    check(!exists(firstPid), 'Replaced NVIDIA process leaked');
    cached.pause();
    await pause(50);
    check(!exists(secondPid), 'Turning off GPU did not terminate the process');

    let clock = 1000;
    const silent = sampler(program('time.sleep(60)'), {startupTimeoutMs: 100, now: () => clock});
    await rejects(silent.sample(), /timed out/);
    check(silent._run === null, 'Silent process was retained after timeout');
    const retryAt = silent._nextRetry;
    await rejects(silent.sample(), /timed out/);
    check(silent._nextRetry === retryAt, 'Failure backoff was ignored');
    clock += 1000;
    await rejects(silent.sample(), /timed out/);
    check(silent._nextRetry > retryAt, 'Failed NVIDIA query did not recover after retry delay');

    const stale = sampler(program(`print(${JSON.stringify(row)}, flush=True)\ntime.sleep(60)`), {now: () => clock});
    await stale.sample(1);
    const stalePid = stale._run.process.get_identifier();
    clock += 3001;
    await rejects(stale.sample(1), /timed out/);
    await pause(50);
    check(!exists(stalePid), 'Stalled process was not killed');

    const oversized = sampler(program("sys.stdout.write('X' * 20000); sys.stdout.flush()\ntime.sleep(60)"));
    await rejects(oversized.sample(), /large/);

    const cancelled = sampler(program('time.sleep(60)'));
    const pending = cancelled.sample();
    const cancelledPid = cancelled._run.process.get_identifier();
    cancelled.stop();
    await rejects(pending, /paused/);
    await pause(50);
    check(!exists(cancelledPid), 'Cancellation leaked a process');

    const exits = sampler(program(`print(${JSON.stringify(row)}, flush=True)\ntime.sleep(0.1)`));
    await exits.sample();
    await pause(200);
    await rejects(exits.sample(), /closed|exited/);

    let launches = 0;
    const unreaped = sampler('fixture', {spawn: () => {
        launches++;
        return {
            get_stdout_pipe: () => Gio.MemoryInputStream.new_from_bytes(new GLib.Bytes(new TextEncoder().encode(`${row}\n`))),
            wait_async() {}, // Simulate a killed task stuck in kernel I/O.
            force_exit() {},
        };
    }});
    for (let index = 0; index < 4; index++) {
        await unreaped.sample();
        unreaped.pause();
    }
    await rejects(unreaped.sample(), /still stopping/);
    check(launches === 4, 'Unreaped driver processes accumulate without a limit');
    print('NVIDIA regression tests passed: process reuse, chunking, multiple GPUs, diagnostics, interval changes, backoff, staleness, bounded output and shutdown.');
}
const guard = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 20, () => {
    failed = true;
    printerr('NVIDIA regression test timed out');
    for (const instance of samplers) instance.stop();
    loop.quit();
    return GLib.SOURCE_REMOVE;
});
run().catch(error => { failed = true; printerr(`${error.message}\n${error.stack}`); }).finally(async () => {
    if (GLib.MainContext.default().find_source_by_id(guard))
        GLib.source_remove(guard);
    for (const instance of samplers) instance.stop();
    await pause(50);
    for (const file of files) {
        try { Gio.File.new_for_path(file).delete(null); } catch { /* Fixture may not have started. */ }
    }
    Gio.File.new_for_path(directory).delete(null);
    loop.quit();
});
loop.run();
if (failed) imports.system.exit(1);
