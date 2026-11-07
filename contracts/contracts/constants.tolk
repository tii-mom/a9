// A9 Protocol v11 — shared constants (docs/35).
// Custom opcodes occupy the project-reserved 0x5254xxxx range. Opcode numbers of
// messages that survive from v8.9 are unchanged.

// ---------------------------------------------------------------------------
// Inbound opcodes
// ---------------------------------------------------------------------------
const OP_OPEN_ROUND: uint32 = 0x52540001;        // keeper
const OP_CLOSE_STAKING: uint32 = 0x52540002;     // anyone, after the 36h window
const OP_SUBMIT_CANDLE: uint32 = 0x52540003;     // keeper
const OP_STAKE_DEPOSIT: uint32 = 0x5254000F;     // forward_payload of a TEP-74 transfer
const OP_ABORT_TECHNICAL: uint32 = 0x52540010;   // anyone, after timeouts
const OP_RETRY_SETTLEMENT: uint32 = 0x52540015;  // anyone, resend bounced settlement
const OP_RELEASE_TEAM: uint32 = 0x52540016;      // anyone, endAt + fallback: last team quota

// RC <-> StakeTicket (v11)
const OP_TICKET_ADD_STAKE: uint32 = 0x52540301;  // RC -> ticket (deploys it)
const OP_TICKET_UPDATE: uint32 = 0x52540302;     // RC -> ticket after a paid request
const OP_TICKET_CLAIM: uint32 = 0x52540303;      // owner -> ticket
const OP_TICKET_RESTAKE: uint32 = 0x52540304;    // owner -> ticket (one-tap continue)
const OP_TICKET_REQUEST: uint32 = 0x52540305;    // ticket -> RC

// Events (external-out logs)
const EV_TARGET_PRICE_SET: uint32 = 0x52540101;
const EV_ROUND_SETTLED: uint32 = 0x52540102;
const EV_DEPOSIT_ACCEPTED: uint32 = 0x52540103;
const EV_TECHNICAL_ABORTED: uint32 = 0x52540104;
const EV_STAKING_CLOSED: uint32 = 0x5254010B;
const EV_CANDLE_SUBMITTED: uint32 = 0x5254010C;
const EV_CLAIMED: uint32 = 0x5254010E;
const EV_DEPOSIT_REFUNDED: uint32 = 0x5254010F;
const EV_SETTLEMENT_BOUNCED: uint32 = 0x52540110;
const EV_UNEXPECTED_BOUNCE: uint32 = 0x52540111;
const EV_RESTAKED: uint32 = 0x52540112;
const EV_TEAM_RELEASED: uint32 = 0x52540113;

// TEP-74 standard opcodes
const OP_JETTON_TRANSFER: uint32 = 0x0f8a7ea5;
const OP_JETTON_BURN: uint32 = 0x595f07bc;

// ---------------------------------------------------------------------------
// Round status (numeric values kept from v8.9 for indexer/frontend compatibility;
// 5/6/7 = ORACLE_PAUSED / SETTLING_* no longer exist)
// ---------------------------------------------------------------------------
const STATUS_UNOPENED: uint8 = 0;
const STATUS_PREVIEW: uint8 = 1;
const STATUS_STAKING_OPEN: uint8 = 2;
const STATUS_OBSERVING: uint8 = 4;
const STATUS_SUCCEEDED: uint8 = 8;
const STATUS_FAILED_PERMANENT: uint8 = 9;
const STATUS_TECHNICAL_ABORTED: uint8 = 10;

const ABORT_REASON_OBSERVATION_TIMEOUT: uint8 = 2;
const ABORT_REASON_PREVIEW_TIMEOUT: uint8 = 3;

const MAX_ROUNDS: uint8 = 10;
// target = max(P0 * 2^tier, 2 * opening 24h TWAP) — fixed, not configurable
const PRICE_MULTIPLIER: uint8 = 2;

// Settlement actions (bit flags; one bit per outbound jetton message)
const ACTION_TEAM_TRANSFER: uint8 = 1; // success: 1.2e8 to the team wallet
const ACTION_BURN: uint8 = 2;          // failure: half budget+team+principal; end: leftover carry
// queryId roundId 0 + ACTION_TEAM_TRANSFER = final ReleaseTeam transfer (bounce restores it)

// v11 economics (docs/35 D-44/D-45)
const IMMEDIATE_REWARD_BPS: uint128 = 2000;       // 20% of a reward claimable at once
const BPS: uint128 = 10000;
const TIMING_BPS_FIRST: uint128 = 15000;         // first third of the staking window
const TIMING_BPS_SECOND: uint128 = 12000;
const TIMING_BPS_LAST: uint128 = 10000;

// queryId layout for outbound jetton messages:
//   settlement: SETTLE_TAG | roundId<<8 | action
//   claims/refunds: plain counter-free tag (bounces are not expected, see README)
const SETTLE_QUERY_TAG: uint64 = 0x8000000000000000;
const CLAIM_QUERY_TAG: uint64 = 0x4000000000000000;
const REFUND_QUERY_TAG: uint64 = 0x2000000000000000;

// TON values
const VALUE_JETTON_ACTION: int = 100000000;   // 0.1 TON per settlement transfer/burn
const MIN_CLAIM_VALUE: int = 100000000;       // claimant pays the outbound transfer
const MIN_RETRY_VALUE: int = 300000000;
const MIN_REFUND_VALUE: int = 100000000;      // forward TON needed for an instant refund
const MIN_DEPOSIT_VALUE: int = 100000000;     // forward TON a valid deposit must carry (ticket deploy)
const VALUE_TICKET_MSG: int = 20000000;       // RC -> ticket update / add-stake from a request
const VALUE_TICKET_DEPLOY: int = 50000000;    // restake: deploy/top up the new ticket
const TICKET_MIN_BALANCE: int = 20000000;     // ticket keeps this for storage, returns the rest
const MIN_TICKET_ACTION_VALUE: int = 150000000; // owner -> ticket claim
const MIN_TICKET_RESTAKE_VALUE: int = 250000000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
enum Errors {
    NotKeeper = 101,
    NotJettonWallet = 104,
    UnknownMessage = 106,

    BadRoundId = 200,
    BadRoundStatus = 201,
    MaxRoundsReached = 204,
    PreviewNotFinished = 205,
    TooEarly = 208,
    CandleIndexOutOfRange = 211,
    CandlePeriodMismatch = 212,
    CandleNotClosedYet = 213,
    CandleOutOfOrder = 214,
    CandleBadPrice = 215,

    NothingToClaim = 230,
    NotEnoughValue = 234,
    WrongWorkchain = 235,

    NotTicket = 236,
    NotOwner = 237,
    TicketPending = 238,
    RestakeNotOpen = 239,

    NothingToRetry = 240,
    BadConfig = 250,
}
