import { useDict } from '../../lib/lang';

/** Replace {name} placeholders in a copy template. */
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = vars[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

export type LandingCopy = {
  common: {
    dash: string;
    loading: string;
    apiDown: string;
    retry: string;
    goMe: string;
    goLeaderboard: string;
    lossFull: string;
  };
  tape: {
    price: string;
    target: string;
    lit: string;
    miss: string;
    stake: string;
    burned: string;
    volume: string;
    touched: string;
    untouched: string;
    buy: string;
    sell: string;
  };
  hero: {
    badge: string;
    pill: string;
    title: string;
    titleEm: string;
    lede: string;
    ctaStake: string;
    ctaBuy: string;
    ctaRules: string;
    totalSupply: string;
    totalSupplyValue: string;
    totalSupplyUnit: string;
    unlockRounds: string;
    unlockRoundsValue: string;
    unlockRoundsUnit: string;
    roundTarget: string;
    roundTargetValue: string;
    roundTargetUnit: string;
  };
  board: {
    currentBattle: string;
    ofRounds: string;
    windowLeft: string;
    stakeDeadline: string;
    observeLeft: string;
    observeTotal: string;
    roundLabel: string;
    settled: string;
    closed: string;
    phaseStake: string;
    phaseObserve: string;
    phaseWin: string;
    phaseLose: string;
    phasePaused: string;
    phaseUnopened: string;
    cellHit: string;
    cellMiss: string;
    cellLive: string;
    cellPending: string;
    oracleOnline: string;
    oraclePaused: string;
    validSources: string;
    coverage: string;
    configVersion: string;
    frozen: string;
    pending: string;
    demoAccel: string;
    price: string;
    targetLabel: string;
    targetOf: string;
    twap: string;
    touchedTarget: string;
    untouchedTarget: string;
    needRise: string;
    beforeObserve: string;
    aboveTarget: string;
    belowTarget: string;
    twapTentativeHit: string;
    twapTentativeMiss: string;
    twapProgress: string;
    twapLastClosed: string;
    twapAfterStart: string;
    litNeed: string;
    missLine: string;
    remainCandles: string;
    unitCandle: string;
    hitSubWaiting: string;
    hitSubLocked: string;
    hitSubNeed: string;
    missSubHint: string;
    missSubTriggered: string;
    missSubOneMore: string;
    missSubLeft: string;
    remSubStake: string;
    remSubLive: string;
    remSubNoNeed: string;
    remSubNeed: string;
    verdictStake: string;
    verdictStakeSub: string;
    verdictWin: string;
    verdictLose: string;
    verdictDoneSub: string;
    verdictLocked: string;
    verdictLockedSub: string;
    verdictLost: string;
    verdictLostSub: string;
    verdictOpen: string;
    verdictOpenSub: string;
    mine: string;
    myStake: string;
    myReward: string;
    myLoss: string;
    resultWinTitle: string;
    resultWinBody: string;
    resultWinMine: string;
    resultLoseTitle: string;
    resultLoseBody: string;
    resultLoseMine: string;
    resultLoseNext: string;
    claim: string;
    resultAbortTitle: string;
    resultAbortBody: string;
    chartAria: string;
    chartStakeNote: string;
    chartEmpty: string;
    chartWaiting: string;
    tipAbove: string;
    tipBelow: string;
    tipCandle: string;
    targetTag: string;
    waitingRound: string;
  };
  cmd: {
    title: string;
    connect: string;
    disconnect: string;
    walletEmpty: string;
    walletDemo: string;
    walletReal: string;
    balanceUnknown: string;
    staked: string;
    ton: string;
    fuse: string;
    tabBuy: string;
    tabStake: string;
    payTon: string;
    max: string;
    receive: string;
    receiveSub: string;
    avgPrice: string;
    impact: string;
    fee: string;
    minReceive: string;
    buyBtn: string;
    buyNote: string;
    stakeRound: string;
    stakeDeadline: string;
    stakeTotal: string;
    stakeAddrs: string;
    stakeAmount: string;
    stakeAll: string;
    lossMax: string;
    rewardEst: string;
    share: string;
    riskText: string;
    payloadLabel: string;
    btnRiskFirst: string;
    btnConfirm: string;
    btnConnectFirst: string;
    btnNotOpen: string;
    btnSubmitting: string;
    btnContractPending: string;
    lockClosedTitle: string;
    lockClosedBody: string;
    lockClosedMine: string;
    lockNext: string;
    goBuy: string;
    lockDoneTitle: string;
    lockDoneWin: string;
    lockDoneLose: string;
    toastNeedWallet: string;
    toastEnterAmount: string;
    toastInsufficientTon: string;
    toastInsufficientFuse: string;
    toastRisk: string;
    toastNotOpen: string;
    toastBuyDemo: string;
    toastBuyContract: string;
    toastStakeOk: string;
    toastStakeFail: string;
    toastClaimOk: string;
    toastClaimNone: string;
    toastContractPending: string;
    toastWalletError: string;
  };
  flow: {
    lbl: string;
    title: string;
    intro: string;
    tradesTitle: string;
    time: string;
    side: string;
    amount: string;
    price: string;
    value: string;
    bookTitle: string;
    internal: string;
    statsTitle: string;
    live: string;
    empty: string;
    tagMe: string;
    tagBig: string;
    buy: string;
    sell: string;
    s24h: string;
    liquidity: string;
    supply: string;
    burned: string;
    staked: string;
    stakers: string;
    reward: string;
    ratio: string;
    bookTarget: string;
  };
  ladder: {
    lbl: string;
    title: string;
    intro: string;
    p0: string;
    note: string;
    tagS: string;
    tagF: string;
    tagO: string;
    tagK: string;
    tagU: string;
    outClaim: string;
    outBurned: string;
    outPending: string;
    outLocked: string;
    outAbort: string;
  };
  rules: {
    lbl: string;
    title: string;
    intro: string;
    steps: { n: string; title: string; body: string; key: string }[];
    sandLbl: string;
    sandTitle: string;
    sandIntro: string;
    sandCellsTitle: string;
    sandCount: string;
    presets: { all: string; eight: string; seven: string; none: string };
    gaugeZero: string;
    gaugePass: string;
    sandStake: string;
    outLbl: string;
    outWinTitle: string;
    outWinBody: string;
    outWinPrincipal: string;
    outWinReward: string;
    outWinTotal: string;
    outLoseTitle: string;
    outLoseBody: string;
    outLoseExtra: string;
    outLoseYourLoss: string;
    outLoseRewardBurn: string;
    outLosePoolBurn: string;
    diff: { title: string; body: string }[];
    cellAriaOn: string;
    cellAriaOff: string;
  };
  supply: {
    lbl: string;
    title: string;
    intro: string;
    liq: string;
    team: string;
    mkt: string;
    aria: string;
    tableHead: { name: string; pct: string; amount: string };
    rows: { name: string; pct: string; amount: string }[];
  };
  risk: {
    lbl: string;
    version: string;
    items: { title: string; body: string }[];
  };
  mcta: {
    buy: string;
    stake: string;
  };
};

export const ZH: LandingCopy = {
  common: {
    dash: '—',
    loading: '加载中…',
    apiDown: '行情数据暂不可用，正在重试…',
    retry: '重试',
    goMe: '前往我的战况',
    goLeaderboard: '查看排行榜',
    lossFull: 'A9（100%）',
  },
  tape: {
    price: 'A9/USD',
    target: 'R{round} 目标',
    lit: '点亮',
    miss: '失守',
    stake: '本轮质押',
    burned: '已销毁',
    volume: '24H 成交',
    touched: '已触及',
    untouched: '未触及',
    buy: '买',
    sell: '卖',
  },
  hero: {
    badge: 'TON · 价格驱动型代币',
    pill: '10 轮目标价逐轮翻倍',
    title: '12 根 K 线点亮 8 根，',
    titleEm: '7 亿枚才会解锁。',
    lede: '每一轮设一个目标价，用户质押参战。48 小时内 12 根 4 小时 K 线，TWAP 触及目标价的至少 8 根，奖励开放认领、本金退还。差一根，本轮 7 亿奖励与全部质押本金一起销毁，本轮永久关闭。',
    ctaStake: '质押参战',
    ctaBuy: '买入 A9',
    ctaRules: '读懂规则',
    totalSupply: '总发行',
    totalSupplyValue: '100',
    totalSupplyUnit: '亿枚',
    unlockRounds: '解锁轮次',
    unlockRoundsValue: '10',
    unlockRoundsUnit: '轮 × 7 亿',
    roundTarget: '第 n 轮目标',
    roundTargetValue: 'P0×2',
    roundTargetUnit: 'n',
  },
  board: {
    currentBattle: '当前战役',
    ofRounds: '/ {total}',
    windowLeft: '窗口剩余',
    stakeDeadline: '报名截止',
    observeLeft: '观察窗口剩余',
    observeTotal: '/ 48:00',
    roundLabel: '本轮',
    settled: '已结算',
    closed: '已关闭',
    phaseStake: '报名中 · STAKING_OPEN',
    phaseObserve: '观察中 · OBSERVING',
    phaseWin: '成功 · SUCCEEDED',
    phaseLose: '永久关闭 · FAILED_PERMANENT',
    phasePaused: '考核暂停 · ORACLE_PAUSED',
    phaseUnopened: '未开启 · UNOPENED',
    cellHit: '点亮',
    cellMiss: '熄灭',
    cellLive: '进行中',
    cellPending: '待观察',
    oracleOnline: '预言机在线',
    oraclePaused: '预言机暂停',
    validSources: '有效来源 {valid} / {total}',
    coverage: '覆盖率 {pct}%',
    configVersion: '配置版本 {v}',
    frozen: '已冻结',
    pending: '待确认',
    demoAccel: '（演示加速）',
    price: '现价 A9 / USD',
    targetLabel: '本轮目标价',
    targetOf: '本轮目标价 · {mult}×P0',
    twap: '本根暂定 TWAP',
    touchedTarget: '已触及目标价',
    untouchedTarget: '未触及目标价',
    needRise: '未触及 · 还需上涨 {pct}',
    beforeObserve: '观察期起算前不计 K 线',
    aboveTarget: '高出目标 {pct}',
    belowTarget: '低于目标 {pct}',
    twapTentativeHit: '暂时达标 · 本根暂亮',
    twapTentativeMiss: '暂未达标 · 本根暂灭',
    twapProgress: '进度 {pct}%',
    twapLastClosed: '最后一根已收盘',
    twapAfterStart: '观察开始后统计',
    litNeed: '已点亮 / 需要',
    missLine: '已失守 / 判负线',
    remainCandles: '剩余 K 线',
    unitCandle: '根',
    hitSubWaiting: '观察开始后计数',
    hitSubLocked: '通过资格已锁定',
    hitSubNeed: '还差 {n} 根',
    missSubHint: '最多容错 4 根',
    missSubTriggered: '判负线已触发',
    missSubOneMore: '再失守 1 根即判负',
    missSubLeft: '还可失守 {n} 根',
    remSubStake: '共 12 根完整 K 线',
    remSubLive: '含进行中 1 根 · ',
    remSubNoNeed: '无需再亮',
    remSubNeed: '需再亮 ≥ {n} 根',
    verdictStake: '报名进行中，目标价 {target}',
    verdictStakeSub: '现价需要上涨 {pct} 才能触及。报名截止后，从下一个 UTC 4 小时整点起算 48 小时。',
    verdictWin: '本轮通过：{hits} / 12 根达标',
    verdictLose: '本轮失败：仅 {hits} / 12 根达标',
    verdictDoneSub: '12 根完整 K 线已收齐，链上结算完成。',
    verdictLocked: '通过资格已锁定',
    verdictLockedSub: '已有 {hits} 根达标，达标数不会减少。窗口走完后才能链上结算。',
    verdictLost: '已确定失败',
    verdictLostSub: '已失守 {miss} 根，剩余 K 线全亮也到不了 8 根。窗口走完后，奖励池与本轮全部质押将被销毁。',
    verdictOpen: '胜负未定',
    verdictOpenSub: '剩余 {remain} 根里还需再亮 {need} 根；再失守 {margin} 根即判负。',
    mine: '我的战位',
    myStake: '质押 {v} A9',
    myReward: '通过则预计奖励 {v}',
    myLoss: '失败则损失 {v}（100%）',
    resultWinTitle: '引信点燃，R{round} 解锁',
    resultWinBody: '12 根里 {hits} 根达标。{reward} A9 奖励开放认领，质押本金可全额取回。',
    resultWinMine: '你的质押 {stake} A9，预计可认领奖励 {reward} A9。',
    resultLoseTitle: '引信熄灭，R{round} 永久关闭',
    resultLoseBody: '仅 {hits} 根达标。已销毁 {reward} 奖励 + {stake} 质押本金，合计 {total} A9，总供应量随之减少。',
    resultLoseMine: '你的 {stake} A9 已销毁。',
    resultLoseNext: '下一轮目标价不回滚：R{next} 仍是 {mult}×P0 = {target}。',
    claim: '认领本金与奖励',
    resultAbortTitle: 'R{round} 技术中止',
    resultAbortBody: '本轮因预言机/合约技术原因中止，不销毁任何本金。恢复后将重新收满完整 12 根 K 线。',
    chartAria: '本轮价格走势与目标价对比图',
    chartStakeNote: '观察窗口尚未开始 · 以下为报名期价格走势',
    chartEmpty: '等待行情数据…',
    chartWaiting: '等待 K 线数据',
    tipAbove: '高于目标 {pct}',
    tipBelow: '低于目标 {pct}',
    tipCandle: 'K线 {n}',
    targetTag: '目标 {v}',
    waitingRound: '等待轮次数据…',
  },
  cmd: {
    title: '指挥台 · COMMAND',
    connect: '连接钱包',
    disconnect: '断开',
    walletEmpty: '未连接钱包',
    walletDemo: '演示钱包',
    walletReal: 'TON Connect',
    balanceUnknown: '余额暂未提供',
    staked: '本轮已质押',
    ton: 'TON',
    fuse: 'A9',
    tabBuy: '① 买入 A9',
    tabStake: '② 质押参战',
    payTon: '支付 TON',
    max: 'MAX',
    receive: '预计获得',
    receiveSub: '≈ {usd} · 1 TON ≈ ${rate}（演示汇率）',
    avgPrice: '成交均价',
    impact: '价格影响',
    fee: '手续费 0.3%',
    minReceive: '最少收到（滑点 1%）',
    buyBtn: '买入 A9',
    buyNote: '买入的 A9 留在你的钱包，在报名期内可转入质押金库参战。演示环境不会产生真实交易。',
    stakeRound: '报名轮次',
    stakeDeadline: '报名截止',
    stakeTotal: '本轮已质押',
    stakeAddrs: '参战地址',
    stakeAmount: '质押数量',
    stakeAll: '全部',
    lossMax: '失败时最大损失',
    rewardEst: '通过时预计奖励',
    share: '奖励占比（会被后来者稀释）',
    riskText: '我已阅读并确认：若本轮 12 根 K 线中达标不足 8 根，本轮全部质押本金（含我的质押）将 100% 销毁，且无法取回。预言机故障不按价格失败处理。',
    payloadLabel: 'payload 预览',
    btnRiskFirst: '勾选风险确认后质押',
    btnConfirm: '确认质押 · 锁定至本轮结算',
    btnConnectFirst: '连接钱包后质押',
    btnNotOpen: '当前不在报名窗口',
    btnSubmitting: '提交中…',
    btnContractPending: '合约部署后开放',
    lockClosedTitle: 'R{round} 报名已截止',
    lockClosedBody: '本轮参战名单已锁定：{stakers} 个地址，质押 {total} A9。质押本金在结算前无法追加、转移或取回。',
    lockClosedMine: '我在本轮的质押',
    lockNext: 'R{next} 将在 R{current} 结算后开启。现在可以先买入 A9 备弹。',
    goBuy: '去买入 A9',
    lockDoneTitle: 'R{round} 已结算',
    lockDoneWin: '本轮通过，可在战况面板认领本金与奖励。',
    lockDoneLose: '本轮失败，已永久关闭。',
    toastNeedWallet: '请先连接钱包',
    toastEnterAmount: '请输入数量',
    toastInsufficientTon: 'TON 余额不足',
    toastInsufficientFuse: 'A9 余额不足，请先买入',
    toastRisk: '请先勾选风险确认',
    toastNotOpen: '当前不在报名窗口',
    toastBuyDemo: '演示环境不产生真实交易（已模拟买入 {amount} A9）',
    toastBuyContract: '合约部署后开放',
    toastStakeOk: '已质押 {amount} A9，已记录风险确认 v{version}',
    toastStakeFail: '质押失败：{msg}',
    toastClaimOk: '已认领 {amount} A9',
    toastClaimNone: '暂无可认领额度',
    toastContractPending: '合约部署后开放',
    toastWalletError: '钱包连接失败，已降级为演示钱包',
  },
  flow: {
    lbl: 'ORDER FLOW · 成交流',
    title: '每一笔买卖都在推着价格线',
    intro: '逐笔成交、买卖盘口和本轮关键数字。价格线能否守在目标价之上，决定 12 根 K 线里有几根点亮。',
    tradesTitle: '逐笔成交 · TIME & SALES',
    time: '时间 UTC',
    side: '方向',
    amount: '数量 A9',
    price: '价格',
    value: '金额 USD',
    bookTitle: '盘口深度 · ORDER BOOK',
    internal: '内盘',
    statsTitle: '战场数据',
    live: '实时',
    empty: '等待成交…',
    tagMe: '你',
    tagBig: '大单',
    buy: '买',
    sell: '卖',
    s24h: '24H 成交额',
    liquidity: '内盘流动性',
    supply: '总供应量',
    burned: '已销毁',
    staked: '本轮质押池',
    stakers: '参战地址',
    reward: '本轮奖励预算',
    ratio: '奖励 / 质押',
    bookTarget: '目标 {v}',
  },
  ladder: {
    lbl: 'LADDER · 轮次阶梯',
    title: '十道关卡，每道目标价翻一倍',
    intro: '第 n 轮目标价 = P0 × 2ⁿ，第 10 轮是 P0 的 1024 倍。某一轮失败后，下一轮目标价不会回滚，也不会补发。P0 = {p0}，上线前由多源 7 日 TWAP 冻结上链。',
    p0: '—',
    note: '进度条为对数刻度：每向右一格，目标价翻一倍。',
    tagS: '已点亮 · 已解锁',
    tagF: '已熄灭 · 永久关闭',
    tagO: '观察中',
    tagK: '报名中',
    tagU: '未开启',
    outClaim: '已开放认领',
    outBurned: '已销毁',
    outPending: '待判定',
    outLocked: '未解锁',
    outAbort: '技术中止 · 不销毁',
  },
  rules: {
    lbl: 'BRIEFING · 作战规则',
    title: '一轮战役，四个阶段',
    intro: '规则写进合约，管理员不能修改已开始轮次的目标价、K 线阈值和预言机配置。',
    steps: [
      {
        n: '01',
        title: '报名质押',
        body: '报名窗口内，把 A9 转入质押金库，并在交易里写入风险确认。窗口关闭后不能追加、转移或提前取回。',
        key: '建议窗口 7 天 · 参数上线前确认',
      },
      {
        n: '02',
        title: '48 小时观察',
        body: '从下一个 UTC 4 小时整点起，连续 12 根完整 K 线。每根取多源 TWAP，不用最高价，不用瞬时价。',
        key: '4h × 12 = 48h · 不使用部分 K 线',
      },
      {
        n: '03',
        title: '判定',
        body: 'TWAP 大于等于目标价的 K 线至少 8 根即通过，不要求连续。恰好等于目标价也算达标。',
        key: '达标数 ≥ 8 通过 · ≤ 7 失败',
      },
      {
        n: '04',
        title: '结算',
        body: '通过：本金退还，7 亿奖励按质押占比认领。失败：7 亿奖励与本轮全部质押本金实际销毁，供应量随之减少。',
        key: '用户主动认领 · 每笔幂等',
      },
    ],
    sandLbl: 'WAR GAME · 沙盘推演',
    sandTitle: '点击 K 线，自己试一次判定',
    sandIntro: '默认刚好 8 根达标。取消任意一根，看看会发生什么。',
    sandCellsTitle: '12 根 4 小时 K 线 · 点击切换',
    sandCount: '{n} / 12 达标',
    presets: { all: '全部点亮', eight: '刚好 8 根', seven: '只差 1 根', none: '全部熄灭' },
    gaugeZero: '0',
    gaugePass: '通过线 8',
    sandStake: '假设我质押（A9）',
    outLbl: '判定结果',
    outWinTitle: '通过 · 引信点燃',
    outWinBody: '{n} 根达标，达到 8 根的通过线。{reward} A9 奖励开放认领，质押本金可全额取回。',
    outWinPrincipal: '取回本金',
    outWinReward: '预计奖励（按当前质押池占比）',
    outWinTotal: '合计',
    outLoseTitle: '失败 · 引信熄灭',
    outLoseBody: '仅 {n} 根达标，{extra}本轮永久关闭。{reward} 奖励额度与本轮全部质押本金一并销毁。',
    outLoseExtra: '只差 1 根。',
    outLoseYourLoss: '你的损失',
    outLoseRewardBurn: '奖励池销毁',
    outLosePoolBurn: '质押池销毁（含你）',
    diff: [
      { title: '失败永久关闭', body: '不重开、不重试、不补发，管理员也无法恢复。第 2 轮失败，第 3 轮目标仍是 8×P0。' },
      { title: '故障不算败', body: '预言机缺数据、签名无效、来源不足时，考核暂停，不销毁任何本金。恢复后重新收满完整 12 根。' },
      { title: '价格由预言机裁决', body: '多源签名数据加 4 小时 TWAP，任何人都可以提交有效数据。单一后台、单个池子都不能决定结果。' },
      { title: '销毁是真销毁', body: '失败时执行 Jetton burn，并核对 Jetton Master 的总供应量确实减少，不是把余额标成不可用。' },
    ],
    cellAriaOn: '第 {i} 根K线，达标',
    cellAriaOff: '第 {i} 根K线，未达标',
  },
  supply: {
    lbl: 'SUPPLY · 筹码分配',
    title: '100 亿枚，70% 留给战场',
    intro: '十个 7% 的方块对应十轮奖励预算，颜色跟随每一轮的实际结果。失败的方块被销毁，不会转移到其他轮次。',
    liq: '内盘/流动性',
    team: '团队',
    mkt: '营销',
    aria: '100亿枚代币分配示意',
    tableHead: { name: '分配', pct: '占比', amount: '数量（枚）' },
    rows: [
      { name: '十轮目标解锁奖励（每轮 7 亿）', pct: '70%', amount: '7,000,000,000' },
      { name: '内盘及流动性（内盘销售 8% + 流动性 5%）', pct: '13%', amount: '1,300,000,000' },
      { name: '团队', pct: '12%', amount: '1,200,000,000' },
      { name: '营销推广', pct: '5%', amount: '500,000,000' },
      { name: '合计', pct: '100%', amount: '10,000,000,000' },
    ],
  },
  risk: {
    lbl: 'WARNING · 参战前必读',
    version: '风险披露 v{version}',
    items: [
      { title: '本轮失败，全部质押本金 100% 销毁。', body: '同时销毁该轮 7 亿奖励额度。你的质押没有任何保本机制。' },
      { title: '目标价逐轮翻倍。', body: '第 10 轮目标是初始参考价的 1024 倍。协议不保证价格上涨，也不保证奖励实现。' },
      { title: 'TWAP 与多源预言机只能提高操纵成本。', body: '它们不能保证价格无法被操纵，也不能防止抛售。' },
      { title: '技术故障和市场失败是两回事。', body: '预言机故障只会暂停考核，不会销毁本金。但智能合约仍可能存在未被发现的漏洞，审计报告将在主网开放前公布。' },
      { title: '多钱包拆分无法被完全阻止。', body: '每地址上限只能缓解，不能证明真人唯一。' },
      { title: '合规风险由你自行判断。', body: '该机制可能触及不同司法辖区对金融产品、博彩、促销和消费者保护的规定，参与前请咨询专业意见。本页不构成投资建议。' },
    ],
  },
  mcta: { buy: '买入 A9', stake: '质押参战' },
};

export const EN: LandingCopy = {
  common: {
    dash: '—',
    loading: 'Loading…',
    apiDown: 'Market data unavailable, retrying…',
    retry: 'Retry',
    goMe: 'My position',
    goLeaderboard: 'Leaderboard',
    lossFull: 'A9 (100%)',
  },
  tape: {
    price: 'A9/USD',
    target: 'R{round} target',
    lit: 'Lit',
    miss: 'Missed',
    stake: 'Staked',
    burned: 'Burned',
    volume: '24H vol',
    touched: 'hit',
    untouched: 'below',
    buy: 'B',
    sell: 'S',
  },
  hero: {
    badge: 'TON · Price-driven token',
    pill: 'Target doubles every round, 10 rounds',
    title: 'Light 8 of 12 candles — ',
    titleEm: '700M A9 unlocks.',
    lede: 'Each round sets a target price and users stake to fight. Over 48 hours there are twelve 4-hour candles; if the TWAP reaches the target in at least 8 of them, rewards open for claiming and principal is returned. Miss by one candle and the round\'s 700M reward plus all staked principal are burned. The round closes forever.',
    ctaStake: 'Stake & fight',
    ctaBuy: 'Buy A9',
    ctaRules: 'Read the rules',
    totalSupply: 'Total supply',
    totalSupplyValue: '10B',
    totalSupplyUnit: 'tokens',
    unlockRounds: 'Unlock rounds',
    unlockRoundsValue: '10',
    unlockRoundsUnit: 'rounds × 700M',
    roundTarget: 'Round n target',
    roundTargetValue: 'P0×2',
    roundTargetUnit: 'n',
  },
  board: {
    currentBattle: 'CURRENT BATTLE',
    ofRounds: '/ {total}',
    windowLeft: 'Window left',
    stakeDeadline: 'Staking closes',
    observeLeft: 'Observation left',
    observeTotal: '/ 48:00',
    roundLabel: 'Round',
    settled: 'Settled',
    closed: 'Closed',
    phaseStake: 'STAKING · STAKING_OPEN',
    phaseObserve: 'OBSERVING · OBSERVING',
    phaseWin: 'SUCCESS · SUCCEEDED',
    phaseLose: 'CLOSED · FAILED_PERMANENT',
    phasePaused: 'PAUSED · ORACLE_PAUSED',
    phaseUnopened: 'UNOPENED · UNOPENED',
    cellHit: 'LIT',
    cellMiss: 'OUT',
    cellLive: 'LIVE',
    cellPending: 'WAIT',
    oracleOnline: 'Oracle online',
    oraclePaused: 'Oracle paused',
    validSources: 'Valid sources {valid} / {total}',
    coverage: 'Coverage {pct}%',
    configVersion: 'Config {v}',
    frozen: 'frozen',
    pending: 'pending',
    demoAccel: ' (demo speed)',
    price: 'PRICE A9 / USD',
    targetLabel: 'Round target',
    targetOf: 'Round target · {mult}×P0',
    twap: 'Provisional TWAP',
    touchedTarget: 'Target reached',
    untouchedTarget: 'Below target',
    needRise: 'Not reached · needs {pct}',
    beforeObserve: 'No candles before observation',
    aboveTarget: '{pct} above target',
    belowTarget: '{pct} below target',
    twapTentativeHit: 'Tentative hit · candle lit',
    twapTentativeMiss: 'Tentative miss',
    twapProgress: 'Progress {pct}%',
    twapLastClosed: 'Last candle closed',
    twapAfterStart: 'Counted after observation starts',
    litNeed: 'Lit / needed',
    missLine: 'Missed / fail line',
    remainCandles: 'Remaining',
    unitCandle: 'candles',
    hitSubWaiting: 'Counted after observation starts',
    hitSubLocked: 'Pass locked in',
    hitSubNeed: '{n} more needed',
    missSubHint: 'Up to 4 misses allowed',
    missSubTriggered: 'Fail line reached',
    missSubOneMore: 'One more miss ends it',
    missSubLeft: '{n} misses left',
    remSubStake: '12 full candles total',
    remSubLive: 'incl. 1 live · ',
    remSubNoNeed: 'No more needed',
    remSubNeed: 'Need ≥ {n} more',
    verdictStake: 'Staking live, target {target}',
    verdictStakeSub: 'Price must rise {pct} to reach the target. After staking closes, 48 hours start from the next UTC 4-hour boundary.',
    verdictWin: 'Round passed: {hits} / 12 candles qualified',
    verdictLose: 'Round failed: only {hits} / 12 candles qualified',
    verdictDoneSub: 'All 12 candles are closed and on-chain settlement is complete.',
    verdictLocked: 'Pass locked in',
    verdictLockedSub: '{hits} candles already qualified; that count cannot decrease. Settlement waits until the window ends.',
    verdictLost: 'Failure confirmed',
    verdictLostSub: '{miss} candles missed. Even lighting every remaining candle cannot reach 8. When the window ends, the reward pool and all staked principal are burned.',
    verdictOpen: 'Undecided',
    verdictOpenSub: 'Of {remain} candles left, {need} more must qualify; {margin} more misses end the round.',
    mine: 'My position',
    myStake: 'Staked {v} A9',
    myReward: 'Est. reward if passed {v}',
    myLoss: 'Loss if failed {v} (100%)',
    resultWinTitle: 'Fuse lit — R{round} unlocked',
    resultWinBody: '{hits} of 12 candles qualified. {reward} A9 rewards are open for claiming and principal can be fully withdrawn.',
    resultWinMine: 'Your {stake} A9 stake can claim about {reward} A9 in rewards.',
    resultLoseTitle: 'Fuse out — R{round} closed forever',
    resultLoseBody: 'Only {hits} candles qualified. Burned {reward} in rewards + {stake} in staked principal, {total} A9 in total; supply decreases accordingly.',
    resultLoseMine: 'Your {stake} A9 has been burned.',
    resultLoseNext: 'The next target does not roll back: R{next} stays {mult}×P0 = {target}.',
    claim: 'Claim principal & reward',
    resultAbortTitle: 'R{round} technically aborted',
    resultAbortBody: 'This round was aborted for oracle/contract technical reasons. No principal is burned. A full set of 12 candles restarts after recovery.',
    chartAria: 'Round price versus target price chart',
    chartStakeNote: 'Observation has not started · staking-period prices below',
    chartEmpty: 'Waiting for market data…',
    chartWaiting: 'Waiting for candle data',
    tipAbove: '{pct} above target',
    tipBelow: '{pct} below target',
    tipCandle: 'Candle {n}',
    targetTag: 'Target {v}',
    waitingRound: 'Waiting for round data…',
  },
  cmd: {
    title: 'COMMAND · Console',
    connect: 'Connect wallet',
    disconnect: 'Disconnect',
    walletEmpty: 'Wallet not connected',
    walletDemo: 'demo wallet',
    walletReal: 'TON Connect',
    balanceUnknown: 'balance unavailable',
    staked: 'Staked this round',
    ton: 'TON',
    fuse: 'A9',
    tabBuy: '① Buy A9',
    tabStake: '② Stake & fight',
    payTon: 'Pay TON',
    max: 'MAX',
    receive: 'You receive',
    receiveSub: '≈ {usd} · 1 TON ≈ ${rate} (demo rate)',
    avgPrice: 'Avg price',
    impact: 'Price impact',
    fee: 'Fee 0.3%',
    minReceive: 'Min received (1% slippage)',
    buyBtn: 'Buy A9',
    buyNote: 'Bought A9 stays in your wallet and can be moved into the staking vault while staking is open. The demo creates no real trade.',
    stakeRound: 'Staking round',
    stakeDeadline: 'Staking closes',
    stakeTotal: 'Staked this round',
    stakeAddrs: 'Stakers',
    stakeAmount: 'Stake amount',
    stakeAll: 'Max',
    lossMax: 'Max loss on failure',
    rewardEst: 'Est. reward on pass',
    share: 'Reward share (diluted by later stakers)',
    riskText: 'I have read and accept: if fewer than 8 of this round\'s 12 candles qualify, 100% of this round\'s staked principal (including mine) is burned and cannot be recovered. Oracle failure is not treated as a price failure.',
    payloadLabel: 'payload preview',
    btnRiskFirst: 'Accept the risk to stake',
    btnConfirm: 'Confirm stake · locked until settlement',
    btnConnectFirst: 'Connect wallet to stake',
    btnNotOpen: 'Staking window is closed',
    btnSubmitting: 'Submitting…',
    btnContractPending: 'Opens after contract deploy',
    lockClosedTitle: 'R{round} staking closed',
    lockClosedBody: 'The participant list is locked: {stakers} addresses, {total} A9 staked. Principal cannot be added, moved or withdrawn before settlement.',
    lockClosedMine: 'My stake this round',
    lockNext: 'R{next} opens after R{current} settles. Buy A9 now to prepare.',
    goBuy: 'Buy A9',
    lockDoneTitle: 'R{round} settled',
    lockDoneWin: 'This round passed. Claim principal and rewards from the battle board.',
    lockDoneLose: 'This round failed and is permanently closed.',
    toastNeedWallet: 'Connect a wallet first',
    toastEnterAmount: 'Enter an amount',
    toastInsufficientTon: 'Insufficient TON',
    toastInsufficientFuse: 'Insufficient A9 — buy first',
    toastRisk: 'Accept the risk disclosure first',
    toastNotOpen: 'Staking window is closed',
    toastBuyDemo: 'Demo only, no real trade (simulated buy of {amount} A9)',
    toastBuyContract: 'Opens after contract deploy',
    toastStakeOk: 'Staked {amount} A9, risk disclosure v{version} recorded',
    toastStakeFail: 'Stake failed: {msg}',
    toastClaimOk: 'Claimed {amount} A9',
    toastClaimNone: 'Nothing to claim yet',
    toastContractPending: 'Opens after contract deploy',
    toastWalletError: 'Wallet connection failed; using the demo wallet instead',
  },
  flow: {
    lbl: 'ORDER FLOW · Trades',
    title: 'Every trade pushes the price line',
    intro: 'Time & sales, order-book depth and this round\'s key numbers. Whether the price holds above target decides how many of the 12 candles light up.',
    tradesTitle: 'TIME & SALES',
    time: 'Time UTC',
    side: 'Side',
    amount: 'Size A9',
    price: 'Price',
    value: 'Value USD',
    bookTitle: 'ORDER BOOK',
    internal: 'Internal',
    statsTitle: 'Battle data',
    live: 'Live',
    empty: 'Waiting for trades…',
    tagMe: 'you',
    tagBig: 'block',
    buy: 'BUY',
    sell: 'SELL',
    s24h: '24H volume',
    liquidity: 'Internal liquidity',
    supply: 'Total supply',
    burned: 'Burned',
    staked: 'Round stake pool',
    stakers: 'Participants',
    reward: 'Round reward budget',
    ratio: 'Reward / stake',
    bookTarget: 'Target {v}',
  },
  ladder: {
    lbl: 'LADDER · Rounds',
    title: 'Ten gates, each target doubles',
    intro: 'Round n target = P0 × 2ⁿ; round 10 is 1024× P0. A failed round never rolls the next target back and is never re-issued. P0 = {p0}, frozen on-chain from a multi-source 7-day TWAP before launch.',
    p0: '—',
    note: 'The bar is a log scale: every step right doubles the target price.',
    tagS: 'Lit · unlocked',
    tagF: 'Out · permanently closed',
    tagO: 'Observing',
    tagK: 'Staking',
    tagU: 'Not opened',
    outClaim: 'open for claiming',
    outBurned: 'burned',
    outPending: 'pending',
    outLocked: 'locked',
    outAbort: 'technical abort · no burn',
  },
  rules: {
    lbl: 'BRIEFING · Rules',
    title: 'One campaign, four stages',
    intro: 'The rules live in the contract. Admins cannot change the target, candle threshold or oracle config of a round that has started.',
    steps: [
      {
        n: '01',
        title: 'Stake to enlist',
        body: 'During the staking window, move A9 into the staking vault and write the risk acceptance into the transaction. After the window closes it cannot be topped up, moved or withdrawn early.',
        key: 'Suggested 7-day window · confirm before launch',
      },
      {
        n: '02',
        title: '48-hour observation',
        body: 'Starting at the next UTC 4-hour boundary, twelve complete candles. Each one uses the multi-source TWAP — not the high, not the spot price.',
        key: '4h × 12 = 48h · no partial candles',
      },
      {
        n: '03',
        title: 'Verdict',
        body: 'At least 8 candles with a TWAP at or above the target pass the round; they need not be consecutive. Exactly equal to target counts.',
        key: '≥ 8 qualified passes · ≤ 7 fails',
      },
      {
        n: '04',
        title: 'Settlement',
        body: 'Pass: principal returns and the 700M reward is claimable pro rata. Fail: the 700M reward and all staked principal are actually burned, reducing supply.',
        key: 'Pull claims · idempotent per tx',
      },
    ],
    sandLbl: 'WAR GAME · Sandbox',
    sandTitle: 'Click the candles and try the verdict yourself',
    sandIntro: 'The default is exactly 8 qualified. Turn one off and see what happens.',
    sandCellsTitle: '12 × 4h candles · click to toggle',
    sandCount: '{n} / 12 qualified',
    presets: { all: 'Light all', eight: 'Exactly 8', seven: 'Short by one', none: 'Extinguish all' },
    gaugeZero: '0',
    gaugePass: 'Pass line 8',
    sandStake: 'Suppose I stake (A9)',
    outLbl: 'VERDICT',
    outWinTitle: 'Pass · fuse lit',
    outWinBody: '{n} candles qualified, reaching the line of 8. {reward} A9 rewards open for claiming and principal returns in full.',
    outWinPrincipal: 'Principal returned',
    outWinReward: 'Est. reward (current pool share)',
    outWinTotal: 'Total',
    outLoseTitle: 'Fail · fuse out',
    outLoseBody: 'Only {n} candles qualified. {extra}The round closes forever; the {reward} reward budget and all staked principal are burned together.',
    outLoseExtra: 'Short by exactly one. ',
    outLoseYourLoss: 'Your loss',
    outLoseRewardBurn: 'Reward pool burned',
    outLosePoolBurn: 'Stake pool burned (incl. yours)',
    diff: [
      { title: 'A failure closes forever', body: 'No reopen, no retry, no re-issue — even admins cannot restore it. If round 2 fails, round 3 still targets 8×P0.' },
      { title: 'Outages are not failures', body: 'If the oracle lacks data, signatures are invalid or sources are insufficient, scoring pauses and no principal is burned. A full 12-candle window restarts after recovery.' },
      { title: 'The oracle decides price', body: 'Multi-source signed data plus 4-hour TWAP; anyone can submit valid data. No single backend or pool decides the outcome.' },
      { title: 'Burns are real burns', body: 'On failure a Jetton burn executes and the Jetton Master total supply is checked to have decreased — balances are not merely marked unusable.' },
    ],
    cellAriaOn: 'Candle {i}, qualified',
    cellAriaOff: 'Candle {i}, not qualified',
  },
  supply: {
    lbl: 'SUPPLY · Allocation',
    title: '10B tokens, 70% reserved for battle',
    intro: 'Ten 7.5% blocks map to the ten round rewards and follow each round\'s real outcome. Failed blocks are burned and never moved to other rounds.',
    liq: 'Internal / Liquidity',
    team: 'Team',
    mkt: 'Marketing',
    aria: '10B token allocation diagram',
    tableHead: { name: 'Allocation', pct: 'Share', amount: 'Amount' },
    rows: [
      { name: 'Ten round unlock rewards (700M each)', pct: '70%', amount: '7,000,000,000' },
      { name: 'Internal sale & liquidity', pct: '13%', amount: '1,300,000,000' },
      { name: 'Team', pct: '12%', amount: '1,200,000,000' },
      { name: 'Marketing', pct: '5%', amount: '500,000,000' },
      { name: 'Total', pct: '100%', amount: '10,000,000,000' },
    ],
  },
  risk: {
    lbl: 'WARNING · Read before you fight',
    version: 'Risk disclosure v{version}',
    items: [
      { title: 'If the round fails, 100% of staked principal is burned.', body: 'The 700M reward for that round is burned as well. Your stake has no capital protection.' },
      { title: 'The target doubles every round.', body: 'Round 10 targets 1024× the initial reference price. The protocol does not guarantee price appreciation or that rewards will be realized.' },
      { title: 'TWAP and multi-source oracles only raise the cost of manipulation.', body: 'They cannot guarantee the price is unmanipulable and cannot prevent selling.' },
      { title: 'Technical failure and market failure are different things.', body: 'An oracle outage only pauses scoring and never burns principal. Smart contracts may still contain undiscovered bugs; the audit report will be published before mainnet opens.' },
      { title: 'Splitting across wallets cannot be fully prevented.', body: 'Per-address caps only mitigate; they cannot prove a unique human.' },
      { title: 'Compliance risk is yours to judge.', body: 'This mechanism may touch rules on financial products, gambling, promotions and consumer protection in various jurisdictions. Seek professional advice before participating. This page is not investment advice.' },
    ],
  },
  mcta: { buy: 'Buy A9', stake: 'Stake & fight' },
};

export function useCopy(): LandingCopy {
  return useDict(ZH, EN);
}