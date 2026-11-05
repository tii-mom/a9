import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { ApiError } from '../../lib/api';
import { api, useQuery } from '../../lib/api';
import { formatDateTime, formatToken, formatUsdE8 } from '../../lib/format';
import { useDict, useLang } from '../../lib/lang';
import { SiteFooter } from '../../components/SiteFooter';
import { SiteHeader } from '../../components/SiteHeader';
import { formatPrice, secondsHint } from './common';
import {
  apiErrorText,
  COMMON,
  durationText,
  resultLabel,
  stateLabel,
} from './common';
import { ConfirmButton, Empty, ErrorState, Loading, PageHead, Stat, StatePill, ToastView, useToast } from './ui';
import './pages.css';

const TOKEN_KEY = 'fuse.admin.token';

/** 数据源徽标：demo 用琥珀色，与生产（chain）区分。 */
function DataSourceChip({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="ap-muted">—</span>;
  if (value === 'demo') return <span className="chip demo-src">demo</span>;
  return <span className="chip ok">{value}</span>;
}

/** 已知冻结项的英文标签/取值（后端 label/value 为中文数据，EN 界面用本地映射兜底）。 */
const FROZEN_EN: Record<string, { label: string; value?: string }> = {
  P0_USD_E8: { label: 'P0 initial reference price' },
  ROUND_REWARD_RAW: { label: 'Reward budget per round', value: '750,000,000 FUSE × 10 rounds = 7,500,000,000' },
  PRICE_LADDER: { label: 'Price ladder P0×2ⁿ', value: '10 rounds / up to 1024×P0' },
  MIN_QUALIFIED_CANDLES: { label: 'Qualified candle threshold', value: '8 / 12 (otherwise permanently closed and principal burned)' },
  BURN_SEMANTICS: { label: 'Failure burn semantics', value: 'Reward budget + all accepted principal of this round' },
  TOKEN_DECIMALS: { label: 'Jetton decimals (D-02)', value: '9 (proposed, pending confirmation)' },
  ORACLE_CONFIG: { label: 'Oracle & data sources (D-04~D-09)', value: 'TBD (demo source has no on-chain authority)' },
  REWARD_FORMULA: { label: 'Reward formula (D-14)', value: 'MVP default: pro rata to accepted stake' },
  MULTISIG: { label: 'Multisig threshold (D-23)', value: 'Suggested 3/5 or equivalent independent governance' },
  AUDIT: { label: 'Contract audit (D-24 prerequisite)', value: 'Pending audit / report publication' },
};

function frozenLabel(key: string, fallback: string, lang: 'zh' | 'en'): string {
  return lang === 'zh' ? fallback : FROZEN_EN[key]?.label ?? fallback;
}

/** 运行时长：后端若误传 Unix 时间戳（>10 年），显示 — 而不是荒谬的天数。 */
function uptimeText(seconds: number | null | undefined, lang: 'zh' | 'en'): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0 || seconds > 315360000) return '—';
  return durationText(seconds, lang);
}

/** 冻结项里的价格字符串统一压缩为 4 位有效数字（$0.00400 → $0.004）。 */
function frozenValue(value: string): string {
  const match = /^\$([0-9]*\.?[0-9]+)$/.exec(value.trim());
  if (!match) return value;
  const usd = Number(match[1]);
  if (!Number.isFinite(usd)) return value;
  return formatPrice(String(Math.round(usd * 1e8)));
}

function readToken(): string {
  try {
    return window.sessionStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

function saveToken(value: string): void {
  try {
    if (value) window.sessionStorage.setItem(TOKEN_KEY, value);
    else window.sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

interface AdminDict extends Record<string, unknown> {
  lbl: string;
  title: string;
  desc: string;
  healthTitle: string;
  healthDesc: string;
  healthOk: string;
  healthDown: string;
  healthWorker: string;
  healthVersion: string;
  healthDb: string;
  healthDataSource: string;
  healthUptime: string;
  healthNow: string;
  healthNotReached: string;
  loginTitle: string;
  loginDesc: string;
  loginField: string;
  loginPlaceholder: string;
  loginButton: string;
  loginBusy: string;
  loginEmpty: string;
  loginInvalid: string;
  howToTitle: string;
  howTo: string[];
  sessionNote: string;
  logout: string;
  loggedIn: string;
  tokenExpiredTitle: string;
  tokenExpiredDesc: string;
  reLogin: string;
  actionsTitle: string;
  actionsDesc: string;
  actionTick: string;
  actionTickHint: string;
  actionPause: string;
  actionPauseHint: string;
  actionResume: string;
  actionResumeHint: string;
  actionAdvance: string;
  actionAdvanceHint: string;
  pauseReason: string;
  pauseReasonPlaceholder: string;
  confirmPause: string;
  confirmAdvance: string;
  cancel: string;
  actionOk: string;
  actionFail: string;
  configTitle: string;
  configDesc: string;
  frozenTitle: string;
  frozenFrozen: string;
  frozenPending: string;
  frozenEmpty: string;
  frozenEmptyDesc: string;
  contractsTitle: string;
  notDeployed: string;
  roundsTitle: string;
  roundsDesc: string;
  colRound: string;
  colState: string;
  colTarget: string;
  colCandles: string;
  colStake: string;
  colStakers: string;
  colResult: string;
  colBurned: string;
  colUpdated: string;
  eventsTitle: string;
  eventsDesc: string;
  eventsEmpty: string;
  eventsEmptyDesc: string;
  oracleTitle: string;
  oracleOnline: string;
  oracleOffline: string;
  oraclePaused: string;
  oracleSources: string;
  oracleCoverage: string;
  oracleConfig: string;
  oracleUpdated: string;
  workerTitle: string;
  demoCandle: string;
  statsTitle: string;
  supply: string;
  burned: string;
  lockedStake: string;
  price: string;
  volume24h: string;
  liquidity: string;
  logLevelInfo: string;
  logLevelWarn: string;
  logLevelError: string;
}

const ZH: AdminDict = {
  lbl: '运维后台',
  title: '运维后台',
  desc: '健康检查、协议参数与冻结项、十轮状态、预言机与状态机操作、审计事件。令牌仅保存在当前标签页。',
  healthTitle: '系统健康',
  healthDesc: 'Worker 存活、D1 连通性与数据源',
  healthOk: '运行正常',
  healthDown: '不可达',
  healthWorker: 'Worker 状态',
  healthVersion: '版本',
  healthDb: 'D1 连通',
  healthDataSource: '数据源',
  healthUptime: '运行时长',
  healthNow: '服务器时间',
  healthNotReached: '无法访问 /api/health，请确认 worker 已启动。',
  loginTitle: '管理员登录',
  loginDesc: '使用 ADMIN_TOKEN 以 Bearer 方式访问管理接口。令牌不会写入 localStorage，只保存在本标签页 sessionStorage。',
  loginField: 'ADMIN_TOKEN',
  loginPlaceholder: '输入管理员令牌',
  loginButton: '登录',
  loginBusy: '验证中…',
  loginEmpty: '请输入管理员令牌',
  loginInvalid: '令牌无效或已过期（401）',
  howToTitle: '如何获取令牌',
  howTo: [
    '本地：复制 worker/.dev.vars.example 为 worker/.dev.vars，其中 ADMIN_TOKEN 即本地令牌。',
    '线上：由 Lead 通过 npx wrangler secret put ADMIN_TOKEN 配置，令牌只下发给人，不写进前端代码。',
    '未配置 ADMIN_TOKEN 时管理接口返回 401，这是预期行为。',
  ],
  sessionNote: '登出或关闭标签页后令牌自动失效。',
  logout: '登出',
  loggedIn: '已登录',
  tokenExpiredTitle: '令牌无效',
  tokenExpiredDesc: '当前令牌被服务端拒绝（401）。请重新登录。',
  reLogin: '重新登录',
  actionsTitle: '运维操作',
  actionsDesc: '所有操作都会写入审计日志；推进轮次为不可逆操作，请谨慎确认。',
  actionTick: '手动 Tick',
  actionTickHint: '执行一次状态机推进（幂等，可重复调用）',
  actionPause: '暂停预言机',
  actionPauseHint: '进入 ORACLE_PAUSED：暂停价格考核，不销毁本金',
  actionResume: '恢复预言机',
  actionResumeHint: '从暂停恢复观察流程',
  actionAdvance: '推进轮次',
  actionAdvanceHint: '结算当前轮并开启下一轮（终态后不可回滚）',
  pauseReason: '暂停原因',
  pauseReasonPlaceholder: '例如 oracle_feed_gap',
  confirmPause: '确认暂停',
  confirmAdvance: '确认推进',
  cancel: '取消',
  actionOk: '操作成功，已刷新状态',
  actionFail: '操作失败：',
  configTitle: '协议参数',
  configDesc: '来自 /api/config，只读展示；链上参数冻结后不可由管理员修改',
  frozenTitle: '冻结项',
  frozenFrozen: '已冻结',
  frozenPending: '待确认',
  frozenEmpty: '参数尚未冻结',
  frozenEmptyDesc: '当前配置没有冻结项记录；主网部署前必须完成上线阻断参数的确认与配置哈希冻结。',
  contractsTitle: '合约地址',
  notDeployed: '未部署',
  roundsTitle: '十轮状态',
  roundsDesc: '来自 /api/admin/overview，轮次阈值与目标价不可被管理员修改',
  colRound: '轮次',
  colState: '状态',
  colTarget: '目标价',
  colCandles: '观察/达标',
  colStake: '本轮质押',
  colStakers: '地址数',
  colResult: '结果',
  colBurned: '已销毁',
  colUpdated: '更新时间',
  eventsTitle: '审计事件',
  eventsDesc: '最近的管理员操作与系统事件',
  eventsEmpty: '暂无审计事件',
  eventsEmptyDesc: '管理员操作或系统状态变化后会在此出现记录。',
  oracleTitle: '预言机状态',
  oracleOnline: '在线',
  oracleOffline: '离线',
  oraclePaused: '已暂停',
  oracleSources: '有效来源',
  oracleCoverage: '覆盖率',
  oracleConfig: '配置版本',
  oracleUpdated: '最近更新',
  workerTitle: 'Worker',
  demoCandle: '演示 K 线时长（秒）',
  statsTitle: '协议统计',
  supply: '供应量',
  burned: '已销毁',
  lockedStake: '锁定质押',
  price: '现价',
  volume24h: '24h 成交',
  liquidity: '流动性',
  logLevelInfo: '信息',
  logLevelWarn: '警告',
  logLevelError: '错误',
};

const EN: AdminDict = {
  lbl: 'Admin',
  title: 'Admin Console',
  desc: 'Health, protocol parameters and frozen items, ten-round status, oracle and state-machine actions, audit events. The token is kept in this tab only.',
  healthTitle: 'System health',
  healthDesc: 'Worker liveness, D1 connectivity and data source',
  healthOk: 'Healthy',
  healthDown: 'Unreachable',
  healthWorker: 'Worker status',
  healthVersion: 'Version',
  healthDb: 'D1',
  healthDataSource: 'Data source',
  healthUptime: 'Uptime',
  healthNow: 'Server time',
  healthNotReached: 'Cannot reach /api/health. Make sure the worker is running.',
  loginTitle: 'Admin login',
  loginDesc: 'Use ADMIN_TOKEN as a Bearer token for admin endpoints. The token is never written to localStorage — only to this tab’s sessionStorage.',
  loginField: 'ADMIN_TOKEN',
  loginPlaceholder: 'Enter admin token',
  loginButton: 'Sign in',
  loginBusy: 'Verifying…',
  loginEmpty: 'Enter the admin token',
  loginInvalid: 'Invalid or expired token (401)',
  howToTitle: 'How to get the token',
  howTo: [
    'Local: copy worker/.dev.vars.example to worker/.dev.vars — ADMIN_TOKEN inside is your local token.',
    'Live: configured by the Lead via npx wrangler secret put ADMIN_TOKEN; the secret is handed to people, never baked into the frontend.',
    'Without ADMIN_TOKEN the admin endpoints return 401 by design.',
  ],
  sessionNote: 'The token is cleared when you sign out or close the tab.',
  logout: 'Sign out',
  loggedIn: 'Signed in',
  tokenExpiredTitle: 'Invalid token',
  tokenExpiredDesc: 'The server rejected the current token (401). Please sign in again.',
  reLogin: 'Sign in again',
  actionsTitle: 'Operations',
  actionsDesc: 'Every action is written to the audit log. Advancing a round is irreversible — confirm carefully.',
  actionTick: 'Manual tick',
  actionTickHint: 'Run one state-machine step (idempotent, safe to repeat)',
  actionPause: 'Pause oracle',
  actionPauseHint: 'Enter ORACLE_PAUSED: price test is paused, principal is never burned',
  actionResume: 'Resume oracle',
  actionResumeHint: 'Resume the observation flow from paused',
  actionAdvance: 'Advance round',
  actionAdvanceHint: 'Settle the current round and open the next one (irreversible once terminal)',
  pauseReason: 'Pause reason',
  pauseReasonPlaceholder: 'e.g. oracle_feed_gap',
  confirmPause: 'Confirm pause',
  confirmAdvance: 'Confirm advance',
  cancel: 'Cancel',
  actionOk: 'Done — state refreshed',
  actionFail: 'Action failed: ',
  configTitle: 'Protocol parameters',
  configDesc: 'From /api/config, read-only. On-chain parameters cannot be changed by an admin once frozen',
  frozenTitle: 'Frozen items',
  frozenFrozen: 'Frozen',
  frozenPending: 'Pending',
  frozenEmpty: 'Parameters not frozen yet',
  frozenEmptyDesc: 'No frozen parameter records in the current config. Blocking parameters must be confirmed and hashed before mainnet deployment.',
  contractsTitle: 'Contracts',
  notDeployed: 'Not deployed',
  roundsTitle: 'Ten rounds',
  roundsDesc: 'From /api/admin/overview. Thresholds and target prices cannot be changed by an admin',
  colRound: 'Round',
  colState: 'Status',
  colTarget: 'Target',
  colCandles: 'Seen / qualified',
  colStake: 'Staked',
  colStakers: 'Stakers',
  colResult: 'Result',
  colBurned: 'Burned',
  colUpdated: 'Updated',
  eventsTitle: 'Audit events',
  eventsDesc: 'Recent admin actions and system events',
  eventsEmpty: 'No audit events',
  eventsEmptyDesc: 'Records appear here after admin actions or system state changes.',
  oracleTitle: 'Oracle',
  oracleOnline: 'Online',
  oracleOffline: 'Offline',
  oraclePaused: 'Paused',
  oracleSources: 'Valid sources',
  oracleCoverage: 'Coverage',
  oracleConfig: 'Config version',
  oracleUpdated: 'Last update',
  workerTitle: 'Worker',
  demoCandle: 'Demo candle seconds',
  statsTitle: 'Protocol stats',
  supply: 'Supply',
  burned: 'Burned',
  lockedStake: 'Locked stake',
  price: 'Price',
  volume24h: '24h volume',
  liquidity: 'Liquidity',
  logLevelInfo: 'INFO',
  logLevelWarn: 'WARN',
  logLevelError: 'ERROR',
};

export default function AdminPage() {
  const { lang } = useLang();
  const d = useDict(ZH, EN);
  const c = COMMON[lang];
  const { toast, show } = useToast();

  const [token, setToken] = useState<string>(() => readToken());
  const [input, setInput] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [pauseReason, setPauseReason] = useState('');
  const [pauseOpen, setPauseOpen] = useState(false);

  const healthQuery = useQuery(() => api.health(), [], { intervalMs: 10000 });
  const configQuery = useQuery(() => api.config(), [], { intervalMs: 0 });
  const overviewQuery = useQuery(() => api.admin.overview(token), [token], {
    enabled: token.length > 0,
    intervalMs: 5000,
  });

  const unauthorized = overviewQuery.error?.code === 'UNAUTHORIZED';

  useEffect(() => {
    if (!unauthorized) return;
    saveToken('');
    setToken('');
    setLoginError(d.loginInvalid);
  }, [unauthorized, d.loginInvalid]);

  const decimals = configQuery.data?.token.decimals ?? 9;
  const config = configQuery.data;
  const overview = overviewQuery.data;
  const health = healthQuery.data;

  const signIn = useCallback(async () => {
    const value = input.trim();
    if (!value) {
      setLoginError(d.loginEmpty);
      return;
    }
    setLoggingIn(true);
    setLoginError(null);
    try {
      await api.admin.overview(value);
      saveToken(value);
      setToken(value);
      setInput('');
    } catch (error) {
      const apiError = error as ApiError;
      setLoginError(apiError.code === 'UNAUTHORIZED' ? d.loginInvalid : apiErrorText(apiError, lang));
    } finally {
      setLoggingIn(false);
    }
  }, [input, d.loginEmpty, d.loginInvalid, lang]);

  const signOut = useCallback(() => {
    saveToken('');
    setToken('');
    setInput('');
    setLoginError(null);
  }, []);

  const runAction = useCallback(
    async (key: string, run: () => Promise<unknown>) => {
      if (!token) return;
      setBusy(key);
      try {
        await run();
        overviewQuery.refresh();
        healthQuery.refresh();
        show(d.actionOk, 'ok');
      } catch (error) {
        show(`${d.actionFail}${apiErrorText(error as ApiError, lang)}`, 'bad');
      } finally {
        setBusy(null);
      }
    },
    [token, overviewQuery.refresh, healthQuery.refresh, show, d.actionOk, d.actionFail, lang],
  );

  const configRows: { label: string; value: ReactNode }[] = config
    ? [
        { label: lang === 'zh' ? '代币' : 'Token', value: `${config.token.name} (${config.token.symbol})` },
        { label: lang === 'zh' ? '精度 decimals' : 'Decimals', value: String(config.token.decimals) },
        { label: 'P0', value: formatPrice(config.p0UsdE8) },
        { label: lang === 'zh' ? '价格倍数' : 'Price multiplier', value: `×${config.priceMultiplier}` },
        { label: lang === 'zh' ? '轮次总数' : 'Rounds', value: String(config.roundCount) },
        { label: lang === 'zh' ? '每轮奖励' : 'Reward / round', value: `${formatToken(config.roundRewardRaw, decimals)} FUSE` },
        { label: lang === 'zh' ? '总供应' : 'Total supply', value: `${formatToken(config.totalSupplyRaw, decimals)} FUSE` },
        { label: lang === 'zh' ? 'K 线周期' : 'Candle length', value: secondsHint(config.candleSeconds) },
        { label: lang === 'zh' ? 'K 线根数' : 'Candle count', value: String(config.candleCount) },
        { label: lang === 'zh' ? '达标阈值' : 'Min qualified', value: String(config.minQualifiedCandles) },
        { label: lang === 'zh' ? '风险确认版本' : 'Risk version', value: String(config.riskDisclosureVersion) },
        { label: lang === 'zh' ? '质押窗口' : 'Stake window', value: secondsHint(config.stakeDurationSeconds) },
        { label: lang === 'zh' ? '观察窗口' : 'Observation', value: secondsHint(config.observationSeconds) },
        { label: lang === 'zh' ? '网络' : 'Network', value: config.network },
        { label: lang === 'zh' ? '数据源' : 'Data source', value: <DataSourceChip value={config.dataSource} /> },
        { label: 'TON/USD', value: formatPrice(config.tonUsdE8) },
        { label: 'TON Connect manifest', value: config.tonConnectManifestUrl ?? d.notDeployed },
      ]
    : [];

  const contractRows: { label: string; value: string | null }[] = config
    ? [
        { label: 'Jetton Master', value: config.contracts.jettonMaster },
        { label: 'Round Controller', value: config.contracts.roundController },
        { label: 'Staking Vault', value: config.contracts.stakingVault },
        { label: 'Reward Vault', value: config.contracts.rewardVault },
        { label: 'Oracle Adapter', value: config.contracts.oracleAdapter },
        { label: 'Code hash', value: config.contracts.codeHash },
        { label: 'Oracle config hash', value: config.contracts.oracleConfigHash },
        { label: 'Multisig', value: config.contracts.multisig },
        { label: 'Audit report', value: config.contracts.auditReportUrl },
      ]
    : [];

  const healthOk = health?.ok === true;

  return (
    <>
      <SiteHeader />
      <main className="wrap page ap-page">
        <PageHead
          lbl={d.lbl}
          title={d.title}
          desc={d.desc}
          right={
            <div className="ap-toolbar">
              <span className={`chip ${healthQuery.error ? 'bad' : healthOk ? 'ok' : 'pend'}`}>
                {healthQuery.error ? d.healthDown : healthOk ? d.healthOk : c.loading}
              </span>
              {token ? (
                <>
                  <span className="chip ok">{d.loggedIn}</span>
                  <button className="btn ghost sm" type="button" onClick={signOut}>
                    {d.logout}
                  </button>
                </>
              ) : null}
            </div>
          }
        />

        {/* 健康检查 */}
        <section className="ap-sec">
          <div className="ap-sec-h">
            <h2>{d.healthTitle}</h2>
            <p className="ap-sec-desc">{d.healthDesc}</p>
          </div>
          {healthQuery.error && !health ? (
            <ErrorState error={healthQuery.error} onRetry={healthQuery.refresh} title={d.healthNotReached} />
          ) : !health ? (
            <Loading rows={2} />
          ) : (
            <div className="cards">
              <Stat
                label={d.healthWorker}
                value={health.ok ? d.healthOk : d.healthDown}
                tone={health.ok ? 'ok' : 'bad'}
                hint={`${d.healthVersion} ${health.version}`}
              />
              <Stat label={d.healthDb} value={health.db ? 'OK' : 'FAIL'} tone={health.db ? 'ok' : 'bad'} />
              <Stat label={d.healthDataSource} value={<DataSourceChip value={health.dataSource} />} />
              <Stat label={d.healthUptime} value={uptimeText(health.uptimeSeconds, lang)} />
              <Stat label={d.healthNow} value={formatDateTime(health.now)} />
              {overview?.worker?.demoCandleSeconds !== null && overview?.worker?.demoCandleSeconds !== undefined ? (
                <Stat label={d.demoCandle} value={String(overview.worker.demoCandleSeconds)} hint={overview.worker.dataSource} />
              ) : null}
            </div>
          )}
        </section>

        {/* 登录 / 令牌无效 */}
        {!token ? (
          <section className="panel ap-sec">
            <div className="ap-panel-h">
              <h3>{d.loginTitle}</h3>
            </div>
            <div className="ap-pad">
              <div className="ap-login">
                <p className="note" style={{ marginTop: 0 }}>
                  {d.loginDesc}
                </p>
                <div className="field">
                  <label htmlFor="admin-token">{d.loginField}</label>
                  <input
                    id="admin-token"
                    type="password"
                    autoComplete="off"
                    placeholder={d.loginPlaceholder}
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void signIn();
                    }}
                  />
                </div>
                {loginError ? <div className="err-box">{loginError}</div> : null}
                <div className="row">
                  <button className="btn fire" type="button" disabled={loggingIn} onClick={() => void signIn()}>
                    {loggingIn ? d.loginBusy : d.loginButton}
                  </button>
                  <span className="ap-muted mono-sm">{d.sessionNote}</span>
                </div>
                <div className="note-box">
                  <b>{d.howToTitle}</b>
                  <ul className="ap-note-list">
                    {d.howTo.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          </section>
        ) : null}

        {token && unauthorized ? (
          <section className="panel ap-sec">
            <div className="ap-pad">
              <Empty title={d.tokenExpiredTitle} desc={d.tokenExpiredDesc}>
                <button className="btn fire sm" type="button" onClick={signOut}>
                  {d.reLogin}
                </button>
              </Empty>
            </div>
          </section>
        ) : null}

        {/* 运维操作 */}
        {token && !unauthorized ? (
          <section className="panel ap-sec">
            <div className="ap-panel-h">
              <h3>{d.actionsTitle}</h3>
              <span className="ap-muted mono-sm">{d.actionsDesc}</span>
            </div>
            <div className="ap-pad">
              <div className="ap-admin-actions">
                <div className="ap-action">
                  <span className="ap-action-t">
                    <b>{d.actionTick}</b>
                    <small>{d.actionTickHint}</small>
                  </span>
                  <span className="ap-action-ctl">
                    <button
                      className="btn ghost sm"
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void runAction('tick', () => api.admin.tick(token))}
                    >
                      {busy === 'tick' ? '…' : d.actionTick}
                    </button>
                  </span>
                </div>

                <div className="ap-action">
                  <span className="ap-action-t">
                    <b>{d.actionPause}</b>
                    <small>{d.actionPauseHint}</small>
                  </span>
                  <span className="ap-action-ctl">
                    {pauseOpen ? (
                      <>
                        <input
                          type="text"
                          aria-label={d.pauseReason}
                          placeholder={d.pauseReasonPlaceholder}
                          value={pauseReason}
                          onChange={(event) => setPauseReason(event.target.value)}
                        />
                        <button
                          className="btn fire sm"
                          type="button"
                          disabled={busy !== null}
                          onClick={() => {
                            const reason = pauseReason.trim() || 'manual_admin_pause';
                            void runAction('pause', () => api.admin.pauseOracle(token, reason)).then(() => {
                              setPauseOpen(false);
                              setPauseReason('');
                            });
                          }}
                        >
                          {busy === 'pause' ? '…' : d.confirmPause}
                        </button>
                        <button className="btn ghost sm" type="button" onClick={() => setPauseOpen(false)}>
                          {d.cancel}
                        </button>
                      </>
                    ) : (
                      <button className="btn ghost sm" type="button" disabled={busy !== null} onClick={() => setPauseOpen(true)}>
                        {d.actionPause}
                      </button>
                    )}
                  </span>
                </div>

                <div className="ap-action">
                  <span className="ap-action-t">
                    <b>{d.actionResume}</b>
                    <small>{d.actionResumeHint}</small>
                  </span>
                  <span className="ap-action-ctl">
                    <button
                      className="btn ghost sm"
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void runAction('resume', () => api.admin.resumeOracle(token))}
                    >
                      {busy === 'resume' ? '…' : d.actionResume}
                    </button>
                  </span>
                </div>

                <div className="ap-action">
                  <span className="ap-action-t">
                    <b>{d.actionAdvance}</b>
                    <small>{d.actionAdvanceHint}</small>
                  </span>
                  <span className="ap-action-ctl">
                    <ConfirmButton
                      label={d.actionAdvance}
                      confirmLabel={d.confirmAdvance}
                      cancelLabel={d.cancel}
                      busy={busy === 'advance'}
                      disabled={busy !== null}
                      onConfirm={() => void runAction('advance', () => api.admin.advance(token))}
                    />
                  </span>
                </div>
              </div>

              {overview?.oracle ? (
                <div className="ap-round-meta" style={{ marginTop: 14 }}>
                  <div>
                    <span className="lbl">{d.oracleTitle}</span>
                    <div className="v">
                      {overview.oracle.paused ? d.oraclePaused : overview.oracle.online ? d.oracleOnline : d.oracleOffline}
                    </div>
                  </div>
                  <div>
                    <span className="lbl">{d.oracleSources}</span>
                    <div className="v">
                      {overview.oracle.validSources}/{overview.oracle.totalSources}
                    </div>
                  </div>
                  <div>
                    <span className="lbl">{d.oracleCoverage}</span>
                    <div className="v">{(overview.oracle.coverageBps / 100).toFixed(2)}%</div>
                  </div>
                  <div>
                    <span className="lbl">{d.oracleConfig}</span>
                    <div className="v">{overview.oracle.configVersion}</div>
                  </div>
                  <div>
                    <span className="lbl">{d.oracleUpdated}</span>
                    <div className="v">{formatDateTime(overview.oracle.lastUpdate)}</div>
                  </div>
                  {overview.worker ? (
                    <div>
                      <span className="lbl">{d.workerTitle}</span>
                      <div className="v">{uptimeText(overview.worker.uptimeSeconds, lang)}</div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {overview?.stats ? (
                <div className="ap-round-meta" style={{ marginTop: 10 }}>
                  <div>
                    <span className="lbl">{d.supply}</span>
                    <div className="v">{formatToken(overview.stats.supplyRaw, decimals)}</div>
                  </div>
                  <div>
                    <span className="lbl">{d.burned}</span>
                    <div className="v bad">{formatToken(overview.stats.burnedRaw, decimals)}</div>
                  </div>
                  <div>
                    <span className="lbl">{d.lockedStake}</span>
                    <div className="v">{formatToken(overview.stats.lockedStakeRaw, decimals)}</div>
                  </div>
                  <div>
                    <span className="lbl">{d.price}</span>
                    <div className="v hot">{formatPrice(overview.stats.priceUsdE8)}</div>
                  </div>
                  <div>
                    <span className="lbl">{d.volume24h}</span>
                    <div className="v">{formatUsdE8(overview.stats.volume24hUsdE8, { compact: true })}</div>
                  </div>
                  <div>
                    <span className="lbl">{d.liquidity}</span>
                    <div className="v">{formatUsdE8(overview.stats.liquidityUsdE8, { compact: true })}</div>
                  </div>
                  <div>
                    <span className="lbl">{d.healthDataSource}</span>
                    <div className="v">{overview.worker ? <DataSourceChip value={overview.worker.dataSource} /> : '—'}</div>
                  </div>
                  <div>
                    <span className="lbl">{d.healthNow}</span>
                    <div className="v">{overview.worker ? formatDateTime(overview.worker.now) : '—'}</div>
                  </div>
                </div>
              ) : null}
            </div>
          </section>
        ) : null}

        {/* 协议参数 */}
        <section className="panel ap-sec">
          <div className="ap-panel-h">
            <h3>{d.configTitle}</h3>
            <span className="ap-muted mono-sm">{d.configDesc}</span>
          </div>
          <div className="ap-pad">
            {configQuery.error ? (
              <ErrorState error={configQuery.error} onRetry={configQuery.refresh} />
            ) : !config ? (
              <Loading rows={4} />
            ) : (
              <>
                <dl className="ap-kv">
                  {configRows.map((row) => (
                    <div key={row.label}>
                      <dt>{row.label}</dt>
                      <dd>{row.value}</dd>
                    </div>
                  ))}
                </dl>

                <div className="ap-sec-h" style={{ marginTop: 18 }}>
                  <h2>{d.contractsTitle}</h2>
                </div>
                <dl className="ap-kv">
                  {contractRows.map((row) => (
                    <div key={row.label}>
                      <dt>{row.label}</dt>
                      <dd className={row.value ? undefined : 'bad'}>{row.value ?? d.notDeployed}</dd>
                    </div>
                  ))}
                </dl>

                <div className="ap-sec-h" style={{ marginTop: 18 }}>
                  <h2>{d.frozenTitle}</h2>
                </div>
                {config.frozenParams.length === 0 ? (
                  <Empty title={d.frozenEmpty} desc={d.frozenEmptyDesc} />
                ) : (
                  <div className="ap-frozen">
                    {config.frozenParams.map((item) => (
                      <div key={item.key} title={item.key}>
                        <span className="ap-frozen-lab">
                          <span>{frozenLabel(item.key, item.label, lang)}</span>
                          <span className={`chip ${item.status === 'frozen' ? 'ok' : 'pend'}`}>
                            {item.status === 'frozen' ? d.frozenFrozen : d.frozenPending}
                          </span>
                        </span>
                        <b>{frozenValue(lang === 'zh' ? item.value : FROZEN_EN[item.key]?.value ?? item.value)}</b>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </section>

        {/* 十轮状态 */}
        {token && !unauthorized ? (
          <section className="panel ap-sec">
            <div className="ap-panel-h">
              <h3>{d.roundsTitle}</h3>
              <span className="ap-muted mono-sm">{d.roundsDesc}</span>
            </div>
            {overviewQuery.error && !overview ? (
              <div className="ap-pad">
                <ErrorState error={overviewQuery.error} onRetry={overviewQuery.refresh} />
              </div>
            ) : !overview ? (
              <div className="ap-pad">
                <Loading rows={4} />
              </div>
            ) : overview.rounds.length === 0 ? (
              <div className="ap-pad">
                <Empty title={c.noData} />
              </div>
            ) : (
              <div className="ap-table-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>{d.colRound}</th>
                      <th>{d.colState}</th>
                      <th>{d.colTarget}</th>
                      <th>{d.colCandles}</th>
                      <th>{d.colStake}</th>
                      <th>{d.colStakers}</th>
                      <th>{d.colResult}</th>
                      <th>{d.colBurned}</th>
                      <th>{d.colUpdated}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.rounds.map((round) => (
                      <tr key={round.roundId}>
                        <td className="ap-mono">R{round.roundId}</td>
                        <td>
                          <StatePill state={round.state} />
                        </td>
                        <td className="ap-num hot">{formatPrice(round.targetPriceUsdE8)}</td>
                        <td className="ap-num">
                          {round.candlesSeen}/{round.qualifiedCandles}
                        </td>
                        <td className="ap-num">{formatToken(round.totalAcceptedStakeRaw, decimals)}</td>
                        <td className="ap-num">{round.stakerCount}</td>
                        <td>{resultLabel(round.result, lang)}</td>
                        <td className={`ap-num ${round.burnedRaw ? 'bad' : ''}`}>
                          {round.burnedRaw ? formatToken(round.burnedRaw, decimals) : '—'}
                        </td>
                        <td className="ap-mono ap-muted">{formatDateTime(round.updatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ) : null}

        {/* 审计事件 */}
        {token && !unauthorized ? (
          <section className="panel ap-sec">
            <div className="ap-panel-h">
              <h3>{d.eventsTitle}</h3>
              <span className="ap-muted mono-sm">{d.eventsDesc}</span>
            </div>
            {!overview ? (
              <div className="ap-pad">
                <Loading rows={3} />
              </div>
            ) : overview.events.length === 0 ? (
              <div className="ap-pad">
                <Empty title={d.eventsEmpty} desc={d.eventsEmptyDesc} />
              </div>
            ) : (
              <div className="ap-events">
                {[...overview.events]
                  .sort((a, b) => b.ts - a.ts)
                  .map((event) => (
                    <div className="ap-event" key={event.id}>
                      <span>{formatDateTime(event.ts)}</span>
                      <span className={`lv ${event.level}`}>
                        {event.level === 'info' ? d.logLevelInfo : event.level === 'warn' ? d.logLevelWarn : d.logLevelError}
                      </span>
                      <span className="ap-event-detail">
                        <b style={{ color: 'var(--text-2)' }}>{event.actor}</b> · {event.action} · {event.detail}
                      </span>
                    </div>
                  ))}
              </div>
            )}
          </section>
        ) : null}

        {overview?.rounds?.length ? (
          <p className="ap-muted mono-sm" style={{ marginTop: 14 }}>
            {stateLabel(overview.rounds[0]?.state, lang)} · {c.updatedAt} {formatDateTime(overview.worker?.now ?? Date.now())}
          </p>
        ) : null}
      </main>
      <ToastView toast={toast} />
      <SiteFooter />
    </>
  );
}
