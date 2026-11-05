// A9 Protocol — shared constants (V6.1)
// Authority: docs/00_DECISIONS_V2.md (V6.1), docs/04_CONTRACT_ABI.md.
// Custom opcodes occupy the project-reserved 0x5254xxxx range (see README §ABI).

// ---------------------------------------------------------------------------
// Opcodes — docs/04 §5 (registered values), plus project extensions
// ---------------------------------------------------------------------------
const OP_OPEN_ROUND: uint32 = 0x52540001;
const OP_CLOSE_STAKING: uint32 = 0x52540002;
const OP_SUBMIT_CANDLE: uint32 = 0x52540003;
const OP_ORACLE_CANDLE_VERIFIED: uint32 = 0x52540004; // reserved (OracleAdapter phase 2)
const OP_FINALIZE_ROUND: uint32 = 0x52540005;
const OP_CLAIM_PRINCIPAL: uint32 = 0x52540006;
const OP_CLAIM_REWARD: uint32 = 0x52540007;
const OP_START_FAILURE_BURN: uint32 = 0x52540008; // reserved (logical ABI)
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
const OP_TEAM_RELEASED_ACK: uint32 = 0x52540013;
const OP_TEAM_BURNED_ACK: uint32 = 0x52540014;
const OP_RETRY_PENDING_ACTIONS: uint32 = 0x52540015;
const OP_SET_JETTON_WALLET: uint32 = 0x52540016;

// Events (external-out logs, TEP-style). Not internal messages.
const EV_TARGET_PRICE_SET: uint32 = 0x52540101;
const EV_ROUND_SETTLED: uint32 = 0x52540102;
const EV_DEPOSIT_ACCEPTED: uint32 = 0x52540103;
const EV_TECHNICAL_ABORTED: uint32 = 0x52540104;
const EV_TEAM_RELEASED: uint32 = 0x52540201;
const EV_TEAM_BURNED: uint32 = 0x52540202;

// TEP-74 / TEP-89 standard opcodes
const OP_JETTON_TRANSFER: uint32 = 0x0f8a7ea5;
const OP_JETTON_BURN: uint32 = 0x595f07bc;
const OP_JETTON_TRANSFER_NOTIFICATION: uint32 = 0x7362d09c;
const OP_TOP_UP_TONS: uint32 = 0xd372158c;

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

// Rounds are hard-capped at 10 by the tokenomics (70% = 10 x 7%).
const MAX_ROUNDS: uint8 = 10;
// claimAll upper bound: fixed 10-round scan (docs/04 §8.1, no unbounded loop).
const MAX_CLAIM_SCAN_ROUNDS: uint8 = 10;

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
}
