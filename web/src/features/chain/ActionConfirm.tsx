import { useEffect, useId, useRef, type ReactNode } from 'react';

/** Native modal supplies keyboard containment, Escape and focus restoration. */
export function ActionConfirm({ title, children, onConfirm, onCancel, disabled = false, lang, confirmLabel }: {
  title: string; children: ReactNode; onConfirm: () => void; onCancel: () => void; disabled?: boolean; lang: 'zh' | 'en'; confirmLabel?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    dialog?.showModal();
    return () => { dialog?.close(); previous?.focus(); };
  }, []);
  return <dialog ref={ref} className="chain-confirm" aria-labelledby={id} onCancel={(event) => { event.preventDefault(); onCancel(); }}>
    <h3 id={id}>{title}</h3>
    <div className="chain-confirm-body">{children}</div>
    <div className="chain-actions">
      <button autoFocus className="btn ghost" type="button" onClick={onCancel}>{lang === 'zh' ? '返回检查' : 'Go back'}</button>
      <button className="btn fire" type="button" disabled={disabled} onClick={onConfirm}>{confirmLabel ?? (lang === 'zh' ? '确认并请求签名' : 'Confirm & request signature')}</button>
    </div>
  </dialog>;
}
