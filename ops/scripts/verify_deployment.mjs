#!/usr/bin/env node
/** 90 — 测试网部署验收：离线不变量 + 链上只读核对（--offline 跳过网络）。 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { flag } from './lib/cli.mjs';
import { RECORDS_DIR, asBigInt, formatTokens, resolvePath } from './lib/config.mjs';
import { bootstrap, finish, printNextSteps, resolveContractAddress, resolveWalletAddress } from './lib/step.mjs';
import { findJettonWallet, getAddressInformation, getJettonData, getJettonMasterMetadata, getTonBalance, parseAddress, runGetMethod, stackItemToBigInt } from './lib/ton.mjs';
import { expectedProtocolConfig } from './lib/verify.mjs';
import { CHECK_STATUS, check, verifyAllocationInvariant, verifyFundingPlan, verifyLadder, verifyRegistryStructure } from './lib/verify.mjs';
import { section, kv, ok, fail, warn, info, detail, table, summary } from './lib/log.mjs';

const { args, execute, params, digest, registry } = bootstrap({
  id: '90',
  title: '测试网部署验收（verify_deployment）',
  dependsOn: [],
});

const offline = flag(args, 'offline');
const strict = flag(args, 'strict');
const checks = [];
const add = (item) => checks.push(item);

/** 期望的 JettonWallet code hash：contracts/build/JettonWallet.json 的 hash 字段。 */
function loadBuildCodeHash(contractName) {
  const file = resolvePath(params.toolchain.buildDir + '/' + contractName + '.json');
  if (!existsSync(file)) return null;
  try {
    const json = JSON.parse(readFileSync(file, 'utf8'));
    const hash = json.hash || json.code_hash;
    return hash && /^[0-9a-fA-F]{64}$/.test(hash) ? hash.toLowerCase() : null;
  } catch { return null; }
}

function hexFromCodeHashField(info) {
  const raw = info && info.code_hash;
  if (!raw) return null;
  const text = String(raw).trim();
  if (/^[0-9a-fA-F]{64}$/.test(text)) return text.toLowerCase();
  try {
    const hex = Buffer.from(text, 'base64').toString('hex');
    return /^[0-9a-fA-F]{64}$/.test(hex) ? hex.toLowerCase() : null;
  } catch { return null; }
}

function expectedJettonWalletCodeHash() {
  const file = resolvePath(params.toolchain.buildDir + '/JettonWallet.json');
  if (!existsSync(file)) return null;
  try {
    const json = JSON.parse(readFileSync(file, 'utf8'));
    const hash = json.hash || json.code_hash;
    return hash && /^[0-9a-fA-F]{64}$/.test(hash) ? hash.toLowerCase() : null;
  } catch { return null; }
}

section('离线不变量');
const allocation = verifyAllocationInvariant(params);
add(check('allocation.sum', allocation.ok ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, allocation.sumRaw + ' raw'));
const ladder = verifyLadder(params);
add(check('price.ladder', ladder.ok ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, 'tier 1..10'));
add(check('params.digest', registry.paramsDigest === digest ? CHECK_STATUS.PASS : CHECK_STATUS.WARN, 'registry=' + (registry.paramsDigest || '未写入')));
add(check('registry.structure', 'INFO', '见下'));
const registryChecks = verifyRegistryStructure(registry);
for (const item of registryChecks) add(item);

const fundingPlan = verifyFundingPlan(params, { all: true });
for (const item of fundingPlan) {
  const record = (registry.funding || []).find((entry) => entry.kind === item.kind && entry.amountRaw === item.amountRaw && entry.confirmed === true);
  add(check('funding.' + item.kind, record ? CHECK_STATUS.PASS : CHECK_STATUS.WARN, record ? record.recipient : '未记录（部署后核对）'));
}

const controller = resolveContractAddress(registry, 'roundController');
const jettonMaster = resolveContractAddress(registry, 'jettonMaster');
const teamVault = resolveContractAddress(registry, 'teamVault');

if (!offline) {
  section('链上只读核对（TON Center testnet）');
  const netCheck = async (name, fn) => {
    try { await fn(); } catch (error) { add(check(name, strict ? CHECK_STATUS.FAIL : CHECK_STATUS.WARN, '读取失败：' + String(error.message || error).slice(0, 200))); }
  };

  const rcWallet = resolveContractAddress(registry, 'roundControllerJettonWallet');
  const tvWallet = resolveContractAddress(registry, 'teamVaultJettonWallet');
  for (const [key, address] of [['jettonMaster', jettonMaster], ['roundController', controller], ['teamVault', teamVault], ['roundControllerJettonWallet', rcWallet], ['teamVaultJettonWallet', tvWallet]]) {
    if (!address) { add(check('account.' + key, CHECK_STATUS.SKIP, '未登记')); continue; }
    await netCheck('account.' + key, async () => {
      const info = await getAddressInformation(params, address);
      const state = String(info.state || 'unknown');
      add(check('account.' + key, state === 'active' ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, 'state=' + state + ' balance=' + info.balance));
    });
  }

  const addressHashFromSlice = (item) => {
    if (!item || !item.value) return null;
    try {
      const bytes = Buffer.from(String(item.value), 'base64');
      let bits = '';
      for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
      if (bits.length < 267 || bits.slice(0, 2) !== '10') return null;
      let hex = '';
      for (let offset = 0; offset < 256; offset += 4) hex += parseInt(bits.slice(11 + offset, 15 + offset), 2).toString(16);
      return hex;
    } catch { return null; }
  };
  const tryGetMethod = async (address, methods) => {
    for (const method of methods) {
      try {
        const result = await runGetMethod(params, address, method);
        return { method, stack: result.stack || [] };
      } catch (error) { /* try next */ }
    }
    return null;
  };

  if (jettonMaster && controller) {
    await netCheck('jetton.wallet.rc', async () => {
      const wallet = await findJettonWallet(params, jettonMaster, controller);
      add(check('jetton.wallet.rc', wallet && rcWallet && wallet.address === rcWallet ? CHECK_STATUS.PASS : CHECK_STATUS.WARN, wallet ? wallet.address : '未解析'));
    });
    await netCheck('jetton.wallet.tv', async () => {
      const wallet = await findJettonWallet(params, jettonMaster, teamVault);
      add(check('jetton.wallet.tv', wallet && tvWallet && wallet.address === tvWallet ? CHECK_STATUS.PASS : CHECK_STATUS.WARN, wallet ? wallet.address : '未解析'));
    });
    await netCheck('jetton.wallet.teamWallet', async () => {
      const teamWallet = resolveWalletAddress(registry, 'teamWallet');
      if (!teamWallet) { add(check('jetton.wallet.teamWallet', CHECK_STATUS.WARN, 'teamWallet 未登记')); return; }
      const wallet = await findJettonWallet(params, jettonMaster, teamWallet);
      const recorded = resolveContractAddress(registry, 'teamWalletJettonWallet');
      add(check('jetton.wallet.teamWallet', wallet && recorded && wallet.address === recorded ? CHECK_STATUS.PASS : CHECK_STATUS.WARN, wallet ? wallet.address + ' vs registry ' + (recorded || '未登记') : '未解析'));
    });
  }
  for (const [key, address, buildName] of [['roundController', controller, 'RoundController'], ['teamVault', teamVault, 'TeamVault']]) {
    if (!address) continue;
    await netCheck(key + '.code_hash', async () => {
      const info = await getAddressInformation(params, address);
      const actual = hexFromCodeHashField(info);
      const expected = loadBuildCodeHash(buildName);
      add(check(key + '.code_hash', actual && expected && actual === expected ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, '链上 ' + (actual || '?') + ' vs build ' + (expected || '?')));
    });
  }
  for (const [key, address, minTon] of [['roundController', controller, 20], ['teamVault', teamVault, 10]]) {
    if (!address) continue;
    await netCheck('ton.balance.' + key, async () => {
      const balance = await getTonBalance(params, address);
      const ton = Number(BigInt(balance.balanceNano)) / 1e9;
      add(check('ton.balance.' + key, ton >= minTon ? CHECK_STATUS.PASS : CHECK_STATUS.WARN, ton.toFixed(2) + ' TON（建议 ≥' + minTon + '）'));
    });
  }

  if (jettonMaster) {
    await netCheck('jetton.total_supply', async () => {
      const data = await getJettonData(params, jettonMaster);
      add(check('jetton.total_supply', data.totalSupplyRaw === params.token.totalSupplyRaw ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, data.totalSupplyRaw + ' vs ' + params.token.totalSupplyRaw));
      add(check('jetton.mintable', data.mintable === false ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, String(data.mintable)));
      add(check('jetton.admin_null', data.adminNull === true ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, data.adminNull ? 'admin = null（mint 已关闭）' : 'admin 非 null：mint-once 未完成'));
    });
    await netCheck('jetton.metadata', async () => {
      const metadata = await getJettonMasterMetadata(params, jettonMaster);
      if (!metadata) {
        add(check('jetton.metadata', CHECK_STATUS.WARN, 'TON Center v3 暂未索引 metadata；get_jetton_data 已核对 supply/mint，稍后重跑'));
        return;
      }
      add(check('jetton.name', metadata.name === params.token.name ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, String(metadata.name) + ' vs ' + params.token.name));
      add(check('jetton.symbol', metadata.symbol === params.token.symbol ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, String(metadata.symbol) + ' vs ' + params.token.symbol));
      add(check('jetton.decimals', Number(metadata.decimals) === Number(params.token.decimals) ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, String(metadata.decimals) + ' vs ' + params.token.decimals));
    });
  }

  if (controller) {
    await netCheck('rc.jetton_wallet_code_hash', async () => {
      const expectedHash = expectedJettonWalletCodeHash();
      if (!expectedHash) {
        add(check('rc.jetton_wallet_code_hash', CHECK_STATUS.FAIL, '缺少 contracts/build/JettonWallet.json 的 code hash；无法比对 RC.jettonWalletCode'));
        return;
      }
      try {
        const result = await tryGetMethod(controller, ['get_jetton_wallet_code_hash']);
        if (!result) {
          add(check('rc.jetton_wallet_code_hash', CHECK_STATUS.FAIL, 'get_jetton_wallet_code_hash 调用失败（task-30 应提供该 getter）'));
          return;
        }
        const actual = stackItemToBigInt(result.stack[0]);
        if (actual === null) { add(check('rc.jetton_wallet_code_hash', CHECK_STATUS.FAIL, 'getter 返回值无法解析为 uint256')); return; }
        const actualHex = actual.toString(16).padStart(64, '0').slice(-64).toLowerCase();
        add(check('rc.jetton_wallet_code_hash', actualHex === expectedHash ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, '链上 0x' + actualHex + ' vs build 0x' + expectedHash));
      } catch (error) {
        add(check('rc.jetton_wallet_code_hash', CHECK_STATUS.FAIL, 'get_jetton_wallet_code_hash 调用失败：' + String(error.message || error).slice(0, 160)));
      }
    });
    await netCheck('rc.get_protocol_config', async () => {
      const response = await runGetMethod(params, controller, 'get_protocol_config');
      const stack = response.stack || [];
      if (stack.length < 22) { add(check('rc.get_protocol_config', CHECK_STATUS.WARN, '返回栈异常长度 ' + stack.length)); return; }
      const expected = expectedProtocolConfig(params);
      const indexes = [[5, 'p0UsdE8'], [6, 'priceMultiplier'], [7, 'roundRewardRaw'], [8, 'teamRoundRaw'], [9, 'minStakeRaw'], [10, 'maxStakePerAddressBps'], [11, 'maxTotalStakeRaw'], [12, 'previewSeconds'], [13, 'stakeDurationSeconds'], [14, 'candleSeconds'], [15, 'candleCount'], [16, 'minQualifiedCandles'], [17, 'observationSeconds'], [18, 'techAbortPauseSeconds'], [19, 'techAbortObservationTimeout'], [20, 'riskDisclosureVersion'], [21, 'configVersion']];
      for (const [index, key] of indexes) {
        const actual = stackItemToBigInt(stack[index]);
        const expectedValue = String(expected[key]);
        add(check('rc.config.' + key, actual !== null && actual.toString() === expectedValue ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, '期望 ' + expectedValue + ' 链上 ' + (actual === null ? '?' : actual.toString())));
      }
    });
  }

  if (controller) {
    await netCheck('rc.round1', async () => {
      const response = await runGetMethod(params, controller, 'get_round', [1]);
      const stack = response.stack || [];
      if (stack.length < 14) { add(check('rc.round1', CHECK_STATUS.WARN, 'round1 未开或返回栈异常')); return; }
      const status = Number(stackItemToBigInt(stack[1]));
      const tier = Number(stackItemToBigInt(stack[2]));
      const target = stackItemToBigInt(stack[3]);
      const twap = stackItemToBigInt(stack[4]);
      const reward = stackItemToBigInt(stack[6]);
      const stakeOpen = stackItemToBigInt(stack[7]);
      const stakeClose = stackItemToBigInt(stack[8]);
      const obsStart = stackItemToBigInt(stack[9]);
      const obsEnd = stackItemToBigInt(stack[10]);
      add(check('rc.round1.status', status > 0 ? CHECK_STATUS.PASS : CHECK_STATUS.WARN, 'status=' + status));
      if (status > 0) {
        const ladderFloor = asBigInt(params.price.ladderRefUsdE8[String(tier)] || '0');
        const minTarget = twap && twap > 0n ? (2n * twap > ladderFloor ? 2n * twap : ladderFloor) : ladderFloor;
        add(check('rc.round1.target_lock', target !== null && target >= minTarget ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, 'target=' + target + ' floor=' + minTarget + ' twap24h=' + twap));
        add(check('rc.round1.reward_budget', reward === asBigInt(params.rounds.roundRewardRaw) ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, String(reward)));
        add(check('rc.round1.stake_window', stakeClose !== null && stakeOpen !== null && stakeClose - stakeOpen === BigInt(params.timeline.stakeDurationSeconds) ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, (stakeOpen || 0) + ' -> ' + (stakeClose || 0)));
        add(check('rc.round1.observation_window', obsEnd !== null && obsStart !== null && obsEnd - obsStart === BigInt(params.timeline.observationSeconds) ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, (obsStart || 0) + ' -> ' + (obsEnd || 0)));
      }
    });
  }

  if (teamVault) {
    await netCheck('teamVault.pending_query_ids', async () => {
      const result = await tryGetMethod(teamVault, ['get_pending_query_ids', 'get_pending_actions', 'get_pending_state']);
      if (!result) { add(check('teamVault.pending_query_ids', CHECK_STATUS.WARN, '未提供聚合 pendingQueryId getter；需用索引器/Acton rpc 人工核对 pending release/burn 已清零')); return; }
      const nonZero = result.stack.map((item) => stackItemToBigInt(item)).filter((value) => value !== null && value !== 0n).length;
      add(check('teamVault.pending_query_ids', nonZero === 0 ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, nonZero === 0 ? '全为 0' : nonZero + ' 个 pending queryId 非 0'));
    });
    await netCheck('teamVault.teamWalletJettonWallet', async () => {
      const teamWalletOwner = resolveWalletAddress(registry, 'teamWallet');
      const recorded = resolveContractAddress(registry, 'teamWalletJettonWallet');
      let expectedHash = recorded ? parseAddress(recorded).hashHex : null;
      if (jettonMaster && teamWalletOwner) {
        try {
          const canonical = await findJettonWallet(params, jettonMaster, teamWalletOwner);
          if (canonical) expectedHash = parseAddress(canonical.address).hashHex;
        } catch (error) { /* fallback to registry */ }
      }
      if (!expectedHash) { add(check('teamVault.teamWalletJettonWallet', CHECK_STATUS.FAIL, '无法确定期望钱包：registry 未登记且 get_wallet_address(teamWallet) 失败')); return; }
      try {
        const response = await runGetMethod(params, teamVault, 'get_team_wallet_jetton_wallet');
        const stack = response.stack || [];
        const actualHash = addressHashFromSlice(stack[0]);
        const same = actualHash && actualHash.toLowerCase() === expectedHash.toLowerCase();
        add(check('teamVault.teamWalletJettonWallet', same ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, same ? expectedHash : '链上 ' + (actualHash || '?') + ' vs canonical/get_wallet_address ' + expectedHash));
      } catch (error) {
        add(check('teamVault.teamWalletJettonWallet', CHECK_STATUS.FAIL, 'get_team_wallet_jetton_wallet 调用失败（task-30 getter）：' + String(error.message || error).slice(0, 160)));
      }
    });
    await netCheck('teamVault.state', async () => {
      const response = await runGetMethod(params, teamVault, 'get_team_vault_state');
      const stack = response.stack || [];
      if (stack.length < 8) { add(check('teamVault.state', CHECK_STATUS.WARN, '返回栈异常长度 ' + stack.length)); return; }
      const controllerSlot = stack[0];
      const teamRound = stackItemToBigInt(stack[3]);
      add(check('teamVault.teamRoundRaw', teamRound === asBigInt(params.rounds.teamRoundRaw) ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, String(teamRound)));
      add(check('teamVault.controller', controllerSlot && controllerSlot.type === 'slice' ? CHECK_STATUS.PASS : CHECK_STATUS.WARN, '需用 Acton rpc 人工核对 controller = RC'));
    });
  }
}

section('验收结果');
const rows = checks.map((item) => [item.name, item.status, item.detail]);
table(['检查项', '结果', '详情'], rows);
const failures = checks.filter((item) => item.status === CHECK_STATUS.FAIL).length;
const warns = checks.filter((item) => item.status === CHECK_STATUS.WARN).length;
if (failures === 0) ok('没有 FAIL 项（WARN=' + warns + '，需人工确认）');
else fail(failures + ' 个 FAIL 项：不得开放真实质押/开轮');

if (flag(args, 'save') || execute) {
  mkdirSync(RECORDS_DIR, { recursive: true });
  const file = join(RECORDS_DIR, 'verify-deployment-' + new Date().toISOString().slice(0, 10) + '.json');
  writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), paramsDigest: digest, offline, failures, warns, checks }, null, 2));
  info('验收报告已写入：' + file);
}

printNextSteps(failures === 0
  ? ['继续：按 runbooks/02_round_operations.md 开 R1；首次开轮前确认流动性就绪与公告已发。']
  : ['先修复 FAIL 项；参数/合约问题需回退到对应步骤，不要绕过验收。']);
process.exit(summary({ FAIL: failures, WARN: warns, 模式: offline ? 'OFFLINE' : 'ONLINE' }) || (failures ? 1 : 0));
