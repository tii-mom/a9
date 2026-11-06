/**
 * 城门纯函数（无 I/O）：剩余美元与阶段映射。
 */
import type { SocialRoundPhase } from '@shared/types';

/**
 * 破城还差多少美元：remainingUsd = poolUsdt × (sqrt(gate / price) − 1)，下限 0。
 * 价格或城门价无效（非有限数 / ≤ 0）时返回 null，避免除零。
 */
export function remainingUsd(poolUsdt: number, gatePriceUsd: number, priceUsd: number): number | null {
  if (![poolUsdt, gatePriceUsd, priceUsd].every((value) => Number.isFinite(value))) return null;
  if (gatePriceUsd <= 0 || priceUsd <= 0) return null;
  const value = poolUsdt * (Math.sqrt(gatePriceUsd / priceUsd) - 1);
  return value > 0 ? value : 0;
}

/**
 * 轮次状态 → 对外阶段。
 * UNOPENED → preview；STAKING_OPEN → staking；
 * OBSERVING / STAKING_CLOSED / ORACLE_PAUSED → observing（报名已关、等待判定或暂停中）；
 * SUCCEEDED / FAILED_PERMANENT / TECHNICAL_ABORTED / SETTLING_* → settled。
 */
export function phaseOf(state: string | null | undefined): SocialRoundPhase {
  switch (state) {
    case 'STAKING_OPEN':
      return 'staking';
    case 'OBSERVING':
    case 'STAKING_CLOSED':
    case 'ORACLE_PAUSED':
      return 'observing';
    case 'SUCCEEDED':
    case 'FAILED_PERMANENT':
    case 'TECHNICAL_ABORTED':
    case 'SETTLING_SUCCESS':
    case 'SETTLING_FAILURE':
      return 'settled';
    default:
      return 'preview';
  }
}
