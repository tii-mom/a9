// A9 Protocol v10 — storage, message, event and view types for RoundController.
// Every cell stays under 1023 bits / 4 refs; config groups live behind refs.

import "constants"

// ===========================================================================
// Config (immutable after deployment)
// ===========================================================================

struct ProtocolAddresses {
    // single hot key (keeper) that opens rounds and submits candles (D-41, single-sig)
    keeper: address
    jettonMaster: address
    // receives 1.2e8 A9 per successful round
    teamWallet: address
}

struct ProtocolEcon {
    p0UsdE8: uint128
    roundRewardRaw: uint128
    teamRoundRaw: uint128
    minStakeRaw: uint128
    maxStakePerAddressRaw: uint128
    maxTotalStakeRaw: uint128
}

struct ProtocolTiming {
    previewSeconds: uint32
    stakeDurationSeconds: uint32
    candleSeconds: uint32
    candleCount: uint8
    minQualifiedCandles: uint8
    // after this delay past the expected end of a stage, anyone may abort
    abortTimeoutSeconds: uint32
    riskDisclosureVersion: uint16
    configVersion: uint32
}

struct ProtocolConfig {
    addresses: Cell<ProtocolAddresses>
    econ: Cell<ProtocolEcon>
    timing: Cell<ProtocolTiming>
    // standard Jetton Wallet code: RC derives its own wallet address on-chain,
    // so no admin wiring step exists at all.
    jettonWalletCode: cell
}

// ===========================================================================
// Round / stake storage
// ===========================================================================

struct RoundData {
    status: uint8
    targetTier: uint8
    targetPriceUsdE8: uint128
    targetTwap24hUsdE8: uint128
    stakeOpenAt: uint64
    // = observationStart; for PREVIEW rounds this is unused (0)
    stakeCloseAt: uint64
    settledAt: uint64
    candlesSeen: uint8
    qualifiedCandles: uint8
    totalStakeRaw: uint128
    stakerCount: uint16
    // settlement actions dispatched (ACTION_* bits) and those that bounced
    actionsSent: uint8
    retryMask: uint8
    // rolling sha256 over submitted candles: H(prev || index || twap || digest)
    candleHash: uint256
}

struct StakePosition {
    amountRaw: uint128
    lastDepositNonce: uint64
    claimed: bool
}

struct Storage {
    config: Cell<ProtocolConfig>
    currentRoundId: uint8
    successCount: uint8
    // round 0 = refund ledger (only amounts >= minStake that could not be refunded instantly)
    rounds: map<uint8, RoundData>
    stakes: map<uint8, map<address, StakePosition>>
}

fun Storage.load(): Storage {
    return Storage.fromCell(contract.getData());
}

fun Storage.save(self) {
    contract.setData(self.toCell());
}

fun emptyRound(): RoundData {
    return {
        status: STATUS_UNOPENED,
        targetTier: 0,
        targetPriceUsdE8: 0,
        targetTwap24hUsdE8: 0,
        stakeOpenAt: 0,
        stakeCloseAt: 0,
        settledAt: 0,
        candlesSeen: 0,
        qualifiedCandles: 0,
        totalStakeRaw: 0,
        stakerCount: 0,
        actionsSent: 0,
        retryMask: 0,
        candleHash: 0 as uint256,
    };
}

// ===========================================================================
// Inbound messages
// ===========================================================================

struct (0x52540001) OpenRound {
    queryId: uint64
    twap24hUsdE8: uint128
}

// Kept for ABI compatibility; the TWAP field is ignored (no early close in v10).
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

// Claim one round: principal (+ reward if SUCCEEDED). roundId 0 = refund ledger.
struct (0x52540006) Claim {
    queryId: uint64
    roundId: uint8
}

// Claim everything claimable in rounds 0..10 with one transfer (roundId ignored).
struct (0x5254000E) ClaimAll {
    queryId: uint64
    roundId: uint8
}

struct (0x52540010) AbortTechnical {
    queryId: uint64
}

struct (0x52540015) RetrySettlement {
    queryId: uint64
    roundId: uint8
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

struct (0x7362d09c) TransferNotification {
    queryId: uint64
    jettonAmount: coins
    transferInitiator: address
    @abi.clientType(PayloadInline | PayloadInRef)
    forwardPayload: ForwardPayloadRemainder
}

struct (0xd372158c) TopUpTons {}

// Leftover TON returned by the Jetton Master after a settlement burn. No-op.
struct (0xd53276db) ReturnExcessesBack {
    queryId: uint64
}

// StakePayload carried inside transfer_notification.forward_payload (unchanged):
// op(32)+version(8)+roundId(8)+depositNonce(64)+riskVersion(16)+acceptBurn(8) = 136 bit.
struct (0x5254000F) StakeDeposit {
    version: uint8
    roundId: uint8
    depositNonce: uint64
    riskDisclosureVersion: uint16
    acceptFullPrincipalBurn: uint8
}

// ===========================================================================
// Events
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
    // burn breakdown (all 0 on success with stakers)
    rewardBurnRaw: uint128
    teamBurnRaw: uint128
    principalBurnRaw: uint128
    teamReleasedRaw: uint128
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

struct (0x5254010B) StakingClosed {
    roundId: uint8
    closeAt: uint64
    early: bool
    twap1hUsdE8: uint128
}

struct (0x5254010C) CandleSubmitted {
    roundId: uint8
    candleIndex: uint8
    periodStart: uint32
    periodEnd: uint32
    twapPriceUsdE8: uint128
    dataDigest: uint256
    candleHash: uint256
}

struct (0x5254010E) Claimed {
    owner: address
    // bit (r-1) = round r; bit 15 = refund ledger
    roundsMask: uint16
    principalRaw: uint128
    rewardRaw: uint128
}

struct (0x5254010F) DepositRefunded {
    owner: address
    amountRaw: uint128
    // true: sent back now; false: credited to the refund ledger (round 0)
    instant: bool
    // false: sub-minimum dust without TON for a refund, kept by the contract
    recorded: bool
}

struct (0x52540110) SettlementBounced {
    roundId: uint8
    action: uint8
}

struct (0x52540111) UnexpectedBounce {
    op: uint32
    queryId: uint64
}

// ===========================================================================
// Get-method views (shapes kept from v8.9 so existing decoders keep working;
// retired fields are filled with neutral values, see README §4)
// ===========================================================================

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

struct StakePositionView {
    amountRaw: uint128
    lastDepositNonce: uint64
    principalClaimed: bool
    rewardClaimed: bool
    weight: uint128
    rewardState: uint8
}

struct Claimable {
    principalRaw: uint128
    rewardRaw: uint128
    roundsMask: uint16
}
