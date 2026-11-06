/**
 * D1 访问层。直接使用 users / squads 表（列名见任务单），不 import social/。
 * tg_chat_id / tg_user_id 统一按字符串绑定：TEXT 与 INTEGER 列都能正确比较。
 */
import { countStakersBySquad } from './squad';
import type { SquadRow, SquadWithMembers } from './types';

export interface UserLink {
  wallet: string;
  squadCode: string | null;
}

interface UserRow {
  wallet: string;
  squad_code: string | null;
}

interface SquadDbRow {
  code: string;
  name: string;
  leader_wallet: string;
  tg_chat_id: string | number;
}

interface SquadMemberRow extends SquadDbRow {
  members: number;
}

function toSquad(row: SquadDbRow): SquadRow {
  return {
    code: row.code,
    name: row.name,
    leaderWallet: row.leader_wallet,
    tgChatId: String(row.tg_chat_id),
  };
}

export async function findUserByTgId(db: D1Database, tgUserId: string): Promise<UserLink | null> {
  const row = await db
    .prepare('SELECT wallet, squad_code FROM users WHERE tg_user_id = ? LIMIT 1')
    .bind(tgUserId)
    .first<UserRow>();
  return row ? { wallet: row.wallet, squadCode: row.squad_code ?? null } : null;
}

export async function findSquadByChat(db: D1Database, chatId: string): Promise<SquadRow | null> {
  const row = await db
    .prepare('SELECT code, name, leader_wallet, tg_chat_id FROM squads WHERE tg_chat_id = ? LIMIT 1')
    .bind(chatId)
    .first<SquadDbRow>();
  return row ? toSquad(row) : null;
}

export async function findSquadByCode(db: D1Database, code: string): Promise<SquadRow | null> {
  const row = await db
    .prepare('SELECT code, name, leader_wallet, tg_chat_id FROM squads WHERE code = ? LIMIT 1')
    .bind(code)
    .first<SquadDbRow>();
  return row ? toSquad(row) : null;
}

export async function squadCodeExists(db: D1Database, code: string): Promise<boolean> {
  const row = await db.prepare('SELECT 1 AS hit FROM squads WHERE code = ? LIMIT 1').bind(code).first();
  return row !== null;
}

/** 所有已绑定群的战队，附带成员数（排名与摘要用）。 */
export async function listSquadsWithMembers(db: D1Database): Promise<SquadWithMembers[]> {
  const res = await db
    .prepare(
      `SELECT s.code, s.name, s.leader_wallet, s.tg_chat_id,
              (SELECT COUNT(*) FROM users u WHERE u.squad_code = s.code) AS members
         FROM squads s
        WHERE s.tg_chat_id IS NOT NULL`,
    )
    .all<SquadMemberRow>();
  return (res.results ?? []).map((row) => ({ ...toSquad(row), members: Number(row.members) || 0 }));
}

/** 所有已绑定群的 chat id（K 线推送用）。 */
export async function listSquadChatIds(db: D1Database): Promise<string[]> {
  const res = await db
    .prepare('SELECT tg_chat_id FROM squads WHERE tg_chat_id IS NOT NULL')
    .all<{ tg_chat_id: string | number }>();
  return (res.results ?? []).map((row) => String(row.tg_chat_id));
}

export async function insertSquad(
  db: D1Database,
  squad: { code: string; name: string; leaderWallet: string; tgChatId: string },
): Promise<void> {
  await db
    .prepare('INSERT INTO squads (code, name, leader_wallet, tg_chat_id) VALUES (?, ?, ?, ?)')
    .bind(squad.code, squad.name, squad.leaderWallet, squad.tgChatId)
    .run();
}

export async function setUserSquad(db: D1Database, wallet: string, code: string): Promise<void> {
  await db.prepare('UPDATE users SET squad_code = ? WHERE wallet = ?').bind(code, wallet).run();
}

/**
 * 占用一根 K 线的推送名额（bot_pushes 主键去重）。
 * 返回 true = 本次新占用，应当推送；false = 已推过（重放 / 重索引）。
 */
export async function claimCandlePush(db: D1Database, roundId: number, candleIndex: number, nowMs: number): Promise<boolean> {
  const res = await db
    .prepare('INSERT OR IGNORE INTO bot_pushes (round_id, candle_index, pushed_at) VALUES (?, ?, ?)')
    .bind(roundId, candleIndex, nowMs)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/** 某轮截至 upToIndex（含）已亮盏数（candles.qualified = 1 的根数）。 */
export async function countLitCandles(db: D1Database, roundId: number, upToIndex: number): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM candles WHERE round_id = ? AND candle_index <= ? AND qualified = 1')
    .bind(roundId, upToIndex)
    .first<{ n: number }>();
  return Number(row?.n) || 0;
}

/**
 * 本城（最新已开始轮次）各战队的上车人数（distinct 地址）。
 * 与 social/snapshot.ts 的 stakersBySquad 同口径（见 countStakersBySquad）：
 * 「等级 / 还差 N 人」只按这个数算，不用 users 的成员总数。
 */
export async function stakersThisRoundByCode(db: D1Database): Promise<Map<string, number>> {
  const focus = await db
    .prepare("SELECT round_id FROM rounds WHERE state != 'UNOPENED' ORDER BY round_id DESC LIMIT 1")
    .first<{ round_id: number }>();
  if (!focus) return new Map();
  const stakes = await db
    .prepare('SELECT DISTINCT address FROM stakes WHERE round_id = ?')
    .bind(focus.round_id)
    .all<{ address: string }>();
  const users = await db
    .prepare('SELECT wallet, squad_code FROM users WHERE squad_code IS NOT NULL')
    .all<{ wallet: string; squad_code: string }>();
  return countStakersBySquad(
    (stakes.results ?? []).map((row) => row.address),
    (users.results ?? []).map((row) => ({ wallet: row.wallet, squadCode: row.squad_code })),
  );
}
