/**
 * v11 结算记账（docs/35 §3.3、contracts/contracts/RoundController.tolk settleRound）。
 * 金额一律取自 RoundSettled 事件（精确值）：carry（滚存）是合约内部状态，链下无法从 get_round 精确复算。
 *  - 成功轮：RC 把「上一次成功的团队额度」转给团队钱包（teamReleasedRaw）；本轮 1.2 亿留待下一次成功。
 *            仅第 10 城结束时，留存滚存（carry）会以一笔 burn 销毁（rewardBurnRaw）。
 *  - 失败轮：一笔 burn = 半额奖励 + 团队 1.2 亿 + 本轮全部质押（rewardBurnRaw / teamBurnRaw / principalBurnRaw）。
 *  - 确认：get_round 的 *Confirmed 标志 = 动作已发出且未被退回（被退回 → SettlementBounced → RetrySettlement）。
 * 铁律：不允许仅凭 keeper 声明/K 线计数就把 burn_ledger 写成 confirmed。
 */
import type { ProtocolConfigFields } from './config';
import type { BurnRow, ClaimRow, RoundRow, StakeRow } from '../store';
import type { RoundSettledEvent } from './events';

export type BurnKind = 'reward' | 'team' | 'principal';

export const BURN_KINDS: readonly BurnKind[] = ['reward', 'team', 'principal'] as const;

/** burn_ledger 的稳定幂等键。 */
export function burnRef(roundId: number, kind: BurnKind): string {
  return 'R' + roundId + ':' + kind;
}

export interface SettlementAmounts {
  reward: bigint;
  team: bigint;
  principal: bigint;
  teamReleased: bigint;
}

/** RoundSettled 事件 → 本轮结算动作金额（事件为准）。 */
export function settlementFromEvent(event: RoundSettledEvent): SettlementAmounts {
  return {
    reward: event.rewardBurnRaw,
    team: event.teamBurnRaw,
    principal: event.principalBurnRaw,
    teamReleased: event.teamReleasedRaw,
  };
}

/**
 * 事件金额的结构性核对（carry 无法链下复算，只核对可推导部分）：
 *  失败轮：奖励销毁 ≥ 半额预算、团队 = 1.2 亿、本金 = 总质押；成功轮：不销毁本金与团队额度。
 * 返回不一致的说明文字列表（空 = 一致）。
 */
export function settlementMismatches(event: RoundSettledEvent, config: ProtocolConfigFields): string[] {
  const problems: string[] = [];
  const teamRound = BigInt(config.teamRoundRaw);
  if (event.status === 9) {
    if (event.rewardBurnRaw < event.rewardBudgetRaw / 2n) problems.push('失败轮奖励销毁 < 半额预算');
    if (event.teamBurnRaw !== teamRound) problems.push('失败轮团队销毁 ≠ 1.2 亿');
    if (event.principalBurnRaw !== event.totalAcceptedStakeRaw) problems.push('失败轮本金销毁 ≠ 总质押');
  } else if (event.status === 8) {
    if (event.teamBurnRaw !== 0n || event.principalBurnRaw !== 0n) problems.push('成功轮出现本金/团队销毁');
  }
  return problems;
}

/** 本轮已确认销毁总额（burn_ledger 中 confirmed=1 的行之和）；没有已确认 burn 返回 null。 */
export function confirmedBurnedTotal(burns: readonly BurnRow[]): bigint | null {
  let total = 0n;
  let any = false;
  for (const row of burns) {
    if (row.confirmed !== 1) continue;
    total += BigInt(row.amount_raw);
    any = true;
  }
  return any ? total : null;
}

export interface RcWalletInput {
  config: ProtocolConfigFields;
  /** 全部质押行（source = restake 的行是滚入，不是新的入金，计算时跳过） */
  stakes: StakeRow[];
  rounds: RoundRow[];
  burns: BurnRow[];
  /** 全部领取（本金 + 奖励） */
  claims: ClaimRow[];
  /** 退款账本：dust = 无效且 TON 不足而留存在 RC 的金额（非即时退回） */
  keptRaw: bigint;
  roundCount?: number;
}

/**
 * RC 钱包应持有 = 初始注资（10 × (7 亿 + 1.2 亿) = 82 亿）+ 全部入金质押 + 留存的无效质押
 *               − 已释放团队额 − 已确认销毁 − 已领取（本金 + 奖励）。
 * 攻城令之间的续战（source = restake）只在攻城令间移动价值，不改变 RC 钱包余额。
 */
export function expectedRcWalletBalance(input: RcWalletInput): bigint {
  const rounds = BigInt(input.roundCount ?? 10);
  let total = rounds * (BigInt(input.config.roundRewardRaw) + BigInt(input.config.teamRoundRaw));
  for (const stake of input.stakes) {
    if ((stake.source ?? 'deposit') === 'deposit') total += BigInt(stake.amount_raw);
  }
  total += input.keptRaw;
  for (const round of input.rounds) if (round.team_released_raw) total -= BigInt(round.team_released_raw);
  for (const burn of input.burns) if (burn.confirmed === 1) total -= BigInt(burn.amount_raw);
  for (const claim of input.claims) total -= BigInt(claim.amount_raw);
  return total;
}
