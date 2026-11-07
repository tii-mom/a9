/**
 * Glue between the social layer (worker/src/social) and the Telegram bot (worker/src/bot).
 * The bot expects upper-case phases and non-null numbers; the social gate API uses
 * lower-case phases and nulls when the STON.fi pool is not configured.
 */
import type { Env } from './env';
import { buildGate } from './social/handlers';
import type { GateStatus } from './bot/types';

const PHASE: Record<string, string> = {
  preview: 'PREVIEW',
  staking: 'STAKING_OPEN',
  observing: 'OBSERVING',
  settled: 'SETTLED',
};

export async function loadGateForBot(env: Env): Promise<GateStatus | null> {
  try {
    const g = await buildGate(env as never, Math.floor(Date.now() / 1000));
    if (!g || g.roundId == null) return null;
    return {
      roundId: Number(g.roundId),
      phase: PHASE[g.phase] ?? String(g.phase),
      gatePriceUsd: Number(g.gatePriceUsd ?? 0),
      priceUsd: Number(g.priceUsd ?? 0),
      remainingUsd: Number(g.remainingUsd ?? 0),
      litCandles: Number(g.litCandles ?? 0),
      candlesSeen: Number(g.candlesSeen ?? 0),
      rewardBudgetRaw: String(g.rewardBudgetRaw ?? '0'),
      stakeCount: Number(g.stakeCount ?? 0),
      phaseEndsAt: (g as { phaseEndsAt?: number }).phaseEndsAt,
    };
  } catch (e) {
    console.error('[bot] gate unavailable', e instanceof Error ? e.message : String(e));
    return null;
  }
}
