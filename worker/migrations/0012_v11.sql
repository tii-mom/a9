-- 0012: v11 攻城令 / 压城奖励 / 一键续战（docs/35 §3）
-- 只加不删：v10 的 claims / refund_ledger 等保留，旧行不回填、不改写。

-- 1) 质押来源：deposit = 转账入金（计入 RC 钱包入金）；restake = 一键续战滚入（不是新的入金）。
--    weight_raw 列（v8 起就有）在 v11 存链上 DepositAccepted.weightRaw（= 金额 × 时机系数）。
ALTER TABLE stakes ADD COLUMN source TEXT NOT NULL DEFAULT 'deposit';

-- 2) 领取事件流水（v11 Claimed 事件；同一 (round, owner) 可能有两次：首次本金+20%，之后压城解锁）。
--    主键 (tx_lt, address, round_id) 保证索引器重放幂等；claims 视图由它聚合。
CREATE TABLE IF NOT EXISTS claim_events (
  tx_lt         TEXT NOT NULL,
  address       TEXT NOT NULL,
  round_id      INTEGER NOT NULL,
  principal_raw TEXT NOT NULL,
  reward_raw    TEXT NOT NULL,
  claimed_at    INTEGER NOT NULL,
  PRIMARY KEY (tx_lt, address, round_id)
);
CREATE INDEX IF NOT EXISTS idx_claim_events_address ON claim_events(address);
