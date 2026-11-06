/**
 * 守城补贴（docs/35 §4.4，任务单 1）。纯函数，无 I/O。
 *
 * 规则：钱包在第 r 城的观察窗口（stakeCloseAt .. stakeCloseAt + 24h）内，在 STON.fi 官方池子上的净 A9 买入（买 − 卖，下限 0），
 * 且其中一部分在第 r+1 城的报名窗口内被质押进第 r+1 城。补贴 = 比例 × min(净买入, 次轮质押)。
 *   比例：10%；第 1 城为 20%。
 * 直接转账收到的 A9 不计入：本函数只接收池子成交（PoolTradeSource），转账不会出现在成交列表里。
 * 单人上限、预算缩放由 junxiang.ts 统一处理。
 */
import type { JunxiangContribution } from './junxiang';
import type { PoolSwap } from './sources';

export const GUARD_WINDOW_MS = 24 * 3_600_000;
export const GUARD_RATE_BPS = 1_000n;
export const GUARD_RATE_BPS_ROUND_ONE = 2_000n;

/** 第 r 城的补贴比例（bps）。 */
export function guardRateBps(roundId: number): bigint {
  return roundId === 1 ? GUARD_RATE_BPS_ROUND_ONE : GUARD_RATE_BPS;
}

/** 观察窗口 [stakeCloseAt, stakeCloseAt + 24h]（含两端）。 */
export function guardWindowOf(stakeCloseAt: number): { fromMs: number; toMs: number } {
  return { fromMs: stakeCloseAt, toMs: stakeCloseAt + GUARD_WINDOW_MS };
}

/** 净买入：每个钱包的 BUY − SELL（只保留正数）。keyOf 把成交钱包归一化为与其它表一致的键。 */
export function netBoughtByWallet(swaps: readonly PoolSwap[], keyOf: (wallet: string) => string): Map<string, bigint> {
  const net = new Map<string, bigint>();
  for (const swap of swaps) {
    if (swap.a9Amount <= 0n) continue;
    const key = keyOf(swap.wallet);
    const delta = swap.side === 'BUY' ? swap.a9Amount : -swap.a9Amount;
    net.set(key, (net.get(key) ?? 0n) + delta);
  }
  for (const [key, value] of net) {
    if (value <= 0n) net.delete(key);
  }
  return net;
}

/**
 * 守城补贴行。netBought / stakedNext 均为 键 → raw；只有两者都大于 0 的钱包才有补贴。
 */
export function guardContributions(input: {
  roundId: number;
  netBought: ReadonlyMap<string, bigint>;
  stakedNext: ReadonlyMap<string, bigint>;
}): JunxiangContribution[] {
  const rate = guardRateBps(input.roundId);
  const out: JunxiangContribution[] = [];
  for (const [wallet, bought] of input.netBought) {
    const staked = input.stakedNext.get(wallet) ?? 0n;
    const base = bought < staked ? bought : staked;
    if (base <= 0n) continue;
    const amountRaw = (base * rate) / 10_000n;
    if (amountRaw <= 0n) continue;
    out.push({ wallet, kind: 'guard', amountRaw, meta: `守城补贴 ${rate.toString()}bps × min(净买入, 次城质押)` });
  }
  return out;
}
