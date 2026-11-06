/**
 * 纯函数单元自检（开发者工具）：snapshot 映射 / v10 结算记账 / config digest / candle 行 / v10 事件与入站消息解码。
 * 运行：tsc 编译成 CJS 后 `node /tmp/a9idx/indexer/tools/unit.js`（不参与 worker 运行时）。
 */
import { buildCandleRow, buildRoundPatch, chainStatusToRoundState } from '../snapshot';
import { burnRef, confirmedBurnedTotal, expectedRcWalletBalance, settlementAmounts } from '../ledger';
import { decodeEvent, EVENT_OP, REFUND_LEDGER_BIT, roundsInMask } from '../events';
import { decodeInboundMessage, TX_OP } from '../messages';
import { rewardFor } from '../../protocol';
import { refundBalance } from '../../store';
import { cell } from './cell';
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
  oracle: '0:' + '1'.repeat(64),
  jettonMaster: '0:' + '3'.repeat(64),
  stakingJettonWallet: '0:' + '4'.repeat(64),
  teamVault: '0:' + '5'.repeat(64),
  p0UsdE8: '116000',
  priceMultiplier: '2',
  roundRewardRaw: '700000000000000000',
  teamRoundRaw: '120000000000000000',
  minStakeRaw: '100000000000000',
  maxStakePerAddressBps: '1000',
  maxTotalStakeRaw: '200000000000000000',
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
  const failAmounts = settlementAmounts(9, config, 1000n);
  check('ledger.failure', failAmounts.reward === 700000000000000000n && failAmounts.team === 120000000000000000n && failAmounts.principal === 1000n && failAmounts.teamReleased === 0n, 'reward+team+principal 一笔 burn');
  const okAmounts = settlementAmounts(8, config, 1000n);
  check('ledger.success', okAmounts.reward === 0n && okAmounts.teamReleased === 120000000000000000n, '成功：团队释放 1.2 亿，不销毁');
  check('ledger.successNoStaker', settlementAmounts(8, config, 0n).reward === 700000000000000000n, 'D-18b：0 质押成功轮 burn 奖励');
  check('ledger.abort', settlementAmounts(10, config, 5n).teamReleased === 0n && settlementAmounts(10, config, 5n).reward === 0n, '技术终止：不动 8.2 亿');

  const failed = { ...view, status: 9, rewardBurnConfirmed: true, teamBurnConfirmed: true, principalBurnConfirmed: true, totalAcceptedStakeRaw: 1000n };
  check('ledger.confirmedTotal', confirmedBurnedTotal(failed, config) === 820000000000000000n + 1000n, String(confirmedBurnedTotal(failed, config)));
  check('ledger.bouncedIsNull', confirmedBurnedTotal({ ...failed, rewardBurnConfirmed: false }, config) === null, 'burn 被退回待重试时不显示已销毁');
  check('ledger.successNoBurn', confirmedBurnedTotal({ ...view, status: 8, totalAcceptedStakeRaw: 5n, rewardBurnConfirmed: false }, config) === null, '有质押成功轮没有 burn');
  check('state.previewMapping', chainStatusToRoundState(1) === 'UNOPENED' && chainStatusToRoundState(9) === 'FAILED_PERMANENT', 'ok');
  check('state.removedStatuses', [3, 5, 6, 7].every((status) => chainStatusToRoundState(status) === null), 'v10 不再出现 3/5/6/7');
  check('reward.proRata', rewardFor(700n, 3n, 4n) === 525n && rewardFor(700n, 1n, 0n) === 0n, 'floor(budget × stake / total)');

  // RC 钱包公式：82 亿 + 质押 + 记入 + 零头 − 团队释放 − 已销毁 − 已领取 − 退款已领
  const wallet = expectedRcWalletBalance({
    config,
    stakes: [{ amount_raw: '400' }, { amount_raw: '100' }] as never,
    rounds: [{ team_released_raw: '120000000000000000' }, { team_released_raw: null }] as never,
    burns: [{ amount_raw: '820000000000000100', confirmed: 1 }, { amount_raw: '9', confirmed: 0 }] as never,
    claims: [{ amount_raw: '50' }] as never,
    refunds: { pending: 5n, credited: 7n, claimed: 2n, instant: 99n, dust: 3n },
  });
  check('ledger.rcWallet', wallet === 8_200_000_000_000_000_000n + 500n + 7n + 3n - 120000000000000000n - 820000000000000100n - 50n - 2n, wallet.toString());

  const refunds = refundBalance([
    { tx_lt: '1', address: 'a', kind: 'credit', amount_raw: '10', created_at: 0 },
    { tx_lt: '2', address: 'a', kind: 'dust', amount_raw: '1', created_at: 0 },
    { tx_lt: '3', address: 'a', kind: 'claim', amount_raw: '10', created_at: 0 },
    { tx_lt: '4', address: 'a', kind: 'credit', amount_raw: '4', created_at: 0 },
  ]);
  check('refund.balance', refunds.pending === 4n && refunds.credited === 14n && refunds.claimed === 10n && refunds.dust === 1n, JSON.stringify({ p: String(refunds.pending) }));

  // ---------------- v10 事件解码（按 types.tolk 布局构造） ----------------
  const owner = '0:' + 'ab'.repeat(32);
  const ev = (op: number, body: ReturnType<typeof cell>) => decodeEvent({ emitter: 'rc', txLt: '1', txHash: 'h', txNow: 1, opcode: op, body: body.toBoc() });
  const settled = ev(EVENT_OP.roundSettled, cell().u(EVENT_OP.roundSettled, 32).u(2, 8).u(9, 8).u(3, 8).u(24, 8).u(777n, 128).u(2, 8).u(7n, 128).u(8n, 128).u(9n, 128).u(0n, 128));
  check('event.roundSettled', !!settled && settled.opcode === EVENT_OP.roundSettled && settled.rewardBurnRaw === 7n && settled.teamBurnRaw === 8n && settled.principalBurnRaw === 9n && settled.teamReleasedRaw === 0n && settled.totalAcceptedStakeRaw === 777n, '四个新 u128 字段');
  const claimed = ev(EVENT_OP.claimed, cell().u(EVENT_OP.claimed, 32).address(owner).u(0x8005, 16).u(11n, 128).u(22n, 128));
  check('event.claimed', !!claimed && claimed.opcode === EVENT_OP.claimed && claimed.owner.raw === owner && claimed.roundsMask === 0x8005 && claimed.principalRaw === 11n && claimed.rewardRaw === 22n, 'owner/mask/principal/reward');
  check('event.mask', roundsInMask(0x8005).join(',') === '1,3' && (0x8005 & REFUND_LEDGER_BIT) !== 0, 'bit r-1 = 第 r 轮，bit 15 = 退款账本');
  const refunded = ev(EVENT_OP.depositRefunded, cell().u(EVENT_OP.depositRefunded, 32).address(owner).u(5n, 128).bool(false).bool(true));
  check('event.depositRefunded', !!refunded && refunded.opcode === EVENT_OP.depositRefunded && refunded.amountRaw === 5n && !refunded.instant && refunded.recorded, 'instant=false recorded=true');
  const bounced = ev(EVENT_OP.settlementBounced, cell().u(EVENT_OP.settlementBounced, 32).u(4, 8).u(2, 8));
  check('event.settlementBounced', !!bounced && bounced.opcode === EVENT_OP.settlementBounced && bounced.roundId === 4 && bounced.action === 2, 'roundId/action');
  const unexpected = ev(EVENT_OP.unexpectedBounce, cell().u(EVENT_OP.unexpectedBounce, 32).u(0x0f8a7ea5, 32).u(123n, 64));
  check('event.unexpectedBounce', !!unexpected && unexpected.opcode === EVENT_OP.unexpectedBounce && unexpected.op === 0x0f8a7ea5 && unexpected.queryId === 123n, 'op/queryId');
  check('event.removedOps', [0x52540105, 0x52540106, 0x52540107, 0x52540108, 0x52540201, 0x52540202].every((op) => ev(op, cell().u(op, 32).u(0, 64)) === null), '旧 V8 / TeamVault 事件不再解码');

  // ---------------- 入站消息 ----------------
  const claimMsg = decodeInboundMessage({ opcode: TX_OP.claim, body: cell().u(TX_OP.claim, 32).u(9n, 64).u(0, 8).toBoc() });
  check('msg.claim', !!claimMsg && claimMsg.opcode === TX_OP.claim && 'roundId' in claimMsg && claimMsg.roundId === 0, 'Claim(0) = 退款账本');
  const retry = decodeInboundMessage({ opcode: TX_OP.retrySettlement, body: cell().u(TX_OP.retrySettlement, 32).u(1n, 64).u(3, 8).toBoc() });
  check('msg.retrySettlement', !!retry && retry.opcode === TX_OP.retrySettlement, '0x52540015');
  const payload = cell().u(TX_OP.stakeDeposit, 32).u(1, 8).u(2, 8).u(42n, 64).u(1, 16).u(1, 8);
  const inline = decodeInboundMessage({ opcode: TX_OP.transferNotification, body: cell().u(TX_OP.transferNotification, 32).u(5n, 64).coins(100000000000000n).address(owner).u(0, 1).u(TX_OP.stakeDeposit, 32).u(1, 8).u(2, 8).u(42n, 64).u(1, 16).u(1, 8).toBoc() });
  check('msg.transferNotification.inline', !!inline && inline.opcode === TX_OP.transferNotification && inline.jettonAmount === 100000000000000n && inline.stake?.roundId === 2 && inline.stake.depositNonce === 42n && inline.transferInitiator?.raw === owner, 'Either 左支');
  const inRef = decodeInboundMessage({ opcode: TX_OP.transferNotification, body: cell().u(TX_OP.transferNotification, 32).u(5n, 64).coins(7n).address(owner).u(1, 1).ref(payload).toBoc() });
  check('msg.transferNotification.ref', !!inRef && inRef.opcode === TX_OP.transferNotification && inRef.stake?.depositNonce === 42n, 'Either 右支（ref cell，前端质押格式）');
  check('msg.removedOps', [0x52540005, 0x52540007, 0x52540009, 0x52540017, 0x52540018, 0x52540019, 0x5254001a].every((op) => decodeInboundMessage({ opcode: op, body: cell().u(op, 32).u(0n, 64).u(1, 8).toBoc() }) === null), '已删除的入站 opcode 不再解码');

  if (failures.length) { console.error('UNIT FAILURES: ' + failures.length); process.exit(1); }
  console.log('UNIT OK');
  process.exit(0);
}

void main();
