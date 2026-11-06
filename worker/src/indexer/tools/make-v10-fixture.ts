/**
 * 生成 v10 合成 fixture（开发者工具，不参与 worker 运行时）。
 *
 * v10 还没有测试网实例可录制，所以按 contracts/contracts/types.tolk 的字段布局与 RoundController 的结算语义
 * 合成一份确定性的链上快照（toncenter v2/v3 形态），供 selfcheck / e2e 回放。场景覆盖：
 *   R1 成功（A、B 质押；A 已 Claim(1)，B 未领）· R2 失败（一笔 burn）+ 退款账本记入 / 零头留存 / 即时退回
 *   R3 0 质押成功（奖励 burn + 团队释放）· R4 技术终止（A 用 ClaimAll 退本金）· C 用 Claim(0) 领退款账本
 *   R5 PREVIEW。RC 钱包余额按代币流水独立模拟，selfcheck 再用 ledger.expectedRcWalletBalance 公式核对。
 *
 * 运行：
 *   ./node_modules/.bin/tsc src/indexer/tools/make-v10-fixture.ts --outDir <dir> --module commonjs --target ES2022 \
 *     --moduleResolution node --skipLibCheck --types @cloudflare/workers-types
 *   node <dir>/tools/make-v10-fixture.js src/indexer/tools/fixtures/v10-synthetic.json
 */
import { bytesToBase64, bytesToHex, rollingCandleHash } from '../boc';
import { EVENT_OP } from '../events';
import { TX_OP } from '../messages';
import { addressArg, numArg } from '../getters';
import { cell, type CellBuilder } from './cell';
import { getterKey, type FixtureFile } from './fixture-client';
import type { ChainTx } from '../chain-client';

declare const process: { argv: string[]; exit(code: number): never };
declare function require(name: string): { writeFileSync(path: string, text: string): void };

const A9 = 1_000_000_000n;
const addr = (fill: string): string => '0:' + fill.repeat(64);
export const ADDR = {
  rc: addr('a'),
  jm: addr('b'),
  teamWallet: addr('c'),
  keeper: addr('d'),
  rcWallet: addr('e'),
  userA: addr('1'),
  userB: addr('2'),
  userC: addr('3'),
};

export const CONFIG = {
  p0UsdE8: 116_000n,
  priceMultiplier: 2n,
  roundRewardRaw: 700_000_000n * A9,
  teamRoundRaw: 120_000_000n * A9,
  minStakeRaw: 100_000n * A9,
  maxStakePerAddressBps: 1000n,
  maxTotalStakeRaw: 200_000_000n * A9,
  previewSeconds: 60n,
  stakeDurationSeconds: 120n,
  candleSeconds: 60n,
  candleCount: 24n,
  minQualifiedCandles: 16n,
  abortTimeoutSeconds: 604_800n,
  riskDisclosureVersion: 1n,
  configVersion: 1n,
};

const T0 = 1_800_000_000;
/** 不解码但会出现在交易里的事件（StakingClosed / CandleSubmitted）。 */
const STAKING_CLOSED = 0x5254010b;
const CANDLE_SUBMITTED = 0x5254010c;

interface RoundState {
  status: number;
  tier: number;
  target: bigint;
  twap24h: bigint;
  stakeOpenAt: number;
  stakeCloseAt: number;
  candlesSeen: number;
  qualified: number;
  totalStake: bigint;
  settledAt: number;
  teamOk: boolean;
  burnOk: boolean;
  candleHash: Uint8Array;
  stakes: Map<string, { amount: bigint; nonce: bigint; claimed: boolean }>;
}

function emptyRound(): RoundState {
  return {
    status: 0, tier: 0, target: 0n, twap24h: 0n, stakeOpenAt: 0, stakeCloseAt: 0, candlesSeen: 0, qualified: 0,
    totalStake: 0n, settledAt: 0, teamOk: false, burnOk: false, candleHash: new Uint8Array(32), stakes: new Map(),
  };
}

export async function buildV10Fixture(): Promise<FixtureFile> {
  const txs: ChainTx[] = [];
  let lt = 1_000_000n;
  let now = T0;
  let walletBalance = 10n * (CONFIG.roundRewardRaw + CONFIG.teamRoundRaw); // RC 注资 82 亿（forward_ton_amount = 0，无事件）
  const rounds = new Map<number, RoundState>();
  for (let r = 1; r <= 10; r++) rounds.set(r, emptyRound());
  const refundLedger = new Map<string, bigint>();
  let successCount = 0;
  let currentRound = 0;

  const pushTx = (inOpcode: number | null, inBody: CellBuilder | null, events: { op: number; body: CellBuilder }[], source = ADDR.keeper): void => {
    lt += 1000n;
    now += 1;
    txs.push({
      hash: bytesToBase64(new Uint8Array(32).map((_, i) => Number((lt >> BigInt((i % 8) * 8)) & 0xffn) ^ i)),
      lt: lt.toString(),
      now,
      aborted: false,
      in_msg: inOpcode === null ? null : {
        opcode: '0x' + inOpcode.toString(16),
        source,
        destination: ADDR.rc,
        message_content: { body: inBody ? inBody.toBoc() : '' },
      },
      out_msgs: events.map((event) => ({ opcode: '0x' + event.op.toString(16), destination: null, message_content: { body: event.body.toBoc() } })),
    });
  };

  const openRound = (roundId: number, twap24h: bigint): void => {
    const rd = rounds.get(roundId)!;
    rd.status = 2;
    rd.tier = successCount + 1;
    const ladder = CONFIG.p0UsdE8 * (1n << BigInt(rd.tier));
    rd.target = ladder > twap24h * 2n ? ladder : twap24h * 2n;
    rd.twap24h = twap24h;
    rd.stakeOpenAt = now + 1;
    rd.stakeCloseAt = rd.stakeOpenAt + Number(CONFIG.stakeDurationSeconds);
    currentRound = roundId;
    pushTx(TX_OP.openRound, cell().u(TX_OP.openRound, 32).u(1, 64).u(twap24h, 128), [
      { op: EVENT_OP.targetPriceSet, body: cell().u(EVENT_OP.targetPriceSet, 32).u(roundId, 8).u(rd.tier, 8).u(rd.target, 128).u(twap24h, 128) },
    ]);
  };

  const transferNotification = (owner: string, amount: bigint, roundId: number, nonce: bigint): CellBuilder =>
    cell()
      .u(TX_OP.transferNotification, 32).u(nonce, 64).coins(amount).address(owner).u(0, 1)
      .u(TX_OP.stakeDeposit, 32).u(1, 8).u(roundId, 8).u(nonce, 64).u(1, 16).u(1, 8);

  const deposit = (roundId: number, owner: string, amount: bigint, nonce: bigint): void => {
    const rd = rounds.get(roundId)!;
    walletBalance += amount;
    const pos = rd.stakes.get(owner) ?? { amount: 0n, nonce: 0n, claimed: false };
    pos.amount += amount;
    pos.nonce = nonce;
    rd.stakes.set(owner, pos);
    rd.totalStake += amount;
    pushTx(TX_OP.transferNotification, transferNotification(owner, amount, roundId, nonce), [
      { op: EVENT_OP.depositAccepted, body: cell().u(EVENT_OP.depositAccepted, 32).u(roundId, 8).address(owner).u(amount, 128).u(rd.totalStake, 128) },
    ], ADDR.rcWallet);
  };

  /** 无效质押：instant=即时退回；否则 recorded=记入退款账本 / 零头留存。 */
  const refund = (owner: string, amount: bigint, instant: boolean, recorded: boolean, roundId: number): void => {
    walletBalance += amount;
    if (instant) walletBalance -= amount;
    else if (recorded) refundLedger.set(owner, (refundLedger.get(owner) ?? 0n) + amount);
    pushTx(TX_OP.transferNotification, transferNotification(owner, amount, roundId, 99n), [
      { op: EVENT_OP.depositRefunded, body: cell().u(EVENT_OP.depositRefunded, 32).address(owner).u(amount, 128).bool(instant).bool(recorded) },
    ], ADDR.rcWallet);
  };

  const closeStaking = (roundId: number): void => {
    const rd = rounds.get(roundId)!;
    rd.status = 4;
    pushTx(TX_OP.closeStaking, cell().u(TX_OP.closeStaking, 32).u(2, 64).u(0, 128), [
      { op: STAKING_CLOSED, body: cell().u(STAKING_CLOSED, 32).u(roundId, 8).u(rd.stakeCloseAt, 64).bool(false).u(0, 128) },
    ]);
  };

  const settle = (roundId: number, success: boolean): CellBuilder => {
    const rd = rounds.get(roundId)!;
    let rewardBurn = 0n, teamBurn = 0n, principalBurn = 0n, teamReleased = 0n;
    if (success) {
      rd.status = 8;
      successCount += 1;
      teamReleased = CONFIG.teamRoundRaw;
      if (rd.totalStake === 0n) rewardBurn = CONFIG.roundRewardRaw;
    } else {
      rd.status = 9;
      rewardBurn = CONFIG.roundRewardRaw;
      teamBurn = CONFIG.teamRoundRaw;
      principalBurn = rd.totalStake;
    }
    rd.settledAt = now + 1;
    if (teamReleased > 0n) {
      rd.teamOk = true;
      walletBalance -= teamReleased;
    }
    const burn = rewardBurn + teamBurn + principalBurn;
    if (burn > 0n) {
      rd.burnOk = true;
      walletBalance -= burn;
    }
    if (roundId < 10) {
      const next = rounds.get(roundId + 1)!;
      next.status = 1;
      next.stakeOpenAt = rd.settledAt + Number(CONFIG.previewSeconds);
      currentRound = roundId + 1;
    }
    return cell()
      .u(EVENT_OP.roundSettled, 32).u(roundId, 8).u(rd.status, 8).u(rd.qualified, 8).u(rd.candlesSeen, 8)
      .u(rd.totalStake, 128).u(successCount + 1, 8).u(rewardBurn, 128).u(teamBurn, 128).u(principalBurn, 128).u(teamReleased, 128);
  };

  const candles = async (roundId: number, qualifyingCount: number): Promise<void> => {
    const rd = rounds.get(roundId)!;
    for (let index = 0; index < Number(CONFIG.candleCount); index++) {
      const qualifies = index < qualifyingCount;
      const twap = qualifies ? rd.target + 1000n : rd.target - 1000n;
      const digest = BigInt('0x' + (roundId.toString(16).padStart(2, '0') + index.toString(16).padStart(2, '0')).repeat(16));
      const periodStart = rd.stakeCloseAt + index * Number(CONFIG.candleSeconds);
      rd.candleHash = await rollingCandleHash(rd.candleHash, index, twap, digest);
      rd.candlesSeen += 1;
      if (qualifies && rd.qualified < Number(CONFIG.minQualifiedCandles)) rd.qualified += 1;
      const body = cell().u(TX_OP.submitCandle, 32).u(index, 64).u(roundId, 8).u(index, 8)
        .u(periodStart, 32).u(periodStart + Number(CONFIG.candleSeconds), 32).u(twap, 128).u(digest, 256);
      const events: { op: number; body: CellBuilder }[] = [
        {
          op: CANDLE_SUBMITTED,
          body: cell().u(CANDLE_SUBMITTED, 32).u(roundId, 8).u(index, 8).u(periodStart, 32).u(periodStart + 60, 32).u(twap, 128).u(digest, 256).u(BigInt('0x' + bytesToHex(rd.candleHash)), 256),
        },
      ];
      if (index === Number(CONFIG.candleCount) - 1) {
        events.push({ op: EVENT_OP.roundSettled, body: settle(roundId, rd.qualified >= Number(CONFIG.minQualifiedCandles)) });
      }
      pushTx(TX_OP.submitCandle, body, events);
    }
  };

  const claim = (owner: string, roundId: number, all: boolean): void => {
    let principal = 0n, reward = 0n, mask = 0;
    const from = all ? 0 : roundId;
    const to = all ? 10 : roundId;
    for (let r = from; r <= to; r++) {
      if (r === 0) {
        const pending = refundLedger.get(owner) ?? 0n;
        if (pending > 0n) {
          principal += pending;
          mask |= 1 << 15;
          refundLedger.delete(owner);
        }
        continue;
      }
      const rd = rounds.get(r)!;
      if (rd.status !== 8 && rd.status !== 10) continue;
      const pos = rd.stakes.get(owner);
      if (!pos || pos.claimed || pos.amount === 0n) continue;
      pos.claimed = true;
      principal += pos.amount;
      if (rd.status === 8) reward += (CONFIG.roundRewardRaw * pos.amount) / rd.totalStake;
      mask |= 1 << (r - 1);
    }
    walletBalance -= principal + reward;
    const op = all ? TX_OP.claimAll : TX_OP.claim;
    pushTx(op, cell().u(op, 32).u(7, 64).u(roundId, 8), [
      { op: EVENT_OP.claimed, body: cell().u(EVENT_OP.claimed, 32).address(owner).u(mask, 16).u(principal, 128).u(reward, 128) },
    ], owner);
  };

  // ---------------- 场景 ----------------
  openRound(1, 100_000n);
  deposit(1, ADDR.userA, 300_000n * A9, 1n);
  deposit(1, ADDR.userB, 100_000n * A9, 1n);
  closeStaking(1);
  await candles(1, 24);
  claim(ADDR.userA, 1, false);

  openRound(2, 100_000n);
  deposit(2, ADDR.userB, 200_000n * A9, 2n);
  refund(ADDR.userC, 50_000n * A9, false, true, 2); // 低于最低质押、TON 足够 → 记入退款账本
  refund(ADDR.userC, 10n * A9, false, false, 2); // 零头且 TON 不足 → 留存
  refund(ADDR.userA, 200_000n * A9, true, true, 9); // 轮次不对 → 即时退回
  closeStaking(2);
  await candles(2, 3);

  openRound(3, 100_000n);
  closeStaking(3);
  await candles(3, 20);

  openRound(4, 100_000n);
  deposit(4, ADDR.userA, 100_000n * A9, 3n);
  closeStaking(4);
  {
    const rd = rounds.get(4)!;
    rd.status = 10;
    rd.settledAt = now + 1;
    const next = rounds.get(5)!;
    next.status = 1;
    next.stakeOpenAt = rd.settledAt + Number(CONFIG.previewSeconds);
    currentRound = 5;
    pushTx(TX_OP.abortTechnical, cell().u(TX_OP.abortTechnical, 32).u(5, 64), [
      { op: EVENT_OP.technicalAborted, body: cell().u(EVENT_OP.technicalAborted, 32).u(4, 8).u(2, 8).u(rd.settledAt, 64) },
    ], ADDR.userB);
  }
  claim(ADDR.userA, 0, true); // ClaimAll：只有 R4 本金
  claim(ADDR.userC, 0, false); // Claim(0)：退款账本

  // ---------------- getter 响应 ----------------
  const v2: FixtureFile['v2'] = {};
  const num = (value: bigint | number): unknown => ['num', '0x' + BigInt(value).toString(16)];
  const addressItem = (raw: string): unknown => {
    const builder = cell().address(raw);
    return ['cell', { bytes: builder.toBoc(), object: { data: builder.rawData(), refs: [], special: false } }];
  };
  const ok = (stack: unknown[]): FixtureFile['v2'][string] => ({ ok: true, result: { stack, exit_code: 0 } });
  const put = (address: string, method: string, args: Parameters<typeof getterKey>[2], stack: unknown[]): void => {
    v2[getterKey(address, method, args)] = ok(stack);
  };

  const observationSeconds = CONFIG.candleSeconds * CONFIG.candleCount;
  put(ADDR.rc, 'get_protocol_config', [], [
    addressItem(ADDR.keeper), addressItem(ADDR.keeper), addressItem(ADDR.jm), addressItem(ADDR.rcWallet), addressItem(ADDR.teamWallet),
    num(CONFIG.p0UsdE8), num(CONFIG.priceMultiplier), num(CONFIG.roundRewardRaw), num(CONFIG.teamRoundRaw), num(CONFIG.minStakeRaw),
    num(CONFIG.maxStakePerAddressBps), num(CONFIG.maxTotalStakeRaw), num(CONFIG.previewSeconds), num(CONFIG.stakeDurationSeconds),
    num(CONFIG.candleSeconds), num(CONFIG.candleCount), num(CONFIG.minQualifiedCandles), num(observationSeconds),
    num(CONFIG.abortTimeoutSeconds), num(CONFIG.abortTimeoutSeconds), num(CONFIG.riskDisclosureVersion), num(CONFIG.configVersion),
  ]);
  put(ADDR.rc, 'get_current_round', [], [num(currentRound)]);
  put(ADDR.rc, 'get_success_count', [], [num(successCount)]);
  put(ADDR.rc, 'get_jetton_wallet_address', [], [addressItem(ADDR.rcWallet)]);
  put(ADDR.rcWallet, 'get_wallet_data', [], [num(walletBalance), addressItem(ADDR.rc), addressItem(ADDR.jm)]);
  let burned = 0n;
  for (const [, rd] of rounds) {
    if (rd.status === 9) burned += CONFIG.roundRewardRaw + CONFIG.teamRoundRaw + rd.totalStake;
    if (rd.status === 8 && rd.totalStake === 0n) burned += CONFIG.roundRewardRaw;
  }
  put(ADDR.jm, 'get_jetton_data', [], [num(10_000_000_000n * A9 - burned), num(0), ['null']]);

  for (const [roundId, rd] of rounds) {
    const opened = rd.status !== 0 && rd.status !== 1;
    const failed = rd.status === 9;
    put(ADDR.rc, 'get_round', [numArg(roundId)], [
      num(roundId), num(rd.status), num(rd.tier), num(rd.target), num(rd.twap24h), num(opened ? rd.stakeOpenAt : 0),
      num(rd.status === 0 ? 0 : CONFIG.roundRewardRaw), num(rd.stakeOpenAt), num(opened ? rd.stakeCloseAt : 0),
      num(opened ? rd.stakeCloseAt : 0), num(opened ? rd.stakeCloseAt + Number(observationSeconds) : 0),
      num(rd.candlesSeen), num(rd.qualified), num(rd.totalStake), num(rd.settledAt),
      num(rd.teamOk ? 1 : 0), num(failed && rd.burnOk ? 1 : 0), num(rd.burnOk ? 1 : 0), num(failed && rd.burnOk ? 1 : 0),
      num(0), num(BigInt('0x' + bytesToHex(rd.candleHash))), num(rd.totalStake),
    ]);
    put(ADDR.rc, 'get_round_total_stake', [numArg(roundId)], [num(rd.totalStake)]);
    for (const [owner, pos] of rd.stakes) {
      const ownerArg = addressArg({ workchain: 0, hashHex: owner.slice(2) });
      put(ADDR.rc, 'get_user_stake', [numArg(roundId), ownerArg], [
        num(pos.amount), num(pos.nonce), num(pos.claimed ? 1 : 0), num(pos.claimed ? 1 : 0), num(pos.amount), num(0),
      ]);
      const reward = rd.status === 8 && rd.totalStake > 0n ? (CONFIG.roundRewardRaw * pos.amount) / rd.totalStake : 0n;
      put(ADDR.rc, 'get_user_reward_estimate', [numArg(roundId), ownerArg], [num(reward)]);
    }
  }
  for (const owner of [ADDR.userA, ADDR.userB, ADDR.userC]) {
    let principal = refundLedger.get(owner) ?? 0n;
    let reward = 0n;
    let mask = principal > 0n ? 1 << 15 : 0;
    for (const [roundId, rd] of rounds) {
      const pos = rd.stakes.get(owner);
      if (!pos || pos.claimed || (rd.status !== 8 && rd.status !== 10)) continue;
      principal += pos.amount;
      if (rd.status === 8) reward += (CONFIG.roundRewardRaw * pos.amount) / rd.totalStake;
      mask |= 1 << (roundId - 1);
    }
    put(ADDR.rc, 'get_claimable_all', [addressArg({ workchain: 0, hashHex: owner.slice(2) })], [num(principal), num(reward), num(mask)]);
  }

  return {
    meta: {
      network: 'testnet',
      recordedAt: 'synthetic',
      rc: ADDR.rc,
      jm: ADDR.jm,
      tw: ADDR.teamWallet,
      keeper: ADDR.keeper,
      note: '由 make-v10-fixture.ts 按 v10 ABI 合成（v10 尚无测试网实例可录制）；字段布局见 contracts/contracts/types.tolk。',
      expectedWalletBalance: walletBalance.toString(),
    },
    v2,
    v3: { transactions: { [ADDR.rc]: txs } },
  };
}

async function main(): Promise<void> {
  const out = process.argv[2];
  if (!out) {
    console.error('用法：node make-v10-fixture.js <out.json>');
    process.exit(2);
  }
  const fixture = await buildV10Fixture();
  require('fs').writeFileSync(out, JSON.stringify(fixture, null, 1) + '\n');
  console.log('wrote ' + out + ' txs=' + fixture.v3.transactions[ADDR.rc].length + ' getters=' + Object.keys(fixture.v2).length);
}

if (process.argv[1] && process.argv[1].endsWith('make-v10-fixture.js')) void main();
