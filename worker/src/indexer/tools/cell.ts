/**
 * 最小 cell 构造器（开发者工具：单测 / 合成 fixture 用，不参与 worker 运行时）。
 * 与 boc.ts 的 BitWriter 不同：地址不追加哨兵位，BOC 按标准写完成标记（1 后补 0），支持 refs。
 */
import { bytesToBase64 } from '../boc';

export class CellBuilder {
  readonly bits: number[] = [];
  readonly refs: CellBuilder[] = [];

  u(value: bigint | number, bits: number): this {
    let rest = typeof value === 'bigint' ? value : BigInt(value);
    if (rest < 0n) rest = (1n << BigInt(bits)) + rest;
    for (let i = bits - 1; i >= 0; i--) this.bits.push(Number((rest >> BigInt(i)) & 1n));
    return this;
  }

  bool(value: boolean): this {
    return this.u(value ? 1 : 0, 1);
  }

  /** MsgAddressInt addr_std（267 bit，无哨兵）。 */
  address(raw: string): this {
    const [wc, hash] = raw.split(':');
    this.u(2, 2).u(0, 1).u(Number(wc), 8).u(BigInt('0x' + hash), 256);
    return this;
  }

  /** TL-B coins（VarUInteger 16）。 */
  coins(value: bigint): this {
    if (value === 0n) return this.u(0, 4);
    const bytes = Math.ceil(value.toString(16).length / 2);
    return this.u(bytes, 4).u(value, bytes * 8);
  }

  ref(child: CellBuilder): this {
    this.refs.push(child);
    return this;
  }

  /** 数据字节（带完成标记）与 d2。 */
  serializeData(): { data: Uint8Array; d2: number } {
    const bitLen = this.bits.length;
    const full = bitLen % 8 === 0;
    const bytes = Math.ceil(bitLen / 8) + (full ? 0 : 0);
    const data = new Uint8Array(full ? bitLen / 8 : bytes);
    for (let i = 0; i < bitLen; i++) if (this.bits[i]) data[i >> 3] |= 0x80 >> (i & 7);
    if (!full) data[bitLen >> 3] |= 0x80 >> (bitLen & 7);
    const d2 = Math.floor(bitLen / 8) + Math.ceil(bitLen / 8);
    return { data, d2 };
  }

  /** 原始数据（无完成标记）base64 + 位长：toncenter stack object.data 形态。 */
  rawData(): { b64: string; len: number } {
    const data = new Uint8Array(Math.ceil(this.bits.length / 8));
    for (let i = 0; i < this.bits.length; i++) if (this.bits[i]) data[i >> 3] |= 0x80 >> (i & 7);
    return { b64: bytesToBase64(data), len: this.bits.length };
  }

  /** 序列化为 BOC base64（无 index / 无 crc；cells 按 DFS 先序，根在 0）。 */
  toBoc(): string {
    const order: CellBuilder[] = [];
    const visit = (cell: CellBuilder): void => {
      order.push(cell);
      for (const child of cell.refs) visit(child);
    };
    visit(this);
    const parts: number[] = [];
    for (const cell of order) {
      const { data, d2 } = cell.serializeData();
      parts.push(cell.refs.length, d2, ...data);
      for (const child of cell.refs) parts.push(order.indexOf(child));
    }
    const header = [0xb5, 0xee, 0x9c, 0x72, 0x01, 0x02, order.length, 1, 0, (parts.length >> 8) & 0xff, parts.length & 0xff, 0];
    return bytesToBase64(new Uint8Array([...header, ...parts]));
  }
}

export function cell(): CellBuilder {
  return new CellBuilder();
}
