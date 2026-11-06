/**
 * 累计清单 Merkle 树单测：编码（49 字节叶子）、根与证明用独立参考实现（WebCrypto，不引用被测代码）复算后逐叶校验。
 *
 * 运行（worker 目录）：npm run test:social
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTonAddress } from '../indexer/address';
import { aggregateJunxiang, layoutPayout, walletKeyOf, type PayoutEntry } from './payout';
import { fromHex, leafPreimage, LEAF_PREIMAGE_BYTES, leafHashOf, toHex, verifyMerkleProof } from './merkle';

/* ---------- 独立参考实现（只用 WebCrypto，不复用被测代码） ---------- */

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function refSha(...parts: Uint8Array[]): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', concatBytes(parts)));
}

function refCompare(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

function refHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function refPreimage(workchain: number, hashHex: string, amount: bigint): Uint8Array {
  const buf = new Uint8Array(49);
  buf[0] = workchain < 0 ? 256 + workchain : workchain;
  buf.set(refHex(hashHex), 1);
  let rest = amount;
  for (let i = 48; i >= 33; i--) {
    buf[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return buf;
}

async function refRoot(leaves: Uint8Array[]): Promise<Uint8Array> {
  if (leaves.length === 0) return new Uint8Array(32);
  let level = [...leaves].sort(refCompare);
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        const [lo, hi] = refCompare(level[i], level[i + 1]) <= 0 ? [level[i], level[i + 1]] : [level[i + 1], level[i]];
        next.push(await refSha(lo, hi));
      } else {
        next.push(level[i]);
      }
    }
    level = next;
  }
  return level[0];
}

/** 独立校验：按文件头算法逐层复算（另写一遍，不引用 verifyMerkleProof）。 */
async function refVerify(leaf: Uint8Array, proof: Uint8Array[], index: number, count: number, root: Uint8Array): Promise<boolean> {
  let hash = leaf;
  let pos = index;
  let size = count;
  let used = 0;
  while (size > 1) {
    if (!(pos === size - 1 && size % 2 === 1)) {
      const sib = proof[used++];
      if (!sib) return false;
      const [lo, hi] = refCompare(hash, sib) <= 0 ? [hash, sib] : [sib, hash];
      hash = await refSha(lo, hi);
    }
    pos = Math.floor(pos / 2);
    size = Math.ceil(size / 2);
  }
  return used === proof.length && refCompare(hash, root) === 0;
}

/* ---------- 测试辅助 ---------- */

function throwsMatching(fn: () => unknown, pattern: RegExp): void {
  try {
    fn();
  } catch (err) {
    assert.ok(pattern.test(String((err as Error).message ?? err)), `message ${String(err)} matches ${pattern}`);
    return;
  }
  throw new Error('expected to throw');
}

async function rejectsMatching(fn: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await fn();
  } catch (err) {
    assert.ok(pattern.test(String((err as Error).message ?? err)), `message ${String(err)} matches ${pattern}`);
    return;
  }
  throw new Error('expected to reject');
}

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

function randomHash(next: () => number): string {
  let out = '';
  for (let i = 0; i < 32; i++) out += (next() & 0xff).toString(16).padStart(2, '0');
  return out;
}

function entriesOf(count: number, seed: number): PayoutEntry[] {
  const next = lcg(seed);
  const out: PayoutEntry[] = [];
  for (let i = 0; i < count; i++) {
    const hashHex = randomHash(next);
    const amount = i === 0 ? (1n << 128n) - 1n : BigInt(next()) * 1_000_003n + BigInt(i);
    out.push({ wallet: `0:${hashHex}`, workchain: 0, hashHex, cumulativeRaw: amount });
  }
  return out;
}

/* ---------- 编码 ---------- */

test('叶子原文 49 字节：int8 workchain ‖ uint256 hash ‖ uint128 amount（大端）', () => {
  assert.equal(LEAF_PREIMAGE_BYTES, 49);
  const pre = leafPreimage({ workchain: -1, hashHex: 'ab'.repeat(32), cumulativeRaw: 256n });
  assert.equal(pre.length, 49);
  assert.equal(pre[0], 0xff, 'workchain -1 is 0xff');
  assert.equal(toHex(pre.subarray(1, 33)), 'ab'.repeat(32), 'hash');
  assert.equal(toHex(pre.subarray(33)), '00'.repeat(14) + '0100', 'amount 256 big-endian');
  assert.equal(leafPreimage({ workchain: 0, hashHex: '00'.repeat(32), cumulativeRaw: 0n })[0], 0x00, 'workchain 0');
});

test('叶子编码与参考实现逐字节一致', async () => {
  for (const entry of entriesOf(5, 7)) {
    const ours = leafPreimage(entry);
    const ref = refPreimage(entry.workchain, entry.hashHex, entry.cumulativeRaw);
    assert.equal(toHex(ours), toHex(ref));
    assert.equal(toHex(await leafHashOf(entry)), toHex(await refSha(ref)));
  }
});

test('叶子编码拒绝越界值', () => {
  throwsMatching(() => leafPreimage({ workchain: 0, hashHex: '00'.repeat(32), cumulativeRaw: 1n << 128n }), /uint128/);
  throwsMatching(() => leafPreimage({ workchain: 128, hashHex: '00'.repeat(32), cumulativeRaw: 0n }), /int8/);
  throwsMatching(() => leafPreimage({ workchain: 0, hashHex: 'zz', cumulativeRaw: 0n }), /hash/);
  throwsMatching(() => leafPreimage({ workchain: 0, hashHex: '00'.repeat(32), cumulativeRaw: -1n }), /uint128/);
});

/* ---------- 根与证明 ---------- */

test('单叶子：根即叶子，证明为空', async () => {
  const layout = await layoutPayout(entriesOf(1, 3));
  const leaf = fromHex(layout.items[0].leafHex);
  assert.equal(layout.rootHex, layout.items[0].leafHex);
  assert.deepEqual(layout.items[0].proof, []);
  assert.equal(await verifyMerkleProof(leaf, [], 0, 1, fromHex(layout.rootHex)), true);
});

test('空清单：根为 32 个 0 字节', async () => {
  const layout = await layoutPayout([]);
  assert.equal(layout.rootHex, '00'.repeat(32));
  assert.equal(layout.leafCount, 0);
});

test('多种叶子数（含奇数、2 的幂）：根与独立复算一致，每片叶子的证明都能校验', async () => {
  for (const count of [2, 3, 4, 5, 6, 7, 8, 9, 13, 16, 17, 33]) {
    const entries = entriesOf(count, count * 11);
    const layout = await layoutPayout(entries);
    const refLeaves: Uint8Array[] = [];
    for (const entry of entries) refLeaves.push(await refSha(refPreimage(entry.workchain, entry.hashHex, entry.cumulativeRaw)));
    assert.equal(layout.rootHex, toHex(await refRoot(refLeaves)), `root for n=${count}`);
    assert.equal(layout.leafCount, count);
    const root = fromHex(layout.rootHex);
    for (let position = 0; position < layout.items.length; position++) {
      const item = layout.items[position];
      assert.equal(item.index, position, 'index is sorted position');
      const leaf = fromHex(item.leafHex);
      assert.ok(await refVerify(leaf, item.proof.map(fromHex), item.index, count, root), `ref verify n=${count} idx=${item.index}`);
    }
  }
});

test('证明的反例：篡改金额、下标或证明都会失败', async () => {
  const layout = await layoutPayout(entriesOf(6, 99));
  const root = fromHex(layout.rootHex);
  const item = layout.items[2];
  const leaf = fromHex(item.leafHex);
  const proof = item.proof.map(fromHex);
  assert.equal(await verifyMerkleProof(leaf, proof, item.index, 6, root), true, 'honest');
  const bumped = item.cumulativeRaw === (1n << 128n) - 1n ? item.cumulativeRaw - 1n : item.cumulativeRaw + 1n;
  const tampered = await leafHashOf({ workchain: item.workchain, hashHex: item.hashHex, cumulativeRaw: bumped });
  assert.equal(await verifyMerkleProof(tampered, proof, item.index, 6, root), false, 'amount changed');
  // 下标只决定晋级层：与真实兄弟配对的下标互换不改变结果（排序对哈希），但会改变晋级结构时必须失败
  assert.equal(await verifyMerkleProof(leaf, proof, item.index ^ 1, 6, root), true, 'swap with sibling index is symmetric');
  const deep = layout.items[4];
  assert.equal(await verifyMerkleProof(fromHex(deep.leafHex), deep.proof.map(fromHex), 0, 6, root), false, 'index 0 expects 3 siblings');
  assert.equal(await verifyMerkleProof(leaf, proof, 6, 6, root), false, 'out of range');
  if (proof.length > 0) assert.equal(await verifyMerkleProof(leaf, proof.slice(1), item.index, 6, root), false, 'truncated');
});

test('证明长度：晋级层不计入证明（奇数节点原样上提）', async () => {
  // 5 叶：层大小 5 → 3 → 2 → 1。下标 0 每层都有兄弟（3 个）；下标 4 在前两层都是末尾奇数节点被晋级，只剩 1 个兄弟
  const layout = await layoutPayout(entriesOf(5, 5));
  assert.equal(layout.items[0].proof.length, 3, 'index 0 has a sibling at every level');
  assert.equal(layout.items[4].proof.length, 1, 'index 4 promoted twice');
});

test('钱包重复或地址非法时报错', async () => {
  const entries = entriesOf(2, 1);
  await rejectsMatching(() => layoutPayout([entries[0], entries[0]]), /重复/);
  throwsMatching(() => walletKeyOf('not-an-address'), /无法解析/);
});

/* ---------- 地址归一与累计 ---------- */

test('同一账户的友好地址与 raw 形式归并为同一键，金额累加', () => {
  const hashHex = 'cd'.repeat(32);
  const friendly = formatTonAddress(0, hashHex);
  const rows = aggregateJunxiang([
    { wallet: friendly, amountRaw: '100' },
    { wallet: `0:${hashHex}`, amountRaw: '50' },
    { wallet: friendly, amountRaw: 0n },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].wallet, `0:${hashHex}`);
  assert.equal(rows[0].cumulativeRaw, 150n);
});
