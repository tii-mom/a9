/**
 * 最小 TON Cell / BOC 序列化（自包含，不引入 @ton/core 依赖）。
 * 参考 TON 规范与 ton-core（MIT）实现，仅保留本项目需要的子集：
 *   - 位串构建（writeUint / writeVarUint / writeAddress / ref）
 *   - BOC（bag of cells）序列化，无索引、无 CRC（TON 节点与钱包均可解析）
 *
 * 只用于构造 TON Connect 的 payload（交易消息体），不用于签名与网络传输。
 */

import { base64Decode, base64Encode, type TonAddress } from './address';

/** 不可变 cell：位串 + 最多 4 个子 cell 引用。 */
export class ChainCell {
  readonly bits: Uint8Array;
  readonly bitLength: number;
  readonly refs: ChainCell[];

  constructor(bits: Uint8Array, bitLength: number, refs: ChainCell[] = []) {
    this.bits = bits;
    this.bitLength = bitLength;
    this.refs = refs;
  }

  get empty(): boolean {
    return this.bitLength === 0 && this.refs.length === 0;
  }
}

/** 位串构建器。 */
export class CellBuilder {
  private readonly bits: number[] = [];
  private readonly refs: ChainCell[] = [];

  get length(): number {
    return this.bits.length;
  }

  writeBit(value: boolean | number): this {
    this.bits.push(value === true || Number(value) > 0 ? 1 : 0);
    return this;
  }

  /** 写入无符号整数（MSB first）。 */
  writeUint(value: bigint | number | string, bitCount: number): this {
    if (!Number.isSafeInteger(bitCount) || bitCount < 0) throw new Error('非法位宽: ' + bitCount);
    let v = BigInt(value);
    if (bitCount === 0) {
      if (v !== 0n) throw new Error('位宽为 0 但值非 0');
      return this;
    }
    if (v < 0n) throw new Error('writeUint 不接受负数');
    if (v >= 1n << BigInt(bitCount)) throw new Error('值 ' + v + ' 超出 ' + bitCount + ' bit');
    for (let i = bitCount - 1; i >= 0; i -= 1) {
      this.bits.push(Number((v >> BigInt(i)) & 1n));
    }
    return this;
  }

  /** 写入有符号整数（补码，MSB first）。 */
  writeInt(value: bigint | number | string, bitCount: number): this {
    let v = BigInt(value);
    const min = -(1n << BigInt(bitCount - 1));
    const max = (1n << BigInt(bitCount - 1)) - 1n;
    if (v < min || v > max) throw new Error('值 ' + v + ' 超出 ' + bitCount + ' bit 有符号范围');
    if (v < 0n) v += 1n << BigInt(bitCount);
    return this.writeUint(v, bitCount);
  }

  /** 可变长度无符号整数（TON Coins / VarUint16 格式）。 */
  writeVarUint(value: bigint | number | string, headerBits: number): this {
    let v = BigInt(value);
    if (v < 0n) throw new Error('writeVarUint 不接受负数');
    if (v === 0n) return this.writeUint(0, headerBits);
    const bitLength = v.toString(2).length;
    const sizeBytes = Math.ceil(bitLength / 8);
    this.writeUint(sizeBytes, headerBits);
    return this.writeUint(v, sizeBytes * 8);
  }

  /** TON Coins（VarUint16，头 4 bit 表示字节数）。 */
  writeCoins(amount: bigint | number | string): this {
    return this.writeVarUint(amount, 4);
  }

  /** 写入 TON 地址（内部地址：10 + anycast 0 + 8 bit workchain + 256 bit hash）。 */
  writeAddress(address: TonAddress | null): this {
    if (!address) return this.writeUint(0, 2);
    this.writeUint(2, 2); // 内部地址
    this.writeUint(0, 1); // anycast = none
    this.writeInt(address.workchain, 8);
    const hash = address.hashHex.toLowerCase();
    if (hash.length !== 64) throw new Error('地址 hash 长度非法');
    for (let i = 0; i < 64; i += 2) {
      this.writeUint(Number.parseInt(hash.slice(i, i + 2), 16), 8);
    }
    return this;
  }

  /** 追加子 cell 引用（最多 4 个）。 */
  ref(cell: ChainCell): this {
    if (this.refs.length >= 4) throw new Error('一个 cell 最多 4 个引用');
    this.refs.push(cell);
    return this;
  }

  /** 完成构建。 */
  end(): ChainCell {
    const byteLength = Math.ceil(this.bits.length / 8);
    const bytes = new Uint8Array(byteLength);
    for (let i = 0; i < this.bits.length; i += 1) {
      if (this.bits[i]) bytes[i >> 3] |= 1 << (7 - (i % 8));
    }
    return new ChainCell(bytes, this.bits.length, this.refs);
  }
}

/** 新建构建器（链式调用）。 */
export function beginCell(): CellBuilder {
  return new CellBuilder();
}

/**
 * 填充到字节边界：TON 的 cell 数据在 BOC 中以「补齐位」结尾——
 * 若最后有不足 8 bit 的空位，先在第一个空位写 1，其余写 0。
 */
function paddedBits(cell: ChainCell): Uint8Array {
  const byteLength = Math.ceil(cell.bitLength / 8);
  const out = new Uint8Array(byteLength);
  out.set(cell.bits.subarray(0, byteLength));
  const padding = byteLength * 8 - cell.bitLength;
  if (padding > 0) {
    // 第一个补齐位 = 1
    out[cell.bitLength >> 3] |= 1 << (7 - (cell.bitLength % 8));
  }
  return out;
}

/** ref 描述符：低 2 bit = 引用数（普通 cell 其余位为 0）。 */
function refsDescriptor(cell: ChainCell): number {
  return cell.refs.length;
}

/** 位描述符：ceil(len/8) + floor(len/8)。 */
function bitsDescriptor(cell: ChainCell): number {
  return Math.ceil(cell.bitLength / 8) + Math.floor(cell.bitLength / 8);
}

/** 无符号整数的二进制位长度（0 → 1）。 */
function bitsForNumber(value: number): number {
  return value <= 0 ? 1 : value.toString(2).length;
}

/** 前序遍历收集 cell（父在前、子在后，引用可指向后面的 cell）。 */
function collectCells(root: ChainCell): { cell: ChainCell; refIndexes: number[] }[] {
  const order: ChainCell[] = [];
  const mapping = new Map<ChainCell, number>();

  const visit = (cell: ChainCell): number => {
    const existing = mapping.get(cell);
    if (existing !== undefined) return existing;
    const index = order.length;
    order.push(cell);
    mapping.set(cell, index);
    // 预先占位，递归后回填引用索引
    return index;
  };

  visit(root);
  const result: { cell: ChainCell; refIndexes: number[] }[] = [];
  for (let i = 0; i < order.length; i += 1) {
    const cell = order[i];
    const refIndexes = cell.refs.map((ref) => visit(ref));
    result.push({ cell, refIndexes });
  }
  return result;
}

/**
 * BOC 序列化（无 index / 无 CRC）。
 * header: magic(32) + has_idx(1) + has_crc(1) + has_cache(1) + flags(2) + size_bytes(3)
 *         + offset_bytes(8) + cells(size_b) + roots(size_b) + absent(size_b)
 *         + total_cell_size(offset_b) + root_id(size_b)
 */
export function serializeCellToBoc(root: ChainCell): Uint8Array {
  const cells = collectCells(root);
  const cellsNum = cells.length;
  const sizeBytes = Math.max(Math.ceil(bitsForNumber(cellsNum) / 8), 1);

  const cellSize = (cell: ChainCell): number => 2 + Math.ceil(cell.bitLength / 8) + cell.refs.length * sizeBytes;
  let totalCellSize = 0;
  for (const entry of cells) totalCellSize += cellSize(entry.cell);
  const offsetBytes = Math.max(Math.ceil(bitsForNumber(totalCellSize) / 8), 1);

  const headerBits =
    32 + // magic
    (1 + 1 + 1 + 2) + // has_idx / has_crc / has_cache / flags
    3 + // size bytes
    8 + // offset bytes
    sizeBytes * 8 * 3 + // cells / roots / absent
    offsetBytes * 8 + // total cell size
    sizeBytes * 8 + // root id
    totalCellSize * 8; // 所有 cell 的序列化数据

  const builder = beginCell();
  builder.writeUint(0xb5ee9c72, 32);
  builder.writeBit(0); // has_idx
  builder.writeBit(0); // has_crc32c
  builder.writeBit(0); // has_cache_bits
  builder.writeUint(0, 2); // flags
  builder.writeUint(sizeBytes, 3); // size
  builder.writeUint(offsetBytes, 8); // offset bytes
  builder.writeUint(cellsNum, sizeBytes * 8);
  builder.writeUint(1, sizeBytes * 8); // roots
  builder.writeUint(0, sizeBytes * 8); // absent
  builder.writeUint(totalCellSize, offsetBytes * 8); // total cell size
  builder.writeUint(0, sizeBytes * 8); // root id

  for (const entry of cells) {
    builder.writeUint(refsDescriptor(entry.cell), 8);
    builder.writeUint(bitsDescriptor(entry.cell), 8);
    const padded = paddedBits(entry.cell);
    for (let i = 0; i < padded.length; i += 1) builder.writeUint(padded[i], 8);
    for (const refIndex of entry.refIndexes) builder.writeUint(refIndex, sizeBytes * 8);
  }

  // 内部对齐检查：BOC 必须整字节
  const bits = builder.length;
  if (bits !== headerBits) throw new Error('BOC 长度计算错误 ' + bits + ' != ' + headerBits);
  return finishBytes(builder.end());
}

function finishBytes(cell: ChainCell): Uint8Array {
  return cell.bits;
}

/** Cell → base64 的 BOC（TON Connect payload 用标准 base64）。 */
export function toBocBase64(cell: ChainCell): string {
  return base64Encode(serializeCellToBoc(cell));
}

/** 仅供测试/调试：cell 的位串 hex 视图。 */
export function cellBitsHex(cell: ChainCell): string {
  let out = '';
  for (let i = 0; i < cell.bitLength; i += 1) {
    out += (cell.bits[i >> 3] >> (7 - (i % 8))) & 1 ? '1' : '0';
  }
  return out;
}
/* ------------------------------------------------------------------ */
/* BOC 解析（最小实现：无 exotic / 无 CRC 校验，支持 index）           */
/* 用于解析 toncenter/tonapi 返回的消息 body（领取回执 / Jetton 通知）  */
/* ------------------------------------------------------------------ */

/** 解析后的 cell（位串 + 子 cell）。 */
export interface ParsedCell {
  bits: number[];
  refs: ParsedCell[];
}

class ByteReader {
  private readonly bytes: Uint8Array;
  private offset = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  readUint(byteCount: number): number {
    let value = 0;
    for (let i = 0; i < byteCount; i += 1) value = value * 256 + this.bytes[this.offset + i];
    this.offset += byteCount;
    return value;
  }

  readBytes(count: number): Uint8Array {
    const out = this.bytes.subarray(this.offset, this.offset + count);
    this.offset += count;
    return out;
  }

  skip(count: number): void {
    this.offset += count;
  }
}

function bytesToBitArray(bytes: Uint8Array, bitLength: number): number[] {
  const bits: number[] = new Array(bitLength);
  for (let i = 0; i < bitLength; i += 1) bits[i] = (bytes[i >> 3] >> (7 - (i % 8))) & 1;
  return bits;
}

/** 去掉补齐位：找到最后一个非零字节里最靠右的 1（那是第一个补齐位）。 */
function paddedByteLengthToBits(bytes: Uint8Array): number {
  for (let i = bytes.length - 1; i >= 0; i -= 1) {
    if (bytes[i] !== 0) {
      const testByte = bytes[i];
      let bitPos = testByte & -testByte;
      if ((bitPos & 1) === 0) bitPos = Math.log2(bitPos) + 1;
      return i * 8 + (8 - bitPos);
    }
  }
  return 0;
}

const BOC_MAGIC = 0xb5ee9c72;

/** 解析 BOC（单 root 或多 root），返回根 cell 列表。 */
export function parseBocBytes(bytes: Uint8Array): ParsedCell[] {
  const reader = new ByteReader(bytes);
  if (reader.readUint(4) !== BOC_MAGIC) throw new Error('不是合法的 BOC');
  const flagsByte = reader.readUint(1);
  // 位序（MSB first）：has_idx(1) | has_crc32c(1) | has_cache_bits(1) | flags(2) | size(3)
  const hasIndex = (flagsByte & 0x80) !== 0;
  const hasCrc = (flagsByte & 0x40) !== 0;
  const sizeBytes = flagsByte & 0x07;
  const offsetBytes = reader.readUint(1);
  const cellsNum = reader.readUint(sizeBytes);
  const rootsNum = reader.readUint(sizeBytes);
  reader.readUint(sizeBytes); // absent
  reader.readUint(offsetBytes); // total cell size
  const rootIndexes: number[] = [];
  for (let i = 0; i < rootsNum; i += 1) rootIndexes.push(reader.readUint(sizeBytes));
  if (hasIndex) reader.skip(cellsNum * offsetBytes);
  if (hasCrc) {
    // CRC 在文件末尾，忽略（不校验）
  }

  // 第一遍：顺序读取所有 cell 的描述与引用索引（引用可以指向后面的 cell，需两遍解析）
  const raw: { bits: number[]; refIndexes: number[] }[] = [];
  for (let i = 0; i < cellsNum; i += 1) {
    const d1 = reader.readUint(1);
    const refsCount = d1 & 7;
    const levelMask = d1 >> 5;
    const hasHashes = (d1 & 16) !== 0;
    const d2 = reader.readUint(1);
    const dataBytes = Math.ceil(d2 / 2);
    const paddingAdded = d2 % 2 === 1;
    if (hasHashes) {
      let hashesCount = 0;
      let mask = levelMask & 7;
      for (let b = 0; b < 3; b += 1) {
        hashesCount += mask & 1;
        mask >>= 1;
      }
      hashesCount += 1;
      reader.skip(hashesCount * 32 + hashesCount * 2);
    }
    const data = reader.readBytes(dataBytes);
    const bitLength = paddingAdded ? paddedByteLengthToBits(data) : dataBytes * 8;
    const bits = bytesToBitArray(data, bitLength);
    const refIndexes: number[] = [];
    for (let r = 0; r < refsCount; r += 1) refIndexes.push(reader.readUint(sizeBytes));
    raw.push({ bits, refIndexes });
  }

  // 第二遍：解析引用
  const cells: ParsedCell[] = raw.map((entry) => ({ bits: entry.bits, refs: [] }));
  for (let i = 0; i < raw.length; i += 1) {
    for (const refIndex of raw[i].refIndexes) {
      const target = cells[refIndex];
      if (!target) throw new Error('BOC 引用索引越界: ' + refIndex);
      cells[i].refs.push(target);
    }
  }
  return rootIndexes.map((index) => {
    const root = cells[index];
    if (!root) throw new Error('BOC root 索引越界: ' + index);
    return root;
  });
}

/** base64（兼容 url-safe）→ BOC 根 cell。 */
export function parseBocBase64(value: string): ParsedCell[] {
  const normalized = String(value ?? '').trim();
  if (!normalized) return [];
  return parseBocBytes(base64Decode(normalized));
}

/** 位读取器（对 ParsedCell 的顺序读取）。 */
export class CellSlice {
  private readonly cell: ParsedCell;
  private offset = 0;

  constructor(cell: ParsedCell) {
    this.cell = cell;
  }

  get remainingBits(): number {
    return this.cell.bits.length - this.offset;
  }

  get refs(): ParsedCell[] {
    return this.cell.refs;
  }

  skip(bits: number): void {
    this.offset += bits;
  }

  loadBit(): boolean {
    const bit = this.cell.bits[this.offset] ?? 0;
    this.offset += 1;
    return bit === 1;
  }

  loadUint(bits: number): bigint {
    let value = 0n;
    for (let i = 0; i < bits; i += 1) {
      value = (value << 1n) | BigInt(this.cell.bits[this.offset + i] ?? 0);
    }
    this.offset += bits;
    return value;
  }

  loadUintNumber(bits: number): number {
    return Number(this.loadUint(bits));
  }

  /** 取剩余未读位（用于解析内联 forward_payload）。 */
  readRemainingBits(): number[] {
    const rest = this.cell.bits.slice(this.offset);
    this.offset = this.cell.bits.length;
    return rest;
  }

  loadCoins(): bigint {
    const sizeBytes = Number(this.loadUint(4));
    if (sizeBytes === 0) return 0n;
    return this.loadUint(sizeBytes * 8);
  }

  /** 读取 MsgAddress（内部地址），返回 { workchain, hashHex } 或 null。 */
  loadAddress(): TonAddress | null {
    const tag = Number(this.loadUint(2));
    if (tag === 0) return null;
    if (tag !== 2) {
      // 外部地址或无 anycast 的内部地址：非本项目场景，直接放弃
      throw new Error('不支持的外部地址');
    }
    if (this.loadBit()) throw new Error('不支持 anycast 地址');
    const wcBits = Number(this.loadUint(8));
    const workchain = wcBits > 127 ? wcBits - 256 : wcBits;
    let hashHex = '';
    for (let i = 0; i < 32; i += 1) {
      hashHex += Number(this.loadUint(8)).toString(16).padStart(2, '0');
    }
    return { workchain, hashHex };
  }
}