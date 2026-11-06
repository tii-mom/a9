/** TON 地址编解码（CRC16/XMODEM）与 TON Center 只读查询。 */

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const HEX = '0123456789abcdefABCDEF';

function buildCrc16Table() {
  const table = new Uint16Array(256);
  for (let index = 0; index < 256; index++) {
    let crc = index << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    table[index] = crc;
  }
  return table;
}

const CRC16_TABLE = buildCrc16Table();

export function crc16(buffer) {
  let crc = 0;
  for (const byte of buffer) {
    crc = ((crc << 8) & 0xffff) ^ CRC16_TABLE[((crc >> 8) ^ byte) & 0xff];
  }
  return crc;
}

function isHex(text) {
  if (!text || text.length === 0) return false;
  for (const char of text) if (!HEX.includes(char)) return false;
  return true;
}

function isBase64Url(text) {
  if (!text || text.length === 0) return false;
  for (const char of text) if (!B64URL.includes(char)) return false;
  return true;
}

/** 解析友好地址（EQ.../UQ.../kQ.../0Q...）或 raw 地址（workchain:hex64）。 */
export function parseAddress(input) {
  if (typeof input !== 'string' || !input.trim()) return { ok: false, reason: 'empty' };
  const text = input.trim();
  const colon = text.indexOf(':');
  if (colon > 0) {
    const workchainText = text.slice(0, colon);
    const hashHex = text.slice(colon + 1);
    if (!isHex(workchainText) || !isHex(hashHex) || hashHex.length !== 64) {
      return { ok: false, reason: 'invalid raw address' };
    }
    const workchain = Number(workchainText);
    return {
      ok: true,
      raw: workchain + ':' + hashHex.toLowerCase(),
      workchain,
      hashHex: hashHex.toLowerCase(),
      bounceable: null,
      testnet: null,
      friendly: null,
    };
  }
  if (text.length !== 48 || !isBase64Url(text)) return { ok: false, reason: 'invalid friendly address length/charset' };
  const bytes = Buffer.from(text, 'base64url');
  if (bytes.length !== 36) return { ok: false, reason: 'invalid friendly address payload' };
  const expected = bytes.readUInt16BE(34);
  const actual = crc16(bytes.subarray(0, 34));
  if (expected !== actual) return { ok: false, reason: 'crc16 mismatch' };
  const flags = bytes[0];
  const bounceable = (flags & 0x40) === 0;
  const testnet = (flags & 0x80) !== 0;
  const workchain = bytes[1] > 127 ? bytes[1] - 256 : bytes[1];
  const hashHex = bytes.subarray(2, 34).toString('hex');
  return { ok: true, raw: workchain + ':' + hashHex, workchain, hashHex, bounceable, testnet, friendly: text };
}

export function isAddress(input) {
  return parseAddress(input).ok;
}

export function addressEquals(left, right) {
  const a = parseAddress(left);
  const b = parseAddress(right);
  return a.ok && b.ok && a.raw === b.raw;
}

export function formatAddress(workchain, hashHex, options = {}) {
  const bounceable = options.bounceable !== false;
  const testnet = options.testnet !== false;
  if (!isHex(hashHex) || hashHex.length !== 64) throw new Error('hashHex 必须为 64 位十六进制');
  const bytes = Buffer.alloc(36);
  bytes[0] = (bounceable ? 0x11 : 0x51) | (testnet ? 0x80 : 0x00);
  bytes[1] = workchain < 0 ? 256 + workchain : workchain;
  Buffer.from(hashHex, 'hex').copy(bytes, 2);
  bytes.writeUInt16BE(crc16(bytes.subarray(0, 34)), 34);
  return bytes.toString('base64url');
}

export function shortAddress(input) {
  const parsed = parseAddress(input);
  if (!parsed.ok) return String(input);
  return parsed.raw.slice(0, 6) + '...' + parsed.raw.slice(-6);
}

export function explorerUrl(params, address) {
  return params.network.explorerBaseUrl + '/address/' + encodeURIComponent(address);
}

function toncenterApiKey(params) {
  const envName = params.network.toncenter.apiKeyEnv;
  return envName ? process.env[envName] || null : null;
}

let lastToncenterCallAt = 0;
async function throttleToncenter(minIntervalMs = 1100) {
  const wait = Math.max(0, minIntervalMs - (Date.now() - lastToncenterCallAt));
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastToncenterCallAt = Date.now();
}

async function httpJson(url, options = {}) {
  const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
  if (options.apiKey) headers['X-API-Key'] = options.apiKey;
  const responses = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    await throttleToncenter();
    try {
      const response = await fetch(url, {
        method: options.method || 'GET',
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(options.timeoutMs || 15000),
      });
      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch { json = { raw: text }; }
      if (response.ok) return json;
      responses.push('HTTP ' + response.status + ': ' + text.slice(0, 300));
      if (response.status < 500 && response.status !== 429) break;
      if (response.status === 429) await new Promise((resolve) => setTimeout(resolve, 2500 * (attempt + 1)));
    } catch (error) {
      responses.push(String(error && error.message ? error.message : error));
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
  }
  throw new Error('TON Center 请求失败（' + url + '）：' + responses.join(' | '));
}

export async function getAddressInformation(params, address) {
  const parsed = parseAddress(address);
  if (!parsed.ok) throw new Error('非法地址：' + address);
  const url = params.network.toncenter.v2 + '/getAddressInformation';
  const body = { address: parsed.raw };
  const json = await httpJson(url, { method: 'POST', body, apiKey: toncenterApiKey(params) });
  if (!json.ok) throw new Error('getAddressInformation 失败：' + JSON.stringify(json.error || json));
  return json.result;
}

/** @param {Array<number|string>} numericStack 只支持数值参数（地址参数请改用 v3 jetton wallets 查询）。 */
export async function runGetMethod(params, address, method, numericStack = []) {
  const parsed = parseAddress(address);
  if (!parsed.ok) throw new Error('非法地址：' + address);
  const url = params.network.toncenter.v2 + '/runGetMethod';
  const stack = numericStack.map((value) => ['num', '0x' + BigInt(String(value)).toString(16)]);
  const json = await httpJson(url, {
    method: 'POST',
    body: { address: parsed.raw, method, stack },
    apiKey: toncenterApiKey(params),
  });
  if (!json.ok) throw new Error('runGetMethod ' + method + ' 失败：' + JSON.stringify(json.error || json));
  return json.result;
}

function normalizeStackItem(item) {
  if (Array.isArray(item)) return { type: item[0], payload: item[1] };
  return { type: item && item.type, payload: item };
}

export function stackItemToBigInt(item) {
  if (!item) return null;
  const normalized = normalizeStackItem(item);
  if (normalized.type === 'null') return null;
  const raw = normalized.payload && normalized.payload.value !== undefined ? normalized.payload.value : normalized.payload;
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (text.startsWith('-0x')) return -BigInt('0x' + text.slice(3));
  if (text.startsWith('0x')) return BigInt(text);
  if (text === '') return null;
  try { return BigInt(text); } catch { return null; }
}

function stackItemB64(item) {
  const normalized = normalizeStackItem(item);
  const payload = normalized.payload;
  if (!payload) return null;
  if (typeof payload === 'string') return payload;
  if (payload.object && payload.object.data && payload.object.data.b64) return payload.object.data.b64;
  if (payload.value && typeof payload.value === 'string') return payload.value;
  return null;
}

/** 从 get-method 的 slice/cell 地址槽解出 { wc, hashHex }；非地址（含 null address）返回 null。 */
export function addressFromStackItem(item) {
  if (!item) return null;
  const normalized = normalizeStackItem(item);
  if (normalized.type !== 'slice' && normalized.type !== 'cell') return null;
  const b64 = stackItemB64(item);
  if (!b64) return null;
  try {
    const bytes = Buffer.from(b64, 'base64');
    let bits = '';
    for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
    if (bits.length < 3 || bits.slice(0, 2) !== '10') return null;
    const wcRaw = parseInt(bits.slice(3, 11), 2);
    const wc = wcRaw === 255 ? -1 : wcRaw;
    let hashHex = '';
    for (let offset = 0; offset < 256; offset += 4) hashHex += parseInt(bits.slice(11 + offset, 15 + offset), 2).toString(16);
    return { wc, hashHex };
  } catch {
    return null;
  }
}

/** 读取 TEP-74 get_jetton_data：total_supply, mintable, admin, content, wallet_code。 */
export async function getJettonData(params, masterAddress) {
  const result = await runGetMethod(params, masterAddress, 'get_jetton_data');
  const stack = result.stack || [];
  const totalSupply = stackItemToBigInt(stack[0]);
  const mintable = stackItemToBigInt(stack[1]);
  const admin = stack[2] || null;
  return {
    totalSupplyRaw: totalSupply === null ? null : totalSupply.toString(),
    mintable: mintable === null ? null : mintable !== 0n,
    admin,
    adminAddress: addressFromStackItem(admin),
    adminNull: isNullAddressStackItem(admin),
    walletCode: stack[4] || null,
    raw: stack,
  };
}

/** 通过 TON Center v3 查询 owner 的 Jetton Wallet 地址（避免手工构造 slice 参数）。 */
export async function findJettonWallet(params, jettonMaster, ownerAddress) {
  const master = parseAddress(jettonMaster);
  const owner = parseAddress(ownerAddress);
  if (!master.ok) throw new Error('非法 Jetton Master：' + jettonMaster);
  if (!owner.ok) throw new Error('非法 owner：' + ownerAddress);
  const url = params.network.toncenter.v3 + '/jetton/wallets?jetton_address=' + encodeURIComponent(master.raw) + '&owner_address=' + encodeURIComponent(owner.raw) + '&limit=1';
  const json = await httpJson(url, { apiKey: toncenterApiKey(params) });
  const wallets = json.jetton_wallets || json.wallets || [];
  if (!wallets.length) return null;
  const wallet = wallets[0];
  return {
    address: wallet.address,
    balanceRaw: wallet.balance !== undefined ? String(wallet.balance) : null,
    owner: wallet.owner,
    jetton: wallet.jetton,
    raw: wallet,
  };
}

/** 读取合约 TON 余额（nanoTON 字符串）。 */
export async function getTonBalance(params, address) {
  const info = await getAddressInformation(params, address);
  return { balanceNano: String(info.balance ?? '0'), state: info.state, codeHash: info.code_hash ?? null, raw: info };
}

/** 判断 get-method 返回的地址槽是否为 null（未设置）：null 类型或空/近空 slice。 */
export function isNullAddressStackItem(item) {
  if (!item) return true;
  const normalized = normalizeStackItem(item);
  if (normalized.type === 'null') return true;
  const b64 = stackItemB64(item);
  if (!b64) return true;
  try {
    const bytes = Buffer.from(b64, 'base64');
    let bits = '';
    for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
    return bits.length < 3 || bits.slice(0, 2) !== '10';
  } catch {
    return true;
  }
}

/** 读取 Jetton Master 的元数据（TON Center v3）。decimals 可能是字符串。 */
export async function getJettonMasterMetadata(params, address) {
  const parsed = parseAddress(address);
  if (!parsed.ok) throw new Error('非法 Jetton Master：' + address);
  const url = params.network.toncenter.v3 + '/jetton/masters?address=' + encodeURIComponent(parsed.raw);
  const json = await httpJson(url, { apiKey: toncenterApiKey(params) });
  const masters = json.jetton_masters || json.masters || [];
  if (!masters.length) return null;
  const master = masters[0];
  let content = master.jetton_content || master.content || {};
  if (typeof content === 'string') {
    try { content = JSON.parse(content); } catch { content = {}; }
  }
  return {
    name: content.name !== undefined ? String(content.name) : null,
    symbol: content.symbol !== undefined ? String(content.symbol) : null,
    decimals: content.decimals !== undefined ? Number(content.decimals) : null,
    raw: master,
  };
}

export function validateTestnetAddress(input, label = 'address') {
  const parsed = parseAddress(input);
  if (!parsed.ok) return { ok: false, message: label + ' 非法：' + parsed.reason };
  if (parsed.testnet === false) return { ok: false, message: label + ' 是主网地址（testnet flag 缺失）：' + input };
  return { ok: true, parsed };
}

// ---------------------------------------------------------------------------
// v10 RoundController 只读辅助（contracts/README §4.3 / §4.4）
// ---------------------------------------------------------------------------

/** v10 状态值（数值沿用 v8.9；3/5/6/7 不再出现）。 */
export const ROUND_STATUS = { 0: 'UNOPENED', 1: 'PREVIEW', 2: 'STAKING_OPEN', 4: 'OBSERVING', 8: 'SUCCEEDED', 9: 'FAILED_PERMANENT', 10: 'TECHNICAL_ABORTED' };

/** 解码 get_round(roundId) 的 RoundView 栈（types.tolk RoundView 字段顺序）。 */
export function decodeRoundView(stack) {
  const n = (index) => stackItemToBigInt(stack[index]);
  const b = (index) => { const value = n(index); return value === null ? null : value !== 0n; };
  if (!Array.isArray(stack) || stack.length < 19) return null;
  const status = Number(n(1));
  return {
    roundId: Number(n(0)),
    status,
    state: ROUND_STATUS[status] || 'UNKNOWN(' + status + ')',
    targetTier: Number(n(2)),
    targetPriceUsdE8: n(3),
    targetTwap24hUsdE8: n(4),
    rewardBudgetRaw: n(6),
    stakeOpenAt: n(7),
    stakeCloseAt: n(8),
    observationStart: n(9),
    observationEnd: n(10),
    candlesSeen: Number(n(11)),
    qualifiedCandles: Number(n(12)),
    totalAcceptedStakeRaw: n(13),
    settledAt: n(14),
    teamReleaseConfirmed: b(15),
    teamBurnConfirmed: b(16),
    rewardBurnConfirmed: b(17),
    principalBurnConfirmed: b(18),
  };
}

export async function getRoundView(params, roundController, roundId) {
  const result = await runGetMethod(params, roundController, 'get_round', [roundId]);
  return decodeRoundView(result.stack || []);
}

/** 读取任意 Jetton Wallet 的余额（get_wallet_data[0]）；未部署返回 null。 */
export async function getJettonWalletBalance(params, walletAddress) {
  try {
    const result = await runGetMethod(params, walletAddress, 'get_wallet_data');
    if (result.exit_code !== undefined && result.exit_code !== 0) return null;
    return stackItemToBigInt((result.stack || [])[0]);
  } catch {
    return null;
  }
}

/** BOC 根 cell 的数据字节（只支持读取根 cell 的前若干字节，够解 external-out 事件头）。 */
export function bocRootData(b64) {
  const buf = Buffer.from(String(b64 || ''), 'base64');
  if (buf.length < 6 || buf.readUInt32BE(0) !== 0xb5ee9c72) return null;
  const flags = buf[4];
  const hasIdx = (flags & 0x80) !== 0;
  const sizeBytes = flags & 0x07;
  const offBytes = buf[5];
  let pos = 6;
  const readN = (bytes) => { let value = 0; for (let i = 0; i < bytes; i++) value = value * 256 + buf[pos + i]; pos += bytes; return value; };
  const cells = readN(sizeBytes);
  const roots = readN(sizeBytes);
  readN(sizeBytes); // absent
  readN(offBytes); // tot_cells_size
  const rootIndex = roots > 0 ? readN(sizeBytes) : 0;
  pos += (roots - 1) * sizeBytes;
  if (hasIdx) pos += cells * offBytes;
  // 跳到 rootIndex 号 cell
  for (let index = 0; index < cells; index++) {
    const d1 = buf[pos];
    const d2 = buf[pos + 1];
    const refs = d1 & 0x07;
    const dataLen = Math.ceil(d2 / 2);
    const data = buf.subarray(pos + 2, pos + 2 + dataLen);
    if (index === rootIndex) return data;
    pos += 2 + dataLen + refs * sizeBytes;
  }
  return null;
}

const V10_EVENT_NAMES = {
  0x52540101: 'TargetPriceSet', 0x52540102: 'RoundSettled', 0x52540103: 'DepositAccepted', 0x52540104: 'TechnicalAborted',
  0x5254010b: 'StakingClosed', 0x5254010c: 'CandleSubmitted', 0x5254010e: 'Claimed', 0x5254010f: 'DepositRefunded',
  0x52540110: 'SettlementBounced', 0x52540111: 'UnexpectedBounce',
};

/** 把 external-out 消息体解成 v10 事件（只解运维告警需要的字段）。 */
export function decodeRcEvent(bodyB64, meta = {}) {
  const data = bocRootData(bodyB64);
  if (!data || data.length < 4) return null;
  const op = data.readUInt32BE(0);
  const type = V10_EVENT_NAMES[op];
  if (!type) return null;
  const event = { type, opcode: '0x' + op.toString(16), ...meta };
  if (type === 'SettlementBounced' && data.length >= 6) { event.roundId = data[4]; event.action = data[5]; }
  if (type === 'UnexpectedBounce' && data.length >= 16) { event.op = '0x' + data.readUInt32BE(4).toString(16); event.queryId = data.readBigUInt64BE(8).toString(); }
  if ((type === 'RoundSettled' || type === 'TechnicalAborted' || type === 'StakingClosed' || type === 'CandleSubmitted') && data.length >= 5) event.roundId = data[4];
  return event;
}

/** 读取 RC 最近的 external-out 事件（TON Center v3 /transactions）。 */
export async function fetchRcEvents(params, roundController, { limit = 50 } = {}) {
  const parsed = parseAddress(roundController);
  if (!parsed.ok) throw new Error('非法 RoundController：' + roundController);
  const url = params.network.toncenter.v3 + '/transactions?account=' + encodeURIComponent(parsed.raw) + '&limit=' + limit + '&sort=desc';
  const json = await httpJson(url, { apiKey: toncenterApiKey(params) });
  const events = [];
  for (const tx of json.transactions || []) {
    for (const message of tx.out_msgs || []) {
      if (message.destination) continue; // external-out 才是事件
      const body = message.message_content && message.message_content.body;
      const event = decodeRcEvent(body, { ts: Number(tx.now || 0) * 1000, txHash: tx.hash, lt: tx.lt });
      if (event) events.push(event);
    }
  }
  return events;
}
