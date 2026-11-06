import { useEffect, useState } from 'react';
import type { MeResponse, ProtocolConfig, ProtocolStats } from '@shared/types';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { compactUsd, formatUsdE8, pad2 } from '../../lib/format';
import type { BoardView } from './derive';
import { clockText } from './derive';
import { useLang } from '../../lib/lang';
import { fill, type LandingCopy } from './landing.i18n';
import type { LandingWallet } from './wallet';
import { formatCompactToken, intFmt, shortAddr, toRawUnits, tokenNum, usdNum } from './utils';
import { BUY_ENTRY_OPEN } from './flags';
import { LiveCountdown } from './LiveCountdown';

interface Props {
  cfg: ProtocolConfig | null;
  stats: ProtocolStats | null;
  dataReady: boolean;
  board: BoardView;
  clockTargetMs: number | null;
  nextStakeTargetMs: number | null;
  me: MeResponse | null;
  wallet: LandingWallet;
  copy: LandingCopy;
  tab: 'buy' | 'stake';
  setTab: (tab: 'buy' | 'stake') => void;
  toast: (message: string) => void;
  onRefresh: () => void;
}

export function CommandPanel({ cfg, board, dataReady, clockTargetMs, nextStakeTargetMs, me, wallet, copy, tab, setTab, toast, onRefresh }: Props) {
  const { lang } = useLang();
  const decimals = cfg?.token.decimals ?? 9;
  const price = usdNum(board.priceUsdE8);
  const target = usdNum(board.targetUsdE8);
  const mult = board.priceMultiplier; // D-28 档位由 API 提供（失败不升档）
  const tonUsd = usdNum(cfg?.tonUsdE8 ?? null);
  const roundId = board.roundId;
  const stakeOpen = board.state === 'STAKING_OPEN';
  const realWallet = wallet.connected && !wallet.demo;
  const riskVersion = cfg?.riskDisclosureVersion ?? 1;

  const [payTon, setPayTon] = useState('100');
  const [stakeAmount, setStakeAmount] = useState('50000');
  // Two separate acknowledgements: (1) principal may go to zero, (2) failure burns the round's
  // reward budget and all staked principal. Neither is pre-checked; both are required to stake.
  const [risk, setRisk] = useState(false);
  const [burnAck, setBurnAck] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => { setRisk(false); setBurnAck(false); }, [wallet.address, roundId, riskVersion]);
  const onTabKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!BUY_ENTRY_OPEN || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'buy' : event.key === 'End' ? 'stake' : tab === 'buy' ? 'stake' : 'buy';
    setTab(next);
    document.getElementById(`tab-${next}`)?.focus();
  };

  // ---- wallet display
  const tonBalance = wallet.tonBalance === null ? null : Number(String(wallet.tonBalance).replace(/,/g, ''));
  const fuseBalanceRaw = wallet.fuseBalance;
  const fuseBalance = tokenNum(fuseBalanceRaw, decimals);
  const tonBalanceShown = tonBalance === null ? null : Math.max(0, tonBalance);
  const fuseBalanceShown = fuseBalance;
  const myPosition = me && roundId !== null ? me.stakes.find((s) => s.roundId === roundId) ?? null : null;
  const myStake = myPosition ? tokenNum(myPosition.amountRaw, decimals) : 0;
  // Reference conversion only: no router quote or exchange execution is available.
  const ton = Math.max(0, Number.isFinite(Number(payTon)) ? Number(payTon) : 0);
  const usd = ton * (tonUsd ?? 0);
  const quotePrice = price;
  const fuseOut = quotePrice !== null && quotePrice > 0 ? usd / quotePrice : null;

  // ---- stake calc
  const stakeVal = Math.max(0, Number(stakeAmount) || 0);
  const amountRaw = toRawUnits(stakeAmount, decimals);

  const stakeDisabled = !dataReady || !stakeOpen || !wallet.connected || realWallet || !Number.isFinite(stakeVal) || stakeVal < 10000 || amountRaw === '0' || stakeVal + myStake > 20000000 || fuseBalanceRaw === null || stakeVal > fuseBalance || !risk || !burnAck || submitting || roundId === null;
  const stakeLabel = submitting
    ? copy.cmd.btnSubmitting
    : !stakeOpen
      ? copy.cmd.btnNotOpen
      : realWallet
        ? copy.cmd.btnContractPending
        : !wallet.connected
          ? copy.cmd.btnConnectFirst
          : !risk || !burnAck
            ? copy.cmd.btnRiskFirst
            : copy.cmd.btnConfirm;

  const onStake = async () => {
    if (!dataReady || !stakeOpen) {
      toast(copy.cmd.toastNotOpen);
      return;
    }
    if (!wallet.connected || !wallet.address) {
      toast(copy.cmd.toastNeedWallet);
      return;
    }
    if (realWallet) {
      toast(copy.cmd.toastContractPending);
      return;
    }
    if (!Number.isFinite(stakeVal) || stakeVal < 10000 || amountRaw === '0' || stakeVal + myStake > 20000000) {
      toast(copy.cmd.toastEnterAmount);
      return;
    }
    if (!risk || !burnAck) {
      toast(copy.cmd.toastRisk);
      return;
    }
    if (fuseBalanceRaw === null || stakeVal > fuseBalance) {
      toast(copy.cmd.toastInsufficientFuse);
      return;
    }
    if (roundId === null) return;
    setSubmitting(true);
    try {
      await api.stake({
        address: wallet.address,
        roundId,
        amountRaw,
        riskDisclosureVersion: riskVersion,
        acceptFullPrincipalBurn: burnAck,
      });
      setRisk(false);
      setStakeAmount('');
      toast(fill(copy.cmd.toastStakeOk, { amount: intFmt(stakeVal), version: riskVersion }));
      onRefresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast(fill(copy.cmd.toastStakeFail, { msg: message }));
    } finally {
      setSubmitting(false);
    }
  };

  const onChip = (ratio: number) => {
    if (!wallet.connected) {
      toast(copy.cmd.toastNeedWallet);
      return;
    }
    if (fuseBalance <= 0) {
      toast(copy.cmd.toastInsufficientFuse);
      return;
    }
    setStakeAmount(String(Math.floor(fuseBalance * ratio)));
  };

  const onPayChip = (value: string) => {
    if (value === 'max') {
      if (!wallet.connected) {
        toast(copy.cmd.toastNeedWallet);
        return;
      }
      setPayTon(String(tonBalance === null ? 0 : Math.max(0, Math.floor((tonBalance - 0.1) * 100) / 100)));
      return;
    }
    setPayTon(value);
  };

  return (
    <aside className="hud cmd" id="cmd" tabIndex={-1} aria-label={copy.cmd.title}>
      <div className="cmd-head">
        <span className="lbl">{copy.cmd.title}</span>
        <button
          className="btn ghost sm"
          type="button"
          onClick={() => (wallet.connected ? wallet.disconnect() : wallet.connect())}
          disabled={wallet.connecting}
        >
          {wallet.connected ? copy.cmd.disconnect : wallet.connecting ? copy.cmd.btnSubmitting : copy.cmd.connect}
        </button>
      </div>

      {wallet.connected ? (
        <div className="wal">
          <div className="addr">
            {shortAddr(wallet.address)} · {wallet.demo ? copy.cmd.walletDemo : copy.cmd.walletReal}
          </div>
          <div>
            <span className="lbl">{copy.cmd.ton}</span>
            <div className="v">{tonBalanceShown === null ? '—' : intFmt(tonBalanceShown)}</div>
          </div>
          <div>
            <span className="lbl">{copy.cmd.fuse}</span>
            <div className="v">{fuseBalanceRaw === null ? '—' : intFmt(fuseBalanceShown)}</div>
          </div>
          <div>
            <span className="lbl">{copy.cmd.staked}</span>
            <div className="v">{me ? intFmt(myStake) : '—'}</div>
          </div>
        </div>
      ) : null}

      {BUY_ENTRY_OPEN ? (
        <div className="tabs" role="tablist" aria-label={copy.cmd.title} onKeyDown={onTabKey}>
          <button type="button" id="tab-buy" role="tab" tabIndex={tab === 'buy' ? 0 : -1} aria-selected={tab === 'buy'} aria-controls="paneBuy" onClick={() => setTab('buy')}>
            {copy.cmd.tabBuy}
          </button>
          <button type="button" id="tab-stake" role="tab" tabIndex={tab === 'stake' ? 0 : -1} aria-selected={tab === 'stake'} aria-controls="paneStake" onClick={() => setTab('stake')}>
            {copy.cmd.tabStake}
            <span className={'tdot' + (stakeOpen ? '' : ' off')} />
          </button>
        </div>
      ) : null}

      {tab === 'buy' && BUY_ENTRY_OPEN ? (
        <div id="paneBuy" role="tabpanel" aria-labelledby="tab-buy" tabIndex={0}>
          <label className="f" htmlFor="payTon">
            <span className="lbl">{copy.cmd.payTon}</span>
            <div className="inp">
              <input
                id="payTon"
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                value={payTon}
                onChange={(event) => setPayTon(event.target.value)}
              />
              <span>GRAM</span>
            </div>
          </label>
          <div className="chips">
            {['50', '100', '500', 'max'].map((value) => (
              <button type="button" key={value} onClick={() => onPayChip(value)}>
                {value === 'max' ? copy.cmd.max : value}
              </button>
            ))}
          </div>
          <div className="recv">
            <span className="lbl">{lang === 'zh' ? '参考换算数量' : 'Reference amount'}</span>
            <div className="mono">{fuseOut === null ? '—' : intFmt(fuseOut) + ' A9'}</div>
            <div className="sub">
              {fill(copy.cmd.receiveSub, {
                usd: compactUsd(usd),
                rate: tonUsd === null ? '—' : tonUsd.toFixed(2),
              })}
            </div>
          </div>
          <dl className="kv">
            <div>
              <dt>{lang === 'zh' ? '参考价格' : 'Reference price'}</dt>
              <dd>{quotePrice === null ? '—' : formatUsdE8(String(Math.round(quotePrice * 1e8)))}</dd>
            </div>
            <div>
              <dt>{copy.cmd.impact}</dt>
              <dd>{lang === 'zh' ? '未报价' : 'Not quoted'}</dd>
            </div>
            <div>
              <dt>{lang === 'zh' ? '交易费 / Gas' : 'Trading fee / gas'}</dt>
              <dd>—</dd>
            </div>
            <div>
              <dt>{copy.cmd.minReceive}</dt>
              <dd>—</dd>
            </div>
          </dl>
          <button className="btn full" type="button" disabled>
            {lang === 'zh' ? '交易入口尚未开放' : 'Trading is not open'}
          </button>
          <p className="note">{copy.cmd.buyNote}</p>
        </div>
      ) : (
        <div id="paneStake" role="tabpanel" aria-labelledby="tab-stake" tabIndex={0}>
          <div className="stake-status">
          {!stakeOpen ? (
            <div className="lock">
              {board.phase === 'done' ? (
                <>
                  <h3>{fill(copy.cmd.lockDoneTitle, { round: pad2(roundId ?? 0) })}</h3>
                  <p className="sub">
                    {board.result === 'win' ? copy.cmd.lockDoneWin : board.result === 'abort' ? copy.board.resultAbortBody : copy.cmd.lockDoneLose}
                  </p>
                  <Link className="btn fire" to="/me">
                    {copy.common.goMe}
                  </Link>
                </>
              ) : (
                <>
                  <h3>{board.phase === 'settling' ? (lang === 'zh' ? '结算处理中' : 'Settlement in progress') : board.phase === 'unopened' ? copy.board.phaseUnopened : fill(copy.cmd.lockClosedTitle, { round: pad2(roundId ?? 0) })}</h3>
                  <p className="sub">
                    {fill(copy.cmd.lockClosedBody, {
                      stakers: intFmt(board.stakerCount),
                      total: formatCompactToken(board.totalStakeRaw, decimals, lang),
                    })}
                  </p>
                  {wallet.connected && myStake > 0 ? (
                    <dl className="kv">
                      <div>
                        <dt>{copy.cmd.lockClosedMine}</dt>
                        <dd>{me ? intFmt(myStake) : '—'} A9</dd>
                      </div>
                    </dl>
                  ) : null}
                  {roundId !== null && roundId < board.cfgRoundCount ? (
                    <p className="sub">
                      {fill(copy.cmd.lockNext, {
                        next: pad2(roundId + 1),
                        current: pad2(roundId),
                      })}
                    </p>
                  ) : null}
                  {nextStakeTargetMs !== null ? (
                    <dl className="kv">
                      <div>
                        <dt>{lang === 'zh' ? '下一轮报名开放' : 'Next staking opens'}</dt>
                        <dd><LiveCountdown targetMs={nextStakeTargetMs} format={clockText} /></dd>
                      </div>
                    </dl>
                  ) : null}
                  <Link className="btn ghost" to="/rules">{lang === 'zh' ? '查看规则与风险' : 'Rules and risk'}</Link>
                  {BUY_ENTRY_OPEN ? (
                    <button className="btn" type="button" onClick={() => setTab('buy')}>
                      {copy.cmd.goBuy}
                    </button>
                  ) : null}
                </>
              )}
            </div>
          ) : (
              <dl className="kv">
                <div>
                  <dt>{copy.cmd.stakeRound + ' R' + pad2(roundId ?? 0)}</dt>
                  <dd>
                    {target === null ? '—' : formatUsdE8(board.targetUsdE8) + ' · ' + (mult === null ? '2^n' : String(mult)) + '×P0'}
                  </dd>
                </div>
                <div>
                  <dt>{copy.cmd.stakeDeadline}</dt>
                  <dd>{clockTargetMs === null ? clockText(null) : <LiveCountdown targetMs={clockTargetMs} format={clockText} />}</dd>
                </div>
                <div>
                  <dt>{copy.cmd.stakeTotal}</dt>
                  <dd>{formatCompactToken(board.totalStakeRaw, decimals, lang) + ' A9'}</dd>
                </div>
                <div>
                  <dt>{copy.cmd.stakeAddrs}</dt>
                  <dd>{intFmt(board.stakerCount)}</dd>
                </div>
              </dl>
          )}
          </div>
          <fieldset className="stake-form" disabled={!stakeOpen}>
              <label className="f" htmlFor="stkAmt">
                <span className="lbl">{copy.cmd.stakeAmount}</span>
                <div className="inp">
                  <input
                    id="stkAmt"
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="any"
                    value={stakeAmount}
                    onChange={(event) => setStakeAmount(event.target.value)}
                  />
                  <span>A9</span>
                </div>
              </label>
              <div className="chips">
                <button type="button" onClick={() => onChip(0.25)}>
                  25%
                </button>
                <button type="button" onClick={() => onChip(0.5)}>
                  50%
                </button>
                <button type="button" onClick={() => onChip(1)}>
                  {copy.cmd.stakeAll}
                </button>
              </div>
              <dl className="kv danger">
                <div>
                  <dt>{copy.cmd.lossMax}</dt>
                  <dd className="bad">{intFmt(stakeVal) + ' ' + copy.common.lossFull}</dd>
                </div>
                <div>
                  <dt>{copy.cmd.rewardEst}</dt>
                  <dd className="ok">{lang === 'zh' ? '待权重与结算确认' : 'Pending weights and settlement'}</dd>
                </div>
                <div>
                  <dt>{copy.cmd.share}</dt>
                  <dd>{lang === 'zh' ? '本金 × 连续参与加成 + 邀请权重' : 'Stake × streak multiplier + referral weight'}</dd>
                </div>
              </dl>
              <label className="risk" htmlFor="riskOk">
                <input id="riskOk" type="checkbox" checked={risk} onChange={(event) => setRisk(event.target.checked)} />
                <span>{fill(copy.cmd.riskText, { need: board.need, total: board.candleCount })}</span>
              </label>
              <label className="risk" htmlFor="burnOk">
                <input id="burnOk" type="checkbox" checked={burnAck} onChange={(event) => setBurnAck(event.target.checked)} />
                <span>{copy.cmd.burnText}</span>
              </label>
              <p className="note">{lang === 'zh' ? '单笔最低 10,000 A9；单地址本轮最多 20,000,000 A9。成功奖励按最终权重分配，早领仅得 50%，其余进入解锁池。' : 'Minimum 10,000 A9; up to 20,000,000 A9 per address per round. Success rewards use final participation weights. Early claims pay 50%; the remainder enters the unlock pool.'}</p>
              {!dataReady ? <p className="note" role="status">{lang === 'zh' ? '等待数据恢复后可提交' : 'Submission waits for fresh data'}</p> : null}
              {stakeVal > fuseBalance && wallet.connected ? <p className="note bad">{copy.cmd.toastInsufficientFuse}</p> : null}
              {realWallet ? (
                <p className="note" role="note">
                  {lang === "zh" ? "真实钱包的质押请在「我的质押」完成，首页暂不提交链上交易。" : "Stake with a real wallet on My stake. The homepage does not submit on-chain transactions yet."}{" "}
                  <Link to="/me">{lang === "zh" ? "前往我的质押" : "Go to My stake"}</Link>
                </p>
              ) : null}
              <button className="btn fire full" type="button" disabled={stakeDisabled} onClick={onStake}>
                {stakeLabel}
              </button>
          </fieldset>
        </div>
      )}
    </aside>
  );
}
