import type { ChainTxState } from './useChainTx';
import { CHAIN_I18N } from './i18n';
import { shortenAddress } from './address';

export interface TxStatusProps {
  state: ChainTxState;
  lang: 'zh' | 'en';
  onRetry?: () => void;
  onRecheck?: () => void;
  onDismiss?: () => void;
}

/** 交易状态行：阶段、交易哈希链接、错误提示、重试/关闭。 */
export function TxStatusView({ state, lang, onRetry, onRecheck, onDismiss }: TxStatusProps) {
  const d = CHAIN_I18N[lang];
  if (state.phase === 'idle' && !state.error && !state.result) return null;

  const tone =
    state.phase === 'confirmed'
      ? 'ok'
      : state.phase === 'rejected' || state.phase === 'failed'
        ? 'bad'
        : 'pending';
  const phaseText = d.phases[state.phase] ?? state.phase;
  const result = state.result;
  const errorText = state.error ? d.errors[state.error.code] ?? state.error.message : null;
  const canRetry = state.phase === 'rejected' || state.phase === 'failed';

  return (
    <div className={'chain-tx ' + tone} role="status" aria-live="polite">
      <div className="chain-tx-head">
        <span className="chain-dot" aria-hidden="true" />
        <b>{phaseText}</b>
        {result?.explorerUrl ? (
          <a className="chain-hash" href={result.explorerUrl} target="_blank" rel="noreferrer">
            {d.txHash} {shortenAddress(result.hash, 8, 8)}
          </a>
        ) : result ? <span className="chain-hash">{d.txHash} {shortenAddress(result.hash, 8, 8)}</span> : null}
      </div>
      {result ? (
        <p className="chain-tx-note">{result.stage === 'contract' ? d.confirmedByContract : d.confirmedByWallet}</p>
      ) : null}
      {errorText ? (
        <p className="chain-err">
          {errorText}
          {state.error?.detail ? <em> · {state.error.detail}</em> : null}
        </p>
      ) : null}
      {state.phase === 'pending' ? <p className="chain-tx-note">{lang === 'zh' ? '尚未确认合约执行结果。重查不会发送交易；关闭只停止跟踪，不会撤销交易。再次操作前请核对原交易，避免重复发送。' : 'Contract execution is not confirmed. Checking sends no transaction; dismissing only stops tracking. Verify the original transaction before sending again.'}</p> : null}
      <div className="chain-tx-actions">
        {canRetry && onRetry ? (
          <button className="btn ghost sm" type="button" onClick={onRetry}>
            {d.txRetry}
          </button>
        ) : null}
        {state.phase === 'pending' && onRecheck ? <button className="btn ghost sm" type="button" onClick={onRecheck}>{lang === 'zh' ? '重新检查原交易' : 'Check original transaction'}</button> : null}
        {onDismiss && (state.phase === 'confirmed' || state.phase === 'failed' || state.phase === 'rejected' || state.phase === 'pending') ? (
          <button className="btn ghost sm" type="button" onClick={onDismiss}>
            {d.txDismiss}
          </button>
        ) : null}
      </div>
    </div>
  );
}
