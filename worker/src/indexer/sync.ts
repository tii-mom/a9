/**
 * 链上索引器编排层（cron 单写者）。
 *
 * 一次 tick 的固定流程：
 *  1. 配置：env + 期望 configVersion/Hash（不一致 → 拒绝出数，ORACLE_PAUSED）
 *  2. 租约：D1 metrics 原子租约，避免 cron 与 admin tick 重叠
 *  3. 引导：首次运行为 R1..R10 插入 UNOPENED 行（INSERT OR IGNORE，绝不 REPLACE）
 *  4. 增量拉取：v3 /transactions 按 lt 游标分页（只消费 finality=finalized），一次 tick 最多 N 页
 *  5. 解码：入站消息（SubmitCandle 等）+ external-out 事件（DepositAccepted 等）
 *  6. 写库：K 线 / 质押 / 推荐关系 / 销毁三态 / 轮次快照（全部幂等键控）
 *  7. getter 锚定：关键节点用 get_round / get_jetton_data 复核，不一致只告警不覆盖
 *  8. 健康：成功/失败写 metrics，失败按类型退避，永不抛出、永不回退 demo
 *
 * 铁律：链上状态是唯一权威；本文件之外（sources/chain.ts）不得发网络请求。
 */
import type { Env } from '../env';
import { ownWeightFor } from '../protocol';
import type { Params } from '../protocol';
import { REFERRAL_BONUS_BPS } from '../protocol';
import * as v8 from '../v8';
import * as store from '../store';
import type { CandleRow, RoundRow, StakeRow } from '../store';
import { resolveChainConfig } from './config';
import type { ChainConfig, ProtocolConfigFields } from './config';
import { createChainClient } from './chain-client';
import type { ChainClient, ChainMessage, ChainTx } from './chain-client';
import {
  digestProtocolConfig,
  getJettonData,
  getProtocolConfig,
  getRound,
  getTeamVaultState,
  type ChainRoundView,
} from './getters';
import { decodeEvent, EVENT_OP, type ChainEvent } from './events';
import { decodeInboundMessage, TX_OP, type DecodedInboundMessage } from './messages';
import { buildCandleRow, buildRoundPatch, chainStatusToRoundState, isActiveChainStatus, isTerminalChainStatus } from './snapshot';
import {
  BURN_KINDS,
  burnRef,
  computeFailureBurnId,
  confirmedBurnedTotal,
  deriveBurnObservations,
  expectedBurnAmount,
  type BurnKind,
} from './ledger';
import { HEALTH_KEY, markFailure, markHealthy, readChainHealth } from './health';
import { parseTonAddress } from './address';

/** 单次 tick 的结果。必填字段是 backend-dev 接线依赖的最小集合，其余为诊断扩展（可选）。 */
export interface IndexerTickResult {
  ok: boolean;
  /** 未真正同步的原因：租约被占 / 未到轮询时间 / 配置不一致等；正常跑完不带该字段 */
  skipped?: 'lease' | 'not_due' | 'config_mismatch' | 'not_chain' | 'no_api_key';
  pages: number;
  writes: number;
  error?: string;
  events?: number;
  candles?: number;
  stakes?: number;
  claims?: number;
  healthy?: boolean;
  /** 本次 tick 实际使用的轮询间隔（毫秒），便于观测降级 */
  nextPollMs?: number;
}

const LEASE_KEY = 'indexer:lease';

/** 调试开关（仅本地/排障：env.INDEXER_DEBUG=1 时打印 tick 阶段日志）。 */
function debugEnabled(env: Env): boolean {
  return String((env as unknown as Record<string, string | undefined>).INDEXER_DEBUG ?? '') === '1';
}

function debugLog(env: Env, message: string): void {
  if (debugEnabled(env)) console.log('[indexer] ' + message);
}

/** 读取可选整数 env（本地 e2e/压测用；生产不设置即走默认值）。 */
function intEnv(env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = Number.parseInt(String((env as unknown as Record<string, string | undefined>)[key] ?? ''), 10);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, raw));
}
const CURSOR_RC = 'chain:cursor:rc';
const CURSOR_TV = 'chain:cursor:tv';
const CONFIG_CACHE = 'chain:config';
const CONFIG_FETCH_INTERVAL_MS = 10 * 60 * 1000;
const MAX_PAGES_PER_TICK = 5;
const MAX_GETTER_ROUNDS_PER_TICK = 3;
const STALE_MS = 10 * 60 * 1000;
const DAY_MS = 86_400_000;

interface Cursor {
  lt: string;
  hash: string;
  txNow: number;
}

function readCursor(kv: Map<string, string>, key: string): Cursor | null {
  const raw = kv.get(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Cursor>;
    if (typeof parsed.lt === 'string' && typeof parsed.hash === 'string') {
      return { lt: parsed.lt, hash: parsed.hash, txNow: Number(parsed.txNow ?? 0) || 0 };
    }
  } catch {
    /* 游标损坏 → 当作首次运行，从链上最早交易重建（幂等写入安全） */
  }
  return null;
}

function cursorValue(tx: ChainTx): Cursor {
  return { lt: tx.lt, hash: tx.hash, txNow: tx.now };
}

function isFinalized(tx: ChainTx): boolean {
  return tx.finality === undefined || tx.finality === 'finalized';
}

/** 按 lt 游标分页拉取（start_lt 是 inclusive，所以过滤 <= 游标）；只接受 finality=finalized。 */
async function pullTransactions(
  client: ChainClient,
  account: string,
  cursor: Cursor | null,
  maxPages: number,
): Promise<{ txs: ChainTx[]; next: Cursor | null; pages: number }> {
  const txs: ChainTx[] = [];
  let pages = 0;
  let startLt = cursor?.lt;
  let seenLt = cursor?.lt ?? null;
  let next: Cursor | null = null;
  for (let page = 0; page < maxPages; page++) {
    const batch = await client.transactions({ account, startLt, limit: 100, sort: 'asc' });
    pages++;
    if (!batch.length) break;
    let stopped = false;
    for (const tx of batch) {
      if (seenLt !== null && BigInt(tx.lt) <= BigInt(seenLt)) continue;
      if (!isFinalized(tx)) {
        stopped = true;
        continue;
      }
      txs.push(tx);
      seenLt = tx.lt;
      next = cursorValue(tx);
    }
    const lastLt = batch[batch.length - 1].lt;
    if (stopped || batch.length < 100 || lastLt === startLt) break;
    startLt = lastLt;
  }
  return { txs, next, pages };
}

/** 提取一笔交易里的 external-out 事件（destination=null 且有 opcode）。 */
function eventsOfTx(tx: ChainTx, emitter: string): ChainEvent[] {
  const events: ChainEvent[] = [];
  for (const message of tx.out_msgs ?? []) {
    if (message.destination) continue;
    if (!message.opcode || !message.message_content?.body) continue;
    const opcode = Number.parseInt(message.opcode, 16);
    if (!Number.isFinite(opcode)) continue;
    const event = decodeEvent({ emitter, txLt: tx.lt, txHash: tx.hash, txNow: tx.now, opcode, body: message.message_content.body });
    if (event) events.push(event);
  }
  return events;
}

/** 提取一笔交易里打到目标合约的入站消息。 */
function inboundOfTx(tx: ChainTx, targetRaw: string): DecodedInboundMessage[] {
  const inbound: DecodedInboundMessage[] = [];
  const message = tx.in_msg;
  if (!message || !message.opcode || !message.message_content?.body) return inbound;
  if (message.destination && parseTonAddress(message.destination)?.raw !== targetRaw) return inbound;
  const opcode = Number.parseInt(message.opcode, 16);
  if (!Number.isFinite(opcode)) return inbound;
  const decoded = decodeInboundMessage({ opcode, body: message.message_content.body });
  if (decoded) inbound.push(decoded);
  return inbound;
}

/** 计算地址在本轮入账时的 streak（与合约 streakForRound 同口径：同轮保持 / 上轮 +1 / 否则 1，封顶 10）。 */
function streakFor(stakesByAddress: Map<string, StakeRow[]>, address: string, roundId: number): number {
  const rows = stakesByAddress.get(address) ?? [];
  if (!rows.length) return 1;
  const lastRound = rows.reduce((max, row) => Math.max(max, row.round_id), 0);
  const lastStreak = rows.filter((row) => row.round_id === lastRound).reduce((max, row) => Math.max(max, row.streak ?? 1), 0);
  if (lastRound === roundId) return Math.min(lastStreak, 10);
  if (lastRound + 1 === roundId) return Math.min(lastStreak + 1, 10);
  return 1;
}

function groupStakes(rows: StakeRow[]): Map<string, StakeRow[]> {
  const map = new Map<string, StakeRow[]>();
  for (const row of rows) {
    const list = map.get(row.address);
    if (list) list.push(row);
    else map.set(row.address, [row]);
  }
  return map;
}

function groupCandles(rows: CandleRow[]): Map<number, CandleRow[]> {
  const map = new Map<number, CandleRow[]>();
  for (const row of rows) {
    const list = map.get(row.round_id);
    if (list) list.push(row);
    else map.set(row.round_id, [row]);
  }
  for (const list of map.values()) list.sort((a, b) => a.candle_index - b.candle_index);
  return map;
}

/** 根据 D1 轮次状态决定本次 tick 之后多久再拉（省请求：不逐块轮询）。 */
function nextPollIntervalMs(rounds: RoundRow[], now: number, lastOkAt: number): number {
  const active = rounds.filter((round) => isActiveChainStatus(round.chain_status ?? 0));
  const states = new Set(rounds.map((round) => round.state));
  if (states.has('SETTLING_SUCCESS') || states.has('SETTLING_FAILURE')) return 15_000;
  if (states.has('STAKING_OPEN')) return 60_000;
  if (states.has('OBSERVING') || states.has('STAKING_CLOSED') || states.has('ORACLE_PAUSED')) return 5 * 60_000;
  if (active.length) return 60_000;
  // 无活跃轮次：预告期/未开轮，低频心跳即可
  if (lastOkAt > 0 && now - lastOkAt < STALE_MS) return 5 * 60_000;
  return 10 * 60_000;
}

interface TickContext {
  env: Env;
  now: number;
  config: ChainConfig;
  client: ChainClient;
  kv: Map<string, string>;
  rounds: RoundRow[];
  configFields: ProtocolConfigFields;
  configDigest: string;
  pages: number;
  writes: number;
  events: number;
  candles: number;
  stakes: number;
  claims: number;
}

/** 拉取/刷新链上配置（10 分钟缓存），并做 configVersion / configHash 一致性校验。 */
async function ensureConfig(ctx: TickContext): Promise<{ changed: boolean }> {
  const { env, kv, now, config, client } = ctx;
  const cachedRaw = kv.get(CONFIG_CACHE);
  let cached: { fetchedAt: number; fields: ProtocolConfigFields; digest: string } | null = null;
  if (cachedRaw) {
    try {
      const parsed = JSON.parse(cachedRaw) as { fetchedAt: number; fields: ProtocolConfigFields; digest: string };
      if (parsed && parsed.fields) cached = parsed;
    } catch {
      cached = null;
    }
  }
  let fields = cached?.fields ?? null;
  let digest = cached?.digest ?? null;
  let changed = false;
  if (!fields || !digest || now - cached!.fetchedAt > CONFIG_FETCH_INTERVAL_MS) {
    fields = await getProtocolConfig(client, config.addresses.roundController.raw);
    digest = await digestProtocolConfig(config.network, fields);
    cached = { fetchedAt: now, fields, digest };
    await store.setMetrics(env, { [CONFIG_CACHE]: JSON.stringify(cached) }, now);
    changed = true;
  }

  // 配置一致性校验：版本、hash、关键地址三者任一不符都拒绝出数
  const versionMismatch =
    config.expectedConfigVersion !== null && Number.parseInt(fields.configVersion, 10) !== config.expectedConfigVersion;
  const hashMismatch = config.expectedConfigHash !== null && digest.toLowerCase() !== config.expectedConfigHash.toLowerCase();
  const addressMismatch =
    parseTonAddress(fields.jettonMaster)?.raw !== config.addresses.jettonMaster.raw ||
    parseTonAddress(fields.teamVault)?.raw !== config.addresses.teamVault.raw;
  if (versionMismatch || hashMismatch || addressMismatch) {
    const reasons: string[] = [];
    if (versionMismatch) reasons.push('configVersion 链上=' + fields.configVersion + ' 期望=' + config.expectedConfigVersion);
    if (hashMismatch) reasons.push('configHash 链上=' + digest + ' 期望=' + config.expectedConfigHash);
    if (addressMismatch) reasons.push('地址不一致（jettonMaster/teamVault）');
    throw Object.assign(new Error('ORACLE_CONFIG_MISMATCH: ' + reasons.join('; ')), { kind: 'config' as const, digest, fields });
  }

  // 链路配置写回 D1 config（buildParams 会读；这是 chain 模式参数唯一来源）
  const entries: Record<string, string> = {
    p0_usd_e8: fields.p0UsdE8,
    price_multiplier: fields.priceMultiplier,
    round_reward_raw: fields.roundRewardRaw,
    team_round_raw: fields.teamRoundRaw,
    min_stake_raw: fields.minStakeRaw,
    max_total_stake_raw: fields.maxTotalStakeRaw,
    candle_seconds: fields.candleSeconds,
    candle_count: fields.candleCount,
    min_qualified_candles: fields.minQualifiedCandles,
    observation_seconds: fields.observationSeconds,
    stake_duration_seconds: fields.stakeDurationSeconds,
    stake_gap_seconds: fields.previewSeconds,
    risk_disclosure_version: fields.riskDisclosureVersion,
    contract_round_controller: config.addresses.roundController.raw,
    contract_jetton_master: config.addresses.jettonMaster.raw,
    contract_team_vault: config.addresses.teamVault.raw,
    contract_oracle_config_hash: digest,
  };
  for (const [key, value] of Object.entries(entries)) {
    if (kv.get(key) !== value) {
      await store.setConfigValues(env, { [key]: value }, now);
      ctx.writes++;
    }
  }
  // 地址的 friendly 形式（前端展示用）
  if (kv.get('contract_round_controller_friendly') !== config.addresses.roundController.input) {
    await store.setConfigValues(
      env,
      {
        contract_round_controller_friendly: config.addresses.roundController.input,
        contract_team_vault_friendly: config.addresses.teamVault.input,
        contract_jetton_master_friendly: config.addresses.jettonMaster.input,
      },
      now,
    );
    ctx.writes++;
  }
  await store.setMetrics(
    env,
    {
      [HEALTH_KEY.configVersion]: fields.configVersion,
      [HEALTH_KEY.configHash]: digest,
      [HEALTH_KEY.configMismatch]: '0',
    },
    now,
  );
  ctx.configFields = fields;
  ctx.configDigest = digest;
  return { changed };
}

/** 首次引导：确保 R1..R10 存在且为 UNOPENED（INSERT OR IGNORE，绝不 REPLACE 造成级联删除）。 */
async function ensureBootstrap(ctx: TickContext): Promise<void> {
  const { env, kv, now, rounds, configFields } = ctx;
  if (kv.get(HEALTH_KEY.bootstrapped) === '1' && rounds.length > 0) return;
  // 防串库：D1 里若存在演示循环痕迹，说明这是 demo 数据集；chain 模式必须先在干净库上引导，
  // 否则会把演示轮次/假销毁当真数据展示（绝不允许演示兜底）。
  if (kv.get('demo_cycle') !== undefined || kv.get('demo_epoch_ms') !== undefined) {
    throw Object.assign(new Error('D1 中存在演示数据（demo_cycle/demo_epoch_ms），chain 模式需先清库再引导（禁止演示数据兜底）'), {
      kind: 'config' as const,
    });
  }
  const seeds = [] as store.RoundChainSeed[];
  const existing = new Set(rounds.map((round) => round.round_id));
  for (let roundId = 1; roundId <= 10; roundId++) {
    if (existing.has(roundId)) continue;
    seeds.push({
      round_id: roundId,
      state: 'UNOPENED',
      target_price_usd_e8: '0',
      reward_budget_raw: configFields.roundRewardRaw,
      chain_status: 0,
      updated_at: now,
    });
  }
  if (seeds.length) await store.ensureRoundRows(env, seeds);
  await store.setMetrics(env, { [HEALTH_KEY.bootstrapped]: '1' }, now);
  if (seeds.length) ctx.writes += seeds.length;
  ctx.rounds = await store.listRounds(env);
}

/** 处理一条批次的链上数据 → D1（K 线 / 质押 / 推荐 / 领取）。 */
async function applyBatch(ctx: TickContext, rcTxs: ChainTx[], tvTxs: ChainTx[]): Promise<void> {
  const { env, now, rounds, configFields } = ctx;
  const rcRaw = ctx.config.addresses.roundController.raw;
  const roundById = new Map(rounds.map((round) => [round.round_id, round]));
  const allStakes = await store.listAllStakes(env);
  const stakesByAddress = groupStakes(allStakes);
  const referrals = new Map<string, string>();
  for (const row of await store.listReferrals(env)) referrals.set(row.address, row.referrer);
  const candleRows = groupCandles(await store.listCandlesAll(env));

  const candleBatch: CandleRow[] = [];
  const referralBatch: { address: string; referrer: string; created_at: number }[] = [];

  // 第一遍：先应用开轮目标价事件（TargetPriceSet），否则同批次后面的 SubmitCandle 拿不到 target 会被跳过。
  // 链上顺序保证 OpenRound（TargetPriceSet）先于该轮任何 SubmitCandle，但两遍扫描才不依赖「同一页内」的偶然顺序。
  const targets = new Map<number, bigint>();
  for (const tx of rcTxs) {
    if (tx.aborted || tx.description?.aborted) continue;
    for (const event of eventsOfTx(tx, rcRaw)) {
      if (event.opcode !== EVENT_OP.targetPriceSet) continue;
      targets.set(event.roundId, event.targetPriceUsdE8);
      const previous = roundById.get(event.roundId);
      if (!previous) continue;
      const patch = {
        target_price_usd_e8: event.targetPriceUsdE8.toString(),
        target_tier: event.tier,
        target_twap24h_usd_e8: event.twap24hUsdE8.toString(),
      };
      const changed = await store.patchRoundChain(env, event.roundId, patch, now);
      if (changed) {
        ctx.writes++;
        previous.target_price_usd_e8 = patch.target_price_usd_e8;
        previous.target_tier = patch.target_tier;
        (previous as RoundRow & { target_twap24h_usd_e8?: string | null }).target_twap24h_usd_e8 = patch.target_twap24h_usd_e8;
      }
    }
  }

  for (const tx of rcTxs) {
    if (tx.aborted || tx.description?.aborted) continue;
    for (const inbound of inboundOfTx(tx, rcRaw)) {
      ctx.events++;
      if (inbound.opcode === TX_OP.submitCandle) {
        const round = roundById.get(inbound.roundId);
        const target = targets.get(inbound.roundId) ?? BigInt(round?.target_price_usd_e8 ?? '0');
        // 同一 (round, index) 只写一次；后续 rolling hash 复核会兜底
        if (target > 0n) candleBatch.push(buildCandleRow(inbound, target, now));
      }
    }
    for (const event of eventsOfTx(tx, rcRaw)) {
      ctx.events++;
      if (event.opcode === EVENT_OP.depositAccepted) {
        const exists = (stakesByAddress.get(event.owner.raw) ?? []).some(
          (row) => row.round_id === event.roundId && row.nonce === tx.lt,
        );
        if (exists) continue;
        const streak = streakFor(stakesByAddress, event.owner.raw, event.roundId);
        const inserted = await store.insertStake(env, {
          roundId: event.roundId,
          address: event.owner.raw,
          amountRaw: event.amountRaw,
          weightRaw: ownWeightFor(event.amountRaw, streak),
          nonce: tx.lt,
          riskDisclosureVersion: Number.parseInt(configFields.riskDisclosureVersion, 10),
          acceptFullPrincipalBurn: true,
          acceptedAt: tx.now * 1000,
          streak,
          referredBy: referrals.get(event.owner.raw) ?? null,
        });
        if (inserted) {
          ctx.stakes++;
          ctx.writes++;
          const list = stakesByAddress.get(event.owner.raw) ?? [];
          list.push({
            id: 0,
            round_id: event.roundId,
            address: event.owner.raw,
            amount_raw: event.amountRaw.toString(),
            weight_raw: '0',
            nonce: tx.lt,
            risk_disclosure_version: 0,
            accept_full_principal_burn: 1,
            streak,
            reward_state: 0,
            referred_by: referrals.get(event.owner.raw) ?? null,
            principal_claimed: 0,
            reward_claimed: 0,
            accepted_at: tx.now * 1000,
          });
          stakesByAddress.set(event.owner.raw, list);
        }
      } else if (event.opcode === EVENT_OP.referrerSet) {
        if (referrals.get(event.owner.raw) !== undefined) continue; // 一次性绑定，不可改
        referrals.set(event.owner.raw, event.referrer.raw);
        referralBatch.push({ address: event.owner.raw, referrer: event.referrer.raw, created_at: tx.now * 1000 });
        ctx.writes++;
      } else if (event.opcode === EVENT_OP.rewardEarly) {
        await store.insertClaimsBulk(env, [
          { round_id: event.roundId, address: event.owner.raw, kind: 'reward', amount_raw: event.paidRaw.toString(), claimed_at: tx.now * 1000 },
        ]);
        await store.updateRoundReward(env, {
          roundId: event.roundId,
          address: event.owner.raw,
          state: 2,
          paidRaw: event.paidRaw.toString(),
          lockedRaw: event.lockedRaw.toString(),
          now,
        });
        ctx.claims++;
        ctx.writes += 2;
      } else if (event.opcode === EVENT_OP.rewardRolled) {
        // V8 滚存：合约把奖励直接计进下一轮质押（**不会**发 DepositAccepted），必须在这里补一条 stake 行，
        // 否则轮次总质押/权重/奖励都会偏低（fast-test 实测 R4 差 2,000 万 A9）。
        const exists = (stakesByAddress.get(event.owner.raw) ?? []).some(
          (row) => row.round_id === event.nextRoundId && row.nonce === 'roll:' + tx.lt,
        );
        if (!exists) {
          const streak = streakFor(stakesByAddress, event.owner.raw, event.nextRoundId);
          const inserted = await store.insertStake(env, {
            roundId: event.nextRoundId,
            address: event.owner.raw,
            amountRaw: event.amountRaw,
            weightRaw: ownWeightFor(event.amountRaw, streak),
            nonce: 'roll:' + tx.lt,
            riskDisclosureVersion: Number.parseInt(configFields.riskDisclosureVersion, 10),
            acceptFullPrincipalBurn: true,
            acceptedAt: tx.now * 1000,
            streak,
            referredBy: referrals.get(event.owner.raw) ?? null,
          });
          if (inserted) {
            ctx.stakes++;
            ctx.writes++;
            const list = stakesByAddress.get(event.owner.raw) ?? [];
            list.push({
              id: 0,
              round_id: event.nextRoundId,
              address: event.owner.raw,
              amount_raw: event.amountRaw.toString(),
              weight_raw: '0',
              nonce: 'roll:' + tx.lt,
              risk_disclosure_version: 0,
              accept_full_principal_burn: 1,
              streak,
              reward_state: 0,
              referred_by: referrals.get(event.owner.raw) ?? null,
              principal_claimed: 0,
              reward_claimed: 0,
              accepted_at: tx.now * 1000,
            });
            stakesByAddress.set(event.owner.raw, list);
          }
        }
        await store.updateRoundReward(env, {
          roundId: event.roundId,
          address: event.owner.raw,
          state: 1,
          rolledRaw: event.amountRaw.toString(),
          now,
        });
        ctx.writes++;
      }
    }
  }

  if (candleBatch.length) {
    // 去重（同批次内可能重复；D1 PK 也会兜底）
    const seen = new Set<string>();
    const rows = candleBatch.filter((row) => {
      const key = row.round_id + ':' + row.candle_index;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    await store.insertCandles(env, rows);
    ctx.candles += rows.length;
    ctx.writes += rows.length;
    for (const row of rows) {
      const list = candleRows.get(row.round_id) ?? [];
      list.push(row);
      list.sort((a, b) => a.candle_index - b.candle_index);
      candleRows.set(row.round_id, list);
    }
  }
  if (referralBatch.length) await store.insertReferralsBulk(env, referralBatch);

  for (const tx of tvTxs) {
    if (tx.aborted || tx.description?.aborted) continue;
    for (const event of eventsOfTx(tx, ctx.config.addresses.teamVault.raw)) {
      ctx.events++;
      if (event.opcode === EVENT_OP.teamReleased || event.opcode === EVENT_OP.teamBurned) {
        await store.logEvent(
          env,
          'info',
          'indexer',
          event.opcode === EVENT_OP.teamReleased ? 'TEAM_RELEASED' : 'TEAM_BURNED',
          'R' + event.roundId + ' amount=' + event.amountRaw.toString() + ' tx=' + tx.lt,
        );
        ctx.writes++;
      }
    }
  }
}

/** 用 get_round 锚定刷新轮次快照 + 三笔销毁确认状态。 */
async function refreshRounds(ctx: TickContext, roundIds: number[]): Promise<void> {
  const { env, now, client, configFields } = ctx;
  const rounds = await store.listRounds(env);
  const roundById = new Map(rounds.map((round) => [round.round_id, round]));
  const candlesAll = groupCandles(await store.listCandlesAll(env));
  const rcRaw = ctx.config.addresses.roundController.raw;

  const getterCap = intEnv(env, 'INDEXER_MAX_GETTER_ROUNDS', MAX_GETTER_ROUNDS_PER_TICK, 1, 10);
    for (const roundId of roundIds.slice(0, getterCap)) {
    let view: ChainRoundView;
    try {
      view = await getRound(client, rcRaw, roundId);
    } catch (error) {
      await store.logEvent(env, 'warn', 'indexer', 'INDEXER_GETTER_WARN', 'get_round(' + roundId + ') 失败：' + String(error).slice(0, 200));
      continue;
    }
    const previous = roundById.get(roundId) ?? null;
    const candles = candlesAll.get(roundId) ?? [];
    debugLog(env, 'round ' + roundId + ' status=' + view.status + ' seen=' + view.candlesSeen + ' candlesRows=' + candles.length);

    // ORACLE 恢复：链上重置了观察窗口 → 清掉旧 K 线，避免混合两个窗口
    if (
      previous &&
      previous.state === 'ORACLE_PAUSED' &&
      chainStatusToRoundState(view.status) === 'OBSERVING' &&
      view.observationStart > 0 &&
      previous.observation_start !== view.observationStart * 1000
    ) {
      await store.resetRoundWindow(env, roundId, view.observationStart * 1000, view.observationEnd * 1000, now);
      await store.patchRoundChain(env, roundId, { last_candle_twap_usd_e8: null, last_candle_at: null }, now);
      candlesAll.set(roundId, []);
      ctx.writes++;
      await store.logEvent(env, 'warn', 'indexer', 'INDEXER_WINDOW_RESET', 'R' + roundId + ' 链上观察窗口重置，已清空旧 K 线');
    }

    // 销毁三态：status 7/9 视为已 dispatched；flags 为 confirmed
    const burnRound = view.status === 7 || view.status === 9 || (view.status === 8 && view.rewardBurnConfirmed);
    if (burnRound) {
      // 链上 failureBurnId 复算校验（只告警，不阻塞）
      if (view.status === 9 && view.failureBurnId !== '0x' + '0'.repeat(64)) {
        const expectedBurnId = await computeFailureBurnId(roundId, Number.parseInt(configFields.configVersion, 10));
        if (view.failureBurnId !== expectedBurnId) {
          await store.logEvent(env, 'error', 'indexer', 'INDEXER_BURN_ID_MISMATCH', 'R' + roundId + ' burnId 链上=' + view.failureBurnId + ' 计算=' + expectedBurnId);
        }
      }
      const confirmed = deriveBurnObservations(view, configFields);
      const confirmedKinds = new Set(confirmed.map((item) => item.kind));
      for (const kind of BURN_KINDS) {
        const amount = expectedBurnAmount(kind, configFields, view.totalAcceptedStakeRaw);
        if (kind === 'principal' && amount === 0n) continue;
        const isConfirmed = confirmedKinds.has(kind);
        const changed = await store.upsertBurnLedger(env, {
          roundId,
          kind,
          amountRaw: amount.toString(),
          burnRef: burnRef(roundId, kind),
          confirmed: isConfirmed,
          txHash: null,
          now,
        });
        if (changed) ctx.writes++;
      }
    }

    const burned = view.status === 9 ? confirmedBurnedTotal(view, configFields) : null;
    const patch = buildRoundPatch({
      view,
      config: configFields,
      previous,
      candles,
      burnedRaw: burned === null ? null : burned.toString(),
      now,
    });
    if (Object.keys(patch).length) {
      const changed = await store.patchRoundChain(env, roundId, patch, now);
      if (changed) ctx.writes++;
    }
    await syncRoundRewards(ctx, roundId, view);
  }
}

/**
 * chain 模式下 v8.syncV8Rounds 整体跳过（backend-dev B3/H-7），所以成功轮的奖励三态账本由索引器负责：
 * 用链上 get_round.totalWeight 作为分母、D1 stakes 作为权重来源，复算每地址 reward 并整轮落库（保留已领三态）。
 */
async function syncRoundRewards(ctx: TickContext, roundId: number, view: ChainRoundView): Promise<void> {
  if (chainStatusToRoundState(view.status) !== 'SUCCEEDED') return;
  const stakes = await store.listStakesForRound(ctx.env, roundId);
  if (!stakes.length) return;
  const round = await store.getRound(ctx.env, roundId);
  if (!round) return;
  const params = {
    minStakeRaw: BigInt(ctx.configFields.minStakeRaw || '0'),
    referralBonusBps: REFERRAL_BONUS_BPS,
  } as unknown as Params;
  const weights = v8.computeRoundWeights(params, stakes);
  if (view.totalWeight > 0n && weights.totalWeight !== view.totalWeight) {
    await store.logEvent(
      ctx.env,
      'warn',
      'indexer',
      'INDEXER_WEIGHT_DIVERGE',
      'R' + roundId + ' 本地权重合计=' + weights.totalWeight.toString() + ' 链上=' + view.totalWeight.toString() + '（以链上为分母）',
    );
    weights.totalWeight = view.totalWeight;
  }
  const existing = await store.listRoundRewards(ctx.env, roundId);
  const rows = v8.buildRewardRows(params, round, weights, ctx.now, existing);
  const drifted =
    rows.length !== existing.length ||
    rows.some((row) => {
      const prev = existing.find((item) => item.address === row.address);
      return !prev || prev.reward_raw !== row.reward_raw || prev.weight_raw !== row.weight_raw;
    });
  if (!drifted) return;
  await store.replaceRoundRewards(ctx.env, roundId, rows);
  ctx.writes++;
}

/** 刷新供应量与 24h 前价格缓存（低频）。 */
async function refreshCaches(ctx: TickContext): Promise<void> {
  const { env, now, kv, client, config } = ctx;
  const lastSupply = Number(kv.get('chain_supply_synced_at') ?? '0') || 0;
  if (now - lastSupply > CONFIG_FETCH_INTERVAL_MS) {
    try {
      const jetton = await getJettonData(client, config.addresses.jettonMaster.raw);
      // 关键口径：views 的 supply = total_supply_raw - burned_raw（演示同款公式）。
      // 因此 chain 模式必须写「初始供应量」而不是当前供应量，否则会重复扣减已销毁量。
      const burnRows = await store.listBurns(env);
      let burnedConfirmed = 0n;
      for (const row of burnRows) if (row.confirmed === 1) burnedConfirmed += BigInt(row.amount_raw);
      const initialSupply = jetton.totalSupplyRaw + burnedConfirmed;
      await store.setConfigValues(env, { total_supply_raw: initialSupply.toString() }, now);
      await store.setMetrics(
        env,
        {
          chain_supply_synced_at: String(now),
          chain_total_supply_raw: jetton.totalSupplyRaw.toString(),
          chain_burned_confirmed_raw: burnedConfirmed.toString(),
        },
        now,
      );
      ctx.writes++;
    } catch (error) {
      await store.logEvent(env, 'warn', 'indexer', 'INDEXER_SUPPLY_WARN', String(error).slice(0, 200));
    }
  }
  // 24h 前真实价格：取 period_end <= now-24h 的最近一根已上链 K 线
  const candles = await store.listCandlesAll(env);
  const cutoff = now - DAY_MS;
  let best: CandleRow | null = null;
  for (const candle of candles) {
    if (candle.period_end <= cutoff && (!best || candle.period_end > best.period_end)) best = candle;
  }
  if (best) {
    if (kv.get(HEALTH_KEY.price24hAgo) !== best.twap_price_usd_e8) {
      await store.setMetrics(env, { [HEALTH_KEY.price24hAgo]: best.twap_price_usd_e8 }, now);
      ctx.writes++;
    }
  }
}

const PENDING_ROUNDS = 'chain:pending_rounds';

/** 读取待 getter 锚定的轮次队列（跨 tick 排空，避免补数时一次打太多 getter）。 */
function readPendingRounds(kv: Map<string, string>): number[] {
  const raw = kv.get(PENDING_ROUNDS);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is number => typeof value === 'number' && value >= 1 && value <= 10);
  } catch {
    return [];
  }
}

/** 选择本 tick 需要 getter 锚定的轮次：待办队列优先，其次事件轮次 + 活跃轮 + 最新轮（上限 3 个）。 */
function pickRoundIds(rounds: RoundRow[], touched: Set<number>, pending: number[], cap: number): number[] {
  const picked: number[] = [];
  const push = (roundId: number): void => {
    if (roundId >= 1 && roundId <= 10 && !picked.includes(roundId)) picked.push(roundId);
  };
  for (const roundId of pending) push(roundId);
  for (const roundId of touched) push(roundId);
  const active = rounds
    .filter((round) => isActiveChainStatus(round.chain_status ?? 0) || round.state !== 'UNOPENED')
    .sort((a, b) => b.round_id - a.round_id)[0];
  if (active) push(active.round_id);
  const latest = rounds.reduce((max, round) => (round.round_id > max ? round.round_id : max), 1);
  push(latest);
  return picked.slice(0, cap);
}

/** tick 主体（租约内执行）。 */
async function runTick(env: Env, now: number, config: ChainConfig): Promise<IndexerTickResult> {
  const kv = await store.getKeyValues(env);
  const nextPollAt = Number(kv.get(HEALTH_KEY.nextPollAt) ?? '0') || 0;
  if (nextPollAt > now) {
    return { ok: true, skipped: 'not_due', pages: 0, writes: 0, healthy: readChainHealth(kv).healthy, nextPollMs: nextPollAt - now };
  }
  const rounds = await store.listRounds(env);
  const client = createChainClient(config);
  const ctx: TickContext = {
    env,
    now,
    config,
    client,
    kv,
    rounds,
    configDigest: '',
    configFields: {
      admin: '',
      oracle: '',
      jettonMaster: '',
      stakingJettonWallet: '',
      teamVault: '',
      p0UsdE8: '0',
      priceMultiplier: '0',
      roundRewardRaw: '0',
      teamRoundRaw: '0',
      minStakeRaw: '0',
      maxStakePerAddressBps: '0',
      maxTotalStakeRaw: '0',
      previewSeconds: '0',
      stakeDurationSeconds: '0',
      candleSeconds: '0',
      candleCount: '0',
      minQualifiedCandles: '0',
      observationSeconds: '0',
      techAbortPauseSeconds: '0',
      techAbortObsTimeoutSeconds: '0',
      riskDisclosureVersion: '1',
      configVersion: '0',
    },
    pages: 0,
    writes: 0,
    events: 0,
    candles: 0,
    stakes: 0,
    claims: 0,
  };

  debugLog(env, 'tick start now=' + now);
  await ensureConfig(ctx);
  debugLog(env, 'config ok version=' + ctx.configFields.configVersion);
  await ensureBootstrap(ctx);
  debugLog(env, 'bootstrap ok rounds=' + ctx.rounds.length);

  const rcCursor = readCursor(kv, CURSOR_RC);
  const rcPull = await pullTransactions(
    client,
    config.addresses.roundController.raw,
    rcCursor,
    intEnv(env, 'INDEXER_MAX_PAGES', MAX_PAGES_PER_TICK, 1, 20),
  );
  ctx.pages += rcPull.pages;
  debugLog(env, 'rc pull txs=' + rcPull.txs.length + ' pages=' + rcPull.pages);
  const tvCursor = readCursor(kv, CURSOR_TV);
  const tvPull = await pullTransactions(client, config.addresses.teamVault.raw, tvCursor, 2);
  ctx.pages += tvPull.pages;
  debugLog(env, 'tv pull txs=' + tvPull.txs.length + ' pages=' + tvPull.pages);

  const touched = new Set<number>();
  const collectRounds = (txs: ChainTx[], emitter: string, target: string): void => {
    for (const tx of txs) {
      for (const event of eventsOfTx(tx, emitter)) touched.add('roundId' in event ? (event as { roundId: number }).roundId : 0);
      for (const inbound of inboundOfTx(tx, target)) {
        if ('roundId' in inbound && typeof (inbound as { roundId?: number }).roundId === 'number') {
          touched.add((inbound as { roundId: number }).roundId);
        }
      }
    }
  };
  collectRounds(rcPull.txs, config.addresses.roundController.raw, config.addresses.roundController.raw);
  collectRounds(tvPull.txs, config.addresses.teamVault.raw, config.addresses.teamVault.raw);
  touched.delete(0);

  await applyBatch(ctx, rcPull.txs, tvPull.txs);
  debugLog(env, 'apply done writes=' + ctx.writes + ' candles=' + ctx.candles + ' stakes=' + ctx.stakes);

  // 游标只在数据落库后推进（幂等写入，崩溃重放安全）
  if (rcPull.next) {
    await store.setMetrics(env, { [CURSOR_RC]: JSON.stringify(rcPull.next) }, now);
    ctx.writes++;
  }
  if (tvPull.next) {
    await store.setMetrics(env, { [CURSOR_TV]: JSON.stringify(tvPull.next) }, now);
    ctx.writes++;
  }

  const refreshedRounds = await store.listRounds(env);
  const pending = readPendingRounds(kv);
  const merged = [...new Set([...pending, ...touched])];
  const roundIds = pickRoundIds(refreshedRounds, touched, pending, intEnv(env, 'INDEXER_MAX_GETTER_ROUNDS', MAX_GETTER_ROUNDS_PER_TICK, 1, 10));
  debugLog(env, 'refresh rounds=' + JSON.stringify(roundIds) + ' pending=' + JSON.stringify(pending));
  await refreshRounds(ctx, roundIds);
  debugLog(env, 'refresh done writes=' + ctx.writes);
  // 本 tick 没轮到的轮次留在队列里，下个 tick 继续（补数时不会漏掉中间轮次）
  const remaining = merged.filter((roundId) => !roundIds.includes(roundId));
  if (remaining.length !== pending.length || remaining.some((roundId, index) => roundId !== pending[index])) {
    await store.setMetrics(env, { [PENDING_ROUNDS]: JSON.stringify(remaining) }, now);
    ctx.writes++;
  }
  await refreshCaches(ctx);
  debugLog(env, 'caches done writes=' + ctx.writes);

  const latestRounds = await store.listRounds(env);
  const interval = intEnv(env, 'INDEXER_MIN_POLL_MS', nextPollIntervalMs(latestRounds, now, Number(kv.get(HEALTH_KEY.okAt) ?? '0') || 0), 1000, 10 * 60_000);
  await markHealthy(env, {
    now,
    nextPollAt: now + interval,
    pages: ctx.pages,
    events: ctx.events,
    configVersion: ctx.configFields.configVersion,
    configHash: ctx.configDigest || undefined,
  });

  return {
    ok: true,
    pages: ctx.pages,
    writes: ctx.writes,
    events: ctx.events,
    candles: ctx.candles,
    stakes: ctx.stakes,
    claims: ctx.claims,
    healthy: true,
    nextPollMs: interval,
  };
}

/** 单次 cron tick：租约 → 配置 → 引导 → 分页拉取 → 解码 → 写库 → getter 锚定 → 健康判定。永不抛出。 */
export async function tick(env: Env, now = Date.now()): Promise<IndexerTickResult> {
  if ((env.DATA_SOURCE ?? '').trim() !== 'chain') {
    return { ok: true, skipped: 'not_chain', pages: 0, writes: 0 };
  }
  const resolved = resolveChainConfig(env);
  if (!resolved.ok) {
    const noKey = resolved.error.includes('TONCENTER_API_KEY');
    await markFailure(env, { now, error: resolved.error, retryAfterMs: 5 * 60_000, configMismatch: !noKey });
    return { ok: false, skipped: noKey ? 'no_api_key' : 'config_mismatch', pages: 0, writes: 0, error: resolved.error, healthy: false };
  }
  const config = resolved.config;
  const leaseMs = config.leaseSeconds * 1000;
  const acquired = await store.tryAcquireLease(env, LEASE_KEY, now, leaseMs);
  if (!acquired) {
    return { ok: true, skipped: 'lease', pages: 0, writes: 0 };
  }
  try {
    return await runTick(env, now, config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const kind = (error as { kind?: string }).kind;
    const configMismatch = kind === 'config' || message.startsWith('ORACLE_CONFIG_MISMATCH');
    let retryAfterMs = 30_000;
    if (configMismatch) retryAfterMs = 10 * 60_000;
    else if (message.includes('限流') || message.includes('rate')) retryAfterMs = 60_000;
    else if (message.includes('网络')) retryAfterMs = 20_000;
    await store.logEvent(env, configMismatch ? 'error' : 'warn', 'indexer', 'INDEXER_TICK_ERROR', message.slice(0, 400));
    await markFailure(env, { now, error: message, retryAfterMs, configMismatch });
    return { ok: false, pages: 0, writes: 0, error: message, healthy: false, nextPollMs: retryAfterMs };
  } finally {
    await store.releaseLease(env, LEASE_KEY, Date.now());
  }
}

export interface ReconcileDiff {
  roundId: number | null;
  field: string;
  chain: string;
  d1: string;
}

/**
 * 全量对账（仅 admin/CLI 触发）：以 get-method 为锚点，与 D1 逐字段比较。
 * 返回空数组 = 一致；任何一项不一致都会被列出（不静默跳过）。
 */
export async function reconcile(env: Env, now = Date.now()): Promise<{ ok: boolean; diffs: string[] }> {
  const resolved = resolveChainConfig(env);
  if (!resolved.ok) return { ok: false, diffs: ['配置不可用：' + resolved.error] };
  const config = resolved.config;
  const client = createChainClient(config);
  const fields = await getProtocolConfig(client, config.addresses.roundController.raw);
  const digest = await digestProtocolConfig(config.network, fields);
  const diffs: string[] = [];
  const add = (roundId: number | null, field: string, chain: string, d1: string): void => {
    diffs.push((roundId === null ? '' : 'R' + roundId + ' ') + field + ': chain=' + chain + ' d1=' + d1);
  };

  if (config.expectedConfigVersion !== null && Number.parseInt(fields.configVersion, 10) !== config.expectedConfigVersion) {
    add(null, 'configVersion', fields.configVersion, String(config.expectedConfigVersion));
  }
  if (config.expectedConfigHash !== null && digest.toLowerCase() !== config.expectedConfigHash.toLowerCase()) {
    add(null, 'configHash', digest, config.expectedConfigHash);
  }

  const rounds = await store.listRounds(env);
  const candlesByRound = groupCandles(await store.listCandlesAll(env));
  const stakes = await store.listAllStakes(env);
  const stakeTotals = new Map<number, bigint>();
  for (const stake of stakes) stakeTotals.set(stake.round_id, (stakeTotals.get(stake.round_id) ?? 0n) + BigInt(stake.amount_raw));

  const jetton = await getJettonData(client, config.addresses.jettonMaster.raw);
  const supplyRow = (await store.getKeyValues(env)).get('total_supply_raw');
  // total_supply_raw 存的是「初始供应量」（views 会再减 burned），所以期望值 = 链上当前 supply + 已确认销毁量
  const burnRows = await store.listBurns(env);
  let confirmedBurned = 0n;
  for (const row of burnRows) if (row.confirmed === 1) confirmedBurned += BigInt(row.amount_raw);
  const expectedInitial = jetton.totalSupplyRaw + confirmedBurned;
  if (supplyRow && BigInt(supplyRow) !== expectedInitial) {
    add(null, 'totalSupply', expectedInitial.toString(), supplyRow);
  }

  for (const round of rounds) {
    if (round.state === 'UNOPENED') continue;
    const view = await getRound(client, config.addresses.roundController.raw, round.round_id);
    const mapped = chainStatusToRoundState(view.status);
    if (mapped && mapped !== round.state) add(round.round_id, 'state', String(view.status) + '(' + mapped + ')', round.state);
    if (view.targetTier !== round.target_tier) add(round.round_id, 'targetTier', String(view.targetTier), String(round.target_tier));
    if (view.targetPriceUsdE8.toString() !== round.target_price_usd_e8) {
      add(round.round_id, 'targetPrice', view.targetPriceUsdE8.toString(), round.target_price_usd_e8);
    }
    if (view.candlesSeen !== round.candles_seen) add(round.round_id, 'candlesSeen', String(view.candlesSeen), String(round.candles_seen));
    const threshold = Number.parseInt(fields.minQualifiedCandles, 10);
    const expectedQualified = Math.min(view.qualifiedCandles, threshold);
    const actualQualified = Math.min(round.qualified_candles, threshold);
    if (expectedQualified !== actualQualified) {
      add(round.round_id, 'qualifiedCandles(min16)', String(expectedQualified), String(actualQualified) + '（D1 真实值 ' + String(round.qualified_candles) + '）');
    }
    const candles = candlesByRound.get(round.round_id) ?? [];
    if (candles.length !== round.candles_seen && candles.length > 0) {
      add(round.round_id, 'candlesRows', String(view.candlesSeen), String(candles.length));
    }
    // 进行中轮次（2..7）还在产 K 线：getter 与 D1 不是同一瞬间的快照，只对终态轮次做不可变哈希比对
    const inFlight = view.status >= 2 && view.status <= 7;
    if (!inFlight && candles.length > 0 && view.candleHash !== '0x' + '0'.repeat(64)) {
      const { verifyCandleHash } = await import('./snapshot');
      const okHash = await verifyCandleHash(candles, view.candleHash);
      if (!okHash) add(round.round_id, 'candleHash', view.candleHash, '本地复算不一致');
    }
    const stakeTotal = stakeTotals.get(round.round_id) ?? 0n;
    if (stakeTotal !== view.totalAcceptedStakeRaw && (candles.length > 0 || stakeTotal > 0n)) {
      add(round.round_id, 'totalStake', view.totalAcceptedStakeRaw.toString(), stakeTotal.toString());
    }
    if (view.status === 9) {
      if (round.burned_raw !== null) {
        const total = confirmedBurnedTotal(view, fields);
        if (total === null) add(round.round_id, 'burnedRaw', '三笔未全部确认', round.burned_raw);
        else if (total.toString() !== round.burned_raw) add(round.round_id, 'burnedRaw', total.toString(), round.burned_raw);
      }
    }
  }

  // TeamVault 绑定关系
  try {
    const tv = await getTeamVaultState(client, config.addresses.teamVault.raw);
    if (tv.controller && tv.controller.raw !== config.addresses.roundController.raw) {
      add(null, 'teamVault.controller', tv.controller.raw, config.addresses.roundController.raw);
    }
  } catch (error) {
    diffs.push('TeamVault getter 失败：' + String(error).slice(0, 120));
  }

  return { ok: diffs.length === 0, diffs };
}
