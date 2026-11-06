#!/usr/bin/env node
/**
 * chain-reconcile.mjs — v10 链上 ↔ Worker 对账工具（纯 node、零依赖、不 import TS）。
 *
 * 用法：
 *   node worker/src/indexer/tools/chain-reconcile.mjs \
 *     --network testnet --rc <RC> --jm <JM> [--tw <团队钱包>] [--keeper <keeper>] \
 *     [--api https://a9.lat] [--v2-url … --v3-url …（fixture-server）] [--json report.json] [--allow-public]
 *
 * v10（docs/34 §2）：只有 RoundController + Jetton；团队释放读 RoundSettled；RC 钱包余额核对公式：
 *   82 亿 + Σ已接受质押 + Σ退款账本记入 + Σ留存零头 − Σ已确认团队释放 − Σ已确认销毁 − Σ已领取（本金 + 奖励 + 退款）
 *
 * 环境变量：TONCENTER_API_KEY（强烈建议；无 key 时自动 5s 间隔且极易 429）
 *
 * 规则（Lead 硬要求）：
 *  - 每一项都以 get-method 为独立锚点，API 只是被检对象；
 *  - 任何一步拿不到 getter / API 就 FAIL 并 exit 1，不静默跳过；
 *  - 差值必须为 0 才算通过；链上 qualifiedCandles 封顶 16，报告里会显式标注「链上封顶 16 / D1 真实 N」。
 *
 * ORACLE_CONFIG_HASH canonical 规则（与 worker/src/indexer/config.ts 必须逐字节一致）：
 *  1. get_protocol_config() 22 槽，顺序 = 合约声明顺序；
 *  2. 地址槽 -> "<workchain>:<64 位小写 hex>"；整数槽 -> 十进制字符串（无 0x / 无前导零）；
 *  3. JSON.stringify({ v: 1, network, fields: {...按声明顺序...} })（UTF-8、无空格）；
 *  4. hash = "sha256:" + sha256(utf8).hex。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const CONFIG_KEYS = [
  'admin', 'oracle', 'jettonMaster', 'stakingJettonWallet', 'teamVault',
  'p0UsdE8', 'priceMultiplier', 'roundRewardRaw', 'teamRoundRaw', 'minStakeRaw',
  'maxStakePerAddressBps', 'maxTotalStakeRaw', 'previewSeconds', 'stakeDurationSeconds',
  'candleSeconds', 'candleCount', 'minQualifiedCandles', 'observationSeconds',
  'techAbortPauseSeconds', 'techAbortObsTimeoutSeconds', 'riskDisclosureVersion', 'configVersion',
];
// v10 只会出现 0/1/2/4/8/9/10
const STATUS_TO_STATE = {
  0: 'UNOPENED', 1: 'UNOPENED', 2: 'STAKING_OPEN', 4: 'OBSERVING', 8: 'SUCCEEDED', 9: 'FAILED_PERMANENT', 10: 'TECHNICAL_ABORTED',
};

/* ------------------------------- CLI 参数 ------------------------------- */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const network = (args.network || 'testnet') === 'mainnet' ? 'mainnet' : 'testnet';
const allowPublic = Boolean(args['allow-public']) || !process.env.TONCENTER_API_KEY;
const apiBase = args.api ? String(args.api).replace(/\/$/, '') : null;
// 可选：把 toncenter v2/v3 指向 fixture-server（离线 CI 对账，命令见 e2e-local.mjs）
const V2_BASE = args['v2-url'] ? String(args['v2-url']).replace(/\/$/, '') : (network === 'mainnet' ? 'https://toncenter.com/api/v2' : 'https://testnet.toncenter.com/api/v2');
const V3_BASE = args['v3-url'] ? String(args['v3-url']).replace(/\/$/, '') : (network === 'mainnet' ? 'https://toncenter.com/api/v3' : 'https://testnet.toncenter.com/api/v3');
const reportPath = args.json ? String(args.json) : null;

/* ------------------------------- 地址工具 ------------------------------- */
const CRC16 = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let b = 0; b < 8; b++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
    t[i] = c;
  }
  return t;
})();
function crc16(bytes) {
  let crc = 0;
  for (const byte of bytes) crc = ((crc << 8) & 0xffff) ^ CRC16[((crc >> 8) ^ byte) & 0xff];
  return crc;
}
function parseAddress(input) {
  if (typeof input !== 'string' || !input.trim()) return null;
  const text = input.trim();
  const colon = text.indexOf(':');
  if (colon > 0) {
    const wc = Number(text.slice(0, colon));
    const hash = text.slice(colon + 1);
    if (!Number.isInteger(wc) || !/^[0-9a-fA-F]{64}$/.test(hash)) return null;
    return { raw: wc + ':' + hash.toLowerCase(), workchain: wc, hashHex: hash.toLowerCase() };
  }
  if (text.length !== 48) return null;
  const bytes = Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4), 'base64');
  if (bytes.length !== 36) return null;
  if (crc16(bytes.subarray(0, 34)) !== ((bytes[34] << 8) | bytes[35])) return null;
  const wc = bytes[1] > 127 ? bytes[1] - 256 : bytes[1];
  return { raw: wc + ':' + bytes.subarray(2, 34).toString('hex'), workchain: wc, hashHex: bytes.subarray(2, 34).toString('hex') };
}

/* --------------------------- BOC / 位读取 --------------------------- */
class BitReader {
  constructor(data, bitLen) { this.data = data; this.bitLen = bitLen; this.pos = 0; }
  u(bits) {
    let v = 0n;
    for (let i = 0; i < bits; i++) {
      const byte = this.data[this.pos >> 3] ?? 0;
      v = (v << 1n) | BigInt((byte >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return v;
  }
  n(bits) { return Number(this.u(bits)); }
  address() {
    const tag = this.u(2);
    if (tag !== 2n) throw new Error('地址标记非 0b10');
    if (this.u(1) === 1n) this.u(8);
    const wcRaw = this.n(8);
    const wc = wcRaw > 127 ? wcRaw - 256 : wcRaw;
    const hash = this.u(256);
    const hashHex = hash.toString(16).padStart(64, '0');
    return { workchain: wc, hashHex, raw: wc + ':' + hashHex };
  }
}
function bitLenOf(n) { let b = 0; while (n > 0) { b++; n = Math.floor(n / 2); } return b; }
function parseBoc(b64) {
  const buf = Buffer.from(b64, 'base64');
  if (buf.readUInt32BE(0) !== 0xb5ee9c72) throw new Error('BOC magic 不匹配');
  const flags = buf[4];
  const hasIdx = (flags & 0x80) !== 0;
  const sizeBytes = flags & 7;
  const offBytes = buf[5];
  let p = 6;
  const rd = (n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + buf[p++]; return v; };
  const cellsNum = rd(sizeBytes);
  rd(sizeBytes); rd(sizeBytes); rd(offBytes);
  const rootIdx = rd(sizeBytes);
  if (hasIdx) p += cellsNum * offBytes;
  const refBytes = Math.max(1, Math.ceil(bitLenOf(cellsNum) / 8));
  const cells = [];
  for (let i = 0; i < cellsNum; i++) {
    const d1 = buf[p++]; const d2 = buf[p++];
    const refs = d1 & 7;
    if ((d1 & 0x10) !== 0) throw new Error('不支持 with_hashes cell');
    const dataLen = (d2 >> 1) + (d2 & 1);
    const withBits = (d2 & 1) !== 0;
    const data = buf.subarray(p, p + dataLen); p += dataLen;
    for (let r = 0; r < refs; r++) rd(refBytes);
    let bitLen = dataLen * 8;
    if (withBits) {
      const last = data[dataLen - 1];
      let ctz = 0; let v = last & 0x7f;
      if (!v) throw new Error('BOC cell 位长编码非法');
      while ((v & 1) === 0) { ctz++; v >>= 1; }
      bitLen = (dataLen - 1) * 8 + 7 - ctz;
    }
    cells.push({ d1, d2, data, bitLen });
  }
  return { cells, rootIndex: rootIdx };
}
function rootCell(b64) { const bag = parseBoc(b64); return bag.cells[bag.rootIndex]; }
function cellHashRaw(d1, d2, data) { return createHash('sha256').update(Buffer.concat([Buffer.from([d1, d2]), data])).digest(); }
function hashOfBits(buf, bitLen) {
  const dataLen = buf.length;
  const d2 = bitLen % 8 === 0 ? dataLen * 2 : (dataLen - 1) * 2 + 1;
  return cellHashRaw(0, d2, buf);
}
function rollingHash(prev, index, twap, digest) {
  const b = Buffer.alloc(81);
  prev.copy(b, 0);
  b[32] = index & 0xff;
  const tw = Buffer.alloc(16); let t = twap; for (let i = 15; i >= 0; i--) { tw[i] = Number(t & 255n); t >>= 8n; }
  tw.copy(b, 33);
  const dg = Buffer.alloc(32); let d = digest; for (let i = 31; i >= 0; i--) { dg[i] = Number(d & 255n); d >>= 8n; }
  dg.copy(b, 49);
  return hashOfBits(b, 648);
}
function sha256Hex(text) { return createHash('sha256').update(text, 'utf8').digest(); }

/* --------------------------- toncenter 客户端 --------------------------- */
let lastCallAt = 0;
const MIN_INTERVAL = allowPublic ? 5000 : 150;
async function throttle() {
  const wait = MIN_INTERVAL - (Date.now() - lastCallAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}
async function httpJson(url, options = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    await throttle();
    try {
      const response = await fetch(url, {
        method: options.method || 'GET',
        headers: { 'content-type': 'application/json', ...(process.env.TONCENTER_API_KEY ? { 'X-API-Key': process.env.TONCENTER_API_KEY } : {}) },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(20000),
      });
      const text = await response.text();
      let json;
      try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
      if (response.ok && json.ok !== false) return json;
      lastError = 'HTTP ' + response.status + ' ' + JSON.stringify(json).slice(0, 200);
      if (response.status === 429) await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
    } catch (error) {
      lastError = String(error && error.message ? error.message : error);
    }
    await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
  }
  throw new Error('toncenter 请求失败（' + url + '）：' + lastError);
}
async function runGetMethod(address, method, stack = []) {
  const json = await httpJson(V2_BASE + '/runGetMethod', { method: 'POST', body: { address, method, stack } });
  if (!json.result || typeof json.result.exit_code !== 'number') throw new Error(method + ' 缺少 result');
  if (json.result.exit_code !== 0) throw new Error(method + ' exit_code=' + json.result.exit_code);
  return json.result.stack;
}
async function getTransactions(address, startLt) {
  const params = new URLSearchParams({ account: address, limit: '100', sort: 'asc' });
  if (startLt) params.set('start_lt', startLt);
  const json = await httpJson(V3_BASE + '/transactions?' + params.toString());
  return json.transactions || [];
}
function stackNum(item) {
  const payload = Array.isArray(item) ? item[1] : item && item.value;
  if (!payload) return 0n;
  if (typeof payload === 'string') {
    if (payload.startsWith('-0x')) return -BigInt('0x' + payload.slice(3));
    if (payload.startsWith('0x')) return BigInt(payload);
    return BigInt(payload);
  }
  if (payload.value) return BigInt(payload.value.startsWith('0x') ? payload.value : '0x' + payload.value);
  return 0n;
}
function stackAddress(item) {
  if (!item) return null;
  const payload = Array.isArray(item) ? item[1] : null;
  const b64 = payload && (payload.object && payload.object.data && payload.object.data.b64 ? payload.object.data.b64 : null);
  const len = payload && payload.object && payload.object.data && payload.object.data.len;
  if (b64 && typeof len === 'number') {
    const cell = { data: Buffer.from(b64, 'base64'), bitLen: len };
    return new BitReader(cell.data, cell.bitLen).address();
  }
  return null;
}

/* ------------------------------ 链上 getter ------------------------------ */
async function getProtocolConfig(rc) {
  const stack = await runGetMethod(rc, 'get_protocol_config');
  if (stack.length < 22) throw new Error('get_protocol_config 槽位不足：' + stack.length);
  const fields = {};
  CONFIG_KEYS.forEach((key, i) => {
    if (i < 5) {
      const address = stackAddress(stack[i]);
      if (!address) throw new Error('config 地址槽 ' + key + ' 为空');
      fields[key] = address.raw;
    } else fields[key] = stackNum(stack[i]).toString();
  });
  return fields;
}
function configDigest(fields) {
  const ordered = {};
  for (const key of CONFIG_KEYS) ordered[key] = String(fields[key]);
  return 'sha256:' + sha256Hex(JSON.stringify({ v: 1, network, fields: ordered })).toString('hex');
}
async function getRound(rc, roundId) {
  const stack = await runGetMethod(rc, 'get_round', [['num', '0x' + roundId.toString(16)]]);
  if (stack.length < 22) throw new Error('get_round 槽位不足');
  const hex256 = (v) => '0x' + v.toString(16).padStart(64, '0');
  const bool = (v) => stackNum(v) !== 0n;
  return {
    roundId: Number(stackNum(stack[0])), status: Number(stackNum(stack[1])), targetTier: Number(stackNum(stack[2])),
    targetPriceUsdE8: stackNum(stack[3]), targetTwap24hUsdE8: stackNum(stack[4]), targetWrittenAt: Number(stackNum(stack[5])),
    rewardBudgetRaw: stackNum(stack[6]), stakeOpenAt: Number(stackNum(stack[7])), stakeCloseAt: Number(stackNum(stack[8])),
    observationStart: Number(stackNum(stack[9])), observationEnd: Number(stackNum(stack[10])), candlesSeen: Number(stackNum(stack[11])),
    qualifiedCandles: Number(stackNum(stack[12])), totalAcceptedStakeRaw: stackNum(stack[13]), settledAt: Number(stackNum(stack[14])),
    teamReleaseConfirmed: bool(stack[15]), teamBurnConfirmed: bool(stack[16]), rewardBurnConfirmed: bool(stack[17]),
    principalBurnConfirmed: bool(stack[18]), failureBurnId: hex256(stackNum(stack[19])), candleHash: hex256(stackNum(stack[20])),
    totalWeight: stackNum(stack[21]),
  };
}
async function getCurrentRound(rc) { return Number(stackNum((await runGetMethod(rc, 'get_current_round'))[0])); }
async function getRoundTotalStake(rc, roundId) { return stackNum((await runGetMethod(rc, 'get_round_total_stake', [['num', '0x' + roundId.toString(16)]]))[0]); }
async function getJettonData(jm) {
  const stack = await runGetMethod(jm, 'get_jetton_data');
  return { totalSupplyRaw: stackNum(stack[0]), mintable: stackNum(stack[1]) !== 0n };
}
/** 地址入参 slice BOC（与 worker getters.addressArg 逐字节一致，含 1 位哨兵）。 */
function addressSliceBoc(parsed) {
  const bits = [];
  const push = (value, count) => {
    let v = typeof value === 'bigint' ? value : BigInt(value);
    if (v < 0n) v = (1n << BigInt(count)) + v;
    for (let i = count - 1; i >= 0; i--) bits.push(Number((v >> BigInt(i)) & 1n));
  };
  push(2n, 2); push(0n, 1); push(parsed.workchain, 8); push(BigInt('0x' + parsed.hashHex), 256); push(1n, 1);
  const data = Buffer.alloc(Math.ceil(bits.length / 8));
  bits.forEach((bit, index) => { if (bit) data[index >> 3] |= 0x80 >> (index & 7); });
  const bitLen = bits.length;
  const dataLen = data.length;
  const d2 = bitLen % 8 === 0 ? dataLen * 2 : (dataLen - 1) * 2 + 1;
  const cellSize = 2 + dataLen;
  const out = Buffer.alloc(11 + cellSize);
  out[0] = 0xb5; out[1] = 0xee; out[2] = 0x9c; out[3] = 0x72; out[4] = 0x01;
  out[5] = 0x01; out[6] = 0x01; out[7] = 0x01; out[8] = 0x00; out[9] = cellSize; out[10] = 0x00;
  out[11] = 0x00; out[12] = d2;
  data.copy(out, 13);
  return out.toString('base64');
}
/** raw → 用户友好地址（非 bounceable，UQ…；/api/me 只接受友好地址）。 */
function toFriendly(parsed) {
  const body = Buffer.alloc(34);
  body[0] = 0x51;
  body[1] = parsed.workchain & 0xff;
  Buffer.from(parsed.hashHex, 'hex').copy(body, 2);
  const crc = crc16(body);
  return Buffer.concat([body, Buffer.from([crc >> 8, crc & 0xff])]).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}
async function getClaimableAll(rc, owner) {
  const stack = await runGetMethod(rc, 'get_claimable_all', [['slice', addressSliceBoc(owner)]]);
  return { principalRaw: stackNum(stack[0]), rewardRaw: stackNum(stack[1]), roundsMask: Number(stackNum(stack[2])) };
}
async function getJettonWalletAddress(rc) { return stackAddress((await runGetMethod(rc, 'get_jetton_wallet_address'))[0]); }
async function getWalletBalance(wallet) { return stackNum((await runGetMethod(wallet, 'get_wallet_data'))[0]); }
async function fetchAllTransactions(address) {
  const all = [];
  let startLt;
  for (let page = 0; page < 50; page++) {
    const batch = await getTransactions(address, startLt);
    if (!batch.length) break;
    for (const tx of batch) if (!all.length || BigInt(tx.lt) > BigInt(all[all.length - 1].lt)) all.push(tx);
    const lastLt = batch[batch.length - 1].lt;
    if (batch.length < 100 || lastLt === startLt) break;
    startLt = lastLt;
  }
  return all;
}

/* ------------------------------ v10 事件 ------------------------------ */
const EV = {
  depositAccepted: 0x52540103, roundSettled: 0x52540102, claimed: 0x5254010e, depositRefunded: 0x5254010f,
  settlementBounced: 0x52540110, unexpectedBounce: 0x52540111,
};
const REFUND_BIT = 1 << 15;
function decodeEvent(opcode, body) {
  const cell = rootCell(body);
  const r = new BitReader(cell.data, cell.bitLen);
  if (r.n(32) !== opcode) return null;
  switch (opcode) {
    case EV.depositAccepted: return { kind: 'deposit', roundId: r.n(8), owner: r.address().raw, amount: r.u(128) };
    case EV.roundSettled: {
      const roundId = r.n(8); const status = r.n(8); r.n(8); r.n(8); const stake = r.u(128); r.n(8);
      return { kind: 'settled', roundId, status, stake, rewardBurn: r.u(128), teamBurn: r.u(128), principalBurn: r.u(128), teamReleased: r.u(128) };
    }
    case EV.claimed: return { kind: 'claimed', owner: r.address().raw, mask: r.n(16), principal: r.u(128), reward: r.u(128) };
    case EV.depositRefunded: return { kind: 'refund', owner: r.address().raw, amount: r.u(128), instant: r.n(1) === 1, recorded: r.n(1) === 1 };
    case EV.settlementBounced: return { kind: 'bounced', roundId: r.n(8), action: r.n(8) };
    case EV.unexpectedBounce: return { kind: 'unexpected', op: r.n(32), queryId: r.u(64) };
    default: return null;
  }
}
function decodeSubmitCandle(body) {
  const cell = rootCell(body);
  const r = new BitReader(cell.data, cell.bitLen);
  if (r.n(32) !== 0x52540003) return null;
  r.u(64);
  const roundId = r.n(8); const index = r.n(8); r.u(32); r.u(32);
  return { roundId, index, twap: r.u(128), digest: r.u(256) };
}

/* ------------------------------ 主流程 ------------------------------ */
const diffs = [];
const notes = [];
function diff(field, chainValue, apiValue, note) {
  diffs.push({ field, chain: String(chainValue), api: String(apiValue), note: note || '' });
}
async function apiGet(path) {
  const response = await fetch(apiBase + path, { signal: AbortSignal.timeout(30000) });
  const json = await response.json();
  if (!json || json.ok !== true) throw new Error('API ' + path + ' 失败：' + JSON.stringify(json).slice(0, 200));
  return json.data;
}

async function main() {
  const rc = parseAddress(args.rc);
  const jm = parseAddress(args.jm);
  if (!rc || !jm) { console.error('缺少 --rc / --jm'); process.exit(2); }
  const tw = args.tw ? parseAddress(args.tw) : null;
  const keeper = args.keeper ? parseAddress(args.keeper) : null;

  const cfg = await getProtocolConfig(rc.raw);
  const digest = configDigest(cfg);
  console.log('configVersion=' + cfg.configVersion + ' configHash=' + digest);
  if (cfg.jettonMaster !== jm.raw) diff('config.jettonMaster', cfg.jettonMaster, jm.raw);
  if (tw && cfg.teamVault !== tw.raw) diff('config.teamWallet', cfg.teamVault, tw.raw);
  if (keeper && (cfg.admin !== keeper.raw || cfg.oracle !== keeper.raw)) diff('config.keeper', cfg.admin + '/' + cfg.oracle, keeper.raw);
  if (cfg.admin !== cfg.oracle) diff('config.keeperSlots', cfg.admin, cfg.oracle, 'v10 admin = oracle = keeper');

  const txs = await fetchAllTransactions(rc.raw);
  const events = [];
  const candles = new Map();
  for (const tx of txs) {
    if (tx.aborted || (tx.description && tx.description.aborted)) continue;
    for (const message of tx.out_msgs || []) {
      if (message.destination || !message.opcode || !message.message_content || !message.message_content.body) continue;
      const event = decodeEvent(Number.parseInt(message.opcode, 16), message.message_content.body);
      if (event) events.push({ ...event, lt: tx.lt });
    }
    const inbound = tx.in_msg;
    if (inbound && inbound.opcode === '0x52540003' && inbound.message_content && inbound.message_content.body) {
      const candle = decodeSubmitCandle(inbound.message_content.body);
      if (candle) {
        const list = candles.get(candle.roundId) || [];
        if (!list.some((item) => item.index === candle.index)) list.push(candle);
        candles.set(candle.roundId, list);
      }
    }
  }
  console.log('transactions=' + txs.length + ' events=' + events.length);

  // 事件账
  const stakeByRound = new Map();
  const stakeByOwnerRound = new Map();
  const refundByOwner = new Map();
  let refundCredited = 0n; let refundDust = 0n; let refundClaimed = 0n; let claimedPaid = 0n;
  const claimed = new Map();
  for (const event of events) {
    if (event.kind === 'deposit') {
      stakeByRound.set(event.roundId, (stakeByRound.get(event.roundId) || 0n) + event.amount);
      const key = event.owner + '|' + event.roundId;
      stakeByOwnerRound.set(key, (stakeByOwnerRound.get(key) || 0n) + event.amount);
    } else if (event.kind === 'refund') {
      if (!event.recorded) refundDust += event.amount;
      else if (!event.instant) {
        refundCredited += event.amount;
        refundByOwner.set(event.owner, (refundByOwner.get(event.owner) || 0n) + event.amount);
      }
    } else if (event.kind === 'claimed') {
      let roundsPrincipal = 0n;
      const set = claimed.get(event.owner) || new Set();
      for (let r = 1; r <= 10; r++) {
        if (!(event.mask & (1 << (r - 1)))) continue;
        set.add(r);
        roundsPrincipal += stakeByOwnerRound.get(event.owner + '|' + r) || 0n;
      }
      claimed.set(event.owner, set);
      let refundPart = 0n;
      if (event.mask & REFUND_BIT) {
        refundPart = event.principal - roundsPrincipal;
        refundClaimed += refundPart;
        refundByOwner.set(event.owner, 0n);
      }
      claimedPaid += event.principal - refundPart + event.reward;
    } else if (event.kind === 'bounced') {
      notes.push('R' + event.roundId + ' SettlementBounced action=' + event.action + '（需要 RetrySettlement）');
    } else if (event.kind === 'unexpected') {
      notes.push('UnexpectedBounce op=0x' + event.op.toString(16) + ' queryId=' + event.queryId + '（需人工核查）');
    }
  }

  // 逐轮 getter
  const roundViews = new Map();
  let teamReleased = 0n; let burned = 0n;
  const settled = new Map(events.filter((event) => event.kind === 'settled').map((event) => [event.roundId, event]));
  for (let roundId = 1; roundId <= 10; roundId++) {
    const view = await getRound(rc.raw, roundId);
    roundViews.set(roundId, view);
    if (view.status === 0) continue;
    if (!(view.status in STATUS_TO_STATE)) diff('R' + roundId + '.status', view.status, '-', 'v10 不应出现');
    const stake = stakeByRound.get(roundId) || 0n;
    if (stake !== view.totalAcceptedStakeRaw) diff('R' + roundId + '.totalStake', view.totalAcceptedStakeRaw, stake, 'DepositAccepted 合计');
    if (view.totalWeight !== view.totalAcceptedStakeRaw) diff('R' + roundId + '.totalWeight', view.totalWeight, view.totalAcceptedStakeRaw, 'v10 = 总质押');
    const list = (candles.get(roundId) || []).sort((a, b) => a.index - b.index);
    if (list.length) {
      let hash = Buffer.alloc(32);
      for (const candle of list) hash = rollingHash(hash, candle.index, candle.twap, candle.digest);
      if ('0x' + hash.toString('hex') !== view.candleHash) diff('R' + roundId + '.candleHash', view.candleHash, '0x' + hash.toString('hex'));
    }
    if (view.status === 8 || view.status === 9) {
      const reward = BigInt(cfg.roundRewardRaw); const team = BigInt(cfg.teamRoundRaw);
      const exp = view.status === 8
        ? { rewardBurn: view.totalAcceptedStakeRaw === 0n ? reward : 0n, teamBurn: 0n, principalBurn: 0n, teamReleased: team }
        : { rewardBurn: reward, teamBurn: team, principalBurn: view.totalAcceptedStakeRaw, teamReleased: 0n };
      const event = settled.get(roundId);
      if (!event) diff('R' + roundId + '.RoundSettled', '缺事件', '-');
      else for (const key of Object.keys(exp)) if (event[key] !== exp[key]) diff('R' + roundId + '.settled.' + key, event[key], exp[key]);
      const burnTotal = exp.rewardBurn + exp.teamBurn + exp.principalBurn;
      if (burnTotal > 0n && view.rewardBurnConfirmed) burned += burnTotal;
      if (exp.teamReleased > 0n && view.teamReleaseConfirmed) teamReleased += exp.teamReleased;
      if (burnTotal > 0n && !view.rewardBurnConfirmed) notes.push('R' + roundId + ' burn 未确认（被退回待重试？）');
      if (exp.teamReleased > 0n && !view.teamReleaseConfirmed) notes.push('R' + roundId + ' 团队转账未确认（被退回待重试？）');
    }
  }

  // RC 钱包余额
  const initial = 10n * (BigInt(cfg.roundRewardRaw) + BigInt(cfg.teamRoundRaw));
  let totalStake = 0n;
  for (const value of stakeByRound.values()) totalStake += value;
  const expectedWallet = initial + totalStake + refundCredited + refundDust - teamReleased - burned - claimedPaid - refundClaimed;
  const wallet = await getJettonWalletAddress(rc.raw);
  if (!wallet || wallet.raw !== cfg.stakingJettonWallet) diff('rcWallet.address', wallet && wallet.raw, cfg.stakingJettonWallet);
  const balance = wallet ? await getWalletBalance(wallet.raw) : 0n;
  console.log('RC 钱包：chain=' + balance + ' 公式=' + expectedWallet + '（82 亿 + 质押 ' + totalStake + ' + 记入 ' + refundCredited + ' + 零头 ' + refundDust + ' − 团队 ' + teamReleased + ' − 销毁 ' + burned + ' − 领取 ' + claimedPaid + ' − 退款已领 ' + refundClaimed + '）');
  if (balance !== expectedWallet) diff('rcWallet.balance', balance, expectedWallet, '公式推导');
  const jetton = await getJettonData(jm.raw);
  const initialSupply = 10_000_000_000n * 1_000_000_000n;
  if (jetton.totalSupplyRaw !== initialSupply - burned) diff('jetton.totalSupply', jetton.totalSupplyRaw, initialSupply - burned, '初始 − 已确认 burn');

  // Worker API 对账（可选）
  if (apiBase) {
    const apiRounds = await apiGet('/api/rounds');
    const byId = new Map(apiRounds.map((row) => [row.roundId, row]));
    for (const [roundId, view] of roundViews) {
      if (view.status === 0) continue;
      const row = byId.get(roundId);
      if (!row) { diff('api.R' + roundId, 'exists', 'missing'); continue; }
      if (row.state !== STATUS_TO_STATE[view.status]) diff('api.R' + roundId + '.state', STATUS_TO_STATE[view.status], row.state);
      if (String(row.totalAcceptedStakeRaw) !== view.totalAcceptedStakeRaw.toString()) diff('api.R' + roundId + '.totalStake', view.totalAcceptedStakeRaw, row.totalAcceptedStakeRaw);
      if (view.status === 1) continue;
      if (String(row.targetPriceUsdE8) !== view.targetPriceUsdE8.toString()) diff('api.R' + roundId + '.target', view.targetPriceUsdE8, row.targetPriceUsdE8);
      if (row.candlesSeen !== view.candlesSeen) diff('api.R' + roundId + '.candlesSeen', view.candlesSeen, row.candlesSeen);
      const event = settled.get(roundId);
      const expectTeam = view.status === 8 && view.teamReleaseConfirmed && event ? event.teamReleased.toString() : null;
      if ((row.teamReleasedRaw ?? null) !== expectTeam) diff('api.R' + roundId + '.teamReleasedRaw', expectTeam, row.teamReleasedRaw);
      if (event && view.rewardBurnConfirmed) {
        const burnTotal = event.rewardBurn + event.teamBurn + event.principalBurn;
        const expectBurn = burnTotal > 0n ? burnTotal.toString() : null;
        if ((row.burnedRaw ?? null) !== expectBurn) diff('api.R' + roundId + '.burnedRaw', expectBurn, row.burnedRaw);
      }
    }
    const stats = await apiGet('/api/stats');
    if (BigInt(stats.burnedRaw) !== burned) diff('api.stats.burnedRaw', burned, stats.burnedRaw);
    const owners = new Set([...stakeByOwnerRound.keys()].map((key) => key.split('|')[0]).concat([...refundByOwner.keys()]));
    for (const owner of owners) {
      const parsed = parseAddress(owner);
      const chain = await getClaimableAll(rc.raw, parsed);
      const me = await apiGet('/api/me?address=' + encodeURIComponent(toFriendly(parsed)));
      const all = me.claimableAll;
      if (BigInt(all.principalRaw) !== chain.principalRaw || BigInt(all.rewardRaw) !== chain.rewardRaw || all.roundsMask !== chain.roundsMask) {
        diff('api.me.claimableAll.' + owner.slice(2, 10), chain.principalRaw + '/' + chain.rewardRaw + '/0x' + chain.roundsMask.toString(16), all.principalRaw + '/' + all.rewardRaw + '/0x' + all.roundsMask.toString(16));
      }
      for (const stake of me.stakes) {
        const exp = claimed.get(owner)?.has(stake.roundId) ?? false;
        if (stake.claimed !== exp) diff('api.me.claimed.' + owner.slice(2, 10) + '.R' + stake.roundId, exp, stake.claimed);
      }
    }
  }

  for (const note of notes) console.log('NOTE ' + note);
  console.log('DIFFS ' + diffs.length);
  for (const item of diffs) console.log('  - ' + item.field + ': chain=' + item.chain + ' api=' + item.api + (item.note ? '（' + item.note + '）' : ''));
  if (reportPath) writeFileSync(reportPath, JSON.stringify({ network, rc: rc.raw, configHash: digest, diffs, notes }, null, 2));
  process.exit(diffs.length ? 1 : 0);
}

main().catch((error) => { console.error('RECONCILE ERROR: ' + (error && error.stack ? error.stack : error)); process.exit(1); });
