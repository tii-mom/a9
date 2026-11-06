/**
 * v10 结算记账（docs/34 §2、contracts/README §4.3）。
 *  - 成功轮：RC 直接转 1.2 亿给团队钱包；若 0 质押，再 burn 7 亿奖励（D-18b）。
 *  - 失败轮：一笔 burn = 7 亿奖励 + 1.2 亿团队 + 本轮全部质押；D1 账本仍按 reward/team/principal 拆分。
 *  - 确认：get_round 的 *Confirmed = 动作已发出且未被退回（被退回 → SettlementBounced → RetrySettlement）。
 * 铁律：不允许仅凭 keeper 声明/K 线计数就把 burn_ledger 写成 confirmed。
 */
import type { ChainRoundView } from './getters';
import type { ProtocolConfigFields } from './config';
import type { BurnRow, ClaimRow, RefundBalance, RoundRow, StakeRow } from '../store';

export type BurnKind = 'reward' | 'team' | 'principal';

export const BURN_KINDS: readonly BurnKind[] = ['reward', 'team', 'principal'] as const;

/** burn_ledger 的稳定幂等键（与 store.finalizeFailure 的 demo 口径一致）。 */
export function burnRef(roundId: number, kind: BurnKind): string {
  return 'R' + roundId + ':' + kind;
}

export interface SettlementAmounts {
  reward: bigint;
  team: bigint;
  principal: bigint;
  teamReleased: bigint;
}

/** 与合约 settleRound 同口径推导结算金额（status 8 成功 / 9 失败；其他全 0）。 */
export function settlementAmounts(status: number, config: ProtocolConfigFields, totalStakeRaw: bigint): SettlementAmounts {
  const reward = BigInt(config.roundRewardRaw);
  const team = BigInt(config.teamRoundRaw);
  if (status === 8) return { reward: totalStakeRaw === 0n ? reward : 0n, team: 0n, principal: 0n, teamReleased: team };
  if (status === 9) return { reward, team, principal: totalStakeRaw, teamReleased: 0n };
  return { reward: 0n, team: 0n, principal: 0n, teamReleased: 0n };
}

/** 本轮已确认销毁总额；没有 burn 或尚未确认返回 null（避免提前显示"已销毁"）。 */
export function confirmedBurnedTotal(round: ChainRoundView, config: ProtocolConfigFields): bigint | null {
  const amounts = settlementAmounts(round.status, config, round.totalAcceptedStakeRaw);
  const total = amounts.reward + amounts.team + amounts.principal;
  if (total === 0n || !round.rewardBurnConfirmed) return null;
  return total;
}

export interface RcWalletInput {
  config: ProtocolConfigFields;
  stakes: StakeRow[];
  rounds: RoundRow[];
  burns: BurnRow[];
  claims: ClaimRow[];
  refunds: RefundBalance;
  roundCount?: number;
}

/**
 * RC 钱包应持有 = 初始注资（10 × (7 亿 + 1.2 亿) = 82 亿）+ 全部已接受质押 + 退款账本记入 + 留存零头
 *               − 已确认团队释放 − 已确认销毁 − 已领取（本金 + 奖励）− 退款账本已领。
 * 等价于 docs/34 的「82 亿 − 已释放团队 − 已销毁 − 已领取奖励 + 未领取本金」（终止轮 8.2 亿留存不变）。
 */
export function expectedRcWalletBalance(input: RcWalletInput): bigint {
  const rounds = BigInt(input.roundCount ?? 10);
  let total = rounds * (BigInt(input.config.roundRewardRaw) + BigInt(input.config.teamRoundRaw));
  for (const stake of input.stakes) total += BigInt(stake.amount_raw);
  total += input.refunds.credited + input.refunds.dust - input.refunds.claimed;
  for (const round of input.rounds) if (round.team_released_raw) total -= BigInt(round.team_released_raw);
  for (const burn of input.burns) if (burn.confirmed === 1) total -= BigInt(burn.amount_raw);
  for (const claim of input.claims) total -= BigInt(claim.amount_raw);
  return total;
}
