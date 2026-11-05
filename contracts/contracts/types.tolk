// A9 Protocol — storage, message and event types (V8: weighted rewards + 3-state).
// Logical layout follows docs/04 §3/§4/§5 and docs/17_REWARD_V2.md; concrete cell
// layout is Tolk-native. Groups behind Cell<T> keep every cell under 1023 bits and
// every cell under 4 refs.

import "constants"

// ===========================================================================
// Config (stored behind refs to stay under the 1023-bit cell limit)
// ===========================================================================

struct ProtocolAddresses {
    admin: address
    oracle: address
    jettonMaster: address
}

struct ProtocolVaults {
    // Canonical Jetton Wallet owned by RoundController: holds principal + reward pools.
    stakingJettonWallet: address
    teamVault: address
    // P0: code used to derive the recipient's Jetton Wallet for ReturnExcessesBack checks.
    jettonWalletCode: cell
}

struct ProtocolEcon {
    // $0.00116 => 116000 USD_E8 (immutable constant for this deployment)
    p0UsdE8: uint128
    // 2x, immutable (D-31)
    priceMultiplier: uint8
    // 700,000,000 * 10^9
    roundRewardRaw: uint128
    // 120,000,000 * 10^9 (per round, held by TeamVault)
    teamRoundRaw: uint128
    // 10,000 * 10^9
    minStakeRaw: uint128
    // 1000 bps = 10% of the round total per address (derives the fixed 20M hard cap)
    maxStakePerAddressBps: uint16
    // 200,000,000 * 10^9
    maxTotalStakeRaw: uint128
}

struct ProtocolTiming {
    previewSeconds: uint32
    stakeDurationSeconds: uint32
    candleSeconds: uint32
    candleCount: uint8
    minQualifiedCandles: uint8
    observationSeconds: uint32
    techAbortPauseSeconds: uint32
    techAbortObsTimeoutSeconds: uint32
    riskDisclosureVersion: uint16
    configVersion: uint32
}

struct ProtocolConfig {
    addresses: Cell<ProtocolAddresses>
    vaults: Cell<ProtocolVaults>
    econ: Cell<ProtocolEcon>
    timing: Cell<ProtocolTiming>
}

// Flat view returned by get_protocol_config().
struct ProtocolConfigView {
    admin: address
    oracle: address
    jettonMaster: address
    stakingJettonWallet: address
    teamVault: address
    p0UsdE8: uint128
    priceMultiplier: uint8
    roundRewardRaw: uint128
    teamRoundRaw: uint128
    minStakeRaw: uint128
    maxStakePerAddressBps: uint16
    maxTotalStakeRaw: uint128
    previewSeconds: uint32
    stakeDurationSeconds: uint32
    candleSeconds: uint32
    candleCount: uint8
    minQualifiedCandles: uint8
    observationSeconds: uint32
    techAbortPauseSeconds: uint32
    techAbortObsTimeoutSeconds: uint32
    riskDisclosureVersion: uint16
    configVersion: uint32
}

// ===========================================================================
// Round / stake storage
// ===========================================================================

// V8: per-round weight meta (kept behind one ref to stay under 1023 bits).
struct RoundExtra {
    failureBurnId: uint256
    // rolling sha256 over submitted candles: H(prev || index || twap || digest)
    candleHash: uint256
    // Σ weight (own weights + referral bonuses)
    totalWeight: uint128
    // referral bonus credited per referrer (already capped by own stake)
    bonus: map<address, uint128>
    // referred stake per referrer (for get_referral)
    referred: map<address, uint128>
}

struct StakePosition {
    amountRaw: uint128
    lastDepositNonce: uint64
    principalClaimed: bool
    rewardClaimed: bool
    // own weight = amount × (1 + 10% × min(streak,10)), accumulated at deposit time
    weight: uint128
    // 0 PENDING / 1 ROLLED / 2 EARLY
    rewardState: uint8
}

struct RoundData {
    status: uint8
    targetTier: uint8
    targetPriceUsdE8: uint128
    targetTwap24hUsdE8: uint128
    targetWrittenAt: uint64
    rewardBudgetRaw: uint128
    stakeOpenAt: uint64
    stakeCloseAt: uint64
    observationStart: uint64
    observationEnd: uint64
    candlesSeen: uint8
    qualifiedCandles: uint8
    totalAcceptedStakeRaw: uint128
    settledAt: uint64
    teamReleaseConfirmed: bool
    teamBurnConfirmed: bool
    rewardBurnConfirmed: bool
    principalBurnConfirmed: bool
    // F-03: burn already sent but not yet confirmed (prevents double retry)
    rewardBurnDispatched: bool
    principalBurnDispatched: bool
    // P2-1: at most one oracle pause per round
    pauseCount: uint8
    // ref: candle hash + total weight + bonus/referred maps
    extra: Cell<RoundExtra>
}

// Flat view returned by get_round().
struct RoundView {
    roundId: uint8
    status: uint8
    targetTier: uint8
    targetPriceUsdE8: uint128
    targetTwap24hUsdE8: uint128
    targetWrittenAt: uint64
    rewardBudgetRaw: uint128
    stakeOpenAt: uint64
    stakeCloseAt: uint64
    observationStart: uint64
    observationEnd: uint64
    candlesSeen: uint8
    qualifiedCandles: uint8
    totalAcceptedStakeRaw: uint128
    settledAt: uint64
    teamReleaseConfirmed: bool
    teamBurnConfirmed: bool
    rewardBurnConfirmed: bool
    principalBurnConfirmed: bool
    failureBurnId: uint256
    candleHash: uint256
    totalWeight: uint128
}

struct StreakInfo {
    lastRound: uint8
    count: uint8
}

// V8 extras grouped behind one ref so Storage stays within 4 refs.
struct LockedState {
    lockedRaw: uint128
    claimedRaw: uint128
    // F-01: non-zero while this owner has an unconfirmed claim in flight
    pendingQueryId: uint64
}

// P0-3: every outbound claim transfer is recorded here by queryId and removed
// when the wallet confirms (ReturnExcessesBack) or rolls back (bounce).
struct PendingClaim {
    owner: address
    kind: uint8
    roundId: uint8
    principalMask: uint16
    rewardMask: uint16
    amountRaw: uint128
    lockedDeltaRaw: uint128
    lockedBeforeRaw: uint128
}

struct StorageExtras {
    referrer: map<address, address>
    streaks: map<address, StreakInfo>
    locked: map<address, LockedState>
    pending: map<uint64, PendingClaim>
    claimCounter: uint64
    // R10 unlock pool start (0 = not started)
    unlockStart: uint64
}

struct Storage {
    // config grouped behind one ref: Storage must stay within 4 refs
    config: Cell<ProtocolConfig>
    // V8 social/unlock state behind one ref
    extras: Cell<StorageExtras>
    currentRoundId: uint8
    successCount: uint8
    lastSettledAt: uint64
    pausedAt: uint64
    rounds: map<uint8, RoundData>
    // stakes[roundId][owner]
    stakes: map<uint8, map<address, StakePosition>>
}

fun Storage.load(): Storage {
    return Storage.fromCell(contract.getData());
}

fun Storage.save(self) {
    contract.setData(self.toCell());
}

fun emptyRoundExtra(): RoundExtra {
    return RoundExtra {
        failureBurnId: 0 as uint256,
        candleHash: 0 as uint256,
        totalWeight: 0,
        bonus: [],
        referred: [],
    };
}

fun emptyExtras(): StorageExtras {
    return StorageExtras {
        referrer: [],
        streaks: [],
        locked: [],
        pending: [],
        claimCounter: 0,
        unlockStart: 0,
    };
}

fun emptyRound(): RoundData {
    return RoundData {
        status: STATUS_UNOPENED,
        targetTier: 0,
        targetPriceUsdE8: 0,
        targetTwap24hUsdE8: 0,
        targetWrittenAt: 0,
        rewardBudgetRaw: 0,
        stakeOpenAt: 0,
        stakeCloseAt: 0,
        observationStart: 0,
        observationEnd: 0,
        candlesSeen: 0,
        qualifiedCandles: 0,
        totalAcceptedStakeRaw: 0,
        settledAt: 0,
        teamReleaseConfirmed: false,
        teamBurnConfirmed: false,
        rewardBurnConfirmed: false,
        principalBurnConfirmed: false,
        rewardBurnDispatched: false,
        principalBurnDispatched: false,
        pauseCount: 0,
        extra: emptyRoundExtra().toCell(),
    };
}

fun roundView(roundId: uint8, rd: RoundData): RoundView {
    val extra = rd.extra.load();
    return {
        roundId,
        status: rd.status,
        targetTier: rd.targetTier,
        targetPriceUsdE8: rd.targetPriceUsdE8,
        targetTwap24hUsdE8: rd.targetTwap24hUsdE8,
        targetWrittenAt: rd.targetWrittenAt,
        rewardBudgetRaw: rd.rewardBudgetRaw,
        stakeOpenAt: rd.stakeOpenAt,
        stakeCloseAt: rd.stakeCloseAt,
        observationStart: rd.observationStart,
        observationEnd: rd.observationEnd,
        candlesSeen: rd.candlesSeen,
        qualifiedCandles: rd.qualifiedCandles,
        totalAcceptedStakeRaw: rd.totalAcceptedStakeRaw,
        settledAt: rd.settledAt,
        teamReleaseConfirmed: rd.teamReleaseConfirmed,
        teamBurnConfirmed: rd.teamBurnConfirmed,
        rewardBurnConfirmed: rd.rewardBurnConfirmed,
        principalBurnConfirmed: rd.principalBurnConfirmed,
        failureBurnId: extra.failureBurnId,
        candleHash: extra.candleHash,
        totalWeight: extra.totalWeight,
    };
}

// ===========================================================================
// Custom messages (docs/04 §5 + docs/17 §4.2)
// ===========================================================================

struct (0x52540001) OpenRound {
    queryId: uint64
    twap24hUsdE8: uint128
}

struct (0x52540002) CloseStaking {
    queryId: uint64
    twap1hUsdE8: uint128
}

struct (0x52540003) SubmitCandle {
    queryId: uint64
    roundId: uint8
    candleIndex: uint8
    periodStart: uint32
    periodEnd: uint32
    twapPriceUsdE8: uint128
    dataDigest: uint256
}

struct (0x52540005) FinalizeRound {
    queryId: uint64
    roundId: uint8
}

struct (0x52540006) ClaimPrincipal {
    queryId: uint64
    roundId: uint8
}

struct (0x52540007) ClaimReward {
    queryId: uint64
    roundId: uint8
}

struct (0x52540009) BurnAck {
    roundId: uint8
    kind: uint8
    amountRaw: uint128
    burnId: uint256
}

struct (0x5254000A) PauseOracle {
    queryId: uint64
    reason: uint32
}

struct (0x5254000B) ResumeOracle {
    queryId: uint64
}

struct (0x5254000C) ReleaseTeamQuota {
    queryId: uint64
    roundId: uint8
}

struct (0x5254000D) BurnTeamQuota {
    queryId: uint64
    roundId: uint8
    burnId: uint256
}

struct (0x5254000E) ClaimAll {
    queryId: uint64
    // 0 => scan every settled round (bounded by MAX_CLAIM_SCAN_ROUNDS)
    roundId: uint8
}

struct (0x52540010) AbortTechnical {
    queryId: uint64
}

struct (0x52540011) StartObservation {
    queryId: uint64
    roundId: uint8
}

struct (0x52540012) InitController {
    controller: address
}

struct (0x52540013) TeamReleasedAck {
    queryId: uint64
    roundId: uint8
    amountRaw: uint128
}

struct (0x52540014) TeamBurnedAck {
    queryId: uint64
    roundId: uint8
    amountRaw: uint128
    burnId: uint256
}

struct (0x52540015) RetryPendingActions {
    queryId: uint64
    roundId: uint8
}

struct (0x52540016) SetJettonWallet {
    wallet: address
}

// P0: one-time admin message storing the canonical Jetton Wallet code so the RC
// can derive the expected ReturnExcessesBack sender for each claim owner.
struct (0x5254001B) SetJettonWalletCode {
    code: cell
}

struct (0x5254001C) SetTeamWalletJettonWallet {
    wallet: address
}

// V8 reward-state opcodes (docs/17 §4.2)
struct (0x52540017) ClaimRewardEarly {
    queryId: uint64
    roundId: uint8
}

struct (0x52540018) RollReward {
    queryId: uint64
    roundId: uint8
}

struct (0x52540019) SetReferrer {
    referrer: address
}

struct (0x5254001A) ClaimUnlocked {
    queryId: uint64
}

// ===========================================================================
// TEP-74 messages
// ===========================================================================

type ForwardPayloadRemainder = RemainingBitsAndRefs

struct (0b0) PayloadInline {
    value: RemainingBitsAndRefs
}

struct (0b1) PayloadInRef {
    value: Cell<RemainingBitsAndRefs>
}

struct (0x0f8a7ea5) AskToTransfer {
    queryId: uint64
    jettonAmount: coins
    transferRecipient: address
    sendExcessesTo: address?
    customPayload: cell?
    forwardTonAmount: coins
    @abi.clientType(PayloadInline | PayloadInRef)
    forwardPayload: ForwardPayloadRemainder
}

struct (0x595f07bc) AskToBurn {
    queryId: uint64
    jettonAmount: coins
    sendExcessesTo: address?
    customPayload: cell?
}

struct (0x7362d09c) TransferNotification {
    queryId: uint64
    jettonAmount: coins
    // TEP-74 official notification: sender:MsgAddressInt (required, not Maybe)
    transferInitiator: address
    @abi.clientType(PayloadInline | PayloadInRef)
    forwardPayload: ForwardPayloadRemainder
}

struct (0xd372158c) TopUpTons {}

// P0-2: TEP-74 wallet/master excess-return message; also used as completion ack.
struct (0xd53276db) ReturnExcessesBack {
    queryId: uint64
}

// StakePayload carried inside transfer_notification.forward_payload.
// op(32)+version(8)+roundId(8)+depositNonce(64)+riskVersion(16)+acceptBurn(8) = 136 bit.
struct (0x5254000F) StakeDeposit {
    version: uint8
    roundId: uint8
    depositNonce: uint64
    riskDisclosureVersion: uint16
    acceptFullPrincipalBurn: uint8
}

// ===========================================================================
// Get-method return helpers
// ===========================================================================

struct Claimable {
    principalRaw: uint128
    rewardRaw: uint128
    roundsMask: uint16
}

struct RoundBurnStatus {
    rewardBurnConfirmed: bool
    teamBurnConfirmed: bool
    principalBurnConfirmed: bool
    failureBurnId: uint256
}

struct RewardStateInfo {
    amountRaw: uint128
    state: uint8
    rollableRaw: uint128
    earlyAmountRaw: uint128
}

struct UnlockInfo {
    unlockStart: uint64
    totalLockedRaw: uint128
    claimedRaw: uint128
    claimableRaw: uint128
}

struct ReferralInfo {
    referrer: address?
    referredStakeThisRound: uint128
    bonusThisRound: uint128
}

// ===========================================================================
// TeamVault storage / types (unchanged)
// ===========================================================================

struct TeamVaultConfig {
    admin: address
    controller: address?
    configVersion: uint32
}

struct TeamVaultParams {
    jettonWallet: address
    teamWallet: address
    // P0-2 closure: only ReturnExcessesBack from this master confirms a team burn
    jettonMaster: address
    teamRoundRaw: uint128
}

struct TeamRoundState {
    released: bool
    burned: bool
    amountRaw: uint128
    queryId: uint64
}

struct TeamVaultExtra {
    // P0: expected ReturnExcessesBack sender for team-wallet transfers.
    teamWalletJettonWallet: address
}

struct TeamVaultStorage {
    config: TeamVaultConfig
    params: Cell<TeamVaultParams>
    extra: Cell<TeamVaultExtra>
    rounds: map<uint8, TeamRoundState>
    // pending burn burnId per round (kept until Jetton Master confirms)
    pendingBurnIds: map<uint8, uint256>
    totalReleasedRaw: uint128
    totalBurnedRaw: uint128
    releasedCount: uint8
    burnedCount: uint8
}

fun TeamVaultStorage.load(): TeamVaultStorage {
    return TeamVaultStorage.fromCell(contract.getData());
}

fun TeamVaultStorage.save(self) {
    contract.setData(self.toCell());
}

struct TeamVaultState {
    controller: address?
    jettonWallet: address
    teamWallet: address
    teamRoundRaw: uint128
    totalReleasedRaw: uint128
    totalBurnedRaw: uint128
    releasedCount: uint8
    burnedCount: uint8
}

// ===========================================================================
// Events (external-out logs)
// ===========================================================================

struct (0x52540101) TargetPriceSet {
    roundId: uint8
    tier: uint8
    targetPriceUsdE8: uint128
    twap24hUsdE8: uint128
}

struct (0x52540102) RoundSettled {
    roundId: uint8
    status: uint8
    qualifiedCandles: uint8
    candlesSeen: uint8
    totalAcceptedStakeRaw: uint128
    tierAfter: uint8
}

struct (0x52540103) DepositAccepted {
    roundId: uint8
    owner: address
    amountRaw: uint128
    totalAcceptedStakeRaw: uint128
}

struct (0x52540104) TechnicalAborted {
    roundId: uint8
    reason: uint8
    at: uint64
}

struct (0x52540201) TeamReleased {
    roundId: uint8
    amountRaw: uint128
    to: address
}

struct (0x52540202) TeamBurned {
    roundId: uint8
    amountRaw: uint128
    burnId: uint256
}

struct (0x52540105) RewardRolled {
    roundId: uint8
    owner: address
    amountRaw: uint128
    nextRoundId: uint8
}

struct (0x52540106) RewardEarly {
    roundId: uint8
    owner: address
    paidRaw: uint128
    lockedRaw: uint128
}

struct (0x52540107) ReferrerSet {
    owner: address
    referrer: address
}

struct (0x52540108) UnlockClaimed {
    owner: address
    amountRaw: uint128
}


// ===========================================================================
// OracleAdapter (mainnet M-2): 3/5 ed25519 signed submissions -> RC forwarder.
// ===========================================================================

struct OracleSignerKeys {
    s0: uint256
    s1: uint256
    s2: uint256
    s3: uint256
    s4: uint256
    threshold: uint8
}

struct OracleAdapterConfig {
    admin: address
    controller: address?
    chainId: uint32
    configVersion: uint32
    signers: Cell<OracleSignersPacked>
}

// Packed signer keys: inline s0,s1,s2 (768 bits) + one ref cell with s3,s4 + threshold.
struct OracleSignersPacked {
    s0: uint256
    s1: uint256
    s2: uint256
    threshold: uint8
    tail: Cell<OracleSignersTail>
}

struct OracleSignersTail {
    s3: uint256
    s4: uint256
}

struct OraclePendingForward {
    kind: uint8
    prevLastPlus: uint8
    acceptedLastPlus: uint8
}

struct OracleAdapterStorage {
    config: Cell<OracleAdapterConfig>
    usedMask: map<uint8, uint8>
    lastCandle: map<uint8, uint8>
    // C-3: keyed by forwarded queryId = roundId<<16 | action<<8 | candleIndex
    pending: map<uint64, OraclePendingForward>
}

struct OracleConfigView {
    admin: address
    controller: address?
    chainId: uint32
    configVersion: uint32
    threshold: uint8
}

struct OracleSignerSetView {
    s0: uint256
    s1: uint256
    s2: uint256
    s3: uint256
    s4: uint256
    threshold: uint8
}

struct OracleUsedActions {
    openUsed: bool
    closeUsed: bool
    lastCandleIndex: uint8
}

struct (0x52540021) SetSignerSet {
    signers: cell
    threshold: uint8
    chainId: uint32
    configVersion: uint32
}

struct (0x52540022) SetOracleController {
    controller: address
}

struct (0x52540023) SetOracleAdmin {
    admin: address
}

struct (0x52540024) SubmitSignedOpenRound {
    roundId: uint8
    twap24hUsdE8: uint128
    timestamp: uint64
    sigCount: uint8
    sigs: cell
}

struct (0x52540025) SubmitSignedCloseStaking {
    roundId: uint8
    twap1hUsdE8: uint128
    timestamp: uint64
    sigCount: uint8
    sigs: cell
}

struct (0x52540026) SubmitSignedCandle {
    roundId: uint8
    candleIndex: uint8
    periodStart: uint32
    periodEnd: uint32
    twapPriceUsdE8: uint128
    dataDigest: uint256
    timestamp: uint64
    sigCount: uint8
    sigs: cell
}
