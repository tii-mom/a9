-- FUSE 引信协议 — D1 schema v1
-- 约定：
--   * 所有代币金额保存为 TEXT（raw units 字符串，TOKEN_DECIMALS = 9）：
--     初始总供应 1e19 已超出 SQLite int64 上限，禁止用 INTEGER / SQL SUM 处理金额。
--   * 价格保存为 TEXT（USD_E8 字符串，1e8 = $1）。
--   * 时间保存为 INTEGER（unix 毫秒）。
--   * 读写全部在 worker/src/store.ts 聚合，页面查询避免 N+1。

CREATE TABLE IF NOT EXISTS config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS metrics (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 十轮主表：本轮状态、目标价、质押/观察窗口、K 线计数、终态结果
CREATE TABLE IF NOT EXISTS rounds (
  round_id                INTEGER PRIMARY KEY CHECK (round_id BETWEEN 1 AND 10),
  state                   TEXT NOT NULL CHECK (state IN (
                            'UNOPENED','STAKING_OPEN','STAKING_CLOSED','OBSERVING','ORACLE_PAUSED',
                            'SETTLING_SUCCESS','SETTLING_FAILURE','SUCCEEDED','FAILED_PERMANENT','TECHNICAL_ABORTED')),
  target_price_usd_e8     TEXT NOT NULL,
  reward_budget_raw       TEXT NOT NULL,
  stake_open_at           INTEGER,
  stake_close_at          INTEGER,
  observation_start       INTEGER,
  observation_end         INTEGER,
  candles_seen            INTEGER NOT NULL DEFAULT 0 CHECK (candles_seen BETWEEN 0 AND 12),
  qualified_candles       INTEGER NOT NULL DEFAULT 0 CHECK (qualified_candles BETWEEN 0 AND 12),
  total_accepted_stake_raw TEXT NOT NULL DEFAULT '0',
  staker_count            INTEGER NOT NULL DEFAULT 0 CHECK (staker_count >= 0),
  result                  TEXT CHECK (result IS NULL OR result IN ('SUCCESS','FAILURE','TECHNICAL_ABORT')),
  burned_raw              TEXT,
  updated_at              INTEGER NOT NULL
);

-- 12 根观察 K 线（主键保证同一轮同一根只落库一次 → cron/admin tick 幂等）
CREATE TABLE IF NOT EXISTS candles (
  round_id            INTEGER NOT NULL,
  candle_index        INTEGER NOT NULL CHECK (candle_index BETWEEN 0 AND 11),
  period_start        INTEGER NOT NULL,
  period_end          INTEGER NOT NULL,
  twap_price_usd_e8   TEXT NOT NULL,
  qualified           INTEGER NOT NULL CHECK (qualified IN (0, 1)),
  coverage_bps        INTEGER NOT NULL CHECK (coverage_bps BETWEEN 0 AND 10000),
  valid_source_count  INTEGER NOT NULL CHECK (valid_source_count >= 0),
  data_digest         TEXT NOT NULL,
  recorded_at         INTEGER NOT NULL,
  PRIMARY KEY (round_id, candle_index),
  FOREIGN KEY (round_id) REFERENCES rounds(round_id) ON DELETE CASCADE
);

-- 每笔质押独立记账：同一地址可多次质押，但 (round, address, nonce) 必须唯一
CREATE TABLE IF NOT EXISTS stakes (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id                INTEGER NOT NULL,
  address                 TEXT NOT NULL,
  amount_raw              TEXT NOT NULL CHECK (length(amount_raw) BETWEEN 1 AND 40 AND amount_raw NOT GLOB '*[^0-9]*'),
  weight_raw              TEXT NOT NULL,
  nonce                   TEXT NOT NULL,
  risk_disclosure_version INTEGER NOT NULL,
  accept_full_principal_burn INTEGER NOT NULL DEFAULT 0 CHECK (accept_full_principal_burn IN (0, 1)),
  principal_claimed       INTEGER NOT NULL DEFAULT 0 CHECK (principal_claimed IN (0, 1)),
  reward_claimed          INTEGER NOT NULL DEFAULT 0 CHECK (reward_claimed IN (0, 1)),
  accepted_at             INTEGER NOT NULL,
  UNIQUE (round_id, address, nonce),
  FOREIGN KEY (round_id) REFERENCES rounds(round_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_stakes_round ON stakes(round_id);
CREATE INDEX IF NOT EXISTS idx_stakes_address ON stakes(address);
CREATE INDEX IF NOT EXISTS idx_stakes_round_address ON stakes(round_id, address);

-- 领取记录：唯一键保证 principal / reward 各自只能领一次（幂等）
CREATE TABLE IF NOT EXISTS claims (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id   INTEGER NOT NULL,
  address    TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('principal','reward')),
  amount_raw TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  UNIQUE (round_id, address, kind),
  FOREIGN KEY (round_id) REFERENCES rounds(round_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_claims_address ON claims(address);

-- 逐笔成交（演示/链上同步）
CREATE TABLE IF NOT EXISTS trades (
  id           INTEGER PRIMARY KEY,
  ts           INTEGER NOT NULL,
  side         TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  amount_raw   TEXT NOT NULL,
  price_usd_e8 TEXT NOT NULL,
  value_usd_e8 TEXT NOT NULL,
  big          INTEGER NOT NULL DEFAULT 0 CHECK (big IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_trades_ts ON trades(ts DESC);

-- 盘口深度快照
CREATE TABLE IF NOT EXISTS book_levels (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  side         TEXT NOT NULL CHECK (side IN ('ask','bid')),
  price_usd_e8 TEXT NOT NULL,
  amount_raw   TEXT NOT NULL,
  seq          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_book_side_seq ON book_levels(side, seq);

-- 销毁账本：每种销毁一条记录，burn_ref 唯一 → 重复结算不会重复销毁
CREATE TABLE IF NOT EXISTS burn_ledger (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id     INTEGER NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('reward','principal')),
  amount_raw   TEXT NOT NULL,
  burn_ref     TEXT NOT NULL UNIQUE,
  confirmed    INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0, 1)),
  created_at   INTEGER NOT NULL,
  confirmed_at INTEGER,
  FOREIGN KEY (round_id) REFERENCES rounds(round_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_burn_round ON burn_ledger(round_id);

-- 管理端审计日志（admin 端点与状态机自动推进都写这里）
CREATE TABLE IF NOT EXISTS admin_events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     INTEGER NOT NULL,
  level  TEXT NOT NULL CHECK (level IN ('info','warn','error')),
  actor  TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_events_ts ON admin_events(ts DESC);

-- schema 版本号记录在 config.schema_version（D1 不允许 PRAGMA user_version）。
