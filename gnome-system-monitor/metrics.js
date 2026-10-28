// Pure parsers, shared by the extension and the regression tests.
export const clamp = value => Math.max(0, Math.min(100, value));

export function parseCpu(text) {
    const match = text.match(/^cpu\s+(.+)$/m);
    if (!match)
        throw new Error('CPU counters unavailable');
    // guest and guest_nice are already included in user and nice.
    const values = match[1].trim().split(/\s+/).slice(0, 8).map(Number);
    return {total: values.reduce((sum, value) => sum + value, 0), idle: values[3] + values[4]};
}

export function cpuUsage(previous, current) {
    const total = current.total - (previous?.total ?? current.total);
    if (total <= 0 || !previous || current.idle < previous.idle)
        return null;
    return clamp(100 * (1 - (current.idle - previous.idle) / total));
}

export function parseMemory(text) {
    const fields = {};
    for (const match of text.matchAll(/^(\w+):\s+(\d+)\s+kB/gm))
        fields[match[1]] = Number(match[2]) * 1024;
    if (!(fields.MemTotal > 0) || fields.MemAvailable === undefined)
        throw new Error('Memory counters unavailable');
    const used = Math.max(0, fields.MemTotal - fields.MemAvailable);
    return {
        used, total: fields.MemTotal, percent: clamp(used / fields.MemTotal * 100),
        swapUsed: Math.max(0, fields.SwapTotal - fields.SwapFree),
        swapTotal: fields.SwapTotal,
    };
}

export function parseNvidia(text) {
    return text.trim().split('\n').filter(Boolean).map(line => {
        const columns = line.split(',').map(value => value.trim());
        if (columns.length < 6)
            throw new Error('Unexpected nvidia-smi output');
        const number = value => value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
        const mib = value => number(value) === null ? null : number(value) * 1024 ** 2;
        return {
            id: columns[0], name: columns[1], utilization: number(columns[2]),
            memoryUsed: mib(columns[3]), memoryTotal: mib(columns[4]),
            temperature: number(columns[5]),
        };
    });
}

export function parseDiskstats(text, device) {
    for (const line of text.trim().split('\n')) {
        const fields = line.trim().split(/\s+/);
        if (`${fields[0]}:${fields[1]}` !== device || fields.length < 14)
            continue;
        return {
            name: fields[2], readBytes: Number(fields[5]) * 512,
            writeBytes: Number(fields[9]) * 512, ioMs: Number(fields[12]),
        };
    }
    return null;
}

export function diskRates(previous, current, seconds) {
    if (!previous || !current || previous.name !== current.name || seconds <= 0 ||
        current.readBytes < previous.readBytes || current.writeBytes < previous.writeBytes ||
        current.ioMs < previous.ioMs)
        return {read: null, write: null, busy: null};
    return {
        read: (current.readBytes - previous.readBytes) / seconds,
        write: (current.writeBytes - previous.writeBytes) / seconds,
        busy: clamp((current.ioMs - previous.ioMs) / (seconds * 10)),
    };
}

export function findMount(text, path) {
    const decode = value => value.replace(/\\([0-7]{3})/g, (_, code) => String.fromCharCode(parseInt(code, 8)));
    let selected = null;
    for (const line of text.trim().split('\n')) {
        const [left, right] = line.split(' - ');
        if (!right)
            continue;
        const fields = left.split(' ');
        const mount = decode(fields[4]);
        if (path !== mount && !path.startsWith(mount === '/' ? '/' : `${mount}/`))
            continue;
        if (selected && selected.mount.length > mount.length)
            continue;
        const filesystem = right.split(' ');
        selected = {mount, device: fields[2], type: filesystem[0], source: decode(filesystem[1])};
    }
    return selected;
}

export function formatPercent(value) {
    return value === null || value === undefined || !Number.isFinite(value) ? '—' : `${Math.round(value)}%`;
}

export function formatBytes(value) {
    if (value === null || value === undefined || !Number.isFinite(value))
        return '—';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
    let index = 0;
    while (Math.abs(value) >= 1024 && index < units.length - 1) {
        value /= 1024;
        index++;
    }
    return `${value.toFixed(index > 0 && value < 100 ? 1 : 0)} ${units[index]}`;
}
