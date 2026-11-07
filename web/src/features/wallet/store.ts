import type { MeResponse, RoundSummary } from '@shared/types';
import { api, setAuthBridge } from '../../lib/api';
import { generateDemoAddress, rawToFriendly } from './address';
import { DEMO_WALLET_ENABLED } from './flags';

/** 演示钱包资金（与 worker 的 DEMO_WALLET_BALANCE 对齐：250,000 A9，raw units 9 位）。 */
export const DEMO_A9_BALANCE_RAW = '250000000000000';
/** 演示钱包 TON 余额（人类可读）。 */
export const DEMO_TON_BALANCE = '1,250.00';
/** 演示钱包地址持久化 key。 */
const DEMO_ADDRESS_KEY = 'fuse.wallet.demoAddress';
/** 上次使用的钱包模式。 */
const MODE_KEY = 'fuse.wallet.mode';

export type WalletMode = 'ton' | 'demo';
export type WalletStatus = 'idle' | 'restoring' | 'connecting' | 'connected';

/** 内部状态（对外只暴露 useWallet() 里约定的字段）。 */
export interface WalletStoreState {
  status: WalletStatus;
  mode: WalletMode | null;
  /** 展示 + /api/me 查询用的友好地址（UQ.../EQ...） */
  address: string | null;
  /** TON Connect 返回的 raw 地址 */
  rawAddress: string | null;
  network: 'mainnet' | 'testnet' | 'demo' | null;
  walletName: string | null;
  /** 人类可读 TON 余额 */
  tonBalance: string | null;
  /** A9 raw units（9 位） */
  fuseBalance: string | null;
  error: string | null;
  /** 最近一次连接尝试是否降级为演示钱包 */
  fellBack: boolean;
  /** 降级/提示原因（内部 UI 使用，不进 useWallet 契约） */
  notice: string | null;
  /** TON Connect SDK 是否可用 */
  tonAvailable: boolean;
  /** 当前 TON 钱包是否持有有效登录会话（写接口 Authorization: Bearer） */
  hasSession: boolean;
  /** 写请求在无会话时发出过；用于在钱包按钮上提示「签名登录」 */
  signInRequested: boolean;
}

const INITIAL: WalletStoreState = {
  status: 'idle',
  mode: null,
  address: null,
  rawAddress: null,
  network: null,
  walletName: null,
  tonBalance: null,
  fuseBalance: null,
  error: null,
  fellBack: false,
  notice: null,
  tonAvailable: false,
  hasSession: false,
  signInRequested: false,
};

let state: WalletStoreState = INITIAL;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch {
      /* ignore listener errors */
    }
  });
}

function patch(next: Partial<WalletStoreState>): void {
  if (Object.keys(next).length === 0) return;
  state = { ...state, ...next };
  emit();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getWalletSnapshot(): WalletStoreState {
  return state;
}

/* ------------------------------------------------------------------ */
/* localStorage（隐私模式/禁用时静默降级）                              */
/* ------------------------------------------------------------------ */

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function remove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* TON Connect 懒加载（动态 import，不进首屏 chunk，失败即降级）        */
/* ------------------------------------------------------------------ */

/** TON Connect 回传的 ton_proof 成功项（字段与 SDK 的 TonProofItemReplySuccess 一致）。 */
interface TonProofReplyLike {
  name?: string;
  proof?: {
    timestamp: number;
    domain: { lengthBytes: number; value: string };
    payload: string;
    signature: string;
  };
  error?: unknown;
}

interface TonWalletLike {
  account?: { address?: string; chain?: string; publicKey?: string; walletStateInit?: string } | null;
  device?: { appName?: string } | null;
  name?: string | null;
  /** 仅在带 ton_proof 请求的那次连接中出现；恢复会话时没有 */
  connectItems?: { tonProof?: TonProofReplyLike } | null;
}

/** 发给 POST /api/auth/session 的 proof（服务端 TonProof 形状）。 */
interface TonProofPayload {
  timestamp: number;
  domain: { lengthBytes: number; value: string };
  payload: string;
  signature: string;
  publicKey: string;
  stateInit: string;
}

/** TON Connect 连接请求参数（只用到 tonProof）。 */
type ConnectRequestParams = { state: 'ready'; value: { tonProof: string } } | { state: 'loading' } | null | undefined;

interface TonModalStateLike {
  status?: string;
  closeReason?: string | null;
}

/** 链上交易消息（与 TON Connect SendTransactionRequest.messages 对齐）。 */
export interface TonConnectTxMessage {
  address: string;
  /** nanoTon，字符串 */
  amount: string;
  payload?: string;
  stateInit?: string;
}

/** TON Connect 交易请求。 */
export interface TonConnectTxRequest {
  /** unix 秒；缺省 = now + 5 分钟 */
  validUntil?: number;
  /** TON Connect chain id（'-3' 测试网 / '-239' 主网）；缺省取当前钱包网络 */
  network?: string;
  /** 发送者 raw 地址（'<wc>:<hex>'）；缺省取当前钱包地址 */
  from?: string;
  messages: TonConnectTxMessage[];
}

export interface TonConnectTxResult {
  /** 已签名 BOC（base64） */
  boc: string;
}

interface TonConnectLike {
  connected?: boolean;
  account?: { address?: string; chain?: string } | null;
  onStatusChange(cb: (wallet: TonWalletLike | null) => void, errHandler?: (err: unknown) => void): () => void;
  onModalStateChange(cb: (modal: TonModalStateLike) => void): () => void;
  openModal(): Promise<void>;
  disconnect(): Promise<void>;
  sendTransaction(transaction: {
    validUntil: number;
    network?: string;
    from?: string;
    messages: TonConnectTxMessage[];
  }): Promise<TonConnectTxResult>;
  setConnectRequestParameters(params: ConnectRequestParams): void;
}

let tonUI: TonConnectLike | null = null;
let tonLoad: Promise<TonConnectLike | null> | null = null;

function tonManifestUrl(): string {
  try {
    return new URL('/tonconnect-manifest.json', window.location.origin).toString();
  } catch {
    return '/tonconnect-manifest.json';
  }
}

function twaReturnUrl(): `${string}://${string}` | undefined {
  const w = window as unknown as { Telegram?: { WebApp?: { initData?: string } } };
  if (!w.Telegram?.WebApp?.initData) return undefined;
  const bot = window.location.hostname === 'test.a9.lat'
    ? 'a9_test_bot'
    : (import.meta.env.VITE_TG_BOT_USERNAME as string | undefined);
  return bot ? `https://t.me/${bot}/app` : undefined;
}

async function loadTonConnect(): Promise<TonConnectLike | null> {
  try {
    const mod = (await import('@tonconnect/ui-react')) as unknown as {
      TonConnectUI?: new (options: Record<string, unknown>) => TonConnectLike;
    };
    const Ctor = mod.TonConnectUI;
    if (typeof Ctor !== 'function') return null;
    const ui = new Ctor({
      manifestUrl: tonManifestUrl(),
      language: 'en',
      uiPreferences: { theme: 'DARK', borderRadius: 'none' },
      // Inside Telegram: after approving in the wallet, jump straight back into this Mini App.
      ...(twaReturnUrl() ? { actionsConfiguration: { twaReturnUrl: twaReturnUrl() } } : {}),
    });
    ui.onStatusChange(handleTonWallet, () => {
      /* 单次状态错误不打断 UI，连接失败由 modal 关闭分支处理 */
    });
    ui.onModalStateChange(handleTonModalState);
    tonUI = ui;
    patch({ tonAvailable: true });
    return ui;
  } catch {
    patch({ tonAvailable: false });
    return null;
  }
}

function ensureTon(): Promise<TonConnectLike | null> {
  if (tonLoad) return tonLoad;
  tonLoad = loadTonConnect();
  return tonLoad;
}

function handleTonWallet(wallet: TonWalletLike | null): void {
  const raw = wallet?.account?.address;
  if (wallet && typeof raw === 'string' && raw.length > 0) {
    const chain = String(wallet.account?.chain ?? '');
    const testnet = chain === '-3';
    const address = rawToFriendly(raw, testnet);
    const name = wallet.device?.appName || wallet.name || (testnet ? 'TON Wallet (testnet)' : 'TON Wallet');
    const previous = state.address;
    if (previous && previous !== address) dropSession(previous);
    patch({
      status: 'connected',
      mode: 'ton',
      address,
      rawAddress: raw,
      network: testnet ? 'testnet' : 'mainnet',
      walletName: name,
      error: null,
      fellBack: false,
      notice: null,
      tonBalance: null,
      fuseBalance: null,
    });
    write(MODE_KEY, 'ton');
    // 恢复已保存的会话（同一地址、未过期）；本次连接若回传了 ton_proof，则换取新会话
    activeSession = loadStoredSession(address);
    refreshSessionFlag();
    const proof = tonProofFrom(wallet);
    if (proof) void establishSession(address, proof);
    void doRefreshBalances();
    return;
  }
  // 钱包侧断开：清空地址与余额，但保留演示地址以便下次一键降级
  if (state.mode === 'ton') {
    dropSession(state.address);
    clearWallet();
    remove(MODE_KEY);
  }
}

function handleTonModalState(modal: TonModalStateLike): void {
  if (modal?.status !== 'closed') return;
  if (state.status !== 'connecting') return;
  // 连接成功后 modal 也会 close，给 SDK 一点时间先触发 onStatusChange
  window.setTimeout(() => {
    if (state.status === 'connecting' && !(tonUI && tonUI.connected)) {
      stopConnecting('cancelled');
    }
  }, 350);
}

/* ------------------------------------------------------------------ */
/* 演示钱包                                                            */
/* ------------------------------------------------------------------ */

function pickActiveRound(rounds: RoundSummary[]): RoundSummary | null {
  const active = new Set(['STAKING_OPEN', 'STAKING_CLOSED', 'OBSERVING', 'ORACLE_PAUSED', 'SETTLING_SUCCESS', 'SETTLING_FAILURE']);
  return rounds.find((r) => active.has(r.state)) ?? rounds.find((r) => r.state === 'UNOPENED') ?? rounds[0] ?? null;
}

/**
 * 演示地址：首次选定后持久化，之后不再漂移。
 * 优先取当前轮排行榜第一名（这样「我的战况」能看到演示数据），失败则本地生成 UQ 地址。
 */
async function resolveDemoAddress(): Promise<string> {
  const saved = read(DEMO_ADDRESS_KEY);
  if (saved) return saved;
  let address: string | null = null;
  try {
    const rounds = await api.rounds();
    const round = pickActiveRound(rounds);
    if (round) {
      const rows = await api.leaderboard(round.roundId);
      const top = [...rows].sort((a, b) => a.rank - b.rank).find((row) => row.address && row.amountRaw !== '0');
      if (top) address = top.address;
    }
  } catch {
    /* 离线/后端未就绪：走本地生成 */
  }
  const finalAddress = address ?? generateDemoAddress();
  write(DEMO_ADDRESS_KEY, finalAddress);
  return finalAddress;
}

function adoptDemo(address: string, notice: string | null = null): void {
  write(MODE_KEY, 'demo');
  write(DEMO_ADDRESS_KEY, address);
  patch({
    status: 'connected',
    mode: 'demo',
    address,
    rawAddress: address,
    network: 'demo',
    walletName: null,
    tonBalance: DEMO_TON_BALANCE,
    fuseBalance: DEMO_A9_BALANCE_RAW,
    error: null,
    fellBack: notice !== null,
    notice,
  });
}

function stopConnecting(reason: 'cancelled' | 'unavailable' | 'failed'): void {
  clearWallet();
  remove(MODE_KEY);
  patch({ notice: reason, error: reason === 'cancelled' ? null : reason });
}

function clearWallet(): void {
  activeSession = null;
  patch({
    status: 'idle',
    mode: null,
    address: null,
    rawAddress: null,
    network: null,
    walletName: null,
    tonBalance: null,
    fuseBalance: null,
    error: null,
    fellBack: false,
    notice: null,
    hasSession: false,
    signInRequested: false,
  });
}

/* ------------------------------------------------------------------ */
/* 登录会话（TON Proof → 会话 token，写接口走 Authorization: Bearer）    */
/* ------------------------------------------------------------------ */

interface StoredSession {
  address: string;
  token: string;
  /** 毫秒时间戳（服务端返回的 expiresAt） */
  expiresAt: number;
}

/** 按地址持久化的会话 key（与演示钱包 key 分开）。 */
const SESSION_KEY_PREFIX = 'fuse.wallet.session.';
/** 当前 TON 钱包的会话；localStorage 不可用时仍在本页内有效。 */
let activeSession: StoredSession | null = null;

function sessionKey(address: string): string {
  return SESSION_KEY_PREFIX + address;
}

function isLiveSession(session: StoredSession | null, address: string | null): boolean {
  return !!session && !!address && session.address === address && session.expiresAt > Date.now();
}

function loadStoredSession(address: string): StoredSession | null {
  const raw = read(sessionKey(address));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (parsed && typeof parsed.token === 'string' && typeof parsed.expiresAt === 'number') {
      const session: StoredSession = { address, token: parsed.token, expiresAt: parsed.expiresAt };
      if (isLiveSession(session, address)) return session;
    }
  } catch {
    /* 损坏的记录直接丢弃 */
  }
  remove(sessionKey(address));
  return null;
}

function refreshSessionFlag(): void {
  const hasSession = isLiveSession(activeSession, state.address);
  if (state.hasSession !== hasSession) patch({ hasSession, signInRequested: hasSession ? false : state.signInRequested });
}

/** 清除某地址的会话（断开连接 / 切换地址时调用）。 */
function dropSession(address: string | null): void {
  if (!address) return;
  remove(sessionKey(address));
  if (activeSession?.address === address) activeSession = null;
  refreshSessionFlag();
}

/** 从 TON Connect 连接结果取出 ton_proof；缺 publicKey / stateInit 时服务端无法验签，视为无 proof。 */
function tonProofFrom(wallet: TonWalletLike): TonProofPayload | null {
  const item = wallet.connectItems?.tonProof;
  const proof = item && item.name === 'ton_proof' ? item.proof : undefined;
  const publicKey = wallet.account?.publicKey;
  const stateInit = wallet.account?.walletStateInit;
  if (!proof || !publicKey || !stateInit) return null;
  return { ...proof, publicKey, stateInit };
}

/** 用本次连接回传的 ton_proof 换取会话 token；失败时保持「需要签名登录」。 */
async function establishSession(address: string, proof: TonProofPayload): Promise<void> {
  try {
    const session = await api.authSession({ address, proof });
    if (state.address !== address || state.mode !== 'ton') return; // 钱包已切换，丢弃旧结果
    activeSession = { address, token: session.token, expiresAt: session.expiresAt };
    write(sessionKey(address), JSON.stringify(activeSession));
    refreshSessionFlag();
  } catch {
    /* 签名未通过或服务不可用：仍是未登录会话，写操作时由钱包按钮提示签名登录 */
  }
}

/** 每次连接前下发新的登录挑战；拿不到挑战时仍允许连接（之后可「签名登录」）。 */
async function applyConnectChallenge(ui: TonConnectLike): Promise<void> {
  let params: ConnectRequestParams = null;
  try {
    const challenge = await api.authChallenge();
    params = { state: 'ready', value: { tonProof: challenge.payload } };
  } catch {
    params = null;
  }
  ui.setConnectRequestParameters(params);
}

/** api.ts 请求层使用：当前钱包的有效会话 token。 */
function currentSessionToken(): string | null {
  if (state.mode !== 'ton' || state.status !== 'connected') return null;
  const session = activeSession;
  if (session && isLiveSession(session, state.address)) return session.token;
  if (session) dropSession(session.address);
  return null;
}

/** api.ts 请求层使用：TON 钱包无会话时发出了写请求，记下来以便提示签名登录。 */
function onWriteWithoutSession(): void {
  if (state.mode !== 'ton' || state.status !== 'connected' || state.hasSession) return;
  if (!state.signInRequested) patch({ signInRequested: true });
}

setAuthBridge({ token: currentSessionToken, missingSession: onWriteWithoutSession });

/* ------------------------------------------------------------------ */
/* 余额                                                               */
/* ------------------------------------------------------------------ */

async function fetchTonBalance(address: string, testnet: boolean): Promise<string | null> {
  try {
    const base = testnet ? 'https://testnet.toncenter.com' : 'https://toncenter.com';
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? window.setTimeout(() => controller.abort(), 6000) : null;
    const res = await fetch(`${base}/api/v2/getAddressBalance?address=${encodeURIComponent(address)}`, {
      signal: controller ? controller.signal : undefined,
    });
    if (timer !== null) window.clearTimeout(timer);
    if (!res.ok) return null;
    const json = (await res.json()) as { ok?: boolean; result?: unknown };
    if (!json || json.ok !== true || typeof json.result !== 'string') return null;
    const nano = Number(json.result);
    if (!Number.isFinite(nano)) return null;
    return (nano / 1e9).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  } catch {
    return null;
  }
}

async function doRefreshBalances(): Promise<void> {
  if (state.status !== 'connected' || !state.address) return;
  if (state.mode === 'demo') {
    patch({ tonBalance: DEMO_TON_BALANCE, fuseBalance: DEMO_A9_BALANCE_RAW });
    return;
  }
  const address = state.address;
  const network = state.network;
  const ton = await fetchTonBalance(address, network === 'testnet');
  // 真实钱包：Jetton 未上线，A9 余额一律显示「—」（由 UI 渲染为占位）
  let fuse: string | null = null;
  try {
    const me = (await api.me(address)) as MeResponse & { balanceRaw?: string };
    if (typeof me.balanceRaw === 'string') fuse = me.balanceRaw;
  } catch {
    /* 后端不可用时不阻塞钱包 UI */
  }
  if (state.address !== address || state.network !== network || state.mode !== 'ton' || state.status !== 'connected') return; // Discard responses from an old wallet or network.
  patch({ tonBalance: ton, fuseBalance: fuse });
}

/* ------------------------------------------------------------------ */
/* 初始化 / 动作                                                       */
/* ------------------------------------------------------------------ */

let initPromise: Promise<void> | null = null;

async function bootstrap(): Promise<void> {
  if (typeof window === 'undefined') return;
  const savedMode = read(MODE_KEY);
  const savedDemo = read(DEMO_ADDRESS_KEY);
  if (savedMode === 'demo' && !DEMO_WALLET_ENABLED) {
    // A demo session saved by an earlier build must not come back as a fake balance.
    remove(MODE_KEY);
    remove(DEMO_ADDRESS_KEY);
    patch({ status: 'idle' });
    return;
  }
  if (savedMode === 'demo') {
    adoptDemo(savedDemo ?? (await resolveDemoAddress()));
    return;
  }
  if (savedMode === 'ton') {
    patch({ status: 'restoring' });
    const ui = await ensureTon();
    if (!ui) {
      patch({ status: 'idle' });
      return;
    }
    window.setTimeout(() => {
      if (state.status === 'restoring') {
        remove(MODE_KEY);
        patch({ status: 'idle' });
      }
    }, 3000);
  }
}

/** 幂等初始化：Provider 挂载或首次 useWallet/connect 时调用。 */
export function ensureWalletInit(): Promise<void> {
  if (!initPromise) initPromise = bootstrap().catch(() => undefined);
  return initPromise;
}

/** 连接 TON 钱包；取消或失败保持未连接，演示身份必须由用户主动选择。 */
export function connect(): void {
  void (async () => {
    void ensureWalletInit();
    if (state.status === 'connecting') return;
    patch({ status: 'connecting', error: null, notice: null, fellBack: false });
    if (!tonUI) tonLoad = null; // 允许重试
    const ui = await ensureTon();
    if (!ui) {
      stopConnecting('unavailable');
      return;
    }
    try {
      await applyConnectChallenge(ui);
      await ui.openModal();
    } catch {
      stopConnecting('failed');
    }
  })();
}

/**
 * 重新签名登录：TON Connect 已连接时不会再次返回 ton_proof，所以先断开，再用新挑战重新连接（会弹出钱包确认）。
 */
export function signIn(): void {
  void (async () => {
    const ui = tonUI;
    if (ui && state.mode === 'ton' && state.status === 'connected') {
      const previous = state.address;
      try {
        await ui.disconnect();
      } catch {
        /* ignore */
      }
      dropSession(previous);
      clearWallet();
      remove(MODE_KEY);
    }
    connect();
  })();
}

/** 直接使用演示钱包（跳过 TON Connect）。 */
export function connectDemo(): void {
  if (!DEMO_WALLET_ENABLED) return;
  void (async () => {
    void ensureWalletInit();
    const address = await resolveDemoAddress();
    adoptDemo(address);
  })();
}

/** 换一个新的演示地址（用于演示空态；会覆盖已持久化的演示地址）。 */
export function resetDemoWallet(): void {
  if (!DEMO_WALLET_ENABLED) return;
  adoptDemo(generateDemoAddress());
}

/** 断开钱包：清空地址与余额（余额不保留上一个地址的数据）。 */
export function disconnect(): void {
  void (async () => {
    const address = state.address;
    const ui = tonUI;
    if (ui) {
      try {
        await ui.disconnect();
      } catch {
        /* ignore */
      }
    }
    dropSession(address);
    clearWallet();
    remove(MODE_KEY);
  })();
}

/** 重新拉取余额（TON 走 toncenter 只读查询，失败显示 —）。 */
export function refreshBalances(): Promise<void> {
  return doRefreshBalances();
}
/* ------------------------------------------------------------------ */
/* 链上交易（后续阶段新增，不影响既有只读契约）                         */
/* ------------------------------------------------------------------ */

/** 当前 TON Connect 可用性快照（供链上模块判断能否发交易）。 */
export interface TonConnectState {
  /** SDK 是否加载成功 */
  available: boolean;
  connected: boolean;
  /** 友好地址（UQ.../kQ...） */
  address: string | null;
  /** TON Connect raw 地址（'<wc>:<hex>'） */
  rawAddress: string | null;
  /** 当前钱包网络 */
  network: 'mainnet' | 'testnet' | 'demo' | null;
  walletName: string | null;
}

export function getTonConnectState(): TonConnectState {
  return {
    available: state.tonAvailable && tonUI !== null,
    connected: state.status === 'connected' && !!state.address && state.mode === 'ton',
    address: state.address,
    rawAddress: state.rawAddress,
    network: state.network,
    walletName: state.walletName,
  };
}

function txError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

/**
 * 通过现有单实例 TonConnectUI 发起交易（不新建实例，复用钱包连接）。
 * 用户拒绝时抛出的错误带 code=300（TON Connect 约定），由调用方分类提示。
 */
export async function sendTonConnectTransaction(tx: TonConnectTxRequest): Promise<TonConnectTxResult> {
  void ensureWalletInit();
  if (!tx || !Array.isArray(tx.messages) || tx.messages.length === 0) {
    throw txError('交易消息为空', 'TONCONNECT_BAD_REQUEST');
  }
  const ui = tonUI ?? (await ensureTon());
  if (!ui) throw txError('TON Connect SDK 不可用', 'TONCONNECT_UNAVAILABLE');
  if (state.status !== 'connected' || !state.address) {
    throw txError('钱包未连接', 'WALLET_NOT_CONNECTED');
  }
  if (state.mode !== 'ton') {
    throw txError('演示钱包不能签名，请连接真实 GRAM 钱包', 'DEMO_WALLET');
  }
  const network =
    tx.network ?? (state.network === 'testnet' ? '-3' : state.network === 'mainnet' ? '-239' : undefined);
  const response = await ui.sendTransaction({
    validUntil: tx.validUntil ?? Math.floor(Date.now() / 1000) + 300,
    network,
    from: tx.from ?? state.rawAddress ?? undefined,
    messages: tx.messages,
  });
  const boc = response && typeof response.boc === 'string' ? response.boc : '';
  if (!boc) throw txError('钱包未返回已签名 BOC', 'TONCONNECT_EMPTY_BOC');
  return { boc };
}
