#!/usr/bin/env node
/**
 * record-fixtures.mjs — 把链上真实响应录成离线 fixture（供 fixture-server.mjs 回放）。
 *
 * 只用 node 原生能力（零依赖）。录两类数据：
 *  1. v3 /transactions：RC / TeamVault 的全部交易（只保留索引器需要的字段，减小体积）；
 *  2. v2 /runGetMethod：get_protocol_config / get_round(1..10) / get_jetton_data / get_team_vault_state /
 *     get_round_total_stake(1..10)（对账 CLI 也需要）。
 *
 * 用法：
 *   node worker/src/indexer/tools/record-fixtures.mjs \
 *     --rc 0:... --tv 0:... --jm 0:... [--rounds 10] [--out worker/src/indexer/tools/fixtures/fasttest-v86.json]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const network = (args.network || 'testnet') === 'mainnet' ? 'mainnet' : 'testnet';
const apiBase = (network === 'mainnet' ? 'https://toncenter.com/api' : 'https://testnet.toncenter.com/api');
const outPath = args.out || 'worker/src/indexer/tools/fixtures/fasttest-v86.json';
const roundCount = Number(args.rounds || 10);
const rc = args.rc;
const tv = args.tv;
const jm = args.jm;
if (!rc || !tv || !jm) { console.error('缺少 --rc/--tv/--jm'); process.exit(2); }

let lastCallAt = 0;
const MIN_INTERVAL = process.env.TONCENTER_API_KEY ? 200 : 5000;
async function throttle() {
  const wait = MIN_INTERVAL - (Date.now() - lastCallAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}
async function httpJson(url, options = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt++) {
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
      try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
      if (response.ok && json.ok !== false) return json;
      lastError = 'HTTP ' + response.status + ' ' + JSON.stringify(json).slice(0, 160);
      if (response.status === 429) await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
      else if (response.status >= 500) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      else throw new Error(lastError);
    } catch (error) {
      lastError = String(error && error.message ? error.message : error);
    }
    await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
  }
  throw new Error('toncenter 请求失败（' + url + '）：' + lastError);
}

/** 只保留索引器会用到的字段（体积可控，回放语义不变）。 */
function projectTx(tx) {
  return {
    lt: tx.lt,
    hash: tx.hash,
    now: tx.now,
    mc_block_seqno: tx.mc_block_seqno,
    finality: tx.finality,
    aborted: tx.description ? tx.description.aborted === true : tx.aborted === true,
    in_msg: tx.in_msg
      ? {
          opcode: tx.in_msg.opcode,
          source: tx.in_msg.source,
          destination: tx.in_msg.destination,
          created_at: tx.in_msg.created_at,
          bounced: tx.in_msg.bounced,
          message_content: tx.in_msg.message_content ? { body: tx.in_msg.message_content.body } : null,
        }
      : null,
    out_msgs: (tx.out_msgs || []).map((msg) => ({
      opcode: msg.opcode,
      destination: msg.destination,
      message_content: msg.message_content ? { body: msg.message_content.body } : null,
    })),
  };
}

async function recordTransactions(address) {
  const txs = [];
  let startLt;
  let seenLt = null;
  for (let page = 0; page < 30; page++) {
    const params = new URLSearchParams({ account: address, limit: '100', sort: 'asc' });
    if (startLt) params.set('start_lt', startLt);
    const json = await httpJson(apiBase + '/v3/transactions?' + params.toString());
    const batch = json.transactions || [];
    if (!batch.length) break;
    for (const tx of batch) {
      if (seenLt !== null && BigInt(tx.lt) <= BigInt(seenLt)) continue;
      seenLt = tx.lt;
      txs.push(projectTx(tx));
    }
    const lastLt = batch[batch.length - 1].lt;
    if (lastLt === startLt || batch.length < 100) break;
    startLt = lastLt;
  }
  return txs;
}

async function recordGetter(address, method, stack = []) {
  const json = await httpJson(apiBase + '/v2/runGetMethod', { method: 'POST', body: { address, method, stack } });
  return { ok: true, result: json.result };
}

async function main() {
  const fixtures = { meta: {}, v2: {}, v3: { transactions: {} } };
  fixtures.meta = {
    network,
    recordedAt: new Date().toISOString(),
    rc, tv, jm,
    note: '由 record-fixtures.mjs 从真实链上录制；仅保留索引器字段。回放用 fixture-server.mjs。',
  };
  console.log('[1/4] 录制 RC 交易…');
  fixtures.v3.transactions[rc] = await recordTransactions(rc);
  console.log('      RC txs = ' + fixtures.v3.transactions[rc].length);
  console.log('[2/4] 录制 TeamVault 交易…');
  fixtures.v3.transactions[tv] = await recordTransactions(tv);
  console.log('      TV txs = ' + fixtures.v3.transactions[tv].length);

  const getterKeys = [];
  const put = (address, method, stack, response) => {
    const key = method + '|' + address + '|' + JSON.stringify(stack);
    fixtures.v2[key] = response;
    getterKeys.push(key);
  };
  console.log('[3/4] 录制 getter（config / current_round / success_count / jetton / teamvault）…');
  put(rc, 'get_protocol_config', [], await recordGetter(rc, 'get_protocol_config'));
  put(rc, 'get_current_round', [], await recordGetter(rc, 'get_current_round'));
  put(rc, 'get_success_count', [], await recordGetter(rc, 'get_success_count'));
  put(jm, 'get_jetton_data', [], await recordGetter(jm, 'get_jetton_data'));
  put(tv, 'get_team_vault_state', [], await recordGetter(tv, 'get_team_vault_state'));
  console.log('[4/4] 录制 getter（round 1..' + roundCount + '）…');
  for (let roundId = 1; roundId <= roundCount; roundId++) {
    const stack = [['num', '0x' + roundId.toString(16)]];
    put(rc, 'get_round', stack, await recordGetter(rc, 'get_round', stack));
    put(rc, 'get_round_total_stake', stack, await recordGetter(rc, 'get_round_total_stake', stack));
    process.stdout.write('      round ' + roundId + '\r');
  }
  fixtures.meta.getterKeys = getterKeys.length;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(fixtures));
  console.log('\n完成：' + outPath + '（getter ' + getterKeys.length + ' 条）');
}

main().catch((error) => { console.error('RECORD ERROR: ' + (error && error.stack ? error.stack : error)); process.exit(1); });
