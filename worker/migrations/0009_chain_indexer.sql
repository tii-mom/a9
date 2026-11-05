-- 0009: 链上索引器（indexer-dev / task-39 设计）
-- 背景：MarketSource 是同步签名、只拿得到 RoundRow；chain 模式的现价/终态价/24h 参考价
-- 必须由索引器落库，否则只能返回 0 或假数字。
ALTER TABLE rounds ADD COLUMN last_candle_twap_usd_e8 TEXT;
ALTER TABLE rounds ADD COLUMN last_candle_at INTEGER;
ALTER TABLE rounds ADD COLUMN target_twap24h_usd_e8 TEXT;
ALTER TABLE rounds ADD COLUMN chain_status INTEGER;

-- burn_ledger 记录链上 burn 交易哈希（BurnAck 对账用）
ALTER TABLE burn_ledger ADD COLUMN chain_tx_hash TEXT;
