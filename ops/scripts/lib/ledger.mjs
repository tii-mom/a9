/**
 * v11 结算与对账公式（contracts/README §2、docs/35 D-45~D-47）。
 *
 * - 破城（SUCCEEDED）：不销毁；上一次破城的团队额度（1.2 亿）此时转给 teamWallet（prevTeamRaw），本城额度挂起；
 *   0 人质押破城：整笔奖池滚入下一城（carry += budget）。第 10 城结束后剩余 carry 并入销毁（本函数不建模）。
 * - 失败（FAILED_PERMANENT）：一笔销毁 = 奖池一半（budget / 2）+ 1.2 亿团队 + 本轮全部本金；另一半滚入下一城。
 * - 技术终止（TECHNICAL_ABORTED）：不销毁、不释放；整笔奖池滚入（carry += budget），团队额度留存（D-39）。
 * - RC 钱包余额 = 82 亿 + Σ已接受质押 − Σ销毁 − Σ团队释放 − 已领本金 − 已领奖励（攻城令领取）+ 尾差留存
 *   （奖励按战力比例分配的向下取整尾差留在 RC → 实际只会 ≥ 公式值）。
 */

import { asBigInt } from './config.mjs';

const big = (value) => (value === null || value === undefined || value === '' ? null : asBigInt(value));

/**
 * 每轮的预期销毁 / 团队释放 / 滚存；未判定的轮次返回 null。
 * budgetRaw：本城奖池（默认 7 亿；开城时 = 7 亿 + carry）；prevTeamRaw：上一次破城留下的团队额度。
 */
export function expectedSettlement(params, state, stakeRaw, budgetRaw = null, prevTeamRaw = 0) {
  const budget = big(budgetRaw) ?? asBigInt(params.rounds.roundRewardRaw);
  const team = asBigInt(params.rounds.teamRoundRaw);
  const stake = big(stakeRaw) ?? 0n;
  if (state === 'FAILED_PERMANENT') {
    const half = budget / 2n;
    return { burnRaw: half + team + stake, teamReleaseRaw: 0n, carryRaw: budget - half };
  }
  if (state === 'SUCCEEDED') {
    return { burnRaw: 0n, teamReleaseRaw: big(prevTeamRaw) ?? 0n, carryRaw: stake === 0n ? budget : 0n };
  }
  if (state === 'TECHNICAL_ABORTED') return { burnRaw: 0n, teamReleaseRaw: 0n, carryRaw: budget };
  return null;
}

/**
 * 链上 RoundView 的结算动作是否全部发出且未被退回（*Confirmed 标志）。
 * 返回 null = 未判定；[] = 已完成；非空 = 待 RetrySettlement 的动作。
 *
 * 失败轮：一笔销毁必然发出，*Confirmed 可靠 → 未确认即待重试。
 * 破城轮：RoundView 无法区分「未发出」（上一城没有团队额度 / 无需释放）与「被退回」，
 *         因此这里不从视图推断重试；破城轮的退回只由 SettlementBounced 事件驱动（monitor 告警 → RetrySettlement）。
 */
export function pendingSettlementActions(view) {
  if (!view) return null;
  const stake = view.totalAcceptedStakeRaw ?? 0n;
  if (view.state === 'FAILED_PERMANENT') {
    const confirmed = view.rewardBurnConfirmed && view.teamBurnConfirmed && (stake === 0n || view.principalBurnConfirmed);
    return confirmed ? [] : ['failureBurn'];
  }
  if (view.state === 'SUCCEEDED' || view.state === 'TECHNICAL_ABORTED') return [];
  return null;
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

/**
 * 按轮次列表计算预期结算（v11）：奖池取本城记录的 rewardBudgetRaw；
 * 破城轮的团队释放 = 此前任一破城轮留下的团队额度（1.2 亿），没有更早的破城则为 0（D-47）。
 */
export function expectedSettlementFor(params, rounds, round) {
  const earlier = (rounds || []).filter((item) => Number(item.roundId) < Number(round.roundId));
  const prevTeamRaw = earlier.some((item) => item.state === 'SUCCEEDED') ? asBigInt(params.rounds.teamRoundRaw) : 0n;
  const budget = round.rewardBudgetRaw === null || round.rewardBudgetRaw === undefined ? null : round.rewardBudgetRaw;
  return expectedSettlement(params, round.state, round.totalAcceptedStakeRaw, budget, prevTeamRaw);
}
