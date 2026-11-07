import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleTelegramWebhook } from './index';
import type { BotEnv, GateStatus } from './types';

const SECRET = 'hook-secret';

// 不应被触碰的 D1：一旦被调用就抛错，用来证明鉴权失败时没有读库
const untouchedDb = new Proxy({}, { get: () => () => { throw new Error('DB must not be used'); } }) as unknown as D1Database;

function env(extra: Partial<BotEnv> = {}): BotEnv {
  return { DB: untouchedDb, TG_BOT_TOKEN: 'tok', TG_WEBHOOK_SECRET: SECRET, TG_BOT_USERNAME: 'A9Bot', ...extra };
}

function update(text: string, chatType = 'private'): unknown {
  return {
    update_id: 1,
    message: { message_id: 1, from: { id: 42 }, chat: { id: 42, type: chatType, title: '风暴群' }, text },
  };
}

function post(body: unknown, secret: string | null): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secret !== null) headers['X-Telegram-Bot-Api-Secret-Token'] = secret;
  return new Request('https://a9.lat/api/tg/webhook', { method: 'POST', headers, body: JSON.stringify(body) });
}

async function withFetchStub<T>(run: (calls: Array<{ url: string; body: Record<string, unknown> }>) => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

test('Webhook: 密钥不对返回 401，且不读库不发消息', async () => {
  const res = await handleTelegramWebhook(post(update('/gate'), 'wrong'), env());
  assert.equal(res.status, 401);
});

test('Webhook: 未配置密钥时一律 401（fail closed）', async () => {
  const res = await handleTelegramWebhook(post(update('/gate'), SECRET), env({ TG_WEBHOOK_SECRET: undefined }));
  assert.equal(res.status, 401);
});

test('Webhook: 非 POST 返回 405', async () => {
  const res = await handleTelegramWebhook(new Request('https://a9.lat/api/tg/webhook', { method: 'GET' }), env());
  assert.equal(res.status, 405);
});

test('Webhook: 非法 JSON 返回 400', async () => {
  const req = new Request('https://a9.lat/api/tg/webhook', {
    method: 'POST',
    headers: { 'X-Telegram-Bot-Api-Secret-Token': SECRET },
    body: '{not json',
  });
  const res = await handleTelegramWebhook(req, env());
  assert.equal(res.status, 400);
});

test('Webhook: /start 私聊回复带 startapp 按钮与城门状态行', async () => {
  const gate: GateStatus = {
    roundId: 2,
    phase: 'STAKING_OPEN',
    gatePriceUsd: 0.5,
    priceUsd: 0.4,
    remainingUsd: 20,
    litCandles: 0,
    candlesSeen: 0,
    rewardBudgetRaw: '0',
    stakeCount: 3,
  };
  await withFetchStub(async (calls) => {
    const res = await handleTelegramWebhook(post(update('/start s_K7P2QX'), SECRET), env(), {
      gateSource: async () => gate,
    });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/bottok\/sendMessage$/);
    assert.equal(calls[0].body.chat_id, 42);
    assert.match(String(calls[0].body.text), /第 2 城 · 攻城 ｜ 城门 \$0\.50 ｜ 现价 \$0\.40/);
    const markup = calls[0].body.reply_markup as { inline_keyboard: Array<Array<{ url: string }>> };
    assert.equal(markup.inline_keyboard[0][0].url, 'https://t.me/A9Bot/app?startapp=s_K7P2QX');
  });
});

test('Webhook: /gate 未注入数据源时给出暂不可用', async () => {
  await withFetchStub(async (calls) => {
    await handleTelegramWebhook(post(update('/gate'), SECRET), env());
    assert.equal(calls[0].body.text, '城门数据暂不可用，稍后再试。');
  });
});
