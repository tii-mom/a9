import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ApiError } from '../../lib/api';
import { useLang } from '../../lib/lang';
import { apiErrorText, COMMON, stateLabel, statePillClass } from './common';
import type { RoundState } from '@shared/types';

/** 轮次状态徽标。 */
export function StatePill({ state, className }: { state: RoundState | null | undefined; className?: string }) {
  const { lang } = useLang();
  return (
    <span className={`${statePillClass(state)}${className ? ' ' + className : ''}`}>
      <i aria-hidden="true" />
      {stateLabel(state, lang)}
    </span>
  );
}

/** 指标卡（沿用 app.css 的 .card）。 */
export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'ok' | 'bad' | 'fire' }) {
  const toneClass = tone ? (tone === 'ok' ? 'ok' : tone === 'bad' ? 'bad' : 'hot') : undefined;
  return (
    <div className="card ap-stat">
      <span className="lbl">{label}</span>
      <div className={`v${toneClass ? ' ' + toneClass : ''}`}>{value}</div>
      {hint ? <small className="ap-hint">{hint}</small> : null}
    </div>
  );
}

/** 页头：lbl + h1 + 描述 + 右侧操作区。 */
export function PageHead({ lbl, title, desc, right }: { lbl: string; title: string; desc?: string; right?: ReactNode }) {
  return (
    <div className="page-h">
      <div>
        <span className="lbl">{lbl}</span>
        <h1>{title}</h1>
        {desc ? <p>{desc}</p> : null}
      </div>
      {right ? <div className="ap-head-right">{right}</div> : null}
    </div>
  );
}

/** 空态。 */
export function Empty({ title, desc, children }: { title: string; desc?: string; children?: ReactNode }) {
  return (
    <div className="empty ap-empty">
      <b>{title}</b>
      {desc ? <p>{desc}</p> : null}
      {children ? <div className="ap-empty-actions">{children}</div> : null}
    </div>
  );
}

/** 加载骨架。 */
export function Loading({ rows = 4 }: { rows?: number }) {
  const { lang } = useLang();
  const c = COMMON[lang];
  return (
    <div className="ap-loading" role="status" aria-live="polite">
      <span className="sr">{c.loading}</span>
      {Array.from({ length: rows }).map((_, index) => (
        <span key={index} className="ap-skel" style={{ width: `${92 - ((index * 11) % 40)}%` }} />
      ))}
    </div>
  );
}

/** 错误态 + 重试。 */
export function ErrorState({ error, onRetry, title }: { error: ApiError | string | null | undefined; onRetry?: () => void; title?: string }) {
  const { lang } = useLang();
  const c = COMMON[lang];
  const text = typeof error === 'string' ? error : apiErrorText(error ?? null, lang);
  return (
    <div className="err-box ap-err">
      <b>{title ?? c.apiDownTitle}</b>
      <p>{text}</p>
      {typeof error === 'object' && error?.code === 'NETWORK' ? <p className="ap-err-hint">{c.apiDownHint}</p> : null}
      {onRetry ? (
        <button className="btn ghost sm" type="button" onClick={onRetry}>
          {c.retry}
        </button>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Toast                                                              */
/* ------------------------------------------------------------------ */

export interface ToastState {
  id: number;
  message: string;
  tone: 'ok' | 'bad';
}

export function useToast() {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timer = useRef<number | null>(null);

  const show = useCallback((message: string, tone: 'ok' | 'bad' = 'ok') => {
    setToast({ id: Date.now(), message, tone });
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), 4000);
  }, []);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  return { toast, show };
}

export function ToastView({ toast }: { toast: ToastState | null }) {
  return (
    <div className={`toast ap-toast${toast ? ' show' : ''}${toast?.tone === 'bad' ? ' bad' : ''}`} role="status" aria-live="polite">
      {toast?.message ?? ''}
    </div>
  );
}

/** 两段式确认按钮：第一次点击进入确认态，第二次执行。 */
export function ConfirmButton({
  label,
  confirmLabel,
  cancelLabel,
  onConfirm,
  disabled,
  busy,
  className,
}: {
  label: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  disabled?: boolean;
  busy?: boolean;
  className?: string;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 5000);
    return () => window.clearTimeout(timer);
  }, [armed]);
  if (!armed) {
    return (
      <button className={className ?? 'btn ghost sm'} type="button" disabled={disabled || busy} onClick={() => setArmed(true)}>
        {busy ? '…' : label}
      </button>
    );
  }
  return (
    <span className="ap-confirm">
      <button
        className="btn fire sm"
        type="button"
        disabled={disabled || busy}
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
      >
        {busy ? '…' : confirmLabel}
      </button>
      <button className="btn ghost sm" type="button" onClick={() => setArmed(false)}>
        {cancelLabel}
      </button>
    </span>
  );
}
