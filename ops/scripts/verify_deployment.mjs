#!/usr/bin/env node
/**
 * verify_deployment — 部署验收（v11）：离线不变量 + 链上只读核对（--offline 跳过网络）。
 * v11 追加：RC 的 StakeTicket code hash；军饷分发合约（JunxiangDistributor）的激活、code hash、publisher、Jetton Wallet 推导。
 *
 * 默认 STRICT（严格）模式：开轮前必检项必须全部 PASS——协议配置 17 项 + 5 个地址槽（keeper /
 * jettonMaster / RC 钱包 / teamWallet）、RC 与 Jetton Wallet code hash、RC 钱包推导一致、
 * RC 钱包 = 82 亿、注资登记等；
 * getter 失败或返回栈异常一律 FAIL，绝不以 WARN 静默跳过。
 * --lenient 才降级为 WARN（仅排查阶段使用，不可作为开轮依据）。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { flag } from './lib/cli.mjs';
import { RECORDS_DIR, asBigInt, formatTokens, networkName, resolvePath } from './lib/config.mjs';
import { bootstrap, finish, printNextSteps, resolveContractAddress, resolveWalletAddress } from './lib/step.mjs';
import { addressEquals, addressFromStackItem, findJettonWallet, getAddressInformation, getJettonData, getJettonMasterMetadata, getJettonWalletBalance, getRoundView, getTonBalance, parseAddress, runGetMethod, stackItemToBigInt } from './lib/ton.mjs';
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
const keeper = resolveWalletAddress(registry, 'keeper');
const teamWallet = resolveWalletAddress(registry, 'teamWallet');

if (!offline) {
  section('链上只读核对（TON Center ' + networkName() + '）');
  const netCheck = async (name, fn) => {
    try { await fn(); } catch (error) { add(check(name, strict ? CHECK_STATUS.FAIL : CHECK_STATUS.WARN, '读取失败：' + String(error.message || error).slice(0, 200))); }
  };
  const sameAddress = (stackItem, expected) => {
    const onchain = addressFromStackItem(stackItem);
    const parsed = expected ? parseAddress(expected) : null;
    const same = Boolean(onchain && parsed && parsed.ok && onchain.wc === parsed.workchain && onchain.hashHex.toLowerCase() === parsed.hashHex.toLowerCase());
    return { same, onchain: onchain ? onchain.wc + ':' + onchain.hashHex : '无法解析', expected: parsed && parsed.ok ? parsed.raw : '未登记' };
  };

  const rcWallet = resolveContractAddress(registry, 'roundControllerJettonWallet');
  for (const [key, address] of [['jettonMaster', jettonMaster], ['roundController', controller], ['roundControllerJettonWallet', rcWallet]]) {
    if (!address) { addRequired('account.' + key, strict ? CHECK_STATUS.FAIL : CHECK_STATUS.SKIP, strict ? '未登记（STRICT：合约地址缺失）' : '未登记（--lenient：跳过）'); continue; }
    await netCheck('account.' + key, async () => {
      const info = await getAddressInformation(params, address);
      const state = String(info.state || 'unknown');
      addRequired('account.' + key, state === 'active' ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, 'state=' + state + ' balance=' + info.balance);
    });
  }

  // v11：RC 在链上自行推导 Jetton Wallet；master.get_wallet_address(RC) 与 RC.get_jetton_wallet_address() 必须一致
  if (jettonMaster && controller) {
    await netCheck('jetton.wallet.rc', async () => {
      const wallet = await findJettonWallet(params, jettonMaster, controller);
      const viaMaster = wallet ? wallet.address : canonicalViaActon(jettonMaster, controller);
      const rcSelf = await runGetMethod(params, controller, 'get_jetton_wallet_address');
      const selfCheck = viaMaster ? sameAddress((rcSelf.stack || [])[0], viaMaster) : { same: false, onchain: '?', expected: '?' };
      const registryOk = Boolean(viaMaster && rcWallet && addressEquals(viaMaster, rcWallet));
      addRequired('jetton.wallet.rc', gateStatus(registryOk && selfCheck.same), 'master.get_wallet_address(RC)=' + (viaMaster || '未解析') + '；RC.get_jetton_wallet_address=' + selfCheck.onchain + '；registry=' + (rcWallet || '未登记'));
    });
  }
  if (controller) {
    await netCheck('roundController.code_hash', async () => {
      const info = await getAddressInformation(params, controller);
      const actual = hexFromCodeHashField(info) || codeHashViaActon(controller);
      const expected = loadBuildCodeHash('RoundController');
      const same = Boolean(actual && expected && actual === expected);
      addRequired('roundController.code_hash', same ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, same
        ? '一致：' + actual
        : '线上 ' + (actual || '无法读取') + ' ≠ contracts/build ' + (expected || '?') + '：线上实例与当前构建不一致，必须重部署后再开轮');
    });
    await netCheck('ton.balance.roundController', async () => {
      const balance = await getTonBalance(params, controller);
      const ton = Number(BigInt(balance.balanceNano)) / 1e9;
      const minTon = Number(params.tonBalances.roundControllerMinTon);
      add(check('ton.balance.roundController', ton >= minTon ? CHECK_STATUS.PASS : CHECK_STATUS.WARN, ton.toFixed(2) + ' TON（建议 ≥' + minTon + '）'));
    });
  }
  if (keeper) {
    await netCheck('ton.balance.keeper', async () => {
      const balance = await getTonBalance(params, keeper);
      const ton = Number(BigInt(balance.balanceNano)) / 1e9;
      const minTon = Number(params.tonBalances.keeperMinTon);
      add(check('ton.balance.keeper', ton >= minTon ? CHECK_STATUS.PASS : CHECK_STATUS.WARN, ton.toFixed(2) + ' TON（建议 ≥' + minTon + '）'));
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
          : data.totalSupplyRaw + ' vs ' + params.token.totalSupplyRaw + '（新实例应为 1e19；已有失败轮时差值应等于累计销毁，用 reconcile.mjs --chain 核对）'
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

  let round1Status = null;
  if (controller) {
    await netCheck('rc.jetton_wallet_code_hash', async () => {
      const expectedHash = expectedJettonWalletCodeHash();
      if (!expectedHash) {
        addRequired('rc.jetton_wallet_code_hash', CHECK_STATUS.FAIL, '缺少 contracts/build/JettonWallet.json 的 code hash；无法比对 RC.jettonWalletCode');
        return;
      }
      const result = await runGetMethod(params, controller, 'get_jetton_wallet_code_hash');
      const actual = stackItemToBigInt((result.stack || [])[0]);
      if (actual === null) { addRequired('rc.jetton_wallet_code_hash', CHECK_STATUS.FAIL, 'getter 返回值无法解析为 uint256'); return; }
      const actualHex = actual.toString(16).padStart(64, '0').slice(-64).toLowerCase();
      addRequired('rc.jetton_wallet_code_hash', actualHex === expectedHash ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, actualHex === expectedHash
        ? '一致：0x' + actualHex
        : '线上 0x' + actualHex + ' ≠ contracts/build 0x' + expectedHash);
    });
    await netCheck('rc.get_protocol_config', async () => {
      const response = await runGetMethod(params, controller, 'get_protocol_config');
      const stack = response.stack || [];
      const shapeOk = stack.length >= 22;
      addRequired('rc.get_protocol_config.shape', gateStatus(shapeOk), '栈长度 ' + stack.length + '（期望 ≥22）' + (shapeOk ? '' : '：配置项无法比对'));
      if (!shapeOk) return;
      // v11 槽位（沿用 v8 形状，ProtocolConfigView 字段顺序未变）：0、1 = keeper，2 = jettonMaster，3 = RC 钱包，4 = teamWallet
      for (const [index, key, expected] of [[0, 'keeper', keeper], [1, 'keeper.oracleSlot', keeper], [2, 'jettonMaster', jettonMaster], [3, 'stakingJettonWallet', rcWallet], [4, 'teamWallet', teamWallet]]) {
        const result = sameAddress(stack[index], expected);
        addRequired('rc.address.' + key, gateStatus(result.same), '链上 ' + result.onchain + ' vs registry ' + result.expected);
      }
      const expected = expectedProtocolConfig(params);
      const indexes = [[5, 'p0UsdE8'], [6, 'priceMultiplier'], [7, 'roundRewardRaw'], [8, 'teamRoundRaw'], [9, 'minStakeRaw'], [10, 'maxStakePerAddressBps'], [11, 'maxTotalStakeRaw'], [12, 'previewSeconds'], [13, 'stakeDurationSeconds'], [14, 'candleSeconds'], [15, 'candleCount'], [16, 'minQualifiedCandles'], [17, 'observationSeconds'], [18, 'techAbortPauseSeconds'], [19, 'techAbortObservationTimeout'], [20, 'riskDisclosureVersion'], [21, 'configVersion']];
      for (const [index, key] of indexes) {
        const actual = stackItemToBigInt(stack[index]);
        const expectedValue = String(expected[key]);
        const same = actual !== null && actual.toString() === expectedValue;
        addRequired('rc.config.' + key, gateStatus(same), '期望 ' + expectedValue + ' 链上 ' + (actual === null ? '?' : actual.toString()));
      }
    });
    await netCheck('rc.round1', async () => {
      const view = await getRoundView(params, controller, 1);
      addRequired('rc.round1.shape', gateStatus(Boolean(view)), view ? 'RoundView 19+ 字段' : 'get_round(1) 栈长度不足：轮次检查无法进行');
      if (!view) return;
      round1Status = view.status;
      add(check('rc.round1.status', view.status > 0 ? CHECK_STATUS.PASS : CHECK_STATUS.WARN, view.state + (view.status > 0 ? '' : '（R1 未开，开轮前预期；开轮后必须重跑 --online）')));
      if (view.status > 0) {
        const ladderFloor = asBigInt(params.price.ladderRefUsdE8[String(view.targetTier)] || '0');
        const twap = view.targetTwap24hUsdE8;
        const minTarget = twap && twap > 0n ? (2n * twap > ladderFloor ? 2n * twap : ladderFloor) : ladderFloor;
        addRequired('rc.round1.target_lock', view.targetPriceUsdE8 !== null && view.targetPriceUsdE8 >= minTarget ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, 'target=' + view.targetPriceUsdE8 + ' floor=' + minTarget + ' twap24h=' + twap);
        addRequired('rc.round1.reward_budget', view.rewardBudgetRaw === asBigInt(params.rounds.roundRewardRaw) ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, String(view.rewardBudgetRaw));
        if (view.stakeOpenAt && view.stakeCloseAt) {
          addRequired('rc.round1.stake_window', view.stakeCloseAt - view.stakeOpenAt === BigInt(params.timeline.stakeDurationSeconds) ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL, view.stakeOpenAt + ' -> ' + view.stakeCloseAt);
        }
      }
    });
    // RC 注资：未开轮时 RC 钱包余额必须精确等于 82 亿；开轮后由 reconcile.mjs 按公式核对
    if (rcWallet) {
      await netCheck('rc.vault.balance', async () => {
        const balance = await getJettonWalletBalance(params, rcWallet);
        const expected = asBigInt(params.rounds.rcFundingRaw);
        if (round1Status !== null && round1Status > 1) {
          add(check('rc.vault.balance', balance !== null ? CHECK_STATUS.PASS : CHECK_STATUS.WARN, '已开轮：' + (balance === null ? '未读取' : formatTokens(balance.toString())) + ' A9（用 reconcile.mjs --chain 按公式核对）'));
          return;
        }
        addRequired('rc.vault.balance', gateStatus(balance === expected), 'RC 钱包 ' + (balance === null ? '未读取' : balance.toString()) + ' vs 期望 82 亿 ' + expected + '（forward_ton_amount = 0 注资）');
      });
    }
  }
}

// v11：军饷分发合约（JunxiangDistributor + ClaimRecord）与 RC 的 StakeTicket 代码哈希（contracts/README §6、§7.1）。
// 分发合约不在部署时注资：这里只核对代码、publisher、钱包推导与余额（余额仅提示，周根发布前由运维充值）。
if (!offline) {
  const guard = async (name, fn) => {
    try { await fn(); } catch (error) { add(check(name, strict ? CHECK_STATUS.FAIL : CHECK_STATUS.WARN, '读取失败：' + String(error.message || error).slice(0, 200))); }
  };
  const distributorAddr = resolveContractAddress(registry, 'junxiangDistributor');
  const distributorWalletAddr = resolveContractAddress(registry, 'junxiangDistributorJettonWallet');
  const publisher = resolveWalletAddress(registry, 'junxiangPublisher') || keeper;
  section('链上只读核对（v11：攻城令 / 军饷分发）');
  if (controller) {
    await guard('rc.ticket_code_hash', async () => {
      const expectedHash = loadBuildCodeHash('StakeTicket');
      const result = await runGetMethod(params, controller, 'get_ticket_code_hash');
      const actual = stackItemToBigInt((result.stack || [])[0]);
      const actualHex = actual === null ? null : actual.toString(16).padStart(64, '0').slice(-64).toLowerCase();
      addRequired('rc.ticket_code_hash', gateStatus(Boolean(actualHex && expectedHash && actualHex === expectedHash)), actualHex
        ? '链上 0x' + actualHex + ' vs contracts/build ' + (expectedHash || '?') + '（攻城令地址由它推导）'
        : 'getter 返回值无法解析为 uint256');
    });
  }
  if (distributorAddr) {
    await guard('account.junxiangDistributor', async () => {
      const info = await getAddressInformation(params, distributorAddr);
      const state = String(info.state || 'unknown');
      addRequired('account.junxiangDistributor', gateStatus(state === 'active'), 'state=' + state + ' balance=' + info.balance);
      const actual = hexFromCodeHashField(info) || codeHashViaActon(distributorAddr);
      const expected = loadBuildCodeHash('JunxiangDistributor');
      addRequired('junxiang.distributor.code_hash', gateStatus(Boolean(actual && expected && actual === expected)), actual
        ? '链上 ' + actual + ' vs contracts/build ' + (expected || '?')
        : '无法读取线上 code hash');
    });
    await guard('junxiang.distributor.publisher', async () => {
      const result = await runGetMethod(params, distributorAddr, 'get_distributor');
      const stack = result.stack || [];
      const onchainPublisher = addressFromStackItem(stack[0]);
      const expectedPublisher = publisher ? parseAddress(publisher) : null;
      const samePublisher = Boolean(onchainPublisher && expectedPublisher && expectedPublisher.ok
        && onchainPublisher.wc === expectedPublisher.workchain && onchainPublisher.hashHex.toLowerCase() === expectedPublisher.hashHex.toLowerCase());
      addRequired('junxiang.distributor.publisher', gateStatus(samePublisher), '链上 publisher ' + (onchainPublisher ? onchainPublisher.wc + ':' + onchainPublisher.hashHex : '无法解析') + ' vs registry/keeper ' + (publisher || '未登记'));
      const listId = stackItemToBigInt(stack[2]);
      const total = stackItemToBigInt(stack[3]);
      add(check('junxiang.distributor.state', CHECK_STATUS.PASS, 'listId=' + (listId === null ? '?' : listId.toString()) + ' totalPaidRaw=' + (total === null ? '?' : total.toString()) + '（未发布周根时 listId=0）'));
    });
    await guard('junxiang.distributor.jetton_wallet', async () => {
      if (!jettonMaster) return;
      const wallet = await findJettonWallet(params, jettonMaster, distributorAddr);
      const viaMaster = wallet ? wallet.address : canonicalViaActon(jettonMaster, distributorAddr);
      const registryOk = Boolean(viaMaster && distributorWalletAddr && addressEquals(viaMaster, distributorWalletAddr));
      addRequired('junxiang.distributor.jetton_wallet', gateStatus(registryOk), 'master.get_wallet_address(distributor)=' + (viaMaster || '未解析') + '；registry=' + (distributorWalletAddr || '未登记'));
      if (viaMaster) {
        const balance = await getJettonWalletBalance(params, viaMaster);
        add(check('junxiang.distributor.balance', CHECK_STATUS.PASS, (balance === null ? '未读取' : formatTokens(balance.toString()) + ' A9') + '（发布任一周根前必须 ≥ 本期累计总额；未发布时为 0 属正常）'));
      }
    });
  }
}

section('验收结果');

// 必检项覆盖审计：即使没有 FAIL，也必须确认「关键分支真的执行过」，防止栈异常跳过后静默通过。
const REQUIRED_FAMILIES = [
  { key: 'rc.get_protocol_config.shape', min: 1, label: 'get_protocol_config 结构' },
  { key: 'rc.config.', min: 17, label: '协议配置 17 项', prefix: true },
  { key: 'rc.jetton_wallet_code_hash', min: 1, label: 'Jetton Wallet code hash' },
  { key: 'rc.ticket_code_hash', min: 1, label: 'StakeTicket code hash（攻城令）' },
  { key: 'rc.round1.shape', min: 1, label: 'get_round(1) 结构' },
  { key: 'rc.address.', min: 5, label: 'keeper / jettonMaster / RC 钱包 / teamWallet 地址比对', prefix: true },
  { key: 'jetton.wallet.rc', min: 1, label: 'RC 钱包推导一致' },
  { key: 'rc.vault.balance', min: 1, label: 'RC 82 亿注资' },
  { key: 'account.junxiangDistributor', min: 1, label: '军饷分发合约已激活' },
  { key: 'junxiang.distributor.code_hash', min: 1, label: '军饷分发合约 code hash' },
  { key: 'junxiang.distributor.publisher', min: 1, label: '军饷 publisher 一致' },
  { key: 'junxiang.distributor.jetton_wallet', min: 1, label: '军饷分发 Jetton Wallet 推导一致' },
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
