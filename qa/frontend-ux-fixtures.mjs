// Deterministic API fixtures for browser acceptance. No request reaches a chain or production API.
export function frontendFixtures(state = 'OBSERVING') {
  const now = Date.now();
  const unit = 1_000_000_000n;
  const raw = (tokens) => (BigInt(tokens) * unit).toString();
  const config = {
    token: { name: 'A9', symbol: 'A9', decimals: 9 }, p0UsdE8: '10000', usdPriceScale: 100000000,
    priceMultiplier: 2, roundCount: 10, roundRewardRaw: raw(700000000), totalSupplyRaw: raw(10000000000),
    candleSeconds: 3600, candleCount: 24, minQualifiedCandles: 16, riskDisclosureVersion: 1,
    stakeDurationSeconds: 129600, observationSeconds: 86400, previewSeconds: 43200,
    minStakeRaw: raw(1000), teamRoundRaw: raw(120000000),
    network: 'demo', dataSource: 'demo', demo: { candleSeconds: 3600, speed: 1, epochMs: now - 3600000, previewSeconds: 43200 },
    contracts: Object.fromEntries(['jettonMaster', 'roundController', 'stakingVault', 'rewardVault', 'codeHash', 'oracleConfigHash', 'keeper', 'teamWallet', 'auditReportUrl'].map((key) => [key, null])),
    tonConnectManifestUrl: null, tonUsdE8: '300000000', frozenParams: [],
  };
  const rounds = Array.from({ length: 10 }, (_, index) => ({
    roundId: index + 1, state: index === 0 ? state : 'UNOPENED', priceMultiplier: 2,
    targetPriceUsdE8: '20000', rewardBudgetRaw: config.roundRewardRaw,
    stakeOpenAt: index === 0 ? now - 7200000 : null,
    stakeCloseAt: index === 0 ? now + (state === 'STAKING_OPEN' ? 7200000 : -3600000) : null,
    observationStart: index === 0 ? now - 3600000 * 8 : null,
    observationEnd: index === 0 ? now + 3600000 * 16 : null,
    candlesSeen: index === 0 ? 8 : 0, qualifiedCandles: index === 0 ? 6 : 0,
    totalAcceptedStakeRaw: index === 0 ? raw(2500000) : '0',
    candleHash: null, stakerCount: index === 0 ? 18 : 0, result: null, burnedRaw: null, teamReleasedRaw: null, updatedAt: now,
  }));
  const candles = Array.from({ length: 8 }, (_, index) => ({
    roundId: 1, candleIndex: index, periodStart: now - (8 - index) * 3600000,
    periodEnd: now - (7 - index) * 3600000, twapPriceUsdE8: String(19000 + index * 500),
    qualified: index >= 2, coverageBps: 10000, validSourceCount: 3, dataDigest: 'fixture-' + index,
  }));
  const detail = { ...rounds[0], candles, live: state === 'OBSERVING' ? { candleIndex: 8, twapPriceUsdE8: '23000', progressBps: 4500, qualifiedTentative: true } : null,
    priceUsdE8: '23500', secondsRemaining: 57600, nextState: null };
  const stats = { supplyRaw: config.totalSupplyRaw, burnedRaw: '0', lockedStakeRaw: raw(2500000), stakerCount: 18,
    volume24hUsdE8: '129000000000', liquidityUsdE8: '50000000000', priceUsdE8: '23500', price24hAgoUsdE8: '20500',
    oracle: { online: true, validSources: 3, totalSources: 3, coverageBps: 10000, configVersion: 'fixture', lastUpdate: now, paused: false },
    nextStakeOpenAt: null };
  const trades = Array.from({ length: 8 }, (_, index) => ({ id: index + 1, ts: now - index * 1000, side: index % 2 ? 'SELL' : 'BUY',
    amountRaw: raw(1000 + index * 100), priceUsdE8: '23500', valueUsdE8: '23500000', big: index === 0 }));
  const me = (address) => ({ address, stakes: [], claimable: [],
    refund: { pendingRaw: '0', creditedRaw: '0', claimedRaw: '0' },
    claimableAll: { principalRaw: '0', rewardRaw: '0', roundsMask: 0 },
    totals: { stakedRaw: '0', rewardRaw: '0', claimedRaw: '0' } });
  return { config, rounds, detail, stats, trades, me };
}
