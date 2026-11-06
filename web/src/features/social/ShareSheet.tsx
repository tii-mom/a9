import { useEffect, useState } from 'react';
import { a9Yi } from './format';
import { buildShareText, buildShareUrl, buildTelegramShareUrl, buildXIntentUrl } from './shareText';
import { getTelegramWebApp, openExternal, openTelegramShare } from './telegram';
import type { GateState, ShareMoment } from './types';
import './social.css';

export type { ShareMoment } from './types';

const MOMENT_TITLE: Record<ShareMoment, string> = {
  join: '上车成功',
  squad: '成团',
  breach: '破城',
  fallen: '阵亡',
};

export interface ShareSheetProps {
  open: boolean;
  onClose: () => void;
  /** 分享者的邀请码（落地页 /s/<code>） */
  code: string;
  moment: ShareMoment;
  /** 实时破城数据；文案里的数字来自这里，缺省时文案退化为不带数字的版本 */
  gate?: GateState | null;
  squadName?: string | null;
  /** 阵亡勋章数（fallen 时使用） */
  medals?: number | null;
  /**
   * 后端预生成的 Telegram prepared message id。
   * 目前没有调用方：传入时 Telegram 按钮走 WebApp.shareMessage，否则打开 t.me/share/url。
   */
  preparedMessageId?: string;
}

/** 喊人面板：Telegram / Telegram Story / X / 复制链接。 */
export function ShareSheet({ open, onClose, code, moment, gate, squadName, medals, preparedMessageId }: ShareSheetProps) {
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [storyMedia, setStoryMedia] = useState<string | null>(null);

  const webApp = getTelegramWebApp();
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const text = buildShareText(moment, {
    roundId: gate?.roundId ?? null,
    remainingUsd: gate?.remainingUsd ?? null,
    stakeCount: gate?.stakeCount ?? null,
    poolYi: gate ? a9Yi(gate.rewardBudgetRaw) : null,
    squadName: squadName ?? null,
    medals: medals ?? null,
  });
  const url = buildShareUrl(origin, code);
  const xUrl = buildXIntentUrl(text, buildShareUrl(origin, code, 'x'));
  const canStory = !!webApp && typeof webApp.shareToStory === 'function';

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Story 配图：优先 /og/<code>.png（动态 OG），不存在时回退到站点默认图。
  useEffect(() => {
    if (!open || !canStory) return;
    let alive = true;
    const fallback = `${origin}/og-a9.png`;
    const candidate = `${origin}/og/${encodeURIComponent(code)}.png`;
    fetch(candidate, { method: 'HEAD' })
      .then((res) => (alive ? setStoryMedia(res.ok ? candidate : fallback) : undefined))
      .catch(() => {
        if (alive) setStoryMedia(fallback);
      });
    return () => {
      alive = false;
    };
  }, [open, canStory, code, origin]);

  if (!open) return null;

  const shareTelegram = () => {
    setNotice(null);
    if (webApp && preparedMessageId && typeof webApp.shareMessage === 'function') {
      webApp.shareMessage(preparedMessageId);
      return;
    }
    openTelegramShare(buildTelegramShareUrl(url, text));
  };

  const shareStory = () => {
    if (!webApp?.shareToStory) return;
    try {
      webApp.shareToStory(storyMedia ?? `${origin}/og-a9.png`, { text, widget_link: { url, name: 'A9 攻城' } });
    } catch {
      setNotice('当前 Telegram 版本不支持分享到 Story');
    }
  };

  const shareX = () => {
    setNotice(null);
    openExternal(xUrl);
  };

  const copyLink = async () => {
    setNotice(null);
    try {
      await navigator.clipboard.writeText(`${text} ${url}`);
      setCopied(true);
    } catch {
      setNotice('复制失败，请长按下方文案手动复制');
    }
  };

  return (
    <div
      className="sx-scrim"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="sx-sheet" role="dialog" aria-modal="true" aria-labelledby="sx-share-title">
        <div className="sx-sheet-h">
          <h2 id="sx-share-title">喊人 · {MOMENT_TITLE[moment]}</h2>
          <button type="button" className="sx-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <p className="sx-preview">
          {text}
          <br />
          <span className="sx-muted">{url}</span>
        </p>
        <div className="sx-share-grid">
          <button type="button" className="btn fire" onClick={shareTelegram}>
            Telegram
          </button>
          {canStory ? (
            <button type="button" className="btn" onClick={shareStory}>
              Telegram Story
            </button>
          ) : null}
          <button type="button" className="btn" onClick={shareX}>
            X
          </button>
          <button type="button" className="btn" onClick={copyLink}>
            {copied ? '已复制' : '复制链接'}
          </button>
        </div>
        {notice ? (
          <p className="sx-notice" role="status">
            {notice}
          </p>
        ) : null}
      </div>
    </div>
  );
}
