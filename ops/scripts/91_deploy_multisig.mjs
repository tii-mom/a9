#!/usr/bin/env node
/**
 * 91 — SPIKE：部署 TON Multisig v2（测试网）。纯新增文件，不影响现有 EOA 部署路径。
 * 删除 ops/spike-multisig/ 与本文件即可完全回滚。
 *
 * 用法：
 *   node ops/scripts/91_deploy_multisig.mjs --prepare                 # 下载官方源码/预编译产物
 *   node ops/scripts/91_deploy_multisig.mjs \
 *     --signers a9-test-a,a9-test-b,a9-test-c --threshold 2          # dry-run（默认）
 *   OPS_EXECUTE=1 OPS_CONFIRM=YES node ops/scripts/91_deploy_multisig.mjs \
 *     --signers a9-test-a,a9-test-b,a9-test-c --threshold 2 --value 0.3 --execute [--save-registry]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { flag, parseArgs, str } from './lib/cli.mjs';
import { section, kv, ok, fail, warn, info, detail, summary } from './lib/log.mjs';
import {
  BAM_ROOT, MULTISIG, SPIKE_DIR, SPIKE_REGISTRY, MAIN_REGISTRY, TONCENTER,
  buildMultisigAddress, formatTon, getAccount, httpJson, latestLt, loadMultisigCode,
  readMultisigData, sendFromWallet, sleep, summarizeTx, toNano, walletFromName, waitForAccountTx, waitForActive,
} from '../spike-multisig/lib.mjs';

const args = parseArgs();
const execute = flag(args, 'execute') || process.env.OPS_EXECUTE === '1';
const confirmed = process.env.OPS_CONFIRM === 'YES';
const saveRegistry = flag(args, 'save-registry');
const network = str(args, 'network', 'testnet');
const signerNames = str(args, 'signers', '').split(',').map((s) => s.trim()).filter(Boolean);
const threshold = Number(str(args, 'threshold', '2'));
const proposerNames = str(args, 'proposers', '').split(',').map((s) => s.trim()).filter(Boolean);
const deployerName = str(args, 'deployer', 'a9-deployer');
const allowArbitrarySeqno = flag(args, 'allow-arbitrary-seqno');
const valueTon = str(args, 'value', '0.3');
const prepare = flag(args, 'prepare');
const adopt = flag(args, 'adopt');

function prepareSources() {
  const dir = join(SPIKE_DIR, '.cache', 'multisig-src');
  if (existsSync(join(dir, 'build', 'Multisig.compiled.json'))) { info('已存在预编译产物：' + join(dir, 'build', 'Multisig.compiled.json')); return; }
  mkdirSync(join(SPIKE_DIR, '.cache'), { recursive: true });
  const tar = join(SPIKE_DIR, '.cache', 'multisig.tar.gz');
  info('下载 ton-blockchain/multisig-contract-v2@master 源码…');
  execFileSync('curl', ['-sL', '-m', '180', '-o', tar, 'https://codeload.github.com/ton-blockchain/multisig-contract-v2/tar.gz/refs/heads/master'], { stdio: 'inherit' });
  execFileSync('tar', ['-xzf', tar, '-C', join(SPIKE_DIR, '.cache')], { stdio: 'inherit' });
  execFileSync('mv', [join(SPIKE_DIR, '.cache', 'multisig-contract-v2-master'), dir], { stdio: 'inherit' });
  info('源码/预编译产物就绪：' + dir);
}

section('[91] TON Multisig v2 部署（spike）');
if (prepare) { prepareSources(); process.exit(0); }
if (network !== 'testnet') { fail('spike 仅支持 testnet（--network testnet）'); process.exit(1); }
if (!signerNames.length) { fail('缺少 --signers（逗号分隔的 acton 钱包名，例如 a9-test-a,a9-test-b,a9-test-c）'); process.exit(1); }
if (!Number.isInteger(threshold) || threshold < 1 || threshold > signerNames.length) {
  fail('--threshold 必须是 1..signers.length 的整数'); process.exit(1);
}

const signers = [];
for (const name of signerNames) signers.push(await walletFromName(name));
const proposers = [];
for (const name of proposerNames) proposers.push(await walletFromName(name));

const code = loadMultisigCode();
const { address, data } = buildMultisigAddress({ code, threshold, signers: signers.map((s) => s.address), proposers: proposers.map((p) => p.address), allowArbitrarySeqno });
const friendly = address.toString({ testOnly: true, bounceable: true });
const raw = address.toRawString();

section('部署计划');
kv('网络', network);
kv('多签地址', friendly);
kv('raw', raw);
kv('code hash', code.hash().toString('hex'));
kv('data hash', data.hash().toString('hex'));
kv('阈值', threshold + ' of ' + signers.length);
for (const [index, signer] of signers.entries()) kv('signer[' + index + ']', signer.name + '  ' + signer.friendly);
for (const [index, proposer] of proposers.entries()) kv('proposer[' + index + ']', proposer.name + '  ' + proposer.friendly);
kv('allowArbitrarySeqno', String(allowArbitrarySeqno));
kv('初始注资', valueTon + ' TON（部署消息 value 成为多签合约余额，用于 order 执行 gas）');
kv('部署付款钱包', deployerName);
kv('运行模式', execute ? 'EXECUTE' : 'DRY-RUN');

const existing = await getAccount(friendly);
if (String(existing.state) === 'active' && !adopt) {
  warn('目标地址已 active（可能已部署过）：' + friendly);
  const data_ = await readMultisigData(address);
  kv('链上阈值', data_.threshold);
  kv('链上下一个 orderSeqno', data_.nextOrderSeqno.toString());
  warn('如需在已部署的情况下补写登记表，请使用 --adopt（不会重复部署）。');
  process.exit(execute ? 1 : 0);
}
const adopted = adopt && String(existing.state) === 'active';
if (adopted) info('--adopt：跳过部署，仅核对并登记已存在的多签。');

if (!execute && !adopt) {
  info('dry-run：未发送任何消息。执行请加 OPS_EXECUTE=1 OPS_CONFIRM=YES --execute');
  process.exit(summary({ 结果: 'DRY_RUN', 地址: friendly }) || 0);
}
if (!adopted && execute && !confirmed) { fail('拒绝执行：需要 OPS_CONFIRM=YES 显式确认'); process.exit(1); }

const deployer = await walletFromName(deployerName);
const deployerAccount = await getAccount(deployer.friendly);
kv('部署钱包余额', formatTon(deployerAccount.balance));

let sendResult = { seqno: null };
let txSummary = null;
if (!adopted) {
  const sinceLt = await latestLt(deployer.address);
  section('广播部署');
  const deployBody = (await import('../spike-multisig/lib.mjs')).beginCell().storeUint(0, 32).storeUint(0, 64).endCell();
  sendResult = await sendFromWallet(deployer, {
    to: address,
    value: toNano(valueTon),
    body: deployBody,
    bounce: false,
    init: { code, data },
  });
  info('external message seqno=' + sendResult.seqno);

  const activeResult = await waitForActive(address, { timeoutMs: 120000 });
  if (activeResult.state !== 'active') { fail('部署后账户仍未 active：state=' + activeResult.state); process.exit(1); }
  const deployerTx = await waitForAccountTx(deployer.address, { sinceLt, timeoutMs: 90000 });
  txSummary = summarizeTx(deployerTx);
}
const deployedAccount = await getAccount(friendly);
const onchain = await readMultisigData(address);

ok((adopted ? '已登记现存多签：' : '多签已部署：') + friendly);
kv('部署 tx', txSummary && txSummary.hash ? txSummary.hash : '（adopt 模式/未取到）');
kv('部署 tx fee', txSummary ? formatTon(txSummary.feeNano) : '—');
kv('多签余额', formatTon(deployedAccount.balance));
kv('链上阈值', onchain.threshold);
kv('下一个 orderSeqno', onchain.nextOrderSeqno.toString());
for (const [index, signer] of onchain.signers.entries()) kv('链上 signer[' + index + ']', signer.toString({ testOnly: true, bounceable: true }));

const record = {
  kind: 'multisig-v2-deploy-spike',
  network,
  createdAt: new Date().toISOString(),
  address: friendly,
  raw,
  codeHash: code.hash().toString('hex'),
  codeSource: MULTISIG.source,
  threshold,
  signers: signers.map((s, index) => ({ index, name: s.name, address: s.friendly })),
  proposers: proposers.map((p, index) => ({ index, name: p.name, address: p.friendly })),
  allowArbitrarySeqno,
  deployer: { name: deployer.name, address: deployer.friendly },
  deploy: { valueTon, txHash: txSummary && txSummary.hash, feeNano: txSummary && txSummary.feeNano, externalSeqno: sendResult.seqno },
  onchain: { threshold: onchain.threshold, nextOrderSeqno: onchain.nextOrderSeqno.toString(), signers: onchain.signers.map((s) => s.toString({ testOnly: true, bounceable: true })) },
};
mkdirSync(join(BAM_ROOT, 'ops', 'records'), { recursive: true });
writeFileSync(SPIKE_REGISTRY, JSON.stringify(record, null, 2) + '\n');
info('spike 登记表已写入：' + SPIKE_REGISTRY);

if (saveRegistry) {
  const main = JSON.parse(readFileSync(MAIN_REGISTRY, 'utf8'));
  const backup = join(BAM_ROOT, 'ops', 'records', 'registry-before-multisig-' + Date.now() + '.json');
  writeFileSync(backup, JSON.stringify(main, null, 2) + '\n');
  main.multisig = { address: friendly, raw, codeHash: record.codeHash, threshold, signers: record.signers.map((s) => s.address), updatedAt: record.createdAt, source: 'spike-91' };
  writeFileSync(MAIN_REGISTRY, JSON.stringify(main, null, 2) + '\n');
  info('主登记表已追加 multisig key（其余 key 未改动）；备份：' + backup);
}

process.exit(summary({ 结果: 'DEPLOYED', 地址: friendly, '阈值': threshold + '/' + signers.length }) || 0);
