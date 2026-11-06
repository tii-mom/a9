/** Telegram WebApp 桥接（window.Telegram.WebApp，由 index.html 中的脚本注入）。 */

export interface TgUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TgWebApp {
  ready(): void;
  expand(): void;
  initData?: string;
  initDataUnsafe?: { user?: TgUser; start_param?: string };
  openTelegramLink(url: string): void;
  openLink?(url: string, options?: { try_instant_view?: boolean }): void;
  shareToStory?(mediaUrl: string, params?: { text?: string; widget_link?: { url: string; name?: string } }): void;
  shareMessage?(messageId: string, callback?: (sent: boolean) => void): void;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TgWebApp };
  }
}

/** 当前是否运行在 Telegram 内；普通网页返回 null。 */
export function getTelegramWebApp(): TgWebApp | null {
  if (typeof window === 'undefined') return null;
  return window.Telegram?.WebApp ?? null;
}

let initialized = false;

/** 仅第一次调用时执行 ready()/expand()，之后直接返回实例。 */
export function initTelegramWebApp(): TgWebApp | null {
  const webApp = getTelegramWebApp();
  if (!webApp || initialized) return webApp;
  initialized = true;
  try {
    webApp.ready();
    webApp.expand();
  } catch {
    /* 旧版客户端可能缺少方法：忽略 */
  }
  return webApp;
}

/** 打开外部链接：Telegram 内走 openLink，其余新开窗口。 */
export function openExternal(url: string): void {
  const webApp = getTelegramWebApp();
  try {
    if (webApp?.openLink) {
      webApp.openLink(url);
      return;
    }
  } catch {
    /* fall through */
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** 打开 t.me 分享页：Telegram 内走 openTelegramLink，其余新开窗口。 */
export function openTelegramShare(url: string): void {
  const webApp = getTelegramWebApp();
  try {
    if (webApp) {
      webApp.openTelegramLink(url);
      return;
    }
  } catch {
    /* fall through */
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}
