/**
 * STON.fi 池子储备读取（公开 API，30 秒缓存）。
 * 解析函数 usdtReserveFromPool 为纯函数；网络请求失败一律返回 null，不抛错。
 */
import { addressEquals } from '../indexer/address';
import { USDT_DECIMALS, USDT_MASTER_ADDRESS } from './common';

const POOL_CACHE_MS = 30_000;
const FETCH_TIMEOUT_MS = 3_000;
const STONFI_API = 'https://api.ston.fi/v1/pools/';

interface CacheEntry {
  at: number;
  value: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * 从 STON.fi 池子 JSON 取 USDT 侧储备（USD，已按 6 位小数换算）。
 * 兼容 { pool: {...} } 与裸对象两种形状；找不到 USDT 一侧或数值非法时返回 null。
 */
export function usdtReserveFromPool(json: unknown, usdtMaster: string = USDT_MASTER_ADDRESS): number | null {
  if (!json || typeof json !== 'object') return null;
  const root = json as Record<string, unknown>;
  const pool = (root.pool && typeof root.pool === 'object' ? root.pool : root) as Record<string, unknown>;
  const sides: Array<[string, string]> = [
    ['token0_address', 'reserve0'],
    ['token1_address', 'reserve1'],
  ];
  for (const [addressField, reserveField] of sides) {
    const token = pool[addressField];
    if (typeof token !== 'string' || !addressEquals(token, usdtMaster)) continue;
    const raw = pool[reserveField];
    if (typeof raw !== 'string' && typeof raw !== 'number') return null;
    const reserve = Number(raw);
    if (!Number.isFinite(reserve) || reserve < 0) return null;
    return reserve / 10 ** USDT_DECIMALS;
  }
  return null;
}

export async function poolUsdt(poolAddress: string, now = Date.now()): Promise<number | null> {
  const hit = cache.get(poolAddress);
  if (hit && now - hit.at < POOL_CACHE_MS) return hit.value;
  try {
    const res = await fetch(STONFI_API + encodeURIComponent(poolAddress), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const value = usdtReserveFromPool(await res.json());
    if (value === null) return null;
    cache.set(poolAddress, { at: now, value });
    return value;
  } catch {
    return null;
  }
}
