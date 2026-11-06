/**
 * 军饷计算（docs/35 §4.4）。纯函数，无 I/O，金额全部 bigint。
 *
 * 口径：
 *  - 带兵饷（budget=referral）：新人本轮本金的 10% 给邀请人、5% 给新人；仅 isNewcomer 且 referralEligible 的新人计入；
 *  - 战队饷（budget=squad）：成员本金 × 全队加成 bps；团长另得全队本金的 1%（团长即使本人未报名也可领）；
 *  - 连战饷（budget=streak）：连战每城 +2%，封顶 +10%（输了也算，由调用方传入 streakRounds）；
 *  - 超预算按比例缩放（pro-rata）；单人单城上限 = 对应预算的 2%（先封顶，再按预算缩放）。
 * 不含：守城补贴、新人礼、猜灯、同资金来源合并、merkle / 领取（后续）。
 */

export const JUNXIANG_REFERRER_BPS = 1_000n;
export const JUNXIANG_REFEREE_BPS = 500n;
export const JUNXIANG_LEADER_BPS = 100n;
export const JUNXIANG_STREAK_STEP_BPS = 200n;
export const JUNXIANG_STREAK_CAP_BPS = 1_000n;
export const JUNXIANG_WALLET_CAP_BPS = 200n;

export type JunxiangBudget = 'referral' | 'squad' | 'streak';
export type JunxiangKind = 'referrer' | 'referee' | 'squad' | 'leader' | 'streak';

const BUDGET_OF: Record<JunxiangKind, JunxiangBudget> = {
  referrer: 'referral',
  referee: 'referral',
  squad: 'squad',
  leader: 'squad',
  streak: 'streak',
};

export interface JunxiangMember {
  /** 钱包键（与 referrer / squadLeader 使用同一口径；同一轮内唯一） */
  wallet: string;
  /** 本轮已接受本金（raw）；0 表示本轮未报名（仅团长可能因此只领团长饷） */
  principalRaw: bigint;
  /** 是否为本轮新人（首次报名） */
  isNewcomer: boolean;
  /** 邀请人钱包键 */
  referrer: string | null;
  /** 资金来源是否允许计入带兵饷（新人 A9 来自邀请人转账的不算，由调用方判定） */
  referralEligible: boolean;
  squadCode: string | null;
  /** 是否为所在战队的团长 */
  squadLeader: boolean;
  /** 所在战队本轮等级对应的军饷加成（bps，见 squadLevel） */
  squadBonusBps: number;
  /** 截至本轮的连续报名轮数（含本轮） */
  streakRounds: number;
}

export interface JunxiangBudgets {
  referral: bigint;
  squad: bigint;
  streak: bigint;
}

export interface JunxiangInput {
  roundId: number;
  members: readonly JunxiangMember[];
  budgets: JunxiangBudgets;
}

export interface JunxiangRow {
  roundId: number;
  wallet: string;
  kind: JunxiangKind;
  budget: JunxiangBudget;
  amountRaw: bigint;
}

const BUDGET_ORDER: JunxiangBudget[] = ['referral', 'squad', 'streak'];
const KIND_ORDER: JunxiangKind[] = ['referrer', 'referee', 'squad', 'leader', 'streak'];

function bpsOf(amount: bigint, bps: bigint): bigint {
  return (amount * bps) / 10_000n;
}

export function computeJunxiang(input: JunxiangInput): JunxiangRow[] {
  // 1) 按 (budget, wallet, kind) 累加原始金额
  const raw = new Map<string, { wallet: string; kind: JunxiangKind; budget: JunxiangBudget; amount: bigint }>();
  const add = (wallet: string, kind: JunxiangKind, amount: bigint): void => {
    if (amount <= 0n) return;
    const budget = BUDGET_OF[kind];
    const key = `${budget}|${wallet}|${kind}`;
    const hit = raw.get(key);
    if (hit) hit.amount += amount;
    else raw.set(key, { wallet, kind, budget, amount });
  };

  // 战队本金合计（团长饷的基数）
  const squadTotal = new Map<string, bigint>();
  for (const member of input.members) {
    if (!member.squadCode || member.principalRaw <= 0n) continue;
    squadTotal.set(member.squadCode, (squadTotal.get(member.squadCode) ?? 0n) + member.principalRaw);
  }

  for (const member of input.members) {
    const principal = member.principalRaw;
    if (principal > 0n) {
      if (member.isNewcomer && member.referrer && member.referralEligible && member.referrer !== member.wallet) {
        add(member.wallet, 'referee', bpsOf(principal, JUNXIANG_REFEREE_BPS));
        add(member.referrer, 'referrer', bpsOf(principal, JUNXIANG_REFERRER_BPS));
      }
      if (member.squadCode && member.squadBonusBps > 0) {
        add(member.wallet, 'squad', bpsOf(principal, BigInt(member.squadBonusBps)));
      }
      if (member.streakRounds > 0) {
        const streakBps = BigInt(Math.min(member.streakRounds, 1_000_000)) * JUNXIANG_STREAK_STEP_BPS;
        add(member.wallet, 'streak', bpsOf(principal, streakBps < JUNXIANG_STREAK_CAP_BPS ? streakBps : JUNXIANG_STREAK_CAP_BPS));
      }
    }
    if (member.squadLeader && member.squadCode) {
      add(member.wallet, 'leader', bpsOf(squadTotal.get(member.squadCode) ?? 0n, JUNXIANG_LEADER_BPS));
    }
  }

  const rows = [...raw.values()];

  // 2) 单人单城上限：同一钱包在同一预算内的合计 ≤ 预算 × 2%（超出则等比缩小该钱包的行）
  const byWalletBudget = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.budget}|${row.wallet}`;
    const list = byWalletBudget.get(key) ?? [];
    list.push(row);
    byWalletBudget.set(key, list);
  }
  for (const list of byWalletBudget.values()) {
    const budget = input.budgets[list[0].budget];
    const cap = bpsOf(budget, JUNXIANG_WALLET_CAP_BPS);
    const total = list.reduce((sum, row) => sum + row.amount, 0n);
    if (total > cap) {
      for (const row of list) row.amount = total === 0n ? 0n : (row.amount * cap) / total;
    }
  }

  // 3) 超预算按比例缩放
  for (const budgetName of BUDGET_ORDER) {
    const list = rows.filter((row) => row.budget === budgetName);
    const budget = input.budgets[budgetName];
    const total = list.reduce((sum, row) => sum + row.amount, 0n);
    if (total > budget) {
      for (const row of list) row.amount = total === 0n ? 0n : (row.amount * budget) / total;
    }
  }

  // 4) 输出：去掉 0 行，按 预算 → 钱包 → 类型 排序（确定性）
  return rows
    .filter((row) => row.amount > 0n)
    .sort((a, b) => {
      const byBudget = BUDGET_ORDER.indexOf(a.budget) - BUDGET_ORDER.indexOf(b.budget);
      if (byBudget !== 0) return byBudget;
      if (a.wallet !== b.wallet) return a.wallet < b.wallet ? -1 : 1;
      return KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
    })
    .map((row) => ({ roundId: input.roundId, wallet: row.wallet, kind: row.kind, budget: row.budget, amountRaw: row.amount }));
}
