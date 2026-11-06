/**
 * 失败轮三笔销毁的三态记账（dispatched → confirmed）。
 *
 * 链上语义（contracts/README §4.3/§6.3，RoundController P0-2）：
 *  1. 轮次失败进入 SETTLING_FAILURE，RC 向自己的 Jetton Wallet 发 `AskToBurn(0x595f07bc)`，
 *     queryId = roundId<<16 | kind<<8（kind：1 reward / 2 team / 3 principal；team 由 TeamVault 执行）；
 *  2. Jetton Master 的 `ReturnExcessesBack(0xd53276db)` 回到 RC 即视为该笔销毁完成，
 *     get_round 的 rewardBurnConfirmed / teamBurnConfirmed / principalBurnConfirmed 置 true；
 *  3. 三笔全部 confirmed 才允许把轮次写成 FINAL_FAILED（D1 只存 confirmed 0/1，
 *     dispatched = confirmed:0，confirmed = confirmed:1）。
 *
 * 铁律：不允许仅凭 keeper 声明/K 线计数就把 burn_ledger 写成 confirmed。
 */
import { bytesToHex, failureBurnId } from './boc';
import type { ChainRoundView } from './getters';
import type { ProtocolConfigFields } from './config';

export type BurnKind = 'reward' | 'team' | 'principal';

export const BURN_KINDS: readonly BurnKind[] = ['reward', 'team', 'principal'] as const;

/** burn_ledger 的稳定幂等键（与 store.finalizeFailure 的 demo 口径一致）。 */
export function burnRef(roundId: number, kind: BurnKind): string {
  return 'R' + roundId + ':' + kind;
}

/** burn queryId → { roundId, kind }（kind 未知返回 null）。 */
export function decodeBurnQueryId(queryId: bigint): { roundId: number; kind: BurnKind } | null {
  const roundId = Number((queryId >> 16n) & 0xffn);
  const kindCode = Number((queryId >> 8n) & 0xffn);
  const kind: BurnKind | null = kindCode === 1 ? 'reward' : kindCode === 2 ? 'team' : kindCode === 3 ? 'principal' : null;
  if (!kind) return null;
  return { roundId, kind };
}

/** 三笔销毁的链上金额：reward/team 来自协议常量，principal 来自本轮已接受质押总额。 */
export function expectedBurnAmount(kind: BurnKind, config: ProtocolConfigFields, roundTotalStakeRaw: bigint): bigint {
  if (kind === 'reward') return BigInt(config.roundRewardRaw);
  if (kind === 'team') return BigInt(config.teamRoundRaw);
  return roundTotalStakeRaw;
}

export interface BurnObservation {
  kind: BurnKind;
  amountRaw: bigint;
  confirmed: boolean;
}

/** 由 get_round 的确认标志推导三笔状态（0 质押时 principal 金额为 0，不写账）。 */
export function deriveBurnObservations(round: ChainRoundView, config: ProtocolConfigFields): BurnObservation[] {
  const observations: BurnObservation[] = [];
  if (round.rewardBurnConfirmed) observations.push({ kind: 'reward', amountRaw: BigInt(config.roundRewardRaw), confirmed: true });
  if (round.teamBurnConfirmed) observations.push({ kind: 'team', amountRaw: BigInt(config.teamRoundRaw), confirmed: true });
  if (round.principalBurnConfirmed && round.totalAcceptedStakeRaw > 0n) {
    observations.push({ kind: 'principal', amountRaw: round.totalAcceptedStakeRaw, confirmed: true });
  }
  return observations;
}

/** 委托复算 failureBurnId：H(roundId8‖0xff8‖configVersion32)，与合约 burnIdForRound 同口径。 */
export async function computeFailureBurnId(roundId: number, configVersion: number): Promise<string> {
  return '0x' + bytesToHex(await failureBurnId(roundId, configVersion));
}

/** 三笔是否全部确认（用于 FAILED_PERMANENT 的最终判定与 burned_raw 汇总）。 */
export function allBurnsConfirmed(round: ChainRoundView): boolean {
  if (!round.rewardBurnConfirmed || !round.teamBurnConfirmed) return false;
  // 0 质押轮没有 principal burn
  return round.totalAcceptedStakeRaw === 0n || round.principalBurnConfirmed;
}

/** 失败轮销毁总额（仅在三笔确认后可用；未确认返回 null，避免提前显示"已销毁"）。 */
export function confirmedBurnedTotal(round: ChainRoundView, config: ProtocolConfigFields): bigint | null {
  if (!allBurnsConfirmed(round)) return null;
  return BigInt(config.roundRewardRaw) + BigInt(config.teamRoundRaw) + round.totalAcceptedStakeRaw;
}
