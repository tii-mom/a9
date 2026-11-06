#!/usr/bin/env node
/**
 * chain-reconcile.mjs — 链上 ↔ Worker 对账工具（验收①，纯 node、零依赖、不 import TS）。
 *
 * 用法：
 *   node worker/src/indexer/tools/chain-reconcile.mjs \
 *     --network testnet \
 *     --api https://a9.lat \
 *     [--registry ops/config/testnet.registry.json] \
 *     [--rc kQ...] [--tv kQ...] [--jm kQ...] \
 *     [--json report.json] [--allow-public]
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
const STATUS_TO_STATE = {
  0: 'UNOPENED', 1: 'UNOPENED', 2: 'STAKING_OPEN', 3: 'STAKING_CLOSED', 4: 'OBSERVING',
  5: 'ORACLE_PAUSED', 6: 'SETTLING_SUCCESS', 7: 'SETTLING_FAILURE', 8: 'SUCCEEDED',
  9: 'FAILED_PERMANENT', 10: 'TECHNICAL_ABORTED',
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
async function getTeamVaultState(tv) {
  const stack = await runGetMethod(tv, 'get_team_vault_state');
  return { controller: stackAddress(stack[0]), teamRoundRaw: stackNum(stack[3]) };
}


/* --------------------------- docs/19 辅助：钱包 / 解锁 --------------------------- */
function bytesToBase64Local(bytes) { return Buffer.from(bytes).toString('base64'); }
/** 构造 MsgAddressInt 的 slice BOC（ton RunGetMethod 地址参数；含 1 位哨兵，理论见 indexer/boc.ts 注释）。 */
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
  return bytesToBase64Local(out);
}
async function getUnlockInfo(rcAddress, owner) {
  const stack = await runGetMethod(rcAddress, 'get_unlock_info', [['slice', { bytes: addressSliceBoc(owner) }]]);
  return { unlockStart: Number(stackNum(stack[0])), totalLockedRaw: stackNum(stack[1]), claimedRaw: stackNum(stack[2]), claimableRaw: stackNum(stack[3]) };
}
async function listJettonWallets(jettonMaster) {
  const list = [];
  for (let offset = 0; offset < 200; offset += 100) {
    const url = V3_BASE + '/jetton/wallets?jetton_address=' + encodeURIComponent(jettonMaster) + '&limit=100&offset=' + offset;
    const json = await httpJson(url);
    const batch = json.jetton_wallets || json.wallets || [];
    list.push(...batch);
    if (batch.length < 100) break;
  }
  return list;
}
function sameAddress(left, right) {
  const a = parseAddress(left);
  const b = parseAddress(right);
  return Boolean(a && b && a.raw === b.raw);
}

/* ------------------------------- 对账主流程 ------------------------------- */
const diffs = [];
const failures = [];
const notes = [];
function diff(field, chainValue, apiValue, note) {
  diffs.push({ field, chain: String(chainValue), api: String(apiValue), note: note || null });
}

async function main() {
  const registryPath = args.registry || (network === 'mainnet' ? 'ops/config/mainnet.registry.json' : 'ops/config/testnet.registry.json');
  let registry = null;
  try { registry = JSON.parse(readFileSync(registryPath, 'utf8')); } catch (error) { failures.push('读取 registry 失败（' + registryPath + '）：' + error.message); }
  const pick = (flag, contractKey) => {
    if (args[flag]) return parseAddress(String(args[flag]));
    const entry = registry && registry.contracts && registry.contracts[contractKey];
    return parseAddress(entry && entry.address);
  };
  const rc = pick('rc', 'roundController');
  const tv = pick('tv', 'teamVault');
  const jm = pick('jm', 'jettonMaster');
  if (!rc || !tv || !jm) { failures.push('缺少地址（--rc/--tv/--jm 或 registry）'); return; }

  console.log('== 链上锚点：get-method（独立于 API） ==');
  const config = await getProtocolConfig(rc.raw);
  const digest = configDigest(config);
  const currentRound = await getCurrentRound(rc.raw);
  const jetton = await getJettonData(jm.raw);
  const teamVault = await getTeamVaultState(tv.raw);
  console.log('configVersion=' + config.configVersion + '  configHash=' + digest);
  console.log('currentRound=' + currentRound + '  jetton.totalSupply=' + jetton.totalSupplyRaw.toString() + '  teamVault.controller=' + (teamVault.controller ? teamVault.controller.raw : 'null'));

  // 自检：TeamVault 只接受 RC 指令
  if (!teamVault.controller || teamVault.controller.raw !== rc.raw) failures.push('TeamVault.controller 不是 RoundController');
  if (teamVault.teamRoundRaw !== 120000000n * 1000000000n) diff('teamVault.teamRoundRaw', teamVault.teamRoundRaw.toString(), '120000000000000000');

  // 从交易里复算 K 线滚动哈希（链上唯一锚点，不依赖 API）
  const chainCandles = new Map();
  let startLt;
  let seenLt = null;
  for (let page = 0; page < 10; page++) {
    const txs = await getTransactions(rc.raw, startLt);
    if (!txs.length) break;
    for (const tx of txs) {
      // start_lt 是 inclusive：必须按 lt 去重，否则跨页会重复计数（验收①的血泪教训）
      if (seenLt !== null && BigInt(tx.lt) <= BigInt(seenLt)) continue;
      seenLt = tx.lt;
      const message = tx.in_msg;
      if (!message || message.opcode !== '0x52540003' || !message.message_content || !message.message_content.body) continue;
      if (tx.finality && tx.finality !== 'finalized') continue;
      const reader = new BitReader(rootCell(message.message_content.body).data, rootCell(message.message_content.body).bitLen);
      const op = Number(reader.u(32));
      if (op !== 0x52540003) continue;
      reader.u(64);
      const roundId = reader.n(8); const candleIndex = reader.n(8);
      reader.n(32); reader.n(32);
      const twap = reader.u(128); const digestValue = reader.u(256);
      const list = chainCandles.get(roundId) || [];
      if (!list.some((item) => item.candleIndex === candleIndex)) list.push({ candleIndex, twap, digest: digestValue });
      chainCandles.set(roundId, list);
    }
    const lastLt = txs[txs.length - 1].lt;
    if (lastLt === startLt || txs.length < 100) break;
    startLt = lastLt;
  }

  const rounds = new Map();
  for (let roundId = 1; roundId <= currentRound; roundId++) {
    const view = await getRound(rc.raw, roundId);
    if (view.status === 0) continue;
    rounds.set(roundId, view);
    const stake = await getRoundTotalStake(rc.raw, roundId);
    if (stake !== view.totalAcceptedStakeRaw) diff('R' + roundId + '.totalStake(getter)', view.totalAcceptedStakeRaw.toString(), stake.toString());
    const candles = (chainCandles.get(roundId) || []).sort((a, b) => a.candleIndex - b.candleIndex);
    // 进行中的轮次（2..7）每 10s~1h 还在产生新 K 线：交易列表与 getter 不是同一瞬间的快照，
    // 因此只对已终态轮次（8/9/10）强制「不可变」哈希/根数比对；进行中轮次仅校验已解析 K 线的连续性。
    const inFlight = view.status >= 2 && view.status <= 7;
    if (candles.length) {
      const sequential = candles.every((candle, index) => candle.candleIndex === index);
      if (!sequential) diff('R' + roundId + '.candlesSequential', '0..n', candles.map((candle) => candle.candleIndex).join(','));
      if (!inFlight) {
        let hash = Buffer.alloc(32);
        for (const candle of candles) hash = rollingHash(hash, candle.candleIndex, candle.twap, candle.digest);
        const computed = '0x' + hash.toString('hex');
        if (computed !== view.candleHash) diff('R' + roundId + '.candleHash', view.candleHash, computed, '本地按原始 K 线复算');
        if (candles.length !== view.candlesSeen) diff('R' + roundId + '.candlesCount', String(view.candlesSeen), String(candles.length));
      } else {
        notes.push('R' + roundId + ' 进行中（status=' + view.status + '）：已解析 ' + candles.length + ' 根 / 链上 ' + view.candlesSeen + ' 根，跳过不可变哈希比对');
      }
    }
  }


  /* ------------------------- docs/19 全生命周期对账 ------------------------- */
  if (args.doc19) {
    console.log('\n== docs/19 权威数字对账（不可变项必须 diff=0） ==');
    // 权威快照（docs/19 §2/§3，2026-11-05 20:13 UTC，由 Lead getter 独立读取）
    const DOC19 = {
      supplyRaw: 10000000000000000000n,
      burnedRaw: 5520910000000000000n,
      rcWalletDocRaw: 1732259899434318040n, // 1,732,259,899.434318040
      tvWalletDocRaw: 0n,
      teamRaw: 600000000000000000n,
      marketingRaw: 497000000000000000n,
      liquidityRaw: 500000000000000000n,
      internalRaw: 800000000000000000n,
      docUsersRaw: [139062093023000000n, 106413953488000000n, 104354054054000000n], // 仅 3 位小数，容差 1e6 raw
      unlockLockedRaw: 698900062853551224n,
      rounds: {
        1: { status: 8, tier: 1, target: 232000n, qualified: 16, stake: 0n, weight: 0n },
        2: { status: 9, tier: 2, target: 464000n, qualified: 0, stake: 0n, weight: 0n },
        3: { status: 8, tier: 2, target: 464000n, qualified: 16, stake: 300000000000000n, weight: 370000000000000n },
        4: { status: 9, tier: 3, target: 928000n, qualified: 5, stake: 20110000000000000n, weight: 24142000000000000n },
        5: { status: 8, tier: 3, target: 928000n, qualified: 16, stake: 300000000000000n, weight: 430000000000000n },
        6: { status: 9, tier: 4, target: 1856000n, qualified: 0, stake: 200000000000000n, weight: 300000000000000n },
        7: { status: 8, tier: 4, target: 1856000n, qualified: 16, stake: 0n, weight: 0n },
        8: { status: 9, tier: 5, target: 3712000n, qualified: 0, stake: 300000000000000n, weight: 370000000000000n },
        9: { status: 9, tier: 5, target: 3712000n, qualified: 0, stake: 300000000000000n, weight: 400000000000000n },
        10: { status: 8, tier: 5, target: 3712000n, qualified: 16, stake: 300000000000000n, weight: 430000000000000n },
      },
    };
    const threshold = Number(config.minQualifiedCandles);
    let chainRewardBurn = 0n; let chainTeamBurn = 0n; let chainPrincipalBurn = 0n;
    let roundMismatch = 0;
    console.log('轮 | status | tier | target | seen | qualified(封顶) | 质押 raw | 权重 raw | 团队释放 | 三笔销毁确认');
    for (const [roundId, expected] of Object.entries(DOC19.rounds)) {
      const view = rounds.get(Number(roundId));
      if (!view) { failures.push('docs19: 缺少 R' + roundId); roundMismatch++; continue; }
      const qualified = Math.min(view.qualifiedCandles, threshold);
      const rows = [];
      if (view.status !== expected.status) rows.push('status ' + view.status + '≠' + expected.status);
      if (view.targetTier !== expected.tier) rows.push('tier ' + view.targetTier + '≠' + expected.tier);
      if (view.targetPriceUsdE8 !== expected.target) rows.push('target ' + view.targetPriceUsdE8 + '≠' + expected.target);
      if (view.candlesSeen !== 24) rows.push('seen ' + view.candlesSeen + '≠24');
      if (qualified !== expected.qualified) rows.push('qualified ' + qualified + '≠' + expected.qualified);
      if (view.totalAcceptedStakeRaw !== expected.stake) rows.push('stake ' + view.totalAcceptedStakeRaw + '≠' + expected.stake);
      if (view.totalWeight !== expected.weight) rows.push('weight ' + view.totalWeight + '≠' + expected.weight);
      const success = view.status === 8;
      const expectRewardBurn = success ? expected.stake === 0n : true;
      const expectTeamBurn = !success;
      const expectPrincipalBurn = !success;
      if (view.teamReleaseConfirmed !== success) rows.push('teamRelease=' + view.teamReleaseConfirmed + '≠' + success);
      if (view.teamBurnConfirmed !== expectTeamBurn) rows.push('teamBurn=' + view.teamBurnConfirmed + '≠' + expectTeamBurn);
      if (view.rewardBurnConfirmed !== expectRewardBurn) rows.push('rewardBurn=' + view.rewardBurnConfirmed + '≠' + expectRewardBurn);
      if (view.principalBurnConfirmed !== expectPrincipalBurn) rows.push('principalBurn=' + view.principalBurnConfirmed + '≠' + expectPrincipalBurn);
      if (view.rewardBurnConfirmed) chainRewardBurn += BigInt(config.roundRewardRaw);
      if (view.teamBurnConfirmed) chainTeamBurn += BigInt(config.teamRoundRaw);
      if (view.principalBurnConfirmed) chainPrincipalBurn += view.totalAcceptedStakeRaw;
      if (rows.length) { roundMismatch++; diff('R' + roundId + '.doc19', rows.join('; '), 'docs/19'); }
      console.log(
        'R' + roundId + ' | ' + view.status + ' | ' + view.targetTier + ' | ' + view.targetPriceUsdE8.toString() + ' | ' + view.candlesSeen +
          ' | ' + qualified + ' | ' + view.totalAcceptedStakeRaw.toString() + ' | ' + view.totalWeight.toString() +
          ' | ' + (view.teamReleaseConfirmed ? '✓' : '—') + ' | ' +
          'R' + (view.rewardBurnConfirmed ? '✓' : '—') + ' T' + (view.teamBurnConfirmed ? '✓' : '—') + ' P' + (view.principalBurnConfirmed ? '✓' : '—'),
      );
    }
    const burnTotal = chainRewardBurn + chainTeamBurn + chainPrincipalBurn;
    console.log('销毁合计：奖励 ' + chainRewardBurn + ' + 团队 ' + chainTeamBurn + ' + 本金 ' + chainPrincipalBurn + ' = ' + burnTotal + ' raw');
    if (burnTotal !== DOC19.burnedRaw) diff('doc19.burnedRaw', DOC19.burnedRaw.toString(), burnTotal.toString());
    if (jetton.totalSupplyRaw + burnTotal !== DOC19.supplyRaw) diff('doc19.supplyInvariant', DOC19.supplyRaw.toString(), (jetton.totalSupplyRaw + burnTotal).toString());

    // 持币者枚举（v3 jetton/wallets）：总量守恒 + 角色钱包 + 快照后 claim 对平
    const wallets = await listJettonWallets(jm.raw);
    let holdersSum = 0n;
    const byOwner = new Map();
    for (const wallet of wallets) {
      const balance = BigInt(wallet.balance || '0');
      holdersSum += balance;
      byOwner.set(String(wallet.owner).toLowerCase(), balance);
    }
    console.log('持币者 ' + wallets.length + ' 个；余额合计 ' + holdersSum.toString() + ' raw（应等于链上总供应 ' + jetton.totalSupplyRaw.toString() + '）');
    if (holdersSum !== jetton.totalSupplyRaw) diff('doc19.holdersSum', jetton.totalSupplyRaw.toString(), holdersSum.toString());
    const rcWallet = wallets.find((wallet) => sameAddress(wallet.address, args['rc-wallet'] || ''));
    const tvWallet = wallets.find((wallet) => sameAddress(wallet.address, args['tv-wallet'] || ''));
    const roleKeyMap = {
      teamWallet: 'team', marketingWallet: 'marketing', liquidityWallet: 'liquidity', teamInternalWallet: 'internal',
    };
    const roleExpected = { team: DOC19.teamRaw, marketing: DOC19.marketingRaw, liquidity: DOC19.liquidityRaw, internal: DOC19.internalRaw };
    for (const [walletKey, role] of Object.entries(roleKeyMap)) {
      const owner = registry && registry.wallets && registry.wallets[walletKey] && registry.wallets[walletKey].address;
      const ownerParsed = parseAddress(owner);
      if (!ownerParsed) { notes.push('registry 缺钱包 ' + walletKey + '，跳过角色余额比对'); continue; }
      const balance = byOwner.get(ownerParsed.raw.toLowerCase()) ?? 0n;
      if (balance !== roleExpected[role]) diff('doc19.wallet.' + role, roleExpected[role].toString(), balance.toString());
      else console.log('角色钱包 ' + role + ' = ' + balance.toString() + ' raw ✓');
    }
    if (tvWallet && BigInt(tvWallet.balance) !== DOC19.tvWalletDocRaw) diff('doc19.tvWallet', '0', tvWallet.balance);

    // 用户钱包：docs/19 是 20:13 UTC 快照；之后发生 claim，RC 流出必须与用户流入逐 raw 对平
    const roleOwners = new Set();
    for (const walletKey of Object.keys(roleKeyMap)) {
      const parsed = parseAddress(registry && registry.wallets && registry.wallets[walletKey] && registry.wallets[walletKey].address);
      if (parsed) roleOwners.add(parsed.raw.toLowerCase());
    }
    if (rc) roleOwners.add(rc.raw.toLowerCase());
    if (tv) roleOwners.add(tv.raw.toLowerCase());
    const userHolders = [...byOwner.entries()]
      .filter(([owner, balance]) => balance > 0n && !roleOwners.has(owner))
      .sort((a, b) => (b[1] > a[1] ? 1 : -1))
      .slice(0, 3);
    const currentUsers = userHolders.map(([, balance]) => balance);
    const currentRc = rcWallet ? BigInt(rcWallet.balance) : 0n;
    const rcOutflow = DOC19.rcWalletDocRaw - currentRc;
    const usersInflow = currentUsers.reduce((sum, balance, index) => sum + (balance - (DOC19.docUsersRaw[index] ?? 0n)), 0n);
    console.log('docs/19 之后：RC 钱包流出 ' + rcOutflow.toString() + ' raw；用户 A/B/C 流入 ' + usersInflow.toString() + ' raw');
    const deltaGap = rcOutflow - usersInflow;
    if (deltaGap > 1000000n || deltaGap < -1000000n) diff('doc19.postSnapshotClaimDelta', usersInflow.toString(), rcOutflow.toString());
    else notes.push('docs/19 快照后的 claim：RC 流出 = 用户流入（Δ=' + deltaGap.toString() + ' raw ≤ 0.001 A9，文档余额为时点快照）');

    // 解锁池（R10 终态后）：只读 getter，不触发 claim
    if (userHolders.length) {
      const topOwner = parseAddress(userHolders[0][0]);
      if (topOwner) {
        const unlock = await getUnlockInfo(rc.raw, topOwner);
        console.log('解锁池（余额最高用户）：unlockStart=' + unlock.unlockStart + ' totalLockedRaw=' + unlock.totalLockedRaw.toString());
        if (unlock.unlockStart <= 0) diff('doc19.unlockStart', '>0', String(unlock.unlockStart));
        if (unlock.totalLockedRaw !== DOC19.unlockLockedRaw) diff('doc19.unlockLockedRaw', DOC19.unlockLockedRaw.toString(), unlock.totalLockedRaw.toString());
      }
    }
    notes.push('docs/19 轮次核对：' + (10 - roundMismatch) + '/10 轮 status/tier/target/qualified/stake/weight/销毁标志全部一致');
  }

  if (!apiBase) {
    console.log('\n（未提供 --api，跳过 Worker API 比对，仅链上自检）');
  } else {
    console.log('\n== Worker API 比对：' + apiBase + ' ==');
    const apiJson = async (path) => {
      const response = await fetch(apiBase + path, { signal: AbortSignal.timeout(20000) });
      const json = await response.json();
      if (!json || json.ok !== true) throw new Error(path + ' -> ' + JSON.stringify(json).slice(0, 200));
      return json.data;
    };
    let apiConfig = null; let apiStats = null; let apiRounds = [];
    try { apiConfig = await apiJson('/api/config'); } catch (error) { failures.push('GET /api/config 失败：' + error.message); }
    try { apiStats = await apiJson('/api/stats'); } catch (error) { failures.push('GET /api/stats 失败：' + error.message); }
    try { apiRounds = await apiJson('/api/rounds'); } catch (error) { failures.push('GET /api/rounds 失败：' + error.message); }

    if (apiConfig) {
      const pairs = [
        ['p0UsdE8', config.p0UsdE8], ['priceMultiplier', config.priceMultiplier],
        ['roundRewardRaw', config.roundRewardRaw], ['candleSeconds', config.candleSeconds],
        ['candleCount', config.candleCount], ['minQualifiedCandles', config.minQualifiedCandles],
        ['stakeDurationSeconds', config.stakeDurationSeconds], ['observationSeconds', config.observationSeconds],
        ['riskDisclosureVersion', config.riskDisclosureVersion], ['previewSeconds', config.previewSeconds],
      ];
      for (const [field, chainValue] of pairs) {
        const apiValue = apiConfig[field];
        if (String(apiValue) !== String(chainValue)) diff('config.' + field, chainValue, apiValue);
      }
    }
    if (apiStats) {
      if (String(apiStats.supplyRaw) !== jetton.totalSupplyRaw.toString()) diff('stats.supplyRaw', jetton.totalSupplyRaw, apiStats.supplyRaw);
      const latestRound = [...rounds.entries()].sort((a, b) => b[0] - a[0])[0];
      if (latestRound) {
        const candles = (chainCandles.get(latestRound[0]) || []).sort((a, b) => a.candleIndex - b.candleIndex);
        const last = candles.length ? candles[candles.length - 1].twap.toString() : null;
        if (last && String(apiStats.priceUsdE8) !== last) diff('stats.priceUsdE8', last, apiStats.priceUsdE8, '取最后一根已上链 K 线 TWAP');
      }
      if (apiStats.oracle && apiStats.oracle.paused === true && apiStats.oracle.online === true) diff('stats.oracle', 'paused&&online', 'paused=' + apiStats.oracle.paused + ' online=' + apiStats.oracle.online);
    }
    const apiRoundsById = new Map((apiRounds || []).map((row) => [row.roundId, row]));
    for (const [roundId, view] of rounds) {
      const api = apiRoundsById.get(roundId);
      if (!api) { failures.push('API /api/rounds 缺少 R' + roundId); continue; }
      const mapped = STATUS_TO_STATE[view.status];
      if (mapped && api.state !== mapped) diff('R' + roundId + '.state', mapped, api.state, '链上 status=' + view.status);
      if (String(api.targetPriceUsdE8) !== view.targetPriceUsdE8.toString()) diff('R' + roundId + '.targetPrice', view.targetPriceUsdE8, api.targetPriceUsdE8);
      const ms = (seconds) => (seconds > 0 ? seconds * 1000 : null);
      if ((api.stakeOpenAt ?? null) !== ms(view.stakeOpenAt)) diff('R' + roundId + '.stakeOpenAt', ms(view.stakeOpenAt), api.stakeOpenAt);
      if ((api.stakeCloseAt ?? null) !== ms(view.stakeCloseAt)) diff('R' + roundId + '.stakeCloseAt', ms(view.stakeCloseAt), api.stakeCloseAt);
      if ((api.observationStart ?? null) !== ms(view.observationStart)) diff('R' + roundId + '.observationStart', ms(view.observationStart), api.observationStart);
      if ((api.observationEnd ?? null) !== ms(view.observationEnd)) diff('R' + roundId + '.observationEnd', ms(view.observationEnd), api.observationEnd);
      if (Number(api.candlesSeen) !== view.candlesSeen) diff('R' + roundId + '.candlesSeen', view.candlesSeen, api.candlesSeen);
      const threshold = Number(config.minQualifiedCandles);
      const chainQualified = Math.min(view.qualifiedCandles, threshold);
      const apiQualified = Math.min(Number(api.qualifiedCandles), threshold);
      if (chainQualified !== apiQualified) {
        diff('R' + roundId + '.qualifiedCandles(min' + threshold + ')', chainQualified, apiQualified, '链上封顶 ' + threshold + '，D1 真实值=' + api.qualifiedCandles);
      }
      if (String(api.totalAcceptedStakeRaw) !== view.totalAcceptedStakeRaw.toString()) diff('R' + roundId + '.totalStake', view.totalAcceptedStakeRaw, api.totalAcceptedStakeRaw);
      if (view.candleHash !== '0x' + '0'.repeat(64) && api.candleHash && api.candleHash !== view.candleHash) diff('R' + roundId + '.candleHash', view.candleHash, api.candleHash);
      try {
        const detail = await apiJson('/api/rounds/' + roundId + '/candles');
        const list = Array.isArray(detail) ? detail : (detail.candles || []);
        if (list.length !== view.candlesSeen && view.candlesSeen > 0) diff('R' + roundId + '.candleRows', view.candlesSeen, list.length);
        for (const candle of list) {
          const expectedStart = view.observationStart * 1000 + candle.candleIndex * Number(config.candleSeconds) * 1000;
          if (candle.periodStart !== expectedStart) { diff('R' + roundId + '.candle[' + candle.candleIndex + '].periodStart', expectedStart, candle.periodStart); break; }
        }
      } catch (error) { failures.push('GET /api/rounds/' + roundId + '/candles 失败：' + error.message); }
    }
  }

  console.log('');
  console.log('== 结果 ==');
  console.log('getter 锚点：' + rounds.size + ' 轮；configHash=' + digest);
  if (failures.length) {
    console.log('FAILURES (' + failures.length + ')');
    for (const item of failures) console.log('  ! ' + item);
  }
  if (notes.length) {
    console.log('NOTES (' + notes.length + ')');
    for (const item of notes) console.log('  · ' + item);
  }
  if (diffs.length) {
    console.log('DIFFS (' + diffs.length + ')');
    for (const item of diffs) console.log('  - ' + item.field + '  chain=' + item.chain + '  api=' + item.api + (item.note ? '  (' + item.note + ')' : ''));
  } else {
    console.log('DIFFS (0)  ✅ 链上与 API 完全一致');
  }
  const report = { at: new Date().toISOString(), network, rc: rc.raw, digest, currentRound, diffs, failures };
  if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2));
  process.exit(failures.length || diffs.length ? 1 : 0);
}

main().catch((error) => {
  console.error('RECONCILE ERROR: ' + (error instanceof Error ? error.stack || error.message : String(error)));
  process.exit(1);
});
