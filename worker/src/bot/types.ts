/**
 * 机器人模块的共享类型。
 * 刻意不 import env.ts / social/：只声明机器人真正用到的最小形状，由 index.ts 注入。
 */

/** 机器人需要的环境绑定（Env 结构兼容，TG_* 由 wrangler secret / vars 提供）。 */
export interface BotEnv {
  DB: D1Database;
  /** Bot API token（wrangler secret，永不写进仓库） */
  TG_BOT_TOKEN?: string;
  /** Webhook 校验：请求头 X-Telegram-Bot-Api-Secret-Token 必须等于它 */
  TG_WEBHOOK_SECRET?: string;
  /** 机器人用户名，不带 @ */
  TG_BOT_USERNAME?: string;
}

/**
 * 城门快照（由 social 层的 GET /api/social/gate 同形数据提供）。
 * phase: PREVIEW | STAKING_OPEN | OBSERVING | SUCCEEDED | FAILED_PERMANENT（其他值原样显示）。
 */
export interface GateStatus {
  roundId: number;
  phase: string;
  gatePriceUsd: number;
  priceUsd: number;
  remainingUsd: number;
  litCandles: number;
  candlesSeen: number;
  rewardBudgetRaw: string;
  stakeCount: number;
  /** 可选：当前阶段结束时刻（unix 秒）。给了才显示倒计时。 */
  phaseEndsAt?: number;
}

/** 注入式城门数据源：lead 在 index.ts 里接到 /api/social/gate 的数据。 */
export type GateSource = (env: BotEnv) => Promise<GateStatus | null>;

/** 单根 K 线的推送事件。 */
export interface CandleEvent {
  roundId: number;
  /** 第几根（1..total） */
  candleIndex: number;
  /** 本根是否亮灯 */
  lit: boolean;
  /** 破城所需盏数，固定 16 */
  needed: number;
  priceUsd: number;
  gatePriceUsd: number;
  /** 可选：截至本根（含）已亮盏数。没给时文案不显示「已亮 x/16」 */
  litCount?: number;
  /** 可选：总根数，默认 24 */
  total?: number;
  /** 可选：仅最后一根携带的结算结果；没给时按 litCount 推断 */
  outcome?: 'SUCCEEDED' | 'FAILED_PERMANENT';
}

/** 战队行（tg_chat_id 统一为字符串，发送 Telegram 时直接使用）。 */
export interface SquadRow {
  code: string;
  name: string;
  leaderWallet: string;
  tgChatId: string;
}

/** 带成员数的战队行（用于排名）。 */
export interface SquadWithMembers extends SquadRow {
  members: number;
}

/** Telegram Update 的最小子集。 */
export interface TgUser {
  id: number;
  is_bot?: boolean;
  username?: string;
  first_name?: string;
}

export interface TgChat {
  id: number;
  type: string;
  title?: string;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}
