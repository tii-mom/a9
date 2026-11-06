-- 0015: 军饷扩展（守城补贴 / 新人礼 / 猜灯）+ 累计领取清单（docs/35 §4.4）。
-- 只加不删：旧行保留，junxiang 表通过重建加入新 kind / budget（SQLite 不能改 CHECK）。

-- 1) 首次绑定邀请人的时刻（毫秒）。trigger 在 referrer_wallet 从 NULL 变为非空时写入；
--    存量已绑定用户回填为 created_at（近似：绑定通常与建档同一次请求）。
ALTER TABLE users ADD COLUMN referrer_bound_at INTEGER;
UPDATE users SET referrer_bound_at = created_at WHERE referrer_wallet IS NOT NULL AND referrer_bound_at IS NULL;
CREATE TRIGGER IF NOT EXISTS trg_users_referrer_bound
AFTER UPDATE OF referrer_wallet ON users
WHEN OLD.referrer_wallet IS NULL AND NEW.referrer_wallet IS NOT NULL
BEGIN
  UPDATE users SET referrer_bound_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE wallet = NEW.wallet;
END;

-- 2) 军饷明细：新增 kind guard / newcomer / guess 与 budget guard / newcomer / guess；meta = 行备注（如「计入下一城上车」）。
CREATE TABLE junxiang_v15 (
  round_id    INTEGER NOT NULL,
  wallet      TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('referrer','referee','squad','leader','streak','guard','newcomer','guess')),
  budget      TEXT NOT NULL CHECK (budget IN ('referral','squad','streak','guard','newcomer','guess')),
  amount_raw  TEXT NOT NULL CHECK (length(amount_raw) BETWEEN 1 AND 40 AND amount_raw NOT GLOB '*[^0-9]*'),
  meta        TEXT,
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (round_id, wallet, kind)
);
INSERT INTO junxiang_v15 (round_id, wallet, kind, budget, amount_raw, meta, computed_at)
  SELECT round_id, wallet, kind, budget, amount_raw, NULL, computed_at FROM junxiang;
DROP TABLE junxiang;
ALTER TABLE junxiang_v15 RENAME TO junxiang;
CREATE INDEX IF NOT EXISTS idx_junxiang_round ON junxiang(round_id);

-- 3) 猜灯：每人每城一次；lit_guess 为 0..24 的亮灯数猜测。
CREATE TABLE IF NOT EXISTS guesses (
  round_id   INTEGER NOT NULL,
  wallet     TEXT NOT NULL,
  lit_guess  INTEGER NOT NULL CHECK (lit_guess BETWEEN 0 AND 24),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (round_id, wallet)
);

-- 4) 累计军饷清单（版本化）：每次 build 新增一行 payout_lists；items 为该清单每个钱包的叶子与证明。
CREATE TABLE IF NOT EXISTS payout_lists (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  from_round INTEGER NOT NULL,
  to_round   INTEGER NOT NULL,
  root       TEXT NOT NULL,
  leaf_count INTEGER NOT NULL,
  total_raw  TEXT NOT NULL CHECK (length(total_raw) BETWEEN 1 AND 40 AND total_raw NOT GLOB '*[^0-9]*'),
  created_at INTEGER NOT NULL,
  CHECK (from_round <= to_round)
);
CREATE TABLE IF NOT EXISTS payout_items (
  list_id        INTEGER NOT NULL,
  wallet_key     TEXT NOT NULL,
  workchain      INTEGER NOT NULL,
  wallet_hash    TEXT NOT NULL,
  cumulative_raw TEXT NOT NULL CHECK (length(cumulative_raw) BETWEEN 1 AND 40 AND cumulative_raw NOT GLOB '*[^0-9]*'),
  leaf_index     INTEGER NOT NULL,
  leaf           TEXT NOT NULL,
  proof_json     TEXT NOT NULL,
  PRIMARY KEY (list_id, wallet_key),
  FOREIGN KEY (list_id) REFERENCES payout_lists(id) ON DELETE CASCADE
);
