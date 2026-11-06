/**
 * v10 getter / 事件 / K 线滚动哈希 / RC 钱包余额 的链上自检（开发者工具，不参与 worker 运行时）。
 *
 * 铁律：脚本输出不能当结论——每一项都以 get-method 为独立锚点，用「交易里解析出的原始消息/事件」复算，
 * 再与 getter 返回逐值比较；任何一项失败 exit 1。
 *
 * 运行（纯 node，先编译成 CJS）：
 *   cd worker && ./node_modules/.bin/tsc src/indexer/tools/selfcheck.ts --outDir <dir> \
 *     --module commonjs --target ES2022 --moduleResolution node --skipLibCheck --types @cloudflare/workers-types
 *   离线（v10 合成 fixture）：node <dir>/tools/selfcheck.js --fixtures src/indexer/tools/fixtures/v10-synthetic.json
 *   链上：TONCENTER_API_KEY=... node <dir>/tools/selfcheck.js --rc <RC> --jm <JM> --tw <团队钱包> --keeper <keeper> [--network testnet]
 */
import { createChainClient, type ChainClient, type ChainTx } from '../chain-client';
import { decodeEvent, EVENT_OP, isEventOpcode, REFUND_LEDGER_BIT, roundsInMask, type ChainEvent } from '../events';
import { decodeInboundMessage, TX_OP } from '../messages';
import { rollingCandleHash, bytesToHex } from '../boc';
import { parseTonAddress } from '../address';
import type { ChainConfig } from '../config';
import { expectedRcWalletBalance, settlementAmounts } from '../ledger';
import {
  digestProtocolConfig,
  getClaimableAll,
  getCurrentRound,
  getJettonData,
  getJettonWalletAddress,
  getProtocolConfig,
  getRound,
  getUserStake,
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
      addresses: { roundController: rc, jettonMaster: jm, teamWallet: tw, keeper },
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
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + '  ' + detail);
  };

  // ---------------- 配置 ----------------
  const cfg = await getProtocolConfig(client, rc.raw);
  const digest = await digestProtocolConfig(network, cfg);
  add('config.slotCount', true, '22 槽解析成功，configVersion=' + cfg.configVersion + ' hash=' + digest.slice(0, 23) + '…');
  add('config.keeper', cfg.admin === keeper.raw && cfg.oracle === keeper.raw, 'admin=' + cfg.admin.slice(0, 12) + '… oracle=' + cfg.oracle.slice(0, 12) + '…（v10 两槽都 = keeper）');
  add('config.teamWallet', cfg.teamVault === tw.raw, 'teamVault 槽=' + cfg.teamVault.slice(0, 12) + '…（v10 = 团队钱包）');
  add('config.jettonMaster', cfg.jettonMaster === jm.raw, 'jettonMaster=' + cfg.jettonMaster.slice(0, 12) + '…');
  add('config.minStake', cfg.minStakeRaw === (100_000n * 1_000_000_000n).toString(), 'minStakeRaw=' + cfg.minStakeRaw + '（v10 = 100,000 A9）');
  add('config.teamRound', cfg.teamRoundRaw === (120_000_000n * 1_000_000_000n).toString(), 'teamRoundRaw=' + cfg.teamRoundRaw);
  add('config.multiplier', cfg.priceMultiplier === '2', 'priceMultiplier=' + cfg.priceMultiplier);
  // 时间参数按「代数不变量」校验（fast-test 实例会压缩时间，不能用生产常量卡死）
  const candleCount = Number(cfg.candleCount);
  const candleSeconds = Number(cfg.candleSeconds);
  const threshold = Number(cfg.minQualifiedCandles);
  add('config.candles', candleCount > 0 && candleSeconds > 0 && threshold > 0 && threshold <= candleCount, 'count=' + candleCount + ' seconds=' + candleSeconds + ' threshold=' + threshold);
  add('config.observation', Number(cfg.observationSeconds) === candleSeconds * candleCount, 'obs=' + cfg.observationSeconds + ' = ' + candleSeconds + '×' + candleCount);
  add('config.abortTimeouts', cfg.techAbortPauseSeconds === cfg.techAbortObsTimeoutSeconds, 'pause=' + cfg.techAbortPauseSeconds + ' obs=' + cfg.techAbortObsTimeoutSeconds + '（v10 统一超时）');

  const currentRound = await getCurrentRound(client, rc.raw);
  add('round.current', currentRound >= 0 && currentRound <= 10, 'currentRound=' + currentRound);
  const jetton = await getJettonData(client, jm.raw);
  const initialSupply = 10_000_000_000n * 1_000_000_000n;
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
  let unknownInbound = 0;
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
      if ((Object.values(TX_OP) as number[]).includes(opcode) && !decodeInboundMessage({ opcode, body: inbound.message_content.body })) unknownInbound++;
    }
  }
  add('events.decode', undecodable === 0, 'decoded=' + events.length + ' undecodable=' + undecodable);
  add('inbound.decode', unknownInbound === 0, 'v10 入站 opcode 解码失败=' + unknownInbound);

  // 本地账：质押 / 领取 / 退款账本 / 结算
  const stakes: StakeRow[] = [];
  const claims: ClaimRow[] = [];
  const refunds = { pending: 0n, credited: 0n, claimed: 0n, instant: 0n, dust: 0n };
  const refundByOwner = new Map<string, bigint>();
  const claimedRounds = new Map<string, Set<number>>();
  const settled = new Map<number, Extract<ChainEvent, { opcode: typeof EVENT_OP.roundSettled }>>();
  for (const event of events) {
    if (event.opcode === EVENT_OP.depositAccepted) {
      stakes.push({
        id: stakes.length + 1, round_id: event.roundId, address: event.owner.raw, amount_raw: event.amountRaw.toString(),
        weight_raw: event.amountRaw.toString(), nonce: event.txLt, risk_disclosure_version: 1, accept_full_principal_burn: 1,
        principal_claimed: 0, reward_claimed: 0, accepted_at: event.txNow * 1000,
      });
    } else if (event.opcode === EVENT_OP.depositRefunded) {
      if (!event.recorded) refunds.dust += event.amountRaw;
      else if (event.instant) refunds.instant += event.amountRaw;
      else {
        refunds.credited += event.amountRaw;
        refundByOwner.set(event.owner.raw, (refundByOwner.get(event.owner.raw) ?? 0n) + event.amountRaw);
      }
    } else if (event.opcode === EVENT_OP.claimed) {
      const owner = event.owner.raw;
      const set = claimedRounds.get(owner) ?? new Set<number>();
      let roundsPrincipal = 0n;
      for (const roundId of roundsInMask(event.roundsMask)) {
        set.add(roundId);
        for (const stake of stakes) if (stake.round_id === roundId && stake.address === owner) roundsPrincipal += BigInt(stake.amount_raw);
      }
      claimedRounds.set(owner, set);
      let refundPart = 0n;
      if (event.roundsMask & REFUND_LEDGER_BIT) {
        refundPart = event.principalRaw - roundsPrincipal;
        add('claim.refundPart.' + owner.slice(2, 10), refundPart === (refundByOwner.get(owner) ?? 0n), 'refund=' + refundPart + ' ledger=' + (refundByOwner.get(owner) ?? 0n));
        refunds.claimed += refundPart;
        refundByOwner.set(owner, 0n);
      }
      claims.push({ id: claims.length + 1, round_id: 1, address: owner, kind: 'principal', amount_raw: (event.principalRaw - refundPart + event.rewardRaw).toString(), claimed_at: event.txNow * 1000 });
    } else if (event.opcode === EVENT_OP.roundSettled) {
      settled.set(event.roundId, event);
    }
  }
  refunds.pending = refunds.credited - refunds.claimed;

  // ---------------- 逐轮 ----------------
  const rounds: RoundRow[] = [];
  const burns: BurnRow[] = [];
  let burnedConfirmed = 0n;
  for (let roundId = 1; roundId <= Math.max(currentRound, 1); roundId++) {
    const round = await getRound(client, rc.raw, roundId);
    if (round.status === 0) continue;
    add('round' + roundId + '.status', [1, 2, 4, 8, 9, 10].includes(round.status), 'status=' + round.status + '（v10 不应出现 3/5/6/7）');
    if (round.status === 1) continue;
    const floor = BigInt(cfg.p0UsdE8) * (1n << BigInt(round.targetTier));
    add('round' + roundId + '.target>=floor', round.targetPriceUsdE8 >= floor, 'target=' + round.targetPriceUsdE8.toString() + ' floor=' + floor.toString() + ' tier=' + round.targetTier);
    const cap = Number(cfg.minQualifiedCandles);
    add('round' + roundId + '.qualifiedCap', round.qualifiedCandles <= Math.min(cap, round.candlesSeen), 'qualified=' + round.qualifiedCandles + ' seen=' + round.candlesSeen + ' cap=' + cap);
    add('round' + roundId + '.totalWeight', round.totalWeight === round.totalAcceptedStakeRaw, 'totalWeight=' + round.totalWeight + '（v10 = 总质押）');
    add('round' + roundId + '.failureBurnId', round.failureBurnId === '0x' + '0'.repeat(64), 'failureBurnId 恒为 0');

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

    // DepositAccepted 累加 == totalAcceptedStakeRaw；逐地址 get_user_stake
    const roundStakes = stakes.filter((stake) => stake.round_id === roundId);
    const total = roundStakes.reduce((sum, stake) => sum + BigInt(stake.amount_raw), 0n);
    add('round' + roundId + '.depositSum', total === round.totalAcceptedStakeRaw, 'events=' + roundStakes.length + ' sum=' + total + ' chain=' + round.totalAcceptedStakeRaw);
    const owners = [...new Set(roundStakes.map((stake) => stake.address))];
    for (const ownerRaw of owners) {
      const owner = parseTonAddress(ownerRaw);
      if (!owner) continue;
      const position = await getUserStake(client, rc.raw, roundId, owner);
      const local = roundStakes.filter((stake) => stake.address === ownerRaw).reduce((sum, stake) => sum + BigInt(stake.amount_raw), 0n);
      const claimedLocal = claimedRounds.get(ownerRaw)?.has(roundId) ?? false;
      add('round' + roundId + '.userStake.' + ownerRaw.slice(2, 10), position.amountRaw === local && position.claimed === claimedLocal, 'chain=' + position.amountRaw + '/' + position.claimed + ' events=' + local + '/' + claimedLocal);
    }

    // 结算：RoundSettled 金额 == 合约推导；确认标志一致
    const row = { round_id: roundId, team_released_raw: null as string | null } as RoundRow;
    if (round.status === 8 || round.status === 9) {
      const event = settled.get(roundId);
      const expected = settlementAmounts(round.status, cfg, round.totalAcceptedStakeRaw);
      add(
        'round' + roundId + '.settledEvent',
        !!event && event.rewardBurnRaw === expected.reward && event.teamBurnRaw === expected.team && event.principalBurnRaw === expected.principal && event.teamReleasedRaw === expected.teamReleased,
        event ? 'burn=' + event.rewardBurnRaw + '/' + event.teamBurnRaw + '/' + event.principalBurnRaw + ' team=' + event.teamReleasedRaw : '缺 RoundSettled 事件',
      );
      const burnTotal = expected.reward + expected.team + expected.principal;
      const flagsOk =
        (burnTotal === 0n || round.rewardBurnConfirmed) &&
        round.teamBurnConfirmed === (round.status === 9 && round.rewardBurnConfirmed) &&
        round.principalBurnConfirmed === round.teamBurnConfirmed &&
        (expected.teamReleased === 0n || round.teamReleaseConfirmed);
      add('round' + roundId + '.settleFlags', flagsOk, 'teamOk=' + Number(round.teamReleaseConfirmed) + ' burn=' + Number(round.rewardBurnConfirmed) + '/' + Number(round.teamBurnConfirmed) + '/' + Number(round.principalBurnConfirmed));
      if (round.rewardBurnConfirmed && burnTotal > 0n) {
        burnedConfirmed += burnTotal;
        burns.push({ id: burns.length + 1, round_id: roundId, kind: 'reward', amount_raw: burnTotal.toString(), burn_ref: 'R' + roundId, confirmed: 1, created_at: 0, confirmed_at: 0 });
      }
      if (round.teamReleaseConfirmed && expected.teamReleased > 0n) row.team_released_raw = expected.teamReleased.toString();
    }
    rounds.push(row);
  }

  add('jetton.supply', jetton.totalSupplyRaw === initialSupply - burnedConfirmed, 'totalSupply=' + jetton.totalSupplyRaw + ' 期望=' + (initialSupply - burnedConfirmed) + '（初始 1e19 − 已确认 burn）');

  // get_claimable_all 与事件账一致
  const allOwners = new Set<string>([...stakes.map((stake) => stake.address), ...refundByOwner.keys()]);
  for (const ownerRaw of allOwners) {
    const owner = parseTonAddress(ownerRaw);
    if (!owner) continue;
    const chainClaimable = await getClaimableAll(client, rc.raw, owner);
    let principal = refundByOwner.get(ownerRaw) ?? 0n;
    let mask = principal > 0n ? REFUND_LEDGER_BIT : 0;
    let reward = 0n;
    for (let roundId = 1; roundId <= 10; roundId++) {
      const roundView = rounds.find((item) => item.round_id === roundId) ? await getRound(client, rc.raw, roundId) : null;
      if (!roundView || (roundView.status !== 8 && roundView.status !== 10)) continue;
      if (claimedRounds.get(ownerRaw)?.has(roundId)) continue;
      const own = stakes.filter((stake) => stake.round_id === roundId && stake.address === ownerRaw).reduce((sum, stake) => sum + BigInt(stake.amount_raw), 0n);
      if (own === 0n) continue;
      principal += own;
      if (roundView.status === 8) reward += (BigInt(cfg.roundRewardRaw) * own) / roundView.totalAcceptedStakeRaw;
      mask |= 1 << (roundId - 1);
    }
    add(
      'claimableAll.' + ownerRaw.slice(2, 10),
      chainClaimable.principalRaw === principal && chainClaimable.rewardRaw === reward && chainClaimable.roundsMask === mask,
      'chain=' + chainClaimable.principalRaw + '/' + chainClaimable.rewardRaw + '/0x' + chainClaimable.roundsMask.toString(16) + ' events=' + principal + '/' + reward + '/0x' + mask.toString(16),
    );
  }

  // RC 钱包余额（docs/34 §2 公式）
  const wallet = await getJettonWalletAddress(client, rc.raw);
  add('rcWallet.address', wallet === parseTonAddress(cfg.stakingJettonWallet)?.raw, 'get_jetton_wallet_address=' + wallet.slice(0, 12) + '… stakingJettonWallet 槽=' + cfg.stakingJettonWallet.slice(0, 12) + '…');
  const balance = await getWalletBalance(client, wallet);
  const expected = expectedRcWalletBalance({ config: cfg, stakes, rounds, burns, claims, refunds });
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
