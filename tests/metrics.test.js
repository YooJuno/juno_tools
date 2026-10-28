import assert from 'node:assert/strict';
import test from 'node:test';
import {cpuUsage, diskRates, findMount, formatBytes, formatPercent, parseCpu, parseDiskstats, parseMemory, parseNvidia} from '../gnome-system-monitor/metrics.js';

test('CPU uses deltas and does not double count guest time', () => {
    const before = parseCpu('cpu  100 10 20 800 20 5 5 40 30 4\ncpu0 50 0 10 300 0 0 0 0');
    const after = parseCpu('cpu  150 10 30 830 30 5 5 40 50 4');
    assert.deepEqual(before, {total: 1000, idle: 820});
    assert.equal(cpuUsage(before, after), 60);
    assert.equal(cpuUsage(null, after), null);
    assert.equal(cpuUsage(after, before), null);
    assert.equal(cpuUsage(after, after), null);
    assert.throws(() => parseCpu('unavailable'));
});

test('memory counts reclaimable cache as available, and reports swap separately', () => {
    const result = parseMemory('MemTotal: 1000 kB\nMemFree: 10 kB\nMemAvailable: 600 kB\nSwapTotal: 200 kB\nSwapFree: 150 kB');
    assert.equal(result.percent, 40);
    assert.equal(result.used, 400 * 1024);
    assert.equal(result.swapUsed, 50 * 1024);
    assert.throws(() => parseMemory('MemTotal: 0 kB'));
});

test('GPU parser preserves multiple devices and unsupported metrics', () => {
    const gpus = parseNvidia('0, NVIDIA GeForce RTX 4060 Laptop GPU, 12, 512, 8188, 50\n1, NVIDIA GPU, [N/A], N/A, 4096, [Not Supported]\n');
    assert.equal(gpus[0].memoryUsed, 512 * 1024 ** 2);
    assert.equal(gpus[1].utilization, null);
    assert.equal(gpus[1].memoryUsed, null);
    assert.equal(gpus[1].temperature, null);
    assert.equal(parseNvidia('').length, 0);
    assert.throws(() => parseNvidia('broken'));
});

test('mount selection handles nested mounts, escaped spaces and prefix boundaries', () => {
    const mounts = '1 0 259:2 / / rw - ext4 /dev/nvme0n1p2 rw\n2 1 8:1 / /home rw - ext4 /dev/sda1 rw\n3 1 8:2 / /media/My\\040SSD rw - ext4 /dev/sdb1 rw';
    assert.equal(findMount(mounts, '/home/juno').device, '8:1');
    assert.equal(findMount(mounts, '/home-other').device, '259:2');
    assert.equal(findMount(mounts, '/media/My SSD/files').mount, '/media/My SSD');
    assert.equal(findMount('', '/'), null);
});

test('disk counters use 512-byte sectors and elapsed monotonic time', () => {
    const counters = '259 2 nvme0n1p2 1 0 100 5 3 0 200 4 0 100 120';
    const previous = parseDiskstats(counters, '259:2');
    assert.equal(previous.readBytes, 51200);
    assert.equal(previous.writeBytes, 102400);
    assert.equal(parseDiskstats(counters, '8:1'), null);
    const current = {...previous, readBytes: previous.readBytes + 2048, writeBytes: previous.writeBytes + 4096, ioMs: 300};
    assert.deepEqual(diskRates(previous, current, 2), {read: 1024, write: 2048, busy: 10});
    assert.equal(diskRates(current, previous, 2).read, null);
    assert.equal(diskRates(null, current, 2).read, null);
    assert.equal(diskRates(previous, {...current, name: 'sda'}, 2).busy, null);
});

test('unavailable is distinct from zero', () => {
    assert.equal(formatPercent(null), '—');
    assert.equal(formatPercent(undefined), '—');
    assert.equal(formatPercent(0), '0%');
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(undefined), '—');
    assert.equal(formatBytes(1024 ** 3), '1.0 GiB');
});
