/** BigInt / 数值小工具（金额一律字符串 + BigInt，禁止浮点参与记账）。 */

export function toBigInt(value: string | number | bigint | null | undefined): bigint {
  if (value === null || value === undefined || value === '') return 0n;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? BigInt(Math.trunc(value)) : 0n;
  const t = value.trim();
  if (!/^-?\d+$/.test(t)) return 0n;
  return BigInt(t);
}

export function rawStr(value: bigint): string {
  return value.toString();
}

/** floor(a * b / d)，d 为 0 时返回 0（避免除零）。 */
export function mulDivFloor(a: bigint, b: bigint, d: bigint): bigint {
  if (d === 0n) return 0n;
  return (a * b) / d;
}

export function clampBig(value: bigint, min: bigint, max: bigint): bigint {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function isDigits(value: string): boolean {
  return /^\d+$/.test(value);
}

/** 向下取整到 align 的倍数。 */
export function floorTo(value: number, align: number): number {
  if (align <= 0) return value;
  return Math.floor(value / align) * align;
}

/** 向上取整到 align 的倍数。 */
export function ceilTo(value: number, align: number): number {
  if (align <= 0) return value;
  return Math.ceil(value / align) * align;
}

/** hex 编码（用于 dataDigest 等确定性伪数据）。 */
export function toHex32(n: number): string {
  const v = n >>> 0;
  return v.toString(16).padStart(8, '0');
}
