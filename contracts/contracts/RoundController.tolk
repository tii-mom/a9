// A9 Protocol — RoundController (docs/02 state machine, docs/04 §2.2, docs/11 §4.1)
//
// Implements:
//   * 10-round state machine with PREVIEW (12h) -> STAKING_OPEN (36h) ->
//     STAKING_CLOSED -> OBSERVING (24 x 1h) -> SETTLING_* -> terminal
//   * target price locked at open: max(P0 * 2^tier, 2 * 24h TWAP)
//   * tier semantics D-28: failure retries the same tier, success increments it
//   * stake ledger with nonce dedup, min / per-address 10% / round cap limits
//   * success settlement: pull-claim principal + proportional reward + TeamVault release
//   * failure settlement: three burns (reward / team / principal) with 3 acks
//   * 0-stake success: reward burn (D-18b) + team release
//   * V6.2 timing: 12h preview + 36h staking + 24h observation = 72h/round, 30d/10 rounds
//   * technical abort: 14d paused or observation-end + 7d, anyone, refund principal only
//   * claimAll: single call, bounded 10-round scan, one combined Jetton transfer
//
// The controller also acts as the staking + reward vault (V6.1 self-developed
// surface is exactly RoundController + TeamVault; docs/04 Vault names are logical).

import "types"
import "constants"
import "jetton"
import "jetton/jetton-utils"

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
    | SetJettonWalletCode
    | TransferBounced
    | BurnAck
    | TeamReleasedAck
    | TeamBurnedAck
    | TransferNotification
    | TopUpTons
    | ClaimRewardEarly
    | RollReward
    | SetReferrer
    | ClaimUnlocked
    | ReturnExcessesBack

// ===========================================================================
// Entry point
// ===========================================================================

fun onInternalMessage(in: InMessage) {
    val msg = lazy RoundControllerAllowedMessage.fromSlice(in.body);

    match (msg) {
        OpenRound => { handleOpenRound(in.senderAddress, msg); }
        CloseStaking => { handleCloseStaking(in.senderAddress, msg); }
        SubmitCandle => { handleSubmitCandle(in.senderAddress, msg); }
        FinalizeRound => { handleFinalizeRound(in.senderAddress, msg); }
        ClaimPrincipal => { handleClaimPrincipal(in.senderAddress, msg, in.valueCoins); }
        ClaimReward => { handleClaimReward(in.senderAddress, msg, in.valueCoins); }
        ClaimAll => { handleClaimAll(in.senderAddress, msg, in.valueCoins); }
        PauseOracle => { handlePauseOracle(in.senderAddress, msg); }
        ResumeOracle => { handleResumeOracle(in.senderAddress, msg); }
        AbortTechnical => { handleAbortTechnical(in.senderAddress, msg); }
        StartObservation => { handleStartObservation(in.senderAddress, msg); }
        RetryPendingActions => { handleRetryPendingActions(in.senderAddress, msg, in.valueCoins); }
        SetJettonWallet => { handleSetJettonWallet(in.senderAddress, msg); }
        SetJettonWalletCode => { handleSetJettonWalletCode(in.senderAddress, msg); }
        BurnAck => { handleBurnAck(in.senderAddress, msg); }
        TeamReleasedAck => { handleTeamReleasedAck(in.senderAddress, msg); }
        TeamBurnedAck => { handleTeamBurnedAck(in.senderAddress, msg); }
        TransferNotification => { handleTransferNotification(in.senderAddress, msg, in.valueCoins); }
        ClaimRewardEarly => { handleClaimRewardEarly(in.senderAddress, msg, in.valueCoins); }
        RollReward => { handleRollReward(in.senderAddress, msg); }
        SetReferrer => { handleSetReferrer(in.senderAddress, msg); }
        ClaimUnlocked => { handleClaimUnlocked(in.senderAddress, msg, in.valueCoins); }
        ReturnExcessesBack => { handleReturnExcesses(in.senderAddress, msg); }
        TransferBounced => { handleTransferBounced(in.senderAddress, msg); }
        TopUpTons => {}
        else => throw Errors.UnknownMessage,
    }
}

// A9-F3: idempotently clear a dispatched burn flag after a first/second-hop bounce.
// Repeated notifications are harmless; confirmed burns are never reset.
fun clearBurnDispatched(queryId: uint64) {
    val roundId: uint8 = ((queryId >> 16) & 0xff) as uint8;
    val kind: uint8 = ((queryId >> 8) & 0xff) as uint8;
    var s = lazy Storage.load();
    val rr = s.rounds.get(roundId);
    if (!rr.isFound) {
        return;
    }
    var rd = rr.loadValue();
    if (isTerminal(rd.status)) {
        return;
    }
    var changed = false;
    if (kind == BURN_QUERY_REWARD && !rd.rewardBurnConfirmed && rd.rewardBurnDispatched) {
        rd.rewardBurnDispatched = false;
        changed = true;
    } else if (kind == BURN_QUERY_PRINCIPAL && !rd.principalBurnConfirmed && rd.principalBurnDispatched) {
        rd.principalBurnDispatched = false;
        changed = true;
    }
    if (changed) {
        s.rounds.set(roundId, rd);
        s.save();
    }
}

fun onBouncedMessage(in: InMessageBounced) {
    // P0-3: a bounced claim transfer proves the transfer did not execute.
    in.bouncedBody.skipBouncedPrefix();
    if (in.bouncedBody.remainingBitsCount() < 96) {
        return;
    }
    val op = in.bouncedBody.loadUint(32);
    if (op == OP_JETTON_BURN) {
        // F-03/F3: first-hop burn bounce -> allow RetryPendingActions to resend.
        val burnQ: uint64 = in.bouncedBody.loadUint(64) as uint64;
        clearBurnDispatched(burnQ);
        return;
    }
    if (op != OP_JETTON_TRANSFER) {
        return;
    }
    val queryId: uint64 = in.bouncedBody.loadUint(64) as uint64;
    rollbackPendingClaim(queryId);
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

fun extras(s: Storage): StorageExtras {
    return s.extras.load();
}

fun roundExtra(rd: RoundData): RoundExtra {
    return rd.extra.load();
}

// F-07: single referral formula used by both deposit and roll paths.
fun referralRawAdd(amountRaw: uint128): uint128 {
    return amountRaw * (REFERRAL_BPS as uint128) / 10000;
}

fun bonusOf(ex: RoundExtra, owner: address): uint128 {
    val found = ex.bonus.get(owner);
    return found.isFound ? found.loadValue() : 0;
}

fun referredOf(ex: RoundExtra, owner: address): uint128 {
    val found = ex.referred.get(owner);
    return found.isFound ? found.loadValue() : 0;
}

fun streakOf(ex: StorageExtras, owner: address): StreakInfo {
    val found = ex.streaks.get(owner);
    return found.isFound ? found.loadValue() : (StreakInfo { lastRound: 0, count: 0 });
}

fun lockedStateOf(ex: StorageExtras, owner: address): LockedState {
    val found = ex.locked.get(owner);
    return found.isFound ? found.loadValue() : (LockedState { lockedRaw: 0, claimedRaw: 0, pendingQueryId: 0 });
}

fun requireNoPendingClaim(ex: StorageExtras, owner: address) {
    assert (lockedStateOf(ex, owner).pendingQueryId == 0) throw Errors.ClaimPending;
}

fun lockedOf(ex: StorageExtras, owner: address): uint128 {
    return lockedStateOf(ex, owner).lockedRaw;
}

fun claimedOf(ex: StorageExtras, owner: address): uint128 {
    return lockedStateOf(ex, owner).claimedRaw;
}

// P0-3: queryId layout roundId<<32 | kind<<24 | counter24 (global, reverse-lookupable).
fun claimQueryId(roundId: uint8, kind: uint8, counter: uint64): uint64 {
    assert (counter < 0xffffff) throw Errors.CounterOverflow;
    return ((roundId as uint64) << 32) | ((kind as uint64) << 24) | counter;
}

fun pendingOf(ex: StorageExtras, queryId: uint64): PendingClaim? {
    val found = ex.pending.get(queryId);
    return found.isFound ? found.loadValue() : null;
}

// P0-3: rollback a claim by queryId. Called from onBouncedMessage only; loads and
// saves its own storage so the caller cannot forget to persist the rollback.
fun rollbackPendingClaim(queryId: uint64) {
    var s = lazy Storage.load();
    var ex = s.extras.load();
    val found = ex.pending.get(queryId);
    if (!found.isFound) {
        return;
    }
    val p = found.loadValue();
    val owner = p.owner;

    if (p.kind == CLAIM_KIND_PRINCIPAL) {
        val innerRes = s.stakes.get(p.roundId);
        if (innerRes.isFound) {
            var inner = innerRes.loadValue();
            val posRes = inner.get(owner);
            if (posRes.isFound) {
                var pos = posRes.loadValue();
                pos.principalClaimed = false;
                inner.set(owner, pos);
                s.stakes.set(p.roundId, inner);
            }
        }
    } else if (p.kind == CLAIM_KIND_REWARD) {
        val innerRes = s.stakes.get(p.roundId);
        if (innerRes.isFound) {
            var inner = innerRes.loadValue();
            val posRes = inner.get(owner);
            if (posRes.isFound) {
                var pos = posRes.loadValue();
                pos.rewardClaimed = false;
                pos.rewardState = REWARD_STATE_PENDING;
                inner.set(owner, pos);
                s.stakes.set(p.roundId, inner);
            }
        }
        var lk = lockedStateOf(ex, owner);
        lk.lockedRaw = lk.lockedRaw > p.lockedDeltaRaw ? lk.lockedRaw - p.lockedDeltaRaw : 0;
        ex.locked.set(owner, lk);
    } else if (p.kind == CLAIM_KIND_CLAIM_ALL) {
        var i: uint8 = 1;
        while (i <= MAX_CLAIM_SCAN_ROUNDS) {
            val bit: uint16 = (1 as uint16) << ((i - 1) as uint16);
            val hasP = (p.principalMask & bit) != 0;
            val hasR = (p.rewardMask & bit) != 0;
            if (hasP || hasR) {
                val innerRes = s.stakes.get(i);
                if (innerRes.isFound) {
                    var inner = innerRes.loadValue();
                    val posRes = inner.get(owner);
                    if (posRes.isFound) {
                        var pos = posRes.loadValue();
                        if (hasP) {
                            pos.principalClaimed = false;
                        }
                        if (hasR) {
                            pos.rewardClaimed = false;
                            pos.rewardState = REWARD_STATE_PENDING;
                        }
                        inner.set(owner, pos);
                        s.stakes.set(i, inner);
                    }
                }
            }
            i += 1;
        }
        var lk = lockedStateOf(ex, owner);
        lk.lockedRaw = lk.lockedRaw > p.lockedDeltaRaw ? lk.lockedRaw - p.lockedDeltaRaw : 0;
        ex.locked.set(owner, lk);
    } else if (p.kind == CLAIM_KIND_REFUND) {
        // ledger was credited before forwarding; keep it (no stake flags to restore)
    } else if (p.kind == CLAIM_KIND_UNLOCK) {
        var i: uint8 = 1;
        while (i <= MAX_CLAIM_SCAN_ROUNDS) {
            val bit: uint16 = (1 as uint16) << ((i - 1) as uint16);
            if ((p.rewardMask & bit) != 0) {
                val innerRes = s.stakes.get(i);
                if (innerRes.isFound) {
                    var inner = innerRes.loadValue();
                    val posRes = inner.get(owner);
                    if (posRes.isFound) {
                        var pos = posRes.loadValue();
                        pos.rewardClaimed = false;
                        pos.rewardState = REWARD_STATE_PENDING;
                        inner.set(owner, pos);
                        s.stakes.set(i, inner);
                    }
                }
            }
            i += 1;
        }
        // F-01: relative decrement (never an absolute snapshot), so overlapping
        // rollbacks cannot inflate lockedRaw.
        var lk = lockedStateOf(ex, owner);
        lk.lockedRaw = lk.lockedRaw > p.lockedDeltaRaw ? lk.lockedRaw - p.lockedDeltaRaw : 0;
        lk.claimedRaw = lk.claimedRaw > p.amountRaw ? lk.claimedRaw - p.amountRaw : 0;
        ex.locked.set(owner, lk);
    }

    var lk2 = lockedStateOf(ex, owner);
    if (lk2.pendingQueryId == queryId) {
        lk2.pendingQueryId = 0;
        ex.locked.set(owner, lk2);
    }
    ex.pending.delete(queryId);
    s.extras = ex.toCell();
    s.save();
    emitExternalEvent(ClaimRolledBack {
        queryId,
        roundId: p.roundId,
        kind: p.kind,
        owner,
        amountRaw: p.amountRaw,
    });
}

// P0-3: wallet confirmed the transfer (ReturnExcessesBack) -> drop the pending record.
fun settlePendingClaim(queryId: uint64) {
    var s = lazy Storage.load();
    var ex = s.extras.load();
    val found = ex.pending.get(queryId);
    if (!found.isFound) {
        return;
    }
    val p = found.loadValue();
    if (p.kind == CLAIM_KIND_REFUND) {
        debitRefundLedger(mutate s, p.owner, p.amountRaw as coins);
    }
    var lk = lockedStateOf(ex, p.owner);
    if (lk.pendingQueryId == queryId) {
        lk.pendingQueryId = 0;
        ex.locked.set(p.owner, lk);
    }
    ex.pending.delete(queryId);
    s.extras = ex.toCell();
    s.save();
}

// streak rule: same round keeps the count; previous round +1; otherwise reset to 1.
fun streakForRound(prev: StreakInfo, roundId: uint8): uint8 {
    if (prev.count > 0 && prev.lastRound == roundId) {
        return prev.count;
    }
    if (prev.count > 0 && (prev.lastRound as int) + 1 == (roundId as int)) {
        val next = (prev.count as int) + 1;
        return next > (STREAK_MAX as int) ? STREAK_MAX : (next as uint8);
    }
    return 1;
}

fun weightBpsForStreak(streak: uint8): uint128 {
    // 10000 bps = 1.00x base; +1000 bps (10%) per consecutive round
    return 10000 + (streak as uint128) * (STREAK_BPS_PER_ROUND as uint128);
}

fun ownWeightFor(amountRaw: uint128, streak: uint8): uint128 {
    return amountRaw * weightBpsForStreak(streak) / 10000;
}

fun rewardForWeight(rewardBudget: uint128, totalWeight: uint128, weight: uint128): uint128 {
    if (totalWeight == 0) {
        return 0;
    }
    return rewardBudget * weight / totalWeight;
}

// V8 reward = budget × (own weight + referral bonus) / total weight (floor).
// Rounding dust stays in the vault; Σ rewards <= round budget (never overspend).
fun rewardForRound(rd: RoundData, ex: RoundExtra, pos: StakePosition, owner: address): uint128 {
    return rewardForWeight(rd.rewardBudgetRaw, ex.totalWeight, pos.weight + bonusOf(ex, owner));
}

fun burnIdForRound(roundId: uint8, configVersion: uint32): uint256 {
    return beginCell()
        .storeUint(roundId, 8)
        .storeUint(0xff, 8) // failure-domain marker
        .storeUint(configVersion, 32)
        .endCell()
        .hash();
}

// P0-2: burn queryId encodes round + kind (roundId<<16 | kind<<8 | nonce).
fun burnQueryId(roundId: uint8, kind: uint8, nonce: uint8 = 0): uint64 {
    return BURN_QUERY_TAG | ((roundId as uint64) << 16) | ((kind as uint64) << 8) | (nonce as uint64);
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
        // A9-F9: always anchor the 36h staking window to the actual open time.
        // This removes the "open 1s..35h59m late compresses the window" cliff.
        rd.stakeOpenAt = now;
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

fun handleCloseStaking(sender: address, msg: CloseStaking) {
    var s = lazy Storage.load();
    val now: uint64 = blockchain.now() as uint64;
    val rd = ensureRoundExists(s, s.currentRoundId);
    assert (rd.status == STATUS_STAKING_OPEN) throw Errors.BadRoundStatus;

    var closeAt: uint64 = 0;
    if (now >= rd.stakeCloseAt) {
        // M-1: the 36h window expiring is deterministic -> anyone may close.
        closeAt = rd.stakeCloseAt;
    } else {
        // Early (touch-price) close remains permissioned and still needs a valid TWAP.
        requireAdminOrOracle(s, sender);
        if (msg.twap1hUsdE8 >= rd.targetPriceUsdE8 && msg.twap1hUsdE8 > 0) {
            closeAt = now;
        } else {
            throw Errors.TooEarly;
        }
    }

    var updated = rd;
    updated.status = STATUS_STAKING_CLOSED;
    updated.stakeCloseAt = closeAt;
    updated.observationStart = closeAt;
    updated.observationEnd = closeAt + (timing(s).observationSeconds as uint64);
    s.rounds.set(s.currentRoundId, updated);
    s.save();
    emitExternalEvent(StakingClosed {
        roundId: s.currentRoundId,
        closeAt,
        early: closeAt != rd.stakeCloseAt,
        twap1hUsdE8: msg.twap1hUsdE8,
    });
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

fun handleSubmitCandle(sender: address, msg: SubmitCandle) {
    var s = lazy Storage.load();
    // P0-1: only admin/oracle may submit candles (prevents arbitrary TWAP verdicts).
    requireAdminOrOracle(s, sender);
    val now: uint64 = blockchain.now() as uint64;
    val t = timing(s);
    assert (msg.roundId == s.currentRoundId) throw Errors.BadRoundId;
    var rd = ensureRoundExists(s, msg.roundId);

    if (rd.status == STATUS_STAKING_CLOSED && now >= rd.observationStart) {
        rd.status = STATUS_OBSERVING;
    }
    assert (rd.status == STATUS_OBSERVING) throw Errors.BadRoundStatus;
    assert (msg.candleIndex < t.candleCount) throw Errors.CandleIndexOutOfRange;
    // V8: candles must be submitted strictly in order (index == candlesSeen).
    assert (msg.candleIndex == rd.candlesSeen) throw Errors.CandleAlreadySeen;

    val expectedStart: uint64 = rd.observationStart +
        (msg.candleIndex as uint64) * (t.candleSeconds as uint64);
    val expectedEnd: uint64 = expectedStart + (t.candleSeconds as uint64);
    assert ((msg.periodStart as uint64) == expectedStart) throw Errors.CandlePeriodMismatch;
    assert ((msg.periodEnd as uint64) == expectedEnd) throw Errors.CandlePeriodMismatch;
    assert (now >= expectedEnd) throw Errors.CandleNotClosedYet;
    assert (msg.twapPriceUsdE8 > 0) throw Errors.CandleBadPrice;

    val qualified: bool = msg.twapPriceUsdE8 >= rd.targetPriceUsdE8;
    var rdExtra = rd.extra.load();
    // rolling hash: H(prevHash || candleIndex || twap || dataDigest)
    val newCandleHash = beginCell()
        .storeUint(rdExtra.candleHash, 256)
        .storeUint(msg.candleIndex, 8)
        .storeUint(msg.twapPriceUsdE8, 128)
        .storeUint(msg.dataDigest, 256)
        .endCell()
        .hash();
    rdExtra.candleHash = newCandleHash;
    rd.extra = rdExtra.toCell();
    emitExternalEvent(CandleSubmitted {
        roundId: msg.roundId,
        candleIndex: msg.candleIndex,
        periodStart: msg.periodStart,
        periodEnd: msg.periodEnd,
        twapPriceUsdE8: msg.twapPriceUsdE8,
        dataDigest: msg.dataDigest,
        candleHash: newCandleHash,
    });
    rd.candlesSeen += 1;
    // invariant: qualified counter is capped at the success threshold
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
            var rdExtra = updated.extra.load();
            rdExtra.failureBurnId = burnId;
            updated.extra = rdExtra.toCell();
            sendJettonBurn(v.stakingJettonWallet, burnQueryId(roundId, BURN_QUERY_REWARD), updated.rewardBudgetRaw as coins, contract.getAddress());
            updated.rewardBurnDispatched = true;
        }
        // team 1.2e8 release instruction (idempotent in TeamVault)
        sendTeamRelease(v.teamVault, roundId, 0);
    } else {
        updated.status = STATUS_SETTLING_FAILURE;
        val burnId = burnIdForRound(roundId, timing(s).configVersion);
        var rdExtra = updated.extra.load();
        rdExtra.failureBurnId = burnId;
        updated.extra = rdExtra.toCell();

        // burn 1/3: round reward 7e8
        sendJettonBurn(v.stakingJettonWallet, burnQueryId(roundId, BURN_QUERY_REWARD), updated.rewardBudgetRaw as coins, contract.getAddress());
        updated.rewardBurnDispatched = true;
        // burn 2/3: principal (0-stake rounds have nothing to burn -> auto-confirmed)
        if (updated.totalAcceptedStakeRaw > 0) {
            sendJettonBurn(v.stakingJettonWallet, burnQueryId(roundId, BURN_QUERY_PRINCIPAL), updated.totalAcceptedStakeRaw as coins, contract.getAddress());
            updated.principalBurnDispatched = true;
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
    if (msg.roundId == MAX_ROUNDS) {
        var ex = s.extras.load();
        ex.unlockStart = now;
        s.extras = ex.toCell();
    }
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
    // P2-1: an oracle must not be able to reset the abort timer repeatedly.
    assert (rd.pauseCount == 0) throw Errors.BadRoundStatus;
    var updated = rd;
    updated.pauseCount = rd.pauseCount + 1;
    updated.status = STATUS_ORACLE_PAUSED;
    s.pausedAt = now;
    s.rounds.set(s.currentRoundId, updated);
    s.save();
    emitExternalEvent(OraclePauseChanged { roundId: s.currentRoundId, paused: true, at: now });
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
    var rdExtra = updated.extra.load();
    rdExtra.candleHash = 0 as uint256;
    updated.extra = rdExtra.toCell();
    s.pausedAt = 0;
    s.rounds.set(s.currentRoundId, updated);
    s.save();
    emitExternalEvent(OraclePauseChanged { roundId: s.currentRoundId, paused: false, at: now });

    // A9-F5: tell OracleAdapter to reset its candle cursor. This is best-effort:
    // IGNORE_ERRORS ensures a failed notification can never revert ResumeOracle.
    // If oracle is still the admin wallet (testnet manual mode), skip the send.
    // Fallback: OA admin can call ResetRoundCandles manually (see README runbook).
    val oracleAddr = addresses(s).oracle;
    if (oracleAddr != addresses(s).admin) {
        val out = createMessage({
            bounce: true,
            value: ton("0.1"),
            dest: oracleAddr,
            body: ResetRoundCandles { roundId: s.currentRoundId },
        });
        out.send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_IGNORE_ERRORS);
    }
}

fun handleAbortTechnical(_sender: address, _msg: AbortTechnical) {
    var s = lazy Storage.load();
    val now: uint64 = blockchain.now() as uint64;
    val t = timing(s);
    assert (s.currentRoundId >= 1) throw Errors.BadRoundId;
    var targetId: uint8 = s.currentRoundId;
    var rd = ensureRoundExists(s, targetId);

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
    } else if (
        rd.status == STATUS_PREVIEW &&
        rd.stakeOpenAt > 0 &&
        now >= rd.stakeOpenAt + (t.techAbortPauseSeconds as uint64)
    ) {
        reason = ABORT_REASON_PREVIEW_TIMEOUT;
    } else if (
        rd.status == STATUS_STAKING_OPEN &&
        rd.stakeCloseAt > 0 &&
        now >= rd.stakeCloseAt + (t.techAbortObsTimeoutSeconds as uint64)
    ) {
        reason = ABORT_REASON_OBSERVATION_TIMEOUT;
    } else if (isTerminal(rd.status) && targetId < MAX_ROUNDS) {
        // M-1: currentRoundId only advances via OpenRound, so a pending next
        // PREVIEW is the real stuck state after a settled round. After the
        // preview timeout anyone may abort it and advance onto it, releasing
        // rolled principal and allowing the protocol to reach R10/unlockStart.
        val nextRes = s.rounds.get(targetId + 1);
        if (nextRes.isFound) {
            val nextRd = nextRes.loadValue();
            if (nextRd.status == STATUS_PREVIEW && nextRd.stakeOpenAt > 0 &&
                now >= nextRd.stakeOpenAt + (t.techAbortPauseSeconds as uint64)) {
                targetId += 1;
                rd = nextRd;
                reason = ABORT_REASON_PREVIEW_TIMEOUT;
            }
        }
    }
    if (reason == 0) {
        throw Errors.TooEarly;
    }

    s.currentRoundId = targetId;
    var updated = rd;
    updated.status = STATUS_TECHNICAL_ABORTED;
    updated.settledAt = now;
    s.lastSettledAt = now;
    s.pausedAt = 0;
    if (targetId == MAX_ROUNDS) {
        var ex = s.extras.load();
        ex.unlockStart = now;
        s.extras = ex.toCell();
    }
    s.rounds.set(targetId, updated);
    if (targetId < MAX_ROUNDS && !s.rounds.exists(targetId + 1)) {
        var next = emptyRound();
        next.status = STATUS_PREVIEW;
        next.rewardBudgetRaw = econ(s).roundRewardRaw;
        next.stakeOpenAt = now + (timing(s).previewSeconds as uint64);
        s.rounds.set(targetId + 1, next);
    }
    s.save();

    emitExternalEvent(TechnicalAborted { roundId: targetId, reason, at: now });
}

fun handleTransferNotification(sender: address, msg: TransferNotification, valueCoins: coins) {
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
    if (!parsed) { refundStake(mutate s, owner, amount, valueCoins); return; }
    if (version != 1) { refundStake(mutate s, owner, amount, valueCoins); return; }
    if (acceptBurn != 1) { refundStake(mutate s, owner, amount, valueCoins); return; }
    if (riskVersion != t.riskDisclosureVersion) { refundStake(mutate s, owner, amount, valueCoins); return; }
    if (rd.status != STATUS_STAKING_OPEN || payloadRoundId != roundId ||
        now < rd.stakeOpenAt || now >= rd.stakeCloseAt) {
        refundStake(mutate s, owner, amount, valueCoins);
        return;
    }
    if ((amount as uint128) < e.minStakeRaw) { refundStake(mutate s, owner, amount, valueCoins); return; }

    var inner: map<address, StakePosition> = [];
    val innerRes = s.stakes.get(roundId);
    if (innerRes.isFound) {
        inner = innerRes.loadValue();
    }
    var prevPos = StakePosition { amountRaw: 0, lastDepositNonce: 0, principalClaimed: false, rewardClaimed: false, weight: 0, rewardState: REWARD_STATE_PENDING };
    val prev = inner.get(owner);
    if (prev.isFound) {
        prevPos = prev.loadValue();
    }
    if (nonce <= prevPos.lastDepositNonce) { refundStake(mutate s, owner, amount, valueCoins); return; }

    val newTotal: uint128 = rd.totalAcceptedStakeRaw + (amount as uint128);
    if (newTotal > e.maxTotalStakeRaw) { refundStake(mutate s, owner, amount, valueCoins); return; }
    val newOwnerAmount: uint128 = prevPos.amountRaw + (amount as uint128);
    // Per-address cap. NOTE: docs/00 says "single address <= 10% of this round's
    // total stake", which is unsatisfiable for the first depositor (he is 100%).
    // Implemented as a deterministic hard cap derived from the round cap:
    //   maxPerAddress = maxTotalStakeRaw * maxStakePerAddressBps / 10000
    // (= 20,000,000 A9 with the V6.1 parameters). Documented in contracts/README.
    val perAddressCap: uint128 = e.maxTotalStakeRaw *
        (e.maxStakePerAddressBps as uint128) / 10000;
    if (newOwnerAmount > perAddressCap) { refundStake(mutate s, owner, amount, valueCoins); return; }

    // V8 weight accounting: O(1) increments only (no user iteration).
    var exState = s.extras.load();
    val prevStreak = streakOf(exState, owner);
    val newStreak = streakForRound(prevStreak, roundId);
    val ownW = ownWeightFor(amount as uint128, newStreak);

    var pos = prevPos;
    pos.amountRaw = newOwnerAmount;
    pos.lastDepositNonce = nonce;
    pos.weight = pos.weight + ownW;
    inner.set(owner, pos);
    s.stakes.set(roundId, inner);

    var rdExtra = rd.extra.load();
    rdExtra.totalWeight = rdExtra.totalWeight + ownW;

    // Referral bonus: one level, 20% of invitee stake, capped by referrer's own stake.
    val referrerRes = exState.referrer.get(owner);
    if (referrerRes.isFound && (amount as uint128) >= e.minStakeRaw) {
        val referrer = referrerRes.loadValue();
        val refPosRes = inner.get(referrer);
        val refStake: uint128 = refPosRes.isFound ? refPosRes.loadValue().amountRaw : 0;
        val bonusSoFar = bonusOf(rdExtra, referrer);
        val room: uint128 = refStake > bonusSoFar ? refStake - bonusSoFar : 0;
        val rawAdd: uint128 = referralRawAdd(amount as uint128);
        val add: uint128 = rawAdd < room ? rawAdd : room;
        if (add > 0) {
            rdExtra.bonus.set(referrer, bonusSoFar + add);
            rdExtra.totalWeight = rdExtra.totalWeight + add;
        }
        rdExtra.referred.set(referrer, referredOf(rdExtra, referrer) + (amount as uint128));
    }

    // F-06: if the depositor itself is a referrer, top up its own bonus to
    // min(20% * referredStake, ownStake) (O(1), no loops).
    val myReferred = referredOf(rdExtra, owner);
    if (myReferred > 0) {
        val twenty = myReferred / 5; // 20% = REFERRAL_BPS / 10000
        val target: uint128 = twenty < pos.amountRaw ? twenty : pos.amountRaw;
        val current = bonusOf(rdExtra, owner);
        if (target > current) {
            rdExtra.bonus.set(owner, target);
            rdExtra.totalWeight = rdExtra.totalWeight + (target - current);
        }
    }

    var updated = rd;
    updated.totalAcceptedStakeRaw = newTotal;
    updated.extra = rdExtra.toCell();
    s.rounds.set(roundId, updated);

    exState.streaks.set(owner, StreakInfo { lastRound: roundId, count: newStreak });
    s.extras = exState.toCell();
    s.save();

    emitExternalEvent(DepositAccepted {
        roundId,
        owner,
        amountRaw: amount as uint128,
        totalAcceptedStakeRaw: newTotal,
    });
}

// A9-CRIT-02: round 0 is a REFUND LEDGER, not a real round. It is only touched by
// refundStake/rollback REFUND and ClaimPrincipal(0).
fun creditRefundLedger(mutate s: Storage, owner: address, amount: coins) {
    var inner: map<address, StakePosition> = [];
    val innerRes = s.stakes.get(0);
    if (innerRes.isFound) {
        inner = innerRes.loadValue();
    }
    var pos = StakePosition {
        amountRaw: 0,
        lastDepositNonce: 0,
        principalClaimed: false,
        rewardClaimed: true,
        weight: 0,
        rewardState: REWARD_STATE_PENDING,
    };
    val prev = inner.get(owner);
    if (prev.isFound) {
        pos = prev.loadValue();
    }
    pos.amountRaw = pos.amountRaw + (amount as uint128);
    pos.principalClaimed = false;
    inner.set(owner, pos);
    s.stakes.set(0, inner);
}

fun debitRefundLedger(mutate s: Storage, owner: address, amount: coins) {
    val innerRes = s.stakes.get(0);
    if (!innerRes.isFound) {
        return;
    }
    var inner = innerRes.loadValue();
    val prev = inner.get(owner);
    if (!prev.isFound) {
        return;
    }
    var pos = prev.loadValue();
    pos.amountRaw = pos.amountRaw > (amount as uint128) ? pos.amountRaw - (amount as uint128) : 0;
    inner.set(owner, pos);
    s.stakes.set(0, inner);
}

fun refundStake(mutate s: Storage, owner: address, amount: coins, valueCoins: coins) {
    // Tokens are already in the RC Jetton Wallet; never spend RC TON for a refund.
    // Credit the ledger first; a successful refund transfer debits it again in
    // settlePendingClaim (REFUND branch), a bounce leaves it claimable.
    creditRefundLedger(mutate s, owner, amount);
    var ex = s.extras.load();
    val hasPending = lockedStateOf(ex, owner).pendingQueryId != 0;
    if (valueCoins < ton("0.12") || hasPending) {
        // Not enough inbound gas (or owner already has a pending action): keep the
        // amount claimable via ClaimPrincipal(0); no outbound TON is spent.
        s.extras = ex.toCell();
        s.save();
        return;
    }
    val q = claimQueryId(0, CLAIM_KIND_REFUND, ex.claimCounter);
    ex.claimCounter = ex.claimCounter + 1;
    ex.pending.set(q, PendingClaim {
        owner,
        kind: CLAIM_KIND_REFUND,
        roundId: 0,
        principalMask: 0,
        rewardMask: 0,
        amountRaw: amount as uint128,
        lockedDeltaRaw: 0,
        lockedBeforeRaw: 0,
    });
    var lk = lockedStateOf(ex, owner);
    lk.pendingQueryId = q;
    ex.locked.set(owner, lk);
    s.extras = ex.toCell();
    s.save();

    // 0.1 TON is covered by the >=0.12 TON inbound notification; excess goes back
    // to RC (not the user), closing the CRIT-02 TON drain.
    val body = buildJettonTransferBody(q, amount, owner, contract.getAddress());
    val out = createMessage({
        bounce: BounceMode.Only256BitsOfBody,
        value: ton("0.1"),
        dest: vaults(s).stakingJettonWallet,
        body,
    });
    out.send(SEND_MODE_PAY_FEES_SEPARATELY);
}

// ===========================================================================
// Claims
// ===========================================================================

// C-4: Jetton Wallet detected a second-hop bounce and notifies its owner.
fun handleTransferBounced(sender: address, msg: TransferBounced) {
    val s = lazy Storage.load();
    assert (sender == vaults(s).stakingJettonWallet) throw Errors.NotJettonWallet;
    // A9-F3: burn queryId = BURN_QUERY_TAG | (roundId<<16) | (kind<<8);
    // claim queryId = (roundId<<32) | (kind<<24) | counter. The tag bit is never
    // set by claimQueryId, so it is the unambiguous discriminator.
    if ((msg.queryId & BURN_QUERY_TAG) != 0) {
        val roundId: uint8 = ((msg.queryId >> 16) & 0xff) as uint8;
        val kind: uint8 = ((msg.queryId >> 8) & 0xff) as uint8;
        assert (roundId >= 1 && roundId <= MAX_ROUNDS) throw Errors.BadBurnQuery;
        assert (kind == BURN_QUERY_REWARD || kind == BURN_QUERY_PRINCIPAL) throw Errors.BurnKindMismatch;
        clearBurnDispatched(msg.queryId);
        return;
    }
    rollbackPendingClaim(msg.queryId);
}

fun handleSetJettonWalletCode(sender: address, msg: SetJettonWalletCode) {
    var s = lazy Storage.load();
    requireAdmin(s, sender);
    assert (s.currentRoundId == 0) throw Errors.BadRoundStatus;
    var cfg = s.config.load();
    var v = cfg.vaults.load();
    v.jettonWalletCode = msg.code;
    cfg.vaults = v.toCell();
    s.config = cfg.toCell();
    s.save();
}

// Round 0 = refund ledger. Users pay gas to pull refunds that were credited
// because an automatic refund had insufficient inbound TON or bounced.
fun handleClaimRefund(sender: address) {
    var s = lazy Storage.load();
    val innerRes = s.stakes.get(0);
    if (!innerRes.isFound) {
        throw Errors.NothingToClaim;
    }
    var inner = innerRes.loadValue();
    val found = inner.get(sender);
    if (!found.isFound) {
        throw Errors.NothingToClaim;
    }
    var pos = found.loadValue();
    if (pos.principalClaimed || pos.amountRaw == 0) {
        throw Errors.NothingToClaim;
    }
    var ex = s.extras.load();
    requireNoPendingClaim(ex, sender);
    val amount: uint128 = pos.amountRaw;
    val q = claimQueryId(0, CLAIM_KIND_PRINCIPAL, ex.claimCounter);
    ex.claimCounter = ex.claimCounter + 1;
    ex.pending.set(q, PendingClaim {
        owner: sender,
        kind: CLAIM_KIND_PRINCIPAL,
        roundId: 0,
        principalMask: 0,
        rewardMask: 0,
        amountRaw: amount,
        lockedDeltaRaw: 0,
        lockedBeforeRaw: 0,
    });
    pos.principalClaimed = true;
    inner.set(sender, pos);
    s.stakes.set(0, inner);
    var lk = lockedStateOf(ex, sender);
    lk.pendingQueryId = q;
    ex.locked.set(sender, lk);
    s.extras = ex.toCell();
    s.save();

    sendTrackedJettonTransfer(
        vaults(s).stakingJettonWallet,
        q,
        amount as coins,
        sender,
        contract.getAddress(),
    );
}

fun handleClaimPrincipal(sender: address, msg: ClaimPrincipal, valueCoins: coins) {
    // A9-F6: refuse gas-griefing claims that cannot cover the outbound transfer.
    assert (valueCoins >= ton("0.15")) throw Errors.BadConfig;
    var s = lazy Storage.load();
    if (msg.roundId == 0) {
        handleClaimRefund(sender);
        return;
    }
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

    var ex = s.extras.load();
    requireNoPendingClaim(ex, sender);
    val q = claimQueryId(msg.roundId, CLAIM_KIND_PRINCIPAL, ex.claimCounter);
    ex.claimCounter = ex.claimCounter + 1;
    ex.pending.set(q, PendingClaim { owner: sender, kind: CLAIM_KIND_PRINCIPAL, roundId: msg.roundId, principalMask: 0, rewardMask: 0, amountRaw: pos.amountRaw, lockedDeltaRaw: 0, lockedBeforeRaw: 0 });
    pos.principalClaimed = true;
    inner.set(sender, pos);
    s.stakes.set(msg.roundId, inner);
    var lk = lockedStateOf(ex, sender);
    lk.pendingQueryId = q;
    ex.locked.set(sender, lk);
    s.extras = ex.toCell();
    s.save();

    sendTrackedJettonTransfer(
        vaults(s).stakingJettonWallet,
        q,
        pos.amountRaw as coins,
        sender,
        contract.getAddress(),
    );
    emitExternalEvent(PrincipalClaimedEvent {
        roundId: msg.roundId,
        owner: sender,
        amountRaw: pos.amountRaw,
        queryId: q,
    });
}

fun handleClaimAll(sender: address, msg: ClaimAll, valueCoins: coins) {
    assert (valueCoins >= ton("0.15")) throw Errors.BadConfig;
    var s = lazy Storage.load();
    val v = vaults(s);
    var ex = s.extras.load();
    requireNoPendingClaim(ex, sender);

    var principalTotal: uint128 = 0;
    var rewardTotal: uint128 = 0;
    var lockedTotal: uint128 = 0;
    var principalMask: uint16 = 0;
    var rewardMask: uint16 = 0;

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
                            principalMask = principalMask | ((1 as uint16) << ((roundId - 1) as uint16));
                            changed = true;
                        }
                        if (rd.status == STATUS_SUCCEEDED && !pos.rewardClaimed && ex.unlockStart == 0) {
                            val reward = rewardForRound(rd, roundExtra(rd), pos, sender);
                            if (reward > 0) {
                                val applied = applyEarlyReward(pos, reward);
                                pos = applied.position;
                                rewardTotal += applied.paidRaw;
                                lockedTotal += applied.lockedRaw;
                                rewardMask = rewardMask | ((1 as uint16) << ((roundId - 1) as uint16));
                                changed = true;
                                // F-08: indexers must see the same event as ClaimRewardEarly.
                                emitExternalEvent(RewardEarly {
                                    roundId,
                                    owner: sender,
                                    paidRaw: applied.paidRaw,
                                    lockedRaw: applied.lockedRaw,
                                });
                            }
                        }
                        if (changed) {
                            inner.set(sender, pos);
                            s.stakes.set(roundId, inner);
                        }
                    }
                }
            }
        }
        roundId += 1;
    }

    if (principalTotal == 0 && rewardTotal == 0) {
        s.extras = ex.toCell();
        s.save();
        return;
    }

    val before = lockedOf(ex, sender);
    if (lockedTotal > 0) {
        var lk = lockedStateOf(ex, sender);
        lk.lockedRaw = before + lockedTotal;
        ex.locked.set(sender, lk);
    }
    val total: uint128 = principalTotal + rewardTotal;
    val q = claimQueryId(s.currentRoundId, CLAIM_KIND_CLAIM_ALL, ex.claimCounter);
    ex.claimCounter = ex.claimCounter + 1;
    ex.pending.set(q, PendingClaim { owner: sender, kind: CLAIM_KIND_CLAIM_ALL, roundId: s.currentRoundId, principalMask, rewardMask, amountRaw: total, lockedDeltaRaw: lockedTotal, lockedBeforeRaw: before });
    var lk = lockedStateOf(ex, sender);
    lk.pendingQueryId = q;
    ex.locked.set(sender, lk);
    s.extras = ex.toCell();
    s.save();

    sendTrackedJettonTransfer(
        v.stakingJettonWallet,
        q,
        total as coins,
        sender,
        contract.getAddress(),
    );
}
// ===========================================================================
// Settlement acknowledgements
// ===========================================================================




// P0-2 shared confirmation: BurnAck (legacy, amount-checked) and the real
// Jetton Master's ReturnExcessesBack (queryId-decoded, no amount) both land here.
fun confirmBurn(roundId: uint8, kind: uint8, amountRaw: uint128, checkAmount: bool) {
    var s = lazy Storage.load();
    assert (roundId == s.currentRoundId) throw Errors.BadRoundId;
    var rd = ensureRoundExists(s, roundId);
    if (isTerminal(rd.status)) {
        return;
    }
    if (kind == BURN_QUERY_REWARD) {
        assert (rd.status == STATUS_SETTLING_FAILURE || (rd.status == STATUS_SETTLING_SUCCESS && rd.totalAcceptedStakeRaw == 0)) throw Errors.BadRoundStatus;
        // A9-CRIT-01: a confirmation without a dispatched burn is a spoof.
        assert (rd.rewardBurnDispatched) throw Errors.BadRoundStatus;
        if (checkAmount) {
            assert (amountRaw == rd.rewardBudgetRaw) throw Errors.BurnAmountMismatch;
        }
        rd.rewardBurnConfirmed = true;
    } else if (kind == BURN_QUERY_PRINCIPAL) {
        assert (rd.status == STATUS_SETTLING_FAILURE) throw Errors.BadRoundStatus;
        assert (rd.principalBurnDispatched) throw Errors.BadRoundStatus;
        if (checkAmount) {
            assert (amountRaw == rd.totalAcceptedStakeRaw) throw Errors.BurnAmountMismatch;
        }
        rd.principalBurnConfirmed = true;
    } else {
        throw Errors.BurnKindMismatch;
    }
    s.rounds.set(roundId, rd);
    s.save();
}

fun handleBurnAck(sender: address, msg: BurnAck) {
    val s = lazy Storage.load();
    assert (sender == addresses(s).jettonMaster) throw Errors.NotJettonMaster;
    assert (msg.roundId == s.currentRoundId) throw Errors.BadRoundId;
    assert (msg.burnId == roundExtra(ensureRoundExists(s, msg.roundId)).failureBurnId) throw Errors.BadBurnId;
    confirmBurn(msg.roundId, msg.kind, msg.amountRaw, true);
}

fun handleReturnExcesses(sender: address, msg: ReturnExcessesBack) {
    val s = lazy Storage.load();
    val v = vaults(s);
    if (sender == v.stakingJettonWallet) {
        // compatibility path: mock / self-transfer scenarios
        settlePendingClaim(msg.queryId);
        return;
    }
    // P0: the real TEP-74 excess return is sent by the RECIPIENT's Jetton Wallet.
    // Derive the expected wallet from the pending claim owner.
    val ex = s.extras.load();
    val pending = ex.pending.get(msg.queryId);
    if (pending.isFound) {
        val p = pending.loadValue();
        val expected = calcAddressOfJettonWallet(p.owner, addresses(s).jettonMaster, v.jettonWalletCode);
        if (sender == expected) {
            settlePendingClaim(msg.queryId);
            return;
        }
    }
    assert (sender == addresses(s).jettonMaster) throw Errors.NotJettonMaster;
    val roundId: uint8 = ((msg.queryId >> 16) & 0xff) as uint8;
    val kind: uint8 = ((msg.queryId >> 8) & 0xff) as uint8;
    assert (roundId >= 1 && roundId <= MAX_ROUNDS) throw Errors.BadBurnQuery;
    confirmBurn(roundId, kind, 0, false);
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
    assert (msg.burnId == roundExtra(rd).failureBurnId) throw Errors.BadBurnId;
    rd.teamBurnConfirmed = true;
    s.rounds.set(msg.roundId, rd);
    s.save();
}

// ===========================================================================
// Retry + one-time deployment wiring
// ===========================================================================

fun handleRetryPendingActions(_sender: address, msg: RetryPendingActions, valueCoins: coins) {
    // P1-2: anyone may pay gas to unstick a SETTLING_* round if admin is gone.
    assert (valueCoins >= ton("0.3")) throw Errors.BadConfig;
    var s = lazy Storage.load();
    assert (msg.roundId == s.currentRoundId) throw Errors.BadRoundId;
    var rd = ensureRoundExists(s, msg.roundId);
    val v = vaults(s);
    var changed = false;

    if (rd.status == STATUS_SETTLING_SUCCESS) {
        // A9-F11 (not fixed by design): team release retries are intentionally not
        // throttled here. TeamVault's idempotent rounds table ignores a duplicate
        // pending release (released -> ack only; pending -> return) so no double
        // transfer is possible; the 0.3 TON caller value makes spamming unprofitable.
        if (!rd.teamReleaseConfirmed) {
            sendTeamRelease(v.teamVault, msg.roundId, msg.queryId);
        }
        if (rd.totalAcceptedStakeRaw == 0 && !rd.rewardBurnConfirmed && !rd.rewardBurnDispatched) {
            sendJettonBurn(v.stakingJettonWallet, burnQueryId(msg.roundId, BURN_QUERY_REWARD), rd.rewardBudgetRaw as coins, contract.getAddress());
            rd.rewardBurnDispatched = true;
            changed = true;
        }
    } else if (rd.status == STATUS_SETTLING_FAILURE) {
        if (!rd.rewardBurnConfirmed && !rd.rewardBurnDispatched) {
            sendJettonBurn(v.stakingJettonWallet, burnQueryId(msg.roundId, BURN_QUERY_REWARD), rd.rewardBudgetRaw as coins, contract.getAddress());
            rd.rewardBurnDispatched = true;
            changed = true;
        }
        if (!rd.principalBurnConfirmed && !rd.principalBurnDispatched && rd.totalAcceptedStakeRaw > 0) {
            sendJettonBurn(v.stakingJettonWallet, burnQueryId(msg.roundId, BURN_QUERY_PRINCIPAL), rd.totalAcceptedStakeRaw as coins, contract.getAddress());
            rd.principalBurnDispatched = true;
            changed = true;
        }
        if (!rd.teamBurnConfirmed) {
            sendTeamBurn(v.teamVault, msg.roundId, roundExtra(rd).failureBurnId, msg.queryId);
        }
    } else {
        throw Errors.BadRoundStatus;
    }
    if (changed) {
        s.rounds.set(msg.roundId, rd);
        s.save();
    }
}
fun handleSetJettonWallet(sender: address, msg: SetJettonWallet) {
    var s = lazy Storage.load();
    requireAdmin(s, sender);
    assert (msg.wallet != createAddressNone()) throw Errors.BadConfig;
    assert (s.currentRoundId == 0) throw Errors.BadRoundStatus;
    var cfg = s.config.load();
    var v = cfg.vaults.load();
    v.stakingJettonWallet = msg.wallet;
    cfg.vaults = v.toCell();
    s.config = cfg.toCell();
    s.save();
}

// ===========================================================================
// V8 reward states: SetReferrer / ClaimRewardEarly / RollReward / ClaimUnlocked
// ===========================================================================

fun handleSetReferrer(sender: address, msg: SetReferrer) {
    var s = lazy Storage.load();
    var ex = s.extras.load();
    assert (msg.referrer != createAddressNone()) throw Errors.BadConfig;
    assert (msg.referrer != sender) throw Errors.SelfReferral;
    assert (!ex.referrer.exists(sender)) throw Errors.AlreadyReferred;
    // one-level binding, no mutual A<->B pair
    val back = ex.referrer.get(msg.referrer);
    if (back.isFound) {
        assert (back.loadValue() != sender) throw Errors.MutualReferral;
    }
    ex.referrer.set(sender, msg.referrer);
    s.extras = ex.toCell();
    s.save();
    emitExternalEvent(ReferrerSet { owner: sender, referrer: msg.referrer });
}

struct EarlyRewardApplied {
    position: StakePosition
    paidRaw: uint128
    lockedRaw: uint128
}

// V8 EARLY semantics shared by ClaimRewardEarly, legacy ClaimReward and ClaimAll:
// 50% paid now, 50% goes to the R10 unlock pool.
fun applyEarlyReward(pos: StakePosition, reward: uint128): EarlyRewardApplied {
    var updated = pos;
    updated.rewardClaimed = true;
    updated.rewardState = REWARD_STATE_EARLY;
    val paid: uint128 = reward / 2;
    return { position: updated, paidRaw: paid, lockedRaw: reward - paid };
}

fun payEarlyReward(sender: address, roundId: uint8, valueCoins: coins): uint128 {
    assert (valueCoins >= ton("0.15")) throw Errors.BadConfig;
    var s = lazy Storage.load();
    val rd = ensureRoundExists(s, roundId);
    assert (rd.status == STATUS_SUCCEEDED) throw Errors.NotClaimable;
    var ex = s.extras.load();
    assert (ex.unlockStart == 0) throw Errors.RewardStateLocked;
    requireNoPendingClaim(ex, sender);

    val innerRes = s.stakes.get(roundId);
    if (!innerRes.isFound) {
        throw Errors.NothingToClaim;
    }
    var inner = innerRes.loadValue();
    val found = inner.get(sender);
    if (!found.isFound) {
        throw Errors.NothingToClaim;
    }
    val pos = found.loadValue();
    if (pos.rewardClaimed) {
        throw Errors.AlreadyClaimed;
    }
    assert (pos.rewardState == REWARD_STATE_PENDING) throw Errors.BadRoundStatus;

    val reward = rewardForRound(rd, roundExtra(rd), pos, sender);
    if (reward == 0) {
        throw Errors.ZeroReward;
    }
    val applied = applyEarlyReward(pos, reward);
    val before = lockedOf(ex, sender);
    val q = claimQueryId(roundId, CLAIM_KIND_REWARD, ex.claimCounter);
    ex.claimCounter = ex.claimCounter + 1;
    inner.set(sender, applied.position);
    s.stakes.set(roundId, inner);
    var lk = lockedStateOf(ex, sender);
    lk.lockedRaw = before + applied.lockedRaw;
    lk.pendingQueryId = q;
    ex.locked.set(sender, lk);
    ex.pending.set(q, PendingClaim { owner: sender, kind: CLAIM_KIND_REWARD, roundId, principalMask: 0, rewardMask: 0, amountRaw: applied.paidRaw, lockedDeltaRaw: applied.lockedRaw, lockedBeforeRaw: before });
    s.extras = ex.toCell();
    s.save();

    sendTrackedJettonTransfer(
        vaults(s).stakingJettonWallet,
        q,
        applied.paidRaw as coins,
        sender,
        contract.getAddress(),
    );
    emitExternalEvent(RewardEarly {
        roundId,
        owner: sender,
        paidRaw: applied.paidRaw,
        lockedRaw: applied.lockedRaw,
    });
    return applied.paidRaw;
}

fun handleClaimReward(sender: address, msg: ClaimReward, valueCoins: coins) {
    payEarlyReward(sender, msg.roundId, valueCoins);
}

fun handleClaimRewardEarly(sender: address, msg: ClaimRewardEarly, valueCoins: coins) {
    payEarlyReward(sender, msg.roundId, valueCoins);
}
fun handleRollReward(sender: address, msg: RollReward) {
    var s = lazy Storage.load();
    val rd = ensureRoundExists(s, msg.roundId);
    assert (rd.status == STATUS_SUCCEEDED) throw Errors.NotClaimable;
    assert (msg.roundId < MAX_ROUNDS) throw Errors.RollNotAvailable;

    val nextRoundId: uint8 = msg.roundId + 1;
    val nextRd = ensureRoundExists(s, nextRoundId);
    assert (
        nextRd.status == STATUS_PREVIEW || nextRd.status == STATUS_STAKING_OPEN
    ) throw Errors.RollNotAvailable;
    if (nextRd.status == STATUS_STAKING_OPEN) {
        // C-1: rolling into an already-open round must respect its staking deadline.
        val now: uint64 = blockchain.now() as uint64;
        assert (now < nextRd.stakeCloseAt) throw Errors.RollNotAvailable;
    }

    var ex = s.extras.load();
    assert (ex.unlockStart == 0) throw Errors.RewardStateLocked;
    requireNoPendingClaim(ex, sender);

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
    if (pos.rewardClaimed) {
        throw Errors.AlreadyClaimed;
    }
    assert (pos.rewardState == REWARD_STATE_PENDING) throw Errors.BadRoundStatus;

    val reward = rewardForRound(rd, roundExtra(rd), pos, sender);
    if (reward == 0) {
        throw Errors.ZeroReward;
    }

    val e = econ(s);
    val perAddressCap: uint128 = e.maxTotalStakeRaw * (e.maxStakePerAddressBps as uint128) / 10000;
    var nextInner: map<address, StakePosition> = [];
    val nextInnerRes = s.stakes.get(nextRoundId);
    if (nextInnerRes.isFound) {
        nextInner = nextInnerRes.loadValue();
    }
    var nextPos = StakePosition {
        amountRaw: 0,
        lastDepositNonce: 0,
        principalClaimed: false,
        rewardClaimed: false,
        weight: 0,
        rewardState: REWARD_STATE_PENDING,
    };
    val nextPosRes = nextInner.get(sender);
    if (nextPosRes.isFound) {
        nextPos = nextPosRes.loadValue();
    }
    val roomAddr: uint128 = perAddressCap > nextPos.amountRaw ? perAddressCap - nextPos.amountRaw : 0;
    val roomTotal: uint128 = e.maxTotalStakeRaw > nextRd.totalAcceptedStakeRaw
        ? e.maxTotalStakeRaw - nextRd.totalAcceptedStakeRaw
        : 0;
    var rollAmount: uint128 = reward;
    if (rollAmount > roomAddr) {
        rollAmount = roomAddr;
    }
    if (rollAmount > roomTotal) {
        rollAmount = roomTotal;
    }
    val excess: uint128 = reward - rollAmount;
    // F-05/A9-F10: no room OR below minStakeRaw means no roll; keep PENDING.
    assert (rollAmount > 0) throw Errors.RollNotAvailable;
    assert (rollAmount >= e.minStakeRaw) throw Errors.RollNotAvailable;

    pos.rewardState = REWARD_STATE_ROLLED;
    pos.rewardClaimed = true;
    inner.set(sender, pos);
    s.stakes.set(msg.roundId, inner);

    var nextExtra = nextRd.extra.load();
    if (rollAmount > 0) {
        val prevStreak = streakOf(ex, sender);
        val newStreak = streakForRound(prevStreak, nextRoundId);
        val ownW = ownWeightFor(rollAmount, newStreak);
        nextPos.amountRaw = nextPos.amountRaw + rollAmount;
        nextPos.weight = nextPos.weight + ownW;
        nextInner.set(sender, nextPos);
        s.stakes.set(nextRoundId, nextInner);
        nextExtra.totalWeight = nextExtra.totalWeight + ownW;

        val referrerRes = ex.referrer.get(sender);
        if (referrerRes.isFound && rollAmount >= e.minStakeRaw) {
            val referrer = referrerRes.loadValue();
            val refPosRes = nextInner.get(referrer);
            val refStake: uint128 = refPosRes.isFound ? refPosRes.loadValue().amountRaw : 0;
            val bonusSoFar = bonusOf(nextExtra, referrer);
            val room: uint128 = refStake > bonusSoFar ? refStake - bonusSoFar : 0;
            val rawAdd: uint128 = referralRawAdd(rollAmount);
            val add: uint128 = rawAdd < room ? rawAdd : room;
            if (add > 0) {
                nextExtra.bonus.set(referrer, bonusSoFar + add);
                nextExtra.totalWeight = nextExtra.totalWeight + add;
            }
            nextExtra.referred.set(referrer, referredOf(nextExtra, referrer) + rollAmount);
        }

        // F-06: the roller may itself be a referrer -> top up its next-round bonus.
        val myReferred = referredOf(nextExtra, sender);
        if (myReferred > 0) {
            val twenty = myReferred / 5; // 20% = REFERRAL_BPS / 10000
            val target: uint128 = twenty < nextPos.amountRaw ? twenty : nextPos.amountRaw;
            val current = bonusOf(nextExtra, sender);
            if (target > current) {
                nextExtra.bonus.set(sender, target);
                nextExtra.totalWeight = nextExtra.totalWeight + (target - current);
            }
        }
        ex.streaks.set(sender, StreakInfo { lastRound: nextRoundId, count: newStreak });
    }

    if (excess > 0) {
        var lk = lockedStateOf(ex, sender);
        lk.lockedRaw = lockedOf(ex, sender) + excess;
        ex.locked.set(sender, lk);
    }
    s.extras = ex.toCell();

    var updatedNext = nextRd;
    updatedNext.totalAcceptedStakeRaw = nextRd.totalAcceptedStakeRaw + rollAmount;
    updatedNext.extra = nextExtra.toCell();
    s.rounds.set(nextRoundId, updatedNext);
    s.save();

    emitExternalEvent(RewardRolled {
        roundId: msg.roundId,
        owner: sender,
        amountRaw: rollAmount,
        nextRoundId,
    });
}

fun handleClaimUnlocked(sender: address, _msg: ClaimUnlocked, valueCoins: coins) {
    assert (valueCoins >= ton("0.15")) throw Errors.BadConfig;
    var s = lazy Storage.load();
    val now: uint64 = blockchain.now() as uint64;
    var ex = s.extras.load();
    assert (ex.unlockStart > 0) throw Errors.UnlockNotStarted;
    assert (now >= ex.unlockStart) throw Errors.UnlockNotStarted;
    requireNoPendingClaim(ex, sender);

    val lockedBefore = lockedOf(ex, sender);
    var folded: uint128 = 0;
    var foldMask: uint16 = 0;
    var roundId: uint8 = 1;
    while (roundId <= MAX_CLAIM_SCAN_ROUNDS) {
        val rr = s.rounds.get(roundId);
        if (rr.isFound) {
            val rd = rr.loadValue();
            if (rd.status == STATUS_SUCCEEDED) {
                val innerRes = s.stakes.get(roundId);
                if (innerRes.isFound) {
                    var inner = innerRes.loadValue();
                    val found = inner.get(sender);
                    if (found.isFound) {
                        var pos = found.loadValue();
                        if (!pos.rewardClaimed && pos.rewardState == REWARD_STATE_PENDING) {
                            val reward = rewardForRound(rd, roundExtra(rd), pos, sender);
                            if (reward > 0) {
                                folded = folded + reward;
                                foldMask = foldMask | ((1 as uint16) << ((roundId - 1) as uint16));
                                pos.rewardClaimed = true;
                                inner.set(sender, pos);
                                s.stakes.set(roundId, inner);
                            }
                        }
                    }
                }
            }
        }
        roundId += 1;
    }

    val totalLocked: uint128 = lockedBefore + folded;
    val claimed = claimedOf(ex, sender);
    val elapsed: uint64 = now - ex.unlockStart;
    val capped: uint64 = elapsed > (UNLOCK_DURATION_SECONDS as uint64)
        ? (UNLOCK_DURATION_SECONDS as uint64)
        : elapsed;
    val vested: uint128 = totalLocked * (capped as uint128) / (UNLOCK_DURATION_SECONDS as uint128);
    if (vested <= claimed) {
        throw Errors.NothingUnlocked;
    }
    val claimable: uint128 = vested - claimed;

    val q = claimQueryId(s.currentRoundId, CLAIM_KIND_UNLOCK, ex.claimCounter);
    ex.claimCounter = ex.claimCounter + 1;
    var lk = lockedStateOf(ex, sender);
    lk.lockedRaw = totalLocked;
    lk.claimedRaw = claimed + claimable;
    lk.pendingQueryId = q;
    ex.locked.set(sender, lk);
    ex.pending.set(q, PendingClaim { owner: sender, kind: CLAIM_KIND_UNLOCK, roundId: s.currentRoundId, principalMask: 0, rewardMask: foldMask, amountRaw: claimable, lockedDeltaRaw: folded, lockedBeforeRaw: lockedBefore });
    s.extras = ex.toCell();
    s.save();

    sendTrackedJettonTransfer(
        vaults(s).stakingJettonWallet,
        q,
        claimable as coins,
        sender,
        contract.getAddress(),
    );
    emitExternalEvent(UnlockClaimed { owner: sender, amountRaw: claimable });
}
// ===========================================================================
// Outbound instructions
// ===========================================================================

fun sendTeamRelease(teamVault: address, roundId: uint8, queryId: uint64) {
    val out = createMessage({ bounce: BounceMode.NoBounce, value: ton("0.05"), dest: teamVault, body: ReleaseTeamQuota { queryId, roundId } });
    out.send(SEND_MODE_PAY_FEES_SEPARATELY);
}

fun sendTeamBurn(teamVault: address, roundId: uint8, burnId: uint256, queryId: uint64) {
    val out = createMessage({ bounce: BounceMode.NoBounce, value: ton("0.05"), dest: teamVault, body: BurnTeamQuota { queryId, roundId, burnId } });
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
        admin: a.admin, oracle: a.oracle, jettonMaster: a.jettonMaster,
        stakingJettonWallet: v.stakingJettonWallet, teamVault: v.teamVault, p0UsdE8: e.p0UsdE8,
        priceMultiplier: e.priceMultiplier, roundRewardRaw: e.roundRewardRaw, teamRoundRaw: e.teamRoundRaw,
        minStakeRaw: e.minStakeRaw, maxStakePerAddressBps: e.maxStakePerAddressBps, maxTotalStakeRaw: e.maxTotalStakeRaw,
        previewSeconds: t.previewSeconds, stakeDurationSeconds: t.stakeDurationSeconds, candleSeconds: t.candleSeconds,
        candleCount: t.candleCount, minQualifiedCandles: t.minQualifiedCandles, observationSeconds: t.observationSeconds,
        techAbortPauseSeconds: t.techAbortPauseSeconds, techAbortObsTimeoutSeconds: t.techAbortObsTimeoutSeconds, riskDisclosureVersion: t.riskDisclosureVersion,
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


get fun get_user_stake(roundId: uint8, owner: address): StakePosition {
    val s = lazy Storage.load();
    val innerRes = s.stakes.get(roundId);
    if (!innerRes.isFound) {
        return StakePosition {
            amountRaw: 0,
            lastDepositNonce: 0,
            principalClaimed: false,
            rewardClaimed: false,
            weight: 0,
            rewardState: REWARD_STATE_PENDING,
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
            weight: 0,
            rewardState: REWARD_STATE_PENDING,
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
    return rewardForRound(rd, roundExtra(rd), posRes.loadValue(), owner);
}

get fun get_claimable_all(owner: address): Claimable {
    val s = lazy Storage.load();
    var principal: uint128 = 0;
    var reward: uint128 = 0;
    var mask: uint16 = 0;
    // A9-M4-02: round 0 refunds intentionally excluded — they are claimed only via
    // ClaimPrincipal(0), matching handleClaimAll which scans rounds 1..MAX.
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
                        val r = rewardForRound(rd, roundExtra(rd), pos, owner);
                        // legacy ClaimAll pays 50% now; the other 50% goes to the unlock pool
                        if (r > 0 && s.extras.load().unlockStart == 0) {
                            reward += r / 2;
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
        failureBurnId: roundExtra(rd).failureBurnId,
    };
}


// ===========================================================================
// V8 get methods (docs/17 §4.3)
// ===========================================================================

get fun get_user_weight(roundId: uint8, owner: address): uint128 {
    val s = lazy Storage.load();
    val found = s.rounds.get(roundId);
    if (!found.isFound) {
        return 0;
    }
    val rd = found.loadValue();
    val innerRes = s.stakes.get(roundId);
    if (!innerRes.isFound) {
        return 0;
    }
    val posRes = innerRes.loadValue().get(owner);
    if (!posRes.isFound) {
        return 0;
    }
    return posRes.loadValue().weight + bonusOf(roundExtra(rd), owner);
}

get fun get_total_weight(roundId: uint8): uint128 {
    val s = lazy Storage.load();
    val found = s.rounds.get(roundId);
    if (!found.isFound) {
        return 0;
    }
    return roundExtra(found.loadValue()).totalWeight;
}

get fun get_reward_state(owner: address, roundId: uint8): RewardStateInfo {
    val s = lazy Storage.load();
    val found = s.rounds.get(roundId);
    if (!found.isFound) {
        return { amountRaw: 0, state: REWARD_STATE_PENDING, rollableRaw: 0, earlyAmountRaw: 0 };
    }
    val rd = found.loadValue();
    val ex = roundExtra(rd);
    var amount: uint128 = 0;
    var state: uint8 = REWARD_STATE_PENDING;
    val innerRes = s.stakes.get(roundId);
    if (innerRes.isFound) {
        val posRes = innerRes.loadValue().get(owner);
        if (posRes.isFound) {
            val pos = posRes.loadValue();
            state = pos.rewardState;
            // F-07: full win amount is always reported after the round succeeded,
            // even after Roll / early claim (rollable/early are derived below).
            if (rd.status == STATUS_SUCCEEDED) {
                amount = rewardForRound(rd, ex, pos, owner);
            }
        }
    }
    var rollable: uint128 = 0;
    val rewardClaimedNow = innerRes.isFound
        && innerRes.loadValue().get(owner).isFound
        && innerRes.loadValue().get(owner).loadValue().rewardClaimed;
    if (state == REWARD_STATE_PENDING && !rewardClaimedNow && roundId < MAX_ROUNDS) {
        val nextFound = s.rounds.get(roundId + 1);
        if (nextFound.isFound) {
            val nextRd = nextFound.loadValue();
            if (nextRd.status == STATUS_PREVIEW || nextRd.status == STATUS_STAKING_OPEN) {
                val e = econ(s);
                val cap: uint128 = e.maxTotalStakeRaw * (e.maxStakePerAddressBps as uint128) / 10000;
                var room: uint128 = cap;
                val nextInnerRes = s.stakes.get(roundId + 1);
                if (nextInnerRes.isFound) {
                    val nextPosRes = nextInnerRes.loadValue().get(owner);
                    if (nextPosRes.isFound) {
                        val nextPos = nextPosRes.loadValue();
                        room = cap > nextPos.amountRaw ? cap - nextPos.amountRaw : 0;
                    }
                }
                val roomTotal: uint128 = e.maxTotalStakeRaw > nextRd.totalAcceptedStakeRaw
                    ? e.maxTotalStakeRaw - nextRd.totalAcceptedStakeRaw
                    : 0;
                rollable = amount;
                if (rollable > room) {
                    rollable = room;
                }
                if (rollable > roomTotal) {
                    rollable = roomTotal;
                }
            }
        }
    }
    return { amountRaw: amount, state, rollableRaw: rollable, earlyAmountRaw: amount / 2 };
}

get fun get_unlock_info(owner: address): UnlockInfo {
    val s = lazy Storage.load();
    val now: uint64 = blockchain.now() as uint64;
    val ex = s.extras.load();
    var locked: uint128 = lockedOf(ex, owner);
    var roundId: uint8 = 1;
    while (roundId <= MAX_CLAIM_SCAN_ROUNDS) {
        val rr = s.rounds.get(roundId);
        if (rr.isFound) {
            val rd = rr.loadValue();
            if (rd.status == STATUS_SUCCEEDED) {
                val innerRes = s.stakes.get(roundId);
                if (innerRes.isFound) {
                    val posRes = innerRes.loadValue().get(owner);
                    if (posRes.isFound) {
                        val pos = posRes.loadValue();
                        if (!pos.rewardClaimed && pos.rewardState == REWARD_STATE_PENDING) {
                            locked = locked + rewardForRound(rd, roundExtra(rd), pos, owner);
                        }
                    }
                }
            }
        }
        roundId += 1;
    }
    val claimed = claimedOf(ex, owner);
    var claimable: uint128 = 0;
    if (ex.unlockStart > 0 && now >= ex.unlockStart) {
        val elapsed: uint64 = now - ex.unlockStart;
        val capped: uint64 = elapsed > (UNLOCK_DURATION_SECONDS as uint64)
            ? (UNLOCK_DURATION_SECONDS as uint64)
            : elapsed;
        val vested: uint128 = locked * (capped as uint128) / (UNLOCK_DURATION_SECONDS as uint128);
        claimable = vested > claimed ? vested - claimed : 0;
    }
    return {
        unlockStart: ex.unlockStart,
        totalLockedRaw: locked,
        claimedRaw: claimed,
        claimableRaw: claimable,
    };
}

get fun get_referral(owner: address): ReferralInfo {
    val s = lazy Storage.load();
    val ex = s.extras.load();
    val ref = ex.referrer.get(owner);
    var referrer: address? = null;
    if (ref.isFound) {
        referrer = ref.loadValue();
    }
    var referredStake: uint128 = 0;
    var bonus: uint128 = 0;
    if (s.currentRoundId >= 1) {
        val rr = s.rounds.get(s.currentRoundId);
        if (rr.isFound) {
            val rdEx = roundExtra(rr.loadValue());
            referredStake = referredOf(rdEx, owner);
            bonus = bonusOf(rdEx, owner);
        }
    }
    return {
        referrer,
        referredStakeThisRound: referredStake,
        bonusThisRound: bonus,
    };
}

get fun get_streak(owner: address): StreakInfo {
    val s = lazy Storage.load();
    return streakOf(s.extras.load(), owner);
}


// Read-only config verification for ops: 0 before SetJettonWalletCode, then code hash.
get fun get_jetton_wallet_code_hash(): uint256 {
    val s = lazy Storage.load();
    val code = vaults(s).jettonWalletCode;
    if (code.depth() == 0) {
        return 0 as uint256;
    }
    return code.hash();
}

get fun get_claim_counter(): uint64 {
    val s = lazy Storage.load();
    return s.extras.load().claimCounter;
}

get fun has_pending_claim(queryId: uint64): bool {
    val s = lazy Storage.load();
    return s.extras.load().pending.exists(queryId);
}
