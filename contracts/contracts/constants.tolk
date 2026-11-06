// A9 Protocol — shared constants (V6.2 timing)
// Authority: docs/00_DECISIONS_V2.md (V6.1), docs/04_CONTRACT_ABI.md.
// Custom opcodes occupy the project-reserved 0x5254xxxx range (see README §ABI).

// ---------------------------------------------------------------------------
// Opcodes — docs/04 §5 (registered values), plus project extensions
// ---------------------------------------------------------------------------
const OP_OPEN_ROUND: uint32 = 0x52540001;
const OP_CLOSE_STAKING: uint32 = 0x52540002;
const OP_SUBMIT_CANDLE: uint32 = 0x52540003;
const OP_FINALIZE_ROUND: uint32 = 0x52540005;
const OP_CLAIM_PRINCIPAL: uint32 = 0x52540006;
const OP_CLAIM_REWARD: uint32 = 0x52540007;
const OP_BURN_ACK: uint32 = 0x52540009;
const OP_PAUSE_ORACLE: uint32 = 0x5254000A;
const OP_RESUME_ORACLE: uint32 = 0x5254000B;
const OP_RELEASE_TEAM_QUOTA: uint32 = 0x5254000C;
const OP_BURN_TEAM_QUOTA: uint32 = 0x5254000D;
const OP_CLAIM_ALL: uint32 = 0x5254000E;
const OP_STAKE_DEPOSIT: uint32 = 0x5254000F;
const OP_ABORT_TECHNICAL: uint32 = 0x52540010;
const OP_START_OBSERVATION: uint32 = 0x52540011;
const OP_INIT_CONTROLLER: uint32 = 0x52540012;
const OP_RETRY_PENDING_ACTIONS: uint32 = 0x52540015;
const OP_SET_JETTON_WALLET: uint32 = 0x52540016;
const OP_CLAIM_REWARD_EARLY: uint32 = 0x52540017;
const OP_ROLL_REWARD: uint32 = 0x52540018;
const OP_SET_REFERRER: uint32 = 0x52540019;
const OP_CLAIM_UNLOCKED: uint32 = 0x5254001A;
// TEP-74 wallet -> owner excess return, also used as burn/claim completion signal
const OP_RETURN_EXCESSES: uint32 = 0xd53276db;
// C-4: Jetton Wallet -> owner notification after a two-hop transfer bounce.
const OP_TRANSFER_BOUNCED: uint32 = 0x52540027;
const OP_JETTON_INTERNAL_TRANSFER: uint32 = 0x178d4519;

// OracleAdapter (mainnet M-2): 3/5 ed25519 signed submissions.
const OP_SET_SIGNER_SET: uint32 = 0x52540021;
const OP_SET_ORACLE_CONTROLLER: uint32 = 0x52540022;
const OP_SET_ORACLE_ADMIN: uint32 = 0x52540023;
const OP_SUBMIT_SIGNED_OPEN: uint32 = 0x52540024;
const OP_SUBMIT_SIGNED_CLOSE: uint32 = 0x52540025;
const OP_SUBMIT_SIGNED_CANDLE: uint32 = 0x52540026;

const SIGNED_ACTION_OPEN: uint8 = 1;
const SIGNED_ACTION_CLOSE: uint8 = 2;
const SIGNED_ACTION_CANDLE: uint8 = 3;
const SIGNED_TIMESTAMP_WINDOW: uint32 = 300;

// Reserved (phase-2 OracleAdapter). RoundController has no handler for this yet;
// only the ops dry-run script (scripts/deploy/admin_op.tolk) builds it for planning.
const OP_ORACLE_CANDLE_VERIFIED: uint32 = 0x52540004;

// Events (external-out logs, TEP-style). Not internal messages.
const EV_TARGET_PRICE_SET: uint32 = 0x52540101;
const EV_ROUND_SETTLED: uint32 = 0x52540102;
const EV_DEPOSIT_ACCEPTED: uint32 = 0x52540103;
const EV_TECHNICAL_ABORTED: uint32 = 0x52540104;
const EV_TEAM_RELEASED: uint32 = 0x52540201;
const EV_TEAM_BURNED: uint32 = 0x52540202;
const EV_REWARD_ROLLED: uint32 = 0x52540105;
const EV_REWARD_EARLY: uint32 = 0x52540106;
const EV_REFERRER_SET: uint32 = 0x52540107;
const EV_UNLOCK_CLAIMED: uint32 = 0x52540108;

// TEP-74 / TEP-89 standard opcodes
const OP_JETTON_TRANSFER: uint32 = 0x0f8a7ea5;
const OP_JETTON_BURN: uint32 = 0x595f07bc;
const OP_JETTON_TRANSFER_NOTIFICATION: uint32 = 0x7362d09c;

// ---------------------------------------------------------------------------
// Round status values (docs/02 §1). uint8 on the wire.
// ---------------------------------------------------------------------------
const STATUS_UNOPENED: uint8 = 0;
const STATUS_PREVIEW: uint8 = 1;
const STATUS_STAKING_OPEN: uint8 = 2;
const STATUS_STAKING_CLOSED: uint8 = 3;
const STATUS_OBSERVING: uint8 = 4;
const STATUS_ORACLE_PAUSED: uint8 = 5;
const STATUS_SETTLING_SUCCESS: uint8 = 6;
const STATUS_SETTLING_FAILURE: uint8 = 7;
const STATUS_SUCCEEDED: uint8 = 8;
const STATUS_FAILED_PERMANENT: uint8 = 9;
const STATUS_TECHNICAL_ABORTED: uint8 = 10;

// Burn kinds (docs/00 §2.7: three separate burns per failed round)
const BURN_KIND_REWARD: uint8 = 1;
const BURN_KIND_TEAM: uint8 = 2;
const BURN_KIND_PRINCIPAL: uint8 = 3;

// Technical abort reason codes
const ABORT_REASON_PAUSE_TIMEOUT: uint8 = 1;
const ABORT_REASON_OBSERVATION_TIMEOUT: uint8 = 2;
// M-1: PREVIEW has no permissioned opener -> permissionless timeout escape.
const ABORT_REASON_PREVIEW_TIMEOUT: uint8 = 3;

// Rounds are hard-capped at 10 by the tokenomics (70% = 10 x 7%).
const MAX_ROUNDS: uint8 = 10;
// claimAll upper bound: fixed 10-round scan (docs/04 §8.1, no unbounded loop).
const MAX_CLAIM_SCAN_ROUNDS: uint8 = 10;

// V8 reward-state values
const REWARD_STATE_PENDING: uint8 = 0;
const REWARD_STATE_ROLLED: uint8 = 1;
const REWARD_STATE_EARLY: uint8 = 2;

// V8 weight parameters (BPS = 1/10000)
const STREAK_MAX: uint8 = 10;
const STREAK_BPS_PER_ROUND: uint32 = 1000; // +10% per consecutive round
const REFERRAL_BPS: uint32 = 2000; // 20% of referred stake
const UNLOCK_DURATION_SECONDS: uint32 = 31104000; // 12 x 30 days, linear (1/12 per month)

// P0-3 claim queryId kind (layout: roundId<<32 | kind<<24 | counter24)
const CLAIM_KIND_PRINCIPAL: uint8 = 1;
const CLAIM_KIND_REWARD: uint8 = 2;
const CLAIM_KIND_CLAIM_ALL: uint8 = 3;
const CLAIM_KIND_UNLOCK: uint8 = 4;
const CLAIM_KIND_REFUND: uint8 = 5; // round 0 refund ledger

// P0-2 burn queryId kind (layout: roundId<<16 | kind<<8 | nonce)
const BURN_QUERY_REWARD: uint8 = 1; // same value as BURN_KIND_REWARD
const BURN_QUERY_PRINCIPAL: uint8 = 3; // same value as BURN_KIND_PRINCIPAL
const BURN_QUERY_TEAM: uint8 = 2; // same value as BURN_KIND_TEAM
const RELEASE_QUERY_TEAM: uint8 = 4; // TeamVault release confirmation query kind

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
enum Errors {
    // auth / routing
    NotAdmin = 100,
    NotOracle = 101,
    NotTeamVault = 102,
    NotJettonMaster = 103,
    NotJettonWallet = 104,
    NotController = 105,
    UnknownMessage = 106,
    NotInitialized = 107,
    AlreadyInitialized = 108,
    NotOwner = 109,

    // round lifecycle
    BadRoundId = 200,
    BadRoundStatus = 201,
    RoundNotTerminal = 202,
    PreviousRoundNotSettled = 203,
    MaxRoundsReached = 204,
    PreviewNotFinished = 205,
    StakingWindowClosed = 206,
    StakingStillOpen = 207,
    TooEarly = 208,
    ObservationNotStarted = 209,
    ObservationNotFinished = 210,
    CandleIndexOutOfRange = 211,
    CandlePeriodMismatch = 212,
    CandleNotClosedYet = 213,
    CandleAlreadySeen = 214,
    CandleBadPrice = 215,
    NothingToFinalize = 216,
    BurnsNotConfirmed = 217,
    TeamReleaseNotConfirmed = 218,
    RewardBurnNotConfirmed = 219,

    // staking
    InvalidStakePayload = 220,
    BadStakeVersion = 221,
    BadRiskVersion = 222,
    RiskNotAccepted = 223,
    DepositNonceReused = 224,
    StakeBelowMinimum = 225,
    StakeAboveRoundCap = 226,
    StakeAboveAddressCap = 227,
    ZeroAmount = 228,

    // claims
    NothingToClaim = 230,
    AlreadyClaimed = 231,
    NotClaimable = 232,
    ZeroReward = 233,

    // burns / team vault
    BurnKindMismatch = 240,
    BurnAmountMismatch = 241,
    BadBurnId = 242,
    TeamRoundAlreadyDone = 243,
    TeamRoundConflict = 244,
    ZeroTeamQuota = 245,

    // config
    BadConfig = 250,

    // V8 reward states / referrals / unlock
    AlreadyReferred = 260,
    SelfReferral = 261,
    MutualReferral = 262,
    RewardStateLocked = 263,
    UnlockNotStarted = 264,
    NothingUnlocked = 265,
    RollNotAvailable = 266,

    // P0 fixes
    ClaimPending = 270,
    UnknownBounce = 271,
    CounterOverflow = 272,
    BadBurnQuery = 273,

    // OracleAdapter
    NotEnoughSignatures = 300,
    StaleSignature = 301,
    ReplayAction = 302,
    BadCandleOrder = 303,
    BadSignerIndex = 304,
    BadSignature = 305,
    VersionTooOld = 306,
    BadThreshold = 307,
}
