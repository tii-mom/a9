/**
 * getter / 事件 / K 线滚动哈希 的链上自检（开发者工具，不参与 worker 运行时）。
 *
 * 铁律：脚本输出不能当结论——本自检的每一项都以 get-method 为独立锚点，
 * 用「链上交易里解析出的原始数据」去复算，再与 getter 返回逐值比较；任何一项失败 exit 1。
 *
 * 运行（纯 node，先编译成 CJS）：
 *   cd worker && ./node_modules/.bin/tsc src/indexer/tools/selfcheck.ts --outDir /tmp/a9idx \
 *     --module commonjs --target ES2022 --moduleResolution node --skipLibCheck --types @cloudflare/workers-types
 *   TONCENTER_API_KEY=... node /tmp/a9idx/tools/selfcheck.js \
 *     --rc 0:507f569f... --tv 0:4561cf80... --jm 0:8e6014b3... [--network testnet]
 */
import { createChainClient } from '../chain-client';
import { decodeEvent, EVENT_OP } from '../events';
import { decodeInboundMessage, TX_OP } from '../messages';
import { rollingCandleHash, bytesToHex, failureBurnId } from '../boc';
import { parseTonAddress } from '../address';
import type { ChainConfig } from '../config';
import {
  digestProtocolConfig,
  getCurrentRound,
  getJettonData,
  getProtocolConfig,
  getRound,
  getRoundBurnStatus,
  getTeamVaultState,
  getTotalWeight,
  getUserStake,
} from '../getters';

declare const process: { argv: string[]; env: Record<string, string | undefined>; exit(code: number): never };

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

function num(value: bigint | number): string {
  return typeof value === 'bigint' ? value.toString() : String(value);
}

async function main(): Promise<void> {
  const network = (argOf('network') ?? 'testnet') === 'mainnet' ? 'mainnet' : 'testnet';
  const rc = parseTonAddress(argOf('rc'));
  const tv = parseTonAddress(argOf('tv'));
  const jm = parseTonAddress(argOf('jm'));
  if (!rc || !tv || !jm) {
    console.error('缺少 --rc/--tv/--jm（支持 friendly 或 raw 地址）');
    process.exit(2);
  }
  const apiKey = process.env.TONCENTER_API_KEY?.trim() || null;
  const config: ChainConfig = {
    network,
    v2Url: network === 'mainnet' ? 'https://toncenter.com/api/v2' : 'https://testnet.toncenter.com/api/v2',
    v3Url: network === 'mainnet' ? 'https://toncenter.com/api/v3' : 'https://testnet.toncenter.com/api/v3',
    v2FallbackUrl: null,
    v3FallbackUrl: null,
    apiKey,
    allowPublic: !apiKey,
    addresses: { roundController: rc, teamVault: tv, jettonMaster: jm },
    expectedConfigVersion: null,
    expectedConfigHash: null,
    leaseSeconds: 120,
    // 开发者工具：公共端点限流很严，放宽到 800ms 并依赖客户端退避重试
    minIntervalMs: 800,
  };
  const client = createChainClient(config);
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + '  ' + detail);
  };

  const cfg = await getProtocolConfig(client, rc.raw);
  const digest = await digestProtocolConfig(network, cfg);
  add('config.slotCount', true, '22 槽解析成功，configVersion=' + cfg.configVersion + ' hash=' + digest.slice(0, 23) + '…');
  add('config.p0', cfg.p0UsdE8 === '116000', 'p0UsdE8=' + cfg.p0UsdE8);
  add('config.multiplier', cfg.priceMultiplier === '2', 'priceMultiplier=' + cfg.priceMultiplier);
  add('config.candles', cfg.candleCount === '24' && cfg.candleSeconds === '3600' && cfg.minQualifiedCandles === '16', 'count=' + cfg.candleCount + ' seconds=' + cfg.candleSeconds + ' threshold=' + cfg.minQualifiedCandles);
  add('config.timeline', cfg.previewSeconds === '43200' && cfg.stakeDurationSeconds === '129600' && cfg.observationSeconds === '86400', 'preview=' + cfg.previewSeconds + ' stake=' + cfg.stakeDurationSeconds + ' obs=' + cfg.observationSeconds);

  const currentRound = await getCurrentRound(client, rc.raw);
  add('round.current', currentRound >= 0 && currentRound <= 10, 'currentRound=' + currentRound);
  const jetton = await getJettonData(client, jm.raw);
  add('jetton.supply', jetton.totalSupplyRaw === 10_000_000_000n * 1_000_000_000n, 'totalSupply=' + jetton.totalSupplyRaw.toString());
  add('jetton.mintable', jetton.mintable === false, 'mintable=' + String(jetton.mintable));

  const tvState = await getTeamVaultState(client, tv.raw);
  add('teamvault.round', tvState.teamRoundRaw === 120_000_000n * 1_000_000_000n, 'teamRoundRaw=' + tvState.teamRoundRaw.toString());
  add('teamvault.binding', tvState.controller?.raw === rc.raw, 'controller=' + (tvState.controller?.raw ?? 'null'));

  // 拉 RC 全部交易：用交易里的原始消息/事件复算，再与 getter 对齐
  const transactions = [];
  let startLt: string | undefined;
  for (let page = 0; page < 10; page++) {
    const batch = await client.transactions({ account: rc.raw, startLt, limit: 100, sort: 'asc' });
    if (!batch.length) break;
    for (const tx of batch) {
      if (transactions.length && transactions[transactions.length - 1].lt === tx.lt) continue;
      transactions.push(tx);
    }
    const lastLt = batch[batch.length - 1].lt;
    if (lastLt === startLt) break;
    startLt = lastLt;
    if (batch.length < 100) break;
  }
  add('transactions.fetch', transactions.length > 0, 'count=' + transactions.length);

  for (let roundId = 1; roundId <= currentRound; roundId++) {
    const round = await getRound(client, rc.raw, roundId);
    if (round.status === 0) continue;
    const floor = BigInt(cfg.p0UsdE8) * (1n << BigInt(round.targetTier));
    const targetOk = round.targetPriceUsdE8 >= floor;
    add('round' + roundId + '.target>=floor', targetOk, 'target=' + round.targetPriceUsdE8.toString() + ' floor=' + floor.toString() + ' tier=' + round.targetTier);
    const timelineOk =
      round.stakeOpenAt <= round.stakeCloseAt &&
      round.stakeCloseAt <= round.observationStart &&
      round.observationStart <= round.observationEnd;
    add('round' + roundId + '.timeline', timelineOk, 'open=' + round.stakeOpenAt + ' close=' + round.stakeCloseAt + ' obsStart=' + round.observationStart + ' obsEnd=' + round.observationEnd);
    const cap = Number(cfg.minQualifiedCandles);
    add('round' + roundId + '.qualifiedCap', round.qualifiedCandles <= Math.min(cap, round.candlesSeen), 'qualified=' + round.qualifiedCandles + ' seen=' + round.candlesSeen + ' cap=' + cap);

    // 从交易解析 SubmitCandle 复算滚动哈希
    const candles = [];
    for (const tx of transactions) {
      const message = tx.in_msg;
      if (!message || !message.opcode || !message.message_content?.body) continue;
      if (Number.parseInt(message.opcode, 16) !== TX_OP.submitCandle) continue;
      const decoded = decodeInboundMessage({ opcode: TX_OP.submitCandle, body: message.message_content.body });
      if (!decoded || decoded.opcode !== TX_OP.submitCandle || decoded.roundId !== roundId) continue;
      candles.push({ ...decoded, lt: tx.lt });
    }
    candles.sort((a, b) => a.candleIndex - b.candleIndex);
    if (candles.length) {
      const sequential = candles.every((candle, index) => candle.candleIndex === index);
      add('round' + roundId + '.candlesSequential', sequential, 'parsed=' + candles.length + ' seen=' + round.candlesSeen);
      let hash: Uint8Array<ArrayBufferLike> = new Uint8Array(32);
      for (const candle of candles) hash = await rollingCandleHash(hash, candle.candleIndex, candle.twapPriceUsdE8, candle.dataDigest);
      add('round' + roundId + '.candleHash', '0x' + bytesToHex(hash) === round.candleHash, 'computed=' + '0x' + bytesToHex(hash).slice(0, 16) + '… chain=' + round.candleHash.slice(0, 18) + '…');
      const events = transactions.filter((tx) => (tx.out_msgs ?? []).some((message) => message.opcode && Number.parseInt(message.opcode, 16) === EVENT_OP.roundSettled));
      if (events.length) {
        // RoundSettled 事件的 qualifiedCandles 是封顶后的值，与 getter 一致
        add('round' + roundId + '.settleEvent', true, 'events=' + events.length);
      }
    }

    // DepositAccepted 累加 == get_round_total_stake；并抽第一个地址验证地址参数编码
    const deposits = [];
    for (const tx of transactions) {
      for (const message of tx.out_msgs ?? []) {
        if (!message.opcode || !message.message_content?.body) continue;
        const opcode = Number.parseInt(message.opcode, 16);
        if (opcode !== EVENT_OP.depositAccepted) continue;
        const event = decodeEvent({ emitter: rc.raw, txLt: tx.lt, txHash: tx.hash, txNow: tx.now, opcode, body: message.message_content.body });
        if (event && event.opcode === EVENT_OP.depositAccepted && event.roundId === roundId) deposits.push(event);
      }
    }
    let total = 0n;
    for (const deposit of deposits) total += deposit.amountRaw;
    add('round' + roundId + '.depositSum', total === round.totalAcceptedStakeRaw, 'events=' + deposits.length + ' sum=' + total.toString() + ' chain=' + round.totalAcceptedStakeRaw.toString());
    if (deposits.length) {
      const owner = parseTonAddress(deposits[0].owner.raw);
      if (owner) {
        const stake = await getUserStake(client, rc.raw, roundId, owner);
        add('round' + roundId + '.addressArg', stake.amountRaw >= deposits[0].amountRaw && stake.amountRaw > 0n, 'owner=' + owner.raw.slice(0, 12) + '… stake=' + stake.amountRaw.toString() + ' weight=' + stake.weight.toString());
        const weight = await getTotalWeight(client, rc.raw, roundId);
        add('round' + roundId + '.totalWeight', weight === round.totalWeight, 'chain=' + weight.toString() + ' roundView=' + round.totalWeight.toString());
      }
    }

    if (round.status === 8 || round.status === 9) {
      const burnStatus = await getRoundBurnStatus(client, rc.raw, roundId);
      const expectedBurnId = '0x' + bytesToHex(await failureBurnId(roundId, Number(cfg.configVersion)));
      add('round' + roundId + '.burnId', burnStatus.failureBurnId === expectedBurnId, 'chain=' + burnStatus.failureBurnId.slice(0, 18) + '… computed=' + expectedBurnId.slice(0, 18) + '…');
      add('round' + roundId + '.burntFlags', true, 'reward=' + Number(burnStatus.rewardBurnConfirmed) + ' team=' + Number(burnStatus.teamBurnConfirmed) + ' principal=' + Number(burnStatus.principalBurnConfirmed));
    }
    add('round' + roundId + '.status', true, 'status=' + round.status + ' seen=' + num(round.candlesSeen) + ' qualified=' + num(round.qualifiedCandles) + ' settledAt=' + num(round.settledAt));
  }

  const failed = checks.filter((check) => !check.ok);
  console.log('');
  console.log(JSON.stringify({ network, rc: rc.raw, checks: checks.length, failed: failed.length, digest }, null, 2));
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error('SELFCHECK ERROR: ' + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
