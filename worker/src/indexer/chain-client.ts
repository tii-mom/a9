/**
 * toncenter v2/v3 只读客户端：限速 + 超时 + 指数退避（含抖动）+ 错误分类 + 备用端点切换。
 * 设计约束（Lead 实测 429：公共接口 6 连发即 4 个 429）：
 *  - 有 API key：最小间隔 120ms（≈8 rps，低于免费档 10 rps 上限）；
 *  - 无 key（仅 TONCENTER_ALLOW_PUBLIC=1 本地调试）：最小间隔 5000ms；
 *  - 429/5xx/网络错误 = 可重试（最多 4 次，指数退避）；401/403/400 = 致命，不重试。
 * 所有调用都在 indexer.tick 内，sources/chain.ts 不得 import 本文件。
 */
import type { ChainConfig } from './config';

export type ChainFailureKind = 'rate_limited' | 'transient' | 'fatal';

export class ChainClientError extends Error {
  readonly kind: ChainFailureKind;
  readonly status: number | null;
  readonly retryAfterMs: number | null;

  constructor(kind: ChainFailureKind, message: string, status: number | null = null, retryAfterMs: number | null = null) {
    super(message);
    this.name = 'ChainClientError';
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** runGetMethod 的入参栈元素：['num', '0x..'] 或 ['slice', <BOC base64>]。 */
export type StackArg = readonly [string, string];

export interface ChainMessage {
  hash?: string;
  source?: string | null;
  destination?: string | null;
  value?: string | null;
  opcode?: string | null;
  decoded_opcode?: unknown;
  created_lt?: string;
  created_at?: number;
  bounced?: boolean;
  bounce?: boolean;
  message_content?: { body?: string; decoded?: unknown } | null;
}

export interface ChainTx {
  account?: string;
  hash: string;
  lt: string;
  now: number;
  mc_block_seqno?: number;
  finality?: string;
  aborted?: boolean;
  in_msg?: ChainMessage | null;
  out_msgs?: ChainMessage[];
  description?: { aborted?: boolean; compute_ph?: unknown } | null;
}

export interface TransactionQuery {
  account: string;
  /** 从该 lt 开始（inclusive；调用方需过滤 <= 已处理游标） */
  startLt?: string;
  limit?: number;
  sort?: 'asc' | 'desc';
}

export interface GetMethodResult {
  stack: unknown[];
  exitCode: number;
}

export interface ChainClient {
  readonly network: ChainConfig['network'];
  runGetMethod(address: string, method: string, stack?: readonly StackArg[]): Promise<GetMethodResult>;
  transactions(query: TransactionQuery): Promise<ChainTx[]>;
  /** 端点标签（日志/健康检查用） */
  endpointLabel(): string;
}

interface ClientState {
  lastCallAt: number;
  consecutiveFailures: number;
  useFallback: boolean;
  endpointLabel: string;
}

const MAX_ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

/** 把 HTTP 状态/响应体归类成可重试或致命错误。 */
function classifyFailure(status: number | null, body: unknown, fallbackMessage: string): ChainClientError {
  const record = isRecord(body) ? body : null;
  const apiCode = record && typeof record.code === 'number' ? record.code : null;
  const message = (record && (readString(record, 'error') ?? readString(record, 'message'))) ?? fallbackMessage;
  if (status === 429 || apiCode === 429) return new ChainClientError('rate_limited', 'toncenter 限流：' + message, status);
  if (status === 401 || status === 403 || status === 400 || status === 404) {
    return new ChainClientError('fatal', 'toncenter 拒绝请求（HTTP ' + String(status) + '）：' + message, status);
  }
  if (status !== null && status >= 500) return new ChainClientError('transient', 'toncenter 5xx（' + String(status) + '）：' + message, status);
  return new ChainClientError('transient', 'toncenter 请求失败：' + message, status);
}

function retryAfterMsFrom(response: Response): number | null {
  const raw = response.headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number.parseFloat(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.min(30_000, seconds * 1000));
  return null;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: text.slice(0, 300) };
  }
}

export function createChainClient(config: ChainConfig): ChainClient {
  const state: ClientState = {
    lastCallAt: 0,
    consecutiveFailures: 0,
    useFallback: false,
    endpointLabel: config.network,
  };
  const minIntervalMs = config.minIntervalMs ?? (config.apiKey ? 120 : 5_000);

  async function throttle(): Promise<void> {
    const wait = minIntervalMs - (Date.now() - state.lastCallAt);
    if (wait > 0) await sleep(wait);
    state.lastCallAt = Date.now();
  }

  async function requestJson(url: string, init: RequestInit): Promise<unknown> {
    let lastError: ChainClientError | null = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      await throttle();
      let response: Response;
      try {
        response = await fetch(url, {
          ...init,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: {
            'content-type': 'application/json',
            ...(config.apiKey ? { 'X-API-Key': config.apiKey } : {}),
            ...(init.headers as Record<string, string> | undefined),
          },
        });
      } catch (error) {
        lastError = new ChainClientError('transient', 'toncenter 网络错误：' + (error instanceof Error ? error.message : String(error)));
        state.consecutiveFailures++;
        await sleep(Math.min(4_000, 300 * 2 ** attempt) + Math.floor(Math.random() * 250));
        continue;
      }
      const body = await readJson(response);
      if (response.ok && !(isRecord(body) && body.ok === false)) {
        state.consecutiveFailures = 0;
        state.useFallback = false;
        state.endpointLabel = config.network + (state.useFallback ? ':fallback' : '');
        return body;
      }
      const failure = classifyFailure(response.status, body, 'HTTP ' + response.status);
      lastError = failure;
      state.consecutiveFailures++;
      if (failure.kind === 'fatal') throw failure;
      const retryAfter = retryAfterMsFrom(response);
      if (attempt === MAX_ATTEMPTS - 1) break;
      const backoff = retryAfter ?? Math.min(4_000, 300 * 2 ** attempt) + Math.floor(Math.random() * 250);
      await sleep(backoff);
    }
    throw lastError ?? new ChainClientError('transient', 'toncenter 请求失败（未知原因）');
  }

  return {
    network: config.network,
    endpointLabel(): string {
      return state.endpointLabel;
    },
    async runGetMethod(address: string, method: string, stack: readonly StackArg[] = []): Promise<GetMethodResult> {
      const body = await requestJson(config.v2Url + '/runGetMethod', {
        method: 'POST',
        body: JSON.stringify({ address, method, stack }),
      });
      if (!isRecord(body)) throw new ChainClientError('transient', 'runGetMethod 响应不是对象');
      if (body.ok !== true) throw classifyFailure(null, body, 'runGetMethod ' + method + ' 失败');
      const result = isRecord(body.result) ? body.result : null;
      if (!result) throw new ChainClientError('transient', 'runGetMethod ' + method + ' 缺少 result');
      const exitCode = typeof result.exit_code === 'number' ? result.exit_code : 0;
      const stackItems = Array.isArray(result.stack) ? result.stack : [];
      if (exitCode !== 0) {
        throw new ChainClientError('fatal', 'runGetMethod ' + method + ' 退出码 ' + String(exitCode) + '（地址 ' + address.slice(0, 12) + '…）');
      }
      return { stack: stackItems, exitCode };
    },
    async transactions(query: TransactionQuery): Promise<ChainTx[]> {
      const params = new URLSearchParams();
      params.set('account', query.account);
      params.set('limit', String(Math.min(Math.max(query.limit ?? 100, 1), 100)));
      params.set('sort', query.sort ?? 'asc');
      if (query.startLt) params.set('start_lt', query.startLt);
      const body = await requestJson(config.v3Url + '/transactions?' + params.toString(), { method: 'GET' });
      if (!isRecord(body) || !Array.isArray(body.transactions)) {
        throw new ChainClientError('transient', 'v3/transactions 响应结构异常');
      }
      return body.transactions as ChainTx[];
    },
  };
}
