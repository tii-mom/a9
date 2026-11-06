/**
 * 军饷领取消息构造单测（纯函数）。
 * 参考实现独立于 cell.ts：位串与 cell 表示哈希（d1 d2 data depth hash）在本文件内手工拼装，
 * 再与 buildClaimJunxiangBody 的输出比较 cell 哈希。
 * 运行方式见 PR 说明：esbuild 打包后交给 node:test（与 web/src/features/social/__tests__ 相同）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { ChainCell } from '../cell';
import { serializeCellToBoc } from '../cell';
import type { ChainConfig } from '../config';
import { buildClaimJunxiangBody, buildProofCell, JUNXIANG_CLAIM_OP, prepareJunxiangClaimTransaction } from '../junxiang';

/* ---------------- 独立参考实现 ---------------- */

interface RefCell {
  bits: number[];
  refs: RefCell[];
}

function uintBits(value: bigint, width: number): number[] {
  const out: number[] = [];
  for (let i = width - 1; i >= 0; i -= 1) out.push(Number((value >> BigInt(i)) & 1n));
  return out;
}

function hashBits(hex: string): number[] {
  return uintBits(BigInt('0x' + hex), 256);
}

/** 把 cell.ts 产出的 ChainCell 还原成位数组（只读 bits / bitLength / refs）。 */
function fromChain(cell: ChainCell): RefCell {
  const bits: number[] = [];
  for (let i = 0; i < cell.bitLength; i += 1) bits.push((cell.bits[i >> 3] >> (7 - (i % 8))) & 1);
  return { bits, refs: cell.refs.map(fromChain) };
}

function depthOf(cell: RefCell): number {
  return cell.refs.length === 0 ? 0 : 1 + Math.max(...cell.refs.map(depthOf));
}

/** TON 普通 cell（level 0）表示哈希：d1 ‖ d2 ‖ data(补全标记) ‖ 子 cell depth ‖ 子 cell hash。 */
function representationHash(cell: RefCell): Buffer {
  const len = cell.bits.length;
  const bytes = new Array<number>(Math.ceil(len / 8)).fill(0);
  cell.bits.forEach((bit, i) => {
    if (bit) bytes[i >> 3] |= 0x80 >> (i & 7);
  });
  if (len % 8 !== 0) bytes[len >> 3] |= 0x80 >> (len & 7); // 补全标记：第一个空位置 1
  const d1 = cell.refs.length;
  const d2 = Math.ceil(len / 8) + Math.floor(len / 8);
  const parts: Buffer[] = [Buffer.from([d1, d2, ...bytes])];
  for (const ref of cell.refs) {
    const depth = depthOf(ref);
    parts.push(Buffer.from([depth >> 8, depth & 0xff]));
  }
  for (const ref of cell.refs) parts.push(representationHash(ref));
  return createHash('sha256').update(Buffer.concat(parts)).digest();
}

/** 手工拼装：op ‖ queryId ‖ cumulativeRaw ‖ Maybe 位（有 proof 时带 ref）。 */
function expectedBody(queryId: bigint, cumulative: bigint, proof: RefCell | null): RefCell {
  const head = [...uintBits(BigInt(0x4a580002), 32), ...uintBits(queryId, 64), ...uintBits(cumulative, 128)];
  if (proof === null) return { bits: [...head, 0], refs: [] };
  return { bits: [...head, 1], refs: [proof] };
}

/** 手工拼装 proof 链：每格最多 3 个哈希，后一格挂在前一格 ref 0。 */
function expectedProofChain(hexes: string[]): RefCell | null {
  if (hexes.length === 0) return null;
  const groups: string[][] = [];
  for (let i = 0; i < hexes.length; i += 3) groups.push(hexes.slice(i, i + 3));
  let next: RefCell | null = null;
  for (let g = groups.length - 1; g >= 0; g -= 1) {
    const bits = groups[g].flatMap(hashBits);
    next = { bits, refs: next ? [next] : [] };
  }
  return next;
}

const hex = (byte: string) => byte.repeat(32);
const QUERY_ID = 0x0123456789abcdefn;
const CUMULATIVE = 1_234_567_890_123n; // raw，远小于 2^128

/* ---------------- 测试 ---------------- */

test('op 前 32 bit 为 0x4a580002（手工核对：4a 58 00 02）', () => {
  const body = buildClaimJunxiangBody({ cumulativeRaw: CUMULATIVE, proofHex: [], queryId: QUERY_ID });
  const bytes = serializeCellToBoc(body);
  // BOC 头部之后的 cell 数据不便手算；直接检查位串前 32 位
  const ref = fromChain(body);
  assert.equal(ref.bits.slice(0, 32).join(''), '01001010010110000000000000000010');
  assert.equal(JUNXIANG_CLAIM_OP, 0x4a580002);
  assert.ok(bytes.length > 0);
});

test('空 proof：消息体 = op ‖ queryId ‖ cumulative ‖ 0（225 bit，无 ref），cell 哈希与手工一致', () => {
  const body = buildClaimJunxiangBody({ cumulativeRaw: CUMULATIVE, proofHex: [], queryId: QUERY_ID });
  assert.equal(body.bitLength, 32 + 64 + 128 + 1);
  assert.equal(body.refs.length, 0);
  const expected = expectedBody(QUERY_ID, CUMULATIVE, null);
  assert.equal(representationHash(fromChain(body)).toString('hex'), representationHash(expected).toString('hex'));
});

test('3 个哈希：单格，无后续 ref', () => {
  const proof = [hex('11'), hex('22'), hex('33')];
  const cell = buildProofCell(proof);
  assert.ok(cell);
  assert.equal(cell.bitLength, 768);
  assert.equal(cell.refs.length, 0);
  const body = buildClaimJunxiangBody({ cumulativeRaw: CUMULATIVE, proofHex: proof, queryId: QUERY_ID });
  const expected = expectedBody(QUERY_ID, CUMULATIVE, expectedProofChain(proof));
  assert.equal(representationHash(fromChain(body)).toString('hex'), representationHash(expected).toString('hex'));
});

test('4 个哈希：两格链（3 + 1），第一格 ref 0 指向第二格', () => {
  const proof = [hex('aa'), hex('bb'), hex('cc'), hex('dd')];
  const body = buildClaimJunxiangBody({ cumulativeRaw: CUMULATIVE, proofHex: proof, queryId: QUERY_ID });
  assert.equal(body.refs.length, 1);
  const head = body.refs[0];
  assert.equal(head.bitLength, 768);
  assert.equal(head.refs.length, 1);
  assert.equal(head.refs[0].bitLength, 256);
  assert.equal(head.refs[0].refs.length, 0);
  const expected = expectedBody(QUERY_ID, CUMULATIVE, expectedProofChain(proof));
  assert.equal(representationHash(fromChain(body)).toString('hex'), representationHash(expected).toString('hex'));
});

test('7 个哈希：三格链（3 + 3 + 1），与手工拼装的 cell 哈希一致', () => {
  const proof = ['01', '02', '03', '04', '05', '06', '07'].map(hex);
  const body = buildClaimJunxiangBody({ cumulativeRaw: CUMULATIVE, proofHex: proof, queryId: QUERY_ID });
  const expected = expectedBody(QUERY_ID, CUMULATIVE, expectedProofChain(proof));
  assert.equal(representationHash(fromChain(body)).toString('hex'), representationHash(expected).toString('hex'));
});

test('哈希顺序参与编码：反转 proof 会改变 cell 哈希', () => {
  const proof = [hex('10'), hex('20'), hex('30'), hex('40')];
  const a = buildClaimJunxiangBody({ cumulativeRaw: CUMULATIVE, proofHex: proof, queryId: QUERY_ID });
  const b = buildClaimJunxiangBody({ cumulativeRaw: CUMULATIVE, proofHex: [...proof].reverse(), queryId: QUERY_ID });
  assert.notEqual(representationHash(fromChain(a)).toString('hex'), representationHash(fromChain(b)).toString('hex'));
});

test('非法 proof 节点（非 64 位 hex）直接抛错', () => {
  assert.throws(() => buildProofCell(['zz']), /64 位 hex/);
  assert.throws(() => buildProofCell(['ab'.repeat(31)]), /64 位 hex/);
});

test('prepareJunxiangClaimTransaction：目标地址、0.2 TON、payload 即消息体', () => {
  const distributorRaw = '0:' + 'ab'.repeat(32);
  const chain = {
    chainId: '-3',
    junxiangDistributor: distributorRaw,
  } as unknown as ChainConfig;
  const wallet = { address: '0:' + 'cd'.repeat(32), demo: false, tonBalance: null };
  const proof = [hex('01'), hex('02')];
  const prepared = prepareJunxiangClaimTransaction({
    chain,
    wallet,
    cumulativeRaw: CUMULATIVE,
    proofHex: proof,
    queryId: QUERY_ID,
    now: 1_700_000_000_000,
  });
  assert.equal(prepared.request.messages.length, 1);
  const message = prepared.request.messages[0];
  assert.equal(message.address, distributorRaw);
  assert.equal(message.amount, '200000000');
  assert.equal(prepared.request.network, '-3');
  assert.equal(prepared.request.from, wallet.address);
  assert.equal(prepared.request.validUntil, 1_700_000_000 + 300);
  assert.equal(prepared.meta.queryId, QUERY_ID.toString());
  assert.equal(prepared.meta.cumulativeRaw, CUMULATIVE.toString());
  const body = buildClaimJunxiangBody({ cumulativeRaw: CUMULATIVE, proofHex: proof, queryId: QUERY_ID });
  assert.equal(message.payload, Buffer.from(serializeCellToBoc(body)).toString('base64'));
});

test('prepareJunxiangClaimTransaction：未配置分发合约时拒绝', () => {
  const chain = { chainId: '-3', junxiangDistributor: null } as unknown as ChainConfig;
  const wallet = { address: '0:' + 'cd'.repeat(32), demo: false, tonBalance: null };
  assert.throws(() => prepareJunxiangClaimTransaction({ chain, wallet, cumulativeRaw: 1n, proofHex: [] }), /军饷合约未配置|CHAIN_NOT_CONFIGURED|未配置/);
});
