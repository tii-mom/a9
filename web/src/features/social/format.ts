/** 社交层数字格式化（纯函数，便于单测）。 */

/** A9 精度（raw 单位 = 1e-9 A9）。 */
export const A9_DECIMALS = 9;

/** 1 亿。 */
const YI = 100_000_000;

/** 整数美元：$37,420。非有限数返回 —。 */
export function usdWhole(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `$${Math.round(value).toLocaleString('en-US')}`;
}

/** 价格美元：大于等于 1 保留两位，小于 1 保留四位有效数字（$0.001234）。 */
export function usdPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value >= 1) return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `$${Number(value.toPrecision(4))}`;
}

/** A9 raw 字符串 → 亿 A9，保留两位小数：7e17 raw → "7.00"。解析失败返回 —。 */
export function a9Yi(raw: string | null | undefined): string {
  if (!raw) return '—';
  try {
    const whole = BigInt(raw) / 10n ** BigInt(A9_DECIMALS);
    return (Number(whole) / YI).toFixed(2);
  } catch {
    return '—';
  }
}

/** A9 raw 字符串 → 紧凑展示：1.20 亿 / 3,400 万 / 5,600。解析失败返回 —。 */
export function a9Compact(raw: string | null | undefined): string {
  if (!raw) return '—';
  try {
    const whole = BigInt(raw) / 10n ** BigInt(A9_DECIMALS);
    const n = Number(whole);
    if (n >= YI) return `${(n / YI).toFixed(2)} 亿`;
    if (n >= 10_000) return `${(n / 10_000).toFixed(0)} 万`;
    return n.toLocaleString('en-US');
  } catch {
    return '—';
  }
}

/** 现价相对城门的偏离：above = 现价不低于城门；pct 为百分比（一位小数）。 */
export function gateGap(priceUsd: number, gatePriceUsd: number): { above: boolean; pct: string } | null {
  if (!Number.isFinite(priceUsd) || !Number.isFinite(gatePriceUsd) || gatePriceUsd <= 0) return null;
  const ratio = priceUsd / gatePriceUsd - 1;
  return { above: ratio >= 0, pct: (Math.abs(ratio) * 100).toFixed(1) };
}
