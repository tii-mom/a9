import { useEffect, useState } from 'react';
import { persistLaunchCodes, parseLaunchCodes } from './startParam';
import type { LaunchCodes } from './startParam';
import { getTelegramWebApp, initTelegramWebApp } from './telegram';
import type { TgUser } from './telegram';

export interface TelegramLaunch {
  /** 是否运行在 Telegram 小程序内 */
  inTelegram: boolean;
  /** Telegram 用户（initDataUnsafe.user）；网页为 null */
  user: TgUser | null;
  /** 本次启动解析出的邀请码 / 战队码 / 来源 */
  codes: LaunchCodes;
}

/**
 * Telegram 小程序启动信息。首次挂载时调用 ready()/expand()，
 * 并把本次带来的邀请码 / 战队码写入本地待绑定记录（首次出现的码优先）。
 */
export function useTelegram(): TelegramLaunch {
  const [launch] = useState<TelegramLaunch>(() => {
    const webApp = getTelegramWebApp();
    const inTelegram = webApp !== null;
    const search = typeof window !== 'undefined' ? window.location.search : '';
    return {
      inTelegram,
      user: webApp?.initDataUnsafe?.user ?? null,
      codes: parseLaunchCodes({ startParam: webApp?.initDataUnsafe?.start_param ?? null, search, inTelegram }),
    };
  });

  useEffect(() => {
    initTelegramWebApp();
    if (launch.codes.ref || launch.codes.squad) persistLaunchCodes(launch.codes);
  }, [launch]);

  return launch;
}
