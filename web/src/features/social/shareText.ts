/** 分享文案与链接拼装（纯函数，便于单测）。文案里的数字取自实时数据。 */
import { usdWhole } from './format';
import type { ShareMoment } from './types';

/** 话题标签，所有分享文案统一带上。 */
export const SHARE_TAG = '#A9破城';

export interface ShareContext {
  roundId?: number | null;
  /** 还差多少 USD 破城 */
  remainingUsd?: number | null;
  /** 上车次数 */
  stakeCount?: number | null;
  /** 奖池，亿 A9 已格式化（如 "7.00"） */
  poolYi?: string | null;
  squadName?: string | null;
  /** 阵亡勋章数 */
  medals?: number | null;
}

function roundLabel(roundId: number | null | undefined): string {
  return roundId ? `第 ${roundId} 城` : '本城';
}

/** 按时刻生成分享文案（不含链接）。 */
export function buildShareText(moment: ShareMoment, ctx: ShareContext = {}): string {
  const round = roundLabel(ctx.roundId);
  switch (moment) {
    case 'join': {
      const gap = ctx.remainingUsd !== null && ctx.remainingUsd !== undefined ? `城门还差 ${usdWhole(ctx.remainingUsd)} 破城` : '一起把价格推过城门';
      const count = ctx.stakeCount !== null && ctx.stakeCount !== undefined ? `，已有 ${ctx.stakeCount} 次上车` : '';
      return `我刚用 1 GRAM 上车攻城！${gap}${count}。散户做庄，来一起干 ${SHARE_TAG}`;
    }
    case 'squad': {
      const name = ctx.squadName ? `「${ctx.squadName}」` : '我的战队';
      return `${name}成团了！${round}一起攻城，全队军饷加成已生效。${SHARE_TAG}`;
    }
    case 'breach': {
      const pool = ctx.poolYi ? `奖池 ${ctx.poolYi} 亿 A9 分给攻城的人` : '奖池已分给攻城的人';
      return `${round}破城了！${pool}。散户做庄，这次我们赢了 ${SHARE_TAG}`;
    }
    case 'fallen': {
      const medal = ctx.medals !== null && ctx.medals !== undefined ? `，阵亡勋章 ×${ctx.medals}` : '';
      return `${round}没破，我的本金阵亡了${medal}。下一城见 ${SHARE_TAG}`;
    }
  }
}

/** 战队招募文案：「XX 战队第 N 城招募，差 M 人升级」；已满级（remaining 为 null）时改写。 */
export function buildSquadRecruitText(input: { squadName: string; roundId: number | null; remaining: number | null }): string {
  const round = roundLabel(input.roundId);
  if (input.remaining === null) {
    return `${input.squadName} 战队${round}招募，已满级，全队军饷 +15%。${SHARE_TAG}`;
  }
  return `${input.squadName} 战队${round}招募，差 ${input.remaining} 人升级。${SHARE_TAG}`;
}

/** 分享落地页链接：origin/s/<code>，X 来源带 ?src=x。 */
export function buildShareUrl(origin: string, code: string, src?: 'x'): string {
  const base = `${origin}/s/${encodeURIComponent(code)}`;
  return src ? `${base}?src=${src}` : base;
}

/** X Web Intent（无需 X API）。 */
export function buildXIntentUrl(text: string, url: string): string {
  return `https://x.com/intent/post?${new URLSearchParams({ text, url }).toString()}`;
}

/** Telegram 分享页（非小程序内时使用）。 */
export function buildTelegramShareUrl(url: string, text: string): string {
  return `https://t.me/share/url?${new URLSearchParams({ url, text }).toString()}`;
}
