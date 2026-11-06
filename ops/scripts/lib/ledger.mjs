/**
 * v10 结算与对账公式（docs/34 §2、contracts/README §2）。
 *
 * - 成功轮：团队 1.2 亿从 RC 直接转给 teamWallet；0 人质押时 7 亿奖励销毁。
 * - 失败轮：一笔销毁 = 7 亿奖励 + 1.2 亿团队 + 本轮全部本金。
 * - 技术终止轮：不销毁、不释放，8.2 亿留在 RC。
 * - RC 钱包余额 = 82 亿 + Σ已接受质押 − Σ销毁 − Σ团队释放 − 已领本金 − 已领奖励 + 退款账本未领
 *   （低于 10 万且 TON 不足的零头、奖励按比例分配的尾差也留在 RC → 实际只会 ≥ 公式值）。
 */

import { asBigInt } from './config.mjs';

const big = (value) => (value === null || value === undefined || value === '' ? null : asBigInt(value));

/** 每轮的预期销毁 / 团队释放；未判定的轮次返回 null。 */
export function expectedSettlement(params, state, stakeRaw) {
  const reward = asBigInt(params.rounds.roundRewardRaw);
  const team = asBigInt(params.rounds.teamRoundRaw);
  const stake = big(stakeRaw) ?? 0n;
  if (state === 'FAILED_PERMANENT') return { burnRaw: reward + team + stake, teamReleaseRaw: 0n };
  if (state === 'SUCCEEDED') return { burnRaw: stake === 0n ? reward : 0n, teamReleaseRaw: team };
  if (state === 'TECHNICAL_ABORTED') return { burnRaw: 0n, teamReleaseRaw: 0n };
  return null;
}

/**
 * 链上 RoundView 的结算动作是否全部发出且未被退回（*Confirmed 标志）。
 * 返回 null = 未判定；[] = 已完成；非空 = 待 RetrySettlement 的动作。
 */
export function pendingSettlementActions(view) {
  if (!view) return null;
  const stake = view.totalAcceptedStakeRaw ?? 0n;
  if (view.state === 'SUCCEEDED') {
    const pending = [];
    if (view.teamReleaseConfirmed === false) pending.push('teamRelease');
    if (stake === 0n && view.rewardBurnConfirmed === false) pending.push('rewardBurn');
    return pending;
  }
  if (view.state === 'FAILED_PERMANENT') {
    const confirmed = view.rewardBurnConfirmed && view.teamBurnConfirmed && (stake === 0n || view.principalBurnConfirmed);
    return confirmed ? [] : ['failureBurn'];
  }
  return view.state === 'TECHNICAL_ABORTED' ? [] : null;
}

/**
 * RC 钱包余额公式。totals 需要 claimedPrincipalRaw / claimedRewardRaw / refundPendingRaw；
 * 缺任何一项返回 { expected: null, missing: [...] }。
 */
export function expectedRcVault(params, rounds, totals = {}) {
  const missing = ['claimedPrincipalRaw', 'claimedRewardRaw', 'refundPendingRaw'].filter((key) => totals[key] === undefined || totals[key] === null);
  let stake = 0n;
  let burned = 0n;
  let released = 0n;
  for (const round of rounds) {
    stake += big(round.totalAcceptedStakeRaw) ?? 0n;
    burned += big(round.burnedRaw) ?? 0n;
    released += big(round.teamReleasedRaw) ?? 0n;
  }
  const breakdown = { fundingRaw: asBigInt(params.rounds.rcFundingRaw), stakeRaw: stake, burnedRaw: burned, teamReleasedRaw: released };
  if (missing.length) return { expected: null, missing, breakdown };
  const claimedPrincipal = asBigInt(totals.claimedPrincipalRaw);
  const claimedReward = asBigInt(totals.claimedRewardRaw);
  const refundPending = asBigInt(totals.refundPendingRaw);
  const expected = breakdown.fundingRaw + stake - burned - released - claimedPrincipal - claimedReward + refundPending;
  return { expected, missing, breakdown: { ...breakdown, claimedPrincipalRaw: claimedPrincipal, claimedRewardRaw: claimedReward, refundPendingRaw: refundPending } };
}
