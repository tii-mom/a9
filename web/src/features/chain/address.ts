/**
 * TON 地址工具（链上模块自包含，不依赖 @ton/core）。
 * - 友好地址（EQ.../UQ.../kQ.../0Q...）<-> raw（"<wc>:<64 hex>"）互转
 * - 同时支持 raw 输入，便于和 TON Connect / toncenter 交互
 * 仅做编解码与 CRC16 校验，不涉及私钥或签名。
 */

const B64_URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** TON 内部地址（workchain + 32 字节账户哈希）。 */
export interface TonAddress {
  workchain: number;
  /** 小写 64 位十六进制，不带前缀 */
  hashHex: string;
}

/** 友好地址标志位：bounceable / testnet。 */
const FLAG_BOUNCEABLE_MAINNET = 0x11; // EQ...
const FLAG_NON_BOUNCEABLE_MAINNET = 0x51; // UQ...
const FLAG_BOUNCEABLE_TESTNET = 0x91; // kQ...
const FLAG_NON_BOUNCEABLE_TESTNET = 0xd1; // 0Q...

function alphabet(kind: 'url' | 'std'): string {
  return kind === 'url' ? B64_URL : B64_STD;
}

/** 标准 base64 编码（带 padding），用于 BOC → TON Connect payload。 */
export function base64Encode(bytes: Uint8Array): string {
  return encodeWith(bytes, B64_STD, true);
}

/** base64url 编码（无 padding），用于友好地址。 */
export function base64UrlEncode(bytes: Uint8Array): string {
  return encodeWith(bytes, B64_URL, false);
}

function encodeWith(bytes: Uint8Array, table: string, padded: boolean): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += table[(n >> 18) & 63] + table[(n >> 12) & 63] + table[(n >> 6) & 63] + table[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += table[(n >> 18) & 63] + table[(n >> 12) & 63];
    if (padded) out += '==';
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += table[(n >> 18) & 63] + table[(n >> 12) & 63] + table[(n >> 6) & 63];
    if (padded) out += '=';
  }
  return out;
}

function decodeWith(value: string, table: string): Uint8Array {
  const clean = value.replace(/[\r\n\t ]/g, '');
  const chars = clean.replace(/=+$/, '');
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < chars.length; i += 1) {
    const idx = table.indexOf(chars[i]);
    if (idx < 0) throw new Error('非法 base64 字符: ' + chars[i]);
    buffer = (buffer << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/** 兼容 url-safe / 标准 base64url 解码。 */
export function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/\+/g, '-').replace(/\//g, '_');
  return decodeWith(normalized, B64_URL);
}

/** 标准 base64 解码（兼容无 padding）。 */
export function base64Decode(value: string): Uint8Array {
  return decodeWith(value, B64_STD);
}

/** CRC16/XMODEM（TON 友好地址校验位）。 */
export function crc16Xmodem(bytes: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= bytes[i] << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** raw 地址（"<wc>:<hex>"）。 */
export function toRawAddress(address: TonAddress): string {
  return address.workchain + ':' + address.hashHex.toLowerCase();
}

/** 是否为 raw 地址形态。 */
export function looksLikeRawAddress(value: string): boolean {
  return /^-?\d+:([0-9a-fA-F]{64})$/.test(String(value ?? '').trim());
}

/** 解析 raw 或友好地址（失败抛错）。 */
export function parseTonAddress(value: string): TonAddress {
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error('地址为空');
  if (looksLikeRawAddress(raw)) {
    const sep = raw.indexOf(':');
    const workchain = Number.parseInt(raw.slice(0, sep), 10);
    return { workchain, hashHex: raw.slice(sep + 1).toLowerCase() };
  }
  const normalized = raw.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const bytes = decodeWith(normalized, B64_URL);
  if (bytes.length !== 36) throw new Error('友好地址长度非法: ' + bytes.length);
  const wc = bytes[1] > 127 ? bytes[1] - 256 : bytes[1];
  const hash = bytes.subarray(2, 34);
  const crcStored = (bytes[34] << 8) | bytes[35];
  const crc = crc16Xmodem(bytes.subarray(0, 34));
  if (crc !== crcStored) throw new Error('友好地址 CRC 校验失败');
  return { workchain: wc, hashHex: bytesToHex(hash) };
}

/** 生成友好地址（默认测试网不可弹回，即 0Q...）。 */
export function toFriendlyAddress(address: TonAddress, testnet: boolean, bounceable = false): string {
  const buf = new Uint8Array(36);
  buf[0] = testnet ? (bounceable ? FLAG_BOUNCEABLE_TESTNET : FLAG_NON_BOUNCEABLE_TESTNET) : bounceable ? FLAG_BOUNCEABLE_MAINNET : FLAG_NON_BOUNCEABLE_MAINNET;
  buf[1] = address.workchain & 0xff;
  buf.set(hexToBytes(address.hashHex), 2);
  const crc = crc16Xmodem(buf.subarray(0, 34));
  buf[34] = (crc >> 8) & 0xff;
  buf[35] = crc & 0xff;
  return base64UrlEncode(buf);
}

/** 尝试把任意地址规范成友好地址；失败时原样返回。 */
export function normalizeFriendlyAddress(value: string, testnet: boolean): string {
  try {
    return toFriendlyAddress(parseTonAddress(value), testnet);
  } catch {
    return value;
  }
}

/** 地址缩写展示。 */
export function shortenAddress(value: string, head = 6, tail = 6): string {
  const raw = String(value ?? '');
  if (raw.length <= head + tail + 3) return raw;
  return raw.slice(0, head) + '…' + raw.slice(-tail);
}
