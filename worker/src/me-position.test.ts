/**
 * /api/me 每城拆分（docs/35 §3.4 / contracts/README §2）单测：20% 立即、80% 压城、解锁与可领。
 * 运行：npm run test:social
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FALLBACK_UNLOCK_SECONDS, fallbackUnlockSecondsOf, roundPositionOf, unlockedLockedRaw } from './me-position';

const base = { roundId: 2, principalRaw: 1_000n, rewardRaw: 1_000n, rewardClaimedRaw: 0n };
const noLaterSuccess = { lastSuccessRound: 2, endAt: 0, nowSec: 5_000, fallbackSec: 100 };

test('破城：奖励 20% 立即、80% 压城；首次领取 = 本金 + 20%', () => {
  const p = roundPositionOf({ ...base, state: 'SUCCEEDED', principalClaimed: false, ctx: noLaterSuccess });
  assert.equal(p.immediateRaw, '200');
  assert.equal(p.lockedRaw, '800');
  assert.equal(p.unlockedRaw, '0');
  assert.equal(p.claimablePrincipalRaw, '1000');
  assert.equal(p.claimableRewardRaw, '200');
  assert.equal(p.claimableRaw, '1200');
});

test('首次领取后：可领为 0；之后任一城破城，80% 全部解锁可领', () => {
  const afterFirstClaim = { ...base, state: 'SUCCEEDED' as const, principalClaimed: true, rewardClaimedRaw: 200n };
  const before = roundPositionOf({ ...afterFirstClaim, ctx: noLaterSuccess });
  assert.equal(before.claimableRaw, '0', '压城未解锁前没有可领');
  const later = roundPositionOf({ ...afterFirstClaim, ctx: { ...noLaterSuccess, lastSuccessRound: 3 } });
  assert.equal(later.unlockedRaw, '800');
  assert.equal(later.claimableRaw, '800');
  assert.equal(later.claimablePrincipalRaw, '0');
});

test('第 10 城后线性兜底：按 (now − endAt) / 窗口 解锁，已领部分不重复计入', () => {
  const ctx = { lastSuccessRound: 2, endAt: 1_000, nowSec: 1_050, fallbackSec: 100 };
  assert.equal(unlockedLockedRaw(800n, 2, ctx), 400n, '半个窗口解锁一半');
  assert.equal(unlockedLockedRaw(800n, 2, { ...ctx, nowSec: 1_000 }), 0n, '结束时刻尚未解锁');
  assert.equal(unlockedLockedRaw(800n, 2, { ...ctx, nowSec: 1_200 }), 800n, '超过窗口全部解锁');
  assert.equal(unlockedLockedRaw(800n, 2, { ...ctx, fallbackSec: 0 }), 800n, '窗口为 0 不做除法');

  const partlyClaimed = roundPositionOf({
    ...base,
    state: 'SUCCEEDED',
    principalClaimed: true,
    rewardClaimedRaw: 200n + 400n, // 首次 20% + 之前领过的 400 压城
    ctx,
  });
  assert.equal(partlyClaimed.unlockedRaw, '400');
  assert.equal(partlyClaimed.lockedClaimedRaw, '400');
  assert.equal(partlyClaimed.claimableRaw, '0');
});

test('失败：不可领；技术终止：只退本金', () => {
  const failed = roundPositionOf({ ...base, state: 'FAILED_PERMANENT', principalClaimed: false, ctx: noLaterSuccess });
  assert.equal(failed.claimableRaw, '0');
  assert.equal(failed.immediateRaw, '0');
  const aborted = roundPositionOf({ ...base, state: 'TECHNICAL_ABORTED', principalClaimed: false, rewardRaw: 0n, ctx: noLaterSuccess });
  assert.equal(aborted.claimablePrincipalRaw, '1000');
  assert.equal(aborted.claimableRewardRaw, '0');
});

test('20/80 切分向下取整：immediate = floor(reward × 20%)，locked = reward − immediate（尾差不丢）', () => {
  const p = roundPositionOf({ ...base, rewardRaw: 1_001n, state: 'SUCCEEDED', principalClaimed: false, ctx: noLaterSuccess });
  assert.equal(p.immediateRaw, '200');
  assert.equal(p.lockedRaw, '801');
});

test('兜底解锁窗口：metrics 值优先；缺失 / 非数字 / 非正数回退默认 30 天（2592000 秒）', () => {
  assert.equal(DEFAULT_FALLBACK_UNLOCK_SECONDS, 2_592_000);
  assert.equal(fallbackUnlockSecondsOf(undefined), 2_592_000, '旧部署没有该 metric');
  assert.equal(fallbackUnlockSecondsOf('abc'), 2_592_000);
  assert.equal(fallbackUnlockSecondsOf('0'), 2_592_000);
  assert.equal(fallbackUnlockSecondsOf('-5'), 2_592_000);
  assert.equal(fallbackUnlockSecondsOf('60'), 60, '测试网快速档 60 秒');
});
