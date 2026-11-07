/**
 * 新人礼（免费攻城令，docs/35 §4.4，任务单 2）。纯函数，无 I/O。
 *
 * 资格：通过邀请绑定（users.referrer_wallet 有值）且「首次建档即绑定」的钱包（见 FIRST_BIND_WINDOW_MS 的近似说明），
 *       绑定时刻 < 某城开城时刻；只在绑定后「第一座开城的轮次」获得一次。
 * 影子仓位：1 GRAM 等值的 A9（开城价未知时用 1,000 A9），权重 ×1.0；仅计入「计入下一城上车」的备注，不占用真实质押。
 * 派发：仅当本城成功（result = SUCCESS）时，
 *       payout = 本城奖励池 × shadowWeight / (本城总权重 + 全部影子权重)；
 *       预算 600 万超出时由 junxiang.ts 的预算缩放统一压回。
 */
import type { JunxiangContribution } from './junxiang';

export const NEWCOMER_META = '计入下一城上车';
/** 首次建档到绑定邀请人的最大间隔（毫秒）：users 无「首次绑定」专列，建档与首次绑定通常在同一请求内完成。 */
export const FIRST_BIND_WINDOW_MS = 60_000;
/** 1,000 A9（9 位小数）：开城价未知时的影子仓位。 */
export const NEWCOMER_FALLBACK_SHADOW_RAW = 1_000n * 1_000_000_000n;

export interface ReferralBind {
  /** 钱包键（与 junxiang 同口径） */
  wallet: string;
  /** 绑定邀请人的时刻（毫秒，users.referrer_bound_at） */
  boundAt: number;
  /** 建档时刻（毫秒，users.created_at） */
  createdAt: number;
}

export interface RoundOpen {
  round_id: number;
  stake_open_at: number | null;
}

/** 是否为「首次建档即经邀请绑定」：绑定时刻与建档时刻相差不超过 FIRST_BIND_WINDOW_MS。 */
export function isFirstBindViaInvite(bind: ReferralBind): boolean {
  return bind.boundAt >= bind.createdAt && bind.boundAt - bind.createdAt <= FIRST_BIND_WINDOW_MS;
}

/** 绑定后第一座开城的轮次编号；无则 null。 */
export function firstRoundAfter(boundAt: number, rounds: readonly RoundOpen[]): number | null {
  let best: number | null = null;
  for (const round of rounds) {
    if (round.stake_open_at === null || round.stake_open_at <= boundAt) continue;
    if (best === null || round.round_id < best) best = round.round_id;
  }
  return best;
}

/** 本城的影子仓位钱包（按钱包键升序）。 */
export function newcomerShadowWallets(binds: readonly ReferralBind[], rounds: readonly RoundOpen[], roundId: number): string[] {
  const out = new Set<string>();
  for (const bind of binds) {
    if (!isFirstBindViaInvite(bind)) continue;
    if (firstRoundAfter(bind.boundAt, rounds) !== roundId) continue;
    out.add(bind.wallet);
  }
  return [...out].sort();
}

/**
 * 影子仓位 A9 数量（raw）。两个价格都是正数时为 1 GRAM 等值：gramUsdE8 × 10^9 / a9UsdE8（USD_E8 同口径相消）；
 * 任一未知则 1,000 A9。
 */
export function shadowA9Raw(a9UsdE8: bigint | null, gramUsdE8: bigint | null): bigint {
  if (a9UsdE8 === null || gramUsdE8 === null || a9UsdE8 <= 0n || gramUsdE8 <= 0n) return NEWCOMER_FALLBACK_SHADOW_RAW;
  return (gramUsdE8 * 1_000_000_000n) / a9UsdE8;
}

/**
 * 新人礼行。wallets 为本城影子钱包；totalWeightRaw 为本城真实总权重。
 * 失败城（success=false）或无影子仓位时返回空数组。
 */
export function newcomerContributions(input: {
  roundId: number;
  success: boolean;
  rewardBudgetRaw: bigint;
  totalWeightRaw: bigint;
  wallets: readonly string[];
  shadowRaw: bigint;
}): JunxiangContribution[] {
  if (!input.success || input.wallets.length === 0 || input.shadowRaw <= 0n) return [];
  const allShadow = BigInt(input.wallets.length) * input.shadowRaw;
  const denominator = input.totalWeightRaw + allShadow;
  if (denominator <= 0n) return [];
  const out: JunxiangContribution[] = [];
  for (const wallet of input.wallets) {
    const amountRaw = (input.rewardBudgetRaw * input.shadowRaw) / denominator;
    if (amountRaw > 0n) out.push({ wallet, kind: 'newcomer', amountRaw, meta: NEWCOMER_META });
  }
  return out;
}
