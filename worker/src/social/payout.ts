/**
 * 累计军饷清单（任务单 5）：把截至 toRound 的全部军饷明细按钱包汇总为「终身累计」金额，构建 Merkle 树并持久化。
 * 树的编码见 merkle.ts 文件头（链上 claim 合约必须一致）。
 *
 * - buildPayoutList(fromRound, toRound)：金额口径 = round_id ≤ toRound 的全部明细（累计，不是本周增量）；
 *   fromRound 仅记录在清单元数据里，不影响金额。
 * - 钱包键：TON raw 形式 `<wc>:<hash>`；无法解析为 TON 地址的钱包直接报错（不静默丢弃，否则清单缺人）。
 * - 清单版本化：每次构建新增一行 payout_lists，旧清单保留。
 */
import type { Env } from '../env';
import { badRequest, notFound, okResponse, parseAddress, parseRoundId } from '../http';
import { parseTonAddress } from '../indexer/address';
import { requireAdmin } from '../auth';
import { toBigInt } from '../util';
import { getPayoutItem, insertPayoutItems, insertPayoutList, deletePayoutList, latestPayoutListRow, listJunxiangUpTo, type PayoutItemRow, type PayoutListRow } from './db';
import { buildMerkleTree, compareBytes, leafHashOf, merkleProof, toHex, type MerkleLeafInput } from './merkle';

export interface PayoutEntry extends MerkleLeafInput {
  /** raw 键 `<wc>:<hash>` */
  wallet: string;
}

export interface PayoutLayoutItem extends PayoutEntry {
  /** 排序后的叶子下标 */
  index: number;
  leafHex: string;
  /** 兄弟哈希（hex，自底向上；晋级层省略） */
  proof: string[];
}

export interface PayoutLayout {
  rootHex: string;
  leafCount: number;
  totalRaw: bigint;
  /** 按 index 升序 */
  items: PayoutLayoutItem[];
}

/** 友好 / raw 地址 → raw 键；非法地址抛错。 */
export function walletKeyOf(wallet: string): { key: string; workchain: number; hashHex: string } {
  const parsed = parseTonAddress(wallet);
  if (!parsed) throw new Error(`payout: 无法解析钱包地址 ${wallet}`);
  return { key: parsed.raw, workchain: parsed.workchain, hashHex: parsed.hashHex };
}

/** 纯计算：叶子 → 排序 → 树 → 每人证明。钱包重复会抛错。 */
export async function layoutPayout(entries: readonly PayoutEntry[]): Promise<PayoutLayout> {
  const seen = new Set<string>();
  const hashed: Array<{ entry: PayoutEntry; leaf: Uint8Array }> = [];
  let total = 0n;
  for (const entry of entries) {
    if (seen.has(entry.wallet)) throw new Error(`payout: 钱包重复 ${entry.wallet}`);
    seen.add(entry.wallet);
    total += entry.cumulativeRaw;
    hashed.push({ entry, leaf: await leafHashOf(entry) });
  }
  hashed.sort((a, b) => compareBytes(a.leaf, b.leaf));
  const tree = await buildMerkleTree(hashed.map((row) => row.leaf));
  const items: PayoutLayoutItem[] = hashed.map((row, index) => ({
    ...row.entry,
    index,
    leafHex: toHex(row.leaf),
    proof: merkleProof(tree, index).map(toHex),
  }));
  return { rootHex: toHex(tree.root), leafCount: items.length, totalRaw: total, items };
}

/** 明细按钱包累加（截至某轮）。 */
export function aggregateJunxiang(rows: ReadonlyArray<{ wallet: string; amountRaw: string | bigint }>): PayoutEntry[] {
  const totals = new Map<string, PayoutEntry>();
  for (const row of rows) {
    const { key, workchain, hashHex } = walletKeyOf(row.wallet);
    const amount = typeof row.amountRaw === 'bigint' ? row.amountRaw : toBigInt(row.amountRaw);
    const hit = totals.get(key);
    if (hit) hit.cumulativeRaw += amount;
    else totals.set(key, { wallet: key, workchain, hashHex, cumulativeRaw: amount });
  }
  return [...totals.values()].filter((entry) => entry.cumulativeRaw > 0n);
}

export interface PayoutListSummary {
  listId: number;
  root: string;
  fromRound: number;
  toRound: number;
  leafCount: number;
  totalRaw: string;
  createdAt: number;
}

function validateRange(fromRound: number, toRound: number): void {
  if (!Number.isInteger(fromRound) || !Number.isInteger(toRound) || fromRound < 1 || toRound < fromRound) {
    throw badRequest('轮次范围不合法（需要 1 ≤ fromRound ≤ toRound）');
  }
}

const CUMULATIVE_MAX = (1n << 128n) - 1n;

/** 构建并持久化一份累计清单。 */
export async function buildPayoutList(env: Env, fromRound: number, toRound: number, now: number): Promise<PayoutListSummary> {
  validateRange(fromRound, toRound);
  const entries = aggregateJunxiang(await listJunxiangUpTo(env, toRound));
  for (const entry of entries) {
    if (entry.cumulativeRaw > CUMULATIVE_MAX) throw new Error('payout: 累计金额超出 uint128');
  }
  const layout = await buildLayoutOrEmpty(entries);
  const listId = await insertPayoutList(env, {
    fromRound,
    toRound,
    root: layout.rootHex,
    leafCount: layout.leafCount,
    totalRaw: layout.totalRaw.toString(),
    createdAt: now,
  });
  try {
    await insertPayoutItems(
      env,
      layout.items.map((item) => ({
        list_id: listId,
        wallet_key: item.wallet,
        workchain: item.workchain,
        wallet_hash: item.hashHex,
        cumulative_raw: item.cumulativeRaw.toString(),
        leaf_index: item.index,
        leaf: item.leafHex,
        proof_json: JSON.stringify(item.proof),
      })),
    );
  } catch (err) {
    await deletePayoutList(env, listId);
    throw err;
  }
  return {
    listId,
    root: layout.rootHex,
    fromRound,
    toRound,
    leafCount: layout.leafCount,
    totalRaw: layout.totalRaw.toString(),
    createdAt: now,
  };
}

async function buildLayoutOrEmpty(entries: readonly PayoutEntry[]): Promise<PayoutLayout> {
  if (entries.length === 0) return { rootHex: '00'.repeat(32), leafCount: 0, totalRaw: 0n, items: [] };
  return layoutPayout(entries);
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

function summaryOf(row: PayoutListRow) {
  return {
    listId: row.id,
    root: row.root,
    fromRound: row.from_round,
    toRound: row.to_round,
    leafCount: row.leaf_count,
    totalRaw: row.total_raw,
    createdAt: row.created_at,
  };
}

/** GET /api/social/payout/latest */
export async function handlePayoutLatest(env: Env): Promise<Response> {
  const row = await latestPayoutListRow(env);
  if (!row) throw notFound('尚未生成累计清单');
  return okResponse(summaryOf(row));
}

/** GET /api/social/payout/proof?wallet= ：最新清单中该钱包的累计金额与证明。 */
export async function handlePayoutProof(env: Env, url: URL): Promise<Response> {
  const wallet = parseAddress(url.searchParams.get('wallet'), 'wallet');
  const { key } = walletKeyOf(wallet);
  const list = await latestPayoutListRow(env);
  if (!list) throw notFound('尚未生成累计清单');
  const item: PayoutItemRow | null = await getPayoutItem(env, list.id, key);
  if (!item) throw notFound('该钱包不在最新清单中');
  return okResponse({
    listId: list.id,
    root: list.root,
    cumulativeRaw: item.cumulative_raw,
    proof: JSON.parse(item.proof_json) as string[],
    index: item.leaf_index,
    leafCount: list.leaf_count,
  });
}

/**
 * POST /api/admin/payout/build {fromRound, toRound}（管理员）。
 * 路由由 worker/src/index.ts 注册（见 social/index.ts 的说明）。
 */
export async function handleAdminPayoutBuild(request: Request, env: Env, now: number): Promise<Response> {
  requireAdmin(request, env);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw badRequest('请求体必须是 JSON');
  }
  const obj = (body ?? {}) as Record<string, unknown>;
  const fromRound = parseRoundId(obj.fromRound);
  const toRound = parseRoundId(obj.toRound);
  const summary = await buildPayoutList(env, fromRound, toRound, now);
  return okResponse(summary);
}

