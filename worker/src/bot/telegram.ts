/**
 * Telegram Bot API 薄封装。
 * 失败只记日志、不抛出：机器人被踢、群被封等单个会话的错误不能影响其他群。
 */
import type { BotEnv } from './types';

const API_BASE = 'https://api.telegram.org';

/** 群发间隔：约 25 条/秒，留余量取 40ms */
export const BROADCAST_INTERVAL_MS = 40;

export interface OutgoingMessage {
  chatId: string | number;
  text: string;
  replyMarkup?: unknown;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 发送一条消息。429 时按 retry_after 等待后重试一次。返回是否成功。 */
export async function sendMessage(env: BotEnv, msg: OutgoingMessage): Promise<boolean> {
  const token = env.TG_BOT_TOKEN;
  if (!token) {
    console.warn('[bot] TG_BOT_TOKEN 未配置，跳过发送');
    return false;
  }
  const body: Record<string, unknown> = {
    chat_id: msg.chatId,
    text: msg.text,
    disable_web_page_preview: true,
  };
  if (msg.replyMarkup) body.reply_markup = msg.replyMarkup;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // 注意：URL 含 token，不能打印
      const res = await fetch(`${API_BASE}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) return true;
      const data = (await res.json().catch(() => null)) as
        | { description?: string; parameters?: { retry_after?: number } }
        | null;
      if (res.status === 429 && attempt === 0) {
        await sleep((data?.parameters?.retry_after ?? 1) * 1000);
        continue;
      }
      console.warn(`[bot] sendMessage chat=${msg.chatId} 失败 status=${res.status} ${data?.description ?? ''}`);
      return false;
    } catch (err) {
      console.warn(`[bot] sendMessage chat=${msg.chatId} 异常`, err);
      return false;
    }
  }
  return false;
}

/** 顺序群发，每条之间间隔 BROADCAST_INTERVAL_MS。返回成功条数。 */
export async function broadcast(env: BotEnv, messages: OutgoingMessage[]): Promise<number> {
  let sent = 0;
  for (let i = 0; i < messages.length; i++) {
    if (i > 0) await sleep(BROADCAST_INTERVAL_MS);
    if (await sendMessage(env, messages[i])) sent++;
  }
  return sent;
}

/** 单按钮（打开 Mini App）键盘。 */
export function openAppKeyboard(label: string, url: string): unknown {
  return { inline_keyboard: [[{ text: label, url }]] };
}
