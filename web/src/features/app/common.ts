import type { ApiError } from '../../lib/api';
import { pad2, rawToNumber } from '../../lib/format';
import type { RoundState, RoundSummary } from '@shared/types';

export type Lang = 'zh' | 'en';

/* ------------------------------------------------------------------ */
/* 轮次状态                                                            */
/* ------------------------------------------------------------------ */

export const STATE_LABEL: Record<RoundState, { zh: string; en: string }> = {
  UNOPENED: { zh: '未开启', en: 'Unopened' },
  STAKING_OPEN: { zh: '质押开放', en: 'Staking open' },
  STAKING_CLOSED: { zh: '质押关闭', en: 'Staking closed' },
  OBSERVING: { zh: '观察中', en: 'Observing' },
  ORACLE_PAUSED: { zh: '预言机暂停', en: 'Oracle paused' },
  SETTLING_SUCCESS: { zh: '结算中·成功', en: 'Settling success' },
  SETTLING_FAILURE: { zh: '结算中·失败', en: 'Settling failure' },
  SUCCEEDED: { zh: '已成功', en: 'Succeeded' },
  FAILED_PERMANENT: { zh: '永久失败', en: 'Failed permanently' },
  TECHNICAL_ABORTED: { zh: '技术终止', en: 'Technical abort' },
};

/** 选择器里的短标签。 */
export const STATE_SHORT: Record<RoundState, { zh: string; en: string }> = {
  UNOPENED: { zh: '未开', en: '—' },
  STAKING_OPEN: { zh: '质押', en: 'OPEN' },
  STAKING_CLOSED: { zh: '关闭', en: 'CLOSED' },
  OBSERVING: { zh: '观察', en: 'OBS' },
  ORACLE_PAUSED: { zh: '暂停', en: 'PAUSE' },
  SETTLING_SUCCESS: { zh: '结算', en: 'SETTLE' },
  SETTLING_FAILURE: { zh: '结算', en: 'SETTLE' },
  SUCCEEDED: { zh: '成功', en: 'OK' },
  FAILED_PERMANENT: { zh: '失败', en: 'FAIL' },
  TECHNICAL_ABORTED: { zh: '终止', en: 'ABORT' },
};

export function stateShort(state: RoundState | null | undefined, lang: Lang): string {
  if (!state) return '—';
  const entry = STATE_SHORT[state];
  return entry ? entry[lang] : state;
}

/** 选择器按钮的语义色（成功/失败/进行中/未开启）。 */
export function stateTone(state: RoundState | null | undefined): 'S' | 'F' | 'O' | 'U' {
  if (!state) return 'U';
  if (state === 'SUCCEEDED' || state === 'SETTLING_SUCCESS') return 'S';
  if (state === 'FAILED_PERMANENT' || state === 'SETTLING_FAILURE') return 'F';
  if (state === 'UNOPENED' || state === 'TECHNICAL_ABORTED') return 'U';
  return 'O';
}

export function stateLabel(state: RoundState | null | undefined, lang: Lang): string {
  if (!state) return '—';
  const entry = STATE_LABEL[state];
  return entry ? entry[lang] : state;
}

/** 复用 fuse.css 的 .pill 变体。 */
export function statePillClass(state: RoundState | null | undefined): string {
  switch (state) {
    case 'STAKING_OPEN':
      return 'pill stk';
    case 'OBSERVING':
      return 'pill obs';
    case 'ORACLE_PAUSED':
      return 'pill obs';
    case 'SUCCEEDED':
    case 'SETTLING_SUCCESS':
      return 'pill win';
    case 'FAILED_PERMANENT':
    case 'SETTLING_FAILURE':
      return 'pill lose';
    case 'TECHNICAL_ABORTED':
      return 'pill';
    default:
      return 'pill';
  }
}

/** 终态（不会再变化）。 */
export const TERMINAL_STATES: RoundState[] = ['SUCCEEDED', 'FAILED_PERMANENT', 'TECHNICAL_ABORTED'];

/** 进行中的状态（用于定位「当前轮」）。 */
export const ACTIVE_STATES: RoundState[] = [
  'STAKING_OPEN',
  'STAKING_CLOSED',
  'OBSERVING',
  'ORACLE_PAUSED',
  'SETTLING_SUCCESS',
  'SETTLING_FAILURE',
];

/** 当前轮：优先进行中的轮次，否则第一个未开启轮次，否则最后一轮。 */
export function pickCurrentRound(rounds: RoundSummary[]): RoundSummary | null {
  if (!rounds.length) return null;
  const ordered = [...rounds].sort((a, b) => a.roundId - b.roundId);
  const active = ordered.find((round) => ACTIVE_STATES.includes(round.state));
  if (active) return active;
  const unopened = ordered.find((round) => round.state === 'UNOPENED');
  if (unopened) return unopened;
  return ordered[ordered.length - 1] ?? null;
}

export function resultLabel(result: RoundSummary['result'], lang: Lang): string {
  if (!result) return '—';
  if (result === 'SUCCESS') return lang === 'zh' ? '成功' : 'Success';
  if (result === 'FAILURE') return lang === 'zh' ? '失败' : 'Failure';
  return lang === 'zh' ? '技术终止' : 'Technical abort';
}

/* ------------------------------------------------------------------ */
/* 数字/单位                                                            */
/* ------------------------------------------------------------------ */

/** 基点 → 百分比字符串（shareBps 0..10000）。 */
export function formatBps(bps: number, digits = 2): string {
  const value = Number.isFinite(bps) ? bps / 100 : 0;
  return `${value.toFixed(digits)}%`;
}

/** 价格紧凑格式：$0.004 / $0.032 / $3 / $1,250（最多 4 位有效数字）。 */
export function formatPrice(e8: string | number | null | undefined): string {
  if (e8 === null || e8 === undefined || e8 === '') return '—';
  const value = Number(e8) / 1e8;
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '$0';
  const abs = Math.abs(value);
  if (abs >= 1000) return '$' + value.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (abs >= 1) return '$' + Number(value.toFixed(2)).toString();
  return '$' + Number(value.toPrecision(4)).toString();
}

/** 占比：amount / total，保留两位小数（BigInt 计算，避免浮点误差）。 */
export function sharePct(amountRaw: string, totalRaw: string): string {
  try {
    const total = BigInt(totalRaw || '0');
    if (total <= 0n) return '0.00%';
    const amount = BigInt(amountRaw || '0');
    const bps = (amount * 10000n) / total; // 万分位
    return `${(Number(bps) / 100).toFixed(2)}%`;
  } catch {
    return '0.00%';
  }
}

/** 秒 → 带小时提示（14400 → "14,400 s · 4h"）。 */
export function secondsHint(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const text = s.toLocaleString('en-US');
  if (s > 0 && s % 86400 === 0 && s / 3600 > 48) return `${text} s · ${s / 86400}d`;
  if (s > 0 && s % 3600 === 0) return `${text} s · ${s / 3600}h`;
  if (s > 0 && s % 60 === 0) return `${text} s · ${s / 60}m`;
  return `${text} s`;
}

/** 奖励池 / 总质押 = 奖励倍数（1.00× 表示奖励等于本金）。 */
export function rewardMultiple(rewardRaw: string, stakeRaw: string, decimals: number): string {
  const stake = rawToNumber(stakeRaw, decimals);
  const reward = rawToNumber(rewardRaw, decimals);
  if (!Number.isFinite(stake) || stake <= 0 || !Number.isFinite(reward)) return '—';
  const ratio = reward / stake;
  if (ratio >= 1000) return `${(ratio / 1000).toFixed(1)}k×`;
  return `${ratio.toFixed(2)}×`;
}

/** 倒计时/时长（中英双语，天以下与语言无关的 HH:MM:SS）。 */
export function durationText(seconds: number | null | undefined, lang: Lang): string {
  if (seconds === null || seconds === undefined) return '—';
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const clock = `${pad2(hours)}:${pad2(minutes)}:${pad2(secs)}`;
  if (days > 0) return lang === 'zh' ? `${days}天 ${clock}` : `${days}d ${clock}`;
  return clock;
}

/* ------------------------------------------------------------------ */
/* 文案                                                                 */
/* ------------------------------------------------------------------ */

export interface CommonDict {
  loading: string;
  retry: string;
  refresh: string;
  noData: string;
  round: string;
  status: string;
  address: string;
  targetPrice: string;
  currentPrice: string;
  staked: string;
  totalStaked: string;
  stakers: string;
  rewardPool: string;
  rewardMultiple: string;
  share: string;
  estReward: string;
  rank: string;
  acceptedAt: string;
  burned: string;
  candles: string;
  qualified: string;
  result: string;
  updatedAt: string;
  wallet: string;
  connectWallet: string;
  demoWallet: string;
  myAddress: string;
  principal: string;
  reward: string;
  claim: string;
  connecting: string;
  claimed: string;
  claimable: string;
  locked: string;
  destroyed: string;
  refundable: string;
  cumulative: string;
  notConnected: string;
  apiDownTitle: string;
  apiDownHint: string;
  backHome: string;
  fuseUnit: string;
  noWalletHint: string;
}

export const COMMON: Record<Lang, CommonDict> = {
  zh: {
    loading: '加载中…',
    retry: '重试',
    refresh: '刷新',
    noData: '暂无数据',
    round: '轮次',
    status: '状态',
    address: '地址',
    targetPrice: '目标价',
    currentPrice: '现价',
    staked: '质押量',
    totalStaked: '总质押',
    stakers: '地址数',
    rewardPool: '奖励池',
    rewardMultiple: '奖励倍数',
    share: '占比',
    estReward: '预计奖励',
    rank: '排名',
    acceptedAt: '质押时间',
    burned: '已销毁',
    candles: '观察 K 线',
    qualified: '达标',
    result: '结果',
    updatedAt: '更新时间',
    wallet: '钱包',
    connectWallet: '连接钱包',
    demoWallet: '演示钱包',
    myAddress: '我的地址',
    principal: '本金',
    reward: '奖励',
    claim: '领取',
    connecting: '连接中…',
    claimed: '已领取',
    claimable: '可领取',
    locked: '锁定中',
    destroyed: '已销毁',
    refundable: '可退还',
    cumulative: '累计',
    notConnected: '未连接钱包',
    apiDownTitle: '接口不可用',
    apiDownHint: '无法连接 FUSE API。请确认本地 worker 已启动（npm run dev:worker，127.0.0.1:8787），或稍后重试。',
    backHome: '返回首页',
    fuseUnit: 'FUSE',
    noWalletHint: '连接钱包后即可查看你的质押、可领取与历史记录。',
  },
  en: {
    loading: 'Loading…',
    retry: 'Retry',
    refresh: 'Refresh',
    noData: 'No data',
    round: 'Round',
    status: 'Status',
    address: 'Address',
    targetPrice: 'Target price',
    currentPrice: 'Price',
    staked: 'Staked',
    totalStaked: 'Total staked',
    stakers: 'Stakers',
    rewardPool: 'Reward pool',
    rewardMultiple: 'Reward multiple',
    share: 'Share',
    estReward: 'Est. reward',
    rank: 'Rank',
    acceptedAt: 'Staked at',
    burned: 'Burned',
    candles: 'Candles',
    qualified: 'Qualified',
    result: 'Result',
    updatedAt: 'Updated',
    wallet: 'Wallet',
    connectWallet: 'Connect wallet',
    demoWallet: 'Demo wallet',
    myAddress: 'My address',
    principal: 'Principal',
    reward: 'Reward',
    claim: 'Claim',
    connecting: 'Connecting…',
    claimed: 'Claimed',
    claimable: 'Claimable',
    locked: 'Locked',
    destroyed: 'Burned',
    refundable: 'Refundable',
    cumulative: 'Cumulative',
    notConnected: 'Wallet not connected',
    apiDownTitle: 'API unavailable',
    apiDownHint: 'Cannot reach the FUSE API. Make sure the local worker is running (npm run dev:worker, 127.0.0.1:8787), then retry.',
    backHome: 'Back to home',
    fuseUnit: 'FUSE',
    noWalletHint: 'Connect a wallet to view your stakes, claimables and history.',
  },
};

/** 把 API 错误翻译成双语可读文案（保留原始 message 作为补充）。 */
export function apiErrorText(error: ApiError | null | undefined, lang: Lang): string {
  const zh = lang === 'zh';
  if (!error) return zh ? '未知错误' : 'Unknown error';
  switch (error.code) {
    case 'NETWORK':
    case 'BAD_RESPONSE':
      return zh ? '无法连接接口（worker 未启动或网络异常）' : 'Cannot reach the API (worker offline or network error)';
    case 'UNAUTHORIZED':
      return zh ? '未授权：令牌缺失或无效' : 'Unauthorized: missing or invalid token';
    case 'NOT_FOUND':
      return zh ? '资源不存在' : 'Not found';
    case 'CONFLICT':
      return zh ? '状态冲突：该操作当前不允许' : 'Conflict: operation not allowed in the current state';
    case 'RATE_LIMITED':
      return zh ? '请求过于频繁，请稍后再试' : 'Rate limited, please retry later';
    case 'NOT_IMPLEMENTED':
      return zh ? '后端接口尚未实现' : 'Endpoint not implemented yet';
    case 'INTERNAL':
      return zh ? '服务端内部错误' : 'Internal server error';
    default:
      return error.message;
  }
}
