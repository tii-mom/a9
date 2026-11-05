// A9 Protocol — storage, message and event types.
// Logical layout follows docs/04 §3/§4/§5; concrete cell layout is Tolk-native.
//
// NOTE ON CELL SIZE: Tolk rejects structs whose estimated serialization exceeds
// 1023 bits. Groups of addresses / round extras are therefore stored behind
// refs (Cell<T>), which also keeps the root state cell small.

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
    // 1000 bps = 10% of the round total per address
    maxStakePerAddressBps: uint16
    // 200,000,000 * 10^9
    maxTotalStakeRaw: uint128
}

struct ProtocolTiming {
    // 86,400 (24h PREVIEW, V6)
    previewSeconds: uint32
    // 259,200 (72h staking window)
    stakeDurationSeconds: uint32
    // 14,400 (4h candle)
    candleSeconds: uint32
    // 18
    candleCount: uint8
    // 12
    minQualifiedCandles: uint8
    // 259,200 (72h observation window)
    observationSeconds: uint32
    // 1,209,600 (14 days continuous oracle pause)
    techAbortPauseSeconds: uint32
    // 604,800 (7 days observation-end timeout)
    techAbortObsTimeoutSeconds: uint32
    // Risk disclosure version accepted by deposit payload (testnet starts at 1)
    riskDisclosureVersion: uint16
    configVersion: uint32
}

struct ProtocolConfig {
    addresses: Cell<ProtocolAddresses>
    vaults: Cell<ProtocolVaults>
    econ: Cell<ProtocolEcon>
    timing: Cell<ProtocolTiming>
}

// Flat view returned by get_protocol_config() (get methods return stack tuples,
// not cells, so no 1023-bit constraint applies here).
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
// Round storage
// ===========================================================================

struct CandleRecord {
    periodStart: uint32
    periodEnd: uint32
    twapPriceUsdE8: uint128
    qualified: bool
    dataDigest: uint256
}

struct StakePosition {
    amountRaw: uint128
    lastDepositNonce: uint64
    principalClaimed: bool
    rewardClaimed: bool
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
    // ref: keeps the round cell under 1023 bits
    failureBurnId: Cell<uint256>
    candles: map<uint8, CandleRecord>
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
}

struct Storage {
    // config grouped behind one ref: Storage must stay within 4 refs
    config: Cell<ProtocolConfig>
    // 0 = nothing opened yet; otherwise the currently active (or last) round id.
    currentRoundId: uint8
    // Number of rounds settled as SUCCEEDED. Next tier = successCount + 1 (D-28).
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
        failureBurnId: (0 as uint256).toCell(),
        candles: [],
    };
}

fun roundView(roundId: uint8, rd: RoundData): RoundView {
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
        failureBurnId: rd.failureBurnId.load(),
    };
}

// ===========================================================================
// Custom messages (docs/04 §5)
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

// One-time deployment initializer: the canonical Jetton Wallet address of the
// contract is derived from (jetton master, owner = this contract), so it cannot
// be baked into the state init (cyclic address). Admin sets it exactly once
// before the protocol starts.
struct (0x52540016) SetJettonWallet {
    wallet: address
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

// StakePayload carried inside transfer_notification.forward_payload.
// op(32)+version(8)+roundId(8)+depositNonce(64)+riskVersion(16)+acceptBurn(8) = 136 bit.
struct (0x5254000F) StakeDeposit {
    version: uint8
    roundId: uint8
    depositNonce: uint64
    riskDisclosureVersion: uint16
    // 0/1, uint8 on the wire per lead ABI decision (must be 1)
    acceptFullPrincipalBurn: uint8
}

// ===========================================================================
// Get-method return helpers
// ===========================================================================

struct Claimable {
    principalRaw: uint128
    rewardRaw: uint128
    // bit i set => round (i+1) included in the returned amounts
    roundsMask: uint16
}

struct RoundBurnStatus {
    rewardBurnConfirmed: bool
    teamBurnConfirmed: bool
    principalBurnConfirmed: bool
    failureBurnId: uint256
}

// ===========================================================================
// TeamVault storage / types
// ===========================================================================

struct TeamVaultConfig {
    // deployer/admin until InitController is called once
    admin: address
    // null until initialized; immutable afterwards
    controller: address?
    configVersion: uint32
}

struct TeamVaultParams {
    jettonWallet: address
    teamWallet: address
    teamRoundRaw: uint128
}

struct TeamRoundState {
    released: bool
    burned: bool
    amountRaw: uint128
    queryId: uint64
}

struct TeamVaultStorage {
    config: TeamVaultConfig
    // ref to stay under the 1023-bit root cell limit
    params: Cell<TeamVaultParams>
    rounds: map<uint8, TeamRoundState>
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
