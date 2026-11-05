/**
 * 最小 TON BOC（bag of cells）解析/构造 + 位读写 + cell 哈希。
 *
 * 口径来自 ton-blockchain/ton `crypto/vm/boc.cpp`（CellSerializationInfo::init）：
 *  - cell 头两字节 d1/d2：d1 = refs(低3位) | special(0x08) | with_hashes(0x10) | level(高3位)；
 *  - d2 单字节：data_len = (d2>>1) + (d2&1)，d2&1 表示末字节含有效位（bitLen 用末字节尾零还原）；
 *  - BOC 头：magic(4) flags(1) off_bytes(1) cells(size) roots(size) absent(size) tot_size(off_bytes) root_idx(size) [index]。
 * 只支持普通 cell（不支持 exotic/pruned）；本索引器需要解析的消息体均为普通 cell。
 */
import { crc16 } from './address';

export interface BocCell {
  /** 首字节（含 ref 数/level 标志） */
  d1: number;
  /** 第二字节（数据长度描述） */
  d2: number;
  refs: number;
  level: number;
  special: boolean;
  data: Uint8Array;
  /** 有效位数（由 d2 与末字节尾零还原） */
  bitLen: number;
  /** 引用 cell 的下标 */
  refIndexes: number[];
}

export interface BocBag {
  cells: BocCell[];
  rootIndex: number;
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const text = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  const even = text.length % 2 === 0 ? text : '0' + text;
  const out = new Uint8Array(even.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(even.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** 大端字节 → bigint。 */
export function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/** bigint → 固定长度大端字节。 */
export function bigIntToBytes(value: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let rest = value < 0n ? (1n << BigInt(length * 8)) + value : value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

function bitLengthOfNumber(value: number): number {
  let bits = 0;
  let n = value;
  while (n > 0) {
    bits++;
    n = Math.floor(n / 2);
  }
  return bits;
}

function countTrailingZeroes(value: number): number {
  let count = 0;
  let byte = value & 0xff;
  while (count < 8 && (byte & 1) === 0) {
    count++;
    byte >>= 1;
  }
  return count;
}

/** 解析 BOC 字节。 */
export function parseBocBytes(buffer: Uint8Array): BocBag {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (buffer.byteLength < 6 || view.getUint32(0) !== 0xb5ee9c72) throw new Error('BOC magic 不匹配');
  const flags = buffer[4];
  const hasIndex = (flags & 0x80) !== 0;
  const sizeBytes = flags & 0x07;
  const offBytes = buffer[5];
  let offset = 6;
  const readBig = (n: number): number => {
    let value = 0;
    for (let i = 0; i < n; i++) value = value * 256 + buffer[offset++];
    return value;
  };
  const cellsNum = readBig(sizeBytes);
  readBig(sizeBytes); // roots_num
  readBig(sizeBytes); // absent
  readBig(offBytes); // tot_size
  const rootIndex = readBig(sizeBytes);
  if (hasIndex) offset += cellsNum * offBytes;
  if (cellsNum <= 0 || cellsNum > 512) throw new Error('BOC cells 数量异常：' + cellsNum);
  const refBytes = Math.max(1, Math.ceil(bitLengthOfNumber(cellsNum) / 8));
  const cells: BocCell[] = [];
  for (let index = 0; index < cellsNum; index++) {
    if (offset + 2 > buffer.byteLength) throw new Error('BOC 数据截断（cell 头）');
    const d1 = buffer[offset++];
    const d2 = buffer[offset++];
    const refs = d1 & 0x07;
    const level = (d1 >> 5) & 0x07;
    const special = (d1 & 0x08) !== 0;
    const withHashes = (d1 & 0x10) !== 0;
    if (withHashes) throw new Error('不支持 with_hashes 的 BOC cell');
    if (refs > 4) throw new Error('BOC cell refs 超过 4');
    const dataLen = (d2 >> 1) + (d2 & 1);
    const dataWithBits = (d2 & 1) !== 0;
    if (offset + dataLen > buffer.byteLength) throw new Error('BOC 数据截断（cell 数据）');
    const data = buffer.subarray(offset, offset + dataLen);
    offset += dataLen;
    const refIndexes: number[] = [];
    for (let ref = 0; ref < refs; ref++) refIndexes.push(readBig(refBytes));
    let bitLen: number;
    if (dataWithBits) {
      const last = data[dataLen - 1];
      if (!(last & 0x7f)) throw new Error('BOC cell 位长编码非法（末字节无有效位）');
      bitLen = (dataLen - 1) * 8 + 7 - countTrailingZeroes(last & 0x7f);
    } else {
      bitLen = dataLen * 8;
    }
    cells.push({ d1, d2, refs, level, special, data, bitLen, refIndexes });
  }
  return { cells, rootIndex: rootIndex < cells.length ? rootIndex : 0 };
}

/** 解析 base64 编码的 BOC，返回根 cell。 */
export function rootCellFromBase64(b64: string): BocCell {
  const bag = parseBocBytes(base64ToBytes(b64));
  const cell = bag.cells[bag.rootIndex];
  if (!cell) throw new Error('BOC 根 cell 缺失');
  return cell;
}

/** 位读取器（只读单 cell 的 data，不自动跟随 refs）。 */
export class BitReader {
  private readonly data: Uint8Array;
  private readonly bitLen: number;
  private pos = 0;

  constructor(cell: BocCell) {
    this.data = cell.data;
    this.bitLen = cell.bitLen;
  }

  get position(): number {
    return this.pos;
  }

  get remaining(): number {
    return this.bitLen - this.pos;
  }

  /** 读无符号大端整数。 */
  u(bits: number): bigint {
    if (bits < 0 || bits > 256) throw new Error('位读取长度非法：' + bits);
    if (this.pos + bits > this.bitLen) throw new Error('位读取越界（需要 ' + bits + '，剩余 ' + this.remaining + '）');
    let value = 0n;
    for (let i = 0; i < bits; i++) {
      const byte = this.data[this.pos >> 3] ?? 0;
      const bit = (byte >> (7 - (this.pos & 7))) & 1;
      value = (value << 1n) | BigInt(bit);
      this.pos++;
    }
    return value;
  }

  /** 读 n 位无符号数（返回 number，仅用于短字段）。 */
  uNumber(bits: number): number {
    return Number(this.u(bits));
  }

  /** 读布尔（1 bit）。 */
  bool(): boolean {
    return this.u(1) === 1n;
  }

  skip(bits: number): void {
    if (this.pos + bits > this.bitLen) throw new Error('位跳过越界');
    this.pos += bits;
  }

  /** 读 MsgAddressInt（267 bit：2 bit 标记 + 1 bit anycast + 8 bit workchain + 256 bit hash）。 */
  address(): { workchain: number; hashHex: string; raw: string } {
    const tag = this.u(2);
    if (tag !== 2n) throw new Error('地址标记不是 0b10（实际 ' + tag.toString() + '）');
    const anycast = this.u(1);
    if (anycast === 1n) this.skip(8);
    const wcRaw = this.uNumber(8);
    const workchain = wcRaw > 127 ? wcRaw - 256 : wcRaw;
    const hash = this.u(256);
    let hashHex = hash.toString(16).padStart(64, '0');
    return { workchain, hashHex, raw: workchain + ':' + hashHex };
  }
}

/** 位写入器（构造 cell 数据用）。 */
export class BitWriter {
  private bits: number[] = [];

  /** 写无符号大端整数。 */
  u(value: bigint | number, bits: number): this {
    let rest = typeof value === 'bigint' ? value : BigInt(value);
    if (rest < 0n) rest = (1n << BigInt(bits)) + rest;
    for (let i = bits - 1; i >= 0; i--) this.bits.push(Number((rest >> BigInt(i)) & 1n));
    return this;
  }

  /**
   * 写 MsgAddressInt（267 bit），并追加 1 位哨兵。
   * TON 的 BOC d2 位长还原公式对"末字节尾部为 0"的 cell 会少算位数（实测 267 位地址会被还原成 264~266 位），
   * 追加 1 位后 BOC 还原正好 267 位，TVM 读到的仍是完整地址（多出的哨兵位不参与 loadAddress）。
   * 实测链上真实地址 cell 也是 268 位存储、还原为 267 位。
   */
  address(address: { workchain: number; hashHex: string }): this {
    this.u(2n, 2); // tag 10
    this.u(0n, 1); // anycast none
    this.u(address.workchain, 8);
    const hash = BigInt('0x' + address.hashHex);
    this.u(hash, 256);
    this.u(1n, 1); // 哨兵位（见上）
    return this;
  }

  get bitLen(): number {
    return this.bits.length;
  }

  /** 打包为字节（末字节补零）。 */
  toBytes(): Uint8Array {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8));
    for (let i = 0; i < this.bits.length; i++) {
      if (this.bits[i]) out[i >> 3] |= 0x80 >> (i & 7);
    }
    return out;
  }
}

/**
 * 把单个 cell（无 refs）序列化成 BOC base64，用作 runGetMethod 的 slice 参数。
 * 头部长度固定 11 字节：magic(4) + flags(1) + off_bytes(1) + cells(1) + roots(1) + absent(1) + tot_size(1) + root_idx(1)。
 */
export function buildSingleCellBoc(writer: BitWriter): string {
  const bitLen = writer.bitLen;
  const data = writer.toBytes();
  const dataLen = data.length;
  const d2 = bitLen % 8 === 0 ? dataLen * 2 : (dataLen - 1) * 2 + 1;
  const cellSize = 2 + dataLen;
  const body = new Uint8Array(11 + cellSize);
  let offset = 0;
  body[offset++] = 0xb5;
  body[offset++] = 0xee;
  body[offset++] = 0x9c;
  body[offset++] = 0x72;
  body[offset++] = 0x01; // flags：size_bytes=1，无 index / 无 crc32
  body[offset++] = 0x01; // off_bytes
  body[offset++] = 0x01; // cells_num
  body[offset++] = 0x01; // roots_num
  body[offset++] = 0x00; // absent
  body[offset++] = cellSize; // tot_cells_size（off_bytes=1）
  body[offset++] = 0x00; // root index
  body[offset++] = 0x00; // d1：无 refs / 非 exotic / level 0
  body[offset++] = d2;
  body.set(data, offset);
  return bytesToBase64(body);
}

/**
 * 用「原始 cell 数据 + 精确位长」构造只读 cell。
 * toncenter 的 stack cell 同时给 BOC（bytes）与 object.data.b64 + object.data.len，
 * BOC 的 d2 编码对末尾 0 比特会丢失精确位长，因此地址/切片优先用 object.data.len。
 */
export function cellFromRawData(rawBase64: string, bitLen: number): BocCell {
  const data = base64ToBytes(rawBase64);
  return { d1: 0, d2: 0, refs: 0, level: 0, special: false, data, bitLen, refIndexes: [] };
}

/** SHA-256（WebCrypto；workerd 与 node 都可用）。 */
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  // 复制成独立 ArrayBuffer，避免 Uint8Array<ArrayBufferLike> 与 BufferSource 的类型冲突（workerd/node 同源）。
  const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return new Uint8Array(digest);
}

/** SHA-256 十六进制。 */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  return bytesToHex(await sha256(data));
}

/**
 * 单个普通 cell 的哈希（无 refs）：sha256(d1 d2 data)。
 * d1=0（无 refs / 无 level / 非 exotic）；d2 按 boc.cpp 口径还原。
 */
export async function simpleCellHash(data: Uint8Array, bitLen: number): Promise<Uint8Array> {
  const dataLen = data.length;
  const d2 = bitLen % 8 === 0 ? dataLen * 2 : (dataLen - 1) * 2 + 1;
  const payload = new Uint8Array(2 + dataLen);
  payload[0] = 0;
  payload[1] = d2;
  payload.set(data, 2);
  return sha256(payload);
}

/**
 * 合约 V8 的 K 线滚动哈希：H(prevHash256 ‖ candleIndex8 ‖ twap128 ‖ digest256)。
 * 输入 cell = 648 bit / 81 字节（无 refs），与 RoundController submitCandle 完全同口径。
 */
export async function rollingCandleHash(
  prevHash: Uint8Array,
  candleIndex: number,
  twapUsdE8: bigint,
  dataDigest: bigint,
): Promise<Uint8Array> {
  const data = new Uint8Array(81);
  data.set(prevHash.subarray(0, 32), 0);
  data[32] = candleIndex & 0xff;
  data.set(bigIntToBytes(twapUsdE8, 16), 33);
  data.set(bigIntToBytes(dataDigest, 32), 49);
  return simpleCellHash(data, 648);
}

/** 失败轮 burnId：H(roundId8 ‖ 0xff8 ‖ configVersion32)（RoundController.burnIdForRound 同口径）。 */
export async function failureBurnId(roundId: number, configVersion: number): Promise<Uint8Array> {
  const data = new Uint8Array(6);
  data[0] = roundId & 0xff;
  data[1] = 0xff;
  data[2] = (configVersion >>> 24) & 0xff;
  data[3] = (configVersion >>> 16) & 0xff;
  data[4] = (configVersion >>> 8) & 0xff;
  data[5] = configVersion & 0xff;
  return simpleCellHash(data, 48);
}

/** 供 CRC 复算：对 BOC 原始字节追加/校验 CRC16（仅调试用）。 */
export function bocCrc16(bytes: Uint8Array): number {
  return crc16(bytes);
}
