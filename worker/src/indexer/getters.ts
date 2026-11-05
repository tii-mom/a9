/**
 * RoundController / TeamVault / JettonMaster 的 get-method 封装与栈解码。
 * 槽位顺序严格对齐 contracts/contracts/types.tolk（RoundView 22 槽 / ProtocolConfigView 22 槽 / TeamVaultState 8 槽），
 * 任何槽位顺序变化都必须先改合约再改这里（进度核对脚本会以 candleHash/failureBurnId 复算兜底）。
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
  teamReleaseConfirmed: boolean;
  teamBurnConfirmed: boolean;
  rewardBurnConfirmed: boolean;
  principalBurnConfirmed: boolean;
  failureBurnId: string;
  candleHash: string;
  totalWeight: bigint;
}

export interface ChainStakePosition {
  amountRaw: bigint;
  lastDepositNonce: bigint;
  principalClaimed: boolean;
  rewardClaimed: boolean;
  weight: bigint;
  rewardState: number;
}

export interface ChainTeamVaultState {
  controller: TonAddress | null;
  jettonWallet: TonAddress | null;
  teamWallet: TonAddress | null;
  teamRoundRaw: bigint;
  totalReleasedRaw: bigint;
  totalBurnedRaw: bigint;
  releasedCount: number;
  burnedCount: number;
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

/** get_round_burn_status(roundId)：3 个确认标志 + failureBurnId。 */
export async function getRoundBurnStatus(
  client: ChainClient,
  roundController: string,
  roundId: number,
): Promise<{ rewardBurnConfirmed: boolean; teamBurnConfirmed: boolean; principalBurnConfirmed: boolean; failureBurnId: string }> {
  const { stack } = await client.runGetMethod(roundController, 'get_round_burn_status', [numArg(roundId)]);
  if (stack.length < 4) throw new Error('get_round_burn_status 槽位不足：' + stack.length);
  return {
    rewardBurnConfirmed: stackBool(stack[0]),
    teamBurnConfirmed: stackBool(stack[1]),
    principalBurnConfirmed: stackBool(stack[2]),
    failureBurnId: hex256(stackNum(stack[3])),
  };
}

export async function getRoundTotalStake(client: ChainClient, roundController: string, roundId: number): Promise<bigint> {
  const { stack } = await client.runGetMethod(roundController, 'get_round_total_stake', [numArg(roundId)]);
  return stackNum(stack[0]);
}

export async function getTotalWeight(client: ChainClient, roundController: string, roundId: number): Promise<bigint> {
  const { stack } = await client.runGetMethod(roundController, 'get_total_weight', [numArg(roundId)]);
  return stackNum(stack[0]);
}

export async function getUserWeight(
  client: ChainClient,
  roundController: string,
  roundId: number,
  owner: TonAddress,
): Promise<bigint> {
  const { stack } = await client.runGetMethod(roundController, 'get_user_weight', [numArg(roundId), addressArg(owner)]);
  return stackNum(stack[0]);
}

/** get_user_stake(roundId, owner)：6 槽（amount, nonce, principalClaimed, rewardClaimed, weight, rewardState）。 */
export async function getUserStake(
  client: ChainClient,
  roundController: string,
  roundId: number,
  owner: TonAddress,
): Promise<ChainStakePosition> {
  const { stack } = await client.runGetMethod(roundController, 'get_user_stake', [numArg(roundId), addressArg(owner)]);
  if (stack.length < 6) throw new Error('get_user_stake 槽位不足：' + stack.length);
  return {
    amountRaw: stackNum(stack[0]),
    lastDepositNonce: stackNum(stack[1]),
    principalClaimed: stackBool(stack[2]),
    rewardClaimed: stackBool(stack[3]),
    weight: stackNum(stack[4]),
    rewardState: stackInt(stack[5], 'rewardState'),
  };
}

export async function getUserRewardEstimate(
  client: ChainClient,
  roundController: string,
  roundId: number,
  owner: TonAddress,
): Promise<bigint> {
  const { stack } = await client.runGetMethod(roundController, 'get_user_reward_estimate', [numArg(roundId), addressArg(owner)]);
  return stackNum(stack[0]);
}

/** get_claimable_all(owner)：principalRaw, rewardRaw, roundsMask。 */
export async function getClaimableAll(
  client: ChainClient,
  roundController: string,
  owner: TonAddress,
): Promise<{ principalRaw: bigint; rewardRaw: bigint; roundsMask: number }> {
  const { stack } = await client.runGetMethod(roundController, 'get_claimable_all', [addressArg(owner)]);
  if (stack.length < 3) throw new Error('get_claimable_all 槽位不足：' + stack.length);
  return { principalRaw: stackNum(stack[0]), rewardRaw: stackNum(stack[1]), roundsMask: stackInt(stack[2], 'roundsMask') };
}

/** get_unlock_info(owner)：unlockStart、totalLockedRaw、claimedRaw、claimableRaw。 */
export async function getUnlockInfo(
  client: ChainClient,
  roundController: string,
  owner: TonAddress,
): Promise<{ unlockStart: number; totalLockedRaw: bigint; claimedRaw: bigint; claimableRaw: bigint }> {
  const { stack } = await client.runGetMethod(roundController, 'get_unlock_info', [addressArg(owner)]);
  if (stack.length < 4) throw new Error('get_unlock_info 槽位不足：' + stack.length);
  return {
    unlockStart: stackInt(stack[0], 'unlockStart'),
    totalLockedRaw: stackNum(stack[1]),
    claimedRaw: stackNum(stack[2]),
    claimableRaw: stackNum(stack[3]),
  };
}

/** TeamVault get_team_vault_state()：3 地址 + 5 数字（8 槽）。 */
export async function getTeamVaultState(client: ChainClient, teamVault: string): Promise<ChainTeamVaultState> {
  const { stack } = await client.runGetMethod(teamVault, 'get_team_vault_state');
  if (stack.length < 8) throw new Error('get_team_vault_state 槽位不足：' + stack.length);
  return {
    controller: stackAddress(stack[0]),
    jettonWallet: stackAddress(stack[1]),
    teamWallet: stackAddress(stack[2]),
    teamRoundRaw: stackNum(stack[3]),
    totalReleasedRaw: stackNum(stack[4]),
    totalBurnedRaw: stackNum(stack[5]),
    releasedCount: stackInt(stack[6], 'releasedCount'),
    burnedCount: stackInt(stack[7], 'burnedCount'),
  };
}

/** TeamVault get_round_state(roundId)：released, burned, amountRaw, queryId。 */
export async function getTeamRoundState(
  client: ChainClient,
  teamVault: string,
  roundId: number,
): Promise<{ released: boolean; burned: boolean; amountRaw: bigint; queryId: bigint }> {
  const { stack } = await client.runGetMethod(teamVault, 'get_round_state', [numArg(roundId)]);
  if (stack.length < 4) throw new Error('get_round_state 槽位不足：' + stack.length);
  return { released: stackBool(stack[0]), burned: stackBool(stack[1]), amountRaw: stackNum(stack[2]), queryId: stackNum(stack[3]) };
}

/** JettonMaster get_jetton_data()：total_supply, mintable, admin, content, wallet_code。 */
export async function getJettonData(client: ChainClient, jettonMaster: string): Promise<ChainJettonData> {
  const { stack } = await client.runGetMethod(jettonMaster, 'get_jetton_data');
  if (stack.length < 2) throw new Error('get_jetton_data 槽位不足：' + stack.length);
  return { totalSupplyRaw: stackNum(stack[0]), mintable: stackBool(stack[1]), admin: stackAddress(stack[2]) };
}
