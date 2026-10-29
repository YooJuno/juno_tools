import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {parseNvidia} from './metrics.js';

const nowMs = () => GLib.get_monotonic_time() / 1000;

// One nvidia-smi process amortizes NVML initialization across samples. It exists
// only while GPU monitoring is enabled; no service or driver settings are changed.
export class NvidiaSampler {
    constructor(executable, options = {}) {
        this._executable = executable;
        this._now = options.now ?? nowMs;
        this._startupMs = options.startupTimeoutMs ?? 3000;
        this._retryMs = options.retryDelayMs ?? 30000;
        this._minimumStaleMs = options.minimumStaleMs ?? 3000;
        this._spawn = options.spawn ?? (argv => Gio.Subprocess.new(argv,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE));
        this._children = new Set();
        this._run = null;
        this._nextRetry = 0;
        this._lastError = null;
        this._stopped = false;
    }

    async sample(interval = 2) {
        if (this._stopped)
            throw new Error('GPU monitor has stopped');
        if (!this._executable)
            return [];
        interval = Number.isFinite(interval) ? Math.max(1, Math.min(30, Math.round(interval))) : 2;
        if (this._run && this._run.interval !== interval)
            this.pause();
        if (this._run && this._run.lastOutput !== null &&
            this._now() - this._run.lastOutput >= this._run.staleMs)
            this._fail(this._run, new Error('GPU telemetry timed out'));
        if (this._now() < this._nextRetry)
            throw this._lastError;
        if (!this._run)
            this._start(interval);
        const run = this._run;
        if (!run)
            throw this._lastError;
        if (run.rows.size)
            return this._snapshot(run);
        return run.first;
    }

    pause() {
        if (this._run)
            this._close(this._run, new Error('GPU polling paused'));
        this._nextRetry = 0;
        this._lastError = null;
    }

    stop() {
        this.pause();
        this._stopped = true;
        for (const process of this._children)
            process.force_exit();
    }

    _start(interval) {
        // SIGKILL cannot immediately release a process stuck in kernel I/O.
        // Bound retired children rather than adding one every retry forever.
        if (this._children.size >= 4) {
            this._lastError = new Error('Previous NVIDIA processes are still stopping');
            this._nextRetry = this._now() + this._retryMs;
            return;
        }
        const run = {
            interval, staleMs: Math.max(this._minimumStaleMs, interval * 3000),
            rows: new Map(), buffer: new Uint8Array(0), decoder: new TextDecoder(),
            lastOutput: null, timeout: 0, reading: false, closed: false,
            cancellable: new Gio.Cancellable(),
        };
        try {
            run.process = this._spawn([
                this._executable,
                '--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,uuid',
                '--format=csv,noheader,nounits', `--loop-ms=${interval * 1000}`,
            ]);
            run.stream = run.process.get_stdout_pipe();
        } catch (error) {
            this._lastError = error;
            this._nextRetry = this._now() + this._retryMs;
            return;
        }
        run.first = new Promise((resolve, reject) => {
            run.resolve = resolve;
            run.reject = reject;
        });
        this._run = run;
        this._children.add(run.process);
        this._deadline(run, this._startupMs);
        run.process.wait_async(null, (source, result) => {
            try { source.wait_finish(result); } catch { /* Read failure handles it. */ }
            this._children.delete(run.process);
            if (this._run === run)
                this._fail(run, new Error('nvidia-smi exited; check the NVIDIA driver'));
        });
        this._read(run);
    }

    _deadline(run, milliseconds) {
        if (run.timeout)
            GLib.source_remove(run.timeout);
        run.timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
            run.timeout = 0;
            if (this._run === run)
                this._fail(run, new Error('GPU telemetry timed out'));
            return GLib.SOURCE_REMOVE;
        });
    }

    _read(run) {
        run.reading = true;
        run.stream.read_bytes_async(4096, GLib.PRIORITY_DEFAULT, run.cancellable, (source, result) => {
            run.reading = false;
            try {
                const bytes = source.read_bytes_finish(result);
                if (this._run !== run) {
                    this._closeStream(run);
                    return;
                }
                if (!bytes.get_size())
                    throw new Error('nvidia-smi closed its output');
                const chunk = bytes.get_data();
                if (run.buffer.length + chunk.length > 16384)
                    throw new Error('Unexpectedly large nvidia-smi output');
                const combined = new Uint8Array(run.buffer.length + chunk.length);
                combined.set(run.buffer);
                combined.set(chunk, run.buffer.length);
                let start = 0;
                let updated = false;
                for (let index = 0; index < combined.length; index++) {
                    if (combined[index] !== 10)
                        continue;
                    // GJS TextDecoder has no streaming decode. Decode complete
                    // lines so UTF-8 names split across pipe reads stay intact.
                    const line = run.decoder.decode(combined.subarray(start, index)).trim();
                    start = index + 1;
                    // Linux may interleave Xid/ECC diagnostics with loop output.
                    if (!/^\d+\s*,/.test(line))
                        continue;
                    const separator = line.lastIndexOf(',');
                    const uuid = line.slice(separator + 1).trim();
                    if (!/^GPU-[A-Za-z0-9-]+$/.test(uuid))
                        continue;
                    let row;
                    try { [row] = parseNvidia(line.slice(0, separator)); } catch { continue; }
                    if (!row || !/^\d+$/.test(row.id))
                        continue;
                    if (!run.rows.has(uuid) && run.rows.size >= 256)
                        throw new Error('Too many GPU records');
                    row.uuid = uuid;
                    run.lastOutput = this._now();
                    run.rows.set(uuid, {value: row, seen: run.lastOutput});
                    updated = true;
                }
                run.buffer = combined.slice(start);
                if (updated) {
                    this._deadline(run, run.staleMs);
                    if (run.resolve) {
                        run.resolve(this._snapshot(run));
                        run.resolve = run.reject = null;
                    }
                }
                this._read(run);
            } catch (error) {
                if (this._run === run)
                    this._fail(run, error);
                else
                    this._closeStream(run);
            }
        });
    }

    _snapshot(run) {
        const cutoff = this._now() - run.staleMs;
        for (const [id, row] of run.rows) {
            if (row.seen <= cutoff)
                run.rows.delete(id);
        }
        return [...run.rows.values()].map(row => row.value).sort((a, b) => Number(a.id) - Number(b.id));
    }

    _fail(run, error) {
        if (this._run !== run)
            return;
        this._lastError = error;
        this._nextRetry = this._now() + this._retryMs;
        this._close(run, error);
    }

    _close(run, error) {
        if (this._run === run)
            this._run = null;
        if (run.timeout)
            GLib.source_remove(run.timeout);
        run.timeout = 0;
        run.cancellable.cancel();
        run.process.force_exit();
        run.reject?.(error);
        run.resolve = run.reject = null;
        run.rows.clear();
        run.buffer = new Uint8Array(0);
        if (!run.reading)
            this._closeStream(run);
    }

    _closeStream(run) {
        if (run.closed)
            return;
        run.closed = true;
        run.stream.close_async(GLib.PRIORITY_DEFAULT, null, (source, result) => {
            try { source.close_finish(result); } catch { /* Process is already gone. */ }
        });
    }
}
