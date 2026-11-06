#!/usr/bin/env node
/**
 * 92 — SPIKE：TON Multisig v2 订单工具（测试网）。纯新增文件，不影响现有 EOA 流程。
 * 支持：status / list / order-status / propose / approve / update-signers / fund；默认 dry-run，--execute 广播。
 *
 * 用法示例：
 *   node ops/scripts/92_multisig_order.mjs status
 *   node ops/scripts/92_multisig_order.mjs propose --signer a9-test-a --expiration 3600 \
 *     --transfer kQ...,0.02 --transfer kQ...,0.02            # dry-run
 *   OPS_EXECUTE=1 OPS_CONFIRM=YES node ops/scripts/92_multisig_order.mjs approve --signer a9-test-b --seqno 0
 *   OPS_EXECUTE=1 OPS_CONFIRM=YES node ops/scripts/92_multisig_order.mjs update-signers \
 *     --signer a9-test-a --threshold 2 --signers a9-test-a,a9-test-b,a9-fast-admin2
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { flag, parseArgs, str } from './lib/cli.mjs';
import { section, kv, ok, fail, warn, info, detail, summary } from './lib/log.mjs';
import {
  BAM_ROOT, MULTISIG, SPIKE_REGISTRY, approveBody, beginCell, buildMultisigAddress, Cell,
  formatTon, getAccount, latestLt, loadMultisigCode, newOrderBody, parseAddressSafe,
  readMultisigData, readOrderAddress, readOrderData, sendFromWallet, sleep, summarizeTx,
  toNano, transferAction, updateParamsAction, waitForAccountTx, walletFromName, buildSigners,
} from '../spike-multisig/lib.mjs';

const args = parseArgs();
const command = str(args, 'cmd', str(args, '_', '') ? String(args._[0]) : 'status');
const execute = flag(args, 'execute') || process.env.OPS_EXECUTE === '1';
const confirmed = process.env.OPS_CONFIRM === 'YES';
const REHEARSAL_LOG = join(BAM_ROOT, 'ops', 'records', 'multisig-rehearsal.jsonl');

function readSpikeRegistry() {
  if (!existsSync(SPIKE_REGISTRY)) throw new Error('缺少 ' + SPIKE_REGISTRY + '：请先运行 91_deploy_multisig.mjs');
  return JSON.parse(readFileSync(SPIKE_REGISTRY, 'utf8'));
}
const registry = readSpikeRegistry();
const multisigFriendly = str(args, 'multisig', registry.address);
const multisigAddress = parseAddressSafe(multisigFriendly);
if (!multisigAddress) { fail('非法 --multisig 地址：' + multisigFriendly); process.exit(1); }

function record(step, payload) {
  mkdirSync(join(BAM_ROOT, 'ops', 'records'), { recursive: true });
  const safe = (key, value) => (typeof value === 'bigint' ? value.toString() : value);
  appendFileSync(REHEARSAL_LOG, JSON.stringify({ at: new Date().toISOString(), step, multisig: multisigFriendly, ...payload }, safe) + '\n');
}

function requireConfirm(label) {
  if (!execute) return false;
  if (!confirmed) { fail('拒绝执行「' + label + '」：需要 OPS_EXECUTE=1 且 OPS_CONFIRM=YES'); process.exit(1); }
  return true;
}

async function findSignerIndex(address) {
  const data = await readMultisigData(multisigAddress);
  const index = data.signers.findIndex((item) => item.equals(address));
  return { index, data };
}

async function collectFees(addresses, sinceMs) {
  const results = [];
  for (const address of addresses) {
    if (!address) continue;
    const friendly = typeof address === 'string' ? address : address.toString({ testOnly: true, bounceable: true });
    try {
      const json = await (await import('../spike-multisig/lib.mjs')).httpJson(
        'https://testnet.toncenter.com/api/v2/getTransactions?address=' + encodeURIComponent(friendly) + '&limit=3'
      );
      if (json.ok && Array.isArray(json.result)) {
        for (const tx of json.result) {
          if (tx.utime * 1000 >= sinceMs) results.push({ account: friendly, ...summarizeTx(tx) });
        }
      }
    } catch { /* 非关键 */ }
  }
  return results;
}

/* ----------------------------- status ----------------------------- */
if (command === 'status') {
  section('[92] 多签状态');
  const data = await readMultisigData(multisigAddress);
  const account = await getAccount(multisigFriendly);
  kv('多签地址', multisigFriendly);
  kv('余额', formatTon(account.balance));
  kv('阈值', data.threshold + ' of ' + data.signers.length);
  kv('下一个 orderSeqno', data.nextOrderSeqno.toString());
  data.signers.forEach((addr, index) => kv('signer[' + index + ']', addr.toString({ testOnly: true, bounceable: true })));
  data.proposers.forEach((addr, index) => kv('proposer[' + index + ']', addr.toString({ testOnly: true, bounceable: true })));
  process.exit(0);
}

/* ------------------------------ list ------------------------------ */
if (command === 'list') {
  section('[92] 订单列表');
  const data = await readMultisigData(multisigAddress);
  const next = Number(data.nextOrderSeqno);
  if (next === 0) info('暂无订单（nextOrderSeqno=0）');
  for (let seqno = 0; seqno < next; seqno += 1) {
    try {
      const orderAddress = await readOrderAddress(multisigAddress, seqno);
      const order = await readOrderData(orderAddress);
      kv('#' + seqno, 'executed=' + order.executed + ' approvals=' + order.approvals + '/' + order.threshold + ' expiration=' + new Date(order.expiration * 1000).toISOString() + ' ' + orderAddress.toString({ testOnly: true, bounceable: true }));
    } catch (error) {
      warn('#' + seqno + ' 读取失败：' + String(error.message || error).slice(0, 120));
    }
  }
  process.exit(0);
}

/* --------------------------- order-status -------------------------- */
if (command === 'order-status') {
  const seqno = Number(str(args, 'seqno', '-1'));
  if (seqno < 0) { fail('缺少 --seqno'); process.exit(1); }
  const orderAddress = await readOrderAddress(multisigAddress, seqno);
  const order = await readOrderData(orderAddress);
  section('[92] 订单 #' + seqno);
  kv('order 地址', orderAddress.toString({ testOnly: true, bounceable: true }));
  kv('executed', String(order.executed));
  kv('approvals', order.approvals + '/' + order.threshold);
  kv('expiration', new Date(order.expiration * 1000).toISOString());
  kv('signers', order.signers.join(', '));
  process.exit(0);
}

/* ------------------------------ fund ------------------------------ */
if (command === 'fund') {
  const fromName = str(args, 'from', '');
  const valueTon = str(args, 'value', '0.5');
  if (!fromName) { fail('缺少 --from <钱包名>'); process.exit(1); }
  section('[92] 给多签充值');
  kv('从', fromName);
  kv('到', multisigFriendly);
  kv('金额', valueTon + ' TON');
  if (!requireConfirm('fund')) { info('dry-run：未发送'); process.exit(0); }
  const wallet = await walletFromName(fromName);
  const sinceLt = await latestLt(wallet.address);
  const startedAt = Date.now();
  await sendFromWallet(wallet, { to: multisigAddress, value: toNano(valueTon), body: beginCell().storeUint(0, 32).storeUint(0, 64).endCell(), bounce: true });
  const tx = await waitForAccountTx(wallet.address, { sinceLt, timeoutMs: 90000 });
  const fees = await collectFees([wallet.address, multisigAddress], startedAt);
  kv('tx', tx && tx.transaction_id ? tx.transaction_id.hash : '—');
  ok('已向多签充值 ' + valueTon + ' TON');
  record('fund', { from: fromName, valueTon, txHash: tx && tx.transaction_id ? tx.transaction_id.hash : null, fees });
  process.exit(summary({ 结果: 'FUNDED' }) || 0);
}

/* ----------------------------- propose ----------------------------- */
if (command === 'propose') {
  const signerName = str(args, 'signer', '');
  const expirationSeconds = Number(str(args, 'expiration', '3600'));
  const transferSpecs = [];
  // --transfer "addr,ton" 可重复
  const rawArgs = process.argv.slice(2);
  for (let i = 0; i < rawArgs.length; i += 1) {
    if (rawArgs[i] === '--transfer' && rawArgs[i + 1]) transferSpecs.push(rawArgs[i + 1]);
  }
  const updateFlag = flag(args, 'update-signers');
  if (!signerName) { fail('缺少 --signer <钱包名>'); process.exit(1); }
  if (!transferSpecs.length && !updateFlag) { fail('缺少 --transfer 或 --update-signers'); process.exit(1); }

  section('[92] 发起订单');
  const signer = await walletFromName(signerName);
  const { index: signerIndex, data } = await findSignerIndex(signer.address);
  if (signerIndex < 0) { fail(signerName + ' 不在多签 signer 列表中（先 update-signers 或换人）'); process.exit(1); }
  const seqno = Number(data.nextOrderSeqno);
  const expiration = Math.floor(Date.now() / 1000) + expirationSeconds;

  const actions = [];
  for (const spec of transferSpecs) {
    const [to, ton, bodyHex] = spec.split(',');
    if (!to || !ton) { fail('--transfer 格式应为 "地址,金额TON[,bodyHex]"：' + spec); process.exit(1); }
    const body = bodyHex ? Cell.fromBoc(Buffer.from(bodyHex, 'hex'))[0] : null;
    actions.push(transferAction({ to, value: toNano(ton), body }));
    detail('transfer: ' + to + '  ' + ton + ' TON' + (bodyHex ? '  body=' + bodyHex.slice(0, 18) + '…' : ''));
  }
  if (updateFlag) {
    const newThreshold = Number(str(args, 'threshold', String(data.threshold)));
    const newSignerNames = str(args, 'signers', '').split(',').map((s) => s.trim()).filter(Boolean);
    const newSigners = [];
    for (const name of newSignerNames) {
      const parsed = parseAddressSafe(name);
      if (parsed) { newSigners.push(parsed); continue; }
      const w = await walletFromName(name);
      newSigners.push(w.address);
    }
    actions.push(updateParamsAction({ threshold: newThreshold, signers: newSigners, proposers: [] }));
    detail('update-signers: threshold=' + newThreshold + ' signers=' + newSigners.map((a) => a.toString({ testOnly: true, bounceable: true })).join(','));
  }

  const body = newOrderBody({ actions, expiration, isSigner: true, signerIndex, seqno });
  kv('多签', multisigFriendly);
  kv('发起人', signerName + ' (index ' + signerIndex + ')');
  kv('order seqno', String(seqno));
  kv('actions', String(actions.length));
  kv('过期时间', new Date(expiration * 1000).toISOString());
  kv('附带 value', str(args, 'value', '0.2') + ' TON');
  kv('运行模式', execute ? 'EXECUTE' : 'DRY-RUN');
  if (!requireConfirm('propose')) { info('dry-run：未发送。执行请加 OPS_EXECUTE=1 OPS_CONFIRM=YES --execute'); process.exit(0); }

  const startedAt = Date.now();
  const sinceLt = await latestLt(signer.address);
  const sendResult = await sendFromWallet(signer, { to: multisigAddress, value: toNano(str(args, 'value', '0.2')), body, bounce: true });
  info('external seqno=' + sendResult.seqno);
  const signerTx = await waitForAccountTx(signer.address, { sinceLt, timeoutMs: 90000 });
  await sleep(2500);
  let orderAddress = null;
  let order = null;
  try {
    orderAddress = await readOrderAddress(multisigAddress, seqno);
    order = await readOrderData(orderAddress);
  } catch (error) {
    warn('订单读取失败（可能尚未部署/索引延迟）：' + String(error.message || error).slice(0, 160));
  }
  const fees = await collectFees([signer.address, multisigAddress, orderAddress], startedAt);
  ok('订单已发起：#' + seqno + (orderAddress ? '  ' + orderAddress.toString({ testOnly: true, bounceable: true }) : ''));
  if (order) {
    kv('approvals', order.approvals + '/' + order.threshold);
    kv('executed', String(order.executed));
  }
  record('propose', { signer: signerName, seqno, actions: actions.length, expiration, txHash: signerTx && signerTx.transaction_id ? signerTx.transaction_id.hash : null, orderAddress: orderAddress ? orderAddress.toString({ testOnly: true, bounceable: true }) : null, order, fees });
  process.exit(summary({ 结果: 'PROPOSED', seqno: String(seqno) }) || 0);
}

/* ----------------------------- approve ----------------------------- */
if (command === 'approve') {
  const signerName = str(args, 'signer', '');
  const seqno = Number(str(args, 'seqno', '-1'));
  if (!signerName || seqno < 0) { fail('缺少 --signer / --seqno'); process.exit(1); }
  section('[92] 确认订单 #' + seqno);
  const signer = await walletFromName(signerName);
  const { index: signerIndex, data } = await findSignerIndex(signer.address);
  if (signerIndex < 0) { fail(signerName + ' 不在当前 signer 列表'); process.exit(1); }
  const orderAddress = await readOrderAddress(multisigAddress, seqno);
  const before = await readOrderData(orderAddress);
  const multisigBefore = await readMultisigData(multisigAddress);
  kv('order 地址', orderAddress.toString({ testOnly: true, bounceable: true }));
  kv('当前 approvals', before.approvals + '/' + before.threshold);
  kv('已执行', String(before.executed));
  kv('过期时间', new Date(before.expiration * 1000).toISOString());
  if (!requireConfirm('approve')) { info('dry-run：未发送'); process.exit(0); }

  const startedAt = Date.now();
  const sinceLt = await latestLt(signer.address);
  const orderSinceLt = await latestLt(orderAddress);
  const multisigSinceLt = await latestLt(multisigAddress);
  const sendResult = await sendFromWallet(signer, { to: orderAddress, value: toNano(str(args, 'value', '0.1')), body: approveBody({ signerIndex }), bounce: true });
  info('external seqno=' + sendResult.seqno);
  const signerTx = await waitForAccountTx(signer.address, { sinceLt, timeoutMs: 90000 });
  const signerSummary = summarizeTx(signerTx);
  // 订单合约侧的 tx 才能反映 approve 是否被接受（过期/重复确认等会在这里回滚）
  const orderTx = await waitForAccountTx(orderAddress, { sinceLt: orderSinceLt, timeoutMs: 60000 });
  const orderSummary = summarizeTx(orderTx);
  // 多签侧 tx 的 out_msgs 数量才能证明 action 是否真的执行（过期时多签会拒绝，out=0）
  const multisigTx = await waitForAccountTx(multisigAddress, { sinceLt: multisigSinceLt, timeoutMs: 60000 });
  const multisigSummary = summarizeTx(multisigTx);
  if (orderSummary) {
    kv('order tx', orderSummary.hash || '—');
    kv('order tx exit_code', String(orderSummary.computeExitCode));
    kv('order tx aborted', String(orderSummary.aborted));
  }
  await sleep(3500);
  let after = null;
  try { after = await readOrderData(orderAddress); } catch (error) { warn('读订单失败：' + String(error.message || error).slice(0, 120)); }
  const fees = await collectFees([signer.address, multisigAddress, orderAddress], startedAt);
  if (orderSummary && (orderSummary.aborted || (orderSummary.computeExitCode !== null && orderSummary.computeExitCode !== 0))) {
    fail('订单拒绝了本次确认（order tx aborted/exit_code=' + orderSummary.computeExitCode + '；常见原因：已过期 111 / 重复确认 107 / 签名人不符 106）');
    record('approve', { signer: signerName, seqno, rejected: true, orderExitCode: orderSummary.computeExitCode, orderTx: orderSummary.hash, txHash: signerSummary && signerSummary.hash, fees });
    process.exit(1);
  }
  if (signerSummary && signerSummary.aborted) {
    fail('approve 交易被回滚（compute exit_code=' + signerSummary.computeExitCode + '）');
    record('approve', { signer: signerName, seqno, aborted: true, exitCode: signerSummary.computeExitCode, txHash: signerSummary.hash, fees });
    process.exit(1);
  }
  kv('多签执行 tx', multisigSummary && multisigSummary.hash ? multisigSummary.hash : '—');
  kv('多签执行 out_msgs', multisigSummary ? String(multisigSummary.outMessages) : '—');
  const actionsExecuted = Boolean(multisigSummary && multisigSummary.outMessages > 0);
  // update_multisig_params 是「纯存储更新」，执行成功时不会有 out_msgs；用签名人/阈值是否变化判定
  let multisigAfter = null;
  try { multisigAfter = await readMultisigData(multisigAddress); } catch { /* ignore */ }
  const paramsChanged = Boolean(
    multisigAfter &&
    (multisigAfter.threshold !== multisigBefore.threshold ||
      JSON.stringify(multisigAfter.signers.map((a) => a.toRawString())) !== JSON.stringify(multisigBefore.signers.map((a) => a.toRawString())))
  );
  const updateExecuted = !actionsExecuted && paramsChanged;
  const rejectedByMultisig = Boolean(after && after.executed && !actionsExecuted && !updateExecuted);
  if (rejectedByMultisig) {
    fail('订单已送执行但多签拒绝（out_msgs=0）：典型原因是订单已过期（exit 111）或签名人集合已变更（102）');
    record('approve', { signer: signerName, seqno, rejectedByMultisig: true, orderTx: orderSummary && orderSummary.hash, multisigTx: multisigSummary && multisigSummary.hash, fees });
    process.exit(1);
  }
  ok('approve 已发送（signer index ' + signerIndex + '）');
  if (after) {
    kv('approvals', after.approvals + '/' + after.threshold);
    kv('executed', String(after.executed));
    if (after.executed && actionsExecuted) ok('订单已执行（达到阈值，多签已广播 ' + multisigSummary.outMessages + ' 条 action 消息）');
    else if (updateExecuted) ok('订单已执行（update_multisig_params：签名人/阈值已更新，无 out_msgs 属正常）');
    else warn('未执行：approvals 未达阈值');
  }
  record('approve', {
    signer: signerName, seqno,
    orderTx: orderSummary ? orderSummary.hash : null,
    orderExitCode: orderSummary ? orderSummary.computeExitCode : null,
    txHash: signerSummary ? signerSummary.hash : null,
    aborted: signerSummary ? signerSummary.aborted : null,
    exitCode: signerSummary ? signerSummary.computeExitCode : null,
    order: after,
    multisigOutMessages: multisigSummary ? multisigSummary.outMessages : null,
    actionsExecuted,
    updateExecuted,
    fees,
    multisigBalance: formatTon((await getAccount(multisigFriendly)).balance),
  });
  process.exit(summary({ 结果: after && after.executed ? 'EXECUTED' : 'PENDING' }) || 0);
}

/* --------------------------- update-signers ------------------------ */
if (command === 'update-signers') {
  info('提示：update-signers 等价于 propose --update-signers；请用 propose 子命令。');
  process.exit(0);
}

fail('未知子命令：' + command + '（支持 status/list/order-status/propose/approve/fund）');
process.exit(1);
