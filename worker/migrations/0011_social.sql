-- 0011: 社交层（链下，docs/35 §4）。只加不删；不改合约、不改既有表。

-- 用户：钱包 ↔ 邀请码 ↔ 邀请人 ↔ 战队。
-- referrer_wallet 一经写入不可改（首次绑定生效）；ref_source 仅在绑定邀请人时写入。
CREATE TABLE IF NOT EXISTS users (
  wallet               TEXT PRIMARY KEY,
  tg_user_id           TEXT UNIQUE,
  invite_code          TEXT NOT NULL UNIQUE,
  referrer_wallet      TEXT,
  ref_source           TEXT CHECK (ref_source IS NULL OR ref_source IN ('tg','x','web')),
  squad_code           TEXT,
  squad_changed_season INTEGER,
  created_at           INTEGER NOT NULL,
  CHECK (referrer_wallet IS NULL OR referrer_wallet <> wallet)
);
CREATE INDEX IF NOT EXISTS idx_users_referrer ON users(referrer_wallet);
CREATE INDEX IF NOT EXISTS idx_users_squad ON users(squad_code);

-- 战队（一层公会）。leader_wallet 可空：群内 /team 由机器人建的战队可能没有钱包。
CREATE TABLE IF NOT EXISTS squads (
  code          TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  leader_wallet TEXT,
  tg_chat_id    TEXT UNIQUE,
  season        INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_squads_leader ON squads(leader_wallet);

-- 分享落地页点击（/s/:code?src=x 等），用于拉新来源统计。
CREATE TABLE IF NOT EXISTS share_clicks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL,
  src        TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_share_clicks_code ON share_clicks(code);

-- 军饷明细（每城一批；computeJunxiang 的输出，无 merkle / 领取合约）。
CREATE TABLE IF NOT EXISTS junxiang (
  round_id    INTEGER NOT NULL,
  wallet      TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('referrer','referee','squad','leader','streak')),
  budget      TEXT NOT NULL CHECK (budget IN ('referral','squad','streak')),
  amount_raw  TEXT NOT NULL CHECK (length(amount_raw) BETWEEN 1 AND 40 AND amount_raw NOT GLOB '*[^0-9]*'),
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (round_id, wallet, kind)
);
CREATE INDEX IF NOT EXISTS idx_junxiang_round ON junxiang(round_id);
