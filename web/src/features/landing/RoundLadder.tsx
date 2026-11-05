import type { ProtocolConfig, RoundSummary } from '@shared/types';
import { formatUsdE8, pad2 } from '../../lib/format';
import { ladderLetter, type LadderLetter } from './derive';
import { IcoDot, IcoNo, IcoOk } from './icons';
import { useLang } from '../../lib/lang';
import { fill, type LandingCopy } from './landing.i18n';
import { formatCompactToken, usdNum } from './utils';

interface Props {
  cfg: ProtocolConfig | null;
  rounds: RoundSummary[];
  copy: LandingCopy;
}

export function RoundLadder({ cfg, rounds, copy }: Props) {
  const { lang } = useLang();
  const decimals = cfg?.token.decimals ?? 9;
  const p0 = cfg ? '$' + (usdNum(cfg.p0UsdE8) ?? 0).toFixed(5) : copy.common.dash;
  const roundCount = cfg?.roundCount ?? 10;
  const total = cfg ? roundCount : 0;

  const tagOf = (letter: LadderLetter) => {
    switch (letter) {
      case 'P':
        return { text: lang === 'zh' ? '结算中' : 'Settling', icon: <IcoDot /> };
      case 'A':
        return { text: lang === 'zh' ? '技术中止' : 'Technical abort', icon: <IcoNo /> };
      case 'S':
        return { text: copy.ladder.tagS, icon: <IcoOk /> };
      case 'F':
        return { text: copy.ladder.tagF, icon: <IcoNo /> };
      case 'O':
        return { text: copy.ladder.tagO, icon: <IcoDot /> };
      case 'K':
        return { text: copy.ladder.tagK, icon: <IcoDot /> };
      default:
        return { text: copy.ladder.tagU, icon: null };
    }
  };

  const outcomeOf = (letter: LadderLetter, amount: string) => {
    const value = formatCompactToken(amount, decimals, lang);
    if (letter === 'A') return lang === 'zh' ? '本金不销毁' : 'Principal not burned';
    if (letter === 'P') return value + ' ' + copy.ladder.outPending;
    if (letter === 'S') return value + ' ' + (lang === 'zh' ? '已分配 · 有领取规则' : 'Allocated · claim rules apply');
    if (letter === 'F') return value + ' ' + copy.ladder.outBurned;
    if (letter === 'O' || letter === 'K') return value + ' ' + copy.ladder.outPending;
    return value + ' ' + copy.ladder.outLocked;
  };

  return (
    <section className="sec" id="ladder">
      <div className="wrap">
        <div className="sec-h">
          <span className="lbl">{copy.ladder.lbl}</span>
          <h2>{copy.ladder.title}</h2>
          <p>{fill(copy.ladder.intro, { p0 })}</p>
        </div>
        <div className="ladder" id="ladderBody">
          {Array.from({ length: total }).map((_, index) => {
            const roundId = index + 1;
            const round = rounds.find((item) => item.roundId === roundId) ?? null;
            const letter = ladderLetter(round?.state);
            const tag = tagOf(letter);
            // D-28：目标价与档位倍数一律读 API（tier = 1 + 已成功轮数，失败不升档）
            const target = round?.targetPriceUsdE8 ?? null;
            const rewardRaw = round?.rewardBudgetRaw ?? cfg?.roundRewardRaw ?? '0';
            const mult = round?.priceMultiplier ?? null;
            return (
              <div className={'lrow ' + letter} key={roundId}>
                <span className="lr">{'R' + pad2(roundId)}</span>
                <span className="lt">
                  {tag.icon}
                  {tag.text}
                </span>
                <span className="lp">{target === null ? copy.common.dash : formatUsdE8(target)}</span>
                <span className="lm">{mult === null ? copy.common.dash : '×' + mult}</span>
                <span className="lbar">
                  <i style={{ width: Math.min(100, roundId / roundCount * 100) + '%' }} />
                </span>
                <span className="lo">{outcomeOf(letter, rewardRaw)}</span>
              </div>
            );
          })}
        </div>
        <p className="note">{copy.ladder.note}</p>
      </div>
    </section>
  );
}
