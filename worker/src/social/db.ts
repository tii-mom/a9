/**
 * 社交层 D1 读写（仅操作 users / squads / share_clicks / junxiang）。
 * 金额 TEXT 保存 raw 字符串；时间 INTEGER 毫秒。
 */
import type { Env } from '../env';
import type { SocialSource } from '@shared/types';
import { inviteCodeOf } from './common';
import type { JunxiangRow } from './junxiang';

export interface UserRow {
  wallet: string;
  tg_user_id: string | null;
  invite_code: string;
  referrer_wallet: string | null;
  ref_source: SocialSource | null;
  squad_code: string | null;
  squad_changed_season: number | null;
  created_at: number;
}

export interface SquadRow {
  code: string;
  name: string;
  leader_wallet: string | null;
  tg_chat_id: string | null;
  season: number;
  created_at: number;
}

export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

export async function listUsers(env: Env): Promise<UserRow[]> {
  const res = await env.DB.prepare('SELECT * FROM users').all<UserRow>();
  return res.results ?? [];
}

export async function listSquads(env: Env): Promise<SquadRow[]> {
  const res = await env.DB.prepare('SELECT * FROM squads').all<SquadRow>();
  return res.results ?? [];
}

export async function getUser(env: Env, wallet: string): Promise<UserRow | null> {
  return (await env.DB.prepare('SELECT * FROM users WHERE wallet = ?').bind(wallet).first<UserRow>()) ?? null;
}

export async function getUserByInvite(env: Env, code: string): Promise<UserRow | null> {
  return (await env.DB.prepare('SELECT * FROM users WHERE invite_code = ?').bind(code).first<UserRow>()) ?? null;
}

export async function getSquad(env: Env, code: string): Promise<SquadRow | null> {
  return (await env.DB.prepare('SELECT * FROM squads WHERE code = ?').bind(code).first<SquadRow>()) ?? null;
}

export async function getSquadByTgChat(env: Env, tgChatId: string): Promise<SquadRow | null> {
  return (await env.DB.prepare('SELECT * FROM squads WHERE tg_chat_id = ?').bind(tgChatId).first<SquadRow>()) ?? null;
}

/**
 * 确保用户存在（不存在则按钱包 SHA-256 生成邀请码写入）。
 * 邀请码极小概率冲突时换 salt 重试。
 */
export async function ensureUser(env: Env, wallet: string, now: number): Promise<UserRow> {
  const existing = await getUser(env, wallet);
  if (existing) return existing;
  for (const salt of ['', '1', '2', '3']) {
    const code = await inviteCodeOf(wallet, salt);
    const res = await env.DB.prepare(
      'INSERT OR IGNORE INTO users (wallet, invite_code, created_at) VALUES (?, ?, ?)',
    )
      .bind(wallet, code, now)
      .run();
    if ((res.meta?.changes ?? 0) > 0) break;
    const raced = await getUser(env, wallet);
    if (raced) return raced;
  }
  const row = await getUser(env, wallet);
  if (!row) throw new Error('social: 无法生成邀请码');
  return row;
}

/** 写入 Telegram 账号；返回 false 表示该 TG 账号已绑定其它钱包。 */
export async function setUserTg(env: Env, wallet: string, tgUserId: string): Promise<boolean> {
  try {
    await env.DB.prepare('UPDATE users SET tg_user_id = ? WHERE wallet = ?').bind(tgUserId, wallet).run();
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

/** 首次绑定邀请人（referrer_wallet 为空才写入）；返回是否真正写入。 */
export async function setUserReferrer(
  env: Env,
  wallet: string,
  referrerWallet: string,
  source: SocialSource,
): Promise<boolean> {
  const res = await env.DB.prepare(
    'UPDATE users SET referrer_wallet = ?, ref_source = ? WHERE wallet = ? AND referrer_wallet IS NULL',
  )
    .bind(referrerWallet, source, wallet)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/** 设置战队归属；changedSeason 为 null 时保留原值。 */
export async function setUserSquad(
  env: Env,
  wallet: string,
  code: string,
  changedSeason: number | null,
): Promise<void> {
  await env.DB.prepare(
    'UPDATE users SET squad_code = ?, squad_changed_season = COALESCE(?, squad_changed_season) WHERE wallet = ?',
  )
    .bind(code, changedSeason, wallet)
    .run();
}

export async function insertSquad(env: Env, row: SquadRow): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO squads (code, name, leader_wallet, tg_chat_id, season, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(row.code, row.name, row.leader_wallet, row.tg_chat_id, row.season, row.created_at)
    .run();
}

export async function insertShareClick(env: Env, code: string, src: SocialSource, now: number): Promise<void> {
  await env.DB.prepare('INSERT INTO share_clicks (code, src, created_at) VALUES (?, ?, ?)')
    .bind(code, src, now)
    .run();
}

/** 覆盖写入某一轮的军饷明细（同一轮重算时先删后写，整体一个 batch）。 */
export async function replaceJunxiang(env: Env, roundId: number, rows: JunxiangRow[], now: number): Promise<void> {
  const statements = [env.DB.prepare('DELETE FROM junxiang WHERE round_id = ?').bind(roundId)];
  for (const row of rows) {
    statements.push(
      env.DB.prepare(
        'INSERT INTO junxiang (round_id, wallet, kind, budget, amount_raw, computed_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind(row.roundId, row.wallet, row.kind, row.budget, row.amountRaw.toString(), now),
    );
  }
  await env.DB.batch(statements);
}
