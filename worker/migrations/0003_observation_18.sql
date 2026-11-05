-- 0003: 观察期从 12 根（48h）改为 18 根（72h），放宽 candles_seen / qualified_candles / candle_index 的 CHECK 上限。
PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS rounds_new (
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
  candles_seen            INTEGER NOT NULL DEFAULT 0 CHECK (candles_seen BETWEEN 0 AND 18),
  qualified_candles       INTEGER NOT NULL DEFAULT 0 CHECK (qualified_candles BETWEEN 0 AND 18),
  total_accepted_stake_raw TEXT NOT NULL DEFAULT '0',
  staker_count            INTEGER NOT NULL DEFAULT 0 CHECK (staker_count >= 0),
  result                  TEXT CHECK (result IS NULL OR result IN ('SUCCESS','FAILURE','TECHNICAL_ABORT')),
  burned_raw              TEXT,
  updated_at              INTEGER NOT NULL
);

INSERT INTO rounds_new (round_id, state, target_price_usd_e8, reward_budget_raw, stake_open_at, stake_close_at,
                        observation_start, observation_end, candles_seen, qualified_candles,
                        total_accepted_stake_raw, staker_count, result, burned_raw, updated_at)
  SELECT round_id, state, target_price_usd_e8, reward_budget_raw, stake_open_at, stake_close_at,
         observation_start, observation_end, candles_seen, qualified_candles,
         total_accepted_stake_raw, staker_count, result, burned_raw, updated_at FROM rounds;

DROP TABLE rounds;
ALTER TABLE rounds_new RENAME TO rounds;

CREATE TABLE IF NOT EXISTS candles_new (
  round_id            INTEGER NOT NULL,
  candle_index        INTEGER NOT NULL CHECK (candle_index BETWEEN 0 AND 17),
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

INSERT INTO candles_new (round_id, candle_index, period_start, period_end, twap_price_usd_e8, qualified,
                         coverage_bps, valid_source_count, data_digest, recorded_at)
  SELECT round_id, candle_index, period_start, period_end, twap_price_usd_e8, qualified,
         coverage_bps, valid_source_count, data_digest, recorded_at FROM candles;

DROP TABLE candles;
ALTER TABLE candles_new RENAME TO candles;
CREATE INDEX IF NOT EXISTS idx_candles_round ON candles(round_id);

PRAGMA foreign_keys = ON;
