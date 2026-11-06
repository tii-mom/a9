/** 地址登记表（v10）：唯一事实来源（地址 + 部署交易 + 配置哈希）。 */

import { createHash } from 'node:crypto';
import { existsSync, renameSync } from 'node:fs';
import { DEFAULT_REGISTRY, OPS_ROOT, TEMPLATE_REGISTRY, readJSON, writeJSON } from './config.mjs';
import { parseAddress, validateTestnetAddress } from './ton.mjs';

// v10（D-42）：只有 JettonMaster + 标准 JettonWallet + 一个 RoundController。
// RC 的 Jetton Wallet 同时托管 70 亿奖励 + 12 亿团队额度 + 质押本金。
export const CONTRACT_KEYS = [
  'jettonMaster',
  'jettonMasterTreasuryWallet',
  'roundController',
  'roundControllerJettonWallet',
  'teamWalletJettonWallet',
];

// 没有 admin：keeper 是唯一的运营热钱包（OpenRound / SubmitCandle）。
export const WALLET_KEYS = [
  'keeper',
  'treasury',
  'teamWallet',
  'marketingWallet',
  'liquidityWallet',
  'teamInternalWallet',
];

/** 注资种类：RC 82 亿（奖励 + 团队，forward 0）+ 内盘 / 流动性 / 营销。 */
export const FUNDING_KINDS = ['roundController', 'internalSale', 'liquidity', 'marketing'];

function nowIso() {
  return new Date().toISOString();
}

export function emptyRegistry() {
  const contracts = {};
  for (const key of CONTRACT_KEYS) {
    contracts[key] = { address: null, raw: null, deployTxHash: null, codeHash: null, deployedAt: null, note: null };
  }
  const wallets = {};
  for (const key of WALLET_KEYS) {
    const isPublic = key === 'teamInternalWallet';
    wallets[key] = { address: null, raw: null, testnet: null, public: isPublic, note: null };
  }
  return {
    network: 'testnet',
    chainId: -3,
    status: 'not_deployed',
    contractsVersion: 'v10',
    configVersion: 1,
    paramsDigest: null,
    codeHashes: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
    contracts,
    wallets,
    bindings: {
      roundControllerJettonWalletOwner: null,
      roundControllerKeeper: null,
      roundControllerTeamWallet: null,
      roundControllerUpgradeable: false,
      hasAdmin: false,
    },
    funding: [],
    verification: { lastRunAt: null, healthy: null, checks: [], digest: null },
    notes: [],
  };
}

export function registryPath() {
  return process.env.OPS_REGISTRY || DEFAULT_REGISTRY;
}

export function loadRegistry({ create = true } = {}) {
  const path = registryPath();
  if (!existsSync(path)) {
    if (!create) return null;
    const template = existsSync(TEMPLATE_REGISTRY) ? readJSON(TEMPLATE_REGISTRY) : emptyRegistry();
    template.createdAt = template.createdAt || nowIso();
    template.updatedAt = nowIso();
    writeRegistry(template);
    return template;
  }
  return readJSON(path);
}

export function writeRegistry(registry) {
  const path = registryPath();
  registry.updatedAt = nowIso();
  const temporary = path + '.tmp';
  writeJSON(temporary, registry);
  renameSync(temporary, path);
  return registry;
}

export function setContract(registry, key, address, meta = {}) {
  if (!CONTRACT_KEYS.includes(key)) throw new Error('未知合约 key：' + key);
  const validation = validateTestnetAddress(address, key);
  if (!validation.ok) throw new Error(validation.message);
  const parsed = validation.parsed;
  registry.contracts[key] = {
    ...registry.contracts[key],
    address,
    raw: parsed.raw,
    deployTxHash: meta.deployTxHash || registry.contracts[key].deployTxHash || null,
    codeHash: meta.codeHash || registry.contracts[key].codeHash || null,
    deployedAt: meta.deployedAt || registry.contracts[key].deployedAt || nowIso(),
    note: meta.note || registry.contracts[key].note || null,
  };
  refreshStatus(registry);
  return registry.contracts[key];
}

export function setWallet(registry, key, address, meta = {}) {
  if (!WALLET_KEYS.includes(key)) throw new Error('未知钱包 key：' + key);
  const validation = validateTestnetAddress(address, key);
  if (!validation.ok) throw new Error(validation.message);
  const parsed = validation.parsed;
  registry.wallets[key] = {
    ...registry.wallets[key],
    address,
    raw: parsed.raw,
    testnet: parsed.testnet,
    note: meta.note || registry.wallets[key].note || null,
  };
  refreshStatus(registry);
  return registry.wallets[key];
}

export function getAddress(registry, key) {
  if (CONTRACT_KEYS.includes(key)) return registry.contracts[key] && registry.contracts[key].address;
  if (WALLET_KEYS.includes(key)) return registry.wallets[key] && registry.wallets[key].address;
  return null;
}

export function refreshStatus(registry) {
  const required = ['jettonMaster', 'roundController'];
  const deployed = required.filter((key) => registry.contracts[key] && registry.contracts[key].address);
  const confirmedKinds = new Set((registry.funding || []).filter((item) => item.confirmed === true).map((item) => item.kind));
  if (deployed.length === 0) registry.status = 'not_deployed';
  else if (deployed.length < required.length) registry.status = 'partially_deployed';
  else if (confirmedKinds.size === 0) registry.status = 'deployed_unfunded';
  else if (FUNDING_KINDS.every((kind) => confirmedKinds.has(kind))) registry.status = 'funded';
  else registry.status = 'deployed_funded_partial';
  registry.paramsDigest = registry.paramsDigest || null;
  return registry.status;
}

export function recordFunding(registry, entry) {
  const key = entry.kind + ':' + (entry.recipient || '') + ':' + (entry.amountRaw || '');
  const exists = (registry.funding || []).find((item) => item.key === key);
  if (exists) return exists;
  const record = { key, at: nowIso(), confirmed: false, ...entry };
  registry.funding = registry.funding || [];
  registry.funding.push(record);
  refreshStatus(registry);
  return record;
}

export function registryDigest(registry) {
  const stable = JSON.stringify({
    contracts: registry.contracts,
    wallets: registry.wallets,
    bindings: registry.bindings,
    paramsDigest: registry.paramsDigest,
  });
  return 'sha256:' + createHash('sha256').update(stable).digest('hex');
}

export function summarize(registry) {
  return {
    path: registryPath(),
    status: registry.status,
    paramsDigest: registry.paramsDigest,
    contracts: Object.entries(registry.contracts)
      .filter(([, value]) => value.address)
      .map(([key, value]) => ({ key, address: value.address, explorer: value.address })),
    wallets: WALLET_KEYS.map((key) => ({ key, address: registry.wallets[key] ? registry.wallets[key].address : null })),
    funding: registry.funding,
  };
}

export function relativeRegistryPath() {
  return registryPath().replace(OPS_ROOT + '/', '');
}
