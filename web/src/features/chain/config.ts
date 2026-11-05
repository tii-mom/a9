/**
 * 链上配置：从 /api/config 的 contracts 字段派生（字段由后端下发，未配置则保持演示模式）。
 * 允许后端通过 contracts 里的可选扩展字段覆盖网络端点与质押限额（向后兼容，缺省用默认值）。
 */

import type { ApiError } from '../../lib/api';
import { api, useQuery } from '../../lib/api';
import type { DataSource, ProtocolConfig } from '@shared/types';
import { base64Decode, base64UrlEncode } from './address';
import {
  DEFAULT_MAX_STAKE_PER_ADDRESS_BPS,
  DEFAULT_MAX_TOTAL_STAKE_TOKENS,
  DEFAULT_MIN_STAKE_TOKENS,
  DEFAULT_TOKEN_DECIMALS,
} from './protocol';

export type ChainNetwork = 'mainnet' | 'testnet';
export type ChainDisabledReason = 'no-config' | 'demo' | 'no-contracts';

export interface ChainConfig {
  /** 合约地址齐备且网络为 mainnet/testnet 时为 true */
  configured: boolean;
  /** 未启用原因，供 UI 提示 */
  disabledReason: ChainDisabledReason | null;
  network: ChainNetwork | 'demo';
  /** TON Connect 的 ChainId */
  chainId: '-239' | '-3' | null;
  toncenterBaseUrl: string;
  /** 可选：toncenter API key（无 key 时公共限流） */
  toncenterApiKey: string | null;
  tonapiBaseUrl: string;
  explorerBaseUrl: string;
  roundController: string | null;
  jettonMaster: string | null;
  teamVault: string | null;
  oracleAdapter: string | null;
  riskDisclosureVersion: number;
  tokenDecimals: number;
  roundCount: number;
  minStakeRaw: bigint;
  maxTotalStakeRaw: bigint;
  /** 单地址固定硬顶（raw，V6.1 = 20,000,000 A9） */
  maxStakePerAddressRaw: bigint;
  /** 旧口径（bps），仅为兼容保留；前端校验以 maxStakePerAddressRaw 为准 */
  maxStakePerAddressBps: number;
  // ---- V8 权重制 / 奖励三态 / 邀请 / 解锁（shared/types ProtocolConfig 已定稿） ----
  /** 连续参与每轮权重加成（bps，1000 = +10%） */
  streakBonusBps: number;
  /** 连续参与加成封顶轮次（10 → 最高 2.00×） */
  streakMaxRounds: number;
  /** 直接邀请加成（bps，2000 = 被邀请人质押的 20%） */
  referralBonusBps: number;
  /** 邀请加成封顶 = 邀请人自己质押额（bps，10000 = 1.0×） */
  referralCapMultiple: number;
  /** 早领比例（bps，5000 = 先拿 50%） */
  earlyClaimPenaltyBps: number;
  /** 单地址单轮滚存上限（raw） */
  rolloverCapPerAddressRaw: bigint;
  /** R10 终态后线性解锁时长（秒） */
  unlockDurationSeconds: number;
  dataSource: DataSource;
  tonConnectManifestUrl: string | null;
}

function contractExtra(config: ProtocolConfig | null, key: string): string | null {
  if (!config) return null;
  const contracts = config.contracts as unknown as Record<string, unknown>;
  const value = contracts?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseRawExtra(value: string | null, fallback: bigint): bigint {
  if (!value) return fallback;
  try {
    const parsed = BigInt(value);
    return parsed > 0n ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function parseBpsExtra(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 10000 ? Math.floor(parsed) : fallback;
}

/** 后端配置 → 前端链上配置。 */
export function deriveChainConfig(config: ProtocolConfig | null): ChainConfig {
  const decimals = config?.token.decimals ?? DEFAULT_TOKEN_DECIMALS;
  const network: ChainNetwork | 'demo' =
    config?.network === 'mainnet' ? 'mainnet' : config?.network === 'testnet' ? 'testnet' : 'demo';
  const testnet = network === 'testnet';
  const tokenUnit = 10n ** BigInt(decimals);

  const roundController = config?.contracts.roundController?.trim() || null;
  const jettonMaster = config?.contracts.jettonMaster?.trim() || null;

  // 限额：与合约公式一致——perAddressCap = maxTotalStakeRaw × maxStakePerAddressBps / 10000
  // （V6.1 定稿：200,000,000 × 1000 / 10000 = 20,000,000 A9 固定硬顶，不是动态比例）
  const maxTotalStakeRaw = parseRawExtra(contractExtra(config, 'maxTotalStakeRaw'), DEFAULT_MAX_TOTAL_STAKE_TOKENS * tokenUnit);
  const maxStakePerAddressBps = parseBpsExtra(
    contractExtra(config, 'maxStakePerAddressBps'),
    DEFAULT_MAX_STAKE_PER_ADDRESS_BPS,
  );
  const derivedPerAddressCap = (maxTotalStakeRaw * BigInt(maxStakePerAddressBps)) / 10000n;

  let disabledReason: ChainDisabledReason | null = null;
  if (!config) disabledReason = 'no-config';
  else if (network === 'demo') disabledReason = 'demo';
  else if (!roundController || !jettonMaster) disabledReason = 'no-contracts';

  return {
    configured: disabledReason === null,
    disabledReason,
    network,
    chainId: network === 'mainnet' ? '-239' : network === 'testnet' ? '-3' : null,
    toncenterBaseUrl:
      contractExtra(config, 'toncenterBaseUrl') ?? (testnet ? 'https://testnet.toncenter.com' : 'https://toncenter.com'),
    toncenterApiKey: contractExtra(config, 'toncenterApiKey'),
    tonapiBaseUrl: contractExtra(config, 'tonapiBaseUrl') ?? (testnet ? 'https://testnet.tonapi.io' : 'https://tonapi.io'),
    explorerBaseUrl:
      contractExtra(config, 'explorerBaseUrl') ?? (testnet ? 'https://testnet.tonscan.org' : 'https://tonscan.org'),
    roundController,
    jettonMaster,
    teamVault: config?.contracts.teamVault?.trim() || null,
    oracleAdapter: config?.contracts.oracleAdapter?.trim() || null,
    riskDisclosureVersion: config?.riskDisclosureVersion ?? 1,
    tokenDecimals: decimals,
    roundCount: config?.roundCount ?? 10,
    minStakeRaw: parseRawExtra(contractExtra(config, 'minStakeRaw'), DEFAULT_MIN_STAKE_TOKENS * tokenUnit),
    maxTotalStakeRaw,
    maxStakePerAddressRaw: parseRawExtra(contractExtra(config, 'maxStakePerAddressRaw'), derivedPerAddressCap),
    maxStakePerAddressBps,
    // V8：字段由 shared/types ProtocolConfig 定稿；缺失时按合约/文档缺省值兜底
    streakBonusBps: config?.streakBonusBps ?? 1000,
    streakMaxRounds: config?.streakMaxRounds ?? 10,
    referralBonusBps: config?.referralBonusBps ?? 2000,
    referralCapMultiple: config?.referralCapMultiple ?? 10000,
    earlyClaimPenaltyBps: config?.earlyClaimPenaltyBps ?? 5000,
    rolloverCapPerAddressRaw: parseRawExtra(config?.rolloverCapPerAddressRaw ?? null, 20_000_000n * tokenUnit),
    unlockDurationSeconds: config?.unlockDurationSeconds ?? 31_104_000,
    dataSource: config?.dataSource ?? 'demo',
    tonConnectManifestUrl: config?.tonConnectManifestUrl ?? null,
  };
}

export interface ChainConfigState {
  chain: ChainConfig;
  raw: ProtocolConfig | null;
  loading: boolean;
  error: ApiError | null;
  refresh: () => void;
}

/** 读取并轮询 /api/config（30s）。 */
export function useChainConfig(): ChainConfigState {
  const query = useQuery(() => api.config(), [], { intervalMs: 30000 });
  return {
    chain: deriveChainConfig(query.data),
    raw: query.data,
    loading: query.loading,
    error: query.error,
    refresh: query.refresh,
  };
}

/** 交易哈希统一转 url-safe base64（tonscan / tonviewer 均接受）。 */
export function toExplorerHash(hash: string): string {
  const value = String(hash ?? '').trim();
  if (!value) return '';
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
    return base64UrlEncode(bytes);
  }
  try {
    return base64UrlEncode(base64Decode(value));
  } catch {
    return value;
  }
}

export function explorerTxUrl(chain: ChainConfig, hash: string | null | undefined): string | null {
  const value = toExplorerHash(hash ?? '');
  if (!value) return null;
  return chain.explorerBaseUrl + '/tx/' + value;
}

export function explorerAddressUrl(chain: ChainConfig, address: string | null | undefined): string | null {
  const value = String(address ?? '').trim();
  if (!value) return null;
  return chain.explorerBaseUrl + '/address/' + value;
}
