-- 0014: 机器人 K 线亮灯推送去重（docs/35 §4.1「每根 K 线亮灯」）。
-- 主键 (round_id, candle_index)：同一根 K 线只推一次；索引器重放 / 重复摄入不会重推。只加不删。
CREATE TABLE IF NOT EXISTS bot_pushes (
  round_id     INTEGER NOT NULL,
  candle_index INTEGER NOT NULL,
  pushed_at    INTEGER NOT NULL,
  PRIMARY KEY (round_id, candle_index)
);

-- Backfill: candles already ingested before this migration are marked as pushed (pushed_at = 0),
-- so a cursor reset / reindex never re-announces historical candles to squad groups.
INSERT OR IGNORE INTO bot_pushes (round_id, candle_index, pushed_at)
SELECT round_id, candle_index, 0 FROM candles;
