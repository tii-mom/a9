/** Formatting helpers shared by every page. All amounts come from the API as raw-unit strings. */

export function rawToNumber(raw: string | number | null | undefined, decimals: number): number {
  if (raw === null || raw === undefined) return 0;
  const s = String(raw);
  const digits = s.replace(/^-/, '');
  const neg = s.startsWith('-');
  if (digits.length <= decimals) {
    const padded = digits.padStart(decimals + 1, '0');
    const v = Number(`${padded.slice(0, padded.length - decimals)}.${padded.slice(padded.length - decimals)}`);
    return neg ? -v : v;
  }
  const v = Number(`${digits.slice(0, digits.length - decimals)}.${digits.slice(digits.length - decimals)}`);
  return neg ? -v : v;
}

export function formatToken(raw: string | number | null | undefined, decimals: number, opts: { compact?: boolean; max?: number } = {}): string {
  const v = rawToNumber(raw, decimals);
  if (opts.compact) return compactNumber(v);
  return v.toLocaleString('en-US', { maximumFractionDigits: opts.max ?? 2 });
}

export function compactNumber(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e8) return trim(n / 1e8) + ' 亿';
  if (abs >= 1e4) return trim(n / 1e4) + ' 万';
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export function compactUsd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return '$' + trim(n / 1e9) + 'B';
  if (abs >= 1e6) return '$' + trim(n / 1e6) + 'M';
  if (abs >= 1e3) return '$' + trim(n / 1e3) + 'K';
  return '$' + trim(n);
}

function trim(n: number): string {
  const s = n.toFixed(2);
  return s.replace(/\.?0+$/, '');
}

export function formatUsdE8(e8: string | number | null | undefined, opts: { compact?: boolean } = {}): string {
  if (e8 === null || e8 === undefined) return '—';
  const v = Number(e8) / 1e8;
  if (!Number.isFinite(v)) return '—';
  if (opts.compact) return compactUsd(v);
  return '$' + v.toFixed(v >= 1 ? 3 : 5);
}

export function formatPct(ratio: number, digits = 2): string {
  return (ratio >= 0 ? '+' : '') + (ratio * 100).toFixed(digits) + '%';
}

export function shortAddress(addr: string, head = 6, tail = 4): string {
  if (!addr) return '—';
  if (addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function utcClock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}天 ${pad2(h)}:${pad2(m)}:${pad2(sec)}`;
  return `${pad2(h)}:${pad2(m)}:${pad2(sec)}`;
}

export function formatDateTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}
