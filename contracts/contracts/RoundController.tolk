// A9 Protocol — RoundController (docs/02 state machine, docs/04 §2.2, docs/11 §4.1)
//
// Implements:
//   * 10-round state machine with PREVIEW (24h) -> STAKING_OPEN (72h) ->
//     STAKING_CLOSED -> OBSERVING (18 x 4h) -> SETTLING_* -> terminal
//   * target price locked at open: max(P0 * 2^tier, 2 * 24h TWAP)
//   * tier semantics D-28: failure retries the same tier, success increments it
//   * stake ledger with nonce dedup, min / per-address 10% / round cap limits
//   * success settlement: pull-claim principal + proportional reward + TeamVault release
//   * failure settlement: three burns (reward / team / principal) with 3 acks
//   * 0-stake success: reward burn (D-18b) + team release
//   * technical abort: 14d paused or observation-end + 7d, anyone, refund principal only
//   * claimAll: single call, bounded 10-round scan, one combined Jetton transfer
//
// The controller also acts as the staking + reward vault (V6.1 self-developed
// surface is exactly RoundController + TeamVault; docs/04 Vault names are logical).

import "types"
import "constants"
import "jetton"

contract RoundController {
    author: "A9 Protocol"
    version: "1.0.0"
    description: "A9 round state machine, stake ledger, settlement and pull-claim controller."
    storage: Storage
    incomingMessages: RoundControllerAllowedMessage
}

type RoundControllerAllowedMessage =
    | OpenRound
    | CloseStaking
    | SubmitCandle
    | FinalizeRound
    | ClaimPrincipal
    | ClaimReward
    | ClaimAll
    | PauseOracle
    | ResumeOracle
    | AbortTechnical
    | StartObservation
    | RetryPendingActions
    | SetJettonWallet
    | BurnAck
    | TeamReleasedAck
    | TeamBurnedAck
    | TransferNotification
    | TopUpTons

// ===========================================================================
// Entry point
// ===========================================================================

fun onInternalMessage(in: InMessage) {
    val msg = lazy RoundControllerAllowedMessage.fromSlice(in.body);

    match (msg) {
        OpenRound => {
            handleOpenRound(in.senderAddress, msg);
        }
        CloseStaking => {
            handleCloseStaking(in.senderAddress, msg);
        }
        SubmitCandle => {
            handleSubmitCandle(in.senderAddress, msg);
        }
        FinalizeRound => {
            handleFinalizeRound(in.senderAddress, msg);
        }
        ClaimPrincipal => {
            handleClaimPrincipal(in.senderAddress, msg);
        }
        ClaimReward => {
            handleClaimReward(in.senderAddress, msg);
        }
        ClaimAll => {
            handleClaimAll(in.senderAddress, msg);
        }
        PauseOracle => {
            handlePauseOracle(in.senderAddress, msg);
        }
        ResumeOracle => {
            handleResumeOracle(in.senderAddress, msg);
        }
        AbortTechnical => {
            handleAbortTechnical(in.senderAddress, msg);
        }
        StartObservation => {
            handleStartObservation(in.senderAddress, msg);
        }
        RetryPendingActions => {
            handleRetryPendingActions(in.senderAddress, msg);
        }
        SetJettonWallet => {
            handleSetJettonWallet(in.senderAddress, msg);
        }
        BurnAck => {
            handleBurnAck(in.senderAddress, msg);
        }
        TeamReleasedAck => {
            handleTeamReleasedAck(in.senderAddress, msg);
        }
        TeamBurnedAck => {
            handleTeamBurnedAck(in.senderAddress, msg);
        }
        TransferNotification => {
            handleTransferNotification(in.senderAddress, msg);
        }
        TopUpTons => {}
        else => throw Errors.UnknownMessage,
    }
}

fun onBouncedMessage(_in: InMessageBounced) {
    // Outgoing messages are all idempotent instructions. A bounced child is
    // recovered by the permissionless Finalize/Retry paths; no funds are moved
    // on a bounce, and no state is rolled back here.
}

// ===========================================================================
// Config helpers
// ===========================================================================

fun addresses(s: Storage): ProtocolAddresses {
    return s.config.load().addresses.load();
}

fun vaults(s: Storage): ProtocolVaults {
    return s.config.load().vaults.load();
}

fun econ(s: Storage): ProtocolEcon {
    return s.config.load().econ.load();
}

fun timing(s: Storage): ProtocolTiming {
    return s.config.load().timing.load();
}

fun requireAdmin(s: Storage, sender: address) {
    assert (sender == addresses(s).admin) throw Errors.NotAdmin;
}

fun requireAdminOrOracle(s: Storage, sender: address) {
    val a = addresses(s);
    assert (sender == a.admin || sender == a.oracle) throw Errors.NotOracle;
}

fun isTerminal(status: uint8): bool {
    return status == STATUS_SUCCEEDED || status == STATUS_FAILED_PERMANENT ||
        status == STATUS_TECHNICAL_ABORTED;
}

// P0 * priceMultiplier^tier (tier = successCount + 1, D-28)
fun floorPriceForTier(e: ProtocolEcon, tier: uint8): uint128 {
    var mult: uint128 = 1;
    var i: uint8 = 0;
    while (i < tier) {
        mult = mult * (e.priceMultiplier as uint128);
        i += 1;
    }
    return e.p0UsdE8 * mult;
}

fun rewardForRound(rd: RoundData, pos: StakePosition): uint128 {
    if (rd.totalAcceptedStakeRaw == 0) {
        return 0;
    }
    return rd.rewardBudgetRaw * pos.amountRaw / rd.totalAcceptedStakeRaw;
}

fun burnIdForRound(roundId: uint8, configVersion: uint32): uint256 {
    return beginCell()
        .storeUint(roundId, 8)
        .storeUint(0xff, 8) // failure-domain marker
        .storeUint(configVersion, 32)
        .endCell()
        .hash();
}

fun ensureRoundExists(s: Storage, roundId: uint8): RoundData {
    assert (roundId >= 1 && roundId <= MAX_ROUNDS) throw Errors.BadRoundId;
    val r = s.rounds.get(roundId);
    assert (r.isFound) throw Errors.BadRoundId;
    return r.loadValue();
}

// ===========================================================================
// Round lifecycle
// ===========================================================================

fun handleOpenRound(sender: address, msg: OpenRound) {
    var s = lazy Storage.load();
    requireAdminOrOracle(s, sender);
    val now: uint64 = blockchain.now() as uint64;
    val e = econ(s);
    val t = timing(s);

    var roundId: uint8 = 0;
    var rd: RoundData;
    if (s.currentRoundId == 0) {
        roundId = 1;
        rd = emptyRound();
        // R1 has no PREVIEW: the open tx defines the staking window.
        rd.stakeOpenAt = now;
    } else {
        assert (s.currentRoundId < MAX_ROUNDS) throw Errors.MaxRoundsReached;
        val prev = ensureRoundExists(s, s.currentRoundId);
        assert (isTerminal(prev.status)) throw Errors.PreviousRoundNotSettled;
        roundId = s.currentRoundId + 1;
        rd = ensureRoundExists(s, roundId);
        assert (rd.status == STATUS_PREVIEW) throw Errors.BadRoundStatus;
        assert (now >= rd.stakeOpenAt) throw Errors.PreviewNotFinished;
        // Liveness fallback: if the permissioned opener missed the whole 72h
        // window, re-anchor the window to "now" instead of leaving the round
        // unopenable forever. stakeOpenAt is deterministic only when a keeper
        // opens within [previewEnd, previewEnd + stakeDuration). Documented in
        // contracts/README (ops must monitor the 3 countdowns).
        if (now >= rd.stakeOpenAt + (t.stakeDurationSeconds as uint64)) {
            rd.stakeOpenAt = now;
        }
    }

    val tier: uint8 = s.successCount + 1;
    val floorPrice = floorPriceForTier(e, tier);
    val twapTarget = msg.twap24hUsdE8 * 2;
    val target: uint128 = twapTarget > floorPrice ? twapTarget : floorPrice;
    assert (target > 0) throw Errors.BadConfig;

    rd.status = STATUS_STAKING_OPEN;
    rd.targetTier = tier;
    rd.targetPriceUsdE8 = target;
    rd.targetTwap24hUsdE8 = msg.twap24hUsdE8;
    rd.targetWrittenAt = now;
    rd.rewardBudgetRaw = e.roundRewardRaw;
    rd.stakeCloseAt = rd.stakeOpenAt + (t.stakeDurationSeconds as uint64);
    s.currentRoundId = roundId;
    s.rounds.set(roundId, rd);
    s.save();

    emitExternalEvent(TargetPriceSet {
        roundId,
        tier,
        targetPriceUsdE8: target,
        twap24hUsdE8: msg.twap24hUsdE8,
    });
}

fun handleCloseStaking(_sender: address, msg: CloseStaking) {
    var s = lazy Storage.load();
    val now: uint64 = blockchain.now() as uint64;
    val rd = ensureRoundExists(s, s.currentRoundId);
    assert (rd.status == STATUS_STAKING_OPEN) throw Errors.BadRoundStatus;

    var closeAt: uint64 = 0;
    if (now >= rd.stakeCloseAt) {
        closeAt = rd.stakeCloseAt;
    } else if (msg.twap1hUsdE8 >= rd.targetPriceUsdE8 && msg.twap1hUsdE8 > 0) {
        // touch-price early close (V6 kept)
        closeAt = now;
    } else {
        throw Errors.TooEarly;
    }

    var updated = rd;
    updated.status = STATUS_STAKING_CLOSED;
    updated.stakeCloseAt = closeAt;
    updated.observationStart = closeAt;
    updated.observationEnd = closeAt + (timing(s).observationSeconds as uint64);
    s.rounds.set(s.currentRoundId, updated);
    s.save();
}

fun handleStartObservation(_sender: address, msg: StartObservation) {
    var s = lazy Storage.load();
    val now: uint64 = blockchain.now() as uint64;
    assert (msg.roundId == s.currentRoundId) throw Errors.BadRoundId;
    val rd = ensureRoundExists(s, msg.roundId);
    assert (rd.status == STATUS_STAKING_CLOSED) throw Errors.BadRoundStatus;
    assert (rd.observationStart > 0 && now >= rd.observationStart) throw Errors.ObservationNotStarted;

    var updated = rd;
    updated.status = STATUS_OBSERVING;
    s.rounds.set(msg.roundId, updated);
    s.save();
}

fun handleSubmitCandle(_sender: address, msg: SubmitCandle) {
    var s = lazy Storage.load();
    val now: uint64 = blockchain.now() as uint64;
    val t = timing(s);
    assert (msg.roundId == s.currentRoundId) throw Errors.BadRoundId;
    var rd = ensureRoundExists(s, msg.roundId);

    if (rd.status == STATUS_STAKING_CLOSED && now >= rd.observationStart) {
        rd.status = STATUS_OBSERVING;
    }
    assert (rd.status == STATUS_OBSERVING) throw Errors.BadRoundStatus;
    assert (msg.candleIndex < t.candleCount) throw Errors.CandleIndexOutOfRange;
    assert (!rd.candles.exists(msg.candleIndex)) throw Errors.CandleAlreadySeen;

    val expectedStart: uint64 = rd.observationStart +
        (msg.candleIndex as uint64) * (t.candleSeconds as uint64);
    val expectedEnd: uint64 = expectedStart + (t.candleSeconds as uint64);
    assert ((msg.periodStart as uint64) == expectedStart) throw Errors.CandlePeriodMismatch;
    assert ((msg.periodEnd as uint64) == expectedEnd) throw Errors.CandlePeriodMismatch;
    assert (now >= expectedEnd) throw Errors.CandleNotClosedYet;
    assert (msg.twapPriceUsdE8 > 0) throw Errors.CandleBadPrice;

    val qualified: bool = msg.twapPriceUsdE8 >= rd.targetPriceUsdE8;
    rd.candles.set(msg.candleIndex, CandleRecord {
        periodStart: msg.periodStart,
        periodEnd: msg.periodEnd,
        twapPriceUsdE8: msg.twapPriceUsdE8,
        qualified,
        dataDigest: msg.dataDigest,
    });
    rd.candlesSeen += 1;
    // invariant #7: qualified counter is capped at the success threshold
    if (qualified && rd.qualifiedCandles < t.minQualifiedCandles) {
        rd.qualifiedCandles += 1;
    }

    if (rd.candlesSeen == t.candleCount) {
        val success: bool = rd.qualifiedCandles >= t.minQualifiedCandles;
        settleRound(s, rd, success, now);
        return;
    }
    s.rounds.set(msg.roundId, rd);
    s.save();
}

fun settleRound(s: Storage, rd: RoundData, success: bool, _now: uint64) {
    val _e = econ(s);
    val v = vaults(s);
    val roundId = s.currentRoundId;
    var updated = rd;

    if (success) {
        updated.status = STATUS_SETTLING_SUCCESS;
        if (updated.totalAcceptedStakeRaw == 0) {
            // D-18b: nobody staked but the round passed -> burn the round reward.
            val burnId = burnIdForRound(roundId, timing(s).configVersion);
            updated.failureBurnId = burnId.toCell();
            sendJettonBurn(v.stakingJettonWallet, 0, updated.rewardBudgetRaw as coins, addresses(s).admin);
        }
        // team 1.2e8 release instruction (idempotent in TeamVault)
        sendTeamRelease(v.teamVault, roundId, 0);
    } else {
        updated.status = STATUS_SETTLING_FAILURE;
        val burnId = burnIdForRound(roundId, timing(s).configVersion);
        updated.failureBurnId = burnId.toCell();

        // burn 1/3: round reward 7e8
        sendJettonBurn(v.stakingJettonWallet, 0, updated.rewardBudgetRaw as coins, addresses(s).admin);
        // burn 2/3: principal (0-stake rounds have nothing to burn -> auto-confirmed)
        if (updated.totalAcceptedStakeRaw > 0) {
            sendJettonBurn(
                v.stakingJettonWallet,
                1,
                updated.totalAcceptedStakeRaw as coins,
                addresses(s).admin,
            );
        } else {
            updated.principalBurnConfirmed = true;
        }
        // burn 3/3: team quota via TeamVault
        sendTeamBurn(v.teamVault, roundId, burnId, 2);
    }

    s.rounds.set(roundId, updated);
    s.save();
}

fun handleFinalizeRound(_sender: address, msg: FinalizeRound) {
    var s = lazy Storage.load();
    val now: uint64 = blockchain.now() as uint64;
    assert (msg.roundId == s.currentRoundId) throw Errors.BadRoundId;
    val rd = ensureRoundExists(s, msg.roundId);
    val e = econ(s);
    var updated = rd;
    var settledStatus: uint8 = 0;

    if (rd.status == STATUS_SETTLING_SUCCESS) {
        assert (rd.teamReleaseConfirmed) throw Errors.TeamReleaseNotConfirmed;
        if (rd.totalAcceptedStakeRaw == 0) {
            assert (rd.rewardBurnConfirmed) throw Errors.RewardBurnNotConfirmed;
        }
        updated.status = STATUS_SUCCEEDED;
        settledStatus = STATUS_SUCCEEDED;
        s.successCount += 1;
    } else if (rd.status == STATUS_SETTLING_FAILURE) {
        assert (rd.rewardBurnConfirmed) throw Errors.BurnsNotConfirmed;
        assert (rd.teamBurnConfirmed) throw Errors.BurnsNotConfirmed;
        assert (rd.principalBurnConfirmed) throw Errors.BurnsNotConfirmed;
        updated.status = STATUS_FAILED_PERMANENT;
        settledStatus = STATUS_FAILED_PERMANENT;
    } else {
        throw Errors.BadRoundStatus;
    }

    updated.settledAt = now;
    s.lastSettledAt = now;
    s.rounds.set(msg.roundId, updated);
    if (msg.roundId < MAX_ROUNDS && !s.rounds.exists(msg.roundId + 1)) {
        var next = emptyRound();
        next.status = STATUS_PREVIEW;
        next.rewardBudgetRaw = e.roundRewardRaw;
        next.stakeOpenAt = now + (timing(s).previewSeconds as uint64);
        s.rounds.set(msg.roundId + 1, next);
    }
    s.save();

    emitExternalEvent(RoundSettled {
        roundId: msg.roundId,
        status: settledStatus,
        qualifiedCandles: updated.qualifiedCandles,
        candlesSeen: updated.candlesSeen,
        totalAcceptedStakeRaw: updated.totalAcceptedStakeRaw,
        tierAfter: s.successCount + 1,
    });
}

// ===========================================================================
// Oracle pause / technical abort
// ===========================================================================

fun handlePauseOracle(sender: address, _msg: PauseOracle) {
    var s = lazy Storage.load();
    requireAdminOrOracle(s, sender);
    val now: uint64 = blockchain.now() as uint64;
    val rd = ensureRoundExists(s, s.currentRoundId);
    assert (rd.status == STATUS_OBSERVING) throw Errors.BadRoundStatus;
    var updated = rd;
    updated.status = STATUS_ORACLE_PAUSED;
    s.pausedAt = now;
    s.rounds.set(s.currentRoundId, updated);
    s.save();
}

fun handleResumeOracle(sender: address, _msg: ResumeOracle) {
    var s = lazy Storage.load();
    requireAdminOrOracle(s, sender);
    val now: uint64 = blockchain.now() as uint64;
    val t = timing(s);
    val rd = ensureRoundExists(s, s.currentRoundId);
    assert (rd.status == STATUS_ORACLE_PAUSED) throw Errors.BadRoundStatus;
    assert (s.pausedAt > 0) throw Errors.BadRoundStatus;

    var updated = rd;
    updated.status = STATUS_OBSERVING;
    // docs/02 §7: restart a complete observation window after recovery
    updated.observationStart = now;
    updated.observationEnd = now + (t.observationSeconds as uint64);
    updated.candlesSeen = 0;
    updated.qualifiedCandles = 0;
    updated.candles = [];
    s.pausedAt = 0;
    s.rounds.set(s.currentRoundId, updated);
    s.save();
}

fun handleAbortTechnical(_sender: address, _msg: AbortTechnical) {
    var s = lazy Storage.load();
    val now: uint64 = blockchain.now() as uint64;
    val t = timing(s);
    assert (s.currentRoundId >= 1) throw Errors.BadRoundId;
    val rd = ensureRoundExists(s, s.currentRoundId);

    var reason: uint8 = 0;
    if (rd.status == STATUS_ORACLE_PAUSED && s.pausedAt > 0 &&
        now - s.pausedAt >= (t.techAbortPauseSeconds as uint64)) {
        reason = ABORT_REASON_PAUSE_TIMEOUT;
    } else if (
        (rd.status == STATUS_OBSERVING || rd.status == STATUS_STAKING_CLOSED) &&
        rd.observationEnd > 0 &&
        now >= rd.observationEnd + (t.techAbortObsTimeoutSeconds as uint64)
    ) {
        reason = ABORT_REASON_OBSERVATION_TIMEOUT;
    } else {
        throw Errors.TooEarly;
    }

    var updated = rd;
    updated.status = STATUS_TECHNICAL_ABORTED;
    updated.settledAt = now;
    s.lastSettledAt = now;
    s.pausedAt = 0;
    s.rounds.set(s.currentRoundId, updated);
    if (s.currentRoundId < MAX_ROUNDS && !s.rounds.exists(s.currentRoundId + 1)) {
        var next = emptyRound();
        next.status = STATUS_PREVIEW;
        next.rewardBudgetRaw = econ(s).roundRewardRaw;
        next.stakeOpenAt = now + (timing(s).previewSeconds as uint64);
        s.rounds.set(s.currentRoundId + 1, next);
    }
    s.save();

    emitExternalEvent(TechnicalAborted { roundId: s.currentRoundId, reason, at: now });
}

// ===========================================================================
// Staking (TEP-74 transfer_notification)
// ===========================================================================

fun handleTransferNotification(sender: address, msg: TransferNotification) {
    var s = lazy Storage.load();
    val v = vaults(s);
    assert (sender == v.stakingJettonWallet) throw Errors.NotJettonWallet;

    val owner: address = msg.transferInitiator;
    val amount: coins = msg.jettonAmount;

    if (amount <= 0) {
        return;
    }

    val t = timing(s);
    val e = econ(s);
    val now: uint64 = blockchain.now() as uint64;
    val roundId = s.currentRoundId;
    val rd = ensureRoundExists(s, roundId);

    var version: uint8 = 0;
    var payloadRoundId: uint8 = 0;
    var nonce: uint64 = 0;
    var riskVersion: uint16 = 0;
    var acceptBurn: uint8 = 0;
    var parsed = false;
    var payload = unwrapForwardPayload(msg.forwardPayload);
    if (payload.remainingBitsCount() == 136) {
        val op = payload.loadUint(32);
        version = payload.loadUint(8) as uint8;
        payloadRoundId = payload.loadUint(8) as uint8;
        nonce = payload.loadUint(64) as uint64;
        riskVersion = payload.loadUint(16) as uint16;
        acceptBurn = payload.loadUint(8) as uint8;
        parsed = op == OP_STAKE_DEPOSIT;
    }
    if (!parsed) {
        refundStake(s, owner, amount, 0);
        return;
    }
    if (version != 1) {
        refundStake(s, owner, amount, 0);
        return;
    }
    if (acceptBurn != 1) {
        refundStake(s, owner, amount, 0);
        return;
    }
    if (riskVersion != t.riskDisclosureVersion) {
        refundStake(s, owner, amount, 0);
        return;
    }
    if (rd.status != STATUS_STAKING_OPEN || payloadRoundId != roundId ||
        now < rd.stakeOpenAt || now >= rd.stakeCloseAt) {
        refundStake(s, owner, amount, 0);
        return;
    }
    if ((amount as uint128) < e.minStakeRaw) {
        refundStake(s, owner, amount, 0);
        return;
    }

    var inner: map<address, StakePosition> = [];
    val innerRes = s.stakes.get(roundId);
    if (innerRes.isFound) {
        inner = innerRes.loadValue();
    }
    var prevPos = StakePosition { amountRaw: 0, lastDepositNonce: 0, principalClaimed: false, rewardClaimed: false };
    val prev = inner.get(owner);
    if (prev.isFound) {
        prevPos = prev.loadValue();
    }
    if (nonce <= prevPos.lastDepositNonce) {
        refundStake(s, owner, amount, 0);
        return;
    }

    val newTotal: uint128 = rd.totalAcceptedStakeRaw + (amount as uint128);
    if (newTotal > e.maxTotalStakeRaw) {
        refundStake(s, owner, amount, 0);
        return;
    }
    val newOwnerAmount: uint128 = prevPos.amountRaw + (amount as uint128);
    // Per-address cap. NOTE: docs/00 says "single address <= 10% of this round's
    // total stake", which is unsatisfiable for the first depositor (he is 100%).
    // Implemented as a deterministic hard cap derived from the round cap:
    //   maxPerAddress = maxTotalStakeRaw * maxStakePerAddressBps / 10000
    // (= 20,000,000 A9 with the V6.1 parameters). Documented in contracts/README.
    val perAddressCap: uint128 = e.maxTotalStakeRaw *
        (e.maxStakePerAddressBps as uint128) / 10000;
    if (newOwnerAmount > perAddressCap) {
        refundStake(s, owner, amount, 0);
        return;
    }

    var pos = prevPos;
    pos.amountRaw = newOwnerAmount;
    pos.lastDepositNonce = nonce;
    inner.set(owner, pos);
    s.stakes.set(roundId, inner);

    var updated = rd;
    updated.totalAcceptedStakeRaw = newTotal;
    s.rounds.set(roundId, updated);
    s.save();

    emitExternalEvent(DepositAccepted {
        roundId,
        owner,
        amountRaw: amount as uint128,
        totalAcceptedStakeRaw: newTotal,
    });
}

fun refundStake(s: Storage, owner: address, amount: coins, queryId: uint64) {
    sendJettonTransfer(
        vaults(s).stakingJettonWallet,
        queryId,
        amount,
        owner,
        owner,
    );
}

// ===========================================================================
// Claims
// ===========================================================================

fun handleClaimPrincipal(sender: address, msg: ClaimPrincipal) {
    var s = lazy Storage.load();
    val rd = ensureRoundExists(s, msg.roundId);
    assert (
        rd.status == STATUS_SUCCEEDED || rd.status == STATUS_TECHNICAL_ABORTED
    ) throw Errors.NotClaimable;

    val innerRes = s.stakes.get(msg.roundId);
    if (!innerRes.isFound) {
        throw Errors.NothingToClaim;
    }
    var inner = innerRes.loadValue();
    val found = inner.get(sender);
    if (!found.isFound) {
        throw Errors.NothingToClaim;
    }
    var pos = found.loadValue();
    if (pos.principalClaimed) {
        throw Errors.AlreadyClaimed;
    }
    if (pos.amountRaw == 0) {
        throw Errors.NothingToClaim;
    }
    pos.principalClaimed = true;
    inner.set(sender, pos);
    s.stakes.set(msg.roundId, inner);
    s.save();

    sendJettonTransfer(
        vaults(s).stakingJettonWallet,
        msg.queryId,
        pos.amountRaw as coins,
        sender,
        sender,
    );
}

fun handleClaimReward(sender: address, msg: ClaimReward) {
    var s = lazy Storage.load();
    val rd = ensureRoundExists(s, msg.roundId);
    assert (rd.status == STATUS_SUCCEEDED) throw Errors.NotClaimable;

    val innerRes2 = s.stakes.get(msg.roundId);
    if (!innerRes2.isFound) {
        throw Errors.NothingToClaim;
    }
    var inner = innerRes2.loadValue();
    val found = inner.get(sender);
    if (!found.isFound) {
        throw Errors.NothingToClaim;
    }
    var pos = found.loadValue();
    if (pos.rewardClaimed) {
        throw Errors.AlreadyClaimed;
    }
    val reward = rewardForRound(rd, pos);
    if (reward == 0) {
        throw Errors.ZeroReward;
    }
    pos.rewardClaimed = true;
    inner.set(sender, pos);
    s.stakes.set(msg.roundId, inner);
    s.save();

    sendJettonTransfer(
        vaults(s).stakingJettonWallet,
        msg.queryId,
        reward as coins,
        sender,
        sender,
    );
}

fun handleClaimAll(sender: address, msg: ClaimAll) {
    var s = lazy Storage.load();
    val v = vaults(s);

    var principalTotal: uint128 = 0;
    var rewardTotal: uint128 = 0;
    var mask: uint16 = 0;

    var first: uint8 = 1;
    var last: uint8 = MAX_CLAIM_SCAN_ROUNDS;
    if (msg.roundId != 0) {
        if (msg.roundId > MAX_CLAIM_SCAN_ROUNDS) {
            throw Errors.BadRoundId;
        }
        first = msg.roundId;
        last = msg.roundId;
    }

    var roundId: uint8 = first;
    while (roundId <= last) {
        val rr = s.rounds.get(roundId);
        if (rr.isFound) {
            val rd = rr.loadValue();
            val claimable = rd.status == STATUS_SUCCEEDED || rd.status == STATUS_TECHNICAL_ABORTED;
            if (claimable) {
                val innerRes = s.stakes.get(roundId);
                if (innerRes.isFound) {
                    var inner = innerRes.loadValue();
                    val found = inner.get(sender);
                    if (found.isFound) {
                        var pos = found.loadValue();
                        var changed = false;
                        if (!pos.principalClaimed && pos.amountRaw > 0) {
                            pos.principalClaimed = true;
                            principalTotal += pos.amountRaw;
                            changed = true;
                        }
                        if (rd.status == STATUS_SUCCEEDED && !pos.rewardClaimed) {
                            val reward = rewardForRound(rd, pos);
                            if (reward > 0) {
                                pos.rewardClaimed = true;
                                rewardTotal += reward;
                                changed = true;
                            }
                        }
                        if (changed) {
                            inner.set(sender, pos);
                            s.stakes.set(roundId, inner);
                            if (roundId <= 16) {
                                mask = mask | ((1 as uint16) << ((roundId - 1) as uint16));
                            }
                        }
                    }
                }
            }
        }
        roundId += 1;
    }

    if (principalTotal == 0 && rewardTotal == 0) {
        // nothing to claim: successful transaction, no outbound transfer
        s.save();
        return;
    }

    s.save();
    val total: uint128 = principalTotal + rewardTotal;
    sendJettonTransfer(v.stakingJettonWallet, msg.queryId, total as coins, sender, sender);
}

// ===========================================================================
// Settlement acknowledgements
// ===========================================================================

fun handleBurnAck(sender: address, msg: BurnAck) {
    var s = lazy Storage.load();
    assert (sender == addresses(s).jettonMaster) throw Errors.NotJettonMaster;
    assert (msg.roundId == s.currentRoundId) throw Errors.BadRoundId;
    var rd = ensureRoundExists(s, msg.roundId);
    assert (msg.burnId == rd.failureBurnId.load()) throw Errors.BadBurnId;

    // late duplicate acknowledgement: terminal rounds are immutable, ignore it
    if (isTerminal(rd.status)) {
        return;
    }

    if (msg.kind == BURN_KIND_REWARD) {
        assert (
            rd.status == STATUS_SETTLING_FAILURE ||
            (rd.status == STATUS_SETTLING_SUCCESS && rd.totalAcceptedStakeRaw == 0)
        ) throw Errors.BadRoundStatus;
        assert (msg.amountRaw == rd.rewardBudgetRaw) throw Errors.BurnAmountMismatch;
        rd.rewardBurnConfirmed = true;
    } else if (msg.kind == BURN_KIND_PRINCIPAL) {
        assert (rd.status == STATUS_SETTLING_FAILURE) throw Errors.BadRoundStatus;
        assert (msg.amountRaw == rd.totalAcceptedStakeRaw) throw Errors.BurnAmountMismatch;
        rd.principalBurnConfirmed = true;
    } else {
        throw Errors.BurnKindMismatch;
    }

    s.rounds.set(msg.roundId, rd);
    s.save();
}

fun handleTeamReleasedAck(sender: address, msg: TeamReleasedAck) {
    var s = lazy Storage.load();
    assert (sender == vaults(s).teamVault) throw Errors.NotTeamVault;
    assert (msg.roundId == s.currentRoundId) throw Errors.BadRoundId;
    var rd = ensureRoundExists(s, msg.roundId);
    assert (rd.status == STATUS_SETTLING_SUCCESS) throw Errors.BadRoundStatus;
    assert (msg.amountRaw == econ(s).teamRoundRaw) throw Errors.BurnAmountMismatch;
    rd.teamReleaseConfirmed = true;
    s.rounds.set(msg.roundId, rd);
    s.save();
}

fun handleTeamBurnedAck(sender: address, msg: TeamBurnedAck) {
    var s = lazy Storage.load();
    assert (sender == vaults(s).teamVault) throw Errors.NotTeamVault;
    assert (msg.roundId == s.currentRoundId) throw Errors.BadRoundId;
    var rd = ensureRoundExists(s, msg.roundId);
    assert (rd.status == STATUS_SETTLING_FAILURE) throw Errors.BadRoundStatus;
    assert (msg.amountRaw == econ(s).teamRoundRaw) throw Errors.BurnAmountMismatch;
    assert (msg.burnId == rd.failureBurnId.load()) throw Errors.BadBurnId;
    rd.teamBurnConfirmed = true;
    s.rounds.set(msg.roundId, rd);
    s.save();
}

// ===========================================================================
// Retry + one-time deployment wiring
// ===========================================================================

fun handleRetryPendingActions(sender: address, msg: RetryPendingActions) {
    val s = lazy Storage.load();
    requireAdmin(s, sender);
    assert (msg.roundId == s.currentRoundId) throw Errors.BadRoundId;
    val rd = ensureRoundExists(s, msg.roundId);
    val _e = econ(s);
    val v = vaults(s);

    if (rd.status == STATUS_SETTLING_SUCCESS) {
        if (!rd.teamReleaseConfirmed) {
            sendTeamRelease(v.teamVault, msg.roundId, msg.queryId);
        }
        if (rd.totalAcceptedStakeRaw == 0 && !rd.rewardBurnConfirmed) {
            sendJettonBurn(v.stakingJettonWallet, msg.queryId, rd.rewardBudgetRaw as coins, addresses(s).admin);
        }
    } else if (rd.status == STATUS_SETTLING_FAILURE) {
        if (!rd.rewardBurnConfirmed) {
            sendJettonBurn(v.stakingJettonWallet, msg.queryId, rd.rewardBudgetRaw as coins, addresses(s).admin);
        }
        if (!rd.principalBurnConfirmed && rd.totalAcceptedStakeRaw > 0) {
            sendJettonBurn(
                v.stakingJettonWallet,
                msg.queryId,
                rd.totalAcceptedStakeRaw as coins,
                addresses(s).admin,
            );
        }
        if (!rd.teamBurnConfirmed) {
            sendTeamBurn(v.teamVault, msg.roundId, rd.failureBurnId.load(), msg.queryId);
        }
    } else {
        throw Errors.BadRoundStatus;
    }
}

fun handleSetJettonWallet(sender: address, msg: SetJettonWallet) {
    var s = lazy Storage.load();
    requireAdmin(s, sender);
    assert (s.currentRoundId == 0) throw Errors.BadRoundStatus;
    var cfg = s.config.load();
    var v = cfg.vaults.load();
    v.stakingJettonWallet = msg.wallet;
    cfg.vaults = v.toCell();
    s.config = cfg.toCell();
    s.save();
}

// ===========================================================================
// Outbound instructions
// ===========================================================================

fun sendTeamRelease(teamVault: address, roundId: uint8, queryId: uint64) {
    val out = createMessage({
        bounce: BounceMode.NoBounce,
        value: ton("0.05"),
        dest: teamVault,
        body: ReleaseTeamQuota { queryId, roundId },
    });
    out.send(SEND_MODE_PAY_FEES_SEPARATELY);
}

fun sendTeamBurn(teamVault: address, roundId: uint8, burnId: uint256, queryId: uint64) {
    val out = createMessage({
        bounce: BounceMode.NoBounce,
        value: ton("0.05"),
        dest: teamVault,
        body: BurnTeamQuota { queryId, roundId, burnId },
    });
    out.send(SEND_MODE_PAY_FEES_SEPARATELY);
}

// ===========================================================================
// Get methods
// ===========================================================================

get fun get_protocol_config(): ProtocolConfigView {
    val s = lazy Storage.load();
    val a = addresses(s);
    val v = vaults(s);
    val e = econ(s);
    val t = timing(s);
    return {
        admin: a.admin,
        oracle: a.oracle,
        jettonMaster: a.jettonMaster,
        stakingJettonWallet: v.stakingJettonWallet,
        teamVault: v.teamVault,
        p0UsdE8: e.p0UsdE8,
        priceMultiplier: e.priceMultiplier,
        roundRewardRaw: e.roundRewardRaw,
        teamRoundRaw: e.teamRoundRaw,
        minStakeRaw: e.minStakeRaw,
        maxStakePerAddressBps: e.maxStakePerAddressBps,
        maxTotalStakeRaw: e.maxTotalStakeRaw,
        previewSeconds: t.previewSeconds,
        stakeDurationSeconds: t.stakeDurationSeconds,
        candleSeconds: t.candleSeconds,
        candleCount: t.candleCount,
        minQualifiedCandles: t.minQualifiedCandles,
        observationSeconds: t.observationSeconds,
        techAbortPauseSeconds: t.techAbortPauseSeconds,
        techAbortObsTimeoutSeconds: t.techAbortObsTimeoutSeconds,
        riskDisclosureVersion: t.riskDisclosureVersion,
        configVersion: t.configVersion,
    };
}

get fun get_current_round(): uint8 {
    val s = lazy Storage.load();
    return s.currentRoundId;
}

get fun get_success_count(): uint8 {
    val s = lazy Storage.load();
    return s.successCount;
}

get fun get_round(roundId: uint8): RoundView {
    val s = lazy Storage.load();
    val found = s.rounds.get(roundId);
    if (!found.isFound) {
        return roundView(roundId, emptyRound());
    }
    return roundView(roundId, found.loadValue());
}

get fun get_round_status(roundId: uint8): uint8 {
    val s = lazy Storage.load();
    val found = s.rounds.get(roundId);
    if (!found.isFound) {
        return STATUS_UNOPENED;
    }
    return found.loadValue().status;
}

get fun get_round_target_price(roundId: uint8): uint128 {
    val s = lazy Storage.load();
    val found = s.rounds.get(roundId);
    if (!found.isFound) {
        return 0;
    }
    return found.loadValue().targetPriceUsdE8;
}

get fun get_round_candle(roundId: uint8, candleIndex: uint8): CandleRecord {
    val s = lazy Storage.load();
    val found = s.rounds.get(roundId);
    if (!found.isFound) {
        return CandleRecord {
            periodStart: 0,
            periodEnd: 0,
            twapPriceUsdE8: 0,
            qualified: false,
            dataDigest: 0 as uint256,
        };
    }
    val candle = found.loadValue().candles.get(candleIndex);
    if (!candle.isFound) {
        return CandleRecord {
            periodStart: 0,
            periodEnd: 0,
            twapPriceUsdE8: 0,
            qualified: false,
            dataDigest: 0 as uint256,
        };
    }
    return candle.loadValue();
}

get fun get_user_stake(roundId: uint8, owner: address): StakePosition {
    val s = lazy Storage.load();
    val innerRes = s.stakes.get(roundId);
    if (!innerRes.isFound) {
        return StakePosition {
            amountRaw: 0,
            lastDepositNonce: 0,
            principalClaimed: false,
            rewardClaimed: false,
        };
    }
    val inner = innerRes.loadValue();
    val found = inner.get(owner);
    if (!found.isFound) {
        return StakePosition {
            amountRaw: 0,
            lastDepositNonce: 0,
            principalClaimed: false,
            rewardClaimed: false,
        };
    }
    return found.loadValue();
}

get fun get_round_total_stake(roundId: uint8): uint128 {
    val s = lazy Storage.load();
    val found = s.rounds.get(roundId);
    if (!found.isFound) {
        return 0;
    }
    return found.loadValue().totalAcceptedStakeRaw;
}

get fun get_user_reward_estimate(roundId: uint8, owner: address): uint128 {
    val s = lazy Storage.load();
    val found = s.rounds.get(roundId);
    if (!found.isFound) {
        return 0;
    }
    val rd = found.loadValue();
    if (rd.status != STATUS_SUCCEEDED) {
        return 0;
    }
    val innerRes = s.stakes.get(roundId);
    if (!innerRes.isFound) {
        return 0;
    }
    val posRes = innerRes.loadValue().get(owner);
    if (!posRes.isFound) {
        return 0;
    }
    return rewardForRound(rd, posRes.loadValue());
}

get fun get_claimable_all(owner: address): Claimable {
    val s = lazy Storage.load();
    var principal: uint128 = 0;
    var reward: uint128 = 0;
    var mask: uint16 = 0;
    var roundId: uint8 = 1;
    while (roundId <= MAX_CLAIM_SCAN_ROUNDS) {
        val rr = s.rounds.get(roundId);
        if (rr.isFound) {
            val rd = rr.loadValue();
            val innerRes = s.stakes.get(roundId);
            if (innerRes.isFound) {
                val posRes = innerRes.loadValue().get(owner);
                if (posRes.isFound) {
                    val pos = posRes.loadValue();
                    var included = false;
                    if (
                        (rd.status == STATUS_SUCCEEDED || rd.status == STATUS_TECHNICAL_ABORTED) &&
                        !pos.principalClaimed
                    ) {
                        principal += pos.amountRaw;
                        included = true;
                    }
                    if (rd.status == STATUS_SUCCEEDED && !pos.rewardClaimed) {
                        val r = rewardForRound(rd, pos);
                        if (r > 0) {
                            reward += r;
                            included = true;
                        }
                    }
                    if (included) {
                        mask = mask | ((1 as uint16) << ((roundId - 1) as uint16));
                    }
                }
            }
        }
        roundId += 1;
    }
    return { principalRaw: principal, rewardRaw: reward, roundsMask: mask };
}

get fun get_round_burn_status(roundId: uint8): RoundBurnStatus {
    val s = lazy Storage.load();
    val found = s.rounds.get(roundId);
    if (!found.isFound) {
        return {
            rewardBurnConfirmed: false,
            teamBurnConfirmed: false,
            principalBurnConfirmed: false,
            failureBurnId: 0 as uint256,
        };
    }
    val rd = found.loadValue();
    return {
        rewardBurnConfirmed: rd.rewardBurnConfirmed,
        teamBurnConfirmed: rd.teamBurnConfirmed,
        principalBurnConfirmed: rd.principalBurnConfirmed,
        failureBurnId: rd.failureBurnId.load(),
    };
}
