/** 链上交易错误模型（UI 按 code 做中英双语提示）。 */

export type ChainErrorCode =
  | 'CHAIN_NOT_CONFIGURED'
  | 'WALLET_NOT_CONNECTED'
  | 'DEMO_WALLET'
  | 'TONCONNECT_UNAVAILABLE'
  | 'WALLET_REJECTED'
  | 'INSUFFICIENT_BALANCE'
  | 'ROUND_NOT_OPEN'
  | 'AMOUNT_INVALID'
  | 'AMOUNT_TOO_SMALL'
  | 'AMOUNT_TOO_LARGE'
  | 'JETTON_WALLET_UNRESOLVED'
  | 'NETWORK_ERROR'
  | 'TX_TIMEOUT'
  | 'BAD_CONFIG'
  | 'UNKNOWN';

const RETRIABLE: ChainErrorCode[] = [
  'NETWORK_ERROR',
  'TX_TIMEOUT',
  'JETTON_WALLET_UNRESOLVED',
  'TONCONNECT_UNAVAILABLE',
  'UNKNOWN',
];

export class ChainError extends Error {
  readonly code: ChainErrorCode;
  readonly detail: string | null;
  readonly retriable: boolean;

  constructor(code: ChainErrorCode, message?: string, detail?: string | null) {
    super(message ?? code);
    this.name = 'ChainError';
    this.code = code;
    this.detail = detail ?? null;
    this.retriable = RETRIABLE.includes(code);
  }
}

export function chainError(code: ChainErrorCode, message?: string, detail?: string | null): ChainError {
  return new ChainError(code, message, detail);
}

function errorText(error: unknown): string {
  if (!error) return '';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** TON Connect 用户拒绝：错误码 300（USER_REJECTS_ERROR）或文案匹配。 */
export function isUserRejection(error: unknown): boolean {
  const candidate = error as { code?: unknown } | null;
  if (candidate && Number(candidate.code) === 300) return true;
  return /reject|cancel|declin|denied|abort/i.test(errorText(error));
}

/** 任意异常 → ChainError（便于 UI 统一展示）。 */
export function toChainError(error: unknown): ChainError {
  if (error instanceof ChainError) return error;
  if (isUserRejection(error)) return new ChainError('WALLET_REJECTED', errorText(error));
  const text = errorText(error);
  if (/failed to fetch|networkerror|load failed|network request failed|timed? ?out|timeout/i.test(text)) {
    return new ChainError('NETWORK_ERROR', text);
  }
  if (/ton ?connect|wallet.*(not|未)|not connected/i.test(text)) {
    return new ChainError('WALLET_NOT_CONNECTED', text);
  }
  return new ChainError('UNKNOWN', text || '未知错误');
}
