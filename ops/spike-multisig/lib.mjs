/**
 * SPIKE ONLY — TON Multisig v2 部署/订单工具共用库（task-45）。
 * 纯新增文件；删除 ops/spike-multisig/ 与 ops/scripts/91_/92_ 即可完全回滚。
 * 依赖安装：cd ops/spike-multisig && pnpm install（独立 package.json，不改根 workspace 依赖）。
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const BAM_ROOT = join(HERE, '..', '..');
export const SPIKE_DIR = HERE;

function loadDeps() {
  try {
    const require = createRequire(join(SPIKE_DIR, 'package.json'));
    return {
      core: require('@ton/core'),
      crypto: require('@ton/crypto'),
      ton: require('@ton/ton'),
    };
  } catch (error) {
    throw new Error(
      '缺少 spike 依赖：请先执行  cd ops/spike-multisig && pnpm install\n' +
        '（失败原因：' + String(error && error.message ? error.message : error).slice(0, 200) + '）'
    );
  }
}

export const deps = loadDeps();
const { Address, beginCell, Cell, contractAddress, external, internal, storeMessage, storeMessageRelaxed, toNano, Dictionary } = deps.core;
export { Address, beginCell, Cell, contractAddress, external, internal, storeMessage, storeMessageRelaxed, toNano, Dictionary };

export const MULTISIG = {
  // 预编译产物（仓库 build/Multisig.compiled.json，master 分支 vendored 到 .cache）
  artifact: join(SPIKE_DIR, '.cache', 'multisig-src', 'build', 'Multisig.compiled.json'),
  source: 'ton-blockchain/multisig-contract-v2@master (build/Multisig.compiled.json)',
  // opcodes（wrappers/Constants.ts）
  op: {
    newOrder: 0xf718510f,
    execute: 0x75097f5d,
    executeInternal: 0xa32c59bf,
    orderApprove: 0xa762230f,
    orderInit: 0x9c73fba2,
    actionSendMessage: 0xf1381e5b,
    actionUpdateParams: 0x1d0cfbd3,
  },
  bits: { op: 32, queryId: 64, orderSeqno: 256, signerIndex: 8, actionIndex: 8, time: 48 },
  maxSeqno: (1n << 256n) - 1n,
};

export const TONCENTER = {
  v2: 'https://testnet.toncenter.com/api/v2',
  v3: 'https://testnet.toncenter.com/api/v3',
};

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* toncenter 无 API key 时约 1 RPS：所有请求串行化并保持最小间隔。 */
let lastRequestAt = 0;
export async function throttle(minIntervalMs = 1100) {
  const wait = lastRequestAt + minIntervalMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

export function isRateLimitError(error) {
  const text = String((error && (error.message || error.code)) || error);
  const status = error && (error.status || (error.response && error.response.status));
  return status === 429 || /429|ratelimit|rate limit/i.test(text);
}

/** 任意异步调用 + 429 退避重试（用于 TonClient 等内部自带请求的库调用）。 */
export async function withRetry(fn, { attempts = 8, baseDelay = 1500, minIntervalMs = 1100 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await throttle(minIntervalMs);
    try { return await fn(); } catch (error) {
      lastError = error;
      if (!isRateLimitError(error)) throw error;
      await sleep(baseDelay * (attempt + 1));
    }
  }
  throw lastError || new Error('多次重试后仍失败');
}

/** 带 429/5xx 退避重试的 JSON 请求（toncenter 无 API key 时限速 1 RPS）。 */
export async function httpJson(url, options = {}, { attempts = 8, baseDelay = 1200 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await throttle();
    try {
      const response = await fetch(url, {
        method: options.method || 'GET',
        headers: { 'content-type': 'application/json', ...(options.headers || {}) },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(20000),
      });
      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
      if (response.status === 429) {
        lastError = new Error('toncenter 429 限速');
        await sleep(baseDelay * (attempt + 1));
        continue;
      }
      if (!response.ok) {
        lastError = new Error('HTTP ' + response.status + ': ' + text.slice(0, 300));
        if (response.status < 500) throw lastError;
        await sleep(baseDelay * (attempt + 1));
        continue;
      }
      return json;
    } catch (error) {
      lastError = error;
      await sleep(baseDelay * (attempt + 1));
    }
  }
  throw lastError || new Error('请求失败：' + url);
}

/* ------------------------------------------------------------------ */
/* 钱包 / 助记词                                                        */
/* ------------------------------------------------------------------ */

/** 解析 contracts/global.wallets.toml 中 [wallets.<name>] 的 mnemonic（只读，不打印）。 */
export function loadWalletMnemonic(name) {
  const file = join(BAM_ROOT, 'contracts', 'global.wallets.toml');
  if (!existsSync(file)) throw new Error('找不到 ' + file);
  const text = readFileSync(file, 'utf8');
  const sectionRe = new RegExp('\\[wallets\\.' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\]([\\s\\S]*?)(?=\\n\\[|$)');
  const match = sectionRe.exec(text);
  if (!match) throw new Error('global.wallets.toml 中找不到钱包 ' + name + '（期望 [wallets.' + name + ']）');
  const mnemonicMatch = /mnemonic\s*=\s*"([^"]+)"/.exec(match[1]);
  if (!mnemonicMatch) throw new Error('钱包 ' + name + ' 没有内联 mnemonic（可能使用 keystore；spike 暂不支持）');
  return mnemonicMatch[1].trim().split(/\s+/);
}

export async function walletFromName(name) {
  const mnemonic = loadWalletMnemonic(name);
  const keyPair = await deps.crypto.mnemonicToPrivateKey(mnemonic);
  const wallet = deps.ton.WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey });
  return {
    name,
    keyPair,
    wallet,
    address: wallet.address,
    friendly: wallet.address.toString({ testOnly: true, bounceable: true }),
    raw: wallet.address.toRawString(),
  };
}

export async function buildSigners(names) {
  const list = [];
  for (const name of names) list.push(await walletFromName(name));
  return list;
}

/** 从地址字符串（friendly/raw）构造 Address。 */
export function parseAddressSafe(value) {
  try { return Address.parse(String(value).trim()); } catch { return null; }
}

/* ------------------------------------------------------------------ */
/* toncenter 只读 / 发送                                                */
/* ------------------------------------------------------------------ */

export async function getAccount(address) {
  const friendly = typeof address === 'string' ? address : address.toString({ testOnly: true, bounceable: true });
  const json = await httpJson(TONCENTER.v2 + '/getAddressInformation?address=' + encodeURIComponent(friendly));
  if (!json.ok) throw new Error('getAddressInformation 失败：' + JSON.stringify(json.error || json).slice(0, 300));
  return json.result;
}

/** 运行 get-method；返回 { exitCode, stack(原始 JSON) }。 */
export async function runGetMethod(address, method, stack = []) {
  const addr = typeof address === 'string' ? Address.parse(address) : address;
  const json = await httpJson(TONCENTER.v2 + '/runGetMethod', {
    method: 'POST',
    body: { address: addr.toRawString(), method, stack },
  });
  if (!json.ok) throw new Error('runGetMethod(' + method + ') 失败：' + JSON.stringify(json.error || json).slice(0, 300));
  return { exitCode: json.result.exit_code, stack: json.result.stack || [] };
}

/** 把 toncenter v2 stack item（数组或对象）转成字符串值。 */
export function stackValue(item) {
  if (item === null || item === undefined) return null;
  if (Array.isArray(item)) return item[1];
  if (typeof item === 'object' && item.value !== undefined) return item.value;
  return item;
}

function toBigInt(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (text === '') return null;
  if (text.startsWith('-0x')) return -BigInt('0x' + text.slice(3));
  if (text.startsWith('0x')) return BigInt(text);
  return BigInt(text);
}

/** 读取 seqno（v4r2）。 */
export async function readSeqno(address) {
  const { exitCode, stack } = await runGetMethod(address, 'seqno');
  if (exitCode !== 0) throw new Error('seqno getter exit_code=' + exitCode);
  return Number(toBigInt(stackValue(stack[0])));
}

/**
 * 从钱包发送一条 internal 消息（v4r2）。
 * @returns {{ boc: string, extHash: string|null }}
 */
export async function sendFromWallet(ctx, { to, value, body, bounce = true, init = null, sendMode = 3 }) {
  const { wallet, keyPair, address } = ctx;
  const account = await getAccount(address.toString({ testOnly: true, bounceable: true }));
  const active = String(account.state) === 'active';
  const seqno = active ? await readSeqno(address) : 0;
  const message = internal({ to: typeof to === 'string' ? Address.parse(to) : to, value: BigInt(value), body: body ?? beginCell().endCell(), bounce, init: init ?? undefined });
  const transfer = wallet.createTransfer({ seqno, secretKey: keyPair.secretKey, messages: [message], sendMode });
  const extMessage = beginCell()
    .store(storeMessage(external({ to: address, init: active ? undefined : wallet.init, body: transfer })))
    .endCell();
  const boc = extMessage.toBoc().toString('base64');
  const json = await httpJson(TONCENTER.v2 + '/sendBocReturnHash', { method: 'POST', body: { boc } }, { attempts: 6 });
  if (!json.ok) throw new Error('sendBoc 失败：' + JSON.stringify(json.error || json).slice(0, 400));
  return { boc, extHash: json.result && json.result.hash ? json.result.hash : null, seqno };
}

/** 读取账户最近一笔交易的 lt（用于等待新交易）。 */
export async function latestLt(address) {
  const friendly = typeof address === 'string' ? address : address.toString({ testOnly: true, bounceable: true });
  const json = await httpJson(TONCENTER.v2 + '/getTransactions?address=' + encodeURIComponent(friendly) + '&limit=1');
  if (json.ok && Array.isArray(json.result) && json.result.length) return json.result[0].transaction_id.lt;
  return null;
}

/** 轮询直到账户 state=active。 */
export async function waitForActive(address, { timeoutMs = 90000, pollMs = 2500 } = {}) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < timeoutMs) {
    const account = await getAccount(typeof address === 'string' ? address : address.toString({ testOnly: true, bounceable: true }));
    last = String(account.state);
    if (last === 'active') return { state: last, account };
    await sleep(pollMs);
  }
  return { state: last, account: null };
}

/** 轮询钱包/账户最近交易，等待新交易出现。 */
export async function waitForAccountTx(address, { sinceLt = null, timeoutMs = 90000, pollMs = 2500 } = {}) {
  const friendly = typeof address === 'string' ? address : address.toString({ testOnly: true, bounceable: true });
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const json = await httpJson(TONCENTER.v2 + '/getTransactions?address=' + encodeURIComponent(friendly) + '&limit=5');
    if (json.ok && Array.isArray(json.result) && json.result.length) {
      const tx = json.result.find((item) => (sinceLt === null ? true : BigInt(item.transaction_id.lt) > BigInt(sinceLt)));
      if (tx) return tx;
    }
    await sleep(pollMs);
  }
  return null;
}

/** 从 toncenter v2 交易里提取费用/执行结果摘要。 */
export function summarizeTx(tx) {
  if (!tx) return null;
  const desc = tx.in_msg || {};
  const compute = tx.description && tx.description.compute_ph ? tx.description.compute_ph : null;
  return {
    hash: tx.transaction_id && tx.transaction_id.hash ? tx.transaction_id.hash : null,
    lt: tx.transaction_id ? tx.transaction_id.lt : null,
    utime: tx.utime || null,
    feeNano: tx.fee ? String(tx.fee) : null,
    aborted: tx.description ? Boolean(tx.description.aborted) : null,
    computeExitCode: compute && compute.exit_code !== undefined ? compute.exit_code : null,
    inValue: desc.value !== undefined ? String(desc.value) : null,
    outMessages: Array.isArray(tx.out_msgs) ? tx.out_msgs.length : 0,
  };
}

export function formatTon(nano, digits = 4) {
  if (nano === null || nano === undefined) return '—';
  return (Number(BigInt(String(nano))) / 1e9).toFixed(digits) + ' TON';
}

/* ------------------------------------------------------------------ */
/* Multisig v2 编解码                                                   */
/* ------------------------------------------------------------------ */

export function loadMultisigCode() {
  if (!existsSync(MULTISIG.artifact)) {
    throw new Error('缺少多签预编译产物：' + MULTISIG.artifact + '\n请先运行 91 脚本的 --prepare（会下载官方仓库源码/构建产物到 ops/spike-multisig/.cache）。');
  }
  const json = JSON.parse(readFileSync(MULTISIG.artifact, 'utf8'));
  return Cell.fromBoc(Buffer.from(json.hex, 'hex'))[0];
}

function addressDict(addresses) {
  const dict = Dictionary.empty(Dictionary.Keys.Uint(8), Dictionary.Values.Address());
  addresses.forEach((addr, index) => dict.set(index, typeof addr === 'string' ? Address.parse(addr) : addr));
  return dict;
}

export function buildMultisigData({ threshold, signers, proposers = [], allowArbitrarySeqno = false }) {
  return beginCell()
    .storeUint(0, MULTISIG.bits.orderSeqno)
    .storeUint(threshold, MULTISIG.bits.signerIndex)
    .storeRef(beginCell().storeDictDirect(addressDict(signers)).endCell())
    .storeUint(signers.length, MULTISIG.bits.signerIndex)
    .storeDict(addressDict(proposers))
    .storeBit(allowArbitrarySeqno)
    .endCell();
}

export function buildMultisigAddress({ code, threshold, signers, proposers = [], allowArbitrarySeqno = false }) {
  const data = buildMultisigData({ threshold, signers, proposers, allowArbitrarySeqno });
  const address = contractAddress(0, { code, data });
  return { address, data, code };
}

export function transferAction({ to, value, body = null, bounce = true, sendMode = 3 }) {
  const messageCell = beginCell()
    .store(storeMessageRelaxed(internal({ to: typeof to === 'string' ? Address.parse(to) : to, value: BigInt(value), body: body ?? beginCell().endCell(), bounce })))
    .endCell();
  return beginCell().storeUint(MULTISIG.op.actionSendMessage, MULTISIG.bits.op).storeUint(sendMode, 8).storeRef(messageCell).endCell();
}

export function updateParamsAction({ threshold, signers, proposers = [] }) {
  return beginCell()
    .storeUint(MULTISIG.op.actionUpdateParams, MULTISIG.bits.op)
    .storeUint(threshold, MULTISIG.bits.signerIndex)
    .storeRef(beginCell().storeDictDirect(addressDict(signers)).endCell())
    .storeDict(addressDict(proposers))
    .endCell();
}

export function packOrder(actions) {
  if (!actions.length) throw new Error('订单至少需要 1 条 action');
  if (actions.length > 255) throw new Error('spike 仅支持 ≤255 条 action');
  const dict = Dictionary.empty(Dictionary.Keys.Uint(8), Dictionary.Values.Cell());
  actions.forEach((action, index) => dict.set(index, action));
  return beginCell().storeDictDirect(dict).endCell();
}

export function newOrderBody({ actions, expiration, isSigner, signerIndex, seqno, queryId = 0 }) {
  return beginCell()
    .storeUint(MULTISIG.op.newOrder, MULTISIG.bits.op)
    .storeUint(queryId, MULTISIG.bits.queryId)
    .storeUint(seqno, MULTISIG.bits.orderSeqno)
    .storeBit(isSigner)
    .storeUint(signerIndex, MULTISIG.bits.signerIndex)
    .storeUint(expiration, MULTISIG.bits.time)
    .storeRef(packOrder(actions))
    .endCell();
}

export function approveBody({ signerIndex, queryId = 0 }) {
  return beginCell()
    .storeUint(MULTISIG.op.orderApprove, MULTISIG.bits.op)
    .storeUint(queryId, MULTISIG.bits.queryId)
    .storeUint(signerIndex, MULTISIG.bits.signerIndex)
    .endCell();
}

/** 解析 runGetMethod 的 stack（toncenter v2 JSON 格式）为可读值。使用 @ton/core 的 TupleReader。 */
let cachedClient = null;
function tonClient() {
  if (!cachedClient) cachedClient = new deps.ton.TonClient({ endpoint: TONCENTER.v2 + '/jsonRPC' });
  return cachedClient;
}

export async function callGetter(address, method, params = []) {
  const addr = typeof address === 'string' ? Address.parse(address) : address;
  const result = await withRetry(() => tonClient().runMethod(addr, method, params));
  return result.stack;
}

export async function readMultisigData(address) {
  const stack = await callGetter(address, 'get_multisig_data');
  const nextOrderSeqno = stack.readBigNumber();
  const threshold = stack.readBigNumber();
  const signersCell = stack.readCell();
  const proposersCell = stack.readCellOpt();
  const signers = signersCell ? cellToAddresses(signersCell) : [];
  const proposers = proposersCell ? cellToAddresses(proposersCell) : [];
  return { nextOrderSeqno, threshold: Number(threshold), signers, proposers };
}

function cellToAddresses(cell) {
  const dict = Dictionary.loadDirect(Dictionary.Keys.Uint(8), Dictionary.Values.Address(), cell);
  const list = [];
  const keys = dict.keys();
  keys.sort((a, b) => a - b);
  for (const key of keys) list.push(dict.get(key));
  return list;
}

export async function readOrderAddress(multisigAddress, seqno) {
  const stack = await callGetter(multisigAddress, 'get_order_address', [{ type: 'int', value: BigInt(seqno) }]);
  return stack.readAddress();
}

export async function readOrderData(orderAddress) {
  const stack = await callGetter(orderAddress, 'get_order_data');
  const multisig = stack.readAddress();
  const orderSeqno = stack.readBigNumber();
  const threshold = stack.readBigNumber();
  const executed = stack.readBoolean();
  const signersCell = stack.readCell();
  const approvals = stack.readBigNumber();
  const approvalsNum = stack.readBigNumber();
  const expiration = stack.readBigNumber();
  return {
    multisig: multisig.toString({ testOnly: true, bounceable: true }),
    orderSeqno,
    threshold: Number(threshold),
    executed,
    approvals: Number(approvals),
    approvalsNum: Number(approvalsNum),
    expiration: Number(expiration),
    signers: cellToAddresses(signersCell).map((a) => a.toString({ testOnly: true, bounceable: true })),
  };
}

/* ------------------------------------------------------------------ */
/* registry / 文件                                                      */
/* ------------------------------------------------------------------ */

export const SPIKE_REGISTRY = join(BAM_ROOT, 'ops', 'records', 'multisig-registry.json');
export const MAIN_REGISTRY = join(BAM_ROOT, 'ops', 'config', 'testnet.registry.json');

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}
