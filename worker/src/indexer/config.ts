/**
 * 索引器运行时配置：地址/端点/期望配置版本/HASH/轮询节奏。
 * 全部从 env 读取（不新增全局状态，便于测试）；缺关键项时返回错误而不是猜默认值。
 */
import type { Env } from '../env';
import { parseTonAddress, type TonAddress } from './address';
import { sha256Hex } from './boc';

export type ChainNetwork = 'testnet' | 'mainnet';

/**
 * get_protocol_config() 的 22 个槽位（顺序 = 合约声明顺序，不可改，否则 config hash 失真）。
 * v10 沿用 v8.9 的槽位名（canonical hash 依赖这些名字）：admin = oracle = keeper，teamVault = 团队钱包，
 * techAbortPauseSeconds = techAbortObsTimeoutSeconds = 统一的 7 天技术终止超时。
 */
export interface ProtocolConfigFields {
  admin: string;
  oracle: string;
  jettonMaster: string;
  stakingJettonWallet: string;
  teamVault: string;
  p0UsdE8: string;
  priceMultiplier: string;
  roundRewardRaw: string;
  teamRoundRaw: string;
  minStakeRaw: string;
  maxStakePerAddressBps: string;
  maxTotalStakeRaw: string;
  previewSeconds: string;
  stakeDurationSeconds: string;
  candleSeconds: string;
  candleCount: string;
  minQualifiedCandles: string;
  observationSeconds: string;
  techAbortPauseSeconds: string;
  techAbortObsTimeoutSeconds: string;
  riskDisclosureVersion: string;
  configVersion: string;
}

/** 字段顺序表：canonical hash 与解析都依赖它。 */
export const PROTOCOL_CONFIG_KEYS: readonly (keyof ProtocolConfigFields)[] = [
  'admin',
  'oracle',
  'jettonMaster',
  'stakingJettonWallet',
  'teamVault',
  'p0UsdE8',
  'priceMultiplier',
  'roundRewardRaw',
  'teamRoundRaw',
  'minStakeRaw',
  'maxStakePerAddressBps',
  'maxTotalStakeRaw',
  'previewSeconds',
  'stakeDurationSeconds',
  'candleSeconds',
  'candleCount',
  'minQualifiedCandles',
  'observationSeconds',
  'techAbortPauseSeconds',
  'techAbortObsTimeoutSeconds',
  'riskDisclosureVersion',
  'configVersion',
] as const;

/**
 * ORACLE_CONFIG_HASH 的 canonical 规则（与 tools/chain-reconcile.mjs 必须逐字节一致）：
 *  1. 取 get_protocol_config() 22 槽，顺序即 PROTOCOL_CONFIG_KEYS；
 *  2. 地址槽编码为 "<workchain>:<64 位小写 hex>"；整数槽编码为十进制字符串（无 0x、无前导零）；
 *  3. JSON.stringify({ v: 1, network, fields: { ...按声明顺序... } })，UTF-8、无空格；
 *  4. hash = "sha256:" + sha256(utf8).hex（小写）。
 * 注意：network 参与哈希，testnet/mainnet 的同参数实例 hash 不同（这是有意的，防止跨网误配）。
 */
export async function protocolConfigDigest(network: ChainNetwork, fields: ProtocolConfigFields): Promise<string> {
  const ordered: Record<string, string> = {};
  for (const key of PROTOCOL_CONFIG_KEYS) ordered[key] = String(fields[key]);
  const canonical = JSON.stringify({ v: 1, network, fields: ordered });
  const bytes = new TextEncoder().encode(canonical);
  return 'sha256:' + (await sha256Hex(bytes));
}

export interface ChainConfig {
  network: ChainNetwork;
  v2Url: string;
  v3Url: string;
  /** 备用端点（主端点连续失败时切换）；未配置为 null */
  v2FallbackUrl: string | null;
  v3FallbackUrl: string | null;
  apiKey: string | null;
  /** 无 key 直连公共端点（仅本地调试；会强制 ≥5s 间隔） */
  allowPublic: boolean;
  addresses: {
    roundController: TonAddress;
    /** v11 军饷分发合约；可选（未配置 / 占位符为 null） */
    junxiangDistributor: TonAddress | null;
    jettonMaster: TonAddress;
    /** 团队收款钱包（成功轮 RC 直接转 1.2 亿；对应 get_protocol_config 的 teamVault 槽） */
    teamWallet: TonAddress;
    /** 唯一 keeper（对应 get_protocol_config 的 admin/oracle 槽） */
    keeper: TonAddress;
  };
  expectedConfigVersion: number | null;
  expectedConfigHash: string | null;
  leaseSeconds: number;
  /** 覆盖客户端最小请求间隔（ms）；仅开发者工具使用，生产走 apiKey/allowPublic 推导 */
  minIntervalMs?: number;
}

export type ChainConfigResult = { ok: true; config: ChainConfig } | { ok: false; error: string };

function resolveNetwork(env: Env): ChainNetwork {
  return (env.CHAIN_NETWORK ?? '').trim().toLowerCase() === 'mainnet' ? 'mainnet' : 'testnet';
}

function trimmed(value: string | undefined): string {
  return (value ?? '').trim();
}

/** 读取 env 生成链上索引器配置；缺地址/缺 key 等返回可读错误。 */
export function resolveChainConfig(env: Env): ChainConfigResult {
  const network = resolveNetwork(env);
  const apiKey = trimmed(env.TONCENTER_API_KEY) || null;
  const allowPublic = trimmed(env.TONCENTER_ALLOW_PUBLIC) === '1';
  if (!apiKey && !allowPublic) {
    return { ok: false, error: 'chain 模式缺少 TONCENTER_API_KEY（仅本地调试可显式 TONCENTER_ALLOW_PUBLIC=1）' };
  }
  const defaults = network === 'mainnet' ? 'https://toncenter.com/api' : 'https://testnet.toncenter.com/api';
  const v2Url = trimmed(env.TONCENTER_V2_URL) || defaults + '/v2';
  const v3Url = trimmed(env.TONCENTER_V3_URL) || defaults + '/v3';

  const rc = parseTonAddress(trimmed(env.ROUND_CONTROLLER_ADDRESS));
  if (!rc) return { ok: false, error: 'ROUND_CONTROLLER_ADDRESS 缺失或非法：' + trimmed(env.ROUND_CONTROLLER_ADDRESS) };
  const tw = parseTonAddress(trimmed(env.TEAM_WALLET_ADDRESS));
  if (!tw) return { ok: false, error: 'TEAM_WALLET_ADDRESS 缺失或非法：' + trimmed(env.TEAM_WALLET_ADDRESS) };
  const keeper = parseTonAddress(trimmed(env.KEEPER_ADDRESS));
  if (!keeper) return { ok: false, error: 'KEEPER_ADDRESS 缺失或非法：' + trimmed(env.KEEPER_ADDRESS) };
  const jm = parseTonAddress(trimmed(env.JETTON_MASTER_ADDRESS));
  if (!jm) return { ok: false, error: 'JETTON_MASTER_ADDRESS 缺失或非法：' + trimmed(env.JETTON_MASTER_ADDRESS) };

  // optional: a placeholder (contains "__") or an invalid value means "not deployed yet"
  const jxText = trimmed(env.JUNXIANG_DISTRIBUTOR_ADDRESS);
  const jx = jxText && !jxText.includes('__') ? parseTonAddress(jxText) : null;

  const versionText = trimmed(env.ORACLE_CONFIG_VERSION);
  const expectedConfigVersion = versionText ? Number.parseInt(versionText, 10) : null;
  if (versionText && !Number.isFinite(expectedConfigVersion)) {
    return { ok: false, error: 'ORACLE_CONFIG_VERSION 不是整数：' + versionText };
  }
  const hashText = trimmed(env.ORACLE_CONFIG_HASH).toLowerCase();
  const expectedConfigHash = hashText ? (hashText.startsWith('sha256:') ? hashText : 'sha256:' + hashText) : null;
  const leaseText = Number.parseInt(trimmed(env.INDEXER_LEASE_SECONDS) || '120', 10);
  const leaseSeconds = Number.isFinite(leaseText) && leaseText > 0 ? Math.min(leaseText, 900) : 120;

  return {
    ok: true,
    config: {
      network,
      v2Url,
      v3Url,
      v2FallbackUrl: null,
      v3FallbackUrl: null,
      apiKey,
      allowPublic,
      addresses: { roundController: rc, jettonMaster: jm, teamWallet: tw, keeper, junxiangDistributor: jx },
      expectedConfigVersion,
      expectedConfigHash,
      leaseSeconds,
    },
  };
}
