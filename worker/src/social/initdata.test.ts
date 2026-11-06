/**
 * Telegram initData 校验单测。
 *
 * 运行（仓库 worker 目录）：npm run test:social
 * 已知答案向量由 node:crypto 的独立实现（createHmac）在测试内计算，不复用被测代码。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { INIT_DATA_MAX_AGE_SECONDS, buildDataCheckString, verifyTgInitData } from './initdata';

const BOT_TOKEN = '123456:TEST_TOKEN_for_unit_tests';
const NOW = 1_800_000_000;

/** 参考实现：按 Telegram 文档直接用 node:crypto 计算 hash。 */
function referenceHash(fields: Record<string, string>, botToken: string): string {
  const dataCheckString = Object.keys(fields)
    .filter((key) => key !== 'hash')
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  return createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
}

/** 组装并签名一个 initData 查询串（值经 URLSearchParams 编码，与 Telegram 客户端一致）。 */
function signedInitData(fields: Record<string, string>, botToken = BOT_TOKEN): string {
  const hash = referenceHash(fields, botToken);
  const params = new URLSearchParams({ ...fields, hash });
  return params.toString();
}

function userJson(id: number): string {
  return JSON.stringify({ id, first_name: 'Ada', username: 'ada_fuse', language_code: 'zh' });
}

function baseFields(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    auth_date: String(NOW - 600),
    query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
    user: userJson(987654321),
    ...overrides,
  };
}

test('已知答案：合法 initData 通过，返回 user.id', async () => {
  const initData = signedInitData(baseFields());
  const result = await verifyTgInitData(initData, BOT_TOKEN, NOW);
  assert.deepEqual(result, { ok: true, tgUserId: '987654321', authDate: NOW - 600 });
});

test('data_check_string 按 key 升序、排除 hash、值为解码后的原文', () => {
  const params = new URLSearchParams('user=%7B%22id%22%3A1%7D&auth_date=5&hash=abc&query_id=q');
  assert.equal(buildDataCheckString(params), 'auth_date=5\nquery_id=q\nuser={"id":1}');
});

test('篡改 user 字段（冒充他人 id）→ bad-signature', async () => {
  const fields = baseFields();
  const signed = signedInitData(fields);
  const forged = new URLSearchParams(signed);
  forged.set('user', userJson(111111111));
  const result = await verifyTgInitData(forged.toString(), BOT_TOKEN, NOW);
  assert.deepEqual(result, { ok: false, reason: 'bad-signature' });
});

test('用错误的 bot token 签名 → bad-signature', async () => {
  const initData = signedInitData(baseFields(), 'another:token');
  const result = await verifyTgInitData(initData, BOT_TOKEN, NOW);
  assert.deepEqual(result, { ok: false, reason: 'bad-signature' });
});

test('服务端未配置 bot token → no-bot-token', async () => {
  const initData = signedInitData(baseFields());
  assert.deepEqual(await verifyTgInitData(initData, '', NOW), { ok: false, reason: 'no-bot-token' });
});

test('auth_date 超过 24 小时 → expired；恰好 24 小时仍有效', async () => {
  const stale = signedInitData(baseFields({ auth_date: String(NOW - INIT_DATA_MAX_AGE_SECONDS - 1) }));
  assert.deepEqual(await verifyTgInitData(stale, BOT_TOKEN, NOW), { ok: false, reason: 'expired' });

  const edge = signedInitData(baseFields({ auth_date: String(NOW - INIT_DATA_MAX_AGE_SECONDS) }));
  const result = await verifyTgInitData(edge, BOT_TOKEN, NOW);
  assert.equal(result.ok, true);
});

test('auth_date 远在未来 → future', async () => {
  const initData = signedInitData(baseFields({ auth_date: String(NOW + 3600) }));
  assert.deepEqual(await verifyTgInitData(initData, BOT_TOKEN, NOW), { ok: false, reason: 'future' });
});

test('缺少 hash / hash 格式非法 → bad-hash', async () => {
  const unsigned = new URLSearchParams(baseFields()).toString();
  assert.deepEqual(await verifyTgInitData(unsigned, BOT_TOKEN, NOW), { ok: false, reason: 'bad-hash' });

  const shortHash = new URLSearchParams({ ...baseFields(), hash: 'abcd' }).toString();
  assert.deepEqual(await verifyTgInitData(shortHash, BOT_TOKEN, NOW), { ok: false, reason: 'bad-hash' });
});

test('重复 key → duplicate-key（不走签名比对）', async () => {
  const initData = signedInitData(baseFields()) + '&user=%7B%22id%22%3A1%7D';
  assert.deepEqual(await verifyTgInitData(initData, BOT_TOKEN, NOW), { ok: false, reason: 'duplicate-key' });
});

test('签名正确但 user 缺失或 id 非正整数 → no-user', async () => {
  const noUser = signedInitData({ auth_date: String(NOW - 60), query_id: 'q' });
  assert.deepEqual(await verifyTgInitData(noUser, BOT_TOKEN, NOW), { ok: false, reason: 'no-user' });

  const zeroId = signedInitData(baseFields({ user: userJson(0) }));
  assert.deepEqual(await verifyTgInitData(zeroId, BOT_TOKEN, NOW), { ok: false, reason: 'no-user' });

  const stringId = signedInitData(baseFields({ user: JSON.stringify({ id: '42' }) }));
  assert.deepEqual(await verifyTgInitData(stringId, BOT_TOKEN, NOW), { ok: false, reason: 'no-user' });
});

test('auth_date 非数字 → bad-auth-date（签名无误时）', async () => {
  const initData = signedInitData(baseFields({ auth_date: 'yesterday' }));
  assert.deepEqual(await verifyTgInitData(initData, BOT_TOKEN, NOW), { ok: false, reason: 'bad-auth-date' });
});
