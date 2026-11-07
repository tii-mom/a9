// A9 Protocol v11 — storage, message, event and view types for RoundController.
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
}

struct ProtocolTiming {
    previewSeconds: uint32
    stakeDurationSeconds: uint32
    candleSeconds: uint32
    candleCount: uint8
    minQualifiedCandles: uint8
    // after this delay past the expected end of a stage, anyone may abort
    abortTimeoutSeconds: uint32
    // locked 80% fallback: linear unlock window after round 10 (and final team release delay).
    // Mainnet 30 days; fast testnet profiles use seconds (docs/35 D-45).
    fallbackUnlockSeconds: uint32
    riskDisclosureVersion: uint16
    configVersion: uint32
}

struct ProtocolCodes {
    // standard Jetton Wallet code: RC derives its own wallet address on-chain,
    // so no admin wiring step exists at all.
    jettonWalletCode: cell
    // StakeTicket code: RC verifies tickets by address derivation
    ticketCode: cell
}

struct ProtocolConfig {
    addresses: Cell<ProtocolAddresses>
    econ: Cell<ProtocolEcon>
    timing: Cell<ProtocolTiming>
    codes: Cell<ProtocolCodes>
}

// ===========================================================================
// Round / stake storage
// ===========================================================================

// Rarely-written round fields live behind a ref to keep RoundData under 1023 bits.
struct RoundExtra {
    targetTwap24hUsdE8: uint128
    // rolling sha256 over submitted candles: H(prev || index || twap || digest)
    candleHash: uint256
    // exact settlement amounts, kept so RetrySettlement resends the same thing
    burnRaw: uint128
    teamTransferRaw: uint128
}

struct RoundData {
    status: uint8
    targetTier: uint8
    targetPriceUsdE8: uint128
    stakeOpenAt: uint64
    // = observationStart; for PREVIEW rounds this is unused (0)
    stakeCloseAt: uint64
    settledAt: uint64
    candlesSeen: uint8
    qualifiedCandles: uint8
    totalStakeRaw: uint128
    // sum of stake x timing coefficient; rewards are split by weight
    totalWeightRaw: uint128
    // 7e8 + carry rolled in from failed / empty / aborted rounds, fixed at open
    rewardBudgetRaw: uint128
    // accepted deposits (not distinct addresses: tickets are not looked up)
    stakeCount: uint32
    // settlement actions dispatched (ACTION_* bits) and those that bounced
    actionsSent: uint8
    retryMask: uint8
    extra: Cell<RoundExtra>
}

struct Storage {
    config: Cell<ProtocolConfig>
    currentRoundId: uint8
    successCount: uint8
    rounds: map<uint8, RoundData>
    // reward budget waiting to be added to the next opened round
    carryRaw: uint128
    // last round that succeeded (unlocks every earlier round's 80% locked reward)
    lastSuccessRound: uint8
    // team quota of the last success, paid at the next success (D-47)
    teamPendingRaw: uint128
    // time round 10 settled / was aborted; starts the 30-day fallback unlock
    endAt: uint64
}

fun Storage.load(): Storage {
    return Storage.fromCell(contract.getData());
}

fun Storage.save(self) {
    contract.setData(self.toCell());
}

fun emptyExtra(): RoundExtra {
    return { targetTwap24hUsdE8: 0, candleHash: 0 as uint256, burnRaw: 0, teamTransferRaw: 0 };
}

fun emptyRound(): RoundData {
    return {
        status: STATUS_UNOPENED,
        targetTier: 0,
        targetPriceUsdE8: 0,
        stakeOpenAt: 0,
        stakeCloseAt: 0,
        settledAt: 0,
        candlesSeen: 0,
        qualifiedCandles: 0,
        totalStakeRaw: 0,
        totalWeightRaw: 0,
        rewardBudgetRaw: 0,
        stakeCount: 0,
        actionsSent: 0,
        retryMask: 0,
        extra: emptyExtra().toCell(),
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

// Anyone, once endAt + 30 days has passed: pays the last pending team quota (D-47).
struct (0x52540016) ReleaseTeam {
    queryId: uint64
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

// StakePayload v2 carried inside transfer_notification.forward_payload (ref cell):
// op(32)+version(8)=2+roundId(8)+riskVersion(16)+acceptBurn(8)+beneficiary(address or none).
// beneficiary = none -> the stake belongs to the transfer initiator (D-49).
struct (0x5254000F) StakeDeposit {
    version: uint8
    roundId: uint8
    riskDisclosureVersion: uint16
    acceptFullPrincipalBurn: uint8
    beneficiary: address?
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
    // burn breakdown: rewardBurn = half the budget on failure, + leftover carry after round 10
    rewardBurnRaw: uint128
    teamBurnRaw: uint128
    principalBurnRaw: uint128
    // team quota of the PREVIOUS success paid now (D-47)
    teamReleasedRaw: uint128
    rewardBudgetRaw: uint128
    carryAfterRaw: uint128
}

struct (0x52540103) DepositAccepted {
    roundId: uint8
    owner: address
    amountRaw: uint128
    weightRaw: uint128
    totalAcceptedStakeRaw: uint128
    totalWeightRaw: uint128
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
    roundId: uint8
    principalRaw: uint128
    // immediate 20% (first claim) + newly unlocked part of the locked 80%
    rewardRaw: uint128
}

struct (0x5254010F) DepositRefunded {
    owner: address
    amountRaw: uint128
    // true: sent back now; false: not enough forward TON, kept by the contract
    instant: bool
}

struct (0x52540112) Restaked {
    owner: address
    fromRound: uint8
    toRound: uint8
    amountRaw: uint128
    weightRaw: uint128
}

struct (0x52540113) TeamReleased {
    // round whose success released the quota (0 = final ReleaseTeam)
    roundId: uint8
    amountRaw: uint128
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

struct ProtocolStateView {
    carryRaw: uint128
    lastSuccessRound: uint8
    teamPendingRaw: uint128
    endAt: uint64
    successCount: uint8
    currentRoundId: uint8
    fallbackUnlockSeconds: uint32
}

// What a ticket with this weight is owed right now (reads only round state).
struct RewardPreview {
    rewardRaw: uint128
    immediateRaw: uint128
    lockedRaw: uint128
    unlockedLockedRaw: uint128
}
