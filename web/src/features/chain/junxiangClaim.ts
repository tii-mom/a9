/**
 * 军饷链上前置检查（领取前必须通过，避免用户白付 0.2 TON）：
 *   1. 分发合约 get_distributor().root 必须等于 API 下发的清单根（不一致 = 清单尚未上链）；
 *   2. 读取该钱包的 ClaimRecord.claimedRaw（未部署记录 = 0），仅当 cumulativeRaw > claimedRaw 才可领取。
 * 只读查询；发送交易见 junxiang.ts 与 useJunxiangClaim.ts。
 */

import { parseTonAddress, toRawAddress } from './address';
import type { ChainConfig } from './config';
import { chainError } from './errors';
import { junxiangDistributorAddress, JUNXIANG_GET } from './junxiang';
import { callGetter, ownerStackArgs, rawFromStackValue, stackNum } from './rpc';

/** 分发合约当前已上链的清单根（uint256，数值）。 */
export async function fetchDistributorRoot(chain: ChainConfig): Promise<bigint> {
  const distributor = junxiangDistributorAddress(chain);
  const call = await callGetter(chain, toRawAddress(distributor), JUNXIANG_GET.distributor, []);
  // DistributorView: publisher, root, listId, totalPaidRaw
  if (call.exitCode !== 0 || call.items.length < 2) {
    throw chainError('NETWORK_ERROR', 'get_distributor exit_code=' + call.exitCode, JUNXIANG_GET.distributor);
  }
  const root = stackNum(call.items[1]);
  if (root === null) throw chainError('NETWORK_ERROR', 'get_distributor.root 无法解析', JUNXIANG_GET.distributor);
  return root;
}

/**
 * 该钱包在链上已领取的累计额（ClaimRecord.claimedRaw）。
 * 记录合约未部署（从未领取）时 exit_code = -13，视为 0；其余读取失败抛错，不得把失败显示成 0。
 */
export async function fetchClaimedRaw(chain: ChainConfig, owner: string): Promise<bigint> {
  const distributor = toRawAddress(junxiangDistributorAddress(chain));
  let ownerAddress;
  try {
    ownerAddress = parseTonAddress(owner);
  } catch {
    throw chainError('BAD_CONFIG', '钱包地址不合法', owner);
  }
  let recordAddress: string | null = null;
  let lastError: Error | null = null;
  for (const ownerArg of ownerStackArgs(ownerAddress)) {
    try {
      const call = await callGetter(chain, distributor, JUNXIANG_GET.recordAddress, ownerArg);
      if (call.exitCode !== 0) {
        lastError = chainError('NETWORK_ERROR', JUNXIANG_GET.recordAddress + ' exit_code=' + call.exitCode, JUNXIANG_GET.recordAddress);
        continue;
      }
      recordAddress = rawFromStackValue((call.items[0] as { value?: unknown } | undefined)?.value);
      if (recordAddress) break;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  if (!recordAddress) throw lastError ?? chainError('NETWORK_ERROR', '无法推导领取记录地址', JUNXIANG_GET.recordAddress);

  const call = await callGetter(chain, recordAddress, JUNXIANG_GET.record, []);
  if (call.exitCode === -13) return 0n; // 记录未部署：从未领取
  // RecordView: distributor, owner, claimedRaw
  if (call.exitCode !== 0 || call.items.length < 3) {
    throw chainError('NETWORK_ERROR', 'get_record exit_code=' + call.exitCode, JUNXIANG_GET.record);
  }
  const claimed = stackNum(call.items[2]);
  if (claimed === null) throw chainError('NETWORK_ERROR', 'get_record.claimedRaw 无法解析', JUNXIANG_GET.record);
  return claimed;
}

/** 十六进制根 → 数值；非法返回 null（视为与链上不一致）。 */
export function rootValueOf(hex: string | null | undefined): bigint | null {
  const text = String(hex ?? '').trim();
  if (!/^[0-9a-fA-F]{1,64}$/.test(text)) return null;
  return BigInt('0x' + text);
}
