import { useEffect } from 'react';
import { ApiError, socialApi } from '../../lib/api';
import { clearPending, readPending } from './startParam';
import { getTelegramWebApp } from './telegram';

/** 本页面会话内已发起过绑定的地址，避免重复请求。 */
const attempted = new Set<string>();

/** 明确的业务拒绝：清除本地记录。其余（401 缺 proof、429、5xx、网络）保留记录，下次重试。 */
const FINAL_ERROR_CODES = new Set(['BAD_REQUEST', 'CONFLICT', 'NOT_FOUND']);

/**
 * 钱包连接后，把本地待绑定的邀请码 / 战队码提交给 POST /bind。
 * Telegram 身份只以 WebApp.initData 原文（tgInitData）上送，由服务端校验后取 user.id；前端不发 tgUserId。
 * 服务端「首次绑定为准」：收到业务错误（ApiError）即视为已处理并清除本地记录；
 * 网络错误保留记录，下次进入时重试。没有码时不发起绑定，避免占用「首次绑定」。
 * 应挂在应用级（App），任一页面连上钱包都会触发。
 */
export function useSocialBind(address: string | null): void {
  useEffect(() => {
    if (!address || attempted.has(address)) return;
    const pending = readPending();
    if (!pending) return;
    attempted.add(address);
    const tgInitData = getTelegramWebApp()?.initData || undefined;
    socialApi
      .bind({
        wallet: address,
        referralCode: pending.ref,
        squadCode: pending.squad,
        source: pending.source,
        tgInitData,
      })
      .then(() => clearPending())
      .catch((error: unknown) => {
        if (error instanceof ApiError && FINAL_ERROR_CODES.has(error.code)) {
          clearPending();
          return;
        }
        attempted.delete(address);
      });
  }, [address]);
}
