#!/usr/bin/env node
/** keeper-candles.mjs — v11 keeper 循环：OpenRound → （到期）CloseStaking → 24 根 SubmitCandle（第 24 根即判定）
 * → 失败轮的销毁动作未确认（连续 3 次视图仍未确认，视为被退回）时自动 RetrySettlement → 预告结束后开下一轮。
 * 破城轮的团队额度退回不由本脚本重试（RoundView 无法区分「未发出」与「被退回」）：由 SettlementBounced 事件 → monitor 告警 → 80 --action retry-settlement。
 * 时序（candleSeconds / candleCount）从 get_protocol_config 读取，快测档自动适配。
 *
 * 用法：
 *   OPS_EXECUTE=1 node ops/scripts/keeper-candles.mjs --rc <RC> --signer a9-keeper --rounds 1 --mode success
 *   --mode success|failure|mixed；mixed 默认模式 S,F,S,S,S,F,S,S,F,S
 *   --dry-run（不带 OPS_EXECUTE）只打印动作不广播
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { flag, parseArgs, str } from './lib/cli.mjs';
import { RECORDS_DIR, asBigInt, loadParams, networkName, resolvePath } from './lib/config.mjs';
import { decodeRoundView, runGetMethod, stackItemToBigInt } from './lib/ton.mjs';
import { pendingSettlementActions } from './lib/ledger.mjs';

const args = parseArgs(process.argv.slice(2));
const params = loadParams();
const rc = str(args, 'rc') || process.env.A9_FAST_RC;
const signer = str(args, 'signer') || process.env.A9_KEEPER_WALLET || 'a9-keeper';
const rounds = Number(str(args, 'rounds') || 1);
const mode = str(args, 'mode') || 'mixed';
const execute = process.env.OPS_EXECUTE === '1' && !flag(args, 'dry-run');
const openTwap = str(args, 'twap') || '116000';
const closeDelayRound = Number(str(args, 'close-delay-round') || 0);
const closeDelayMs = Number(str(args, 'close-delay-ms') || 0);
const settleWaitMs = Number(str(args, 'settle-wait') || 0);
let closeDelayUsed = false;
const patternArg = str(args, 'modes');
const pattern = patternArg ? patternArg.split(',').map((x) => x.trim().toUpperCase()) : ['S','F','S','S','S','F','S','S','F','S'];
if (!rc) { console.error('缺少 --rc <fastRC>'); process.exit(2); }

const STATUS = { 0:'UNOPENED',1:'PREVIEW',2:'STAKING_OPEN',4:'OBSERVING',8:'SUCCEEDED',9:'FAILED_PERMANENT',10:'TECHNICAL_ABORTED' };
const TERMINAL = new Set([8,9,10]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let candleSeconds = 10n;
let candleCount = 24n;
const nowSec = () => Math.floor(Date.now() / 1000);
if (!existsSync(RECORDS_DIR)) mkdirSync(RECORDS_DIR, { recursive: true });
const logFile = RECORDS_DIR + '/keeper-candles-' + new Date().toISOString().replace(/[:.]/g,'-') + '.jsonl';
const metrics = { requests: 0, retries429: 0, failures: 0 };
const log = (event) => {
  const record = { at: new Date().toISOString(), ...event };
  appendFileSync(logFile, JSON.stringify(record) + '\n');
  console.log(JSON.stringify(record));
};

async function round(roundId) {
  const r = await runGetMethod(params, rc, 'get_round', [roundId]);
  const s = r.stack || [];
  const n = (i) => stackItemToBigInt(s[i]);
  return {
    roundId: Number(n(0)), status: Number(n(1)), tier: Number(n(2)),
    target: n(3), twap: n(4), writtenAt: Number(n(5)), rewardBudget: n(6),
    stakeOpenAt: Number(n(7)), stakeCloseAt: Number(n(8)),
    obsStart: Number(n(9)), obsEnd: Number(n(10)),
    candlesSeen: Number(n(11)), qualified: Number(n(12)),
    view: decodeRoundView(s),
  };
}
async function readTiming() {
  const r = await runGetMethod(params, rc, 'get_protocol_config');
  const stack = r.stack || [];
  const seconds = stackItemToBigInt(stack[14]);
  const count = stackItemToBigInt(stack[15]);
  if (seconds === null || seconds <= 0n || count === null || count <= 0n) {
    throw new Error('无法从 get_protocol_config 读取 candleSeconds/candleCount');
  }
  return { seconds, count };
}
async function currentRound() { const r = await runGetMethod(params, rc, 'get_current_round'); return Number(stackItemToBigInt(r.stack[0])); }

async function execWithRetry(base, label, env) {
  const delays = [1000, 2000, 4000, 8000, 16000];
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = spawnSync('bash', ['-lc', base], { encoding: 'utf8', timeout: 180000, env: env || process.env });
    const ok = result.status === 0;
    metrics.requests += 1;
    if (ok) return { ok, result };
    const text = String(result.stderr || result.stdout);
    const timeout = result.status === null || /Awaiting trace/i.test(text);
    if (!timeout && !/429|Too Many Requests|HTTP 5\d\d|status 5\d\d/i.test(text)) return { ok, result };
    metrics.retries429 += 1;
    log({ event: 'retry', action: label, attempt: attempt + 1, waitMs: delays[attempt], reason: text.slice(0, 160) });
    await sleep(delays[attempt]);
  }
  metrics.failures += 1;
  return { ok: false, result: { status: 1, stdout: '', stderr: 'retry exhausted' } };
}

async function runAdmin(op, extraArgs = [], envExtra = {}, label) {
  const script = resolvePath('ops/scripts/tolk/fast_admin.tolk');
  const base = 'cd ' + params.toolchain.contractsDir + ' && export PATH=$HOME/.acton/bin:$PATH && OPS_EXECUTE=1 OPS_CONFIRM=YES A9_SIGNER_WALLET=' + signer + ' ROUND_CONTROLLER_ADDRESS=' + rc + ' acton script --manifest-path Acton.toml --net ' + networkName() + ' ' + script + ' ' + op + ' ' + extraArgs.join(' ');
  if (!execute) { log({ action: label, dryRun: true, command: base }); return true; }
  const { ok, result } = await execWithRetry(base, label, { ...process.env, ...envExtra });
  const tx = String(result.stdout || '').split(String.fromCharCode(10)).filter((l) => l.includes('tx[')).join(' | ');
  log({ action: label, ok, exit: result.status, tx, stderr: ok ? undefined : String(result.stderr || result.stdout).slice(0, 400) });
  if (!ok) throw new Error(label + ' 失败: ' + String(result.stderr || result.stdout).slice(0, 500));
  return true;
}

function digestFor(roundId, index, twap) { return createHash('sha256').update(roundId + ':' + index + ':' + twap).digest('hex'); }

async function runCandle(roundId, index, periodStart, periodEnd, twap) {
  const script = resolvePath('ops/scripts/tolk/fast_candle.tolk');
  const base = 'cd ' + params.toolchain.contractsDir + ' && export PATH=$HOME/.acton/bin:$PATH && OPS_EXECUTE=1 OPS_CONFIRM=YES A9_SIGNER_WALLET=' + signer + ' ROUND_CONTROLLER_ADDRESS=' + rc + ' A9_PERIOD_START=' + periodStart + ' A9_PERIOD_END=' + periodEnd + ' A9_TWAP_E8=' + twap + ' acton script --manifest-path Acton.toml --net ' + networkName() + ' ' + script + ' ' + roundId + ' ' + index;
  if (!execute) { log({ action: 'candle', dryRun: true, command: base }); return; }
  // Do not throw on broadcast failure: wallet-level rejections (seqno race /
  // external not accepted) are retryable infra errors, not contract errors.
  let ok = false;
  let result = { status: 1, stdout: '', stderr: '' };
  try {
    const r = await execWithRetry(base, 'candle r' + roundId + ' #' + index, process.env);
    ok = r.ok;
    result = r.result;
  } catch (error) {
    result = { status: 1, stdout: '', stderr: String((error && error.message) || error) };
  }
  const tx = String(result.stdout || '').split(String.fromCharCode(10)).filter((l) => l.includes('tx[')).join(' | ');
  log({ action: 'candle r' + roundId + ' #' + index + ' twap=' + twap, ok, exit: result.status, tx, stderr: ok ? undefined : String(result.stderr || result.stdout).slice(0, 400) });
  return ok;
}

function modeFor(roundId) {
  if (mode === 'success') return 'S';
  if (mode === 'failure') return 'F';
  return pattern[(roundId - 1) % pattern.length] || 'S';
}

async function ensureOpen(roundId) {
  // OpenRound 不带 roundId：合约自动开「当前已判定轮的下一轮」（R1 时 currentRound = 0）
  await runAdmin('open-round', ['0', openTwap], {}, 'open-round(' + roundId + ')');
  await sleep(1500);
}

/**
 * 已判定轮的销毁动作未确认时调用 RetrySettlement；返回是否仍待确认。
 * 去抖：结算交易刚发出时视图尚未确认，连续 3 次仍未确认才视为被退回（RC 对 retryMask=0 会报 NothingToRetry）。
 */
const pendingStreak = new Map();
async function retrySettlementIfNeeded(roundId) {
  const rd = await round(roundId);
  const pending = pendingSettlementActions(rd.view);
  if (!pending || pending.length === 0) { pendingStreak.delete(roundId); return false; }
  const streak = (pendingStreak.get(roundId) || 0) + 1;
  pendingStreak.set(roundId, streak);
  if (streak < 3) {
    log({ event: 'settlement-unconfirmed', roundId, pending, streak });
    return true;
  }
  pendingStreak.set(roundId, 0);
  log({ event: 'settlement-pending', roundId, pending });
  try { await runAdmin('retry-settlement', [String(roundId), '0'], {}, 'retry-settlement(' + roundId + ')'); }
  catch (error) { log({ event: 'retry-settlement-failed', roundId, error: String(error.message).slice(0, 200) }); }
  return true;
}

function candleTwap(modeChar, target) {
  if (modeChar === 'S') return target; // >= target
  const fail = target > 2n ? target / 2n : 1n;
  return fail;
}

async function submitCandles(roundId) {
  let rd = await round(roundId);
  const modeChar = modeFor(roundId);
  while (BigInt(rd.candlesSeen) < candleCount) {
    const index = rd.candlesSeen;
    const periodStart = rd.obsStart + index * Number(candleSeconds);
    const periodEnd = periodStart + Number(candleSeconds);
    while (nowSec() < periodEnd) await sleep(500);
    const rdNow = await round(roundId);
    if (TERMINAL.has(rdNow.status)) break;
    const twap = candleTwap(modeChar, rdNow.target);
    let landed = false;
    const waits = [3000, 5000, 8000, 12000, 15000, 15000, 15000, 15000, 15000, 15000];
    for (let attempt = 0; attempt < 10; attempt++) {
      const sent = await runCandle(roundId, index, periodStart, periodEnd, twap.toString());
      // A wallet-level rejection (seqno race) means the previous external is
      // still in flight: wait longer before resending the same candle.
      await sleep(sent ? 2500 : 10000);
      rd = await round(roundId);
      if (rd.candlesSeen > index) { landed = true; break; }
      if (rd.candlesSeen < index) {
        log({ event: 'candle-reset-detected', roundId, index, candlesSeen: rd.candlesSeen });
        break;
      }
      log({ event: 'candle-resend', roundId, index, attempt: attempt + 1, sent, candlesSeen: rd.candlesSeen });
      await sleep(waits[attempt] || 8000);
    }
    if (!landed && rd.candlesSeen < index) continue;
    if (!landed) {
      throw new Error('candle #' + index + ' 连续 5 次未落地（当前 candlesSeen=' + rd.candlesSeen + '）');
    }
  }
  log({ event: 'candles-done', roundId, candlesSeen: rd.candlesSeen, qualified: rd.qualified, status: STATUS[rd.status] });
}

async function main() {
  const timing = await readTiming();
  candleSeconds = timing.seconds;
  candleCount = timing.count;
  log({ event: 'keeper-start', rc, signer, mode, rounds, execute, logFile, candleSeconds: candleSeconds.toString(), candleCount: candleCount.toString(), apiKeySet: Boolean(process.env[params.network.toncenter.apiKeyEnv]), metrics });
  let settled = 0;
  let openedR1 = false;
  let lastCountedRound = 0;
  while (settled < rounds) {
    let cur = await currentRound();
    if (cur === 0) {
      if (!openedR1) { await ensureOpen(1); openedR1 = true; }
      await sleep(1000);
      continue;
    }
    let rd = await round(cur);
    if (rd.status === 1) { // PREVIEW next round
      while (nowSec() < rd.stakeOpenAt) await sleep(1000);
      await ensureOpen(cur + 1);
      continue;
    }
    if (rd.status === 2) { // STAKING_OPEN
      if (nowSec() >= rd.stakeCloseAt) {
        if (cur === closeDelayRound && !closeDelayUsed && closeDelayMs > 0) {
          closeDelayUsed = true;
          log({ event: 'close-delay', roundId: cur, delayMs: closeDelayMs });
          await sleep(closeDelayMs);
        }
        await runAdmin('close-staking', ['0', '0'], {}, 'close(' + cur + ')');
      } else await sleep(1500);
      continue;
    }
    if (rd.status === 4) { // observing（第 24 根 K 线提交即判定）
      if (rd.obsStart === 0) { await sleep(1000); continue; }
      await submitCandles(cur);
      continue;
    }
    if (TERMINAL.has(rd.status)) {
      if (await retrySettlementIfNeeded(cur)) { await sleep(5000); continue; }
      if (cur !== lastCountedRound) {
        lastCountedRound = cur;
        log({ event: 'round-terminal', roundId: cur, status: STATUS[rd.status], qualified: rd.qualified, candlesSeen: rd.candlesSeen, metrics: { ...metrics } });
        settled += 1;
        if (settled >= rounds) break;
        if (settleWaitMs > 0) await sleep(settleWaitMs);
      }
      if (cur < 10) {
        const next = await round(cur + 1);
        if (next.status === 1) {
          while (nowSec() < next.stakeOpenAt) await sleep(1000);
          await ensureOpen(cur + 1);
        }
      }
      await sleep(1000);
      continue;
    }
    await sleep(1500);
  }
  log({ event: 'keeper-done', settled });
}
await main();
