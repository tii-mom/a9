/**
 * 命令处理：/start /team /gate /rank /me。
 * 回复统一经 telegram.sendMessage；这里只负责业务判断与文案选择。
 */
import type { ParsedCommand } from './commands';
import { appLink, sanitizeStartPayload, squadInviteLink } from './commands';
import * as db from './db';
import { formatGateLine, formatGateStatus, formatMe, formatRank } from './format';
import { openAppKeyboard, sendMessage } from './telegram';
import { competitionRank, newSquadCode } from './squad';
import type { BotEnv, GateSource, GateStatus, TgMessage } from './types';

export interface BotDeps {
  /** 城门数据源；未注入时 /gate 与 /start 状态行给出「暂不可用」 */
  gateSource?: GateSource;
  /** 当前毫秒时间戳（测试注入用） */
  now?: () => number;
}

const SQUAD_NAME_MAX = 32;
const OPEN_APP_LABEL = '打开小程序';

async function reply(env: BotEnv, chatId: number | string, text: string, replyMarkup?: unknown): Promise<void> {
  await sendMessage(env, { chatId, text, replyMarkup });
}

function isPrivate(msg: TgMessage): boolean {
  return msg.chat.type === 'private';
}

function truncateName(title: string | undefined): string {
  const cleaned = (title ?? '').trim() || '未命名战队';
  return Array.from(cleaned).slice(0, SQUAD_NAME_MAX).join('');
}

async function loadGate(env: BotEnv, deps: BotDeps): Promise<GateStatus | null> {
  if (!deps.gateSource) return null;
  try {
    return await deps.gateSource(env);
  } catch (err) {
    console.warn('[bot] gateSource 失败', err);
    return null;
  }
}

function nowSec(deps: BotDeps): number {
  return Math.floor((deps.now ? deps.now() : Date.now()) / 1000);
}

/** 需要绑定钱包时的统一提示（带打开小程序按钮）。 */
async function replyNeedBind(env: BotEnv, chatId: number | string, hint: string): Promise<void> {
  const markup = env.TG_BOT_USERNAME ? openAppKeyboard(OPEN_APP_LABEL, appLink(env.TG_BOT_USERNAME)) : undefined;
  await reply(env, chatId, hint, markup);
}

export async function handleStart(env: BotEnv, msg: TgMessage, cmd: ParsedCommand, deps: BotDeps): Promise<void> {
  // 群里的 /start 没有意义，直接忽略
  if (!isPrivate(msg)) return;
  const payload = sanitizeStartPayload(cmd.args);
  const gate = await loadGate(env, deps);
  const statusLine = gate ? formatGateLine(gate) : '城门数据暂不可用，稍后再试。';
  const intro = '欢迎来到 A9「散户做庄」：1 GRAM 上车，大家一起把价格推过城门。';
  const markup = env.TG_BOT_USERNAME
    ? openAppKeyboard(OPEN_APP_LABEL, appLink(env.TG_BOT_USERNAME, payload))
    : undefined;
  await reply(env, msg.chat.id, `${intro}\n${statusLine}`, markup);
}

export async function handleTeam(env: BotEnv, msg: TgMessage): Promise<void> {
  if (isPrivate(msg)) {
    await reply(env, msg.chat.id, '战队在群里创建：把我拉进群后，群主发送 /team。');
    return;
  }
  if (!msg.from) return;
  const link = await db.findUserByTgId(env.DB, String(msg.from.id));
  if (!link) {
    await replyNeedBind(env, msg.chat.id, '请先打开小程序绑定钱包，再回到群里发送 /team。');
    return;
  }

  const chatId = String(msg.chat.id);
  const existing = await db.findSquadByChat(env.DB, chatId);
  if (existing) {
    const username = env.TG_BOT_USERNAME ?? '';
    const members = (await db.listSquadsWithMembers(env.DB)).find((s) => s.code === existing.code)?.members ?? 0;
    await reply(
      env,
      msg.chat.id,
      `本群战队「${existing.name}」已存在，成员 ${members} 人。\n邀请链接：${squadInviteLink(username, existing.code)}`,
    );
    return;
  }

  if (link.squadCode) {
    const mine = await db.findSquadByCode(env.DB, link.squadCode);
    const hint = mine ? `你已在战队「${mine.name}」，一人只能属于一个战队。` : '你已在一个战队中，一人只能属于一个战队。';
    await reply(env, msg.chat.id, hint);
    return;
  }

  // 战队码冲突极少，最多重试 5 次
  let code = newSquadCode();
  for (let i = 0; i < 5 && (await db.squadCodeExists(env.DB, code)); i++) code = newSquadCode();

  const name = truncateName(msg.chat.title);
  try {
    await db.insertSquad(env.DB, { code, name, leaderWallet: link.wallet, tgChatId: chatId });
  } catch (err) {
    console.warn('[bot] 创建战队失败', err);
    await reply(env, msg.chat.id, '创建战队失败，请稍后再试。');
    return;
  }
  await db.setUserSquad(env.DB, link.wallet, code);

  const invite = squadInviteLink(env.TG_BOT_USERNAME ?? '', code);
  await reply(
    env,
    msg.chat.id,
    `战队「${name}」已创建，你是团长。\n把邀请链接发给队友，打开即可加入：\n${invite}`,
    env.TG_BOT_USERNAME ? openAppKeyboard('加入战队', invite) : undefined,
  );
}

export async function handleGate(env: BotEnv, msg: TgMessage, deps: BotDeps): Promise<void> {
  const gate = await loadGate(env, deps);
  if (!gate) {
    await reply(env, msg.chat.id, '城门数据暂不可用，稍后再试。');
    return;
  }
  await reply(env, msg.chat.id, formatGateStatus(gate, nowSec(deps)));
}

export async function handleRank(env: BotEnv, msg: TgMessage): Promise<void> {
  if (isPrivate(msg)) {
    await reply(env, msg.chat.id, '请在战队群里发送 /rank。');
    return;
  }
  const squad = await db.findSquadByChat(env.DB, String(msg.chat.id));
  if (!squad) {
    await reply(env, msg.chat.id, '本群还不是战队。群主把我拉进群后发送 /team 即可创建。');
    return;
  }
  const all = await db.listSquadsWithMembers(env.DB);
  const stakers = await db.stakersThisRoundByCode(env.DB);
  const mine = all.find((s) => s.code === squad.code);
  const members = mine?.members ?? 0;
  const myStakers = stakers.get(squad.code) ?? 0;
  const rank = competitionRank(myStakers, all.map((s) => stakers.get(s.code) ?? 0));
  await reply(env, msg.chat.id, formatRank(squad.name, rank, all.length, members, myStakers));
}

export async function handleMe(env: BotEnv, msg: TgMessage): Promise<void> {
  if (!isPrivate(msg)) {
    await reply(env, msg.chat.id, '请私聊我发送 /me 查看你的战队。');
    return;
  }
  if (!msg.from) return;
  const link = await db.findUserByTgId(env.DB, String(msg.from.id));
  if (!link) {
    await replyNeedBind(env, msg.chat.id, '请先打开小程序绑定钱包。');
    return;
  }
  const squad = link.squadCode ? await db.findSquadByCode(env.DB, link.squadCode) : null;
  if (!squad) {
    await replyNeedBind(env, msg.chat.id, '你还没有战队。打开小程序加入，或在群里发送 /team 创建。');
    return;
  }
  const all = await db.listSquadsWithMembers(env.DB);
  const stakers = await db.stakersThisRoundByCode(env.DB);
  const mine = all.find((s) => s.code === squad.code);
  const members = mine?.members ?? 0;
  const myStakers = stakers.get(squad.code) ?? 0;
  const rank = competitionRank(myStakers, all.map((s) => stakers.get(s.code) ?? 0));
  await reply(
    env,
    msg.chat.id,
    formatMe(squad.name, rank, all.length, members, myStakers, squadInviteLink(env.TG_BOT_USERNAME ?? '', squad.code)),
  );
}

/** 分发命令。未知命令忽略。 */
export async function handleCommand(env: BotEnv, msg: TgMessage, cmd: ParsedCommand, deps: BotDeps): Promise<void> {
  switch (cmd.name) {
    case 'start':
      return handleStart(env, msg, cmd, deps);
    case 'team':
      return handleTeam(env, msg);
    case 'gate':
      return handleGate(env, msg, deps);
    case 'rank':
      return handleRank(env, msg);
    case 'me':
      return handleMe(env, msg);
    default:
      return;
  }
}
