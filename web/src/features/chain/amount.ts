/** 代币数量（raw units）与十进制字符串互转。 */

/** 十进制字符串 → raw units（bigint）。空串/非法返回 null。 */
export function parseAmountToRaw(input: string, decimals: number): bigint | null {
  const text = String(input ?? '').trim().replace(/,/g, '');
  if (!text) return null;
  if (!/^\d*(\.\d*)?$/.test(text)) return null;
  const [wholePart, fractionPart = ''] = text.split('.');
  const whole = wholePart === '' ? '0' : wholePart;
  if (fractionPart.length > decimals) {
    // 超出精度的部分直接拒绝，避免静默截断
    return null;
  }
  const padded = fractionPart.padEnd(decimals, '0');
  try {
    return BigInt(whole + padded);
  } catch {
    return null;
  }
}

/** raw units → 人类可读（去掉尾随 0，最多保留 decimals 位）。 */
export function formatRawAmount(raw: bigint | string, decimals: number, maxFractionDigits = 4): string {
  let value: bigint;
  try {
    value = BigInt(raw);
  } catch {
    return '0';
  }
  const negative = value < 0n;
  if (negative) value = -value;
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = (value % base).toString().padStart(decimals, '0');
  const trimmed = fraction.replace(/0+$/, '').slice(0, Math.max(0, maxFractionDigits));
  const wholeText = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (negative ? '-' : '') + wholeText + (trimmed ? '.' + trimmed : '');
}

/** 判断字符串是否为合法的正数金额（用于表单按钮禁用）。 */
export function isValidAmountInput(input: string, decimals: number): boolean {
  const raw = parseAmountToRaw(input, decimals);
  return raw !== null && raw > 0n;
}
