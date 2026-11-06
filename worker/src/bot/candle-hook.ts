/**
 * K 线亮灯推送钩子（docs/35 §4.1「每根 K 线亮灯」）。
 *
 * indexer/sync.ts 每个 tick 只把本批摄入的 SubmitCandle（轮次 / 序号 / TWAP / 目标价）收集成列表，
 * 落库后调用一次 pushNewCandleLamps。本文件负责：
 *  - 去重：bot_pushes 以 (round_id, candle_index) 为主键，INSERT OR IGNORE 占位成功才推送，
 *    同一根只推一次；索引器重放、重复摄入、reindex 都不会重推；
 *  - 组装 CandleEvent（USD_E8 → number；亮灯 = twap >= 目标价；最后一根带结算结果）；
 *  - 永不抛出：推送失败只记日志，不能影响索引器。未配置 TG_BOT_TOKEN 时直接跳过（不读写库）。
 */
import * as db from './db';
import { CANDLES_TOTAL, LIT_NEEDED } from './format';
import { pushCandleUpdate } from './index';
import type { BotEnv, CandleEvent } from './types';

/** 一根新摄入 K 线的推送输入（USD_E8 原始值）。 */
export interface CandleLampInput {
  roundId: number;
  /** 第几根（1..24） */
  candleIndex: number;
  /** 本根 TWAP（USD_E8） */
  twapUsdE8: bigint;
  /** 本轮目标价（USD_E8） */
  targetUsdE8: bigint;
}

/** USD_E8（1e-8 美元）→ 美元数值。 */
export function usdE8ToNumber(value: bigint): number {
  return Number(value) / 1e8;
}

export interface CandleHookDeps {
  /** 单条推送函数（测试注入用，默认 pushCandleUpdate） */
  push?: (env: BotEnv, ev: CandleEvent) => Promise<number>;
  /** 当前毫秒时间戳（测试注入用） */
  now?: () => number;
}

/**
 * 推送本批新摄入的 K 线亮灯。返回本次真正推送（未被去重拦下）的根数。永不抛出。
 */
export async function pushNewCandleLamps(env: BotEnv, items: CandleLampInput[], deps: CandleHookDeps = {}): Promise<number> {
  try {
    if (!env.TG_BOT_TOKEN || items.length === 0) return 0;
    const push = deps.push ?? pushCandleUpdate;
    const now = deps.now ? deps.now() : Date.now();
    // 按轮次、序号升序推送，保证群里的消息顺序与 K 线顺序一致
    const ordered = [...items].sort((a, b) => a.roundId - b.roundId || a.candleIndex - b.candleIndex);

    let pushed = 0;
    for (const item of ordered) {
      try {
        const fresh = await db.claimCandlePush(env.DB, item.roundId, item.candleIndex, now);
        if (!fresh) continue;

        const litCount = await db.countLitCandles(env.DB, item.roundId, item.candleIndex);
        const ev: CandleEvent = {
          roundId: item.roundId,
          candleIndex: item.candleIndex,
          lit: item.twapUsdE8 >= item.targetUsdE8,
          needed: LIT_NEEDED,
          total: CANDLES_TOTAL,
          priceUsd: usdE8ToNumber(item.twapUsdE8),
          gatePriceUsd: usdE8ToNumber(item.targetUsdE8),
          litCount,
        };
        if (item.candleIndex >= CANDLES_TOTAL) {
          ev.outcome = litCount >= LIT_NEEDED ? 'SUCCEEDED' : 'FAILED_PERMANENT';
        }
        await push(env, ev);
        pushed++;
      } catch (err) {
        console.warn(`[bot] 亮灯推送失败 round=${item.roundId} candle=${item.candleIndex}`, err);
      }
    }
    return pushed;
  } catch (err) {
    console.warn('[bot] 亮灯推送整体失败', err);
    return 0;
  }
}
