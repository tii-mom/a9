/**
 * 单城军饷编排（任务单 6）：收集守城补贴 / 新人礼 / 猜灯的输入，交给 computeJunxiang，再覆盖写入 junxiang 表。
 *
 * 调用时机由调用方决定：守城补贴需要观察窗口（stakeCloseAt + 24h）与次城报名数据已齐；猜灯只在本城已结算
 * （round.result 非空）时发放。数据源失败会直接抛错，不会写入一份缺少补贴的明细。
 */
import { toBigInt } from '../util';
import { notFound } from '../http';
import { listGuesses, listReferralBinds, replaceJunxiangRows } from './db';
import type { SocialEnv } from './common';
import { guardContributions, guardWindowOf, netBoughtByWallet } from './guard';
import { guessContributions } from './guess';
import { JUNXIANG_A9_BUDGETS, computeJunxiang, type JunxiangContribution, type JunxiangRow } from './junxiang';
import { newcomerContributions, newcomerShadowWallets, shadowA9Raw } from './newcomer';
import { addressKey, junxiangInputOf, loadSnapshot } from './snapshot';
import { fundingClusterSourceFromEnv, poolTradeSourceFromEnv, type FundingClusterSource, type PoolTradeSource, type SourcesEnv } from './sources';

export interface RoundJunxiangDeps {
  /** 守城补贴的池子成交源；null = 未配置 STONFI_POOL_ADDRESS，本城不发守城补贴 */
  pool: { poolAddress: string; source: PoolTradeSource } | null;
  funding: FundingClusterSource;
}

export function defaultJunxiangDeps(env: SourcesEnv): RoundJunxiangDeps {
  return { pool: poolTradeSourceFromEnv(env), funding: fundingClusterSourceFromEnv(env) };
}

/** 计算并覆盖写入第 roundId 城的全部军饷明细；返回写入的行。 */
export async function computeRoundJunxiang(
  env: SourcesEnv,
  roundId: number,
  now: number,
  deps: RoundJunxiangDeps = defaultJunxiangDeps(env),
): Promise<JunxiangRow[]> {
  const snap = await loadSnapshot(env as SocialEnv, now);
  const round = snap.rounds.find((row) => row.round_id === roundId);
  if (!round) throw notFound('轮次不存在');
  // Lead decision: technically aborted rounds pay no 军饷 — principal is refunded with zero risk,
  // so referral/squad bonuses there would be free to farm. Clear any rows and stop.
  if ((round as { result?: string | null }).result === 'TECHNICAL_ABORT') {
    await replaceJunxiangRows(env as SocialEnv, roundId, [], now);
    return [];
  }
  const budgets = JUNXIANG_A9_BUDGETS;
  const input = junxiangInputOf(snap, roundId, budgets);
  const contributions: JunxiangContribution[] = [];

  // 守城补贴：第 r 城观察窗口内的池子净买入 × 第 r+1 城报名窗口内的质押
  const next = snap.rounds.find((row) => row.round_id === roundId + 1);
  if (deps.pool && round.stake_close_at !== null && next && next.stake_open_at !== null && next.stake_close_at !== null) {
    const { fromMs, toMs } = guardWindowOf(round.stake_close_at);
    const swaps = await deps.pool.source.listSwaps(deps.pool.poolAddress, fromMs, toMs);
    const netBought = netBoughtByWallet(swaps, (wallet) => addressKey(snap.chain, wallet));
    const openAt = next.stake_open_at;
    const closeAt = next.stake_close_at;
    const stakedNext = new Map<string, bigint>();
    for (const [key, rows] of snap.byRound.get(next.round_id) ?? new Map()) {
      let sum = 0n;
      for (const row of rows) {
        if (row.accepted_at >= openAt && row.accepted_at <= closeAt) sum += toBigInt(row.amount_raw);
      }
      if (sum > 0n) stakedNext.set(key, sum);
    }
    contributions.push(...guardContributions({ roundId, netBought, stakedNext }));
  }

  // 新人礼：绑定后第一座开城的轮次；成功城才派发；影子仓位 1 GRAM（开城价暂未接入，取 1,000 A9）
  const binds = (await listReferralBinds(env)).map((bind) => ({ ...bind, wallet: addressKey(snap.chain, bind.wallet) }));
  const shadowWallets = newcomerShadowWallets(binds, snap.rounds, roundId);
  contributions.push(
    ...newcomerContributions({
      roundId,
      success: round.result === 'SUCCESS',
      rewardBudgetRaw: toBigInt(round.reward_budget_raw),
      totalWeightRaw: toBigInt(round.total_weight_raw),
      wallets: shadowWallets,
      shadowRaw: shadowA9Raw(null, null),
    }),
  );

  // 猜灯：本城已结算后，亮灯数 = qualified_candles
  if (round.result !== null) {
    const guesses = await listGuesses(env, roundId);
    contributions.push(
      ...guessContributions({ roundId, litActual: round.qualified_candles, guesses, poolRaw: budgets.guess ?? 0n }),
    );
  }

  // 同资金来源合并：成员与补贴钱包一起查询簇
  const wallets = new Set<string>(input.members.map((member) => member.wallet));
  for (const contribution of contributions) wallets.add(contribution.wallet);
  const clusterOf = await deps.funding.clusterOf([...wallets].sort());

  const rows = computeJunxiang({ ...input, contributions, clusterOf });
  await replaceJunxiangRows(env, roundId, rows, now);
  return rows;
}
