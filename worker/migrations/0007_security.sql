-- 0007: 写接口安全（TON Proof 验签 / 一次性 nonce 防重放 / 最简限流）
-- 只加不删。

CREATE TABLE IF NOT EXISTS auth_nonces (
  nonce      TEXT PRIMARY KEY,
  address    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_auth_nonces_address ON auth_nonces(address);
CREATE INDEX IF NOT EXISTS idx_auth_nonces_expires ON auth_nonces(expires_at);

CREATE TABLE IF NOT EXISTS wallet_bindings (
  address    TEXT PRIMARY KEY,
  public_key TEXT NOT NULL UNIQUE,
  bound_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limit (
  key          TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_window ON rate_limit(window_start);
