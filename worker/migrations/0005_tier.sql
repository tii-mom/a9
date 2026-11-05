-- 0005: 目标价档位落库（D-28 / V6.1 已确认）
-- 语义：tier = 1 + 已成功轮数；失败轮不升档（下一轮同档重试），成功轮才 tier+1；10 轮 ≠ 10 档位。
-- 目标价 = P0 × 2^tier（链上再取 max(阶梯, 2×开窗 24h TWAP) 锁定；demo 用阶梯下限）。
ALTER TABLE rounds ADD COLUMN target_tier INTEGER NOT NULL DEFAULT 0;

-- 回填已开启 / 已结算轮次：开轮时的真实档位 = 1 + 更早轮次中 SUCCEEDED 的数量（不随后续成功变化）
UPDATE rounds
   SET target_tier = 1 + (
     SELECT COUNT(*) FROM rounds x
      WHERE x.round_id < rounds.round_id AND x.state = 'SUCCEEDED'
   )
 WHERE state <> 'UNOPENED';

-- 回填 UNOPENED 轮次：乐观投影（假设更早的非失败轮次都成功），仅用于阶梯展示；实际开轮时以 CAS 覆盖
UPDATE rounds
   SET target_tier = 1 + (
     SELECT COUNT(*) FROM rounds x
      WHERE x.round_id < rounds.round_id
        AND x.state IN ('SUCCEEDED','STAKING_OPEN','STAKING_CLOSED','OBSERVING','ORACLE_PAUSED',
                        'SETTLING_SUCCESS','SETTLING_FAILURE','UNOPENED')
   )
 WHERE state = 'UNOPENED';

-- 旧库兼容：把目标价改写为 P0 × 2^tier（重新 seed 会用同一口径覆盖，无需人工修正）
UPDATE rounds
   SET target_price_usd_e8 = CAST(
     CAST((SELECT value FROM config WHERE key = 'p0_usd_e8') AS INTEGER) *
     (CASE target_tier
        WHEN 1 THEN 2 WHEN 2 THEN 4 WHEN 3 THEN 8 WHEN 4 THEN 16 WHEN 5 THEN 32
        WHEN 6 THEN 64 WHEN 7 THEN 128 WHEN 8 THEN 256 WHEN 9 THEN 512 WHEN 10 THEN 1024
        ELSE 1 END) AS TEXT)
 WHERE target_tier BETWEEN 1 AND 10
   AND EXISTS (SELECT 1 FROM config WHERE key = 'p0_usd_e8');
