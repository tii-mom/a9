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

async function httpJson(url, options = {}) {
  const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
  if (options.apiKey) headers['X-API-Key'] = options.apiKey;
  const responses = [];
  for (let attempt = 0; attempt < 3; attempt++) {
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
    } catch (error) {
      responses.push(String(error && error.message ? error.message : error));
    }
    await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
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
  const stack = numericStack.map((value) => ({ type: 'num', value: '0x' + BigInt(String(value)).toString(16) }));
  const json = await httpJson(url, {
    method: 'POST',
    body: { address: parsed.raw, method, stack },
    apiKey: toncenterApiKey(params),
  });
  if (!json.ok) throw new Error('runGetMethod ' + method + ' 失败：' + JSON.stringify(json.error || json));
  return json.result;
}

export function stackItemToBigInt(item) {
  if (!item) return null;
  const raw = item.value !== undefined ? item.value : item;
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (text.startsWith('-0x')) return -BigInt('0x' + text.slice(3));
  if (text.startsWith('0x')) return BigInt(text);
  if (text === '') return null;
  try { return BigInt(text); } catch { return null; }
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
  if (item.type === 'null') return true;
  const value = item.value;
  if (value === null || value === undefined || value === '') return true;
  if (typeof value === 'string') {
    try {
      const bytes = Buffer.from(value, 'base64');
      return bytes.length <= 1;
    } catch {
      return false;
    }
  }
  return false;
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
