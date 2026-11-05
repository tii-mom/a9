import { compactNumber, rawToNumber } from '../../lib/format';
import type { Lang } from '../../lib/lang';

export function intFmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return Math.round(n).toLocaleString('en-US');
}

export function usdNum(e8: string | null | undefined): number | null {
  if (e8 === null || e8 === undefined || e8 === '') return null;
  const v = Number(e8);
  return Number.isFinite(v) ? v / 1e8 : null;
}

export function tokenNum(raw: string | null | undefined, decimals: number): number {
  return rawToNumber(raw ?? '0', decimals);
}

export function pctFmt(ratio: number, digits = 2): string {
  if (!Number.isFinite(ratio)) return '—';
  return (ratio >= 0 ? '+' : '') + (ratio * 100).toFixed(digits) + '%';
}

export function shortAddr(addr: string | null | undefined): string {
  if (!addr) return '—';
  if (addr.length <= 12) return addr;
  return addr.slice(0, 6) + '…' + addr.slice(-4);
}

/** Convert a human decimal string (e.g. "1234.5") into raw units without float rounding drift. */
export function toRawUnits(value: string, decimals: number): string {
  const cleaned = value.trim().replace(/,/g, '');
  if (!cleaned) return '0';
  if (!/^\d+(?:\.\d*)?$/.test(cleaned) || !Number.isInteger(decimals) || decimals < 0) return '0';
  const [whole, fraction = ''] = cleaned.split('.');
  if (fraction.length > decimals && /[1-9]/.test(fraction.slice(decimals))) return '0';
  return BigInt(whole + fraction.padEnd(decimals, '0').slice(0, decimals)).toString();
}

/** Compact number that respects the active language (format.ts compacts to 亿/万 only). */
export function formatCompactNumber(n: number, lang: Lang): string {
  if (!Number.isFinite(n)) return '0';
  if (lang === 'zh') return compactNumber(n);
  const abs = Math.abs(n);
  const trim = (value: number) => value.toFixed(2).replace(/\.?0+$/, '');
  if (abs >= 1e9) return trim(n / 1e9) + 'B';
  if (abs >= 1e6) return trim(n / 1e6) + 'M';
  if (abs >= 1e3) return trim(n / 1e3) + 'K';
  return Math.round(n).toLocaleString('en-US');
}

export function formatCompactToken(raw: string | null | undefined, decimals: number, lang: Lang): string {
  return formatCompactNumber(rawToNumber(raw ?? '0', decimals), lang);
}

/** Countdown in HH:MM:SS, or "D天 HH:MM:SS" / "Dd HH:MM:SS" once it passes a day. */
export function formatCountdown(seconds: number | null | undefined, lang: Lang): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '--:--:--';
  const total = Math.max(0, Math.floor(seconds));
  const pad = (n: number) => String(n).padStart(2, '0');
  const days = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const clock = pad(h) + ':' + pad(m) + ':' + pad(s);
  if (days <= 0) return clock;
  return days + (lang === 'zh' ? '天 ' : 'd ') + clock;
}

export function addThousands(n: number): string {
  return intFmt(n);
}
