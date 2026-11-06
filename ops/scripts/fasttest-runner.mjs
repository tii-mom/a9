#!/usr/bin/env node
/** fasttest-runner.mjs — v11 快测 10 轮编排：逐轮质押（含低于 1,000 A9 的退款探针）+ TicketClaim（攻城令领取），记录每轮证据。
 * 用法：OPS_PARAMS=ops/config/testnet-fast.params.json OPS_EXECUTE=1 node ops/scripts/fasttest-runner.mjs --rc <fastRc> --start 2 --end 10
 * 注：v11 没有 Claim / ClaimAll；每人每城一张攻城令，领取 = TicketClaim 发到 RC.get_ticket_address(owner, round)。
 * 不覆盖：TicketRestake（一键续战）与军饷分发（需单独演练）。
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { flag, parseArgs, str } from './lib/cli.mjs';
import { BAM_ROOT, RECORDS_DIR, loadParams, networkName, resolvePath } from './lib/config.mjs';
import { runGetMethod, stackItemToBigInt } from './lib/ton.mjs';

const args = parseArgs(process.argv.slice(2));
const params = loadParams();
const rc = str(args, 'rc') || process.env.A9_FAST_RC;
const startRound = Number(str(args, 'start') || 2);
const endRound = Number(str(args, 'end') || 10);
const execute = process.env.OPS_EXECUTE === '1';
const users = {
  A: { wallet: 'a9-test-a', address: 'kQB7JWfG8HAfV9ap6fasi6uzylEFcSzTYkFUvgFSlNUFIpnm' },
  B: { wallet: 'a9-test-b', address: 'kQBL8tlXBXfvBwN_qobNXdM4tpMBpcomOtHre_JsmeXA7ExM' },
  C: { wallet: 'a9-test-c', address: 'kQAhuPFUdpAniiSwgfYalPCi7n6SfL1zcHQMnK5pmpNCXYpH' },
};
const master = str(args, 'master') || process.env.A9_FAST_MASTER || 'kQCOYBSzkm5SEpv0g4Wg7NkCuiQGs47HlKPOzzXvff52kX65';
const script = resolvePath('ops/scripts/tolk/user_op.tolk');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);
if (!existsSync(RECORDS_DIR)) mkdirSync(RECORDS_DIR, { recursive: true });
const logFile = RECORDS_DIR + '/fasttest-runner-' + new Date().toISOString().replace(/[:.]/g, '-') + '.jsonl';
function log(event) { const r = { at: new Date().toISOString(), ...event }; appendFileSync(logFile, JSON.stringify(r) + '\n'); console.log(JSON.stringify(r)); }

async function readRound(id) {
  const r = await runGetMethod(params, rc, 'get_round', [id]); const s = r.stack; const n = (i) => stackItemToBigInt(s[i]);
  return { id, status: Number(n(1)), target: n(3), stakeOpenAt: Number(n(7)), stakeCloseAt: Number(n(8)), obsStart: Number(n(9)), candles: Number(n(11)), qualified: Number(n(12)), totalStake: n(13) };
}
async function currentRound() { const r = await runGetMethod(params, rc, 'get_current_round'); return Number(stackItemToBigInt(r.stack[0])); }
const metrics = { requests: 0, retries429: 0, infraFailures: 0, contractFailures: 0, balanceFailures: 0 };
function classify(text) {
  if (/429|Too Many Requests|HTTP 5\d\d|status 5\d\d|timeout|Failed to send message/i.test(text)) return 'INFRA';
  if (/insufficient|余额不足|not enough/i.test(text)) return 'BALANCE';
  return 'CONTRACT';
}
async function runUser(key, cmd, a = 0, b = 0, c = 0, addr) {
  const command = 'cd ' + params.toolchain.contractsDir + ' && export PATH=$HOME/.acton/bin:$PATH && OPS_EXECUTE=1 OPS_CONFIRM=YES A9_SIGNER_WALLET=' + users[key].wallet + ' ROUND_CONTROLLER_ADDRESS=' + rc + ' JETTON_MASTER_ADDRESS=' + master + ' acton script --manifest-path Acton.toml --net ' + networkName() + ' ' + script + ' ' + cmd + ' ' + a + ' ' + b + ' ' + c + ' ' + (addr || users[key].address);
  if (!execute) { log({ dryRun: true, key, cmd, command }); return { ok: true, stdout: '' }; }
  const delays = [1000, 2000, 4000, 8000, 16000];
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = spawnSync('bash', ['-lc', command], { encoding: 'utf8', timeout: 180000 });
    const text = String(result.stdout || '') + String(result.stderr || '');
    metrics.requests += 1;
    const ok = result.status === 0;
    if (ok) { log({ key, cmd, ok: true, exit: 0, metrics: { ...metrics } }); return { ok, stdout: result.stdout || '', text }; }
    const cause = classify(text);
    if (cause === 'INFRA') {
      metrics.retries429 += 1;
      log({ event: 'retry', key, cmd, attempt: attempt + 1, waitMs: delays[attempt], cause, reason: text.slice(-180) });
      await sleep(delays[attempt]);
      continue;
    }
    if (cause === 'BALANCE') metrics.balanceFailures += 1; else metrics.contractFailures += 1;
    log({ key, cmd, ok: false, exit: result.status, cause, tail: text.slice(-300), metrics: { ...metrics } });
    return { ok: false, cause, stdout: result.stdout || '', text };
  }
  metrics.infraFailures += 1;
  log({ key, cmd, ok: false, cause: 'INFRA', reason: 'retry exhausted', metrics: { ...metrics } });
  return { ok: false, cause: 'INFRA', stdout: '', text: 'retry exhausted' };
}
const A9 = 1000000000n;
const MIN_STAKE = BigInt(params.stakeLimits.minStakeRaw);
// R4 的 A 故意质押 500 A9（低于 1,000 A9 最低额）：forward 0.12 TON → 合约即时退回，链上攻城令不生成（仓位应为 0）
function stakeAmount(key, roundId) { return (roundId === 4 && key === 'A' ? 500n : 100000n) * A9; }
function expectedPosition(amount) { return amount >= MIN_STAKE ? amount : 0n; }
async function walletA9(address) {
  try { const r = await runGetMethod(params, address, 'get_wallet_data'); return stackItemToBigInt(r.stack[0]); } catch { return 0n; }
}
async function queryUser(cmd, owner, roundId) {
  const qs = resolvePath('ops/scripts/tolk/query_user.tolk');
  const command = 'cd ' + params.toolchain.contractsDir + ' && export PATH=$HOME/.acton/bin:$PATH && ROUND_CONTROLLER_ADDRESS=' + rc + ' acton script --manifest-path Acton.toml --net ' + networkName() + ' ' + qs + ' ' + cmd + ' ' + owner + ' ' + roundId;
  const r = spawnSync('bash', ['-lc', command], { encoding: 'utf8', timeout: 120000 });
  return String(r.stdout || '') + String(r.stderr || '');
}
async function userWalletAddress(owner) {
  // derive via Acton query script for reliability
  const s = resolvePath('ops/scripts/tolk/query_one_wallet.tolk');
  const command = 'cd ' + params.toolchain.contractsDir + ' && export PATH=$HOME/.acton/bin:$PATH && acton script --manifest-path Acton.toml --net ' + networkName() + ' ' + s + ' ' + master + ' ' + owner;
  const r = spawnSync('bash', ['-lc', command], { encoding: 'utf8', timeout: 60000 });
  const m = String(r.stdout || '').match(/JETTON_WALLET=(\S+)/); return m ? m[1] : null;
}

const staked = new Set();
const claimed = new Set();
const started = Date.now();
while (Date.now() - started < 80 * 60 * 1000) {
  const cur = await currentRound();
  if (cur < startRound) { await sleep(2000); continue; }
  if (cur > endRound) break;
  const rd = await readRound(cur);
  if (rd.status === 2 && !staked.has(cur)) {
    staked.add(cur);
    log({ event: 'stake-start', roundId: cur, target: rd.target?.toString(), stakeCloseAt: rd.stakeCloseAt });
    for (const key of ['A', 'B', 'C']) {
      const amount = stakeAmount(key, cur);
      const wallet = await userWalletAddress(users[key].address);
      const before = wallet ? await walletA9(wallet) : 0n;
      if (before < amount) { log({ event: 'stake-insufficient', roundId: cur, key, wallet, before: before.toString(), need: amount.toString() }); continue; }
      const preRb = await queryUser('stake', users[key].address, cur);
      const preAmt = BigInt((preRb.match(/amount=(\d+)/) || [])[1] || '0');
      if (preAmt > 0n) {
        log({ event: 'stake-already-present', roundId: cur, key, amount: preAmt.toString() });
        continue;
      }
      let confirmed = false;
      let actual = 0n;
      for (let attempt = 0; attempt < 5; attempt++) {
        await runUser(key, 'stake', Number(amount), cur, cur * 1000 + ({ A: 1, B: 2, C: 3 })[key]);
        await sleep(2000);
        const readback = await queryUser('stake', users[key].address, cur);
        const m = readback.match(/amount=(\d+)/);
        actual = m ? BigInt(m[1]) : 0n;
        const expected = expectedPosition(amount);
        log({ event: 'stake-readback', roundId: cur, key, expected: expected.toString(), actual: actual.toString(), pass: actual === expected, attempt: attempt + 1 });
        if (actual === expected) { confirmed = true; break; }
        await sleep([2000, 4000, 8000, 8000][attempt]);
      }
      if (!confirmed) { log({ event: 'stake-readback-fail', roundId: cur, key, expected: expectedPosition(amount).toString(), actual: actual.toString() }); process.exit(3); }
      if (amount < MIN_STAKE && wallet) {
        await sleep(4000);
        const after = await walletA9(wallet);
        log({ event: 'below-min-refund', roundId: cur, key, before: before.toString(), after: after.toString(), refunded: after === before });
      }
    }
  }
  if ([8, 9, 10].includes(rd.status) && !claimed.has(cur)) {
    claimed.add(cur);
    log({ event: 'round-terminal', roundId: cur, status: rd.status, qualified: rd.qualified, candles: rd.candles, totalStake: rd.totalStake?.toString() });
    if (rd.status === 8 || rd.status === 10) {
      // v11：TicketClaim 发到本人本城攻城令：成功轮 = 20% 立即奖励 + 本金（破城当轮）；技术终止轮 = 退本金。
      // 每个质押人都领一次（没有攻城令的地址会在 user_op 里失败，记录即可）。
      for (const key of ['A', 'B', 'C']) await runUser(key, 'claim', cur, 0, 0);
    }
    for (const key of ['A', 'B', 'C']) {
      const rb = await queryUser('stake', users[key].address, cur);
      const cl = await queryUser('claimable', users[key].address, cur);
      log({ event: 'claim-readback', roundId: cur, key, raw: rb.slice(-160), claimable: cl.slice(-120) });
    }
  }
  await sleep(2000);
}
log({ event: 'runner-done', roundsSeen: [...claimed].length });
