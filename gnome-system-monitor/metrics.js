// Pure parsers, shared by the extension and the regression tests.
export const clamp = value => Math.max(0, Math.min(100, value));
const isCounter = value => Number.isFinite(value) && value >= 0;
function counter(value) {
    if (!/^\d+$/.test(value ?? ''))
        return null;
    const number = Number(value);
    return isCounter(number) ? number : null;
}

export function parseCpu(text) {
    const match = text.match(/^cpu[ \t]+(.+)$/m);
    if (!match)
        throw new Error('CPU counters unavailable');
    // guest and guest_nice are already included in user and nice.
    const values = match[1].trim().split(/\s+/).slice(0, 8).map(counter);
    if (values.length < 4 || values.some(value => value === null))
        throw new Error('CPU counters unavailable');
    const total = values.reduce((sum, value) => sum + value, 0);
    if (!Number.isFinite(total))
        throw new Error('CPU counters unavailable');
    return {total, idle: values[3] + (values[4] ?? 0)};
}

export function cpuUsage(previous, current) {
    if (!previous || !current ||
        ![previous.total, previous.idle, current.total, current.idle].every(isCounter))
        return null;
    const total = current.total - previous.total;
    const idle = current.idle - previous.idle;
    // Counters can reset; the kernel also documents that iowait can decrease.
    // An inconsistent delta is unavailable, rather than a misleading 0%/100%.
    if (total <= 0 || idle < 0 || idle > total)
        return null;
    return 100 * (1 - idle / total);
}

export function parseMemory(text) {
    const fields = {};
    for (const match of text.matchAll(/^(MemTotal|MemAvailable|SwapTotal|SwapFree):\s+(\d+)\s+kB\b/gm))
        fields[match[1]] = Number(match[2]) * 1024;
    if (!isCounter(fields.MemTotal) || fields.MemTotal === 0 || !isCounter(fields.MemAvailable))
        throw new Error('Memory counters unavailable');
    const used = Math.max(0, fields.MemTotal - fields.MemAvailable);
    const swapTotal = isCounter(fields.SwapTotal) ? fields.SwapTotal : null;
    const swapUsed = swapTotal === 0 ? 0 : swapTotal !== null && isCounter(fields.SwapFree)
        ? Math.max(0, swapTotal - fields.SwapFree) : null;
    return {
        used, total: fields.MemTotal, percent: clamp(used / fields.MemTotal * 100),
        swapUsed, swapTotal,
    };
}

export function parseNvidia(text) {
    return text.trim().split('\n').filter(Boolean).map(line => {
        const columns = line.split(',');
        const id = columns[0].trim();
        if (columns.length < 6 || !/^\d+$/.test(id))
            throw new Error('Unexpected nvidia-smi output');
        const number = value => value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
        // The final four fields are numeric. Joining the middle preserves names
        // containing CSV commas, with or without nvidia-smi's optional quotes.
        const name = columns.slice(1, -4).join(',').trim().replace(/^"(.*)"$/, (_, value) => value.replace(/""/g, '"'));
        if (!name)
            throw new Error('Unexpected nvidia-smi output');
        const [utilization, used, total, temperature] = columns.slice(-4).map(number);
        const mib = value => value !== null && isCounter(value * 1024 ** 2) ? value * 1024 ** 2 : null;
        return {
            id, name, utilization: utilization !== null && utilization >= 0 && utilization <= 100 ? utilization : null,
            memoryUsed: mib(used), memoryTotal: mib(total), temperature,
        };
    });
}

export function parseDiskstats(text, device) {
    for (const line of text.trim().split('\n')) {
        const fields = line.trim().split(/\s+/);
        if (`${fields[0]}:${fields[1]}` !== device || fields.length < 14)
            continue;
        return blockCounters(fields, device, fields[2], 3);
    }
    return null;
}

function blockCounters(fields, device, name, offset) {
    const sectorsRead = counter(fields[offset + 2]);
    const sectorsWritten = counter(fields[offset + 6]);
    const ioMs = counter(fields[offset + 9]);
    if (sectorsRead === null || sectorsWritten === null || ioMs === null ||
        !Number.isFinite(sectorsRead * 512) || !Number.isFinite(sectorsWritten * 512))
        return null;
    return {device, name, readBytes: sectorsRead * 512, writeBytes: sectorsWritten * 512, ioMs};
}

export function parseBlockStat(text, device, name = device) {
    const fields = text.trim().split(/\s+/);
    return fields.length < 11 ? null : blockCounters(fields, device, name, 0);
}

export function diskRates(previous, current, seconds) {
    const unavailable = () => ({read: null, write: null, busy: null});
    if (!previous || !current || previous.name !== current.name || previous.device !== current.device ||
        !Number.isFinite(seconds) || seconds <= 0 ||
        ![previous.readBytes, previous.writeBytes, previous.ioMs,
            current.readBytes, current.writeBytes, current.ioMs].every(isCounter) ||
        current.readBytes < previous.readBytes || current.writeBytes < previous.writeBytes ||
        current.ioMs < previous.ioMs)
        return unavailable();
    const rates = {
        read: (current.readBytes - previous.readBytes) / seconds,
        write: (current.writeBytes - previous.writeBytes) / seconds,
        busy: clamp((current.ioMs - previous.ioMs) / (seconds * 10)),
    };
    return Object.values(rates).every(Number.isFinite) ? rates : unavailable();
}

export function findMount(text, path) {
    const decode = value => value.replace(/\\([0-7]{3})/g, (_, code) => String.fromCharCode(parseInt(code, 8)));
    let selected = null;
    for (const line of text.trim().split('\n')) {
        const [left, right] = line.split(' - ');
        if (!right)
            continue;
        const fields = left.trim().split(/\s+/);
        const filesystem = right.trim().split(/\s+/);
        if (fields.length < 6 || !/^\d+:\d+$/.test(fields[2]) || filesystem.length < 2)
            continue;
        const mount = decode(fields[4]);
        if (!mount.startsWith('/'))
            continue;
        if (path !== mount && !path.startsWith(mount === '/' ? '/' : `${mount}/`))
            continue;
        if (selected && selected.mount.length > mount.length)
            continue;
        selected = {id: fields[0], mount, device: fields[2], type: filesystem[0], source: decode(filesystem[1])};
    }
    return selected;
}

export function formatPercent(value) {
    return value === null || value === undefined || !Number.isFinite(value) ? '—' : `${Math.round(value)}%`;
}

export function formatBytes(value) {
    if (value === null || value === undefined || !Number.isFinite(value) || value < 0)
        return '—';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
    let index = 0;
    while (Math.abs(value) >= 1024 && index < units.length - 1) {
        value /= 1024;
        index++;
    }
    return `${value.toFixed(index > 0 && value < 100 ? 1 : 0)} ${units[index]}`;
}
