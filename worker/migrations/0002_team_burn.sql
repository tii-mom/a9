-- 0002: 允许销毁账本记录团队轮次额度（kind='team'）
-- 背景（V4 决策）：团队 12%（每轮 1.2 亿）与轮次解锁一致——本轮达标则释放，本轮失败则销毁。
PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS burn_ledger_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id     INTEGER NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('reward','principal','team')),
  amount_raw   TEXT NOT NULL,
  burn_ref     TEXT NOT NULL UNIQUE,
  confirmed    INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0, 1)),
  created_at   INTEGER NOT NULL,
  confirmed_at INTEGER,
  FOREIGN KEY (round_id) REFERENCES rounds(round_id) ON DELETE CASCADE
);

INSERT INTO burn_ledger_new (id, round_id, kind, amount_raw, burn_ref, confirmed, created_at, confirmed_at)
  SELECT id, round_id, kind, amount_raw, burn_ref, confirmed, created_at, confirmed_at FROM burn_ledger;

DROP TABLE burn_ledger;
ALTER TABLE burn_ledger_new RENAME TO burn_ledger;
CREATE INDEX IF NOT EXISTS idx_burn_round ON burn_ledger(round_id);

PRAGMA foreign_keys = ON;
