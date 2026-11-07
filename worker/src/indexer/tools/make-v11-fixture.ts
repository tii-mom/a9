/**
 * 生成 v11 合成 fixture（开发者工具，不参与 worker 运行时）。
 *
 * v11 还没有测试网实例可录制，所以按 contracts/contracts/types.tolk、ticket.tolk 与 RoundController 的
 * 结算 / 领取语义合成一份确定性的链上快照（toncenter v2/v3 形态），供 selfcheck / unit 回放。
 * 金额单位：A9（1 A9 = 1e9 raw）。场景：
 *   R1 成功：A 质押 30 万（首段 ×1.5）、B 质押 10 万（末段 ×1.0）。A 首领（本金 + 20%）；B 一键续战进 R2（本金不出合约）。
 *   R2 失败：B 续战 10 万 + C 质押 20 万；两笔无效质押（一笔即时退回、一笔留存）。半额奖励 + 团队 1.2 亿 + 本金 一笔销毁。
 *   R3 成功（有质押）：A 质押 10 万。结算时释放 R1 的团队 1.2 亿；破城后 R1 的 80% 压城奖励全部解锁，A、B 各领一次。
 *   R4 开窗（STAKING_OPEN，尚无质押）。未覆盖：第 10 城 carry 销毁、0 质押成功轮、技术终止（见报告）。
 *
 * 运行：
 *   ./node_modules/.bin/tsc src/indexer/tools/make-v11-fixture.ts --outDir <dir> --module commonjs --target ES2022 \
 *     --moduleResolution node --skipLibCheck --types @cloudflare/workers-types
 *   node <dir>/tools/make-v11-fixture.js src/indexer/tools/fixtures/v11-synthetic.json
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
  minStakeRaw: 1_000n * A9,
  previewSeconds: 60n,
  stakeDurationSeconds: 129_600n,
  candleSeconds: 3_600n,
  candleCount: 24n,
  minQualifiedCandles: 16n,
  abortTimeoutSeconds: 604_800n,
  riskDisclosureVersion: 1n,
  configVersion: 1n,
  /** 压城兜底解锁窗口（秒）：取 ops/config/testnet-fast.params.json 的 60，区别于主网默认 30 天，以覆盖第 7 槽的读取路径 */
  fallbackUnlockSeconds: 60n,
};

/** 时机系数（bps）：首段 1.5 / 中段 1.2 / 末段 1.0。 */
const BPS_FIRST = 15_000n;
const BPS_SECOND = 12_000n;
const BPS_LAST = 10_000n;
const BPS = 10_000n;
const IMMEDIATE_BPS = 2_000n;
const T0 = 1_800_000_000;
const STAKING_CLOSED = 0x5254010b;
const CANDLE_SUBMITTED = 0x5254010c;

interface RoundState {
  status: number;
  tier: number;
  target: bigint;
  twap24h: bigint;
  stakeOpenAt: number;
  stakeCloseAt: number;
  budget: bigint;
  candlesSeen: number;
  qualified: number;
  totalStake: bigint;
  totalWeight: bigint;
  settledAt: number;
  teamOk: boolean;
  burnOk: boolean;
  candleHash: Uint8Array;
}

interface Ticket {
  owner: string;
  roundId: number;
  amount: bigint;
  weight: bigint;
  principalDone: boolean;
  lockedClaimed: bigint;
}

function emptyRound(): RoundState {
  return {
    status: 0, tier: 0, target: 0n, twap24h: 0n, stakeOpenAt: 0, stakeCloseAt: 0, budget: 0n, candlesSeen: 0, qualified: 0,
    totalStake: 0n, totalWeight: 0n, settledAt: 0, teamOk: false, burnOk: false, candleHash: new Uint8Array(32),
  };
}

/** 攻城令地址：确定性推导（真实环境由 RC 的 get_ticket_address 给出）。 */
function ticketAddress(owner: string, roundId: number): string {
  const value = (BigInt('0x' + owner.slice(2)) + BigInt(roundId) * 7n + 1n) % (1n << 256n);
  return '0:' + value.toString(16).padStart(64, '0');
}

export async function buildV11Fixture(): Promise<FixtureFile> {
  const txs: ChainTx[] = [];
  let lt = 1_000_000n;
  let now = T0;
  // RC 注资 82 亿（10 × (7 亿 + 1.2 亿)，forward_ton_amount = 0，无事件）
  let walletBalance = 10n * (CONFIG.roundRewardRaw + CONFIG.teamRoundRaw);
  const rounds = new Map<number, RoundState>();
  for (let r = 1; r <= 10; r++) rounds.set(r, emptyRound());
  const tickets = new Map<string, Ticket>();
  const depositCount = new Map<number, number>();
  let successCount = 0;
  let lastSuccessRound = 0;
  let teamPending = 0n;
  let carry = 0n;
  let endAt = 0;
  let currentRound = 0;
  let keptRaw = 0n;

  const ticketOf = (owner: string, roundId: number): Ticket => {
    const key = owner + '|' + roundId;
    let ticket = tickets.get(key);
    if (!ticket) {
      ticket = { owner, roundId, amount: 0n, weight: 0n, principalDone: false, lockedClaimed: 0n };
      tickets.set(key, ticket);
    }
    return ticket;
  };

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
    rd.budget = CONFIG.roundRewardRaw + carry;
    carry = 0n;
    rd.stakeOpenAt = now + 1;
    rd.stakeCloseAt = rd.stakeOpenAt + Number(CONFIG.stakeDurationSeconds);
    currentRound = roundId;
    pushTx(TX_OP.openRound, cell().u(TX_OP.openRound, 32).u(1, 64).u(twap24h, 128), [
      { op: EVENT_OP.targetPriceSet, body: cell().u(EVENT_OP.targetPriceSet, 32).u(roundId, 8).u(rd.tier, 8).u(rd.target, 128).u(twap24h, 128) },
    ]);
  };

  /** 转账入金：transfer_notification，forward_payload 为 StakePayload v2（右引用 cell，beneficiary = addr_none）。 */
  const deposit = (roundId: number, owner: string, amount: bigint, bps: bigint): void => {
    const rd = rounds.get(roundId)!;
    walletBalance += amount;
    const weight = (amount * bps) / BPS;
    const ticket = ticketOf(owner, roundId);
    ticket.amount += amount;
    ticket.weight += weight;
    rd.totalStake += amount;
    rd.totalWeight += weight;
    depositCount.set(roundId, (depositCount.get(roundId) ?? 0) + 1);
    const payload = cell().u(TX_OP.stakeDeposit, 32).u(2, 8).u(roundId, 8).u(1, 16).u(1, 8).u(0, 2);
    const notification = cell()
      .u(TX_OP.transferNotification, 32).u(lt + 1n, 64).coins(amount).address(owner).u(1, 1).ref(payload);
    pushTx(TX_OP.transferNotification, notification, [
      { op: EVENT_OP.depositAccepted, body: cell().u(EVENT_OP.depositAccepted, 32).u(roundId, 8).address(owner).u(amount, 128).u(weight, 128).u(rd.totalStake, 128).u(rd.totalWeight, 128) },
    ], ADDR.rcWallet);
  };

  /** 无效入金：instant = 即时退回（钱包余额不变）；否则 TON 不足，金额留存在 RC（计入 keptRaw）。 */
  const refund = (owner: string, amount: bigint, instant: boolean, roundId: number): void => {
    walletBalance += amount;
    if (instant) walletBalance -= amount;
    else keptRaw += amount;
    const payload = cell().u(TX_OP.stakeDeposit, 32).u(2, 8).u(roundId, 8).u(1, 16).u(1, 8).u(0, 2);
    const notification = cell().u(TX_OP.transferNotification, 32).u(lt + 1n, 64).coins(amount).address(owner).u(1, 1).ref(payload);
    pushTx(TX_OP.transferNotification, notification, [
      { op: EVENT_OP.depositRefunded, body: cell().u(EVENT_OP.depositRefunded, 32).address(owner).u(amount, 128).bool(instant) },
    ], ADDR.rcWallet);
  };

  const closeStaking = (roundId: number): void => {
    const rd = rounds.get(roundId)!;
    rd.status = 4;
    pushTx(TX_OP.closeStaking, cell().u(TX_OP.closeStaking, 32).u(2, 64).u(0, 128), [
      { op: STAKING_CLOSED, body: cell().u(STAKING_CLOSED, 32).u(roundId, 8).u(rd.stakeCloseAt, 64).bool(false).u(0, 128) },
    ]);
  };

  /** 结算（第 24 根 K 线）：返回本笔交易的事件（RoundSettled，成功且释放团队额时加 TeamReleased）。 */
  const settle = (roundId: number, success: boolean): { op: number; body: CellBuilder }[] => {
    const rd = rounds.get(roundId)!;
    let rewardBurn = 0n, teamBurn = 0n, principalBurn = 0n, teamReleased = 0n;
    if (success) {
      rd.status = 8;
      successCount += 1;
      lastSuccessRound = roundId;
      teamReleased = teamPending;
      teamPending = CONFIG.teamRoundRaw;
      if (rd.totalStake === 0n) carry += rd.budget;
    } else {
      rd.status = 9;
      rewardBurn = rd.budget / 2n;
      carry += rd.budget - rewardBurn;
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
    const events: { op: number; body: CellBuilder }[] = [{
      op: EVENT_OP.roundSettled,
      body: cell().u(EVENT_OP.roundSettled, 32).u(roundId, 8).u(rd.status, 8).u(rd.qualified, 8).u(rd.candlesSeen, 8)
        .u(rd.totalStake, 128).u(successCount + 1, 8).u(rewardBurn, 128).u(teamBurn, 128).u(principalBurn, 128).u(teamReleased, 128)
        .u(rd.budget, 128).u(carry, 128),
    }];
    if (teamReleased > 0n) events.push({ op: EVENT_OP.teamReleased, body: cell().u(EVENT_OP.teamReleased, 32).u(roundId, 8).u(teamReleased, 128) });
    return events;
  };

  const candles = async (roundId: number, qualifyingCount: number): Promise<void> => {
    const rd = rounds.get(roundId)!;
    const success = qualifyingCount >= Number(CONFIG.minQualifiedCandles);
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
          body: cell().u(CANDLE_SUBMITTED, 32).u(roundId, 8).u(index, 8).u(periodStart, 32).u(periodStart + 3600, 32).u(twap, 128).u(digest, 256).u(BigInt('0x' + bytesToHex(rd.candleHash)), 256),
        },
      ];
      if (index === Number(CONFIG.candleCount) - 1) events.push(...settle(roundId, success));
      pushTx(TX_OP.submitCandle, body, events);
    }
  };

  /** 攻城令领取（owner → 攻城令 → RC）。restake = 一键续战：本金滚入当前轮，只付 20% 立即奖励。 */
  const requestTicket = (owner: string, roundId: number, restake: boolean): void => {
    const ticket = ticketOf(owner, roundId);
    const rd = rounds.get(roundId)!;
    let principal = 0n;
    let reward = 0n;
    if (rd.status === 8) {
      const reward0 = (rd.budget * ticket.weight) / rd.totalWeight;
      const immediate = (reward0 * IMMEDIATE_BPS) / BPS;
      const locked = reward0 - immediate;
      const unlocked = lastSuccessRound > roundId ? locked : 0n;
      if (!ticket.principalDone) {
        principal = restake ? 0n : ticket.amount;
        reward += immediate;
        ticket.principalDone = true;
      }
      if (unlocked > ticket.lockedClaimed) {
        reward += unlocked - ticket.lockedClaimed;
        ticket.lockedClaimed = unlocked;
      }
    }
    const body = cell().u(TX_OP.ticketRequest, 32).u(lt + 2n, 64).address(owner).u(roundId, 8).u(ticket.amount, 128).u(ticket.weight, 128)
      .bool(ticket.principalDone).u(ticket.lockedClaimed, 128).bool(restake);
    const events: { op: number; body: CellBuilder }[] = [];
    if (restake) {
      const cur = rounds.get(currentRound)!;
      const principalMoved = ticket.amount - 0n;
      const weight = (principalMoved * BPS_FIRST) / BPS; // 续战在攻城期首段
      cur.totalStake += principalMoved;
      cur.totalWeight += weight;
      depositCount.set(currentRound, (depositCount.get(currentRound) ?? 0) + 1);
      const next = ticketOf(owner, currentRound);
      next.amount += principalMoved;
      next.weight += weight;
      events.push({ op: EVENT_OP.restaked, body: cell().u(EVENT_OP.restaked, 32).address(owner).u(roundId, 8).u(currentRound, 8).u(principalMoved, 128).u(weight, 128) });
      events.push({
        op: EVENT_OP.depositAccepted,
        body: cell().u(EVENT_OP.depositAccepted, 32).u(currentRound, 8).address(owner).u(principalMoved, 128).u(weight, 128).u(cur.totalStake, 128).u(cur.totalWeight, 128),
      });
    }
    if (reward > 0n || principal > 0n) {
      events.push({ op: EVENT_OP.claimed, body: cell().u(EVENT_OP.claimed, 32).address(owner).u(roundId, 8).u(principal, 128).u(reward, 128) });
      walletBalance -= principal + reward;
    }
    pushTx(TX_OP.ticketRequest, body, events, ticketAddress(owner, roundId));
  };

  // ---------------- 场景 ----------------
  openRound(1, 100_000n);
  deposit(1, ADDR.userA, 300_000n * A9, BPS_FIRST);
  deposit(1, ADDR.userB, 100_000n * A9, BPS_LAST);
  closeStaking(1);
  await candles(1, 24);
  requestTicket(ADDR.userA, 1, false); // A 首领：本金 + 20%

  openRound(2, 100_000n);
  requestTicket(ADDR.userB, 1, true); // B 一键续战：本金滚入 R2，只领 20%
  deposit(2, ADDR.userC, 200_000n * A9, BPS_SECOND);
  refund(ADDR.userA, 500n * A9, true, 2); // 无效且 TON 足够 → 即时退回
  refund(ADDR.userC, 500n * A9, false, 2); // 无效且 TON 不足 → 留存
  closeStaking(2);
  await candles(2, 3);

  openRound(3, 100_000n);
  deposit(3, ADDR.userA, 100_000n * A9, BPS_LAST);
  closeStaking(3);
  await candles(3, 24);
  requestTicket(ADDR.userA, 3, false); // A 领 R3 本金 + 20%
  requestTicket(ADDR.userA, 1, false); // A 领 R1 压城 80%（R3 破城后已解锁）
  requestTicket(ADDR.userB, 1, false); // B 领 R1 压城 80%

  openRound(4, 100_000n);
  // R4 保持 PREVIEW 之后的状态（未开窗），用于 currentRound / 非终态轮次覆盖

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
    num(0), num(0), num(CONFIG.previewSeconds), num(CONFIG.stakeDurationSeconds),
    num(CONFIG.candleSeconds), num(CONFIG.candleCount), num(CONFIG.minQualifiedCandles), num(observationSeconds),
    num(CONFIG.abortTimeoutSeconds), num(CONFIG.abortTimeoutSeconds), num(CONFIG.riskDisclosureVersion), num(CONFIG.configVersion),
  ]);
  put(ADDR.rc, 'get_current_round', [], [num(currentRound)]);
  put(ADDR.rc, 'get_success_count', [], [num(successCount)]);
  put(ADDR.rc, 'get_protocol_state', [], [
    num(carry), num(lastSuccessRound), num(teamPending), num(endAt), num(successCount), num(currentRound), num(CONFIG.fallbackUnlockSeconds),
  ]);
  put(ADDR.rc, 'get_jetton_wallet_address', [], [addressItem(ADDR.rcWallet)]);
  put(ADDR.rcWallet, 'get_wallet_data', [], [num(walletBalance), addressItem(ADDR.rc), addressItem(ADDR.jm)]);
  let burned = 0n;
  for (const [, rd] of rounds) {
    if (rd.status === 9) burned += rd.budget / 2n + CONFIG.teamRoundRaw + rd.totalStake;
  }
  put(ADDR.jm, 'get_jetton_data', [], [num(10_000_000_000n * A9 - burned), num(0), ['null']]);

  for (const [roundId, rd] of rounds) {
    const opened = rd.status !== 0 && rd.status !== 1;
    const failed = rd.status === 9;
    put(ADDR.rc, 'get_round', [numArg(roundId)], [
      num(roundId), num(rd.status), num(rd.tier), num(rd.target), num(rd.twap24h), num(opened ? rd.stakeOpenAt : 0),
      num(opened ? rd.budget : 0), num(rd.stakeOpenAt), num(opened ? rd.stakeCloseAt : 0),
      num(opened ? rd.stakeCloseAt : 0), num(opened ? rd.stakeCloseAt + Number(observationSeconds) : 0),
      num(rd.candlesSeen), num(rd.qualified), num(rd.totalStake), num(rd.settledAt),
      num(rd.teamOk ? 1 : 0), num(failed && rd.burnOk ? 1 : 0), num(rd.burnOk ? 1 : 0), num(failed && rd.burnOk ? 1 : 0),
      num(0), num(BigInt('0x' + bytesToHex(rd.candleHash))), num(rd.totalWeight),
    ]);
    put(ADDR.rc, 'get_round_total_stake', [numArg(roundId)], [num(rd.totalStake)]);
    put(ADDR.rc, 'get_round_staker_count', [numArg(roundId)], [num(depositCount.get(roundId) ?? 0)]);
  }
  for (const ticket of tickets.values()) {
    const ownerArg = addressArg({ workchain: 0, hashHex: ticket.owner.slice(2) });
    const tAddr = ticketAddress(ticket.owner, ticket.roundId);
    put(ADDR.rc, 'get_ticket_address', [ownerArg, numArg(ticket.roundId)], [addressItem(tAddr)]);
    put(tAddr, 'get_ticket_data', [], [
      addressItem(ADDR.rc), addressItem(ticket.owner), num(ticket.roundId), num(ticket.amount), num(ticket.weight),
      num(ticket.principalDone ? 1 : 0), num(ticket.lockedClaimed), num(0),
    ]);
    const rd = rounds.get(ticket.roundId)!;
    const reward0 = rd.status === 8 && rd.totalWeight > 0n ? (rd.budget * ticket.weight) / rd.totalWeight : 0n;
    const immediate = (reward0 * IMMEDIATE_BPS) / BPS;
    const locked = reward0 - immediate;
    const unlocked = lastSuccessRound > ticket.roundId ? locked : 0n;
    put(ADDR.rc, 'get_reward_preview', [numArg(ticket.roundId), numArg(ticket.weight)], [num(reward0), num(immediate), num(locked), num(unlocked)]);
  }

  return {
    meta: {
      network: 'testnet',
      recordedAt: 'synthetic',
      rc: ADDR.rc,
      jm: ADDR.jm,
      tw: ADDR.teamWallet,
      keeper: ADDR.keeper,
      note: '由 make-v11-fixture.ts 按 v11 ABI 合成（v11 尚无测试网实例可录制）；字段布局见 contracts/contracts/types.tolk 与 ticket.tolk。',
      expectedWalletBalance: walletBalance.toString(),
    },
    v2,
    v3: { transactions: { [ADDR.rc]: txs } },
  };
}

async function main(): Promise<void> {
  const out = process.argv[2];
  if (!out) {
    console.error('用法：node make-v11-fixture.js <out.json>');
    process.exit(2);
  }
  const fixture = await buildV11Fixture();
  require('fs').writeFileSync(out, JSON.stringify(fixture, null, 1) + '\n');
  console.log('wrote ' + out + ' txs=' + fixture.v3.transactions[ADDR.rc].length + ' getters=' + Object.keys(fixture.v2).length);
}

if (process.argv[1] && process.argv[1].endsWith('make-v11-fixture.js')) void main();
