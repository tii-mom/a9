/**
 * 社交层只读快照：一次加载 rounds / stakes / users / squads，并派生各类聚合。
 * 地址口径：stakes.address 与索引器一致（chain 模式为 raw 0:hex，demo 为友好地址）；
 * users.wallet 为用户提交的友好地址。跨表比较统一经 addressKey()。
 */
import type { Env } from '../env';
import { parseTonAddress } from '../indexer/address';
import { listRounds, listAllStakes, type RoundRow, type StakeRow } from '../store';
import { toBigInt } from '../util';
import { seasonOfRound, type SocialEnv } from './common';
import { listSquads, listUsers, type SquadRow, type UserRow } from './db';
import type { JunxiangBudgets, JunxiangInput, JunxiangMember } from './junxiang';
import { powerOf, streakOf, type PowerDeposit } from './power';
import { squadLevel } from './squad';

/** 友好地址 → 与 stakes.address 同口径的键。 */
export function addressKey(chain: boolean, wallet: string): string {
  return chain ? (parseTonAddress(wallet)?.raw ?? wallet) : wallet;
}

export interface Snapshot {
  now: number;
  chain: boolean;
  rounds: RoundRow[];
  /** 最后一个已开始（非 UNOPENED）的轮次；都未开始时取第一轮；无轮次为 null */
  focus: RoundRow | null;
  /** 最后一个已开始轮次的编号；无则 0 */
  latestRoundId: number;
  stakes: StakeRow[];
  /** roundId → (stake 键 → 该轮该地址的存款列表) */
  byRound: Map<number, Map<string, StakeRow[]>>;
  /** 地址键 → 报名过的轮次集合 */
  keyRounds: Map<string, Set<number>>;
  /** 失败轮次集合（FAILURE / FAILED_PERMANENT） */
  failedRounds: Set<number>;
  users: UserRow[];
  usersByKey: Map<string, UserRow>;
  /** 邀请人键 → 已报名过的被邀请人 */
  recruitsByKey: Map<string, UserRow[]>;
  squads: SquadRow[];
  squadsByCode: Map<string, SquadRow>;
  /** 战队码 → 成员数（users.squad_code 计数） */
  memberCount: Map<string, number>;
}

export async function loadSnapshot(env: SocialEnv, now: number): Promise<Snapshot> {
  const chain = (env.DATA_SOURCE ?? 'demo').trim() === 'chain';
  const [roundsRaw, stakes, users, squads] = await Promise.all([
    listRounds(env),
    listAllStakes(env),
    listUsers(env),
    listSquads(env),
  ]);
  const rounds = [...roundsRaw].sort((a, b) => a.round_id - b.round_id);
  const started = rounds.filter((row) => row.state !== 'UNOPENED');
  const focus = started.length ? started[started.length - 1] : (rounds[0] ?? null);
  const latestRoundId = started.length ? started[started.length - 1].round_id : 0;

  const byRound = new Map<number, Map<string, StakeRow[]>>();
  const keyRounds = new Map<string, Set<number>>();
  for (const stake of stakes) {
    let perKey = byRound.get(stake.round_id);
    if (!perKey) {
      perKey = new Map();
      byRound.set(stake.round_id, perKey);
    }
    const list = perKey.get(stake.address) ?? [];
    list.push(stake);
    perKey.set(stake.address, list);

    const staked = keyRounds.get(stake.address) ?? new Set<number>();
    staked.add(stake.round_id);
    keyRounds.set(stake.address, staked);
  }

  const failedRounds = new Set(
    rounds.filter((row) => row.result === 'FAILURE' || row.state === 'FAILED_PERMANENT').map((row) => row.round_id),
  );

  const usersByKey = new Map<string, UserRow>();
  for (const user of users) usersByKey.set(addressKey(chain, user.wallet), user);

  const recruitsByKey = new Map<string, UserRow[]>();
  for (const user of users) {
    if (!user.referrer_wallet) continue;
    if (!keyRounds.has(addressKey(chain, user.wallet))) continue;
    const referrerKey = addressKey(chain, user.referrer_wallet);
    const list = recruitsByKey.get(referrerKey) ?? [];
    list.push(user);
    recruitsByKey.set(referrerKey, list);
  }

  const memberCount = new Map<string, number>();
  for (const user of users) {
    if (user.squad_code) memberCount.set(user.squad_code, (memberCount.get(user.squad_code) ?? 0) + 1);
  }

  return {
    now,
    chain,
    rounds,
    focus,
    latestRoundId,
    stakes,
    byRound,
    keyRounds,
    failedRounds,
    users,
    usersByKey,
    recruitsByKey,
    squads,
    squadsByCode: new Map(squads.map((row) => [row.code, row])),
    memberCount,
  };
}

/** 当前赛季（按最新已开始轮次；无则第 1 赛季）。 */
export async function currentSeason(env: Env): Promise<number> {
  const rounds = await listRounds(env);
  const started = rounds.filter((row) => row.state !== 'UNOPENED');
  return seasonOfRound(Math.max(1, started.length ? started[started.length - 1].round_id : 1));
}

/** 某轮各地址战力（raw）。 */
export function powerTable(snap: Snapshot, roundId: number): Map<string, bigint> {
  const out = new Map<string, bigint>();
  const perKey = snap.byRound.get(roundId);
  if (!perKey) return out;
  const round = snap.rounds.find((row) => row.round_id === roundId);
  const openAt = round?.stake_open_at ?? null;
  for (const [key, rows] of perKey) {
    // chain 模式：索引器落库的 weight_raw 即链上权重（含时机系数）；demo 行的 weight_raw 不是权重，走时机表
    const deposits: PowerDeposit[] = rows.map((row) => ({
      amountRaw: toBigInt(row.amount_raw),
      acceptedAt: row.accepted_at,
      weightRaw: snap.chain ? toBigInt(row.weight_raw) : null,
    }));
    out.set(key, powerOf(deposits, openAt));
  }
  return out;
}

/** 多轮战力合计（用于赛季 / 轮次榜）。 */
export function powerOverRounds(snap: Snapshot, roundIds: readonly number[]): Map<string, bigint> {
  const total = new Map<string, bigint>();
  for (const roundId of roundIds) {
    for (const [key, value] of powerTable(snap, roundId)) total.set(key, (total.get(key) ?? 0n) + value);
  }
  return total;
}

/** 某轮各战队的报名人数（distinct 地址，且地址所属战队为该队）。 */
export function stakersBySquad(snap: Snapshot, roundId: number): Map<string, number> {
  const counts = new Map<string, number>();
  const perKey = snap.byRound.get(roundId);
  if (!perKey) return counts;
  for (const key of perKey.keys()) {
    const code = snap.usersByKey.get(key)?.squad_code;
    if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return counts;
}

/** 某战队在某轮的上车人数（distinct 报名地址）；无轮次为 0。等级与「还差」都按它算。 */
export function squadStakersIn(snap: Snapshot, code: string, roundId: number | null): number {
  if (roundId === null) return 0;
  return stakersBySquad(snap, roundId).get(code) ?? 0;
}

/** 某轮的军饷输入（成员 = 本轮报名者 ∪ 有人报名的战队团长）。 */
export function junxiangInputOf(snap: Snapshot, roundId: number, budgets: JunxiangBudgets): JunxiangInput {
  const perKey = snap.byRound.get(roundId) ?? new Map<string, StakeRow[]>();
  const stakers = stakersBySquad(snap, roundId);
  const keys = new Set<string>(perKey.keys());
  for (const squad of snap.squads) {
    if (squad.leader_wallet && stakers.has(squad.code)) keys.add(addressKey(snap.chain, squad.leader_wallet));
  }

  const members: JunxiangMember[] = [];
  for (const key of keys) {
    const principalRaw = (perKey.get(key) ?? []).reduce((sum, row) => sum + toBigInt(row.amount_raw), 0n);
    const user = snap.usersByKey.get(key);
    const rounds = snap.keyRounds.get(key) ?? new Set<number>();
    const firstRound = rounds.size ? Math.min(...rounds) : null;
    const squadCode = user?.squad_code ?? null;
    const leaderKey = squadCode ? snap.squadsByCode.get(squadCode)?.leader_wallet : null;
    members.push({
      wallet: key,
      principalRaw,
      isNewcomer: firstRound === roundId,
      referrer: user?.referrer_wallet ? addressKey(snap.chain, user.referrer_wallet) : null,
      referralEligible: true,
      squadCode,
      squadLeader: !!leaderKey && addressKey(snap.chain, leaderKey) === key,
      squadBonusBps: squadCode ? squadLevel(stakers.get(squadCode) ?? 0).bonusBps : 0,
      streakRounds: streakOf(rounds, roundId),
    });
  }
  return { roundId, members, budgets };
}
