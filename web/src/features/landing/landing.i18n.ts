import { useDict } from '../../lib/lang';

/ Replace {name} placeholders in a copy template. */
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
    roundTarget: string;
    roundTargetValue: string;
    roundTargetUnit: string;
  };
  board: {
    currentBattle: string;
    ofRounds: string;
    windowLeft: string;
    stakeDeadline: string;
    nextStakeStarts: string;
    stakeEnds: string;
    verdictIn: string;
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
    burnText: string;
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
    formulaNote: string;
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
    goMe: '前往我的质押',
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
    pill: "成功才升档 · 失败本金全损",
    title: '用质押，参与价格考核。',
    titleEm: "通过分奖励，失败失去本金。",
    lede: "每城按多源 TWAP 与锁定目标价考核。城门开后上车的本金按战力分奖池：破城后本金与 20% 奖励立即可领，80% 压城随后续破城解锁；城没破则本金全部销毁，奖池一半销毁、一半滚入下一城。",
    ctaStake: '开始质押',
    ctaBuy: '买入 A9',
    ctaRules: '读懂规则',
    totalSupply: '总发行',
    totalSupplyValue: '100',
    totalSupplyUnit: '亿枚',
    roundTarget: '第 n 轮目标',
    roundTargetValue: 'P0×2',
    roundTargetUnit: 'n',
  },
  board: {
    currentBattle: '当前轮次',
    ofRounds: '/ {total}',
    windowLeft: '窗口剩余',
    stakeDeadline: '报名截止',
    nextStakeStarts: '距离下一轮质押开始',
    stakeEnds: '距离质押结束',
    verdictIn: '距离判定',
    observeLeft: '观察窗口剩余',
    observeTotal: '/ 24:00',
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
    cellMiss: '未达标',
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
    targetOf: '本轮目标价 · 阶梯 {mult}×P0',
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
    missSubHint: '最多容错 {n} 根',
    missSubTriggered: '判负线已触发',
    missSubOneMore: '再失守 1 根即判负',
    missSubLeft: '还可失守 {n} 根',
    remSubStake: '{n} 根完整 K 线',
    remSubLive: '含进行中 1 根 · ',
    remSubNoNeed: '无需再亮',
    remSubNeed: '需再亮 ≥ {n} 根',
    verdictStake: '报名进行中，目标价 {target}',
    verdictStakeSub: '现价需要上涨 {pct} 才能触及。报名截止后，从下一个 UTC 1 小时整点起算 24 小时。',
    verdictWin: '本轮通过：{hits} / {total} 根达标',
    verdictLose: '本轮失败：仅 {hits} / {total} 根达标',
    verdictDoneSub: "服务端报告本轮已结算。链上记录请在对应网络核验。",
    verdictLocked: '通过资格已锁定',
    verdictLockedSub: '已有 {hits} 根达标，达标数不会减少。窗口走完后才能链上结算。',
    verdictLost: '已确定失败',
    verdictLostSub: '已失守 {miss} 根，剩余 K 线全亮也到不了 {need} 根。窗口走完后，本城本金全部销毁（输了归零），奖池一半销毁、一半滚入下一城。',
    verdictOpen: '胜负未定',
    verdictOpenSub: '剩余 {remain} 根里还需再亮 {need} 根；再失守 {margin} 根即判负。',
    mine: '我的质押',
    myStake: '质押 {v} A9',
    myReward: "已分配奖励 {v}",
    myLoss: '失败则损失 {v}（100%）',
    resultWinTitle: "R{round} 通过，奖励已分配",
    resultWinBody: "{total} 根里 {hits} 根达标。本城 {reward} A9 奖池按战力占比分配：本金与 20% 奖励立即可领，80% 压城。",
    resultWinMine: "你的本金 {stake} A9；服务端奖励 {reward} A9。实际可领额见账户页。",
    resultLoseTitle: 'R{round} 失败，永久关闭',
    resultLoseBody: '仅 {hits} 根达标。本城奖池 {reward} 的一半销毁、另一半滚入下一城；全部本金 {stake} 销毁。本城合计销毁 {total} A9（含 1.2 亿团队额度），总供应量随之减少。',
    resultLoseMine: '你的 {stake} A9 已销毁。',
    resultLoseNext: '下一轮目标价不回滚：R{next} 仍是 {mult}×P0 = {target}。',
    claim: "查看可领取额度",
    resultAbortTitle: 'R{round} 技术中止',
    resultAbortBody: "本城因技术原因中止，不按价格失败处理，不销毁本金。本金可在攻城令中领取，后续城次以账户及协议状态为准。",
    chartAria: "本轮已报告 TWAP 与目标价对比图",
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
    title: '交易台 · TRADE',
    connect: '连接钱包',
    disconnect: '断开',
    walletEmpty: '未连接钱包',
    walletDemo: '演示钱包',
    walletReal: 'TON Connect',
    balanceUnknown: '余额暂未提供',
    staked: '本轮已质押',
    ton: 'GRAM',
    fuse: 'A9',
    tabBuy: '买入参考',
    tabStake: '本轮参与',
    payTon: '支付 GRAM',
    max: 'MAX',
    receive: '预计获得',
    receiveSub: '≈ {usd} · 1 GRAM ≈ ${rate}（演示汇率）',
    avgPrice: '成交均价',
    impact: '价格影响',
    fee: '手续费 0.3%',
    minReceive: '最少收到（滑点 1%）',
    buyBtn: '买入 A9',
    buyNote: "此处仅按当前参考价换算数量，不是可执行报价。交易入口尚未开放，不会扣除 TON 或增加 A9 余额。演示质押使用服务端演示钱包余额。",
    stakeRound: '报名轮次',
    stakeDeadline: '报名截止',
    stakeTotal: '本轮已质押',
    stakeAddrs: '质押地址',
    stakeAmount: '质押数量',
    stakeAll: '全部',
    lossMax: '失败时最大损失',
    rewardEst: '通过时预计奖励',
    share: '奖励占比（会被后来者稀释）',
    riskText: "我接受：本城 {total} 根 K 线中少于 {need} 根达标时，我的全部本金归零（销毁，无法追回）。价格由单一 keeper 提交，军饷由单一发布者决定；奖励 80% 压城分段解锁。",
    burnText: "我确认：城没破时，我的全部本金将被销毁（输了归零，Jetton burn），销毁不可撤销，上车后不可取消。",
    payloadLabel: 'payload 预览',
    btnRiskFirst: '勾选风险确认后质押',
    btnConfirm: '确认质押 · 锁定至本轮结算',
    btnConnectFirst: '连接钱包后质押',
    btnNotOpen: '当前不在报名窗口',
    btnSubmitting: '提交中…',
    btnContractPending: '合约部署后开放',
    lockClosedTitle: 'R{round} 报名已截止',
    lockClosedBody: '本轮质押名单已锁定：{stakers} 个地址，质押 {total} A9。质押本金在结算前无法追加、转移或取回。',
    lockClosedMine: '我在本轮的质押',
    lockNext: 'R{next} 将在 R{current} 结算后开启。现在可以先买入 A9 备用。',
    goBuy: '去买入 A9',
    lockDoneTitle: 'R{round} 已结算',
    lockDoneWin: "本城破城。前往账户页领取本金与 20% 即时奖励；压城 80% 随后续破城或第 10 城后 30 天线性解锁。",
    lockDoneLose: '本轮失败，已永久关闭。',
    toastNeedWallet: '请先连接钱包',
    toastEnterAmount: '请输入数量',
    toastInsufficientTon: 'GRAM 余额不足',
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
    intro: '逐笔成交、买卖盘口和本轮关键数字。价格线能否守在目标价之上，决定 24 根 K 线里有几根点亮。',
    tradesTitle: '逐笔成交 · TIME & SALES',
    time: '时间 UTC',
    side: '方向',
    amount: '数量 A9',
    price: '价格',
    value: '金额 USD',
    bookTitle: '盘口深度 · ORDER BOOK',
    internal: '内盘',
    statsTitle: '本轮数据',
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
    stakers: '质押地址',
    reward: '本轮奖励预算',
    ratio: '奖励 / 质押',
    bookTarget: '目标 {v}',
  },
  ladder: {
    lbl: 'LADDER · 轮次阶梯',
    title: '十轮，成功才升档，目标价翻倍',
    intro: '目标价按档位（tier）计算：tier = 1 + 已成功轮数，目标 = max(P0 × 2^tier, 2 × 开窗时 24h TWAP)。失败轮不升档（下一轮同档重试），只有成功才升档，因此 10 轮不等于 10 个档位、第 10 轮也不一定是 1024 倍。P0 = {p0}，上线前由多源 7 日 TWAP 冻结上链。目标价在开窗时锁定，锁定后不可修改。',
    p0: '—',
    note: '进度条按轮次推进；相邻轮次倍数相同表示「失败后同档重试」。',
    tagS: '已点亮 · 已解锁',
    tagF: '未通过 · 永久关闭',
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
    lbl: 'RULES · 规则',
    title: '一轮，四个阶段',
    intro: '规则写进合约：没有管理员、不可升级；keeper 只能开轮和提交价格，不能修改已开始轮次的目标价和 K 线阈值。',
    formulaNote: '目标价公式：本轮目标 = max(阶梯 P0×2^tier, 2 × 开窗时 24h TWAP)，tier = 1 + 已成功轮数；开窗时锁定，不可修改。',
    steps: [
      {
        n: '01',
        title: '报名质押',
        body: '报名窗口内，把 A9 转入质押金库，并在交易里写入风险确认。窗口关闭后不能追加、转移或提前取回。',
        key: '报名窗口 36 小时 · 参数上线前确认',
      },
      {
        n: '02',
        title: '24 小时观察',
        body: '从下一个 UTC 1 小时整点起，连续 24 根完整 K 线。每根取多源 TWAP，不用最高价，不用瞬时价。',
        key: '1h × 24 = 24h · 不使用部分 K 线',
      },
      {
        n: '03',
        title: '判定',
        body: 'TWAP 大于等于目标价的 K 线至少 16 根即通过，不要求连续。恰好等于目标价也算达标。',
        key: '达标数 ≥ 16 通过 · ≤ 15 失败',
      },
      {
        n: '04',
        title: '结算',
        body: '破城：本金立即全额可领，奖励 20% 立即可领、80% 压城；城没破：本金 100% 销毁（输了归零），奖池一半销毁、一半滚入下一城。',
        key: '用户主动认领 · 每笔幂等',
      },
    ],
    sandLbl: 'WAR GAME · 沙盘推演',
    sandTitle: '点击 K 线，自己试一次判定',
    sandIntro: "默认刚好 {need} 根达标。取消任意一根，看看会发生什么。",
    sandCellsTitle: "{total} 根 × {hours}h K 线 · 点击切换",
    sandCount: '{n} / {total} 达标',
    presets: { all: '全部点亮({total})', eight: '刚好 {need} 根', seven: '只差 1 根', none: '全部未达标' },
    gaugeZero: '0',
    gaugePass: "通过线 {need}",
    sandStake: '假设我质押（A9）',
    outLbl: '判定结果',
    outWinTitle: '通过',
    outWinBody: "{n} 根达标，达到 {need} 根通过线。破城后本金与 20% 奖励立即可领；{reward} A9 奖池按战力占比分配，其中 80% 压城。",
    outWinPrincipal: '取回本金',
    outWinReward: "奖励金额（按战力比例）",
    outWinTotal: "当前可确定返还",
    outLoseTitle: '失败',
    outLoseBody: '仅 {n} 根达标，{extra}本城永久关闭。本城奖池 {reward} 的一半销毁、另一半滚入下一城；全部上车本金销毁。',
    outLoseExtra: '只差 1 根。',
    outLoseYourLoss: '你的损失',
    outLoseRewardBurn: '奖励池销毁',
    outLosePoolBurn: '质押池销毁（含你）',
    diff: [
      { title: '失败永久关闭', body: '不重开、不重试、不补发，任何人都无法恢复；失败轮不升档，第 2 轮失败后第 3 轮沿用同档（4×P0）。' },
      { title: '故障不算败', body: '价格提交停滞超过 7 天时，任何人都可以触发技术终止：全额退回本金，不销毁、不升档。' },
      { title: '价格由单一 keeper 提交', body: '每小时由一个 keeper 热钱包提交 1 小时 TWAP。没有多签、没有独立预言机：keeper 密钥被盗可提交伪造价格。' },
      { title: '销毁是真销毁', body: '失败时执行 Jetton burn，并核对 Jetton Master 的总供应量确实减少，不是把余额标成不可用。' },
    ],
    cellAriaOn: '第 {i} 根K线，达标',
    cellAriaOff: '第 {i} 根K线，未达标',
  },
  supply: {
    lbl: 'SUPPLY · 筹码分配',
    title: '100 亿枚，70% 用于奖励',
    intro: '十个 7% 的方块对应十轮奖励预算，颜色跟随每一轮的实际结果。失败的方块被销毁，不会转移到其他轮次。',
    liq: '内盘/流动性',
    team: '团队',
    mkt: '营销',
    aria: '100亿枚代币分配示意',
    tableHead: { name: '分配', pct: '占比', amount: '数量（枚）' },
    rows: [
      { name: '十轮目标奖励（每轮 7 亿）', pct: '70%', amount: '7,000,000,000' },
      { name: '内盘及流动性（内盘销售 8% + 流动性 5%）', pct: '13%', amount: '1,300,000,000' },
      { name: '团队', pct: '12%', amount: '1,200,000,000' },
      { name: '营销推广', pct: '5%', amount: '500,000,000' },
      { name: '合计', pct: '100%', amount: '10,000,000,000' },
    ],
  },
  risk: {
    lbl: 'WARNING · 上车前必读',
    version: '风险披露 v{version}',
    items: [
      { title: '输了归零：城没破，本城全部上车本金 100% 销毁。', body: '本金没有任何保本机制；没有复活、没有免死金牌、没有稳健模式。' },
      { title: '城没破，奖池一半销毁、一半滚入下一城。', body: '同时销毁本城 1.2 亿团队额度。第 10 城结束后，剩余滚存全部销毁。' },
      { title: '破城奖励分两段：20% 立即可领，80% 压城。', body: '压城部分在此后任意一城破城时解锁；若第 10 城结束后仍未解锁，则在 30 天内线性解锁，期间领取可能只得到部分。' },
      { title: '团队额度晚一轮发放。', body: '第 r 城破城时团队 1.2 亿不发，下一次破城时才发；最后一笔在第 10 城结束 30 天后由任何人触发释放。' },
      { title: '价格由单一 keeper 提交。', body: '开窗 TWAP 与每根 K 线都由同一热钱包提交，链上无法验证价格真实性；密钥泄露后可伪造任意一轮的成败。' },
      { title: '军饷由单一发布者决定分配。', body: '军饷每周以默克尔根发布，单一发布者钥匙决定每个钱包的累计额；合约无法核验分配依据。' },
      { title: '无效上车可能无法退回。', body: '单笔最低 1,000 A9，请通过本站上车并足额附带 GRAM。附带 GRAM 不足 0.1 时，无效上车的代币留在协议中，不会退回。' },
      { title: '目标价按档位翻倍。', body: '档位 tier = 1 + 已成功轮数，失败轮同档重试、成功才升档；10 轮不等于 10 个档位，第 10 轮倍数取决于失败次数（最多 1024×P0）。协议不保证价格上涨，也不保证奖励实现。' },
      { title: '技术故障和市场失败是两回事。', body: '价格提交停滞超过 7 天时本轮技术终止，全额退回本金，不销毁。但智能合约仍可能存在未被发现的漏洞，审计报告将在主网开放前公布。' },
      { title: '多钱包拆分无法被完全阻止。', body: '协议不设单地址上限，也无法证明真人唯一。' },
      { title: '合规风险由你自行判断。', body: '该机制可能触及不同司法辖区对金融产品、博彩、促销和消费者保护的规定，参与前请咨询专业意见。本页不构成投资建议。' },
    ],
  },
  mcta: { buy: '买入 A9', stake: '开始质押' },
};

export const EN: LandingCopy = {
  common: {
    dash: '—',
    loading: 'Loading…',
    apiDown: 'Market data unavailable, retrying…',
    retry: 'Retry',
    goMe: 'My stake',
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
    pill: "Success advances tier · full principal at risk",
    title: 'Stake into a price challenge.',
    titleEm: "Share rewards on success. Lose principal on failure.",
    lede: "Multi-source TWAP is scored against a locked target. Principal entered during the gate window shares the pool by weight: on success, principal and 20% of the reward are claimable at once, and the other 80% unlocks on a later success. On failure, all principal is burned and half the pool is burned while half rolls into the next round.",
    ctaStake: 'Stake now',
    ctaBuy: 'Buy A9',
    ctaRules: 'Read the rules',
    totalSupply: 'Total supply',
    totalSupplyValue: '10B',
    totalSupplyUnit: 'tokens',
    roundTarget: 'Round n target',
    roundTargetValue: 'P0×2',
    roundTargetUnit: 'n',
  },
  board: {
    currentBattle: 'CURRENT ROUND',
    ofRounds: '/ {total}',
    windowLeft: 'Window left',
    stakeDeadline: 'Staking closes',
    nextStakeStarts: 'Next staking starts in',
    stakeEnds: 'Staking ends in',
    verdictIn: 'Verdict in',
    observeLeft: 'Observation left',
    observeTotal: '/ 24:00',
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
    targetOf: 'Round target · ladder {mult}×P0',
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
    missSubHint: 'Up to {n} misses allowed',
    missSubTriggered: 'Fail line reached',
    missSubOneMore: 'One more miss ends it',
    missSubLeft: '{n} misses left',
    remSubStake: '{n} full candles total',
    remSubLive: 'incl. 1 live · ',
    remSubNoNeed: 'No more needed',
    remSubNeed: 'Need ≥ {n} more',
    verdictStake: 'Staking live, target {target}',
    verdictStakeSub: 'Price must rise {pct} to reach the target. After staking closes, 24 hours start from the next UTC 1-hour boundary.',
    verdictWin: 'Round passed: {hits} / {total} candles qualified',
    verdictLose: 'Round failed: only {hits} / {total} candles qualified',
    verdictDoneSub: "The server reports this round settled. Verify transactions on the corresponding network.",
    verdictLocked: 'Pass locked in',
    verdictLockedSub: '{hits} candles already qualified; that count cannot decrease. Settlement waits until the window ends.',
    verdictLost: 'Failure confirmed',
    verdictLostSub: '{miss} candles missed. Even lighting every remaining candle cannot reach {need}. When the window ends, all principal is burned (losing means zero) and half the pool burns while half rolls into the next round.',
    verdictOpen: 'Undecided',
    verdictOpenSub: 'Of {remain} candles left, {need} more must qualify; {margin} more misses end the round.',
    mine: 'My stake',
    myStake: 'Staked {v} A9',
    myReward: "Allocated rewards {v}",
    myLoss: 'Loss if failed {v} (100%)',
    resultWinTitle: "Round passed — R{round} rewards allocated",
    resultWinBody: "{hits} of {total} candles qualified. The {reward} A9 pool is split pro rata to weight: principal and 20% of the reward are claimable at once; 80% is locked.",
    resultWinMine: "Your principal is {stake} A9; reported rewards are {reward} A9. Check available amounts in your account.",
    resultLoseTitle: 'Round failed — R{round} closed forever',
    resultLoseBody: 'Only {hits} candles qualified. Of the {reward} pool, half is burned and half rolls into the next round; all {stake} in principal is burned. This gate burns {total} A9 in total (including the 120M team quota); supply decreases accordingly.',
    resultLoseMine: 'Your {stake} A9 has been burned.',
    resultLoseNext: 'The next target does not roll back: R{next} stays {mult}×P0 = {target}.',
    claim: "View available claims",
    resultAbortTitle: 'R{round} technically aborted',
    resultAbortBody: "This gate ended for technical reasons, not a failed price test. Principal is not burned and can be claimed from your gate ticket. Check account and protocol status for subsequent gates.",
    chartAria: "Reported round TWAP versus target chart",
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
    title: 'TRADE · Console',
    connect: 'Connect wallet',
    disconnect: 'Disconnect',
    walletEmpty: 'Wallet not connected',
    walletDemo: 'demo wallet',
    walletReal: 'TON Connect',
    balanceUnknown: 'balance unavailable',
    staked: 'Staked this round',
    ton: 'GRAM',
    fuse: 'A9',
    tabBuy: 'Buy estimate',
    tabStake: 'Join this round',
    payTon: 'Pay GRAM',
    max: 'MAX',
    receive: 'You receive',
    receiveSub: '≈ {usd} · 1 GRAM ≈ ${rate} (demo rate)',
    avgPrice: 'Avg price',
    impact: 'Price impact',
    fee: 'Fee 0.3%',
    minReceive: 'Min received (1% slippage)',
    buyBtn: 'Buy A9',
    buyNote: "Reference-price conversion only; not an executable quote. Trading is not open. No TON or A9 balance changes. Demo staking uses the server demo-wallet balance.",
    stakeRound: 'Staking round',
    stakeDeadline: 'Staking closes',
    stakeTotal: 'Staked this round',
    stakeAddrs: 'Stakers',
    stakeAmount: 'Stake amount',
    stakeAll: 'Max',
    lossMax: 'Max loss on failure',
    rewardEst: 'Est. reward on pass',
    share: 'Reward share (diluted by later stakers)',
    riskText: "I accept: if fewer than {need} of {total} candles qualify, all of my staked principal may go to zero and cannot be recovered. Prices are submitted by a single keeper.",
    burnText: "I confirm: if the gate holds, all of my principal is burned (losing means zero; Jetton burn). The burn is irreversible and stakes cannot be cancelled once in.",
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
    lockDoneWin: "This gate broke. Claim principal and the 20% immediate reward from your account; the 80% locked part unlocks on a later success or over 30 days after round 10.",
    lockDoneLose: 'This round failed and is permanently closed.',
    toastNeedWallet: 'Connect a wallet first',
    toastEnterAmount: 'Enter an amount',
    toastInsufficientTon: 'Insufficient GRAM',
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
    intro: 'Time & sales, order-book depth and this round\'s key numbers. Whether the price holds above target decides how many of the 24 candles light up.',
    tradesTitle: 'TIME & SALES',
    time: 'Time UTC',
    side: 'Side',
    amount: 'Size A9',
    price: 'Price',
    value: 'Value USD',
    bookTitle: 'ORDER BOOK',
    internal: 'Internal',
    statsTitle: 'Round data',
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
    title: 'Ten rounds — the tier doubles on success',
    intro: 'Targets follow the tier, not the round number: tier = 1 + successful rounds, target = max(P0 × 2^tier, 2 × 24h TWAP at window open). A failed round does not advance the tier — the next round retries the same tier; only a success moves up. So 10 rounds ≠ 10 tiers, and round 10 is not necessarily 1024×. P0 = {p0}, frozen on-chain from a multi-source 7-day TWAP before launch. The target is locked when the window opens and cannot be changed.',
    p0: '—',
    note: 'The bar advances by round; two adjacent rounds with the same multiple mean a failed round is retrying the same tier.',
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
    lbl: 'RULES',
    title: 'One round, four phases',
    intro: 'The rules live in the contract: no admin, no upgrades. The keeper can only open rounds and submit prices; it cannot change the target or candle threshold of a round that has started.',
    formulaNote: 'Target formula: round target = max(ladder P0×2^tier, 2 × 24h TWAP at window open), tier = 1 + successful rounds. Locked when the window opens; admins cannot change it.',
    steps: [
      {
        n: '01',
        title: 'Stake to enlist',
        body: 'During the staking window, move A9 into the staking vault and write the risk acceptance into the transaction. After the window closes it cannot be topped up, moved or withdrawn early.',
        key: 'Suggested 36-hour window · confirm before launch',
      },
      {
        n: '02',
        title: '24-hour observation',
        body: 'Starting at the next UTC 1-hour boundary, twenty-four complete candles. Each one uses the multi-source TWAP — not the high, not the spot price.',
        key: '1h × 24 = 24h · no partial candles',
      },
      {
        n: '03',
        title: 'Verdict',
        body: 'At least 16 candles with a TWAP at or above the target pass the round; they need not be consecutive. Exactly equal to target counts.',
        key: '≥ 16 qualified passes · ≤ 15 fails',
      },
      {
        n: '04',
        title: 'Settlement',
        body: 'Pass: principal is claimable at once, plus a weight-based share of the reward (20% at once, 80% locked). Fail: all staked principal is burned, half the pool is burned and half rolls into the next round.',
        key: 'Pull claims · idempotent per tx',
      },
    ],
    sandLbl: 'WAR GAME · Sandbox',
    sandTitle: 'Click the candles and try the verdict yourself',
    sandIntro: "The default is exactly {need} qualified. Turn one off and see what happens.",
    sandCellsTitle: "{total} × {hours}h candles · click to toggle",
    sandCount: '{n} / {total} qualified',
    presets: { all: 'Light all ({total})', eight: 'Exactly {need}', seven: 'Short by one', none: 'All below' },
    gaugeZero: '0',
    gaugePass: "Pass line {need}",
    sandStake: 'Suppose I stake (A9)',
    outLbl: 'VERDICT',
    outWinTitle: 'Passed',
    outWinBody: "{n} candles qualify, reaching {need}. On success, principal and 20% of the reward are claimable at once; the {reward} A9 pool is split pro rata to this gate's weight, with 80% locked.",
    outWinPrincipal: 'Principal returned',
    outWinReward: "Reward (pro rata to weight)",
    outWinTotal: "Known principal return",
    outLoseTitle: 'Failed',
    outLoseBody: 'Only {n} candles qualified. {extra}The gate closes forever; half of the {reward} pool is burned, the other half rolls into the next round, and all entry principal is burned.',
    outLoseExtra: 'Short by exactly one. ',
    outLoseYourLoss: 'Your loss',
    outLoseRewardBurn: 'Reward pool burned',
    outLosePoolBurn: 'Stake pool burned (incl. yours)',
    diff: [
      { title: 'A failure closes forever', body: 'No reopen, no retry, no re-issue — even admins cannot restore it. A failed round does not advance the tier: if round 2 fails, round 3 retries the same 4×P0 tier.' },
      { title: 'Outages are not failures', body: 'If price submission stalls for more than 7 days, anyone can trigger a technical abort: principal is returned in full, nothing is burned and the tier does not advance.' },
      { title: 'A single keeper submits prices', body: 'One keeper hot wallet submits the 1-hour TWAP every hour. No multisig and no independent oracle: a stolen keeper key could submit fake prices.' },
      { title: 'Burns are real burns', body: 'On failure a Jetton burn executes and the Jetton Master total supply is checked to have decreased — balances are not merely marked unusable.' },
    ],
    cellAriaOn: 'Candle {i}, qualified',
    cellAriaOff: 'Candle {i}, not qualified',
  },
  supply: {
    lbl: 'SUPPLY · Allocation',
    title: '10B tokens, 70% for rewards',
    intro: 'Ten 7% blocks map to the ten round rewards and follow each round\'s real outcome. A passed gate pays out its pool (20% at once, 80% locked). A failed gate burns half its pool and rolls the other half into the next round.',
    liq: 'Internal / Liquidity',
    team: 'Team',
    mkt: 'Marketing',
    aria: '10B token allocation diagram',
    tableHead: { name: 'Allocation', pct: 'Share', amount: 'Amount' },
    rows: [
      { name: 'Ten round rewards (700M each)', pct: '70%', amount: '7,000,000,000' },
      { name: 'Internal sale & liquidity', pct: '13%', amount: '1,300,000,000' },
      { name: 'Team', pct: '12%', amount: '1,200,000,000' },
      { name: 'Marketing', pct: '5%', amount: '500,000,000' },
      { name: 'Total', pct: '100%', amount: '10,000,000,000' },
    ],
  },
  risk: {
    lbl: 'WARNING · Read before you stake',
    version: 'Risk disclosure v{version}',
    items: [
      { title: 'Losing means zero: if the gate holds, 100% of the round\'s staked principal is burned.', body: 'Principal has no capital protection. There is no revival, no free pass and no conservative mode.' },
      { title: 'If the gate holds, half the round pool is burned and half rolls into the next round.', body: 'The round\'s 120M team quota is burned as well. After round 10 settles, any remaining rollover is burned.' },
      { title: 'Breaking the gate pays in two parts: 20% is claimable at once, 80% stays locked.', body: 'The locked 80% unlocks on any later successful round. If it is still locked after round 10, it unlocks linearly over 30 days, so an early claim may return only part of it.' },
      { title: 'The team quota is paid one round late.', body: 'When round r breaks the gate, the 120M team quota is not paid; it is paid at the next successful round. The last one is released by anyone 30 days after round 10 ends.' },
      { title: 'A single keeper submits all prices.', body: 'The opening TWAP and every hourly candle come from one hot wallet, and the chain cannot verify price authenticity. A leaked key can fake the outcome of any round.' },
      { title: 'A single publisher decides all allocations.', body: 'The weekly junxiang Merkle roots are published by one key that sets each wallet\'s cumulative amount. The contract cannot verify the basis of an allocation.' },
      { title: 'Invalid stakes may not be refunded.', body: 'Minimum 1,000 A9. Stake through this site with enough GRAM attached. If less than 0.1 GRAM is attached, an invalid stake is kept in the protocol and is not refunded.' },
      { title: 'The target doubles per tier, not per round.', body: 'tier = 1 + successful rounds: a failed round retries the same tier and only a success moves up. 10 rounds ≠ 10 tiers, and round 10 is at most 1024× P0 depending on failures. The protocol does not guarantee price appreciation or that rewards will be realized.' },
      { title: 'Technical failure and market failure are different things.', body: 'If price submission stalls for more than 7 days the round is technically aborted and principal is returned in full, nothing burned. Smart contracts may still contain undiscovered bugs; the audit report will be published before mainnet opens.' },
      { title: 'Splitting across wallets cannot be fully prevented.', body: 'The protocol sets no per-address cap and cannot prove a unique human.' },
      { title: 'Compliance risk is yours to judge.', body: 'This mechanism may touch rules on financial products, gambling, promotions and consumer protection in various jurisdictions. Seek professional advice before participating. This page is not investment advice.' },
    ],
  },
  mcta: { buy: 'Buy A9', stake: 'Stake now' },
};

export function useCopy(): LandingCopy {
  return useDict(ZH, EN);
}