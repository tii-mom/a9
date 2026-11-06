/**
 * TON 只读 RPC（toncenter / tonapi）：Jetton Wallet 地址解析与交易回执轮询。
 * 全部为只读查询；发送交易走 TON Connect（wallet 模块）。
 */

import {
  base64Decode,
  looksLikeRawAddress,
  parseTonAddress,
  toRawAddress,
  toFriendlyAddress,
  type TonAddress,
} from './address';
import { beginCell, CellSlice, parseBocBase64, toBocBase64 } from './cell';
import type { ChainConfig } from './config';
import { decodeUserAction } from './decode';
import { chainError, ChainError } from './errors';
import { GET_METHODS } from './protocol';

export interface ResolvedJettonWallet {
  raw: string;
  friendly: string;
}

interface FetchOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  method?: 'GET' | 'POST';
  body?: unknown;
  headers?: Record<string, string>;
}

async function fetchJson(url: string, options: FetchOptions = {}): Promise<unknown> {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeoutMs = options.timeoutMs ?? 12000;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const onAbort = () => controller?.abort();
  if (options.signal) {
    if (options.signal.aborted) controller?.abort();
    else options.signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        accept: 'application/json',
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(options.headers ?? {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller?.signal,
    });
    if (!response.ok) {
      throw chainError('NETWORK_ERROR', 'HTTP ' + response.status, url);
    }
    return (await response.json()) as unknown;
  } catch (error) {
    if (error instanceof ChainError) throw error;
    throw chainError('NETWORK_ERROR', error instanceof Error ? error.message : String(error), url);
  } finally {
    if (timer !== null) clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

function apiKeyHeaders(chain: ChainConfig): Record<string, string> {
  return chain.toncenterApiKey ? { 'X-API-Key': chain.toncenterApiKey } : {};
}

/* ------------------------------------------------------------------ */
/* Jetton Wallet 解析                                                  */
/* ------------------------------------------------------------------ */

function rawFromStackValue(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  if (looksLikeRawAddress(text)) return toRawAddress(parseTonAddress(text));
  // 友好地址
  try {
    return toRawAddress(parseTonAddress(text));
  } catch {
    /* 继续尝试 BOC */
  }
  // toncenter 的 slice 值可能是 base64 序列化的 cell
  try {
    const roots = parseBocBase64(text);
    const root = roots[0];
    if (!root) return null;
    const address = new CellSlice(root).loadAddress();
    return address ? toRawAddress(address) : null;
  } catch {
    return null;
  }
}

interface ToncenterRunResult {
  ok?: boolean;
  result?: { exit_code?: number; stack?: unknown[] };
}

async function resolveViaToncenterRunGetMethod(
  chain: ChainConfig,
  jettonMaster: string,
  owner: string,
): Promise<string | null> {
  const ownerAddress = parseTonAddress(owner);
  const ownerRaw = toRawAddress(ownerAddress);
  const ownerFriendly = toFriendlyAddress(ownerAddress, chain.network === 'testnet', true);
  const addressCellBoc = toBocBase64(beginCell().writeAddress(ownerAddress).end());
  const variants: unknown[][] = [
    [{ type: 'slice', value: ownerRaw }],
    [{ type: 'slice', value: ownerFriendly }],
    [{ type: 'slice', value: addressCellBoc }],
    [{ type: 'cell', value: addressCellBoc }],
  ];
  for (const stack of variants) {
    try {
      const response = (await fetchJson(chain.toncenterBaseUrl + '/api/v2/runGetMethod', {
        method: 'POST',
        headers: apiKeyHeaders(chain),
        body: { address: jettonMaster, method: 'get_wallet_address', stack },
      })) as ToncenterRunResult;
      if (!response?.ok) continue;
      const exitCode = response.result?.exit_code ?? -1;
      if (exitCode !== 0) continue;
      const first = response.result?.stack?.[0] as { value?: unknown } | undefined;
      const resolved = rawFromStackValue(first?.value);
      if (resolved) return resolved;
    } catch {
      /* 换下一种参数格式 */
    }
  }
  return null;
}

interface TonapiAccountJettons {
  balances?: {
    jetton?: { address?: string };
    wallet_address?: { address?: string } | string;
    wallet_address_str?: string;
  }[];
}

async function resolveViaTonapi(chain: ChainConfig, jettonMaster: string, owner: string): Promise<string | null> {
  try {
    const masterRaw = toRawAddress(parseTonAddress(jettonMaster));
    const ownerRaw = toRawAddress(parseTonAddress(owner));
    const response = (await fetchJson(chain.tonapiBaseUrl + '/v2/accounts/' + encodeURIComponent(ownerRaw) + '/jettons')) as TonapiAccountJettons;
    const balances = response?.balances ?? [];
    for (const balance of balances) {
      const jettonAddress = balance?.jetton?.address;
      if (!jettonAddress) continue;
      let candidate: string | null = null;
      try {
        candidate = toRawAddress(parseTonAddress(jettonAddress));
      } catch {
        candidate = jettonAddress;
      }
      if (candidate !== masterRaw) continue;
      const wallet = balance.wallet_address;
      if (typeof wallet === 'string') return rawFromStackValue(wallet);
      const walletAddress = wallet?.address ?? balance.wallet_address_str;
      const resolved = rawFromStackValue(walletAddress);
      if (resolved) return resolved;
    }
  } catch {
    /* 交给下一策略 */
  }
  return null;
}

const jettonWalletCache = new Map<string, ResolvedJettonWallet>();

function cacheKey(chain: ChainConfig, master: string, owner: string): string {
  return chain.network + '|' + master + '|' + owner;
}

/**
 * 解析某个地址在指定 Jetton Master 下的 Jetton Wallet 地址。
 * 策略：本地缓存 → tonapi → toncenter runGetMethod（3 种参数编码）。
 */
export async function resolveJettonWalletAddress(params: {
  chain: ChainConfig;
  jettonMaster: string;
  owner: string;
}): Promise<ResolvedJettonWallet> {
  const { chain, jettonMaster, owner } = params;
  const key = cacheKey(chain, jettonMaster, owner);
  const cached = jettonWalletCache.get(key);
  if (cached) return cached;

  const raw = (await resolveViaTonapi(chain, jettonMaster, owner)) ?? (await resolveViaToncenterRunGetMethod(chain, jettonMaster, owner));
  if (!raw) {
    throw chainError(
      'JETTON_WALLET_UNRESOLVED',
      '无法解析 Jetton Wallet 地址',
      'tonapi 与 toncenter 均未返回 get_wallet_address 结果（可检查网络/合约是否已部署）',
    );
  }
  let address: TonAddress;
  try {
    address = parseTonAddress(raw);
  } catch {
    throw chainError('BAD_CONFIG', 'Jetton Wallet 地址非法', raw);
  }
  const resolved: ResolvedJettonWallet = {
    raw: toRawAddress(address),
    friendly: toFriendlyAddress(address, chain.network === 'testnet', true),
  };
  jettonWalletCache.set(key, resolved);
  return resolved;
}

/* ------------------------------------------------------------------ */
/* 交易回执                                                            */
/* ------------------------------------------------------------------ */

export interface OnchainTx {
  /** transaction_id.hash（base64） */
  hash: string;
  lt: string;
  /** 区块时间（unix 秒） */
  utime: number;
  /**
   * 交易 aborted：TON 上 compute phase 抛错/回滚时为 true。
   * 注意 in_msg 的 op/roundId 仍然存在，所以匹配回执时必须显式排除，否则失败会被误判成功。
   */
  aborted: boolean;
  /** in_msg 是否被 bounce 回发送方（合约拒绝时常见） */
  bounced: boolean;
  /** compute phase exit_code（0 = 成功；null = 拿不到，例如 skipped） */
  exitCode: number | null;
  /** 外部消息（用户钱包合约收到并处理） */
  external: boolean;
  inSource: string | null;
  inDestination: string | null;
  inValueNanoton: string | null;
  /** in_msg body（base64 BOC），不存在为 null */
  inBody: string | null;
}

/** 回执是否代表一次成功的合约执行（aborted / bounced / 非 0 exit_code 一律不算成功）。 */
export function isSuccessfulTx(tx: OnchainTx): boolean {
  if (tx.aborted || tx.bounced) return false;
  if (tx.exitCode !== null && tx.exitCode !== 0) return false;
  return true;
}

/** 用户操作回执的身份匹配条件（只做身份匹配，成功与否由 isSuccessfulTx 判定）。 */
export interface UserActionMatch {
  /** 发送者 raw 地址（"<wc>:<hex>"） */
  sourceRaw: string;
  op: number;
  /** undefined/null = 不比较；ClaimAll 的 0 是有效值 */
  roundId?: number | null;
  /** undefined/null = 不比较（快速重试时必须传本次 queryId） */
  queryId?: bigint | null;
}

/**
 * 统一 matcher：inSource + op + roundId + queryId。
 * 不包含 aborted/exit_code 判断——waitForTransaction 会用 isSuccessfulTx 把「身份命中但执行失败」的 tx
 * 判为 stage='failed' 并带回 exit_code，供 UI 展示失败原因。
 */
export function matchesUserAction(tx: OnchainTx, expected: UserActionMatch): boolean {
  if (!tx.inSource || tx.inSource !== expected.sourceRaw) return false;
  const message = decodeUserAction(tx.inBody);
  if (!message || message.op !== expected.op) return false;
  if (expected.roundId !== undefined && expected.roundId !== null && message.roundId !== expected.roundId) return false;
  if (expected.queryId !== undefined && expected.queryId !== null) {
    if (message.queryId === null || message.queryId !== expected.queryId) return false;
  }
  return true;
}

interface ToncenterTxRaw {
  transaction_id?: { hash?: string; lt?: string };
  utime?: number;
  in_msg?: {
    source?: string;
    destination?: string;
    value?: string;
    bounced?: boolean;
    msg_data?: { body?: string };
  } | null;
  description?: {
    aborted?: boolean;
    compute_ph?: { success?: boolean; exit_code?: number } | null;
    action?: { result_code?: number; success?: boolean } | null;
  };
}

interface ToncenterTxResponse {
  ok?: boolean;
  result?: ToncenterTxRaw[];
  error?: string;
}

function normalizeRaw(value: string | undefined | null): string | null {
  if (!value) return null;
  if (/^0:0{64}$/.test(value)) return null;
  if (/^-?\d+:[0-9a-fA-F]{64}$/.test(value)) return value.toLowerCase();
  return value;
}

/** 尽力把来源地址规范成 raw；解析失败时原样返回，避免整批交易解析失败。 */
function safeRawAddress(value: string | null): string | null {
  if (!value) return null;
  try {
    return toRawAddress(parseTonAddress(value));
  } catch {
    return value;
  }
}

function mapToncenterTx(tx: ToncenterTxRaw): OnchainTx {
  const inSource = normalizeRaw(tx.in_msg?.source);
  const hash = tx.transaction_id?.hash ?? '';
  const exitCodeRaw = tx.description?.compute_ph?.exit_code;
  return {
    hash,
    lt: tx.transaction_id?.lt ?? '0',
    utime: Number(tx.utime ?? 0),
    aborted: Boolean(tx.description?.aborted),
    bounced: Boolean(tx.in_msg?.bounced),
    exitCode: typeof exitCodeRaw === 'number' && Number.isFinite(exitCodeRaw) ? exitCodeRaw : null,
    external: !inSource,
    inSource: safeRawAddress(inSource),
    inDestination: tx.in_msg?.destination ? normalizeRaw(tx.in_msg.destination) : null,
    inValueNanoton: tx.in_msg?.value ?? null,
    inBody: tx.in_msg?.msg_data?.body ?? null,
  };
}

/** 拉取某地址最近的交易（toncenter v2）。 */
export async function fetchRecentTransactions(
  chain: ChainConfig,
  address: string,
  limit = 20,
  signal?: AbortSignal,
): Promise<OnchainTx[]> {
  const normalized = (() => {
    try {
      return toFriendlyAddress(parseTonAddress(address), chain.network === 'testnet', true);
    } catch {
      return address;
    }
  })();
  const url =
    chain.toncenterBaseUrl +
    '/api/v2/getTransactions?address=' +
    encodeURIComponent(normalized) +
    '&limit=' +
    limit +
    '&to_lt=0&archival=false';
  const response = (await fetchJson(url, { headers: apiKeyHeaders(chain), signal })) as ToncenterTxResponse;
  if (!response?.ok || !Array.isArray(response.result)) {
    throw chainError('NETWORK_ERROR', 'toncenter 查询失败', response?.error ?? null);
  }
  return response.result.map(mapToncenterTx);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ */
/* v8.7 退款账本（round 0 = A9-CRIT-02 refund ledger）                  */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * 攻城令（StakeTicket，v11）链上读取：每人每城一个合约，仓位以它为准。
 * get_ticket_address(owner, roundId) 由 RC 推导地址；get_ticket_data / get_reward_preview 读状态与奖励。
 * 读取失败必须抛错：「读不到」与「真的是 0」必须区分，UI 不得把 RPC 失败显示成 0。
 * ------------------------------------------------------------------ */

export interface TicketStateView {
  ticketAddress: string;
  amountRaw: string;
  weightRaw: string;
  principalDone: boolean;
  lockedClaimedRaw: string;
  pending: boolean;
}

export interface RewardPreviewView {
  rewardRaw: string;
  immediateRaw: string;
  lockedRaw: string;
  unlockedLockedRaw: string;
}

/** owner 入参的几种编码（toncenter 对 slice / cell 的接受度不同，依次尝试）。 */
function ownerStackArgs(owner: TonAddress): { type: 'slice' | 'cell'; value: string }[][] {
  const ownerRaw = toRawAddress(owner);
  const ownerBoc = toBocBase64(beginCell().writeAddress(owner).end());
  return [
    [{ type: 'slice', value: ownerBoc }],
    [{ type: 'slice', value: ownerRaw }],
    [{ type: 'cell', value: ownerBoc }],
  ];
}

interface GetterCall {
  items: unknown[];
  exitCode: number;
}

async function callGetter(chain: ChainConfig, address: string, method: string, stack: unknown[]): Promise<GetterCall> {
  const response = (await fetchJson(chain.toncenterBaseUrl + '/api/v2/runGetMethod', {
    method: 'POST',
    headers: apiKeyHeaders(chain),
    body: { address, method, stack },
  })) as ToncenterRunResult;
  if (!response?.ok) throw chainError('NETWORK_ERROR', 'toncenter runGetMethod 失败', method);
  const items = response.result?.stack;
  if (!Array.isArray(items)) throw chainError('NETWORK_ERROR', method + ' 返回无法解析', method);
  return { items, exitCode: response.result?.exit_code ?? -1 };
}

/** toncenter 栈数字（{type:'num', value:'0x…' | '…'}）→ bigint；无法解析返回 null。 */
function stackNum(item: unknown): bigint | null {
  const value = (item as { value?: unknown } | undefined)?.value;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  if (typeof value === 'string' && value.trim()) {
    try {
      return BigInt(value.trim());
    } catch {
      return null;
    }
  }
  return null;
}

function requireNum(item: unknown, label: string): bigint {
  const value = stackNum(item);
  if (value === null) throw chainError('NETWORK_ERROR', label + ' 无法解析');
  return value;
}

/** 攻城令地址：RC.get_ticket_address(owner, roundId)。 */
export async function fetchTicketAddress(params: { chain: ChainConfig; owner: string; roundId: number }): Promise<string> {
  const { chain, owner, roundId } = params;
  if (!chain.configured || !chain.roundController) throw chainError('CHAIN_NOT_CONFIGURED');
  let ownerAddress: TonAddress;
  try {
    ownerAddress = parseTonAddress(owner);
  } catch {
    throw chainError('BAD_CONFIG', '钱包地址不合法', owner);
  }
  const method = GET_METHODS.roundController.ticketAddress;
  let lastError: ChainError | null = null;
  for (const ownerArg of ownerStackArgs(ownerAddress)) {
    try {
      const call = await callGetter(chain, chain.roundController, method, [{ type: 'num', value: '0x' + roundId.toString(16) }, ...ownerArg]);
      if (call.exitCode !== 0) {
        lastError = chainError('NETWORK_ERROR', method + ' exit_code=' + call.exitCode, method);
        continue;
      }
      const value = (call.items[0] as { value?: unknown } | undefined)?.value;
      const raw = rawFromStackValue(value);
      if (raw) return raw;
      lastError = chainError('NETWORK_ERROR', method + ' 返回无法解析', method);
    } catch (error) {
      lastError = error instanceof ChainError ? error : chainError('NETWORK_ERROR', error instanceof Error ? error.message : String(error), method);
    }
  }
  throw lastError ?? chainError('NETWORK_ERROR', '无法推导攻城令地址', method);
}

const ticketCache = new Map<string, { at: number; view: TicketStateView | null }>();
const TICKET_CACHE_MS = 10_000;

/**
 * 攻城令状态：get_ticket_data（8 槽）。攻城令未部署（从未上车）返回 null；其余读取失败抛错。
 */
export async function fetchTicketState(params: { chain: ChainConfig; owner: string; roundId: number; signal?: AbortSignal }): Promise<TicketStateView | null> {
  const { chain, owner, roundId } = params;
  const key = chain.network + '|' + owner + '|' + roundId;
  const cached = ticketCache.get(key);
  if (cached && Date.now() - cached.at < TICKET_CACHE_MS) return cached.view;
  const ticketAddress = await fetchTicketAddress({ chain, owner, roundId });
  const call = await callGetter(chain, ticketAddress, GET_METHODS.ticket.ticketData, []);
  if (call.exitCode === -13) {
    // 账户未部署：该轮没有上车记录
    ticketCache.set(key, { at: Date.now(), view: null });
    return null;
  }
  if (call.exitCode !== 0 || call.items.length < 8) {
    throw chainError('NETWORK_ERROR', 'get_ticket_data exit_code=' + call.exitCode, GET_METHODS.ticket.ticketData);
  }
  const view: TicketStateView = {
    ticketAddress,
    amountRaw: requireNum(call.items[3], 'amountRaw').toString(),
    weightRaw: requireNum(call.items[4], 'weightRaw').toString(),
    principalDone: requireNum(call.items[5], 'principalDone') !== 0n,
    lockedClaimedRaw: requireNum(call.items[6], 'lockedClaimedRaw').toString(),
    pending: requireNum(call.items[7], 'pending') !== 0n,
  };
  ticketCache.set(key, { at: Date.now(), view });
  return view;
}

/** RC.get_reward_preview(roundId, weightRaw)：本金之外的奖励拆分（4 槽）。 */
export async function fetchRewardPreview(params: { chain: ChainConfig; roundId: number; weightRaw: bigint }): Promise<RewardPreviewView> {
  const { chain, roundId, weightRaw } = params;
  if (!chain.configured || !chain.roundController) throw chainError('CHAIN_NOT_CONFIGURED');
  const method = GET_METHODS.roundController.rewardPreview;
  const call = await callGetter(chain, chain.roundController, method, [
    { type: 'num', value: '0x' + roundId.toString(16) },
    { type: 'num', value: '0x' + weightRaw.toString(16) },
  ]);
  if (call.exitCode !== 0 || call.items.length < 4) throw chainError('NETWORK_ERROR', method + ' exit_code=' + call.exitCode, method);
  return {
    rewardRaw: requireNum(call.items[0], 'rewardRaw').toString(),
    immediateRaw: requireNum(call.items[1], 'immediateRaw').toString(),
    lockedRaw: requireNum(call.items[2], 'lockedRaw').toString(),
    unlockedLockedRaw: requireNum(call.items[3], 'unlockedLockedRaw').toString(),
  };
}

export interface WaitForTxOptions {
  chain: ChainConfig;
  /** 合约地址（RoundController），用于匹配合约侧回执 */
  targetAddress: string;
  /** 用户钱包地址（兜底：至少确认外部消息已上链） */
  walletAddress: string;
  /** 交易开始时间（unix 秒），用于过滤旧交易 */
  sinceSec: number;
  /** 合约侧匹配逻辑 */
  match: (tx: OnchainTx) => boolean;
  timeoutMs?: number;
  intervalMs?: number;
  signal?: AbortSignal;
  /** 观察到用户钱包外部交易时回调（UI 可先展示 hash） */
  onWalletTx?: (tx: OnchainTx) => void;
}

export interface WaitForTxResult {
  /** 命中的交易（合约侧优先，其次钱包侧） */
  tx: OnchainTx | null;
  /**
   * contract = 合约侧执行成功；
   * failed   = 身份匹配但合约 compute phase 失败（aborted / bounced / 非 0 exit_code，tx.exitCode 可读）；
   * wallet   = 仅确认外部消息上链；
   * null     = 超时未观察到。
   */
  stage: 'contract' | 'failed' | 'wallet' | null;
}

/**
 * 轮询回执：
 *   1) 合约地址出现 match(tx)：
 *      - isSuccessfulTx → stage=contract
 *      - 否则（aborted / bounced / 非 0 exit_code）→ stage=failed（带回 tx.exitCode）
 *   2) 超过 30s 只有钱包外部交易 → stage=wallet（已签名发出）
 *   3) 超时 → stage=null
 */
export async function waitForTransaction(options: WaitForTxOptions): Promise<WaitForTxResult> {
  const timeoutMs = options.timeoutMs ?? 150000;
  const intervalMs = options.intervalMs ?? 4000;
  const walletFallbackMs = Math.min(30000, Math.floor(timeoutMs / 2));
  const startedAt = Date.now();
  let walletTx: OnchainTx | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    if (options.signal?.aborted) return { tx: walletTx, stage: walletTx ? 'wallet' : null };
    try {
      const targetTxs = await fetchRecentTransactions(options.chain, options.targetAddress, 20, options.signal);
      const matched = targetTxs.find((tx) => tx.utime >= options.sinceSec - 30 && options.match(tx));
      if (matched) {
        if (isSuccessfulTx(matched)) return { tx: matched, stage: 'contract' };
        // 身份匹配但执行失败：只上报「本次窗口内新鲜」的失败tx，避免把上一笔旧失败当成本次失败
        if (matched.utime >= options.sinceSec) return { tx: matched, stage: 'failed' };
      }
    } catch {
      /* 单次查询失败不终止轮询 */
    }
    try {
      const walletTxs = await fetchRecentTransactions(options.chain, options.walletAddress, 10, options.signal);
      // 外部消息也可能 aborted（如 seqno 冲突）：只有成功执行的外部 tx 才算「已发送」
      const external = walletTxs.find((tx) => tx.external && tx.utime >= options.sinceSec - 30 && isSuccessfulTx(tx));
      if (external && !walletTx) {
        walletTx = external;
        options.onWalletTx?.(external);
      }
    } catch {
      /* ignore */
    }
    if (walletTx && Date.now() - startedAt >= walletFallbackMs) {
      return { tx: walletTx, stage: 'wallet' };
    }
    await sleep(intervalMs);
  }
  return { tx: walletTx, stage: walletTx ? 'wallet' : null };
}
