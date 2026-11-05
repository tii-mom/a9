-- 0008: FIX-6 钱包绑定改为「StateInit 已验证」（code_hash / verified_at）
-- 背景：旧实现只做 TOFU 绑定客户端自报 publicKey，攻击者可抢先绑定任意地址。
-- 现在 tonproof.ts 要求提交 StateInit 并验证 address.hash == hash(StateInit)、
-- code hash ∈ {v3r2, v4r2, v5r1}、data 中 public_key == 签名公钥。
--
-- 清理已抢注绑定：旧行没有 verified_at（未验证），一次性删除，真实持有者下次带
-- StateInit 验签时会自动重建；如需手动清理可执行：
--   wrangler d1 execute fuse-protocol --remote --command "DELETE FROM wallet_bindings"

ALTER TABLE wallet_bindings ADD COLUMN code_hash TEXT;
ALTER TABLE wallet_bindings ADD COLUMN verified_at INTEGER;

-- 旧 TOFU 绑定（verified_at IS NULL）全部作废
DELETE FROM wallet_bindings WHERE verified_at IS NULL;
