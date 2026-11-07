/**
 * 军饷外部数据源（接口 + 默认实现 + 测试用假实现）。
 *
 *  - PoolTradeSource：STON.fi 官方池子在某时间区间内的 A9 买卖（守城补贴的净买入，guard.ts）。
 *    默认实现 StonfiPoolTradeSource 读 STONFI_POOL_ADDRESS；网络 / 解析失败时抛错（不静默当作 0，避免少发补贴而无人察觉）。
 *  - FundingClusterSource：钱包 → 资金来源簇（同簇视为一人计上限，见 junxiang.ts 的 clusterOf）。
 *    默认实现 TonApiFundingClusterSource 读 TONAPI_URL，取第一笔入账 TON 转账的发送方；失败则回退为钱包自身（identity）。
 *
 * 地址口径：返回的钱包一律由调用方经 addressKey() 归一化后再用。
 */
import type { Env } from '../env';
import { parseTonAddress } from '../indexer/address';

/* ------------------------------------------------------------------ *
 * 池子成交（守城补贴）
 * ------------------------------------------------------------------ */

export interface PoolSwap {
  /** 成交钱包（友好或 raw 形式，由调用方归一化） */
  wallet: string;
  side: 'BUY' | 'SELL';
  /** 成交的 A9 数量（raw，正整数） */
  a9Amount: bigint;
  /** 成交时间（毫秒） */
  ts: number;
}

export interface PoolTradeSource {
  /** 列出某池子在 [fromMs, toMs] 内的全部成交（含两端）。失败应抛错。 */
  listSwaps(poolAddress: string, fromMs: number, toMs: number): Promise<PoolSwap[]>;
}

export interface PoolSourceEnv {
  STONFI_POOL_ADDRESS?: string;
  /** 可选：覆盖 STON.fi API 根地址（默认 https://api.ston.fi） */
  STONFI_API_URL?: string;
}

const STONFI_DEFAULT_API = 'https://api.ston.fi';
const SOURCE_TIMEOUT_MS = 5_000;
const SWAP_PAGE_LIMIT = 500;

/**
 * 解析 STON.fi 成交列表。
 * 注意：STON.fi 公开 API 的成交接口字段名未经本仓库核对，此处按常见字段（wallet / side / a9_amount…）做宽松解析，
 * 上线前必须用真实响应校准（见 StonfiPoolTradeSource 的 TODO）。无法解析的条目直接报错，不跳过。
 */
export function parseStonfiSwaps(json: unknown): PoolSwap[] {
  const list = Array.isArray(json) ? json : (json as { swaps?: unknown[] } | null)?.swaps;
  if (!Array.isArray(list)) throw new Error('stonfi: 成交列表格式不合法');
  return list.map((item, index) => {
    const row = item as Record<string, unknown>;
    const wallet = typeof row.wallet === 'string' ? row.wallet : typeof row.wallet_address === 'string' ? row.wallet_address : null;
    const sideText = typeof row.side === 'string' ? row.side.toUpperCase() : '';
    const amountText = typeof row.a9_amount === 'string' || typeof row.a9_amount === 'number' ? String(row.a9_amount) : null;
    const ts = typeof row.ts === 'number' ? row.ts : typeof row.timestamp === 'number' ? row.timestamp * 1000 : NaN;
    if (!wallet || (sideText !== 'BUY' && sideText !== 'SELL') || !amountText || !/^\d+$/.test(amountText) || !Number.isFinite(ts)) {
      throw new Error(`stonfi: 第 ${index} 条成交无法解析`);
    }
    return { wallet, side: sideText, a9Amount: BigInt(amountText), ts };
  });
}

export class StonfiPoolTradeSource implements PoolTradeSource {
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;

  constructor(apiBase: string = STONFI_DEFAULT_API, fetchImpl: typeof fetch = fetch) {
    this.apiBase = apiBase;
    this.fetchImpl = fetchImpl;
  }

  async listSwaps(poolAddress: string, fromMs: number, toMs: number): Promise<PoolSwap[]> {
    const out: PoolSwap[] = [];
    // TODO(stonfi): 确认成交接口路径与分页参数；当前为单页请求，超过 SWAP_PAGE_LIMIT 条会被截断并报错。
    const url =
      `${this.apiBase.replace(/\/$/, '')}/v1/pools/${encodeURIComponent(poolAddress)}/swaps` +
      `?from_ts=${Math.floor(fromMs / 1000)}&to_ts=${Math.ceil(toMs / 1000)}&limit=${SWAP_PAGE_LIMIT}`;
    const res = await this.fetchImpl(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`stonfi: 成交请求失败 HTTP ${res.status}`);
    const swaps = parseStonfiSwaps(await res.json());
    if (swaps.length >= SWAP_PAGE_LIMIT) throw new Error('stonfi: 成交条数达到分页上限，结果可能不完整');
    for (const swap of swaps) {
      if (swap.ts >= fromMs && swap.ts <= toMs) out.push(swap);
    }
    return out;
  }
}

/** 测试 / 本地演示用：内存里的成交列表。 */
export class InMemoryPoolTradeSource implements PoolTradeSource {
  private readonly swaps: PoolSwap[];

  constructor(swaps: PoolSwap[]) {
    this.swaps = swaps;
  }

  async listSwaps(_poolAddress: string, fromMs: number, toMs: number): Promise<PoolSwap[]> {
    return this.swaps.filter((swap) => swap.ts >= fromMs && swap.ts <= toMs);
  }
}

/** 按 env 选择池子数据源；未配置 STONFI_POOL_ADDRESS 时返回 null（调用方据此不发守城补贴）。 */
export function poolTradeSourceFromEnv(env: PoolSourceEnv): { poolAddress: string; source: PoolTradeSource } | null {
  const poolAddress = env.STONFI_POOL_ADDRESS?.trim();
  if (!poolAddress) return null;
  return { poolAddress, source: new StonfiPoolTradeSource(env.STONFI_API_URL?.trim() || STONFI_DEFAULT_API) };
}

/* ------------------------------------------------------------------ *
 * 资金来源聚类（合并上限）
 * ------------------------------------------------------------------ */

export interface FundingClusterSource {
  /**
   * 返回 wallet → clusterId。无法确定来源的钱包必须映射到其自身（identity 回退），不能缺席。
   * clusterId 与钱包键不同空间（前缀 funder:），避免与 identity 冲突。
   */
  clusterOf(wallets: readonly string[]): Promise<Map<string, string>>;
}

/** identity：每个钱包自成一簇（默认回退）。 */
export class IdentityFundingClusterSource implements FundingClusterSource {
  async clusterOf(wallets: readonly string[]): Promise<Map<string, string>> {
    return new Map(wallets.map((wallet) => [wallet, wallet]));
  }
}

/**
 * 解析 TON API 交易列表（按时间升序），取第一笔「有发送方且金额 > 0」的入账消息的发送方 raw 地址。
 * 找不到返回 null。字段结构按 TON API v2 的 transactions 形状（in_msg.source.address / in_msg.value）假设，
 * 上线前需用真实响应校准。
 */
export function firstIncomingSenderOf(json: unknown): string | null {
  const txs = (json as { transactions?: unknown[] } | null)?.transactions;
  if (!Array.isArray(txs)) return null;
  for (const tx of txs) {
    const inMsg = (tx as { in_msg?: { source?: { address?: unknown } | null; value?: unknown } | null } | null)?.in_msg;
    const address = inMsg?.source?.address;
    if (typeof address !== 'string' || address.length === 0) continue;
    const value = Number(inMsg?.value ?? 0);
    if (!(value > 0)) continue;
    return parseTonAddress(address)?.raw ?? address;
  }
  return null;
}

export class TonApiFundingClusterSource implements FundingClusterSource {
  /** 进程内缓存：资金来源一旦确定不会变化（失败不缓存）。 */
  private readonly cache = new Map<string, string>();
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, fetchImpl: typeof fetch = fetch) {
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
  }

  private async senderOf(wallet: string): Promise<string | null> {
    const hit = this.cache.get(wallet);
    if (hit !== undefined) return hit;
    try {
      const url = `${this.baseUrl.replace(/\/$/, '')}/v2/accounts/${encodeURIComponent(wallet)}/transactions?limit=50&sort_order=asc`;
      const res = await this.fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS) });
      if (!res.ok) return null;
      const sender = firstIncomingSenderOf(await res.json());
      if (sender) this.cache.set(wallet, sender);
      return sender;
    } catch {
      return null;
    }
  }

  async clusterOf(wallets: readonly string[]): Promise<Map<string, string>> {
    const senders = await Promise.all(wallets.map((wallet) => this.senderOf(wallet)));
    const out = new Map<string, string>();
    wallets.forEach((wallet, index) => {
      const sender = senders[index];
      out.set(wallet, sender ? `funder:${sender}` : wallet);
    });
    return out;
  }
}

/** 按 env 选择资金来源：配置了 TONAPI_URL 用 TON API，否则 identity。 */
export function fundingClusterSourceFromEnv(env: { TONAPI_URL?: string }): FundingClusterSource {
  const base = env.TONAPI_URL?.trim();
  return base ? new TonApiFundingClusterSource(base) : new IdentityFundingClusterSource();
}

export type SourcesEnv = Env & PoolSourceEnv & { TONAPI_URL?: string };
