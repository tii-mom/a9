/**
 * 战队等级表：按人数升级，全队军饷加成递增。
 * 数值来自 docs/35 §4.3（5 / 20 / 100 / 500 人 → +3% / +6% / +10% / +15%）。
 */
export const SQUAD_LEVELS = [
  { level: 1, members: 5, bonusPct: 3 },
  { level: 2, members: 20, bonusPct: 6 },
  { level: 3, members: 100, bonusPct: 10 },
  { level: 4, members: 500, bonusPct: 15 },
] as const;

export const SQUAD_MAX_LEVEL = SQUAD_LEVELS[SQUAD_LEVELS.length - 1].level;

export interface NextSquadLevel {
  level: number;
  members: number;
  bonusPct: number;
  /** 还差几人升到该级（不低于 0） */
  remaining: number;
}

/** 当前等级的军饷加成（0 级无加成）。 */
export function squadBonusPct(level: number): number {
  const hit = SQUAD_LEVELS.find((item) => item.level === level);
  return hit ? hit.bonusPct : 0;
}

/** 下一等级；已满级返回 null。 */
export function nextSquadLevel(currentLevel: number, memberCount: number): NextSquadLevel | null {
  const next = SQUAD_LEVELS.find((item) => item.level > currentLevel);
  if (!next) return null;
  return {
    level: next.level,
    members: next.members,
    bonusPct: next.bonusPct,
    remaining: Math.max(0, next.members - memberCount),
  };
}
