#!/usr/bin/env node
/**
 * qa/chain-logic.mjs — 链上负向用例（纯逻辑，无需浏览器 / 真实钱包 / 链上账户）
 *
 * 覆盖发布门禁要求但浏览器 E2E 无法稳定复现的四类用例中的两类 + 兜底：
 *   1) 用户拒绝签名（TON Connect code 300 / 文案）→ WALLET_REJECTED，不可重试，绝不能当成功；
 *   2) 失败回执（aborted / bounced / 非 0 exit_code）→ stage=failed，绝不显示成功（FIX-5 回归）；
 *   3) 链源不可用（fetch 抛错）→ 回执轮询返回 null，不得误判为已确认；
 *   4) 重复提交：queryId 由时间生成并单调递增（v11 无 depositNonce）。
 *
 * 用法：node qa/chain-logic.mjs      （在仓库根执行；需要 web 依赖已安装，使用 vite 的 SSR 加载器转译 TS）
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const results = [];
const ok = (name, detail = '') => { results.push(['PASS', name, detail]); console.log('✅', name, detail); };
const bad = (name, detail = '') => { results.push(['FAIL', name, detail]); console.log('❌', name, detail); };
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const step = async (name, fn) => {
  try { const detail = await fn(); ok(name, detail ? String(detail).slice(0, 160) : ''); }
  catch (error) { bad(name, String(error && error.message ? error.message : error).slice(0, 300)); }
};

let vite;
try {
  const requireFromWeb = createRequire(join(ROOT, 'web', 'package.json'));
  vite = requireFromWeb('vite');
} catch (error) {
  console.error('缺少 web 依赖（vite）：请在仓库根执行 pnpm install 后再跑本用例。');
  process.exit(2);
}

const server = await vite.createServer({ root: join(ROOT, 'web'), server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
let errorsModule;
let rpcModule;
let configModule;
let protocolModule;
try {
  errorsModule = await server.ssrLoadModule('/src/features/chain/errors.ts');
  rpcModule = await server.ssrLoadModule('/src/features/chain/rpc.ts');
  configModule = await server.ssrLoadModule('/src/features/chain/config.ts');
  protocolModule = await server.ssrLoadModule('/src/features/chain/protocol.ts');
} catch (error) {
  console.error('加载 chain 模块失败：' + String(error && error.message ? error.message : error));
  await server.close();
  process.exit(2);
}

const NOW = Math.floor(Date.now() / 1000);
const RC_RAW = '0:' + 'aa'.repeat(32);
const USER_RAW = '0:' + 'bb'.repeat(32);
const chain = { ...configModule.deriveChainConfig(null), network: 'testnet', toncenterBaseUrl: 'https://mock.toncenter.local', explorerBaseUrl: 'https://mock.explorer.local', toncenterApiKey: null };

function makeTx({ aborted = false, bounced = false, exitCode = 0, utime = NOW, source = USER_RAW, destination = RC_RAW } = {}) {
  return {
    transaction_id: { hash: 'h'.repeat(44), lt: String(Math.floor(Math.random() * 1e6)) },
    utime,
    in_msg: { source, destination, value: '1000000', bounced, msg_data: { body: '' } },
    description: { aborted, compute_ph: { success: !aborted && exitCode === 0, exit_code: exitCode } },
  };
}

function mockFetchResult(list) {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: list }) });
}
function mockFetchThrow(message = 'Failed to fetch') {
  globalThis.fetch = async () => { throw new Error(message); };
}

const realFetch = globalThis.fetch;
const matchTarget = (tx) => tx.inDestination === RC_RAW;
const wait = (extra = {}) => rpcModule.waitForTransaction({
  chain,
  targetAddress: RC_RAW,
  walletAddress: USER_RAW,
  sinceSec: NOW - 5,
  match: matchTarget,
  timeoutMs: 1200,
  intervalMs: 60,
  ...extra,
});

// 1) 用户拒绝签名
await step('wallet.rejected.code300', () => {
  assert(errorsModule.isUserRejection({ code: 300 }) === true, 'code 300 未被识别为拒绝');
  assert(errorsModule.isUserRejection(new Error('User rejected the request')) === true, '文案拒绝未被识别');
  const mapped = errorsModule.toChainError({ code: 300, message: 'User rejected the request' });
  assert(mapped.code === 'WALLET_REJECTED', '应映射为 WALLET_REJECTED，实际 ' + mapped.code);
  assert(mapped.retriable === false, '用户拒绝不应可重试');
  return 'code=300 → WALLET_REJECTED（retriable=false）';
});
await step('wallet.rejected.notFalsePositive', () => {
  assert(errorsModule.isUserRejection(new Error('Network request failed')) === false, '网络错误被误判为用户拒绝');
  const mapped = errorsModule.toChainError(new Error('Failed to fetch'));
  assert(mapped.code === 'NETWORK_ERROR', '网络错误应映射 NETWORK_ERROR，实际 ' + mapped.code);
  return '网络错误不被当成拒绝';
});

// 2) 失败回执：aborted / bounced / 非 0 exit_code 一律 failed，绝不 contract
await step('receipt.aborted', async () => {
  mockFetchResult([makeTx({ aborted: true, exitCode: 0 })]);
  const settle = await wait();
  assert(settle.stage === 'failed', 'aborted 回执应 stage=failed，实际 ' + settle.stage);
  assert(settle.tx && settle.tx.aborted === true, '应带回 aborted tx');
  return 'aborted → stage=failed（绝不显示成功）';
});
await step('receipt.bounced', async () => {
  mockFetchResult([makeTx({ bounced: true })]);
  const settle = await wait();
  assert(settle.stage === 'failed', 'bounced 回执应 stage=failed，实际 ' + settle.stage);
  return 'bounced → stage=failed';
});
await step('receipt.badExitCode', async () => {
  mockFetchResult([makeTx({ exitCode: 230 })]);
  const settle = await wait();
  assert(settle.stage === 'failed', '非 0 exit_code 应 stage=failed，实际 ' + settle.stage);
  assert(settle.tx && settle.tx.exitCode === 230, '应带回 exit_code');
  return 'exit_code=230 → stage=failed（exitCode 可读）';
});
await step('receipt.success', async () => {
  mockFetchResult([makeTx({ exitCode: 0 })]);
  const settle = await wait();
  assert(settle.stage === 'contract', '成功回执应 stage=contract，实际 ' + settle.stage);
  return 'aborted=false/exit_code=0 → stage=contract';
});

// 3) 链源不可用：轮询失败不得误判成功
await step('rpc.unavailable.notConfirmed', async () => {
  mockFetchThrow('Failed to fetch');
  const settle = await wait({ timeoutMs: 400, intervalMs: 50 });
  assert(settle.stage === null, '链源不可用时应返回 stage=null，实际 ' + settle.stage);
  return 'fetch 抛错 → stage=null（不误判成功）';
});

// 4) 重复提交（v11）：StakePayload v2 不再携带 depositNonce；交易 queryId 随毫秒时间单调递增。
//    （防重不靠合约 nonce：重复点击由 UI busy 锁与回执 queryId 匹配保证。）
await step('submit.queryId.monotonic', () => {
  const base = 1793843480000;
  let prev = -1n;
  for (let i = 0; i < 200; i += 1) {
    const now = base + i; // 逐毫秒提交（真实钱包连续点击/重试的形态）
    const queryId = protocolModule.nextQueryId(now);
    assert(queryId > prev, '时间递增时 queryId 必须单调递增');
    prev = queryId;
  }
  // 时间位必须来自毫秒时间戳：queryId = now * 1024 + random(0..1023)
  assert(protocolModule.nextQueryId(base) / 1024n >= BigInt(base), 'queryId 未嵌入毫秒时间位');
  return '200 次逐毫秒提交：queryId 单调递增（v11 无 depositNonce）';
});

globalThis.fetch = realFetch;
await server.close();

console.log('\n=== chain-logic summary ===');
const fails = results.filter((item) => item[0] === 'FAIL');
console.log('PASS ' + (results.length - fails.length) + ' / FAIL ' + fails.length);
process.exit(fails.length ? 1 : 0);
