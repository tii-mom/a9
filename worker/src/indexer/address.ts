/**
 * TON 地址编解码与校验（CRC16/XMODEM）。
 * 索引器内部一律用 raw 形式（workchain:hex，小写）做比较与 toncenter 查询；
 * friendly 形式只用于 env 输入与日志展示。
 */

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const HEX = '0123456789abcdefABCDEF';

const CRC16_TABLE: Uint16Array = (() => {
  const table = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i << 8;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    table[i] = crc;
  }
  return table;
})();

/** TON 地址校验和：CRC16/XMODEM。 */
export function crc16(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) crc = ((crc << 8) & 0xffff) ^ CRC16_TABLE[((crc >> 8) ^ byte) & 0xff];
  return crc;
}

export interface TonAddress {
  /** 规范化 raw：`<workchain>:<64 位小写 hex>` */
  raw: string;
  workchain: number;
  hashHex: string;
  /** friendly 地址的 testnet 位；raw 输入为 null */
  testnet: boolean | null;
  /** friendly 地址的 bounceable 位；raw 输入为 null */
  bounceable: boolean | null;
  /** 原始输入（friendly 或 raw） */
  input: string;
}

function isHex(text: string): boolean {
  if (!text.length) return false;
  for (const ch of text) if (!HEX.includes(ch)) return false;
  return true;
}

function isBase64Url(text: string): boolean {
  if (!text.length) return false;
  for (const ch of text) if (!B64URL.includes(ch)) return false;
  return true;
}

/** base64url 字符串 → 字节（workerd/node 都有 atob）。 */
export function base64UrlToBytes(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** 解析 friendly（EQ…/UQ…/kQ…/0Q…）或 raw（workchain:hex）地址；非法返回 null。 */
export function parseTonAddress(input: string | null | undefined): TonAddress | null {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (!text) return null;
  const colon = text.indexOf(':');
  if (colon > 0) {
    const wcText = text.slice(0, colon);
    const hashText = text.slice(colon + 1);
    if (!/^-?\d+$/.test(wcText) || hashText.length !== 64 || !isHex(hashText)) return null;
    const workchain = Number(wcText);
    const hashHex = hashText.toLowerCase();
    return { raw: workchain + ':' + hashHex, workchain, hashHex, testnet: null, bounceable: null, input: text };
  }
  if (text.length !== 48 || !isBase64Url(text)) return null;
  const bytes = base64UrlToBytes(text);
  if (bytes.length !== 36) return null;
  const expected = (bytes[34] << 8) | bytes[35];
  if (crc16(bytes.subarray(0, 34)) !== expected) return null;
  const flags = bytes[0];
  const workchain = bytes[1] > 127 ? bytes[1] - 256 : bytes[1];
  let hashHex = '';
  for (let i = 2; i < 34; i++) hashHex += bytes[i].toString(16).padStart(2, '0');
  return {
    raw: workchain + ':' + hashHex,
    workchain,
    hashHex,
    testnet: (flags & 0x80) !== 0,
    bounceable: (flags & 0x40) === 0,
    input: text,
  };
}

/** 解析地址，非法时抛出带标签的错误（用于 env / registry 校验）。 */
export function requireTonAddress(input: string | null | undefined, label: string): TonAddress {
  const parsed = parseTonAddress(input);
  if (!parsed) throw new Error(label + ' 不是合法的 TON 地址：' + String(input));
  return parsed;
}

/** 生成 friendly 地址（默认 testnet + bounceable，与测试网工具链一致）。 */
export function formatTonAddress(workchain: number, hashHex: string, options: { testnet?: boolean; bounceable?: boolean } = {}): string {
  const testnet = options.testnet !== false;
  const bounceable = options.bounceable !== false;
  if (!isHex(hashHex) || hashHex.length !== 64) throw new Error('hashHex 必须为 64 位十六进制');
  const bytes = new Uint8Array(36);
  bytes[0] = (bounceable ? 0x11 : 0x51) | (testnet ? 0x80 : 0x00);
  bytes[1] = workchain < 0 ? 256 + workchain : workchain;
  for (let i = 0; i < 32; i++) bytes[2 + i] = parseInt(hashHex.slice(i * 2, i * 2 + 2), 16);
  const crc = crc16(bytes.subarray(0, 34));
  bytes[34] = (crc >> 8) & 0xff;
  bytes[35] = crc & 0xff;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 比较两个地址是否指向同一账户（自动处理 friendly/raw 混用）。 */
export function addressEquals(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = parseTonAddress(left);
  const b = parseTonAddress(right);
  return !!a && !!b && a.raw === b.raw;
}

/** 日志用短地址：`-1:57a9f5…4417`。 */
export function shortAddress(input: string): string {
  const parsed = parseTonAddress(input);
  if (!parsed) return String(input).slice(0, 12);
  return parsed.workchain + ':' + parsed.hashHex.slice(0, 6) + '…' + parsed.hashHex.slice(-4);
}
