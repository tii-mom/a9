import type { MeResponse, RoundSummary } from '@shared/types';
import { api } from '../../lib/api';
import { generateDemoAddress, rawToFriendly } from './address';

/** 演示钱包资金（与 worker 的 DEMO_WALLET_BALANCE 对齐：250,000 FUSE，raw units 9 位）。 */
export const DEMO_FUSE_BALANCE_RAW = '250000000000000';
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
  /** FUSE raw units（9 位） */
  fuseBalance: string | null;
  error: string | null;
  /** 最近一次连接尝试是否降级为演示钱包 */
  fellBack: boolean;
  /** 降级/提示原因（内部 UI 使用，不进 useWallet 契约） */
  notice: string | null;
  /** TON Connect SDK 是否可用 */
  tonAvailable: boolean;
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

interface TonWalletLike {
  account?: { address?: string; chain?: string } | null;
  device?: { appName?: string } | null;
  name?: string | null;
}

interface TonModalStateLike {
  status?: string;
  closeReason?: string | null;
}

interface TonConnectLike {
  connected?: boolean;
  account?: { address?: string; chain?: string } | null;
  onStatusChange(cb: (wallet: TonWalletLike | null) => void, errHandler?: (err: unknown) => void): () => void;
  onModalStateChange(cb: (modal: TonModalStateLike) => void): () => void;
  openModal(): Promise<void>;
  disconnect(): Promise<void>;
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
    void doRefreshBalances();
    return;
  }
  // 钱包侧断开：清空地址与余额，但保留演示地址以便下次一键降级
  if (state.mode === 'ton') {
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
      void fallbackToDemo('cancelled');
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
    fuseBalance: DEMO_FUSE_BALANCE_RAW,
    error: null,
    fellBack: notice !== null,
    notice,
  });
}

async function fallbackToDemo(reason: 'cancelled' | 'unavailable' | 'failed'): Promise<void> {
  try {
    const address = await resolveDemoAddress();
    adoptDemo(address, reason);
  } catch {
    adoptDemo(generateDemoAddress(), reason);
  }
}

function clearWallet(): void {
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
  });
}

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
    patch({ tonBalance: DEMO_TON_BALANCE, fuseBalance: DEMO_FUSE_BALANCE_RAW });
    return;
  }
  const address = state.address;
  const network = state.network;
  const ton = await fetchTonBalance(address, network === 'testnet');
  // 真实钱包：Jetton 未上线，FUSE 余额一律显示「—」（由 UI 渲染为占位）
  let fuse: string | null = null;
  try {
    const me = (await api.me(address)) as MeResponse & { balanceRaw?: string };
    if (typeof me.balanceRaw === 'string') fuse = me.balanceRaw;
  } catch {
    /* 后端不可用时不阻塞钱包 UI */
  }
  if (state.address !== address) return; // 期间已切换地址，丢弃旧结果
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

/** 连接钱包：优先 TON Connect（只读）；不可用/用户取消/失败 → 降级演示钱包。 */
export function connect(): void {
  void (async () => {
    void ensureWalletInit();
    if (state.status === 'connecting') return;
    patch({ status: 'connecting', error: null, notice: null, fellBack: false });
    if (!tonUI) tonLoad = null; // 允许重试
    const ui = await ensureTon();
    if (!ui) {
      await fallbackToDemo('unavailable');
      return;
    }
    try {
      await ui.openModal();
    } catch {
      await fallbackToDemo('failed');
    }
  })();
}

/** 直接使用演示钱包（跳过 TON Connect）。 */
export function connectDemo(): void {
  void (async () => {
    void ensureWalletInit();
    const address = await resolveDemoAddress();
    adoptDemo(address);
  })();
}

/** 换一个新的演示地址（用于演示空态；会覆盖已持久化的演示地址）。 */
export function resetDemoWallet(): void {
  adoptDemo(generateDemoAddress());
}

/** 断开钱包：清空地址与余额（余额不保留上一个地址的数据）。 */
export function disconnect(): void {
  void (async () => {
    const ui = tonUI;
    if (ui) {
      try {
        await ui.disconnect();
      } catch {
        /* ignore */
      }
    }
    clearWallet();
    remove(MODE_KEY);
  })();
}

/** 重新拉取余额（TON 走 toncenter 只读查询，失败显示 —）。 */
export function refreshBalances(): void {
  void doRefreshBalances();
}
