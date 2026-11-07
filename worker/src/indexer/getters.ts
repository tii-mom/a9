/**
 * RoundController / StakeTicket / JettonMaster 的 get-method 封装与栈解码（v11：Claim 相关 getter 已移除，改读攻城令）。
 * 槽位顺序严格对齐 contracts/contracts/types.tolk（RoundView 22 槽 / ProtocolConfigView 22 槽，形状沿用 v8.9），
 * 任何槽位顺序变化都必须先改合约再改这里（进度核对脚本会以 candleHash 复算兜底）。
 */
import { BitReader, BitWriter, buildSingleCellBoc, cellFromRawData, rootCellFromBase64 } from './boc';
import type { ChainClient, StackArg } from './chain-client';
import { PROTOCOL_CONFIG_KEYS, protocolConfigDigest, type ChainNetwork, type ProtocolConfigFields } from './config';
import type { TonAddress } from './address';

/** runGetMethod 栈元素：兼容 v2 的 [type, payload] 与 v3 的 {type,value} 两种形态。 */
function stackType(item: unknown): string {
  if (Array.isArray(item)) return String(item[0] ?? '');
  if (item && typeof item === 'object' && 'type' in item) return String((item as { type: unknown }).type);
  return '';
}

function stackPayload(item: unknown): unknown {
  if (Array.isArray(item)) return item[1];
  if (item && typeof item === 'object' && 'value' in item) return (item as { value: unknown }).value;
  return undefined;
}

/** 数字槽 → bigint（支持 0x… / 十进制 / 负数）。 */
export function stackNum(item: unknown): bigint {
  if (stackType(item) === 'null') return 0n;
  const payload = stackPayload(item);
  if (typeof payload === 'bigint') return payload;
  if (typeof payload === 'number') return BigInt(payload);
  if (typeof payload === 'string') {
    const text = payload.trim();
    if (!text) return 0n;
    if (text.startsWith('-0x')) return -BigInt('0x' + text.slice(3));
    if (text.startsWith('0x') || text.startsWith('0X')) return BigInt(text);
    if (/^-?\d+$/.test(text)) return BigInt(text);
  }
  if (payload && typeof payload === 'object') {
    const value = (payload as Record<string, unknown>).value;
    if (typeof value === 'string' && value.trim()) return BigInt(value.startsWith('0x') ? value : '0x' + value);
  }
  throw new Error('无法解析数字栈槽：' + JSON.stringify(item).slice(0, 120));
}

/** 数字槽 → number（仅用于 uint8/uint16/uint32 等短字段，超出安全整数会抛错）。 */
function stackInt(item: unknown, label: string): number {
  const value = stackNum(item);
  if (value > 9_007_199_254_740_991n || value < -9_007_199_254_740_991n) {
    throw new Error(label + ' 超出 JS 安全整数范围');
  }
  return Number(value);
}

function stackBool(item: unknown): boolean {
  return stackNum(item) !== 0n;
}

/** cell/slice 槽 → 内嵌字节的 base64（toncenter 两种字段形态都可能出现）。 */
export function stackCellBase64(item: unknown): string | null {
  const payload = stackPayload(item);
  if (!payload) return null;
  if (typeof payload === 'string') return payload;
  if (typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (typeof record.bytes === 'string') return record.bytes;
    const object = record.object;
    if (object && typeof object === 'object') {
      const data = (object as Record<string, unknown>).data;
      if (data && typeof data === 'object' && typeof (data as Record<string, unknown>).b64 === 'string') {
        return (data as Record<string, unknown>).b64 as string;
      }
    }
    if (typeof record.value === 'string') return record.value;
  }
  return null;
}

/** 地址槽 → { workchain, hashHex, raw }；null/空 slice 返回 null。 */
export function stackAddress(item: unknown): TonAddress | null {
  if (!item || stackType(item) === 'null') return null;
  // 优先用 object.data（含精确 bitLen）；否则退回 BOC 解析
  const payload = stackPayload(item);
  const object = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).object : undefined;
  const objectData = object && typeof object === 'object' ? (object as Record<string, unknown>).data : undefined;
  let cell;
  if (objectData && typeof objectData === 'object') {
    const raw = objectData as Record<string, unknown>;
    if (typeof raw.b64 === 'string' && typeof raw.len === 'number') {
      cell = cellFromRawData(raw.b64, raw.len);
    }
  }
  if (!cell) {
    const b64 = stackCellBase64(item);
    if (!b64) return null;
    cell = rootCellFromBase64(b64);
  }
  if (cell.bitLen < 267) return null;
  const parsed = new BitReader(cell).address();
  return { raw: parsed.raw, workchain: parsed.workchain, hashHex: parsed.hashHex, testnet: null, bounceable: null, input: parsed.raw };
}

/** 整数入参：['num', '0x…']。 */
export function numArg(value: number | bigint): StackArg {
  const big = typeof value === 'bigint' ? value : BigInt(value);
  return ['num', (big < 0n ? '-0x' + (-big).toString(16) : '0x' + big.toString(16)) as string] as const;
}

/** 地址入参：必须传正确的 267-bit slice BOC（不能只传 hex）。 */
export function addressArg(address: TonAddress | { workchain: number; hashHex: string }): StackArg {
  const writer = new BitWriter();
  writer.address({ workchain: address.workchain, hashHex: address.hashHex });
  return ['slice', buildSingleCellBoc(writer)] as const;
}

function hex256(value: bigint): string {
  return '0x' + value.toString(16).padStart(64, '0');
}

/** 链上原始秒级时间戳（不做毫秒换算；换算统一在 snapshot 层）。 */
export interface ChainRoundView {
  roundId: number;
  status: number;
  targetTier: number;
  targetPriceUsdE8: bigint;
  targetTwap24hUsdE8: bigint;
  targetWrittenAt: number;
  rewardBudgetRaw: bigint;
  stakeOpenAt: number;
  stakeCloseAt: number;
  observationStart: number;
  observationEnd: number;
  candlesSeen: number;
  qualifiedCandles: number;
  totalAcceptedStakeRaw: bigint;
  settledAt: number;
  /** 团队转账已发出且未被退回（成功轮；本轮释放上一次成功的团队额度） */
  teamReleaseConfirmed: boolean;
  /** 失败轮：唯一的 burn 已发出且未被退回（v11 同 rewardBurnConfirmed） */
  teamBurnConfirmed: boolean;
  /** 本轮 burn 已发出且未被退回（失败轮；成功轮仅第 10 城留存滚存时） */
  rewardBurnConfirmed: boolean;
  /** 同 rewardBurnConfirmed（一笔 burn 三个标志同真同假） */
  principalBurnConfirmed: boolean;
  /** 恒为 0（v11 不再有 failureBurnId） */
  failureBurnId: string;
  candleHash: string;
  /** v11 = 本轮总权重（sum of amount × timing bps / 10000） */
  totalWeight: bigint;
}

/** get_ticket_data()（攻城令 StakeTicket，v11）：8 槽。 */
export interface ChainTicketView {
  rc: string;
  owner: string;
  roundId: number;
  amountRaw: bigint;
  weightRaw: bigint;
  principalDone: boolean;
  lockedClaimedRaw: bigint;
  /** 请求已发往 RC 但尚未收到 TicketUpdate（或被 bounce 清除）之前为 true */
  pending: boolean;
}

/** get_reward_preview(roundId, weightRaw)：4 槽。 */
export interface ChainRewardPreview {
  rewardRaw: bigint;
  immediateRaw: bigint;
  lockedRaw: bigint;
  unlockedLockedRaw: bigint;
}

/** get_protocol_state()：7 槽（第 7 槽 fallbackUnlockSeconds 为压城兜底解锁窗口，秒）。 */
export interface ChainProtocolState {
  carryRaw: bigint;
  lastSuccessRound: number;
  teamPendingRaw: bigint;
  endAt: number;
  successCount: number;
  currentRoundId: number;
  fallbackUnlockSeconds: number;
}

export interface ChainJettonData {
  totalSupplyRaw: bigint;
  mintable: boolean;
  admin: TonAddress | null;
}

/** get_protocol_config()：22 槽（5 地址 + 17 数字）。 */
export async function getProtocolConfig(client: ChainClient, roundController: string): Promise<ProtocolConfigFields> {
  const { stack } = await client.runGetMethod(roundController, 'get_protocol_config');
  if (stack.length < 22) throw new Error('get_protocol_config 槽位数异常：' + stack.length + '（期望 22）');
  const fields = {} as ProtocolConfigFields;
  for (let i = 0; i < PROTOCOL_CONFIG_KEYS.length; i++) {
    const key = PROTOCOL_CONFIG_KEYS[i];
    if (i < 5) {
      const address = stackAddress(stack[i]);
      if (!address) throw new Error('get_protocol_config 地址槽 ' + key + ' 为 null');
      fields[key] = address.raw;
    } else {
      fields[key] = stackNum(stack[i]).toString();
    }
  }
  return fields;
}

/** 计算 ORACLE_CONFIG_HASH（规则见 config.ts 注释）。 */
export function digestProtocolConfig(network: ChainNetwork, fields: ProtocolConfigFields): Promise<string> {
  return protocolConfigDigest(network, fields);
}

/** get_round(roundId)：22 槽。未开轮时全部为 0。 */
export async function getRound(client: ChainClient, roundController: string, roundId: number): Promise<ChainRoundView> {
  const { stack } = await client.runGetMethod(roundController, 'get_round', [numArg(roundId)]);
  if (stack.length < 22) throw new Error('get_round(' + roundId + ') 槽位数异常：' + stack.length + '（期望 22）');
  return {
    roundId: stackInt(stack[0], 'roundId'),
    status: stackInt(stack[1], 'status'),
    targetTier: stackInt(stack[2], 'targetTier'),
    targetPriceUsdE8: stackNum(stack[3]),
    targetTwap24hUsdE8: stackNum(stack[4]),
    targetWrittenAt: stackInt(stack[5], 'targetWrittenAt'),
    rewardBudgetRaw: stackNum(stack[6]),
    stakeOpenAt: stackInt(stack[7], 'stakeOpenAt'),
    stakeCloseAt: stackInt(stack[8], 'stakeCloseAt'),
    observationStart: stackInt(stack[9], 'observationStart'),
    observationEnd: stackInt(stack[10], 'observationEnd'),
    candlesSeen: stackInt(stack[11], 'candlesSeen'),
    qualifiedCandles: stackInt(stack[12], 'qualifiedCandles'),
    totalAcceptedStakeRaw: stackNum(stack[13]),
    settledAt: stackInt(stack[14], 'settledAt'),
    teamReleaseConfirmed: stackBool(stack[15]),
    teamBurnConfirmed: stackBool(stack[16]),
    rewardBurnConfirmed: stackBool(stack[17]),
    principalBurnConfirmed: stackBool(stack[18]),
    failureBurnId: hex256(stackNum(stack[19])),
    candleHash: hex256(stackNum(stack[20])),
    totalWeight: stackNum(stack[21]),
  };
}

export async function getCurrentRound(client: ChainClient, roundController: string): Promise<number> {
  const { stack } = await client.runGetMethod(roundController, 'get_current_round');
  return stackInt(stack[0], 'currentRound');
}

export async function getSuccessCount(client: ChainClient, roundController: string): Promise<number> {
  const { stack } = await client.runGetMethod(roundController, 'get_success_count');
  return stackInt(stack[0], 'successCount');
}

export async function getRoundTotalStake(client: ChainClient, roundController: string, roundId: number): Promise<bigint> {
  const { stack } = await client.runGetMethod(roundController, 'get_round_total_stake', [numArg(roundId)]);
  return stackNum(stack[0]);
}

/** get_ticket_address(owner, roundId)：攻城令地址由 RC 按 (code, owner, roundId) 推导，任何人可算。 */
export async function getTicketAddress(client: ChainClient, roundController: string, owner: TonAddress, roundId: number): Promise<string> {
  const { stack } = await client.runGetMethod(roundController, 'get_ticket_address', [addressArg(owner), numArg(roundId)]);
  const address = stackAddress(stack[0]);
  if (!address) throw new Error('get_ticket_address 返回 null');
  return address.raw;
}

/** 攻城令 get_ticket_data()：8 槽（rc, owner, roundId, amountRaw, weightRaw, principalDone, lockedClaimedRaw, pending）。 */
export async function getTicketData(client: ChainClient, ticket: string): Promise<ChainTicketView> {
  const { stack } = await client.runGetMethod(ticket, 'get_ticket_data');
  if (stack.length < 8) throw new Error('get_ticket_data 槽位不足：' + stack.length + '（期望 8）');
  const rc = stackAddress(stack[0]);
  const owner = stackAddress(stack[1]);
  if (!rc || !owner) throw new Error('get_ticket_data 地址槽为 null');
  return {
    rc: rc.raw,
    owner: owner.raw,
    roundId: stackInt(stack[2], 'roundId'),
    amountRaw: stackNum(stack[3]),
    weightRaw: stackNum(stack[4]),
    principalDone: stackBool(stack[5]),
    lockedClaimedRaw: stackNum(stack[6]),
    pending: stackBool(stack[7]),
  };
}

/** get_reward_preview(roundId, weightRaw)：4 槽。 */
export async function getRewardPreview(
  client: ChainClient,
  roundController: string,
  roundId: number,
  weightRaw: bigint,
): Promise<ChainRewardPreview> {
  const { stack } = await client.runGetMethod(roundController, 'get_reward_preview', [numArg(roundId), numArg(weightRaw)]);
  if (stack.length < 4) throw new Error('get_reward_preview 槽位不足：' + stack.length);
  return {
    rewardRaw: stackNum(stack[0]),
    immediateRaw: stackNum(stack[1]),
    lockedRaw: stackNum(stack[2]),
    unlockedLockedRaw: stackNum(stack[3]),
  };
}

/** 旧部署 get_protocol_state 只有 6 槽时的兜底解锁窗口默认值（30 天）。与 me-position.ts DEFAULT_FALLBACK_UNLOCK_SECONDS 同值；此处不 import 以免索引器经 me-position 拖入 @shared 类型别名。 */
const LEGACY_FALLBACK_UNLOCK_SECONDS = 30 * 24 * 3600;

/**
 * get_protocol_state()：7 槽。旧部署只有 6 槽（无第 7 槽）时，兜底解锁窗口取默认 30 天（2592000 秒）。
 */
export async function getProtocolState(client: ChainClient, roundController: string): Promise<ChainProtocolState> {
  const { stack } = await client.runGetMethod(roundController, 'get_protocol_state');
  if (stack.length < 6) throw new Error('get_protocol_state 槽位不足：' + stack.length + '（期望 7，至少 6）');
  return {
    carryRaw: stackNum(stack[0]),
    lastSuccessRound: stackInt(stack[1], 'lastSuccessRound'),
    teamPendingRaw: stackNum(stack[2]),
    endAt: stackInt(stack[3], 'endAt'),
    successCount: stackInt(stack[4], 'successCount'),
    currentRoundId: stackInt(stack[5], 'currentRoundId'),
    fallbackUnlockSeconds: stack.length >= 7 ? stackInt(stack[6], 'fallbackUnlockSeconds') : LEGACY_FALLBACK_UNLOCK_SECONDS,
  };
}

/** get_round_staker_count(roundId)：uint32 = 入账笔数（攻城令不按地址去重）。 */
export async function getRoundStakerCount(client: ChainClient, roundController: string, roundId: number): Promise<number> {
  const { stack } = await client.runGetMethod(roundController, 'get_round_staker_count', [numArg(roundId)]);
  return stackInt(stack[0], 'stakerCount');
}

/** JettonMaster get_jetton_data()：total_supply, mintable, admin, content, wallet_code。 */
export async function getJettonData(client: ChainClient, jettonMaster: string): Promise<ChainJettonData> {
  const { stack } = await client.runGetMethod(jettonMaster, 'get_jetton_data');
  if (stack.length < 2) throw new Error('get_jetton_data 槽位不足：' + stack.length);
  return { totalSupplyRaw: stackNum(stack[0]), mintable: stackBool(stack[1]), admin: stackAddress(stack[2]) };
}

/** RoundController get_jetton_wallet_address()：RC 自己的 Jetton 钱包（链上推导）。 */
export async function getJettonWalletAddress(client: ChainClient, roundController: string): Promise<string> {
  const { stack } = await client.runGetMethod(roundController, 'get_jetton_wallet_address');
  const address = stackAddress(stack[0]);
  if (!address) throw new Error('get_jetton_wallet_address 返回 null');
  return address.raw;
}

/** TEP-74 JettonWallet get_wallet_data()：balance, owner, master, wallet_code → 只取余额。 */
export async function getWalletBalance(client: ChainClient, wallet: string): Promise<bigint> {
  const { stack } = await client.runGetMethod(wallet, 'get_wallet_data');
  if (stack.length < 1) throw new Error('get_wallet_data 槽位不足：' + stack.length);
  return stackNum(stack[0]);
}
