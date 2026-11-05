-- 0006: V8 权重制 + 奖励三态 + 邀请 + 解锁池 + K 线滚动哈希（docs/17，合约 V8 已定稿）
-- 只加不删：rounds/stakes 加列；新增 referrals / round_rewards / unlock_pool；claims 允许 kind='unlock'。

-- 1) rounds：总权重 + 滚动哈希（链上只存一个 hash，逐条 K 线仍在链下 candles 表）
ALTER TABLE rounds ADD COLUMN total_weight_raw TEXT NOT NULL DEFAULT '0';
ALTER TABLE rounds ADD COLUMN candle_hash TEXT;

-- 2) stakes：权重/连续轮次/奖励三态/邀请人快照
ALTER TABLE stakes ADD COLUMN streak INTEGER NOT NULL DEFAULT 1;
ALTER TABLE stakes ADD COLUMN reward_state INTEGER NOT NULL DEFAULT 0 CHECK (reward_state IN (0, 1, 2));
ALTER TABLE stakes ADD COLUMN referred_by TEXT;

-- 3) 邀请关系（一次性、不可改、一层）
CREATE TABLE IF NOT EXISTS referrals (
  address    TEXT PRIMARY KEY,
  referrer   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer);

-- 4) 每 (轮次, 地址) 的权重与奖励三态（对齐合约 StakePosition.weight / rewardState 与 RoundExtra.bonus）
CREATE TABLE IF NOT EXISTS round_rewards (
  round_id    INTEGER NOT NULL,
  address     TEXT NOT NULL,
  weight_raw  TEXT NOT NULL DEFAULT '0',   -- own weight + 邀请加成
  reward_raw  TEXT NOT NULL DEFAULT '0',   -- floor(rewardBudget × weight / totalWeight)
  state       INTEGER NOT NULL DEFAULT 0 CHECK (state IN (0, 1, 2)),
  paid_raw    TEXT NOT NULL DEFAULT '0',   -- 已早领到账（50%）
  locked_raw  TEXT NOT NULL DEFAULT '0',   -- 已进入 R10 后解锁池
  rolled_raw  TEXT NOT NULL DEFAULT '0',   -- 已滚存进下一轮的金额
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (round_id, address),
  FOREIGN KEY (round_id) REFERENCES rounds(round_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_round_rewards_address ON round_rewards(address);

-- 5) 解锁池（单例）：R10 任一终态后写入 start_at；12 × 30 天线性（1/12 每月）
CREATE TABLE IF NOT EXISTS unlock_pool (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  start_at         INTEGER NOT NULL DEFAULT 0,
  total_locked_raw TEXT NOT NULL DEFAULT '0',
  claimed_raw      TEXT NOT NULL DEFAULT '0',
  updated_at       INTEGER NOT NULL
);
INSERT OR IGNORE INTO unlock_pool (id, start_at, total_locked_raw, claimed_raw, updated_at)
  VALUES (1, 0, '0', '0', 0);

-- 6) claims 允许 kind='unlock'（重建表以放宽 CHECK，数据原样迁移）
PRAGMA foreign_keys = OFF;
CREATE TABLE IF NOT EXISTS claims_new (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id   INTEGER NOT NULL,
  address    TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('principal','reward','unlock')),
  amount_raw TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  UNIQUE (round_id, address, kind),
  FOREIGN KEY (round_id) REFERENCES rounds(round_id) ON DELETE CASCADE
);
INSERT OR IGNORE INTO claims_new (id, round_id, address, kind, amount_raw, claimed_at)
  SELECT id, round_id, address, kind, amount_raw, claimed_at FROM claims;
DROP TABLE claims;
ALTER TABLE claims_new RENAME TO claims;
CREATE INDEX IF NOT EXISTS idx_claims_address ON claims(address);
PRAGMA foreign_keys = ON;
