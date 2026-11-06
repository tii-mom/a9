/**
 * Telegram 机器人入口（A9 Worker 内的模块，不单独部署）。
 *
 * - handleTelegramWebhook：Webhook 入口，校验密钥后分发命令；始终返回 2xx（失败只打日志，避免 Telegram 重投）。
 * - pushCandleUpdate：每根 K 线结算后调用，群发到所有战队群。
 * - pushSquadDigest：攻城期每 6h 调用一次，给每个战队发排名与「还差几人升级」。
 */
import { parseCommand, verifyWebhookSecret } from './commands';
import { handleCommand, type BotDeps } from './handlers';
import * as db from './db';
import { formatCandleMessage, formatDigest } from './format';
import { broadcast } from './telegram';
import { competitionRank } from './squad';
import type { BotEnv, CandleEvent, GateStatus, TgUpdate } from './types';

export type { BotDeps } from './handlers';
export type { BotEnv, CandleEvent, GateSource, GateStatus } from './types';

/**
 * Webhook 入口。调用方（index.ts 路由）负责把 POST /api/tg/webhook 指到这里。
 * deps.gateSource 未注入时，/gate 与 /start 的城门信息显示「暂不可用」。
 */
export async function handleTelegramWebhook(request: Request, env: BotEnv, deps: BotDeps = {}): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  if (!verifyWebhookSecret(request.headers.get('X-Telegram-Bot-Api-Secret-Token'), env.TG_WEBHOOK_SECRET)) {
    return new Response('Unauthorized', { status: 401 });
  }

  let update: TgUpdate;
  try {
    update = (await request.json()) as TgUpdate;
  } catch {
    return new Response('Bad Request', { status: 400 });
  }

  const msg = update.message;
  if (msg?.text) {
    const cmd = parseCommand(msg.text, env.TG_BOT_USERNAME);
    if (cmd) {
      try {
        await handleCommand(env, msg, cmd, deps);
      } catch (err) {
        console.error(`[bot] 命令 ${cmd.name} 处理失败`, err);
      }
    }
  }
  return Response.json({ ok: true });
}

/** 单根 K 线结算后群发到所有战队群。返回成功发送的群数。 */
export async function pushCandleUpdate(env: BotEnv, ev: CandleEvent): Promise<number> {
  const text = formatCandleMessage(ev);
  const chatIds = await db.listSquadChatIds(env.DB);
  return broadcast(env, chatIds.map((chatId) => ({ chatId, text })));
}

/**
 * 攻城期战队摘要（每 6h）。只在 STAKING_OPEN 阶段发送，其他阶段直接返回 0。
 * 排名按成员数（竞争排名，同分同名次）。
 */
export async function pushSquadDigest(env: BotEnv, gate: GateStatus): Promise<number> {
  if (gate.phase !== 'STAKING_OPEN') return 0;
  const squads = await db.listSquadsWithMembers(env.DB);
  const counts = squads.map((s) => s.members);
  const messages = squads.map((s) => ({
    chatId: s.tgChatId,
    text: formatDigest(gate, s.name, competitionRank(s.members, counts), squads.length, s.members),
  }));
  return broadcast(env, messages);
}
