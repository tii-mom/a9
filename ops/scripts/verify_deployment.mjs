#!/usr/bin/env node
/**
 * 90 — 测试网部署验收：离线不变量 + 链上只读核对（--offline 跳过网络）。
 *
 * 默认 STRICT（严格）模式：开轮前必检项必须全部 PASS——协议配置 17 项、Jetton Wallet code hash、
 * teamVault.controller 实际地址比对、pendingQueryId 清零、注资登记等；
 * getter 失败或返回栈异常一律 FAIL，绝不以 WARN 静默跳过。
 * --lenient 才降级为 WARN（仅排查阶段使用，不可作为开轮依据）。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { flag } from './lib/cli.mjs';
import { RECORDS_DIR, asBigInt, formatTokens, networkName, resolvePath } from './lib/config.mjs';
import { bootstrap, finish, printNextSteps, resolveContractAddress, resolveWalletAddress } from './lib/step.mjs';
import { addressEquals, addressFromStackItem, findJettonWallet, getAddressInformation, getJettonData, getJettonMasterMetadata, getTonBalance, parseAddress, runGetMethod, stackItemToBigInt } from './lib/ton.mjs';
import { expectedProtocolConfig } from './lib/verify.mjs';
import { CHECK_STATUS, check, verifyAllocationInvariant, verifyFundingPlan, verifyLadder, verifyRegistryStructure } from './lib/verify.mjs';
import { section, kv, ok, fail, warn, info, detail, table, summary } from './lib/log.mjs';

const { args, execute, params, digest, registry } = bootstrap({
  id: '90',
  title: '测试网部署验收（verify_deployment）',
  dependsOn: [],
});

const offline = flag(args, 'offline');
// 严格模式默认开启；--lenient 显式降级。--strict 保留为兼容写法（与默认等价）。
const lenient = flag(args, 'lenient') && !flag(args, 'strict');
const strict = !lenient;
info('验收模式：' + (strict ? 'STRICT（开轮前必检项必须 PASS）' : 'LENIENT（--lenient，仅排查，不可作为开轮依据）') + (offline ? ' / OFFLINE' : ' / ONLINE'));
const checks = [];
const add = (item) => checks.push(item);
/** 必检项状态：通过 = PASS；不通过时严格模式 FAIL、宽松模式 WARN。 */
const gateStatus = (passed) => (passed ? CHECK_STATUS.PASS : strict ? CHECK_STATUS.FAIL : CHECK_STATUS.WARN);
/** 必检项登记：额外打 required 标记，结尾做「关键项是否真的执行过」覆盖审计。 */
const addRequired = (name, status, detailText) => {
  const item = check(name, status, detailText);
  item.required = true;
  checks.push(item);
  return item;
};

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

function codeHashViaActon(address) {
  const command = 'export PATH=$HOME/.acton/bin:$PATH; cd ' + params.toolchain.contractsDir + ' && acton rpc info ' + address + ' --net ' + networkName();
  const result = spawnSync('bash', ['-lc', command], { encoding: 'utf8', timeout: 60000 });
  const match = String(result.stdout || '').match(/Code Hash:\s+0x([0-9a-fA-F]{64})/);
  return match ? match[1].toLowerCase() : null;
}

function canonicalViaActon(masterAddress, ownerAddress) {
  const scriptPath = resolvePath('ops/scripts/tolk/query_one_wallet.tolk');
  const command = 'export PATH=$HOME/.acton/bin:$PATH; cd ' + params.toolchain.contractsDir + ' && acton script --manifest-path Acton.toml --net ' + networkName() + ' ' + scriptPath + ' ' + masterAddress + ' ' + ownerAddress;
  const result = spawnSync('bash', ['-lc', command], { encoding: 'utf8', timeout: 60000 });
  const match = String(result.stdout || '').match(/JETTON_WALLET=(\S+)/);
  return match ? match[1] : null;
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
addRequired('params.digest', gateStatus(registry.paramsDigest === digest), 'registry=' + (registry.paramsDigest || '未写入') + (registry.paramsDigest === digest ? '' : registry.paramsDigest ? '（与当前参数哈希不一致）' : (strict ? '（STRICT：登记表缺少参数哈希）' : '（--lenient：仅提示）')));

add(check('registry.structure', 'INFO', '见下'));
const registryChecks = verifyRegistryStructure(registry);
for (const item of registryChecks) {
  const upgraded = strict && item.status === CHECK_STATUS.WARN ? CHECK_STATUS.FAIL : item.status;
  const detailText = upgraded === item.status ? item.detail : item.detail + '（STRICT：开轮前必须登记）';
  addRequired(item.name, upgraded, detailText);
}

const fundingPlan = verifyFundingPlan(params, { all: true });
for (const item of fundingPlan) {
  const record = (registry.funding || []).find((entry) => entry.kind === item.kind && entry.amountRaw === item.amountRaw && entry.confirmed === true);
  addRequired('funding.' + item.kind, gateStatus(Boolean(record)), record ? record.recipient : strict ? '未记录（STRICT：开轮前必须完成并登记注资）' : '未记录（--lenient：仅提示）');
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
    if (!address) { addRequired('account.' + key, strict ? CHECK_STATUS.FAIL : CHECK_STATUS.SKIP, strict ? '未登记（STRICT：合约地址缺失）' : '未登记（--lenient：跳过）'); continue; }
    await netCheck('account.' + key, async () => {
      const info = await getAddressInformation(params, address);
      const state = String(info.state || 'unknown');
      addRequired('account.' + key, state === 'active' ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, 'state=' + state + ' balance=' + info.balance);
    });
  }

  const addressHashFromSlice = (item) => {
    const parsed = addressFromStackItem(item);
    return parsed ? parsed.hashHex : null;
  };
  const tryGetMethod = async (address, methods) => {
    for (const method of methods) {
      try {
        const result = await runGetMethod(params, address, method);
        if (result.exit_code !== undefined && result.exit_code !== 0) continue;
        return { method, stack: result.stack || [] };
      } catch (error) { /* try next */ }
    }
    return null;
  };

  if (jettonMaster && controller) {
    await netCheck('jetton.wallet.rc', async () => {
      const wallet = await findJettonWallet(params, jettonMaster, controller);
      const actual = wallet ? wallet.address : canonicalViaActon(jettonMaster, controller);
      addRequired('jetton.wallet.rc', gateStatus(Boolean(actual && rcWallet && addressEquals(actual, rcWallet))), actual ? actual + ' vs registry ' + (rcWallet || '未登记') : '未解析（get_wallet_address 与 TON Center 均失败）');
    });
    await netCheck('jetton.wallet.tv', async () => {
      const wallet = await findJettonWallet(params, jettonMaster, teamVault);
      const actual = wallet ? wallet.address : canonicalViaActon(jettonMaster, teamVault);
      addRequired('jetton.wallet.tv', gateStatus(Boolean(actual && tvWallet && addressEquals(actual, tvWallet))), actual ? actual + ' vs registry ' + (tvWallet || '未登记') : '未解析（get_wallet_address 与 TON Center 均失败）');
    });
    await netCheck('jetton.wallet.teamWallet', async () => {
      const teamWallet = resolveWalletAddress(registry, 'teamWallet');
      if (!teamWallet) { addRequired('jetton.wallet.teamWallet', strict ? CHECK_STATUS.FAIL : CHECK_STATUS.WARN, strict ? 'teamWallet 未登记（STRICT：开轮前必须登记）' : 'teamWallet 未登记（--lenient：仅提示）'); return; }
      const wallet = await findJettonWallet(params, jettonMaster, teamWallet);
      const actual = wallet ? wallet.address : canonicalViaActon(jettonMaster, teamWallet);
      const recorded = resolveContractAddress(registry, 'teamWalletJettonWallet');
      addRequired('jetton.wallet.teamWallet', gateStatus(Boolean(actual && recorded && addressEquals(actual, recorded))), actual ? actual + ' vs registry ' + (recorded || '未登记') : '未解析（get_wallet_address 与 TON Center 均失败）');
    });
  }
  for (const [key, address, buildName] of [['roundController', controller, 'RoundController'], ['teamVault', teamVault, 'TeamVault']]) {
    if (!address) continue;
    await netCheck(key + '.code_hash', async () => {
      const info = await getAddressInformation(params, address);
      const actual = hexFromCodeHashField(info) || codeHashViaActon(address);
      const expected = loadBuildCodeHash(buildName);
      const same = Boolean(actual && expected && actual === expected);
      const detailText = same
        ? '一致：' + actual
        : '线上 ' + (actual || '无法读取（TON Center 未返回 code_hash 且本机 acton 不可用）') + ' ≠ contracts/build ' + (expected || '?') +
          '：线上实例与 contracts/build 不一致（可能未重部署），必须重部署到当前构建后再开轮';
      addRequired(key + '.code_hash', same ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, detailText);
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
      const supplySame = data.totalSupplyRaw === params.token.totalSupplyRaw;
      add(check(
        'jetton.total_supply',
        supplySame ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL,
        supplySame
          ? data.totalSupplyRaw
          : data.totalSupplyRaw + ' vs ' + params.token.totalSupplyRaw + '（差值可能来自已发生的测试销毁，新实例应为 1e19；如为旧实例请核对 burn 记录）'
      ));
      add(check('jetton.mintable', data.mintable === false ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, String(data.mintable)));
      add(check('jetton.admin_null', data.adminNull === true ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, data.adminNull ? 'admin = null（mint 已关闭）' : 'admin 非 null：mint-once 未完成'));
    });
    await netCheck('jetton.metadata', async () => {
      const metadata = await getJettonMasterMetadata(params, jettonMaster);
      if (!metadata || metadata.name === null || metadata.symbol === null || metadata.decimals === null) {
        add(check('jetton.metadata', CHECK_STATUS.WARN, 'TON Center v3 尚未索引 name/symbol/decimals（仅 onchain uri）；get_jetton_data 已核对 supply/mint，稍后重跑'));
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
        addRequired('rc.jetton_wallet_code_hash', CHECK_STATUS.FAIL, '缺少 contracts/build/JettonWallet.json 的 code hash；无法比对 RC.jettonWalletCode');
        return;
      }
      try {
        const result = await tryGetMethod(controller, ['get_jetton_wallet_code_hash']);
        if (!result) {
          addRequired('rc.jetton_wallet_code_hash', CHECK_STATUS.FAIL, 'get_jetton_wallet_code_hash 调用失败（task-30 应提供该 getter）');
          return;
        }
        const actual = stackItemToBigInt(result.stack[0]);
        if (actual === null) { addRequired('rc.jetton_wallet_code_hash', CHECK_STATUS.FAIL, 'getter 返回值无法解析为 uint256'); return; }
        const actualHex = actual.toString(16).padStart(64, '0').slice(-64).toLowerCase();
        const sameHash = actualHex === expectedHash;
        addRequired(
          'rc.jetton_wallet_code_hash',
          sameHash ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL,
          sameHash
            ? '一致：0x' + actualHex
            : '线上 0x' + actualHex + ' ≠ contracts/build 0x' + expectedHash + '：线上实例与 contracts/build 不一致（可能未重部署），必须重部署到当前构建后再开轮'
        );
      } catch (error) {
        addRequired('rc.jetton_wallet_code_hash', CHECK_STATUS.FAIL, 'get_jetton_wallet_code_hash 调用失败：' + String(error.message || error).slice(0, 160));
      }
    });
    await netCheck('rc.get_protocol_config', async () => {
      const response = await runGetMethod(params, controller, 'get_protocol_config');
      const stack = response.stack || [];
      const shapeOk = stack.length >= 22;
      addRequired('rc.get_protocol_config.shape', gateStatus(shapeOk), '栈长度 ' + stack.length + '（期望 ≥22）' + (shapeOk ? '' : '：17 个配置项无法比对'));
      if (!shapeOk) return;
      const expected = expectedProtocolConfig(params);
      const indexes = [[5, 'p0UsdE8'], [6, 'priceMultiplier'], [7, 'roundRewardRaw'], [8, 'teamRoundRaw'], [9, 'minStakeRaw'], [10, 'maxStakePerAddressBps'], [11, 'maxTotalStakeRaw'], [12, 'previewSeconds'], [13, 'stakeDurationSeconds'], [14, 'candleSeconds'], [15, 'candleCount'], [16, 'minQualifiedCandles'], [17, 'observationSeconds'], [18, 'techAbortPauseSeconds'], [19, 'techAbortObservationTimeout'], [20, 'riskDisclosureVersion'], [21, 'configVersion']];
      for (const [index, key] of indexes) {
        const actual = stackItemToBigInt(stack[index]);
        const expectedValue = String(expected[key]);
        const same = actual !== null && actual.toString() === expectedValue;
        addRequired('rc.config.' + key, gateStatus(same), '期望 ' + expectedValue + ' 链上 ' + (actual === null ? '?' : actual.toString()));
      }
    });
  }

  if (controller) {
    await netCheck('rc.round1', async () => {
      const response = await runGetMethod(params, controller, 'get_round', [1]);
      const stack = response.stack || [];
      const shapeOk = stack.length >= 14;
      addRequired('rc.round1.shape', gateStatus(shapeOk), '栈长度 ' + stack.length + '（期望 ≥14）' + (shapeOk ? '' : '：轮次检查无法进行'));
      if (!shapeOk) return;
      const status = Number(stackItemToBigInt(stack[1]));
      const tier = Number(stackItemToBigInt(stack[2]));
      const target = stackItemToBigInt(stack[3]);
      const twap = stackItemToBigInt(stack[4]);
      const reward = stackItemToBigInt(stack[6]);
      const stakeOpen = stackItemToBigInt(stack[7]);
      const stakeClose = stackItemToBigInt(stack[8]);
      const obsStart = stackItemToBigInt(stack[9]);
      const obsEnd = stackItemToBigInt(stack[10]);
      add(check('rc.round1.status', status > 0 ? CHECK_STATUS.PASS : CHECK_STATUS.WARN, 'status=' + status + (status > 0 ? '' : '（R1 未开，开轮前预期；开轮后必须重跑 --online）')));
      if (status > 0) {
        const ladderFloor = asBigInt(params.price.ladderRefUsdE8[String(tier)] || '0');
        const minTarget = twap && twap > 0n ? (2n * twap > ladderFloor ? 2n * twap : ladderFloor) : ladderFloor;
        addRequired('rc.round1.target_lock', target !== null && target >= minTarget ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, 'target=' + target + ' floor=' + minTarget + ' twap24h=' + twap);
        addRequired('rc.round1.reward_budget', reward === asBigInt(params.rounds.roundRewardRaw) ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, String(reward));
        addRequired('rc.round1.stake_window', stakeClose !== null && stakeOpen !== null && stakeClose - stakeOpen === BigInt(params.timeline.stakeDurationSeconds) ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, (stakeOpen || 0) + ' -> ' + (stakeClose || 0));
        const obsValid = obsEnd !== null && obsStart !== null && obsEnd - obsStart === BigInt(params.timeline.observationSeconds);
        const obsNotStarted = status <= 2 && (obsStart === null || obsStart === 0n) && (obsEnd === null || obsEnd === 0n);
        add(check('rc.round1.observation_window', obsValid ? CHECK_STATUS.PASS : (obsNotStarted ? CHECK_STATUS.WARN : CHECK_STATUS.FAIL), (obsStart || 0) + ' -> ' + (obsEnd || 0) + (obsNotStarted ? '（STAKING_OPEN 尚未开始观察，正常）' : '')));
      }
    });
  }

  if (teamVault) {
    await netCheck('teamVault.pending_query_ids', async () => {
      // 合约已冻结（tag v8.6-audit-fixed @ c24809a）：不为验收新增 getter。
      // 用已有 get_round_state(roundId) 枚举 1..N 轮，等价判定「聚合 pendingQueryId 全为 0」：
      //   queryId != 0 且既未 released 也未 burned ⇒ 存在卡住的 pending release/burn。
      const roundCount = Number(params.rounds.roundCount || 10);
      const pending = [];
      const shapeIssues = [];
      for (let roundId = 1; roundId <= roundCount; roundId += 1) {
        let result;
        try {
          result = await runGetMethod(params, teamVault, 'get_round_state', [roundId]);
        } catch (error) {
          addRequired('teamVault.pending_query_ids', gateStatus(false), 'get_round_state(' + roundId + ') 调用失败：' + String(error.message || error).slice(0, 160));
          return;
        }
        const stack = result.stack || [];
        if (stack.length < 4) { shapeIssues.push('R' + roundId + ' 栈长度 ' + stack.length); continue; }
        const released = stackItemToBigInt(stack[0]);
        const burned = stackItemToBigInt(stack[1]);
        const queryId = stackItemToBigInt(stack[3]);
        if (queryId === null) { shapeIssues.push('R' + roundId + ' queryId 无法解析'); continue; }
        const settled = (released !== null && released !== 0n) || (burned !== null && burned !== 0n);
        if (queryId !== 0n && !settled) pending.push('R' + roundId + ':' + queryId.toString());
      }
      if (shapeIssues.length) {
        addRequired('teamVault.pending_query_ids', gateStatus(false), 'get_round_state 返回栈异常：' + shapeIssues.slice(0, 3).join('；') + '（无法证明 pending 已清零）');
        return;
      }
      const clear = pending.length === 0;
      addRequired(
        'teamVault.pending_query_ids',
        gateStatus(clear),
        clear
          ? '枚举 R1..R' + roundCount + '：queryId=0 或已 released/burned（无卡住的 pending）'
          : '存在未确认的 pending release/burn：' + pending.slice(0, 6).join('、')
      );
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
      if (!expectedHash) { addRequired('teamVault.teamWalletJettonWallet', CHECK_STATUS.FAIL, '无法确定期望钱包：registry 未登记且 get_wallet_address(teamWallet) 失败'); return; }
      try {
        const response = await runGetMethod(params, teamVault, 'get_team_wallet_jetton_wallet');
        const stack = response.stack || [];
        const actualHash = addressHashFromSlice(stack[0]);
        const same = actualHash && actualHash.toLowerCase() === expectedHash.toLowerCase();
        addRequired('teamVault.teamWalletJettonWallet', same ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, same ? expectedHash : '链上 ' + (actualHash || '?') + ' vs canonical/get_wallet_address ' + expectedHash);
      } catch (error) {
        addRequired('teamVault.teamWalletJettonWallet', CHECK_STATUS.FAIL, 'get_team_wallet_jetton_wallet 调用失败（task-30 getter）：' + String(error.message || error).slice(0, 160));
      }
    });
    await netCheck('teamVault.state', async () => {
      const response = await runGetMethod(params, teamVault, 'get_team_vault_state');
      const stack = response.stack || [];
      const shapeOk = stack.length >= 8;
      addRequired('teamVault.state.shape', gateStatus(shapeOk), '栈长度 ' + stack.length + '（期望 ≥8）' + (shapeOk ? '' : '：TeamVault 状态无法核对'));
      if (!shapeOk) return;
      const controllerSlot = stack[0];
      const teamRound = stackItemToBigInt(stack[3]);
      addRequired('teamVault.teamRoundRaw', teamRound === asBigInt(params.rounds.teamRoundRaw) ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, String(teamRound));
      // controller 必须是 RC 本体：解析 slice/cell 里的 workchain+hash 与 RC 实际地址比对（不能只看类型）
      const onchainController = addressFromStackItem(controllerSlot);
      const rcParsed = controller ? parseAddress(controller) : null;
      const sameController = Boolean(
        onchainController && rcParsed && rcParsed.ok &&
        onchainController.wc === rcParsed.workchain &&
        onchainController.hashHex.toLowerCase() === rcParsed.hashHex.toLowerCase()
      );
      addRequired(
        'teamVault.controller',
        gateStatus(sameController),
        sameController
          ? 'controller = RC（' + onchainController.wc + ':' + onchainController.hashHex.slice(0, 16) + '…）'
          : '链上 controller ' + (onchainController ? onchainController.wc + ':' + onchainController.hashHex : '无法解析（非地址 slice）') + ' vs RC ' + (rcParsed && rcParsed.ok ? rcParsed.raw : '未登记')
      );
    });
  }
}

section('验收结果');

// 必检项覆盖审计：即使没有 FAIL，也必须确认「关键分支真的执行过」，防止栈异常跳过后静默通过。
const REQUIRED_FAMILIES = [
  { key: 'rc.get_protocol_config.shape', min: 1, label: 'get_protocol_config 结构' },
  { key: 'rc.config.', min: 17, label: '协议配置 17 项', prefix: true },
  { key: 'rc.jetton_wallet_code_hash', min: 1, label: 'Jetton Wallet code hash' },
  { key: 'rc.round1.shape', min: 1, label: 'get_round(1) 结构' },
  { key: 'teamVault.controller', min: 1, label: 'teamVault.controller 地址比对' },
  { key: 'teamVault.pending_query_ids', min: 1, label: 'pendingQueryId 清零' },
];
if (offline) {
  info('OFFLINE：链上必检项未执行（离线验收不构成开轮依据，开轮前必须再跑 --online）。');
} else {
  for (const family of REQUIRED_FAMILIES) {
    const count = checks.filter((item) => (family.prefix ? item.name.startsWith(family.key) : item.name === family.key)).length;
    if (count < family.min) {
      addRequired('gate.missing.' + family.label, gateStatus(false), '必检项未执行（' + count + '/' + family.min + '）：脚本分支被跳过，不得据此开轮' + (strict ? '' : '（--lenient：仅提示）'));
    }
  }
}

const rows = checks.map((item) => [item.name, item.status, item.detail]);
table(['检查项', '结果', '详情'], rows);
const requiredChecks = checks.filter((item) => item.required);
const requiredPass = requiredChecks.filter((item) => item.status === CHECK_STATUS.PASS).length;
const requiredFail = requiredChecks.filter((item) => item.status !== CHECK_STATUS.PASS).length;
const failures = checks.filter((item) => item.status === CHECK_STATUS.FAIL).length;
const warns = checks.filter((item) => item.status === CHECK_STATUS.WARN).length;
kv('验收模式', strict ? 'STRICT（默认）' : 'LENIENT（--lenient）');
kv('必检项', requiredPass + '/' + requiredChecks.length + ' PASS' + (requiredFail ? '（' + requiredFail + ' 项未通过）' : ''));
if (failures === 0) {
  if (strict && requiredFail > 0) fail(requiredFail + ' 个必检项未通过：不得开放真实质押/开轮');
  else ok('没有 FAIL 项（必检项 ' + requiredPass + '/' + requiredChecks.length + ' PASS，WARN=' + warns + '）');
} else {
  fail(failures + ' 个 FAIL 项：不得开放真实质押/开轮');
}

if (flag(args, 'save') || execute) {
  mkdirSync(RECORDS_DIR, { recursive: true });
  const file = join(RECORDS_DIR, 'verify-deployment-' + new Date().toISOString().slice(0, 10) + '.json');
  writeFileSync(file, JSON.stringify({
    generatedAt: new Date().toISOString(),
    paramsDigest: digest,
    offline,
    strict,
    failures,
    warns,
    required: { total: requiredChecks.length, pass: requiredPass },
    checks,
  }, null, 2));
  info('验收报告已写入：' + file);
}

if (offline) {
  printNextSteps(['离线验收只覆盖不变量与登记表；开轮前必须再跑 --online（默认严格模式）且必检项全部 PASS。']);
} else if (failures === 0 && requiredFail === 0) {
  printNextSteps(['继续：按 runbooks/02_round_operations.md 开 R1；首次开轮前确认流动性就绪与公告已发。']);
} else {
  printNextSteps(['先修复 FAIL 项；参数/合约问题需回退到对应步骤，不要绕过验收。' + (strict ? '' : '（当前为 --lenient，WARN 不等于通过）')]);
}
process.exit(summary({
  FAIL: failures,
  WARN: warns,
  模式: offline ? 'OFFLINE' : 'ONLINE',
  严格模式: strict ? 'ON' : 'OFF',
  必检项: requiredPass + '/' + requiredChecks.length + ' PASS',
}) || (failures ? 1 : 0));
