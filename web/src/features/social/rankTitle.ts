/** 个人战力榜称号：前 100 名按名次授予，其余无称号。 */
export function powerTitle(rank: number): string | null {
  if (!Number.isInteger(rank) || rank < 1) return null;
  if (rank <= 10) return '城主';
  if (rank <= 30) return '将军';
  if (rank <= 60) return '百夫长';
  if (rank <= 100) return '先锋';
  return null;
}
