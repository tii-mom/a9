/**
 * 累计军饷清单的 Merkle 树（docs/35 §4.4；供链上 claim 合约校验，编码必须与合约一致）。
 *
 * ==== 编码（精确定义，改动即破坏已发布清单）====
 *
 * 叶子（leaf）
 *   leaf = SHA-256( wallet_workchain:int8 ‖ wallet_hash:uint256 ‖ cumulative_amount:uint128 )
 *     - wallet_workchain：1 字节，二进制补码（0 → 0x00，-1 → 0xff）；
 *     - wallet_hash：32 字节，大端，即 TON 账户 hash（raw 形式 `<wc>:<64位hex>` 的后半段）；
 *     - cumulative_amount：16 字节，大端，raw 单位（A9 为 9 位小数），该钱包的「终身累计军饷」；
 *     - 原文拼接共 1 + 32 + 16 = 49 字节；叶子不含 index。
 *
 * 树
 *   - 叶子按「叶子哈希」字节序升序排列；叶子下标 index 即排序后的位置（0 基）；
 *   - 父节点 = SHA-256( min(a, b) ‖ max(a, b) )，min/max 按字节序比较（排序对哈希，无方向位）；
 *   - 某层节点数为奇数时，最后一个节点原样晋级到上一层（不与自身配对）；
 *   - 根 = 最顶层唯一节点；单叶子树的根即该叶子；空清单的根为 32 个 0 字节。
 *
 * 证明（proof）
 *   - proof = 兄弟节点哈希数组（小写 hex），自底向上；晋级的那一层没有兄弟，因此不出现在数组里；
 *   - 校验需要 index（排序后下标）与 leafCount（叶子总数）来判断哪些层发生了晋级，二者随 proof 一起返回。
 *
 * 校验算法（链上 / 外部复算）
 *   h = leaf; pos = index; m = leafCount; k = 0
 *   while m > 1:
 *     if pos == m - 1 and m is odd:  // 晋级，无兄弟
 *     else:                          h = SHA-256(sort2(h, proof[k])); k++
 *     pos = floor(pos / 2); m = ceil(m / 2)
 *   accept iff k == proof.length and h == root
 *
 * 本文件只做纯计算（使用 Web Crypto，Workers 与 Node 均可用），不读写数据库。
 */

export const LEAF_PREIMAGE_BYTES = 49;

export interface MerkleLeafInput {
  /** TON workchain（-1 或 0 等，取值 -128..127） */
  workchain: number;
  /** 账户 hash：64 位 hex（大小写均可，内部统一为小写） */
  hashHex: string;
  /** 终身累计军饷（raw，0 ≤ x < 2^128） */
  cumulativeRaw: bigint;
}

export interface MerkleTree {
  root: Uint8Array;
  /** levels[0] = 排序后的叶子哈希；最后一层长度为 1（空树时为空数组） */
  levels: Uint8Array[][];
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error('merkle: 非法 hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** 字节序比较（长度相同时等价于大端整数比较）。 */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/** 叶子原文（49 字节），见文件头编码定义。 */
export function leafPreimage(input: MerkleLeafInput): Uint8Array {
  if (!Number.isInteger(input.workchain) || input.workchain < -128 || input.workchain > 127) {
    throw new Error(`merkle: workchain 超出 int8 范围：${input.workchain}`);
  }
  if (!/^[0-9a-fA-F]{64}$/.test(input.hashHex)) throw new Error('merkle: wallet_hash 必须是 64 位 hex');
  if (input.cumulativeRaw < 0n || input.cumulativeRaw >= 1n << 128n) {
    throw new Error('merkle: cumulative_amount 超出 uint128 范围');
  }
  const out = new Uint8Array(LEAF_PREIMAGE_BYTES);
  out[0] = input.workchain & 0xff;
  out.set(fromHex(input.hashHex.toLowerCase()), 1);
  let amount = input.cumulativeRaw;
  for (let i = LEAF_PREIMAGE_BYTES - 1; i >= 33; i--) {
    out[i] = Number(amount & 0xffn);
    amount >>= 8n;
  }
  return out;
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

export async function leafHashOf(input: MerkleLeafInput): Promise<Uint8Array> {
  return sha256(leafPreimage(input));
}

/** 父节点：SHA-256(min ‖ max)。 */
export async function pairHash(a: Uint8Array, b: Uint8Array): Promise<Uint8Array> {
  const [lo, hi] = compareBytes(a, b) <= 0 ? [a, b] : [b, a];
  const joined = new Uint8Array(lo.length + hi.length);
  joined.set(lo, 0);
  joined.set(hi, lo.length);
  return sha256(joined);
}

/**
 * 由已排序的叶子哈希构建整棵树。调用方须保证 leaves 已按 compareBytes 升序排列。
 */
export async function buildMerkleTree(leaves: readonly Uint8Array[]): Promise<MerkleTree> {
  if (leaves.length === 0) return { root: new Uint8Array(32), levels: [] };
  const levels: Uint8Array[][] = [[...leaves]];
  while (levels[levels.length - 1].length > 1) {
    const current = levels[levels.length - 1];
    const next: Uint8Array[] = [];
    for (let i = 0; i < current.length; i += 2) {
      next.push(i + 1 < current.length ? await pairHash(current[i], current[i + 1]) : current[i]);
    }
    levels.push(next);
  }
  return { root: levels[levels.length - 1][0], levels };
}

/** 第 index 片叶子的兄弟哈希数组（自底向上，晋级层省略）。 */
export function merkleProof(tree: MerkleTree, index: number): Uint8Array[] {
  const siblings: Uint8Array[] = [];
  let pos = index;
  for (let level = 0; level < tree.levels.length - 1; level++) {
    const nodes = tree.levels[level];
    const sibling = pos % 2 === 0 ? pos + 1 : pos - 1;
    if (sibling < nodes.length) siblings.push(nodes[sibling]);
    pos = Math.floor(pos / 2);
  }
  return siblings;
}

/** 按文件头的校验算法复算根并比较。 */
export async function verifyMerkleProof(
  leaf: Uint8Array,
  siblings: readonly Uint8Array[],
  index: number,
  leafCount: number,
  root: Uint8Array,
): Promise<boolean> {
  if (leafCount <= 0 || index < 0 || index >= leafCount) return false;
  let hash = leaf;
  let pos = index;
  let size = leafCount;
  let used = 0;
  while (size > 1) {
    const promoted = pos === size - 1 && size % 2 === 1;
    if (!promoted) {
      if (used >= siblings.length) return false;
      hash = await pairHash(hash, siblings[used]);
      used++;
    }
    pos = Math.floor(pos / 2);
    size = Math.ceil(size / 2);
  }
  return used === siblings.length && compareBytes(hash, root) === 0;
}
