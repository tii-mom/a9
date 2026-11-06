/**
 * 登录会话单测：会话 token 签发/校验（篡改、过期、地址不一致、缺密钥）+ 通配 nonce 消费。
 *
 * 运行（仓库 worker 目录）：npm run test:auth
 * HMAC 已知答案由 node:crypto 的 createHmac 独立计算，不复用被测代码。
 * nonce 消费使用 node:sqlite 内存库执行真实 SQL（建表语句取自 migration 0007）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Env } from './env';
import * as store from './store';
import { issueAuthChallenge, normalizeTonAddress, signSessionToken, SESSION_TTL_SECONDS, verifySessionToken } from './tonproof';

const SECRET = 'unit-test-session-secret-0123456789';
const NOW = 1_800_000_000_000;

function envWith(secret: string | undefined): Env {
  return { SESSION_SECRET: secret } as unknown as Env;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function jsonToBase64Url(value: object): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

/** 36 字节 raw 地址（wc + 32B hash + 2B 占位）的用户友好形式；解析器不校验 CRC，足够用于单测。 */
function friendlyAddress(hashByte: number, workchain = 0): string {
  const raw = new Uint8Array(36);
  raw[0] = 0x11;
  raw[1] = workchain & 0xff;
  raw.fill(hashByte, 2, 34);
  return bytesToBase64Url(raw);
}

function rawHex(hashByte: number, workchain = 0): string {
  return `${workchain}:${hashByte.toString(16).padStart(2, '0').repeat(32)}`;
}

function splitToken(token: string): { payloadPart: string; macPart: string } {
  const [payloadPart, macPart] = token.split('.');
  return { payloadPart, macPart };
}

function reference(payload: object, secret: string): string {
  const payloadPart = jsonToBase64Url(payload);
  const mac = bytesToBase64Url(createHmac('sha256', secret).update(payloadPart).digest());
  return `${payloadPart}.${mac}`;
}

/* ----------------------------- 会话 token ----------------------------- */

test('signed token verifies for its own address only', async () => {
  const env = envWith(SECRET);
  const address = friendlyAddress(0x22);
  const { token } = await signSessionToken(env, address, NOW);
  assert.equal(await verifySessionToken(env, token, address, NOW), true);
  assert.equal(await verifySessionToken(env, token, friendlyAddress(0x33), NOW), false, 'address mismatch');
  assert.equal(await verifySessionToken(env, token, friendlyAddress(0x22, -1), NOW), false, 'workchain mismatch');
});

test('token layout matches an independent HMAC-SHA256 reference', async () => {
  const env = envWith(SECRET);
  const address = friendlyAddress(0x22);
  const { token, expiresAt } = await signSessionToken(env, address, NOW);
  const exp = Math.floor(NOW / 1000) + SESSION_TTL_SECONDS;
  assert.equal(expiresAt, exp * 1000);
  assert.equal(token, reference({ a: rawHex(0x22), e: exp, v: 1 }, SECRET));
});

test('token lifetime is 7 days', async () => {
  const { expiresAt } = await signSessionToken(envWith(SECRET), friendlyAddress(0x22), NOW);
  assert.equal(expiresAt - NOW, 7 * 24 * 60 * 60 * 1000);
});

test('token expires at e (unix seconds)', async () => {
  const env = envWith(SECRET);
  const address = friendlyAddress(0x22);
  const { token, expiresAt } = await signSessionToken(env, address, NOW);
  assert.equal(await verifySessionToken(env, token, address, expiresAt - 1000), true, 'one second before expiry');
  assert.equal(await verifySessionToken(env, token, address, expiresAt), false, 'at expiry');
  assert.equal(await verifySessionToken(env, token, address, expiresAt + 60_000), false, 'after expiry');
});

test('tampered payload or signature is rejected', async () => {
  const env = envWith(SECRET);
  const address = friendlyAddress(0x22);
  const { token } = await signSessionToken(env, address, NOW);
  const { payloadPart, macPart } = splitToken(token);

  const exp = Math.floor(NOW / 1000) + SESSION_TTL_SECONDS;
  const forgedPayload = jsonToBase64Url({ a: rawHex(0x33), e: exp, v: 1 });
  assert.equal(await verifySessionToken(env, `${forgedPayload}.${macPart}`, friendlyAddress(0x33), NOW), false, 'payload swapped');

  const longerExp = jsonToBase64Url({ a: rawHex(0x22), e: exp + 86400, v: 1 });
  assert.equal(await verifySessionToken(env, `${longerExp}.${macPart}`, address, NOW), false, 'expiry extended');

  const flipped = (macPart[0] === 'A' ? 'B' : 'A') + macPart.slice(1);
  assert.equal(await verifySessionToken(env, `${payloadPart}.${flipped}`, address, NOW), false, 'signature byte flipped');
});

test('token signed with another secret is rejected', async () => {
  const address = friendlyAddress(0x22);
  const { token } = await signSessionToken(envWith('another-secret-value-xxxxxxxxxxxx'), address, NOW);
  assert.equal(await verifySessionToken(envWith(SECRET), token, address, NOW), false);
});

test('token with unsupported version is rejected even with a valid signature', async () => {
  const address = friendlyAddress(0x22);
  const exp = Math.floor(NOW / 1000) + SESSION_TTL_SECONDS;
  const v2 = reference({ a: rawHex(0x22), e: exp, v: 2 }, SECRET);
  const v1 = reference({ a: rawHex(0x22), e: exp, v: 1 }, SECRET);
  assert.equal(await verifySessionToken(envWith(SECRET), v2, address, NOW), false);
  assert.equal(await verifySessionToken(envWith(SECRET), v1, address, NOW), true, 'control: v1 is accepted');
});

test('missing or blank SESSION_SECRET: signing fails with 500, verification returns false', async () => {
  const address = friendlyAddress(0x22);
  const { token } = await signSessionToken(envWith(SECRET), address, NOW);
  for (const secret of [undefined, '', '   ']) {
    let failure: unknown = null;
    try {
      await signSessionToken(envWith(secret), address, NOW);
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof Error, `signing without secret must throw (${JSON.stringify(secret)})`);
    assert.equal((failure as { code?: string }).code, 'INTERNAL');
    assert.equal((failure as { status?: number }).status, 500);
    assert.equal(await verifySessionToken(envWith(secret), token, address, NOW), false);
  }
});

test('malformed tokens are rejected without throwing', async () => {
  const env = envWith(SECRET);
  const address = friendlyAddress(0x22);
  for (const token of ['', '.', 'abc', 'a.b.c', 'a.', '.b', '!!!.???', 'null.null']) {
    assert.equal(await verifySessionToken(env, token, address, NOW), false, `token ${JSON.stringify(token)}`);
  }
});

test('normalizeTonAddress returns the raw wc:hex form', () => {
  assert.equal(normalizeTonAddress(friendlyAddress(0x22)), rawHex(0x22));
  assert.equal(normalizeTonAddress(friendlyAddress(0x44, -1)), rawHex(0x44, -1));
  assert.equal(normalizeTonAddress('not-an-address'), null);
});

/* ----------------------- 通配 nonce（/api/auth/challenge） ----------------------- */

/** auth_nonces 建表语句，与 migrations/0007_security.sql 保持一致。 */
const AUTH_NONCES_DDL = `
CREATE TABLE IF NOT EXISTS auth_nonces (
  nonce      TEXT PRIMARY KEY,
  address    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_auth_nonces_address ON auth_nonces(address);
CREATE INDEX IF NOT EXISTS idx_auth_nonces_expires ON auth_nonces(expires_at);
`;

/** 把 node:sqlite 包成 D1 形状的最小适配（只实现 store.ts 用到的 prepare/bind/run/first）。 */
function fakeD1(db: DatabaseSync): D1Database {
  const prepare = (sql: string) => {
    const stmt = db.prepare(sql);
    const bound = (values: unknown[]) => ({
      bind: (...more: unknown[]) => bound([...values, ...more]),
      run: async () => ({ meta: { changes: Number(stmt.run(...values).changes) } }),
      first: async () => stmt.get(...values) ?? null,
    });
    return bound([]);
  };
  return { prepare } as unknown as D1Database;
}

function freshEnv(): { env: Env; db: DatabaseSync } {
  const db = new DatabaseSync(':memory:');
  db.exec(AUTH_NONCES_DDL);
  return { env: { DB: fakeD1(db) } as unknown as Env, db };
}

test('wildcard nonce is consumable once, by any address', async () => {
  const { env } = freshEnv();
  await store.insertAuthNonce(env, {
    nonce: 'wild-1',
    address: store.AUTH_NONCE_ANY_ADDRESS,
    createdAt: NOW,
    expiresAt: NOW + 600_000,
  });
  assert.equal(await store.consumeAuthNonce(env, { nonce: 'wild-1', address: friendlyAddress(0x22), now: NOW }), true);
  assert.equal(await store.consumeAuthNonce(env, { nonce: 'wild-1', address: friendlyAddress(0x22), now: NOW }), false, 'replay');
  assert.equal(await store.consumeAuthNonce(env, { nonce: 'wild-1', address: friendlyAddress(0x33), now: NOW }), false, 'other address after use');
});

test('wildcard nonce expires after its TTL', async () => {
  const { env } = freshEnv();
  await store.insertAuthNonce(env, {
    nonce: 'wild-exp',
    address: store.AUTH_NONCE_ANY_ADDRESS,
    createdAt: NOW,
    expiresAt: NOW + 600_000,
  });
  assert.equal(
    await store.consumeAuthNonce(env, { nonce: 'wild-exp', address: friendlyAddress(0x22), now: NOW + 600_000 }),
    false,
  );
});

test('address-bound nonce is consumable only by its own address', async () => {
  const { env } = freshEnv();
  await store.insertAuthNonce(env, {
    nonce: 'bound-1',
    address: friendlyAddress(0x22),
    createdAt: NOW,
    expiresAt: NOW + 300_000,
  });
  assert.equal(await store.consumeAuthNonce(env, { nonce: 'bound-1', address: friendlyAddress(0x33), now: NOW }), false);
  assert.equal(await store.consumeAuthNonce(env, { nonce: 'bound-1', address: friendlyAddress(0x22), now: NOW }), true);
});

test('unknown nonce is never consumable', async () => {
  const { env } = freshEnv();
  assert.equal(await store.consumeAuthNonce(env, { nonce: 'nope', address: friendlyAddress(0x22), now: NOW }), false);
});

test('issued challenge is stored under the wildcard address and consumes for any wallet', async () => {
  const { env, db } = freshEnv();
  const { payload, expiresAt } = await issueAuthChallenge(env, NOW);
  assert.equal(expiresAt, NOW + 10 * 60 * 1000);
  assert.match(payload, /^a9-auth:[0-9a-f]{64}$/);
  const row = db.prepare('SELECT address FROM auth_nonces').get() as { address: string };
  assert.equal(row.address, store.AUTH_NONCE_ANY_ADDRESS);
  const nonce = payload.slice('a9-auth:'.length);
  assert.equal(await store.consumeAuthNonce(env, { nonce, address: friendlyAddress(0x44), now: NOW }), true);
  assert.equal(await store.consumeAuthNonce(env, { nonce, address: friendlyAddress(0x44), now: NOW }), false);
});
