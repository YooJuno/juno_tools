import assert from 'node:assert/strict';
import test from 'node:test';
import {cpuUsage, diskRates, findMount, formatBytes, formatPercent, parseBlockStat, parseCpu, parseDiskstats, parseMemory, parseNvidia} from '../gnome-system-monitor/metrics.js';

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

test('CPU rejects partial/malformed counters and inconsistent deltas', () => {
    for (const text of ['cpu 1 2 3', 'cpu 1 2 bad 4 0 0 0 0', 'cpu 1 2 3 4 -1 0 0 0', 'cpu 1 2 3 Infinity 0 0 0 0'])
        assert.throws(() => parseCpu(text));
    assert.deepEqual(parseCpu('cpu 1 2 3 4'), {total: 10, idle: 4});
    assert.equal(cpuUsage({total: 100, idle: 50}, {total: 110, idle: 65}), null);
    assert.equal(cpuUsage({total: 100, idle: 50}, {total: 110, idle: 49}), null);
    assert.equal(cpuUsage({total: 100, idle: 50}, {total: NaN, idle: 55}), null);
});

test('missing swap readings stay unavailable instead of becoming NaN', () => {
    const memory = 'MemTotal: 1000 kB\nMemAvailable: 600 kB';
    assert.deepEqual(parseMemory(memory), {used: 400 * 1024, total: 1000 * 1024, percent: 40, swapUsed: null, swapTotal: null});
    assert.equal(parseMemory(`${memory}\nSwapTotal: 0 kB`).swapUsed, 0);
    assert.equal(parseMemory(`${memory}\nSwapTotal: 100 kB`).swapUsed, null);
    assert.throws(() => parseMemory(`MemTotal: ${'9'.repeat(400)} kB\nMemAvailable: 1 kB`));
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

test('GPU CSV names do not shift metrics and invalid readings stay unavailable', () => {
    const [gpu] = parseNvidia('0, "NVIDIA, Test ""GPU""", 12, 512, 8192, 50');
    assert.equal(gpu.name, 'NVIDIA, Test "GPU"');
    assert.equal(gpu.utilization, 12);
    assert.equal(gpu.memoryUsed, 512 * 1024 ** 2);
    const [invalid] = parseNvidia('0, NVIDIA GPU, 150, -1, Infinity, NaN');
    assert.equal(invalid.utilization, null);
    assert.equal(invalid.memoryUsed, null);
    assert.equal(invalid.memoryTotal, null);
    assert.equal(invalid.temperature, null);
    assert.throws(() => parseNvidia('0, , 1, 2, 3, 4'));
});

test('mount selection handles nested mounts, escaped spaces and prefix boundaries', () => {
    const mounts = '1 0 259:2 / / rw - ext4 /dev/nvme0n1p2 rw\n2 1 8:1 / /home rw - ext4 /dev/sda1 rw\n3 1 8:2 / /media/My\\040SSD rw - ext4 /dev/sdb1 rw';
    assert.equal(findMount(mounts, '/home/juno').device, '8:1');
    assert.equal(findMount(mounts, '/home-other').device, '259:2');
    assert.equal(findMount(mounts, '/media/My SSD/files').mount, '/media/My SSD');
    assert.equal(findMount('', '/'), null);
});

test('malformed mount records cannot hide a valid matching mount', () => {
    const mounts = 'truncated - ext4\n1 0 259:2 / / rw - ext4 /dev/nvme0n1p2 rw\n2 1 broken / /home rw - ext4 /dev/sda1 rw';
    const root = findMount(mounts, '/home/juno');
    assert.equal(root.device, '259:2');
    assert.equal(root.id, '1');
    assert.equal(findMount('1 0 8:1 / / rw - ext4', '/'), null);
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

test('single-device sysfs counters match diskstats and reject corrupt snapshots', () => {
    const stats = '1 0 100 5 3 0 200 4 0 100 120';
    assert.deepEqual(parseBlockStat(stats, '259:2', 'nvme0n1p2'), parseDiskstats(`259 2 nvme0n1p2 ${stats}`, '259:2'));
    assert.equal(parseBlockStat('1 0 100', '259:2'), null);
    assert.equal(parseBlockStat(stats.replace('100', '-100'), '259:2'), null);
    assert.equal(parseBlockStat(stats.replace('200', 'bad'), '259:2'), null);
    assert.equal(parseDiskstats('259 2 nvme0n1p2 1 0 bad 5 3 0 200 4 0 100 120', '259:2'), null);
});

test('disk deltas reset on device replacement and never expose nonfinite rates', () => {
    const previous = {device: '259:2', name: 'disk', readBytes: 100, writeBytes: 100, ioMs: 10};
    const current = {...previous, readBytes: 200, writeBytes: 200, ioMs: 20};
    const unavailable = {read: null, write: null, busy: null};
    assert.deepEqual(diskRates(previous, {...current, device: '8:1'}, 1), unavailable);
    for (const seconds of [0, -1, NaN, Infinity])
        assert.deepEqual(diskRates(previous, current, seconds), unavailable);
    assert.deepEqual(diskRates(previous, {...current, readBytes: NaN}, 1), unavailable);
    assert.deepEqual(diskRates(previous, {...current, ioMs: Infinity}, 1), unavailable);
});

test('unavailable is distinct from zero', () => {
    assert.equal(formatPercent(null), '—');
    assert.equal(formatPercent(undefined), '—');
    assert.equal(formatPercent(0), '0%');
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(undefined), '—');
    assert.equal(formatBytes(-1), '—');
    assert.equal(formatBytes(1024 ** 3), '1.0 GiB');
});
