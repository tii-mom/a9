-- 0010: v10 合约（docs/00 D-42、docs/34 §2）
-- 只加不删：V8 的 referrals / unlock_pool / round_rewards 状态列等保留在库里但不再读写（回滚安全）。

-- 1) 团队释放额：成功轮 RC 直接转 1.2 亿给团队钱包（RoundSettled.teamReleasedRaw；
--    get_round.teamReleaseConfirmed=true 才写入，转账被退回待 RetrySettlement 时保持 NULL）
ALTER TABLE rounds ADD COLUMN team_released_raw TEXT;

-- 2) 退款账本（合约 round 0）：DepositRefunded / Claimed(bit 15) 的事件流水，按 (tx_lt, address, kind) 幂等。
--    kind：credit = 记入账本（instant=false, recorded=true）
--          instant = 即时退回（不进账本，仅留痕）
--          dust = 低于最低质押且 TON 不足的零头，合约留存、不退（recorded=false）
--          claim = 领取账本余额（Claimed 事件 roundsMask bit 15；金额 = 领取前账本余额）
CREATE TABLE IF NOT EXISTS refund_ledger (
  tx_lt      TEXT NOT NULL,
  address    TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('credit','instant','dust','claim')),
  amount_raw TEXT NOT NULL CHECK (length(amount_raw) BETWEEN 1 AND 40 AND amount_raw NOT GLOB '*[^0-9]*'),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tx_lt, address, kind)
);
CREATE INDEX IF NOT EXISTS idx_refund_ledger_address ON refund_ledger(address);
