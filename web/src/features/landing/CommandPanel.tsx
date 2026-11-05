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
import { formatCompactToken, intFmt, pctFmt, shortAddr, toRawUnits, tokenNum, usdNum } from './utils';

interface Props {
  cfg: ProtocolConfig | null;
  stats: ProtocolStats | null;
  board: BoardView;
  secondsRemaining: number | null;
  me: MeResponse | null;
  wallet: LandingWallet;
  copy: LandingCopy;
  tab: 'buy' | 'stake';
  setTab: (tab: 'buy' | 'stake') => void;
  toast: (message: string) => void;
  onRefresh: () => void;
}

export function CommandPanel({ cfg, stats, board, secondsRemaining, me, wallet, copy, tab, setTab, toast, onRefresh }: Props) {
  const { lang } = useLang();
  const decimals = cfg?.token.decimals ?? 9;
  const price = usdNum(board.priceUsdE8);
  const target = usdNum(board.targetUsdE8);
  const mult = board.priceMultiplier; // D-28 档位由 API 提供（失败不升档）
  const tonUsd = usdNum(cfg?.tonUsdE8 ?? null);
  const liquidity = usdNum(stats?.liquidityUsdE8 ?? null);
  const roundId = board.roundId;
  const stakeOpen = board.state === 'STAKING_OPEN';
  const realWallet = wallet.connected && !wallet.demo;
  const riskVersion = cfg?.riskDisclosureVersion ?? 1;

  const [payTon, setPayTon] = useState('100');
  const [stakeAmount, setStakeAmount] = useState('50000');
  const [risk, setRisk] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [buyAdj, setBuyAdj] = useState({ ton: 0, fuse: 0 });

  useEffect(() => {
    setBuyAdj({ ton: 0, fuse: 0 });
  }, [wallet.address]);

  // ---- wallet display
  const tonBalance = wallet.tonBalance === null ? null : Number(String(wallet.tonBalance).replace(/,/g, ''));
  const fuseBalanceRaw = wallet.fuseBalance;
  const fuseBalance = tokenNum(fuseBalanceRaw, decimals);
  const tonBalanceShown = tonBalance === null ? null : Math.max(0, tonBalance + buyAdj.ton);
  const fuseBalanceShown = fuseBalance + buyAdj.fuse;
  const myPosition = me && roundId !== null ? me.stakes.find((s) => s.roundId === roundId) ?? null : null;
  const myStake = myPosition ? tokenNum(myPosition.amountRaw, decimals) : 0;
  const totalStake = tokenNum(board.totalStakeRaw, decimals);
  const rewardBudget = tokenNum(board.rewardBudgetRaw, decimals);

  // ---- buy quote
  const ton = Math.max(0, Number(payTon) || 0);
  const usd = ton * (tonUsd ?? 0);
  const fee = usd * 0.003;
  const impact = liquidity && liquidity > 0 ? (usd / (2 * liquidity)) * 0.5 : 0;
  const quotePrice = price !== null ? price * (1 + impact) : null;
  const fuseOut = quotePrice !== null && quotePrice > 0 ? (usd - fee) / quotePrice : null;

  const onBuy = () => {
    if (!wallet.connected) {
      toast(copy.cmd.toastNeedWallet);
      return;
    }
    if (ton <= 0) {
      toast(copy.cmd.toastEnterAmount);
      return;
    }
    if (!wallet.demo) {
      toast(copy.cmd.toastBuyContract);
      return;
    }
    if (tonBalance !== null && ton > tonBalance) {
      toast(copy.cmd.toastInsufficientTon);
      return;
    }
    if (fuseOut === null) {
      toast(copy.cmd.toastEnterAmount);
      return;
    }
    setBuyAdj((prev) => ({ ton: prev.ton - ton, fuse: prev.fuse + fuseOut }));
    toast(fill(copy.cmd.toastBuyDemo, { amount: intFmt(fuseOut) }));
  };

  // ---- stake calc
  const stakeVal = Math.max(0, Number(stakeAmount) || 0);
  const estReward = rewardBudget * stakeVal / (totalStake + stakeVal || 1);
  const share = stakeVal / (totalStake + stakeVal || 1);
  const amountRaw = toRawUnits(stakeAmount, decimals);
  const payload = 'round_id=R' + pad2(roundId ?? 0) + ' · amount_raw=' + amountRaw + ' · risk_disclosure_version=' + riskVersion + ' · accept_full_principal_burn=' + (risk ? 'true' : 'false') + ' · address=' + (wallet.address ?? '—');

  const stakeDisabled = !stakeOpen || !wallet.connected || realWallet || stakeVal <= 0 || !risk || submitting || roundId === null;
  const stakeLabel = submitting
    ? copy.cmd.btnSubmitting
    : !stakeOpen
      ? copy.cmd.btnNotOpen
      : realWallet
        ? copy.cmd.btnContractPending
        : !wallet.connected
          ? copy.cmd.btnConnectFirst
          : !risk
            ? copy.cmd.btnRiskFirst
            : copy.cmd.btnConfirm;

  const onStake = async () => {
    if (!stakeOpen) {
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
    if (stakeVal <= 0) {
      toast(copy.cmd.toastEnterAmount);
      return;
    }
    if (!risk) {
      toast(copy.cmd.toastRisk);
      return;
    }
    if (fuseBalanceRaw !== null && stakeVal > fuseBalance) {
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
        acceptFullPrincipalBurn: true,
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
      setPayTon(String(tonBalance === null ? 0 : Math.floor(tonBalance)));
      return;
    }
    setPayTon(value);
  };

  return (
    <aside className="hud cmd" id="cmd" aria-label={copy.cmd.title}>
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
            <div className="v">{fuseBalanceRaw === null && buyAdj.fuse === 0 ? '—' : intFmt(fuseBalanceShown)}</div>
          </div>
          <div>
            <span className="lbl">{copy.cmd.staked}</span>
            <div className="v">{intFmt(myStake)}</div>
          </div>
        </div>
      ) : null}

      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'buy'} aria-controls="paneBuy" onClick={() => setTab('buy')}>
          {copy.cmd.tabBuy}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'stake'} aria-controls="paneStake" onClick={() => setTab('stake')}>
          {copy.cmd.tabStake}
          <span className={'tdot' + (stakeOpen ? '' : ' off')} />
        </button>
      </div>

      {tab === 'buy' ? (
        <div id="paneBuy" role="tabpanel">
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
              <span>TON</span>
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
            <span className="lbl">{copy.cmd.receive}</span>
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
              <dt>{copy.cmd.avgPrice}</dt>
              <dd>{quotePrice === null ? '—' : formatUsdE8(String(Math.round(quotePrice * 1e8)))}</dd>
            </div>
            <div>
              <dt>{copy.cmd.impact}</dt>
              <dd>{pctFmt(impact, 3)}</dd>
            </div>
            <div>
              <dt>{copy.cmd.fee}</dt>
              <dd>{'$' + fee.toFixed(2)}</dd>
            </div>
            <div>
              <dt>{copy.cmd.minReceive}</dt>
              <dd>{fuseOut === null ? '—' : intFmt(fuseOut * 0.99) + ' A9'}</dd>
            </div>
          </dl>
          <button className="btn fire full" type="button" onClick={onBuy}>
            {copy.cmd.buyBtn}
          </button>
          <p className="note">{copy.cmd.buyNote}</p>
        </div>
      ) : (
        <div id="paneStake" role="tabpanel">
          {!stakeOpen ? (
            <div className="lock">
              {board.phase === 'done' ? (
                <>
                  <h3>{fill(copy.cmd.lockDoneTitle, { round: pad2(roundId ?? 0) })}</h3>
                  <p className="sub">
                    {board.result === 'win' ? copy.cmd.lockDoneWin : copy.cmd.lockDoneLose}
                  </p>
                  <Link className="btn fire" to="/me">
                    {copy.common.goMe}
                  </Link>
                </>
              ) : (
                <>
                  <h3>{fill(copy.cmd.lockClosedTitle, { round: pad2(roundId ?? 0) })}</h3>
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
                        <dd>{intFmt(myStake)} A9</dd>
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
                  <button className="btn" type="button" onClick={() => setTab('buy')}>
                    {copy.cmd.goBuy}
                  </button>
                </>
              )}
            </div>
          ) : (
            <>
              <dl className="kv">
                <div>
                  <dt>{copy.cmd.stakeRound + ' R' + pad2(roundId ?? 0)}</dt>
                  <dd>
                    {target === null ? '—' : formatUsdE8(board.targetUsdE8) + ' · ' + (mult === null ? '2^n' : String(mult)) + '×P0'}
                  </dd>
                </div>
                <div>
                  <dt>{copy.cmd.stakeDeadline}</dt>
                  <dd>{clockText(secondsRemaining)}</dd>
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
                  <dd className="ok">{intFmt(estReward) + ' A9'}</dd>
                </div>
                <div>
                  <dt>{copy.cmd.share}</dt>
                  <dd>{(share * 100).toFixed(3) + '%'}</dd>
                </div>
              </dl>
              <label className="risk" htmlFor="riskOk">
                <input id="riskOk" type="checkbox" checked={risk} onChange={(event) => setRisk(event.target.checked)} />
                <span>{copy.cmd.riskText}</span>
              </label>
              <code className="payload">{payload}</code>
              <button className="btn fire full" type="button" disabled={stakeDisabled} onClick={onStake}>
                {stakeLabel}
              </button>
            </>
          )}
        </div>
      )}
    </aside>
  );
}
