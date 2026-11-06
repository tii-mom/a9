/**
 * 军饷计算（docs/35 §4.4）。纯函数，无 I/O，金额全部 bigint。
 *
 * 口径：
 *  - 带兵饷（budget=referral）：新人本轮本金的 10% 给邀请人、5% 给新人；仅 isNewcomer 且 referralEligible 的新人计入；
 *  - 战队饷（budget=squad）：成员本金 × 全队加成 bps；团长另得全队本金的 1%（团长即使本人未报名也可领）；
 *  - 连战饷（budget=streak）：连战每城 +2%，封顶 +10%（输了也算，由调用方传入 streakRounds）；
 *  - 守城补贴（budget=guard）、新人礼（budget=newcomer）、猜灯（budget=guess）：由 guard.ts / newcomer.ts / guess.ts
 *    算出 JunxiangContribution 后经 input.contributions 并入，与上面各项同样受预算、上限约束；
 *  - 同资金来源合并（input.clusterOf）：同一簇的钱包共享一个单人上限；
 *  - 上限：单人（或单簇）单城在同一预算线内的合计 ≤ 预算线 × 2%（先封顶，再按预算缩放）；
 *    连战与猜灯共用 200 万线：线额 = streak + guess，上限按线额计；
 *  - 超预算按比例缩放（pro-rata），按各预算单独缩放。
 */

export const JUNXIANG_REFERRER_BPS = 1_000n;
export const JUNXIANG_REFEREE_BPS = 500n;
export const JUNXIANG_LEADER_BPS = 100n;
export const JUNXIANG_STREAK_STEP_BPS = 200n;
export const JUNXIANG_STREAK_CAP_BPS = 1_000n;
export const JUNXIANG_WALLET_CAP_BPS = 200n;

export type JunxiangBudget = 'referral' | 'squad' | 'streak' | 'guard' | 'newcomer' | 'guess';
export type JunxiangKind = 'referrer' | 'referee' | 'squad' | 'leader' | 'streak' | 'guard' | 'newcomer' | 'guess';
/** 由 guard / newcomer / guess 模块产出、经 contributions 并入的行类型 */
export type JunxiangContributionKind = 'guard' | 'newcomer' | 'guess';

const BUDGET_OF: Record<JunxiangKind, JunxiangBudget> = {
  referrer: 'referral',
  referee: 'referral',
  squad: 'squad',
  leader: 'squad',
  streak: 'streak',
  guard: 'guard',
  newcomer: 'newcomer',
  guess: 'guess',
};

/** 预算线：guess 与 streak 共用同一条 200 万线（单人上限按线额算） */
type JunxiangLine = 'referral' | 'squad' | 'streak' | 'guard' | 'newcomer';

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

/** 各预算线额（raw）。guard / newcomer / guess 缺省为 0（不产生对应行）。 */
export interface JunxiangBudgets {
  referral: bigint;
  squad: bigint;
  /** 连战饷线额（不含猜灯）；A9 默认 150 万（200 万线去掉猜灯 50 万） */
  streak: bigint;
  guard?: bigint;
  newcomer?: bigint;
  /** 猜灯线额；A9 默认 50 万 */
  guess?: bigint;
}

/** 外部模块算出的额外行（守城补贴 / 新人礼 / 猜灯）。金额为 raw，仍受预算与上限约束。 */
export interface JunxiangContribution {
  wallet: string;
  kind: JunxiangContributionKind;
  amountRaw: bigint;
  /** 行备注（如「计入下一城上车」），原样写入 junxiang.meta */
  meta?: string | null;
}

export interface JunxiangInput {
  roundId: number;
  members: readonly JunxiangMember[];
  budgets: JunxiangBudgets;
  contributions?: readonly JunxiangContribution[];
  /** 资金来源聚类：wallet → clusterId。缺省时每个钱包自成一簇（即按钱包计上限）。 */
  clusterOf?: ReadonlyMap<string, string>;
}

export interface JunxiangRow {
  roundId: number;
  wallet: string;
  kind: JunxiangKind;
  budget: JunxiangBudget;
  amountRaw: bigint;
  meta?: string | null;
}

const BUDGET_ORDER: JunxiangBudget[] = ['referral', 'squad', 'streak', 'guess', 'guard', 'newcomer'];
const KIND_ORDER: JunxiangKind[] = ['referrer', 'referee', 'squad', 'leader', 'streak', 'guard', 'newcomer', 'guess'];

function bpsOf(amount: bigint, bps: bigint): bigint {
  return (amount * bps) / 10_000n;
}

function amountOfBudget(budgets: JunxiangBudgets, name: JunxiangBudget): bigint {
  switch (name) {
    case 'referral':
      return budgets.referral;
    case 'squad':
      return budgets.squad;
    case 'streak':
      return budgets.streak;
    case 'guard':
      return budgets.guard ?? 0n;
    case 'newcomer':
      return budgets.newcomer ?? 0n;
    case 'guess':
      return budgets.guess ?? 0n;
  }
}

function lineOf(budget: JunxiangBudget): JunxiangLine {
  return budget === 'guess' ? 'streak' : budget;
}

/** 预算线额：连战 + 猜灯共用 200 万线。 */
function lineAmount(budgets: JunxiangBudgets, line: JunxiangLine): bigint {
  if (line === 'streak') return amountOfBudget(budgets, 'streak') + amountOfBudget(budgets, 'guess');
  return amountOfBudget(budgets, line);
}

export function computeJunxiang(input: JunxiangInput): JunxiangRow[] {
  // 1) 按 (budget, wallet, kind) 累加原始金额
  const raw = new Map<string, { wallet: string; kind: JunxiangKind; budget: JunxiangBudget; amount: bigint; meta: string | null }>();
  const add = (wallet: string, kind: JunxiangKind, amount: bigint, meta: string | null = null): void => {
    if (amount <= 0n) return;
    const budget = BUDGET_OF[kind];
    const key = `${budget}|${wallet}|${kind}`;
    const hit = raw.get(key);
    if (hit) hit.amount += amount;
    else raw.set(key, { wallet, kind, budget, amount, meta });
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

  for (const contribution of input.contributions ?? []) {
    add(contribution.wallet, contribution.kind, contribution.amountRaw, contribution.meta ?? null);
  }

  const rows = [...raw.values()];

  // 2) 单人（单簇）单城上限：同一簇在同一预算线内的合计 ≤ 线额 × 2%（超出则等比缩小该簇的行）
  const clusterOf = input.clusterOf;
  const byCluster = new Map<string, typeof rows>();
  for (const row of rows) {
    const cluster = clusterOf?.get(row.wallet) ?? row.wallet;
    const key = `${lineOf(row.budget)}|${cluster}`;
    const list = byCluster.get(key) ?? [];
    list.push(row);
    byCluster.set(key, list);
  }
  for (const list of byCluster.values()) {
    const cap = bpsOf(lineAmount(input.budgets, lineOf(list[0].budget)), JUNXIANG_WALLET_CAP_BPS);
    const total = list.reduce((sum, row) => sum + row.amount, 0n);
    if (total > cap) {
      for (const row of list) row.amount = total === 0n ? 0n : (row.amount * cap) / total;
    }
  }

  // 3) 超预算按比例缩放（各预算单独缩放）
  for (const budgetName of BUDGET_ORDER) {
    const list = rows.filter((row) => row.budget === budgetName);
    const budget = amountOfBudget(input.budgets, budgetName);
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
    .map((row) => ({
      roundId: input.roundId,
      wallet: row.wallet,
      kind: row.kind,
      budget: row.budget,
      amountRaw: row.amount,
      meta: row.meta,
    }));
}

/** A9 精度（TOKEN_DECIMALS = 9，见 protocol.ts）。 */
export const A9_UNIT = 1_000_000_000n;

/**
 * A9 每城各预算线额（docs/35 §4.4）：带兵 1,600 万 / 战队 600 万 / 守城补贴 1,000 万 / 新人礼 600 万 /
 * 连战 + 猜灯 200 万（猜灯 50 万，连战 150 万）。
 */
export const JUNXIANG_A9_BUDGETS: JunxiangBudgets = {
  referral: 16_000_000n * A9_UNIT,
  squad: 6_000_000n * A9_UNIT,
  streak: 1_500_000n * A9_UNIT,
  guess: 500_000n * A9_UNIT,
  guard: 10_000_000n * A9_UNIT,
  newcomer: 6_000_000n * A9_UNIT,
};
