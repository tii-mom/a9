/**
 * V8 奖励三态 / 权重 / 邀请 / 解锁 —— 数据适配与兜底。
 * 字段以 shared/types.ts（backend-dev 定稿）为准；为兼容后端灰度/演示数据，
 * 缺失字段用安全兜底值（不会抛错、不会显示 NaN）。
 */

import type { MeResponse, ReferralInfo, RoundReward, StakePosition, UnlockInfo } from '@shared/types';
import { normalizeFriendlyAddress, parseTonAddress, shortenAddress, toFriendlyAddress, toRawAddress } from './address';
import { UNLOCK_MONTHS, UNLOCK_PERIOD_SECONDS } from './protocol';

export type RewardStateName = 'PENDING' | 'ROLLED' | 'EARLY';

export interface RewardRowView {
  roundId: number;
  state: RewardStateName;
  amountRaw: string;
  rollableRaw: string;
  earlyAmountRaw: string;
  paidRaw: string;
  lockedRaw: string;
  rolledRaw: string;
}

export interface UnlockView {
  active: boolean;
  unlockStart: number;
  endAt: number;
  durationSeconds: number;
  totalLockedRaw: string;
  claimedRaw: string;
  claimableRaw: string;
  /** 0..10000 */
  progressBps: number;
}

export interface ReferralView extends ReferralInfo {
  referrer: string | null;
}

export interface StreakView {
  lastRound: number;
  count: number;
  /** 权重倍数 bps（1.10× = 11000） */
  weightMultiplierBps: number;
}

const ZERO = '0';

function toBigIntSafe(value: string | null | undefined): bigint {
  try {
    return BigInt(String(value ?? ZERO));
  } catch {
    return 0n;
  }
}

function normalizeRow(row: RoundReward): RewardRowView {
  const amountRaw = String(row.amountRaw ?? ZERO);
  const amount = toBigIntSafe(amountRaw);
  return {
    roundId: Number(row.roundId) || 0,
    state: rewardStateName(row.state),
    amountRaw,
    rollableRaw: String(row.rollableRaw ?? ZERO),
    earlyAmountRaw: String(row.earlyAmountRaw ?? (amount / 2n).toString()),
    paidRaw: String(row.paidRaw ?? ZERO),
    lockedRaw: String(row.lockedRaw ?? ZERO),
    rolledRaw: String(row.rolledRaw ?? ZERO),
  };
}

export function rewardStateName(code: number | string | null | undefined): RewardStateName {
  if (code === 1 || code === 'ROLLED' || code === 'rolled') return 'ROLLED';
  if (code === 2 || code === 'EARLY' || code === 'early') return 'EARLY';
  return 'PENDING';
}

/**
 * 每轮奖励三态列表（按轮次倒序）。
 * 优先 me.rewards；旧后端无该字段时从 claimable 的 rewardRaw 兜底为 PENDING。
 */
export function readRewardRows(me: MeResponse | null | undefined): RewardRowView[] {
  const rewards = (me as unknown as { rewards?: RoundReward[] } | null | undefined)?.rewards;
  if (Array.isArray(rewards) && rewards.length > 0) {
    return rewards
      .filter((row) => Number(row?.roundId) > 0)
      .map(normalizeRow)
      .sort((a, b) => b.roundId - a.roundId);
  }

  const rows: RewardRowView[] = (me?.claimable ?? [])
    .filter((item) => toBigIntSafe(item.rewardRaw) > 0n)
    .map((item) => ({
      roundId: item.roundId,
      state: 'PENDING' as RewardStateName,
      amountRaw: String(item.rewardRaw),
      rollableRaw: String(item.rewardRaw),
      earlyAmountRaw: (toBigIntSafe(item.rewardRaw) / 2n).toString(),
      paidRaw: ZERO,
      lockedRaw: ZERO,
      rolledRaw: ZERO,
    }));

  const seen = new Set<number>();
  return rows
    .filter((row) => {
      if (seen.has(row.roundId)) return false;
      seen.add(row.roundId);
      return true;
    })
    .sort((a, b) => b.roundId - a.roundId);
}

/** 解锁池：优先 me.unlock；缺失时按 totals.lockedRewardRaw 做只读兜底展示。 */
export function readUnlockInfo(me: MeResponse | null | undefined): UnlockView {
  const raw = (me as unknown as { unlock?: UnlockInfo } | null | undefined)?.unlock;
  const lockedTotal =
    (me as unknown as { totals?: { lockedRewardRaw?: string } } | null | undefined)?.totals?.lockedRewardRaw ?? ZERO;
  if (raw && typeof raw === 'object') {
    const active = Boolean(raw.active);
    const durationSeconds = Number(raw.durationSeconds) > 0 ? Number(raw.durationSeconds) : UNLOCK_PERIOD_SECONDS;
    const unlockStart = Number(raw.unlockStart) > 0 ? Number(raw.unlockStart) : 0;
    const endAt = Number(raw.endAt) > 0 ? Number(raw.endAt) : unlockStart > 0 ? unlockStart + durationSeconds * 1000 : 0;
    let progressBps = Number(raw.progressBps);
    if (!Number.isFinite(progressBps) || progressBps < 0) {
      progressBps =
        unlockStart > 0
          ? Math.min(10000, Math.max(0, Math.floor(((Date.now() - unlockStart) / (durationSeconds * 1000)) * 10000)))
          : 0;
    }
    return {
      active,
      unlockStart,
      endAt,
      durationSeconds,
      totalLockedRaw: String(raw.totalLockedRaw ?? ZERO),
      claimedRaw: String(raw.claimedRaw ?? ZERO),
      claimableRaw: String(raw.claimableRaw ?? ZERO),
      progressBps: Math.min(10000, Math.max(0, Math.floor(progressBps))),
    };
  }
  return {
    active: false,
    unlockStart: 0,
    endAt: 0,
    durationSeconds: UNLOCK_PERIOD_SECONDS,
    totalLockedRaw: String(lockedTotal ?? ZERO),
    claimedRaw: ZERO,
    claimableRaw: ZERO,
    progressBps: 0,
  };
}

/** 邀请关系与加成：优先 me.referral；referrer 统一转友好地址展示。 */
export function readReferralInfo(me: MeResponse | null | undefined, testnet: boolean): ReferralView {
  const raw = (me as unknown as { referral?: Partial<ReferralInfo> } | null | undefined)?.referral;
  const referrerRaw = raw?.referrer ?? null;
  let referrer: string | null = null;
  if (referrerRaw) {
    try {
      referrer = toFriendlyAddress(parseTonAddress(referrerRaw), testnet, true);
    } catch {
      referrer = referrerRaw;
    }
  }
  return {
    referrer,
    invitedCount: Number(raw?.invitedCount ?? 0) || 0,
    invitedStakeRaw: String(raw?.invitedStakeRaw ?? ZERO),
    bonusThisRoundRaw: String(raw?.bonusThisRoundRaw ?? ZERO),
    bonusTotalRaw: String(raw?.bonusTotalRaw ?? ZERO),
  };
}

/** 连续参与与权重倍数：优先 me.stake；缺失时按 stakes 连续轮次推断。 */
export function readStreakInfo(
  me: MeResponse | null | undefined,
  stakes: StakePosition[],
  fallbackBonusBps = 1000,
  fallbackMaxRounds = 10,
): StreakView {
  const raw = (me as unknown as { stake?: { lastRound?: number; count?: number; weightMultiplierBps?: number } } | null | undefined)?.stake;
  if (raw && (Number(raw.count) > 0 || Number(raw.weightMultiplierBps) > 0)) {
    const count = Math.max(0, Math.floor(Number(raw.count) || 0));
    const bps =
      Number(raw.weightMultiplierBps) > 0
        ? Math.round(Number(raw.weightMultiplierBps))
        : 10000 + fallbackBonusBps * Math.min(count, fallbackMaxRounds);
    return { lastRound: Math.max(0, Math.floor(Number(raw.lastRound) || 0)), count, weightMultiplierBps: bps };
  }

  const rounds = [...stakes].map((s) => s.roundId).sort((a, b) => b - a);
  if (rounds.length === 0) return { lastRound: 0, count: 0, weightMultiplierBps: 10000 };
  let count = 1;
  for (let i = 1; i < rounds.length; i += 1) {
    if (rounds[i] === rounds[i - 1] - 1) count += 1;
    else break;
  }
  return {
    lastRound: rounds[0],
    count,
    weightMultiplierBps: 10000 + fallbackBonusBps * Math.min(count, fallbackMaxRounds),
  };
}

/** 当前轮质押的权重倍数（bps）；没有当轮质押时用 streak 推断值。 */
export function currentWeightMultiplierBps(stakes: StakePosition[], roundId: number | null, fallbackBps: number): number {
  if (roundId !== null) {
    const stake = stakes.find((item) => item.roundId === roundId);
    if (stake) {
      if (Number(stake.weightMultiplierBps) > 0) return Math.round(Number(stake.weightMultiplierBps));
      const amount = toBigIntSafe(stake.amountRaw);
      const weight = toBigIntSafe(stake.weightRaw);
      if (amount > 0n && weight > 0n) return Number((weight * 10000n) / amount);
    }
  }
  return fallbackBps;
}

export function multiplierText(bps: number): string {
  return (Math.max(0, bps) / 10000).toFixed(2) + '×';
}

/* ------------------------------------------------------------------ */
/* 邀请码 / 带参链接 / 待绑定邀请人                                      */
/* ------------------------------------------------------------------ */

const PENDING_REFERRER_KEY = 'fuse.referral.pending.v1';

/** 邀请码 = 地址的友好编码（无后端注册表时也能被对方还原成地址）。 */
export function inviteCodeFor(address: string): string {
  try {
    return toFriendlyAddress(parseTonAddress(address), /^(kQ|0Q)/.test(address), true);
  } catch {
    return address;
  }
}

/** 邀请链接：落到 /me 质押页并自动带上 ref 参数（由本模块 capture 后引导 SetReferrer）。 */
export function inviteLinkFor(code: string, origin?: string): string {
  const base = origin ?? (typeof window !== 'undefined' ? window.location.origin : 'https://a9.lat');
  return base.replace(/\/+$/, '') + '/me?ref=' + encodeURIComponent(code);
}

/** 解析邀请码/地址；非法返回 null。 */
export function parseInviteCode(code: string | null | undefined, testnet: boolean): { friendly: string; raw: string } | null {
  if (!code) return null;
  const value = String(code).trim();
  if (!value) return null;
  try {
    const parsed = parseTonAddress(value);
    return { friendly: toFriendlyAddress(parsed, testnet, true), raw: toRawAddress(parsed) };
  } catch {
    return null;
  }
}

function readPendingRaw(): string | null {
  try {
    return window.localStorage.getItem(PENDING_REFERRER_KEY);
  } catch {
    return null;
  }
}

function writePendingRaw(value: string | null): void {
  try {
    if (value) window.localStorage.setItem(PENDING_REFERRER_KEY, value);
    else window.localStorage.removeItem(PENDING_REFERRER_KEY);
  } catch {
    /* 隐私模式忽略 */
  }
}

/**
 * 从 URL ?ref= 捕获邀请人（幂等）：合法地址且非自己时写入 localStorage。
 * 返回捕获到的地址（friendly）或已有的待绑定值。
 */
export function captureInviteFromLocation(address?: string | null, search?: string): string | null {
  const query = search ?? (typeof window !== 'undefined' ? window.location.search : '');
  let captured: string | null = null;
  try {
    const params = new URLSearchParams(query);
    const ref = params.get('ref');
    if (ref) {
      const parsed = parseInviteCode(ref, true);
      if (parsed) captured = parsed.friendly;
    }
  } catch {
    /* ignore */
  }
  if (captured) {
    if (address) {
      try {
        if (toRawAddress(parseTonAddress(address)) === toRawAddress(parseTonAddress(captured))) return null;
      } catch {
        /* ignore */
      }
    }
    writePendingRaw(captured);
    return captured;
  }
  return readPendingReferrer();
}

/** 待绑定邀请人（尚未 SetReferrer）。 */
export function readPendingReferrer(): string | null {
  return readPendingRaw();
}

export function clearPendingReferrer(): void {
  writePendingRaw(null);
}

/** 地址展示：raw → 友好（失败原样）。 */
export function displayAddress(value: string | null | undefined, testnet: boolean): string {
  if (!value) return '—';
  try {
    return toFriendlyAddress(parseTonAddress(value), testnet, true);
  } catch {
    return value;
  }
}

/** 地址短展示。 */
export function shortAddress(value: string | null | undefined, head = 6, tail = 6): string {
  if (!value) return '—';
  return shortenAddress(normalizeFriendlyAddress(value, true), head, tail);
}

export const UNLOCK_MONTHS_LABEL = UNLOCK_MONTHS;
