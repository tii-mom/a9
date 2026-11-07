#!/usr/bin/env node
/**
 * internal_sale.mjs — 内盘（GRAM 预售）到账核对 + A9 发放。
 *
 * 流程：买家把 GRAM 转到内盘收款钱包（附言 = 收 A9 的地址；不写附言则发回付款地址）
 *       → 本脚本扫描到账、按比例算应发 A9 → 预览 → 确认后从内盘钱包逐笔发 A9。
 *
 *   node ops/scripts/internal_sale.mjs --wallet <内盘收款地址> [--since <unix>] [--min-gram 1] [--rate 1000]
 *   OPS_EXECUTE=1 OPS_CONFIRM=YES node ops/scripts/internal_sale.mjs ... --signer a9-internal   # 真发
 *
 * 安全：
 *  - 默认只预览，不发币；
 *  - 已发放的付款（按付款交易 hash）记入账本，绝不重复发；
 *  - 累计发放（账本 + 本次）超过 --cap（默认 8 亿 A9 硬上限）则整批拒绝；
 *  - 账本：ops/records/internal-sale-<network>-<wallet>.json；每笔附付款 / 发放证据。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseArgs, str } from './lib/cli.mjs';
import { BAM_ROOT, RECORDS_DIR, loadParams, networkName } from './lib/config.mjs';
import { parseAddress, formatAddress, findJettonWallet } from './lib/ton.mjs';

const args = parseArgs(process.argv.slice(2));
const params = loadParams();
const net = networkName();
const wallet = str(args, 'wallet') || process.env.A9_INTERNAL_WALLET;
if (!wallet || !parseAddress(wallet).ok) { console.error('缺少或非法 --wallet <内盘收款地址>'); process.exit(2); }
const since = Number(str(args, 'since', '0'));
const minNano = BigInt(Math.round(Number(str(args, 'min-gram', '1')) * 1e9));
const rate = BigInt(str(args, 'rate', '1000'));                 // 1 GRAM = rate A9（部署前确认）
const capRaw = BigInt(str(args, 'cap', '800000000')) * 10n ** 9n; // 8 亿 A9 硬上限
const signer = str(args, 'signer', 'a9-internal');
const execute = process.env.OPS_EXECUTE === '1';
const master = str(args, 'master') || readFileSync(new URL('../../contracts/deploy/jetton-master.addr', import.meta.url), 'utf8').trim().split(/\s+/)[0];
const testOnly = net !== 'mainnet';

const walletRaw = parseAddress(wallet).raw;
if (!existsSync(RECORDS_DIR)) mkdirSync(RECORDS_DIR, { recursive: true });
const ledgerFile = `${RECORDS_DIR}/internal-sale-${net}-${walletRaw.replace(':', '_')}.json`;
const ledger = existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, 'utf8')) : { wallet, master, rate: String(rate), sent: {} };
const save = () => writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));
const friendly = (raw) => { const p = parseAddress(raw); return p.ok ? formatAddress(p.workchain, p.hashHex, { bounceable: false, testnet: testOnly }) : raw; };
const fmtA9 = (raw) => (Number(raw / 10n ** 6n) / 1000).toLocaleString('en-US');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function v3(path) {
  const headers = {};
  const key = process.env[params.network.toncenter.apiKeyEnv];
  if (key) headers['X-API-Key'] = key;
  for (let i = 0; i < 5; i++) {
    const res = await fetch(params.network.toncenter.v3 + path, { headers });
    if (res.ok) return res.json();
    await sleep(1500 * (i + 1));
  }
  throw new Error('toncenter v3 失败：' + path);
}

/** 内盘钱包收到的 GRAM 付款（成功、外部钱包转入、金额 ≥ min）。 */
async function incomingPayments() {
  const out = [];
  for (let offset = 0; ; offset += 100) {
    const j = await v3(`/transactions?account=${encodeURIComponent(walletRaw)}&limit=100&offset=${offset}&sort=asc&start_utime=${since}`);
    const txs = j.transactions || [];
    for (const t of txs) {
      const m = t.in_msg;
      if (!m || !m.source || t.description?.aborted) continue;
      const value = BigInt(m.value || '0');
      if (value < minNano) continue;
      const comment = (m.message_content?.decoded?.comment || '').trim();
      const target = comment && parseAddress(comment).ok ? parseAddress(comment).raw : m.source;
      out.push({ txHash: t.hash, utime: t.now, payer: m.source, gramNano: value, comment, recipient: target });
    }
    if (txs.length < 100) break;
  }
  return out;
}

function sendA9(recipient, amountRaw) {
  const cmd = `cd ${BAM_ROOT}/${params.toolchain.contractsDir} && export PATH=$HOME/.acton/bin:$PATH && OPS_EXECUTE=1 OPS_CONFIRM=YES A9_SIGNER_WALLET=${signer} JETTON_MASTER_ADDRESS=${master} acton script --manifest-path Acton.toml --net ${net} scripts/deploy/fund_jetton.tolk ${friendly(recipient)} ${amountRaw}`;
  const r = spawnSync('bash', ['-lc', cmd], { encoding: 'utf8', timeout: 180000 });
  return { ok: r.status === 0, tail: (String(r.stdout || '') + String(r.stderr || '')).slice(-400) };
}

const payments = await incomingPayments();
const pending = payments.filter((p) => !ledger.sent[p.txHash]);
const sentTotal = Object.values(ledger.sent).reduce((s, x) => s + BigInt(x.a9Raw), 0n);
const batch = pending.map((p) => ({ ...p, a9Raw: p.gramNano * rate }));   // GRAM 9 位小数 × rate = A9 raw（同为 9 位）
const batchTotal = batch.reduce((s, p) => s + p.a9Raw, 0n);

console.log(`内盘钱包 ${friendly(walletRaw)}（${net}） 比例 1 GRAM = ${rate} A9  上限 ${fmtA9(capRaw)} A9`);
console.log(`到账付款 ${payments.length} 笔；已发 ${payments.length - pending.length} 笔（累计 ${fmtA9(sentTotal)} A9）；待发 ${batch.length} 笔`);
for (const p of batch) {
  console.log(`  ${new Date(p.utime * 1000).toISOString()}  付款 ${friendly(p.payer)}  ${Number(p.gramNano) / 1e9} GRAM  → 发 ${fmtA9(p.a9Raw)} A9 给 ${friendly(p.recipient)}${p.comment ? `（附言 ${p.comment.slice(0, 24)}）` : ''}  tx ${p.txHash}`);
}
if (sentTotal + batchTotal > capRaw) {
  console.error(`拒绝：累计 ${fmtA9(sentTotal + batchTotal)} A9 将超过内盘上限 ${fmtA9(capRaw)} A9。`);
  process.exit(3);
}
if (!batch.length) { console.log('没有待发放的付款。'); process.exit(0); }
if (!execute || process.env.OPS_CONFIRM !== 'YES') { console.log('预览模式：核对无误后加 OPS_EXECUTE=1 OPS_CONFIRM=YES 真发。'); process.exit(0); }

const before = await findJettonWallet(params, master, walletRaw);
if (!before || BigInt(before.balanceRaw || '0') < batchTotal) {
  console.error(`拒绝：内盘钱包 A9 余额 ${before ? fmtA9(BigInt(before.balanceRaw)) : 0} 不足本批 ${fmtA9(batchTotal)}。`);
  process.exit(4);
}
for (const p of batch) {
  // 先记"发送中"，发送失败则删掉；避免进程中断后重复发放（中断时需人工核对 status=sending 的条目）。
  ledger.sent[p.txHash] = { status: 'sending', payer: p.payer, recipient: p.recipient, gramNano: String(p.gramNano), a9Raw: String(p.a9Raw), at: new Date().toISOString() };
  save();
  const r = sendA9(p.recipient, p.a9Raw);
  if (!r.ok) { delete ledger.sent[p.txHash]; save(); console.error(`发送失败（未记账，可重跑）：${p.txHash}\n${r.tail}`); process.exit(5); }
  ledger.sent[p.txHash].status = 'sent';
  save();
  console.log(`已发 ${fmtA9(p.a9Raw)} A9 → ${friendly(p.recipient)}`);
  await sleep(8000); // 等钱包 seqno 前进再发下一笔
}
console.log(`完成；账本 ${ledgerFile}`);
