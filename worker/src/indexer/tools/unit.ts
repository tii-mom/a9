/**
 * 纯函数单元自检（开发者工具）：snapshot 映射 / v11 结算记账 / config digest / candle 行 / v11 事件与入站消息解码 / 社交战力。
 * 运行：tsc 编译成 CJS 后 `node <dir>/tools/unit.js`（不参与 worker 运行时）。
 */
import { buildCandleRow, buildRoundPatch, chainStatusToRoundState } from '../snapshot';
import { burnRef, confirmedBurnedTotal, expectedRcWalletBalance, settlementFromEvent, settlementMismatches } from '../ledger';
import { decodeEvent, EVENT_OP } from '../events';
import { decodeInboundMessage, TX_OP } from '../messages';
import { refundBalance } from '../../store';
import { powerOf } from '../../social/power';
import { cell } from './cell';
import { PROTOCOL_CONFIG_KEYS, protocolConfigDigest, type ProtocolConfigFields } from '../config';
import { getProtocolState } from '../getters';
import type { ChainClient } from '../chain-client';
import type { RoundRow } from '../../store';

declare const process: { exit(code: number): never };

const failures: string[] = [];
function check(name: string, ok: boolean, detail: string): void {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + '  ' + detail);
  if (!ok) failures.push(name + ' ' + detail);
}

const config: ProtocolConfigFields = {
  admin: '0:' + '1'.repeat(64),
  oracle: '0:' + '1'.repeat(64),
  jettonMaster: '0:' + '3'.repeat(64),
  stakingJettonWallet: '0:' + '4'.repeat(64),
  teamVault: '0:' + '5'.repeat(64),
  p0UsdE8: '116000',
  priceMultiplier: '2',
  roundRewardRaw: '700000000000000000',
  teamRoundRaw: '120000000000000000',
  minStakeRaw: '1000000000000',
  maxStakePerAddressBps: '0',
  maxTotalStakeRaw: '0',
  previewSeconds: '43200',
  stakeDurationSeconds: '129600',
  candleSeconds: '3600',
  candleCount: '24',
  minQualifiedCandles: '16',
  observationSeconds: '86400',
  techAbortPauseSeconds: '604800',
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
  candles_seen: 0, qualified_candles: 0, candle_hash: null, total_accepted_stake_raw: '0', total_weight_raw: '0',
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
  const weighted = buildRoundPatch({ view: { ...view, totalWeight: 5n }, config, previous: null, candles: [], burnedRaw: null, now: 1 });
  check('patch.totalWeight', weighted.total_weight_raw === '5', 'v11 total_weight_raw 来自 get_round.totalWeight');
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

  // ---------------- v11 结算（事件为准） ----------------
  check('ledger.burnRef', burnRef(3, 'team') === 'R3:team', burnRef(3, 'team'));
  const settleFail = (overrides: Partial<Record<string, bigint | number>>) => ({
    opcode: EVENT_OP.roundSettled, emitter: 'rc', txLt: '1', txHash: 'h', txNow: 1, body: '',
    roundId: 2, status: 9, qualifiedCandles: 3, candlesSeen: 24, totalAcceptedStakeRaw: 1000n, tierAfter: 2,
    rewardBurnRaw: 350000000000000000n, teamBurnRaw: 120000000000000000n, principalBurnRaw: 1000n, teamReleasedRaw: 0n,
    rewardBudgetRaw: 700000000000000000n, carryAfterRaw: 350000000000000000n, ...overrides,
  } as Parameters<typeof settlementMismatches>[0]);
  const failEvent = settleFail({});
  check('ledger.failure.fromEvent', settlementFromEvent(failEvent).reward === 350000000000000000n && settlementFromEvent(failEvent).principal === 1000n, 'reward/team/principal 来自事件');
  check('ledger.failure.consistent', settlementMismatches(failEvent, config).length === 0, '半额 + 团队 1.2 亿 + 本金');
  check('ledger.failure.badTeam', settlementMismatches(settleFail({ teamBurnRaw: 1n }), config).length > 0, '团队销毁 ≠ 1.2 亿 必须报错');
  const okEvent = settleFail({ status: 8, rewardBurnRaw: 0n, teamBurnRaw: 0n, principalBurnRaw: 0n, teamReleasedRaw: 120000000000000000n });
  check('ledger.success.consistent', settlementMismatches(okEvent, config).length === 0 && settlementFromEvent(okEvent).teamReleased === 120000000000000000n, '成功轮团队释放额来自事件');
  check('ledger.success.noBurn', settlementMismatches(settleFail({ status: 8, principalBurnRaw: 5n }), config).length > 0, '成功轮不销毁本金');
  const burns = [
    { id: 1, round_id: 2, kind: 'reward', amount_raw: '350000000000000000', burn_ref: 'R2:reward', confirmed: 1, created_at: 0, confirmed_at: 0 },
    { id: 2, round_id: 2, kind: 'team', amount_raw: '120000000000000000', burn_ref: 'R2:team', confirmed: 1, created_at: 0, confirmed_at: 0 },
    { id: 3, round_id: 2, kind: 'principal', amount_raw: '1000', burn_ref: 'R2:principal', confirmed: 0, created_at: 0, confirmed_at: null },
  ] as never;
  check('ledger.confirmedTotal', confirmedBurnedTotal(burns) === 470000000000000000n, String(confirmedBurnedTotal(burns)));
  check('ledger.bouncedIsNull', confirmedBurnedTotal([{ amount_raw: '5', confirmed: 0 }] as never) === null, '未确认不计入');

  // RC 钱包：82 亿 + 入金 + 留存 − 团队释放 − 已确认销毁 − 已领取；续战行不计入金
  const wallet = expectedRcWalletBalance({
    config,
    stakes: [
      { amount_raw: '400', source: 'deposit' },
      { amount_raw: '100', source: 'restake' },
      { amount_raw: '100' },
    ] as never,
    rounds: [{ team_released_raw: '120000000000000000' }, { team_released_raw: null }] as never,
    burns: [{ amount_raw: '820000000000000100', confirmed: 1 }, { amount_raw: '9', confirmed: 0 }] as never,
    claims: [{ amount_raw: '50' }] as never,
    keptRaw: 3n,
  });
  check('ledger.rcWallet', wallet === 8_200_000_000_000_000_000n + 500n + 3n - 120000000000000000n - 820000000000000100n - 50n, wallet.toString());

  const refunds = refundBalance([
    { tx_lt: '1', address: 'a', kind: 'instant', amount_raw: '10', created_at: 0 },
    { tx_lt: '2', address: 'a', kind: 'dust', amount_raw: '1', created_at: 0 },
  ]);
  check('refund.balance', refunds.dust === 1n && refunds.instant === 10n && refunds.pending === 0n, 'v11：instant 即时退回，dust 留存');

  // 社交战力：有链上 weight 时直接求和（已含时机系数）
  check('power.noWeight', powerOf([{ amountRaw: 1000n, acceptedAt: 0 }], null) === 1000n, '无 weight 时沿用时机表');

  // ---------------- v11 事件解码 ----------------
  const owner = '0:' + 'ab'.repeat(32);
  const ev = (op: number, body: ReturnType<typeof cell>) => decodeEvent({ emitter: 'rc', txLt: '1', txHash: 'h', txNow: 1, opcode: op, body: body.toBoc() });
  const settled = ev(EVENT_OP.roundSettled, cell().u(EVENT_OP.roundSettled, 32).u(2, 8).u(9, 8).u(3, 8).u(24, 8).u(777n, 128).u(2, 8).u(7n, 128).u(8n, 128).u(9n, 128).u(0n, 128).u(11n, 128).u(12n, 128));
  check('event.roundSettled', !!settled && settled.opcode === EVENT_OP.roundSettled && settled.rewardBurnRaw === 7n && settled.rewardBudgetRaw === 11n && settled.carryAfterRaw === 12n, '新增 rewardBudgetRaw / carryAfterRaw');
  const dep = ev(EVENT_OP.depositAccepted, cell().u(EVENT_OP.depositAccepted, 32).u(3, 8).address(owner).u(100n, 128).u(150n, 128).u(400n, 128).u(550n, 128));
  check('event.depositAccepted', !!dep && dep.opcode === EVENT_OP.depositAccepted && dep.weightRaw === 150n && dep.totalWeightRaw === 550n, 'weightRaw 与 totalWeightRaw');
  const claimed = ev(EVENT_OP.claimed, cell().u(EVENT_OP.claimed, 32).address(owner).u(2, 8).u(11n, 128).u(22n, 128));
  check('event.claimed', !!claimed && claimed.opcode === EVENT_OP.claimed && claimed.owner.raw === owner && claimed.roundId === 2 && claimed.principalRaw === 11n && claimed.rewardRaw === 22n, 'owner/roundId/principal/reward');
  const refunded = ev(EVENT_OP.depositRefunded, cell().u(EVENT_OP.depositRefunded, 32).address(owner).u(5n, 128).bool(false));
  check('event.depositRefunded', !!refunded && refunded.opcode === EVENT_OP.depositRefunded && refunded.amountRaw === 5n && !refunded.instant, 'instant=false');
  const restaked = ev(EVENT_OP.restaked, cell().u(EVENT_OP.restaked, 32).address(owner).u(1, 8).u(2, 8).u(100n, 128).u(150n, 128));
  check('event.restaked', !!restaked && restaked.opcode === EVENT_OP.restaked && restaked.fromRound === 1 && restaked.toRound === 2 && restaked.weightRaw === 150n, 'from/to/amount/weight');
  const team = ev(EVENT_OP.teamReleased, cell().u(EVENT_OP.teamReleased, 32).u(3, 8).u(120n, 128));
  check('event.teamReleased', !!team && team.opcode === EVENT_OP.teamReleased && team.roundId === 3 && team.amountRaw === 120n, 'roundId/amount');
  const bounced = ev(EVENT_OP.settlementBounced, cell().u(EVENT_OP.settlementBounced, 32).u(4, 8).u(2, 8));
  check('event.settlementBounced', !!bounced && bounced.opcode === EVENT_OP.settlementBounced && bounced.roundId === 4 && bounced.action === 2, 'roundId/action');
  const unexpected = ev(EVENT_OP.unexpectedBounce, cell().u(EVENT_OP.unexpectedBounce, 32).u(0x0f8a7ea5, 32).u(123n, 64));
  check('event.unexpectedBounce', !!unexpected && unexpected.opcode === EVENT_OP.unexpectedBounce && unexpected.op === 0x0f8a7ea5 && unexpected.queryId === 123n, 'op/queryId');
  check('event.removedOps', [0x5254010f + 0x100, 0x52540006, 0x5254010e - 0x100].every((op) => ev(op, cell().u(op, 32).u(0, 64)) === null) , 'v10 Claim 等已移除事件不再解码');

  // ---------------- 入站消息 ----------------
  const retry = decodeInboundMessage({ opcode: TX_OP.retrySettlement, body: cell().u(TX_OP.retrySettlement, 32).u(1n, 64).u(3, 8).toBoc() });
  check('msg.retrySettlement', !!retry && retry.opcode === TX_OP.retrySettlement && 'roundId' in retry && retry.roundId === 3, '0x52540015');
  const release = decodeInboundMessage({ opcode: TX_OP.releaseTeam, body: cell().u(TX_OP.releaseTeam, 32).u(8n, 64).toBoc() });
  check('msg.releaseTeam', !!release && release.opcode === TX_OP.releaseTeam, '0x52540016');
  const ticketReq = decodeInboundMessage({
    opcode: TX_OP.ticketRequest,
    body: cell().u(TX_OP.ticketRequest, 32).u(9n, 64).address(owner).u(2, 8).u(100n, 128).u(150n, 128).bool(false).u(0n, 128).bool(true).toBoc(),
  });
  check('msg.ticketRequest', !!ticketReq && ticketReq.opcode === TX_OP.ticketRequest && 'restake' in ticketReq && ticketReq.restake && ticketReq.weightRaw === 150n, '攻城令 → RC');
  const payload = cell().u(TX_OP.stakeDeposit, 32).u(2, 8).u(2, 8).u(1, 16).u(1, 8).u(0, 2);
  const inRef = decodeInboundMessage({ opcode: TX_OP.transferNotification, body: cell().u(TX_OP.transferNotification, 32).u(5n, 64).coins(7n).address(owner).u(1, 1).ref(payload).toBoc() });
  check('msg.transferNotification.ref.none', !!inRef && inRef.opcode === TX_OP.transferNotification && 'stake' in inRef && inRef.stake?.version === 2 && inRef.stake.roundId === 2 && inRef.stake.beneficiary === null, 'payload v2，beneficiary=addr_none');
  const payloadAddr = cell().u(TX_OP.stakeDeposit, 32).u(2, 8).u(2, 8).u(1, 16).u(1, 8).address(owner);
  const inRef2 = decodeInboundMessage({ opcode: TX_OP.transferNotification, body: cell().u(TX_OP.transferNotification, 32).u(5n, 64).coins(7n).address(owner).u(1, 1).ref(payloadAddr).toBoc() });
  check('msg.transferNotification.beneficiary', !!inRef2 && 'stake' in inRef2 && inRef2.stake?.beneficiary?.raw === owner, 'beneficiary 地址');
  check('msg.removedOps', [0x52540006, 0x5254000e].every((op) => decodeInboundMessage({ opcode: op, body: cell().u(op, 32).u(0n, 64).u(1, 8).toBoc() }) === null), 'Claim / ClaimAll 已从 RC 移除');

  // ---------------- get_protocol_state（第 7 槽 fallbackUnlockSeconds） ----------------
  const stateOf = (slots: number[]): ChainClient => ({
    runGetMethod: async () => ({ stack: slots.map((value) => ['num', '0x' + value.toString(16)]), exit_code: 0 }),
  }) as unknown as ChainClient;
  const seven = await getProtocolState(stateOf([1000, 2, 3, 4, 5, 6, 60]), '0:' + 'a'.repeat(64));
  check('getter.protocolState.7slots', seven.fallbackUnlockSeconds === 60 && seven.currentRoundId === 6 && seven.carryRaw === 1000n, 'slot7=fallbackUnlockSeconds');
  const six = await getProtocolState(stateOf([1000, 2, 3, 4, 5, 6]), '0:' + 'a'.repeat(64));
  check('getter.protocolState.6slots', six.fallbackUnlockSeconds === 2592000 && six.successCount === 5, '旧部署 6 槽 → 默认 30 天');
  let shortThrew = false;
  try {
    await getProtocolState(stateOf([1, 2, 3]), '0:' + 'a'.repeat(64));
  } catch {
    shortThrew = true;
  }
  check('getter.protocolState.short', shortThrew, '少于 6 槽抛错');

  if (failures.length) { console.error('UNIT FAILURES: ' + failures.length); process.exit(1); }
  console.log('UNIT OK');
  process.exit(0);
}

void main();
