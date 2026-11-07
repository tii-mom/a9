/**
 * v11 getter / 事件 / 攻城令 / K 线滚动哈希 / RC 钱包余额 的链上自检（开发者工具，不参与 worker 运行时）。
 *
 * 铁律：每一项都以 get-method 为独立锚点，用「交易里解析出的原始消息/事件」复算，再与 getter 返回逐值比较；
 * 任何一项失败 exit 1。
 *
 * 运行（纯 node，先编译成 CJS）：
 *   cd worker && ./node_modules/.bin/tsc src/indexer/tools/selfcheck.ts --outDir <dir> \
 *     --module commonjs --target ES2022 --moduleResolution node --skipLibCheck --types @cloudflare/workers-types
 *   离线（v11 合成 fixture）：node <dir>/tools/selfcheck.js --fixtures src/indexer/tools/fixtures/v11-synthetic.json
 *   链上：TONCENTER_API_KEY=... node <dir>/tools/selfcheck.js --rc <RC> --jm <JM> --tw <团队钱包> --keeper <keeper> [--network testnet]
 */
import { createChainClient, type ChainClient, type ChainTx } from '../chain-client';
import { decodeEvent, EVENT_OP, isEventOpcode, type ChainEvent } from '../events';
import { decodeInboundMessage, TX_OP } from '../messages';
import { rollingCandleHash, bytesToHex } from '../boc';
import { parseTonAddress } from '../address';
import type { ChainConfig } from '../config';
import { expectedRcWalletBalance, settlementMismatches } from '../ledger';
import {
  digestProtocolConfig,
  getCurrentRound,
  getJettonData,
  getJettonWalletAddress,
  getProtocolConfig,
  getProtocolState,
  getRewardPreview,
  getRound,
  getRoundStakerCount,
  getTicketAddress,
  getTicketData,
  getWalletBalance,
} from '../getters';
import { createFixtureClient, type FixtureFile } from './fixture-client';
import type { BurnRow, ClaimRow, RoundRow, StakeRow } from '../../store';

declare const process: { argv: string[]; env: Record<string, string | undefined>; exit(code: number): never };
declare function require(name: string): { readFileSync(path: string, encoding: string): string };

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const A9 = 1_000_000_000n;

function argOf(name: string): string | null {
  const index = process.argv.indexOf('--' + name);
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1];
  return null;
}

async function main(): Promise<void> {
  const fixturesPath = argOf('fixtures');
  let client: ChainClient;
  let network: 'testnet' | 'mainnet' = (argOf('network') ?? 'testnet') === 'mainnet' ? 'mainnet' : 'testnet';
  let rcInput = argOf('rc');
  let jmInput = argOf('jm');
  let twInput = argOf('tw');
  let keeperInput = argOf('keeper');
  if (fixturesPath) {
    const fixtures = JSON.parse(require('fs').readFileSync(fixturesPath, 'utf8')) as FixtureFile;
    client = createFixtureClient(fixtures);
    network = fixtures.meta.network === 'mainnet' ? 'mainnet' : 'testnet';
    rcInput = rcInput ?? fixtures.meta.rc;
    jmInput = jmInput ?? fixtures.meta.jm;
    twInput = twInput ?? fixtures.meta.tw ?? null;
    keeperInput = keeperInput ?? fixtures.meta.keeper ?? null;
  } else {
    client = null as unknown as ChainClient;
  }
  const rc = parseTonAddress(rcInput);
  const jm = parseTonAddress(jmInput);
  const tw = parseTonAddress(twInput);
  const keeper = parseTonAddress(keeperInput);
  if (!rc || !jm || !tw || !keeper) {
    console.error('缺少 --rc/--jm/--tw/--keeper（或 --fixtures）');
    process.exit(2);
  }
  if (!fixturesPath) {
    const apiKey = process.env.TONCENTER_API_KEY?.trim() || null;
    const config: ChainConfig = {
      network,
      v2Url: network === 'mainnet' ? 'https://toncenter.com/api/v2' : 'https://testnet.toncenter.com/api/v2',
      v3Url: network === 'mainnet' ? 'https://toncenter.com/api/v3' : 'https://testnet.toncenter.com/api/v3',
      v2FallbackUrl: null,
      v3FallbackUrl: null,
      apiKey,
      allowPublic: !apiKey,
      addresses: { roundController: rc, jettonMaster: jm, teamWallet: tw, keeper, junxiangDistributor: null },
      expectedConfigVersion: null,
      expectedConfigHash: null,
      leaseSeconds: 120,
      // 开发者工具：公共端点限流很严，放宽到 800ms 并依赖客户端退避重试
      minIntervalMs: 800,
    };
    client = createChainClient(config);
  }
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
    console.log((ok ? 'PASS  ' : 'FAIL  ') + name + '  ' + detail);
  };

  // ---------------- 配置 ----------------
  const cfg = await getProtocolConfig(client, rc.raw);
  const digest = await digestProtocolConfig(network, cfg);
  add('config.slotCount', true, '22 槽解析成功，configVersion=' + cfg.configVersion + ' hash=' + digest.slice(0, 23) + '…');
  add('config.keeper', cfg.admin === keeper.raw && cfg.oracle === keeper.raw, 'admin/oracle 槽 = keeper');
  add('config.teamWallet', cfg.teamVault === tw.raw, 'teamVault 槽 = 团队钱包');
  add('config.jettonMaster', cfg.jettonMaster === jm.raw, 'jettonMaster=' + cfg.jettonMaster.slice(0, 12) + '…');
  add('config.minStake', cfg.minStakeRaw === (1_000n * A9).toString(), 'minStakeRaw=' + cfg.minStakeRaw + '（v11 = 1,000 A9）');
  add('config.teamRound', cfg.teamRoundRaw === (120_000_000n * A9).toString(), 'teamRoundRaw=' + cfg.teamRoundRaw);
  add('config.multiplier', cfg.priceMultiplier === '2', 'priceMultiplier=' + cfg.priceMultiplier);
  const candleCount = Number(cfg.candleCount);
  const candleSeconds = Number(cfg.candleSeconds);
  const threshold = Number(cfg.minQualifiedCandles);
  add('config.candles', candleCount > 0 && candleSeconds > 0 && threshold > 0 && threshold <= candleCount, 'count=' + candleCount + ' seconds=' + candleSeconds + ' threshold=' + threshold);
  add('config.observation', Number(cfg.observationSeconds) === candleSeconds * candleCount, 'obs=' + cfg.observationSeconds + ' = ' + candleSeconds + '×' + candleCount);

  const currentRound = await getCurrentRound(client, rc.raw);
  add('round.current', currentRound >= 0 && currentRound <= 10, 'currentRound=' + currentRound);
  const state = await getProtocolState(client, rc.raw);
  add('protocolState.currentRound', state.currentRoundId === currentRound, 'get_protocol_state.currentRoundId=' + state.currentRoundId + ' vs ' + currentRound);
  add('protocolState.fallbackUnlock', state.fallbackUnlockSeconds > 0, 'get_protocol_state.fallbackUnlockSeconds=' + state.fallbackUnlockSeconds + '（第 7 槽；旧部署 6 槽时默认 2592000）');
  const jetton = await getJettonData(client, jm.raw);
  add('jetton.mintable', jetton.mintable === false, 'mintable=' + String(jetton.mintable));

  // ---------------- 交易 → 事件 ----------------
  const transactions: ChainTx[] = [];
  let startLt: string | undefined;
  for (let page = 0; page < 20; page++) {
    const batch = await client.transactions({ account: rc.raw, startLt, limit: 100, sort: 'asc' });
    if (!batch.length) break;
    for (const tx of batch) {
      if (transactions.length && BigInt(transactions[transactions.length - 1].lt) >= BigInt(tx.lt)) continue;
      transactions.push(tx);
    }
    const lastLt = batch[batch.length - 1].lt;
    if (lastLt === startLt || batch.length < 100) break;
    startLt = lastLt;
  }
  add('transactions.fetch', transactions.length > 0, 'count=' + transactions.length);

  const events: ChainEvent[] = [];
  let undecodable = 0;
  let undecodableInbound = 0;
  for (const tx of transactions) {
    if (tx.aborted || tx.description?.aborted) continue;
    for (const message of tx.out_msgs ?? []) {
      if (message.destination || !message.opcode || !message.message_content?.body) continue;
      const opcode = Number.parseInt(message.opcode, 16);
      if (!isEventOpcode(opcode)) continue;
      const event = decodeEvent({ emitter: rc.raw, txLt: tx.lt, txHash: tx.hash, txNow: tx.now, opcode, body: message.message_content.body });
      if (event) events.push(event);
      else undecodable++;
    }
    const inbound = tx.in_msg;
    if (inbound?.opcode && inbound.message_content?.body) {
      const opcode = Number.parseInt(inbound.opcode, 16);
      if ((Object.values(TX_OP) as number[]).includes(opcode) && !decodeInboundMessage({ opcode, body: inbound.message_content.body })) undecodableInbound++;
    }
  }
  add('events.decode', undecodable === 0, 'decoded=' + events.length + ' undecodable=' + undecodable);
  add('inbound.decode', undecodableInbound === 0, 'v11 入站 opcode 解码失败=' + undecodableInbound);

  // 本地账（只由事件推出）
  const stakes: StakeRow[] = [];
  const claims: ClaimRow[] = [];
  const claimedFlag = new Map<string, boolean>(); // owner|round -> 本金已处理（领取或续战）
  const restakeTx = new Set<string>();
  for (const tx of transactions) {
    if (tx.out_msgs?.some((m) => m.opcode === '0x' + EVENT_OP.restaked.toString(16))) restakeTx.add(tx.lt);
  }
  let keptRaw = 0n;
  let instantRaw = 0n;
  const settled = new Map<number, Extract<ChainEvent, { opcode: typeof EVENT_OP.roundSettled }>>();
  const teamReleasedBy = new Map<number, bigint>();
  for (const event of events) {
    if (event.opcode === EVENT_OP.depositAccepted) {
      stakes.push({
        id: stakes.length + 1, round_id: event.roundId, address: event.owner.raw, amount_raw: event.amountRaw.toString(),
        weight_raw: event.weightRaw.toString(), nonce: event.txLt, risk_disclosure_version: 1, accept_full_principal_burn: 1,
        principal_claimed: 0, reward_claimed: 0, accepted_at: event.txNow * 1000,
        source: restakeTx.has(event.txLt) ? 'restake' : 'deposit',
      });
    } else if (event.opcode === EVENT_OP.depositRefunded) {
      if (event.instant) instantRaw += event.amountRaw;
      else keptRaw += event.amountRaw;
    } else if (event.opcode === EVENT_OP.restaked) {
      claimedFlag.set(event.owner.raw + '|' + event.fromRound, true);
    } else if (event.opcode === EVENT_OP.claimed) {
      const key = event.owner.raw + '|' + event.roundId;
      if (event.principalRaw > 0n) claimedFlag.set(key, true);
      if (event.rewardRaw > 0n) claimedFlag.set(key, true);
      if (event.principalRaw > 0n) claims.push({ id: 0, round_id: event.roundId, address: event.owner.raw, kind: 'principal', amount_raw: event.principalRaw.toString(), claimed_at: event.txNow * 1000 });
      if (event.rewardRaw > 0n) claims.push({ id: 0, round_id: event.roundId, address: event.owner.raw, kind: 'reward', amount_raw: event.rewardRaw.toString(), claimed_at: event.txNow * 1000 });
    } else if (event.opcode === EVENT_OP.roundSettled) {
      settled.set(event.roundId, event);
    } else if (event.opcode === EVENT_OP.teamReleased) {
      teamReleasedBy.set(event.roundId, event.amountRaw);
    }
  }

  // 攻城令之间的续战：Restaked 必须与同交易的 DepositAccepted(source=restake) 配对
  const restakes = events.filter((event) => event.opcode === EVENT_OP.restaked);
  for (const event of restakes) {
    if (event.opcode !== EVENT_OP.restaked) continue;
    const paired = stakes.some((stake) => stake.nonce === event.txLt && stake.round_id === event.toRound && stake.source === 'restake' && stake.amount_raw === event.amountRaw.toString());
    add('restake.pairing.' + event.toRound, paired, 'R' + event.fromRound + '→R' + event.toRound + ' amount=' + event.amountRaw + ' weight=' + event.weightRaw);
  }
  add('refunds.kept', true, 'instant=' + instantRaw + ' kept=' + keptRaw);

  // ---------------- 逐轮 ----------------
  const rounds: RoundRow[] = [];
  const burns: BurnRow[] = [];
  let burnedConfirmed = 0n;
  const ticketSums = new Map<string, { roundId: number; owner: string; amount: bigint; weight: bigint }>();
  for (const stake of stakes) {
    const key = stake.round_id + '|' + stake.address;
    const entry = ticketSums.get(key) ?? { roundId: stake.round_id, owner: stake.address, amount: 0n, weight: 0n };
    entry.amount += BigInt(stake.amount_raw);
    entry.weight += BigInt(stake.weight_raw);
    ticketSums.set(key, entry);
  }
  for (let roundId = 1; roundId <= Math.max(currentRound, 1); roundId++) {
    const round = await getRound(client, rc.raw, roundId);
    if (round.status === 0) continue;
    add('round' + roundId + '.status', [1, 2, 4, 8, 9, 10].includes(round.status), 'status=' + round.status);
    if (round.status === 1) continue;
    const floor = BigInt(cfg.p0UsdE8) * (1n << BigInt(round.targetTier));
    add('round' + roundId + '.target>=floor', round.targetPriceUsdE8 >= floor, 'target=' + round.targetPriceUsdE8.toString() + ' floor=' + floor.toString() + ' tier=' + round.targetTier);
    const cap = Number(cfg.minQualifiedCandles);
    add('round' + roundId + '.qualifiedCap', round.qualifiedCandles <= Math.min(cap, round.candlesSeen), 'qualified=' + round.qualifiedCandles + ' seen=' + round.candlesSeen);

    // 权重：DepositAccepted 累加 == get_round.totalWeight；金额 == totalAcceptedStakeRaw
    const roundStakes = stakes.filter((stake) => stake.round_id === roundId);
    const total = roundStakes.reduce((sum, stake) => sum + BigInt(stake.amount_raw), 0n);
    const weightSum = roundStakes.reduce((sum, stake) => sum + BigInt(stake.weight_raw), 0n);
    add('round' + roundId + '.depositSum', total === round.totalAcceptedStakeRaw, 'events=' + roundStakes.length + ' sum=' + total + ' chain=' + round.totalAcceptedStakeRaw);
    add('round' + roundId + '.totalWeight', weightSum === round.totalWeight, 'events=' + weightSum + ' chain=' + round.totalWeight);
    const count = await getRoundStakerCount(client, rc.raw, roundId);
    add('round' + roundId + '.stakerCount', count === roundStakes.length, 'get_round_staker_count=' + count + ' 入账笔数=' + roundStakes.length);

    // SubmitCandle → 滚动哈希
    const candles = [];
    for (const tx of transactions) {
      const message = tx.in_msg;
      if (!message || !message.opcode || !message.message_content?.body) continue;
      if (Number.parseInt(message.opcode, 16) !== TX_OP.submitCandle) continue;
      const decoded = decodeInboundMessage({ opcode: TX_OP.submitCandle, body: message.message_content.body });
      if (!decoded || decoded.opcode !== TX_OP.submitCandle || decoded.roundId !== roundId) continue;
      candles.push(decoded);
    }
    candles.sort((a, b) => a.candleIndex - b.candleIndex);
    if (candles.length) {
      add('round' + roundId + '.candlesSequential', candles.every((candle, index) => candle.candleIndex === index) && candles.length === round.candlesSeen, 'parsed=' + candles.length + ' seen=' + round.candlesSeen);
      let hash: Uint8Array<ArrayBufferLike> = new Uint8Array(32);
      for (const candle of candles) hash = await rollingCandleHash(hash, candle.candleIndex, candle.twapPriceUsdE8, candle.dataDigest);
      add('round' + roundId + '.candleHash', '0x' + bytesToHex(hash) === round.candleHash, 'computed=0x' + bytesToHex(hash).slice(0, 16) + '… chain=' + round.candleHash.slice(0, 18) + '…');
    }

    // 结算（RoundSettled 事件 = 合约记账；结构性核对 + 确认标志）
    const row = { round_id: roundId, team_released_raw: null as string | null } as RoundRow;
    if (round.status === 8 || round.status === 9) {
      const event = settled.get(roundId);
      if (!event) {
        add('round' + roundId + '.settledEvent', false, '缺 RoundSettled 事件');
      } else {
        add('round' + roundId + '.budgetEvent', event.rewardBudgetRaw === round.rewardBudgetRaw, 'event budget=' + event.rewardBudgetRaw + ' chain=' + round.rewardBudgetRaw);
        const problems = settlementMismatches(event, cfg);
        add('round' + roundId + '.settledEvent', problems.length === 0, problems.length ? problems.join('；') : 'burn=' + event.rewardBurnRaw + '/' + event.teamBurnRaw + '/' + event.principalBurnRaw + ' team=' + event.teamReleasedRaw + ' carryAfter=' + event.carryAfterRaw);
        const burnTotal = event.rewardBurnRaw + event.teamBurnRaw + event.principalBurnRaw;
        const flagsOk = (burnTotal === 0n || round.rewardBurnConfirmed) && round.teamBurnConfirmed === round.principalBurnConfirmed && round.principalBurnConfirmed === round.rewardBurnConfirmed;
        add('round' + roundId + '.settleFlags', flagsOk, 'burn=' + Number(round.rewardBurnConfirmed) + ' teamReleaseConfirmed=' + Number(round.teamReleaseConfirmed));
        const released = teamReleasedBy.get(roundId) ?? 0n;
        add('round' + roundId + '.teamRelease', released === event.teamReleasedRaw && round.teamReleaseConfirmed === (event.teamReleasedRaw > 0n), 'event=' + event.teamReleasedRaw + ' TeamReleased=' + released);
        if (round.rewardBurnConfirmed && burnTotal > 0n) {
          burnedConfirmed += burnTotal;
          burns.push({ id: burns.length + 1, round_id: roundId, kind: 'reward', amount_raw: burnTotal.toString(), burn_ref: 'R' + roundId, confirmed: 1, created_at: 0, confirmed_at: 0 });
        }
        if (round.teamReleaseConfirmed && event.teamReleasedRaw > 0n) row.team_released_raw = event.teamReleasedRaw.toString();
      }
    }
    rounds.push(row);

    // 攻城令：get_ticket_address / get_ticket_data 与本地账逐项比较
    for (const sum of ticketSums.values()) {
      if (sum.roundId !== roundId) continue;
      const owner = parseTonAddress(sum.owner);
      if (!owner) continue;
      const ticket = await getTicketAddress(client, rc.raw, owner, roundId);
      const data = await getTicketData(client, ticket);
      add(
        'ticket.R' + roundId + '.' + sum.owner.slice(2, 10),
        data.amountRaw === sum.amount && data.weightRaw === sum.weight && data.rc === rc.raw && data.roundId === roundId,
        'chain amount=' + data.amountRaw + ' weight=' + data.weightRaw + ' / events amount=' + sum.amount + ' weight=' + sum.weight,
      );
      const flagLocal = claimedFlag.get(sum.owner + '|' + roundId) ?? false;
      add('ticket.R' + roundId + '.principalDone.' + sum.owner.slice(2, 10), data.principalDone === flagLocal, 'chain=' + data.principalDone + ' events=' + flagLocal);
      if (round.status === 8) {
        const preview = await getRewardPreview(client, rc.raw, roundId, sum.weight);
        add(
          'ticket.R' + roundId + '.preview.' + sum.owner.slice(2, 10),
          preview.immediateRaw + preview.lockedRaw === preview.rewardRaw && preview.unlockedLockedRaw <= preview.lockedRaw,
          'reward=' + preview.rewardRaw + ' immediate=' + preview.immediateRaw + ' locked=' + preview.lockedRaw + ' unlocked=' + preview.unlockedLockedRaw,
        );
      }
    }
  }

  add('jetton.supply', jetton.totalSupplyRaw === 10_000_000_000n * A9 - burnedConfirmed, 'totalSupply=' + jetton.totalSupplyRaw + ' 期望=' + (10_000_000_000n * A9 - burnedConfirmed) + '（初始 1e19 − 已确认 burn）');

  // RC 钱包余额：82 亿 + 入金 + 留存无效质押 − 团队释放 − 已确认销毁 − 已领取（本金 + 奖励）
  const wallet = await getJettonWalletAddress(client, rc.raw);
  add('rcWallet.address', wallet === parseTonAddress(cfg.stakingJettonWallet)?.raw, 'get_jetton_wallet_address=' + wallet.slice(0, 12) + '…');
  const balance = await getWalletBalance(client, wallet);
  const teamRows: RoundRow[] = rounds.map((row) => ({ ...row }));
  const expected = expectedRcWalletBalance({ config: cfg, stakes, rounds: teamRows, burns, claims, keptRaw });
  add('rcWallet.balance', balance === expected, 'chain=' + balance + ' 公式=' + expected);

  const failed = checks.filter((check) => !check.ok);
  console.log('');
  console.log(JSON.stringify({ network, rc: rc.raw, checks: checks.length, failed: failed.length, digest }, null, 2));
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error('SELFCHECK ERROR: ' + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
