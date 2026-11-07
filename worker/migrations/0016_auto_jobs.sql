-- 0016: 自动化任务去重（军饷自动化：RoundSettled 后单城重算 / 每周累计清单构建）。
-- 主键 job_key 决定「只执行一次」：INSERT OR IGNORE 占位成功才执行，同 bot_pushes 的口径。
--   junxiang:R<n>        单城军饷重算（每城一次）
--   payout-week:<ISO周>  每周累计清单构建（如 payout-week:2026-W45）
-- 只加不删。
CREATE TABLE IF NOT EXISTS auto_jobs (
  job_key    TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
