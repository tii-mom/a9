/**
 * 机器人文案（纯函数，无 I/O）。用户词汇统一见 docs/35 §2：
 * 城门 / 攻城 / 守城 / 亮灯 / 破城 / 战队 / 军饷 / 攻城令。
 */
import type { CandleEvent, GateStatus } from './types';
import { levelInfo } from './squad';

export const LIT_NEEDED = 16;
export const CANDLES_TOTAL = 24;

const PHASE_LABEL: Record<string, string> = {
  PREVIEW: '集结',
  STAKING_OPEN: '攻城',
  OBSERVING: '守城',
  SUCCEEDED: '破城',
  FAILED_PERMANENT: '城没破（阵亡）',
};

export function phaseLabel(phase: string): string {
  return PHASE_LABEL[phase] ?? phase;
}

/** 美元金额：>=1 保留两位并加千分位；<1 保留到 6 位，去尾零但至少两位小数（小币种价格）。 */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '$--';
  if (Math.abs(value) >= 1) {
    const [int, frac] = value.toFixed(2).split('.');
    return '$' + int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + frac;
  }
  const [int, frac = ''] = value.toFixed(6).replace(/0+$/, '').split('.');
  return '$' + int + '.' + frac.padEnd(2, '0');
}

/** 百分比：整数直接显示（6%），否则保留一位（6.2%）。 */
export function formatPct(value: number): string {
  const rounded = Math.round(Math.abs(value) * 10) / 10;
  return (Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)) + '%';
}

/** 现价相对城门的偏离描述：高于 / 低于 / 持平。 */
export function gapText(priceUsd: number, gatePriceUsd: number): string {
  if (!(gatePriceUsd > 0)) return '城门未知';
  const pct = (priceUsd / gatePriceUsd - 1) * 100;
  if (Math.round(pct * 10) === 0) return '现价与城门持平';
  return pct > 0 ? `现价高于城门 ${formatPct(pct)}` : `现价低于城门 ${formatPct(pct)}`;
}

/** 倒计时：>=1 小时显示 “X小时Y分”，否则 “Y分Z秒”。负数视为已结束。 */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s >= 3600) return `${Math.floor(s / 3600)}小时${Math.floor((s % 3600) / 60)}分`;
  return `${Math.floor(s / 60)}分${s % 60}秒`;
}

/** 一行摘要：第 N 城 · 阶段 ｜ 城门 ｜ 现价（/start 状态行用）。 */
export function formatGateLine(g: GateStatus): string {
  return `第 ${g.roundId} 城 · ${phaseLabel(g.phase)} ｜ 城门 ${formatUsd(g.gatePriceUsd)} ｜ 现价 ${formatUsd(g.priceUsd)}`;
}

/** 城门状态（/gate 使用）。 */
export function formatGateStatus(g: GateStatus, nowSec: number = Math.floor(Date.now() / 1000)): string {
  const lines: string[] = [];
  lines.push(`第 ${g.roundId} 城 · ${phaseLabel(g.phase)}`);
  lines.push(`城门 ${formatUsd(g.gatePriceUsd)} ｜ 现价 ${formatUsd(g.priceUsd)}`);
  // 还差金额为 0（现价已过城门）时切到守城视图（docs/35 §2）
  if (g.remainingUsd > 0) {
    lines.push(`还差 ${formatUsd(g.remainingUsd)} 破城`);
  } else {
    lines.push('现价已过城门，守城中');
  }
  lines.push(`已亮 ${g.litCandles}/${LIT_NEEDED} 盏 · 已看 ${g.candlesSeen}/${CANDLES_TOTAL} 盏`);
  lines.push(`攻城令 ${g.stakeCount} 张`);
  if (typeof g.phaseEndsAt === 'number') {
    lines.push(`倒计时 ${formatCountdown(g.phaseEndsAt - nowSec)}`);
  }
  return lines.join('\n');
}

/** 单根 K 线推送。最后一根（candleIndex === total）走结算文案。 */
export function formatCandleMessage(ev: CandleEvent): string {
  const total = ev.total ?? CANDLES_TOTAL;
  const needed = ev.needed ?? LIT_NEEDED;
  if (ev.candleIndex >= total || ev.outcome !== undefined) {
    return formatFinalMessage(ev, total, needed);
  }
  const gap = gapText(ev.priceUsd, ev.gatePriceUsd);
  const litPart = typeof ev.litCount === 'number' ? `已亮 ${ev.litCount}/${needed}，` : '';
  if (ev.lit) {
    return `第 ${ev.candleIndex} 盏亮了！${litPart}${gap}`;
  }
  return `第 ${ev.candleIndex} 盏未亮，${litPart}${gap}`;
}

/** 最后一根：破城 / 城没破（阵亡）。 */
export function formatFinalMessage(ev: CandleEvent, total: number = CANDLES_TOTAL, needed: number = LIT_NEEDED): string {
  let outcome = ev.outcome;
  if (outcome === undefined && typeof ev.litCount === 'number') {
    outcome = ev.litCount >= needed ? 'SUCCEEDED' : 'FAILED_PERMANENT';
  }
  const litPart = typeof ev.litCount === 'number' ? `已亮 ${ev.litCount}/${needed} 盏` : `共 ${total} 盏已全部亮完`;
  if (outcome === 'SUCCEEDED') {
    return `第 ${ev.roundId} 城破城！${litPart}，城门 ${formatUsd(ev.gatePriceUsd)} 被攻破。压城奖励 80% 待解锁，本金可领。`;
  }
  if (outcome === 'FAILED_PERMANENT') {
    return `第 ${ev.roundId} 城没破，阵亡。${litPart}，未达 ${needed} 盏。本金归零，奖池一半滚入下一城。`;
  }
  return `第 ${ev.roundId} 城 ${total} 盏已全部亮完，结算结果以链上为准。`;
}

/** 战队等级一行：Lv 与下一级还差几人。入参是本城上车人数（stakers this round），不是成员总数。 */
export function formatSquadLevel(stakersThisRound: number): string {
  const info = levelInfo(stakersThisRound);
  const levelText = info.level === 0 ? '未成团' : `Lv${info.level}`;
  if (info.nextAt === null) return `${levelText}（已满级）`;
  return `${levelText} · 还差 ${info.remaining} 人升级（Lv${info.level + 1}：${info.nextAt} 人）`;
}

/** /rank：本群战队排名。members = 成员总数，stakers = 本城上车人数（等级与排名按它）。 */
export function formatRank(name: string, rank: number, total: number, members: number, stakers: number): string {
  return [
    `战队「${name}」 · 第 ${rank} 名 / 共 ${total} 支`,
    `成员 ${members} 人 · 本城上车 ${stakers} 人`,
    formatSquadLevel(stakers),
  ].join('\n');
}

/** /me：个人所在战队。 */
export function formatMe(name: string, rank: number, total: number, members: number, stakers: number, inviteLink: string): string {
  return [
    `你的战队：「${name}」 · 第 ${rank} 名 / 共 ${total} 支`,
    `成员 ${members} 人 · 本城上车 ${stakers} 人 · ${formatSquadLevel(stakers)}`,
    `邀请链接：${inviteLink}`,
  ].join('\n');
}

/** 每 6h 战队摘要（攻城期）。 */
export function formatDigest(g: GateStatus, name: string, rank: number, total: number, members: number, stakers: number): string {
  return [
    `【攻城战报】第 ${g.roundId} 城 · 攻城中`,
    `战队「${name}」第 ${rank} 名 / 共 ${total} 支 · 成员 ${members} 人 · 本城上车 ${stakers} 人`,
    formatSquadLevel(stakers),
    `城门 ${formatUsd(g.gatePriceUsd)} ｜ 现价 ${formatUsd(g.priceUsd)} ｜ 已亮 ${g.litCandles}/${LIT_NEEDED} 盏`,
  ].join('\n');
}
