/**
 * TON 地址工具（演示钱包 + 展示用）。
 * 纯本地计算：CRC16-XMODEM + base64url，把 32 字节哈希编码成友好地址（UQ... / EQ...）。
 * 不发起任何网络请求，也不涉及私钥/签名。
 */

const B64_URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** base64url 编码（无 padding）。 */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64_URL[(n >> 18) & 63] + B64_URL[(n >> 12) & 63] + B64_URL[(n >> 6) & 63] + B64_URL[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64_URL[(n >> 18) & 63] + B64_URL[(n >> 12) & 63];
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64_URL[(n >> 18) & 63] + B64_URL[(n >> 12) & 63] + B64_URL[(n >> 6) & 63];
  }
  return out;
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

/** 0x51 = 主网不可弹回（UQ...）；0x91 = 测试网不可弹回（kQ...）。 */
const FLAG_MAINNET = 0x51;
const FLAG_TESTNET = 0x91;

/** 由 32 字节账户哈希生成 TON 友好地址。 */
export function friendlyAddressFromHash(hash: Uint8Array, workchain = 0, testnet = false): string {
  const buf = new Uint8Array(36);
  buf[0] = testnet ? FLAG_TESTNET : FLAG_MAINNET;
  buf[1] = workchain & 0xff;
  buf.set(hash.subarray(0, 32), 2);
  const crc = crc16Xmodem(buf.subarray(0, 34));
  buf[34] = (crc >> 8) & 0xff;
  buf[35] = crc & 0xff;
  return bytesToBase64Url(buf);
}

/** 本地生成一个 UQ 开头的演示地址（32 字节随机哈希，无任何真实资产）。 */
export function generateDemoAddress(testnet = false): string {
  const hash = new Uint8Array(32);
  try {
    const webCrypto = globalThis.crypto;
    if (webCrypto && typeof webCrypto.getRandomValues === 'function') {
      webCrypto.getRandomValues(hash);
    } else {
      for (let i = 0; i < hash.length; i += 1) hash[i] = Math.floor(Math.random() * 256);
    }
  } catch {
    for (let i = 0; i < hash.length; i += 1) hash[i] = Math.floor(Math.random() * 256);
  }
  return friendlyAddressFromHash(hash, 0, testnet);
}

/**
 * TON Connect 返回的地址是 raw 形式（"0:hex..."），展示与 /api/me 查询用友好地址。
 * 已是友好地址时原样返回。
 */
export function rawToFriendly(raw: string, testnet = false): string {
  if (!raw) return '';
  const sep = raw.indexOf(':');
  if (sep < 0) return raw;
  const workchain = Number.parseInt(raw.slice(0, sep), 10);
  const hex = raw.slice(sep + 1).trim();
  if (hex.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(hex)) return raw;
  const hash = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) hash[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return friendlyAddressFromHash(hash, Number.isFinite(workchain) ? workchain : 0, testnet);
}

/** 是否是 TON 友好地址形态（UQ/EQ/kQ/0Q 开头，48 字符）。 */
export function looksLikeTonAddress(value: string): boolean {
  return /^(UQ|EQ|kQ|0Q)[A-Za-z0-9_-]{46}$/.test(value);
}
