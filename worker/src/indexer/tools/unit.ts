/**
 * 纯函数单元自检（开发者工具）：snapshot 映射 / ledger 三态 / config digest / candle 行。
 * 运行：tsc 编译成 CJS 后 `node /tmp/a9idx/indexer/tools/unit.js`（不参与 worker 运行时）。
 */
import { buildCandleRow, buildRoundPatch, chainStatusToRoundState } from '../snapshot';
import { burnRef, confirmedBurnedTotal, decodeBurnQueryId, deriveBurnObservations, expectedBurnAmount } from '../ledger';
import { PROTOCOL_CONFIG_KEYS, protocolConfigDigest, type ProtocolConfigFields } from '../config';
import type { RoundRow } from '../../store';

declare const process: { exit(code: number): never };

const failures: string[] = [];
function check(name: string, ok: boolean, detail: string): void {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + '  ' + detail);
  if (!ok) failures.push(name + ' ' + detail);
}

const config: ProtocolConfigFields = {
  admin: '0:' + '1'.repeat(64),
  oracle: '0:' + '2'.repeat(64),
  jettonMaster: '0:' + '3'.repeat(64),
  stakingJettonWallet: '0:' + '4'.repeat(64),
  teamVault: '0:' + '5'.repeat(64),
  p0UsdE8: '116000',
  priceMultiplier: '2',
  roundRewardRaw: '700000000000000000',
  teamRoundRaw: '120000000000000000',
  minStakeRaw: '10000000000000',
  maxStakePerAddressBps: '1000',
  maxTotalStakeRaw: '200000000000000000',
  previewSeconds: '43200',
  stakeDurationSeconds: '129600',
  candleSeconds: '3600',
  candleCount: '24',
  minQualifiedCandles: '16',
  observationSeconds: '86400',
  techAbortPauseSeconds: '1209600',
  techAbortObsTimeoutSeconds: '604800',
  riskDisclosureVersion: '1',
  configVersion: '1',
};

const view = {
  roundId: 1, status: 2, targetTier: 1,
  targetPriceUsdE8: 232000n, targetTwap24hUsdE8: 116000n, targetWrittenAt: 100,
  rewardBudgetRaw: 700000000000000000n,
  stakeOpenAt: 1000, stakeCloseAt: 2000, observationStart: 2000, observationEnd: 3000,
  candlesSeen: 0, qualifiedCandles: 0, totalAcceptedStakeRaw: 0n, settledAt: 0,
  teamReleaseConfirmed: false, teamBurnConfirmed: false, rewardBurnConfirmed: false, principalBurnConfirmed: false,
  failureBurnId: '0x' + '0'.repeat(64), candleHash: '0x' + '0'.repeat(64), totalWeight: 0n,
};

const previous = {
  round_id: 1, state: 'SUCCEEDED', target_tier: 1, target_price_usd_e8: '232000', reward_budget_raw: '700000000000000000',
  stake_open_at: 1000000, stake_close_at: 2000000, observation_start: 2000000, observation_end: 3000000,
  candles_seen: 0, qualified_candles: 0, total_accepted_stake_raw: '0', total_weight_raw: '0', candle_hash: null,
  staker_count: 0, result: 'SUCCESS', burned_raw: null, updated_at: 1, chain_status: 8,
} as unknown as RoundRow;

async function main(): Promise<void> {
  check('config.keys', PROTOCOL_CONFIG_KEYS.length === 22, '22 槽');
  const digest = await protocolConfigDigest('testnet', config);
  check('config.digest.format', /^sha256:[0-9a-f]{64}$/.test(digest), digest.slice(0, 23) + '…');
  const digestMainnet = await protocolConfigDigest('mainnet', config);
  check('config.digest.networkScoped', digest !== digestMainnet, 'network 参与哈希');

  const patch = buildRoundPatch({ view, config, previous: null, candles: [], burnedRaw: null, now: 1 });
  check('patch.state', patch.state === 'STAKING_OPEN', String(patch.state));
  check('patch.secondsToMs', patch.stake_open_at === 1000000 && patch.stake_close_at === 2000000, String(patch.stake_open_at));
  check('patch.target', patch.target_price_usd_e8 === '232000' && patch.target_twap24h_usd_e8 === '116000', 'ok');
  const downgrade = buildRoundPatch({ view, config, previous, candles: [], burnedRaw: null, now: 2 });
  check('patch.noTerminalDowngrade', downgrade.state === undefined, '终态不回退');

  const candle = buildCandleRow(
    { opcode: 0x52540003, body: '', queryId: 0n, roundId: 1, candleIndex: 3, periodStart: 2000, periodEnd: 5600, twapPriceUsdE8: 232000n, dataDigest: 255n },
    232000n,
    9999,
  );
  check('candle.qualified', candle.qualified === 1, 'twap==target 视为达标');
  check('candle.periodMs', candle.period_start === 2000000 && candle.period_end === 5600000, '秒→毫秒');
  check('candle.digest', candle.data_digest === '0x' + '0'.repeat(62) + 'ff', candle.data_digest);
  check('candle.coverage', candle.coverage_bps === 10000 && candle.valid_source_count === 1, '真实覆盖率/单提交者');

  check('ledger.burnRef', burnRef(3, 'team') === 'R3:team', burnRef(3, 'team'));
  const query = decodeBurnQueryId((3n << 16n) | (2n << 8n));
  check('ledger.queryId', query !== null && query.roundId === 3 && query.kind === 'team', JSON.stringify(query));
  check('ledger.amounts', expectedBurnAmount('team', config, 7n) === 120000000000000000n && expectedBurnAmount('principal', config, 7n) === 7n, 'ok');

  const failed = { ...view, status: 9, rewardBurnConfirmed: true, teamBurnConfirmed: true, principalBurnConfirmed: true, totalAcceptedStakeRaw: 1000n };
  check('ledger.confirmedTotal', confirmedBurnedTotal(failed, config) === 820000000000000000n + 1000n, String(confirmedBurnedTotal(failed, config)));
  check('ledger.notConfirmedIsNull', confirmedBurnedTotal({ ...failed, teamBurnConfirmed: false }, config) === null, '三笔未齐不显示已销毁');
  check('ledger.observations', deriveBurnObservations(failed, config).length === 3, '三笔');
  check('state.previewMapping', chainStatusToRoundState(1) === 'UNOPENED' && chainStatusToRoundState(9) === 'FAILED_PERMANENT', 'ok');

  if (failures.length) { console.error('UNIT FAILURES: ' + failures.length); process.exit(1); }
  console.log('UNIT OK');
  process.exit(0);
}

void main();
