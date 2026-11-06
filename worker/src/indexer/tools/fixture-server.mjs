#!/usr/bin/env node
/**
 * fixture-server.mjs — 离线回放服务器：把 record-fixtures.mjs 录制的真实链上响应，
 * 按 toncenter v2/v3 的路径与语义回放给 worker（用于本地 D1 端到端验收，零网络、可重复）。
 *
 * 用法：
 *   node worker/src/indexer/tools/fixture-server.mjs --fixtures worker/src/indexer/tools/fixtures/v10-synthetic.json --port 8799 [--mode ok|rate|error]
 *
 * 模式（用于断线/限流演练）：
 *   ok    ：正常回放；
 *   rate  ：所有请求返回 429（模拟公共配额打满）；
 *   error ：所有请求返回 500（模拟 toncenter 故障）。
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

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
const fixturesPath = args.fixtures || 'worker/src/indexer/tools/fixtures/v10-synthetic.json';
const port = Number(args.port || 8799);
const mode = String(args.mode || 'ok');
const fixtures = JSON.parse(readFileSync(fixturesPath, 'utf8'));

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
    });
  });
}

const stats = { v2: 0, v3: 0, miss: 0 };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:' + port);
  if (mode === 'rate') return json(res, 429, { ok: false, code: 429, result: 'Ratelimit exceed' });
  if (mode === 'error') return json(res, 500, { ok: false, error: 'fixture upstream failure' });

  if (url.pathname === '/__stats') return json(res, 200, stats);
  if (url.pathname === '/__meta') return json(res, 200, fixtures.meta);

  // v2 runGetMethod
  if (url.pathname === '/v2/runGetMethod' && req.method === 'POST') {
    stats.v2++;
    const body = await readBody(req);
    const key = body.method + '|' + body.address + '|' + JSON.stringify(body.stack || []);
    const response = fixtures.v2[key];
    if (!response) {
      stats.miss++;
      return json(res, 200, { ok: false, code: 404, error: 'fixture 未录制该 getter：' + key });
    }
    return json(res, 200, response);
  }

  // v3 transactions
  if (url.pathname === '/v3/transactions') {
    stats.v3++;
    const account = url.searchParams.get('account');
    const startLt = url.searchParams.get('start_lt');
    const limit = Math.min(Number(url.searchParams.get('limit') || '100'), 100);
    const sort = url.searchParams.get('sort') || 'asc';
    const all = fixtures.v3.transactions[account];
    if (!all) {
      stats.miss++;
      return json(res, 404, { error: 'fixture 未录制该账户交易：' + account });
    }
    let list = all.filter((tx) => !startLt || BigInt(tx.lt) >= BigInt(startLt));
    list = list.sort((a, b) => (BigInt(a.lt) < BigInt(b.lt) ? -1 : 1));
    if (sort === 'desc') list.reverse();
    return json(res, 200, { transactions: list.slice(0, limit) });
  }

  return json(res, 404, { error: 'fixture server: 未实现的路径 ' + url.pathname });
});

server.listen(port, '127.0.0.1', () => {
  console.log('[fixture-server] listening on http://127.0.0.1:' + port + ' mode=' + mode + ' fixtures=' + fixturesPath);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
