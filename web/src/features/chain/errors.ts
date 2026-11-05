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
  | 'CONTRACT_REJECTED'
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

/**
 * 合约 exit_code → 可读名称（contracts/contracts/constants.tolk Errors enum）。
 * 只用于错误提示，不参与业务判断。
 */
const EXIT_CODE_NAMES: Record<number, string> = {
  // TEP-74 / Jetton
  47: 'BalanceError',
  48: 'NotEnoughGas',
  49: 'InvalidMessage',
  72: 'InvalidOp',
  73: 'NotOwner',
  74: 'NotValidWallet',
  333: 'WrongWorkchain',
  // auth / routing
  100: 'NotAdmin',
  101: 'NotOracle',
  102: 'NotTeamVault',
  103: 'NotJettonMaster',
  104: 'NotJettonWallet',
  105: 'NotController',
  106: 'UnknownMessage',
  107: 'NotInitialized',
  108: 'AlreadyInitialized',
  109: 'NotOwner',
  // round lifecycle
  200: 'BadRoundId',
  201: 'BadRoundStatus',
  202: 'RoundNotTerminal',
  203: 'PreviousRoundNotSettled',
  204: 'MaxRoundsReached',
  205: 'PreviewNotFinished',
  206: 'StakingWindowClosed',
  207: 'StakingStillOpen',
  208: 'TooEarly',
  209: 'ObservationNotStarted',
  210: 'ObservationNotFinished',
  211: 'CandleIndexOutOfRange',
  212: 'CandlePeriodMismatch',
  213: 'CandleNotClosedYet',
  214: 'CandleAlreadySeen',
  215: 'CandleBadPrice',
  216: 'NothingToFinalize',
  217: 'BurnsNotConfirmed',
  218: 'TeamReleaseNotConfirmed',
  219: 'RewardBurnNotConfirmed',
  // staking
  220: 'InvalidStakePayload',
  221: 'BadStakeVersion',
  222: 'BadRiskVersion',
  223: 'RiskNotAccepted',
  224: 'DepositNonceReused',
  225: 'StakeBelowMinimum',
  226: 'StakeAboveRoundCap',
  227: 'StakeAboveAddressCap',
  228: 'ZeroAmount',
  // claims
  230: 'NothingToClaim',
  231: 'AlreadyClaimed',
  232: 'NotClaimable',
  233: 'ZeroReward',
  // burns / team vault
  240: 'BurnKindMismatch',
  241: 'BurnAmountMismatch',
  242: 'BadBurnId',
  243: 'TeamRoundAlreadyDone',
  244: 'TeamRoundConflict',
  245: 'ZeroTeamQuota',
  // config
  250: 'BadConfig',
  // V8 reward states / referrals / unlock
  260: 'AlreadyReferred',
  261: 'SelfReferral',
  262: 'MutualReferral',
  263: 'RewardStateLocked',
  264: 'UnlockNotStarted',
  265: 'NothingUnlocked',
  266: 'RollNotAvailable',
  // P0 fixes
  270: 'ClaimPending',
  271: 'UnknownBounce',
  272: 'CounterOverflow',
  273: 'BadBurnQuery',
  // OracleAdapter
  300: 'NotEnoughSignatures',
  301: 'StaleSignature',
  302: 'ReplayAction',
  303: 'BadCandleOrder',
  304: 'BadSignerIndex',
  305: 'BadSignature',
  306: 'VersionTooOld',
  307: 'BadThreshold',
};

/** exit_code → 可读名称（未知返回空串）。 */
export function describeExitCode(exitCode: number | null | undefined): string {
  if (exitCode === null || exitCode === undefined) return '';
  return EXIT_CODE_NAMES[exitCode] ?? '';
}

/**
 * 合约 compute phase 失败 → ChainError('CONTRACT_REJECTED')。
 * UI 显示本地化的通用文案（i18n errors.CONTRACT_REJECTED）+ 这里的 detail（exit_code + 名称）。
 */
export function exitCodeError(exitCode: number | null | undefined): ChainError {
  const name = describeExitCode(exitCode);
  const detail =
    exitCode === null || exitCode === undefined
      ? 'contract compute phase failed (no exit_code)'
      : 'exit_code=' + exitCode + (name ? ' (' + name + ')' : '');
  return new ChainError('CONTRACT_REJECTED', 'Contract rejected transaction', detail);
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
