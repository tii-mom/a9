/**
 * 离线 fixture 客户端（开发者工具）：按 fixture-server.mjs 同样的键与语义回放 v2 runGetMethod / v3 transactions，
 * 让 selfcheck 可以不经 HTTP、零网络地跑在 fixture 上。不参与 worker 运行时。
 */
import type { ChainClient, ChainTx, GetMethodResult, StackArg, TransactionQuery } from '../chain-client';

export interface FixtureFile {
  meta: Record<string, unknown> & { network?: string; rc: string; jm: string; tw?: string; keeper?: string };
  v2: Record<string, { ok: boolean; result?: { stack?: unknown[]; exit_code?: number }; error?: string }>;
  v3: { transactions: Record<string, ChainTx[]> };
}

/** fixture v2 键：method|address|JSON(stack)（与 fixture-server.mjs 一致）。 */
export function getterKey(address: string, method: string, stack: readonly StackArg[] = []): string {
  return method + '|' + address + '|' + JSON.stringify(stack);
}

export function createFixtureClient(fixtures: FixtureFile): ChainClient {
  return {
    network: fixtures.meta.network === 'mainnet' ? 'mainnet' : 'testnet',
    async runGetMethod(address: string, method: string, stack: readonly StackArg[] = []): Promise<GetMethodResult> {
      const response = fixtures.v2[getterKey(address, method, stack)];
      if (!response || !response.ok || !response.result) throw new Error('fixture 未录制该 getter：' + getterKey(address, method, stack));
      return { stack: response.result.stack ?? [], exitCode: response.result.exit_code ?? 0 };
    },
    async transactions(query: TransactionQuery): Promise<ChainTx[]> {
      const all = fixtures.v3.transactions[query.account];
      if (!all) throw new Error('fixture 未录制该账户交易：' + query.account);
      let list = all.filter((tx) => !query.startLt || BigInt(tx.lt) >= BigInt(query.startLt));
      list = list.sort((a, b) => (BigInt(a.lt) < BigInt(b.lt) ? -1 : 1));
      if (query.sort === 'desc') list.reverse();
      return list.slice(0, Math.min(query.limit ?? 100, 100));
    },
    endpointLabel(): string {
      return 'fixture';
    },
  };
}
