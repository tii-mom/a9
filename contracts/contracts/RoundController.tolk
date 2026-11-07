// A9 Protocol v11 — RoundController (docs/35 is authoritative).
//
//   * 10 rounds: PREVIEW 12h -> STAKING_OPEN 36h -> OBSERVING 24 x 1h -> settled
//   * target locked at open: max(P0 * 2^tier, 2 * opening 24h TWAP); tier = 1 + successes
//   * weight = stake x timing coefficient (first/second/last third of the window: 1.5/1.2/1.0)
//   * reward budget = 7e8 + carry; success: split by weight, 20% claimable at once,
//     80% unlocked by any later success, or linearly over 30 days after round 10
//   * failure: one burn of half the budget + team quota + all principal; other half carried
//   * empty success / technical abort: the whole budget is carried to the next round
//   * team quota of a success is paid at the NEXT success (last one: 30 days after round 10)
//   * positions live in per-(owner, round) StakeTicket contracts; RC stores round totals only,
//     so storage is bounded (<= 11 rounds) and stakers per round are unbounded
//
// Trust model: a single operator key opens rounds (opening TWAP) and submits candles.
// There is no admin, no upgrade, no withdrawal function, no parameter setter.

import "types"
import "constants"
import "jetton"
import "ticket"
import "jetton/jetton-utils"

contract RoundController {
    author: "A9 Protocol"
    version: "11.0.0"
    description: "A9 round state machine, round totals, settlement and ticket-based claims."
    storage: Storage
    incomingMessages: RoundControllerMessage
}

type RoundControllerMessage =
    | TransferNotification
    | OpenRound
    | CloseStaking
    | SubmitCandle
    | TicketRequest
    | AbortTechnical
    | RetrySettlement
    | ReleaseTeam
    | ReturnExcessesBack
    | TopUpTons

fun onInternalMessage(in: InMessage) {
    val msg = lazy RoundControllerMessage.fromSlice(in.body);
    match (msg) {
        TransferNotification => { handleDeposit(in.senderAddress, msg, in.valueCoins); }
        OpenRound => { handleOpenRound(in.senderAddress, msg); }
        CloseStaking => { handleCloseStaking(); }
        SubmitCandle => { handleSubmitCandle(in.senderAddress, msg); }
        TicketRequest => { handleTicketRequest(in.senderAddress, msg, in.valueCoins); }
        AbortTechnical => {
            // the caller pays (round-10 abort burns the carry from the RC balance)
            assert (in.valueCoins >= VALUE_JETTON_ACTION) throw Errors.NotEnoughValue;
            handleAbortTechnical();
        }
        RetrySettlement => { handleRetrySettlement(msg.roundId, in.valueCoins); }
        ReleaseTeam => { handleReleaseTeam(in.valueCoins); }
        ReturnExcessesBack => {}
        TopUpTons => {}
        else => throw Errors.UnknownMessage,
    }
}

// A bounced settlement transfer/burn is marked for RetrySettlement; a bounced final
// team release restores teamPendingRaw. Claims cannot bounce in practice (RC wallet
// balance invariant, enough TON, basechain owner checked at deposit).
fun onBouncedMessage(in: InMessageBounced) {
    in.bouncedBody.skipBouncedPrefix();
    if (in.bouncedBody.remainingBitsCount() < 96) {
        return;
    }
    val op = in.bouncedBody.loadUint(32) as uint32;
    val queryId = in.bouncedBody.loadUint(64) as uint64;
    if ((op == OP_JETTON_TRANSFER || op == OP_JETTON_BURN) && (queryId & SETTLE_QUERY_TAG) != 0) {
        val roundId = ((queryId >> 8) & 0xff) as uint8;
        val action = (queryId & 0xff) as uint8;
        var s = lazy Storage.load();
        if (roundId == 0 && action == ACTION_TEAM_TRANSFER) {
            val amount = in.bouncedBody.loadCoins() as uint128;
            s.teamPendingRaw += amount;
            s.save();
        } else {
            val found = s.rounds.get(roundId);
            if (found.isFound) {
                var rd = found.loadValue();
                if ((rd.actionsSent & action) != 0) {
                    rd.retryMask = rd.retryMask | action;
                    s.rounds.set(roundId, rd);
                    s.save();
                }
            }
        }
        emitExternalEvent(SettlementBounced { roundId, action });
        return;
    }
    emitExternalEvent(UnexpectedBounce { op, queryId });
}

// ===========================================================================
// Helpers
// ===========================================================================

fun cfg(s: Storage): ProtocolConfig { return s.config.load(); }
fun addresses(s: Storage): ProtocolAddresses { return cfg(s).addresses.load(); }
fun econ(s: Storage): ProtocolEcon { return cfg(s).econ.load(); }
fun timing(s: Storage): ProtocolTiming { return cfg(s).timing.load(); }
fun codes(s: Storage): ProtocolCodes { return cfg(s).codes.load(); }

// The RC's canonical Jetton Wallet, derived on-chain (no wiring step, no admin).
fun ownWallet(s: Storage): address {
    val c = cfg(s);
    return calcAddressOfJettonWallet(contract.getAddress(), c.addresses.load().jettonMaster, c.codes.load().jettonWalletCode);
}

fun requireKeeper(s: Storage, sender: address) {
    assert (sender == addresses(s).keeper) throw Errors.NotKeeper;
}

fun now64(): uint64 { return blockchain.now() as uint64; }

fun observationSeconds(t: ProtocolTiming): uint64 {
    return (t.candleSeconds as uint64) * (t.candleCount as uint64);
}

fun isSettled(status: uint8): bool {
    return status == STATUS_SUCCEEDED || status == STATUS_FAILED_PERMANENT ||
        status == STATUS_TECHNICAL_ABORTED;
}

fun floorPriceForTier(p0: uint128, tier: uint8): uint128 {
    var price: uint128 = p0;
    var i: uint8 = 0;
    while (i < tier) {
        price = price * (PRICE_MULTIPLIER as uint128);
        i += 1;
    }
    return price;
}

// Timing coefficient by thirds of the staking window (12h buckets for 36h: no
// advantage in racing the opening second).
fun timingBps(rd: RoundData, t: ProtocolTiming, now: uint64): uint128 {
    val third: uint64 = (t.stakeDurationSeconds as uint64) / 3;
    val elapsed: uint64 = now - rd.stakeOpenAt;
    if (elapsed < third) {
        return TIMING_BPS_FIRST;
    }
    if (elapsed < third * 2) { // intentional: bucket boundary, not a ratio
        return TIMING_BPS_SECOND;
    }
    return TIMING_BPS_LAST;
}

fun inStakingWindow(rd: RoundData, now: uint64): bool {
    return rd.status == STATUS_STAKING_OPEN && now >= rd.stakeOpenAt && now < rd.stakeCloseAt;
}

struct RewardSplit {
    reward: uint128
    immediate: uint128
    locked: uint128
}

fun rewardSplit(rd: RoundData, weight: uint128): RewardSplit {
    if (rd.status != STATUS_SUCCEEDED || rd.totalWeightRaw == 0) {
        return { reward: 0, immediate: 0, locked: 0 };
    }
    val reward: uint128 = rd.rewardBudgetRaw * weight / rd.totalWeightRaw; // floor; dust stays
    val immediate: uint128 = reward * IMMEDIATE_REWARD_BPS / BPS;
    return { reward, immediate, locked: reward - immediate };
}

// How much of a round's locked 80% is unlocked now (D-45).
fun unlockedLocked(s: Storage, roundId: uint8, locked: uint128, now: uint64): uint128 {
    if (s.lastSuccessRound > roundId) {
        return locked;
    }
    if (s.endAt == 0 || now <= s.endAt) {
        return 0;
    }
    val window: uint64 = timing(s).fallbackUnlockSeconds as uint64;
    val elapsed: uint64 = now - s.endAt;
    if (elapsed >= window) {
        return locked;
    }
    return locked * (elapsed as uint128) / (window as uint128);
}

fun settleQueryId(roundId: uint8, action: uint8): uint64 {
    return SETTLE_QUERY_TAG | ((roundId as uint64) << 8) | (action as uint64);
}

// A new PREVIEW round; its staking window opens once now >= stakeOpenAt.
fun previewRound(openAt: uint64): RoundData {
    var next = emptyRound();
    next.status = STATUS_PREVIEW;
    next.stakeOpenAt = openAt;
    return next;
}

// Credits `amount`/`weight` to Ticket(owner, roundId), deploying it if needed.
fun sendAddStake(s: Storage, owner: address, roundId: uint8, amount: uint128, weight: uint128, value: coins, mode: int) {
    val out = createMessage({
        bounce: BounceMode.Only256BitsOfBody,
        value,
        dest: calcDeployedTicket(contract.getAddress(), owner, roundId, codes(s).ticketCode),
        body: TicketAddStake { queryId: 0, amountRaw: amount, weightRaw: weight },
    });
    out.send(mode);
}

// ===========================================================================
// Deposits (TEP-74 transfer_notification from the RC's own Jetton Wallet)
// After the sender check this handler never throws: every invalid deposit is refunded
// (if it carries enough TON for the refund) or kept (documented behaviour).
// ===========================================================================

fun handleDeposit(sender: address, msg: TransferNotification, valueCoins: coins) {
    var s = lazy Storage.load();
    val wallet = ownWallet(s);
    assert (sender == wallet) throw Errors.NotJettonWallet;

    val initiator = msg.transferInitiator;
    val amount = msg.jettonAmount as uint128;
    if (amount == 0) {
        return;
    }

    var payload = unwrapForwardPayload(msg.forwardPayload);
    var ok = false;
    var payloadRound: uint8 = 0;
    var owner = initiator;
    if (payload.remainingBitsCount() >= 74 && payload.remainingRefsCount() == 0) {
        val op = payload.loadUint(32);
        val version = payload.loadUint(8);
        payloadRound = payload.loadUint(8) as uint8;
        val riskVersion = payload.loadUint(16);
        val acceptBurn = payload.loadUint(8);
        val head = payload.preloadUint(2);
        // addr_none (00) or addr_std (10); anything else is malformed
        if (head == 0) {
            payload.loadUint(2);
            ok = true;
        } else if (payload.preloadUint(3) == 4 && payload.remainingBitsCount() == 267) {
            // addr_std without anycast (100…); anycast would make loadAddress underflow (A9-V11-08)
            owner = payload.loadAddress();
            ok = true;
        }
        ok = ok && payload.remainingBitsCount() == 0 &&
            op == OP_STAKE_DEPOSIT && version == 2 && acceptBurn == 1 &&
            riskVersion == timing(s).riskDisclosureVersion;
    }

    val e = econ(s);
    val t = timing(s);
    val now = now64();
    val roundId = s.currentRoundId;
    var rd = emptyRound();
    if (ok && roundId >= 1) {
        val rr = s.rounds.get(roundId);
        if (rr.isFound) {
            rd = rr.loadValue();
        }
        ok = inStakingWindow(rd, now) && payloadRound == roundId &&
            amount >= e.minStakeRaw && valueCoins >= MIN_DEPOSIT_VALUE &&
            owner.getWorkchain() == BASECHAIN;
    } else {
        ok = false;
    }

    if (!ok) {
        refundDeposit(wallet, initiator, amount, valueCoins);
        return;
    }

    val weight: uint128 = amount * timingBps(rd, t, now) / BPS;
    rd.totalStakeRaw += amount;
    rd.totalWeightRaw += weight;
    rd.stakeCount += 1;
    s.rounds.set(roundId, rd);
    s.save();
    // The depositor pays everything: keep the RC's own TON, emit the event, then forward the
    // rest of the deposit's TON to the ticket (A9-V11-01).
    reserveToncoinsOnBalance(contract.getOriginalBalance() - valueCoins, RESERVE_MODE_AT_MOST);
    emitExternalEvent(DepositAccepted {
        roundId,
        owner,
        amountRaw: amount,
        weightRaw: weight,
        totalAcceptedStakeRaw: rd.totalStakeRaw,
        totalWeightRaw: rd.totalWeightRaw,
    });
    // SAFETY: original balance reserved above; only the deposit's TON is forwarded.
    sendAddStake(s, owner, roundId, amount, weight, 0, SEND_MODE_CARRY_ALL_BALANCE);
}

// Instant refund paid by the deposit's own forward TON; without it the amount is kept
// (no ledger: keeps RC storage bounded; frontends always attach enough TON).
fun refundDeposit(wallet: address, initiator: address, amount: uint128, valueCoins: coins) {
    if (valueCoins >= MIN_REFUND_VALUE && initiator.getWorkchain() == BASECHAIN) {
        reserveToncoinsOnBalance(contract.getOriginalBalance() - valueCoins, RESERVE_MODE_AT_MOST);
        emitExternalEvent(DepositRefunded { owner: initiator, amountRaw: amount, instant: true });
        sendWithReservedBalance(wallet, buildJettonTransferBody(REFUND_QUERY_TAG, amount as coins, initiator, initiator));
        return;
    }
    // Kept deposit: log it only if the message's own TON covers the event, so dust notifications
    // cannot drain the RC's balance through event fees.
    if (valueCoins >= MIN_EVENT_VALUE) {
        emitExternalEvent(DepositRefunded { owner: initiator, amountRaw: amount, instant: false });
    }
}

// ===========================================================================
// Round lifecycle
// ===========================================================================

fun handleOpenRound(sender: address, msg: OpenRound) {
    var s = lazy Storage.load();
    requireKeeper(s, sender);
    val now = now64();
    val e = econ(s);
    val t = timing(s);

    var roundId: uint8 = 1;
    var rd = emptyRound();
    if (s.currentRoundId != 0) {
        assert (s.currentRoundId < MAX_ROUNDS) throw Errors.MaxRoundsReached;
        val prev = s.rounds.get(s.currentRoundId);
        assert (prev.isFound && isSettled(prev.loadValue().status)) throw Errors.BadRoundStatus;
        roundId = s.currentRoundId + 1;
        val nr = s.rounds.get(roundId);
        assert (nr.isFound) throw Errors.BadRoundId;
        rd = nr.loadValue();
        assert (rd.status == STATUS_PREVIEW) throw Errors.BadRoundStatus;
        assert (now >= rd.stakeOpenAt) throw Errors.PreviewNotFinished;
    }

    val tier: uint8 = s.successCount + 1;
    val floorPrice = floorPriceForTier(e.p0UsdE8, tier);
    val twapTarget: uint128 = msg.twap24hUsdE8 * (PRICE_MULTIPLIER as uint128);
    val target: uint128 = twapTarget > floorPrice ? twapTarget : floorPrice;

    var ex = rd.extra.load();
    ex.targetTwap24hUsdE8 = msg.twap24hUsdE8;
    rd.extra = ex.toCell();
    rd.status = STATUS_STAKING_OPEN;
    rd.targetTier = tier;
    rd.targetPriceUsdE8 = target;
    rd.rewardBudgetRaw = e.roundRewardRaw + s.carryRaw;
    s.carryRaw = 0;
    rd.stakeOpenAt = now;
    rd.stakeCloseAt = now + (t.stakeDurationSeconds as uint64);
    s.currentRoundId = roundId;
    s.rounds.set(roundId, rd);
    s.save();
    emitExternalEvent(TargetPriceSet { roundId, tier, targetPriceUsdE8: target, twap24hUsdE8: msg.twap24hUsdE8 });
}

// Moves STAKING_OPEN -> OBSERVING once the 36h window has ended. Anyone may call;
// SubmitCandle performs the same transition implicitly.
fun handleCloseStaking() {
    var s = lazy Storage.load();
    val roundId = s.currentRoundId;
    val rr = s.rounds.get(roundId);
    assert (roundId >= 1 && rr.isFound) throw Errors.BadRoundId;
    var rd = rr.loadValue();
    assert (rd.status == STATUS_STAKING_OPEN) throw Errors.BadRoundStatus;
    assert (now64() >= rd.stakeCloseAt) throw Errors.TooEarly;
    rd.status = STATUS_OBSERVING;
    s.rounds.set(roundId, rd);
    s.save();
    emitExternalEvent(StakingClosed { roundId, closeAt: rd.stakeCloseAt, early: false, twap1hUsdE8: 0 });
}

fun handleSubmitCandle(sender: address, msg: SubmitCandle) {
    var s = lazy Storage.load();
    requireKeeper(s, sender);
    val now = now64();
    val t = timing(s);
    assert (msg.roundId >= 1 && msg.roundId == s.currentRoundId) throw Errors.BadRoundId;
    var rd = s.rounds.get(msg.roundId).loadValue();

    if (rd.status == STATUS_STAKING_OPEN && now >= rd.stakeCloseAt) {
        rd.status = STATUS_OBSERVING;
        emitExternalEvent(StakingClosed { roundId: msg.roundId, closeAt: rd.stakeCloseAt, early: false, twap1hUsdE8: 0 });
    }
    assert (rd.status == STATUS_OBSERVING) throw Errors.BadRoundStatus;
    assert (msg.candleIndex < t.candleCount) throw Errors.CandleIndexOutOfRange;
    assert (msg.candleIndex == rd.candlesSeen) throw Errors.CandleOutOfOrder;

    val expectedStart: uint64 = rd.stakeCloseAt + (msg.candleIndex as uint64) * (t.candleSeconds as uint64);
    val expectedEnd: uint64 = expectedStart + (t.candleSeconds as uint64);
    assert ((msg.periodStart as uint64) == expectedStart && (msg.periodEnd as uint64) == expectedEnd) throw Errors.CandlePeriodMismatch;
    assert (now >= expectedEnd) throw Errors.CandleNotClosedYet;
    assert (msg.twapPriceUsdE8 > 0) throw Errors.CandleBadPrice;

    var ex = rd.extra.load();
    ex.candleHash = beginCell()
        .storeUint(ex.candleHash, 256)
        .storeUint(msg.candleIndex, 8)
        .storeUint(msg.twapPriceUsdE8, 128)
        .storeUint(msg.dataDigest, 256)
        .endCell()
        .hash();
    rd.extra = ex.toCell();
    rd.candlesSeen += 1;
    if (msg.twapPriceUsdE8 >= rd.targetPriceUsdE8) {
        rd.qualifiedCandles += 1;
    }
    emitExternalEvent(CandleSubmitted {
        roundId: msg.roundId,
        candleIndex: msg.candleIndex,
        periodStart: msg.periodStart,
        periodEnd: msg.periodEnd,
        twapPriceUsdE8: msg.twapPriceUsdE8,
        dataDigest: msg.dataDigest,
        candleHash: ex.candleHash,
    });

    if (rd.candlesSeen == t.candleCount) {
        settleRound(mutate s, msg.roundId, rd, rd.qualifiedCandles >= t.minQualifiedCandles, now);
        return;
    }
    s.rounds.set(msg.roundId, rd);
    s.save();
}

fun settleRound(mutate s: Storage, roundId: uint8, rd: RoundData, success: bool, now: uint64) {
    val e = econ(s);
    val a = addresses(s);
    val wallet = ownWallet(s);
    val budget = rd.rewardBudgetRaw;
    var rewardBurn: uint128 = 0;
    var teamBurn: uint128 = 0;
    var principalBurn: uint128 = 0;
    var teamReleased: uint128 = 0;

    if (success) {
        rd.status = STATUS_SUCCEEDED;
        s.successCount += 1;
        s.lastSuccessRound = roundId;
        teamReleased = s.teamPendingRaw; // previous success's quota (D-47)
        s.teamPendingRaw = e.teamRoundRaw;
        if (rd.totalStakeRaw == 0) {
            s.carryRaw += budget; // nobody to pay: roll the whole budget
        }
    } else {
        rd.status = STATUS_FAILED_PERMANENT;
        val half: uint128 = budget / 2;
        rewardBurn = half;
        s.carryRaw += budget - half;
        teamBurn = e.teamRoundRaw;
        principalBurn = rd.totalStakeRaw;
    }
    if (roundId == MAX_ROUNDS) {
        s.endAt = now;
        rewardBurn += s.carryRaw; // nothing left to roll into
        s.carryRaw = 0;
    }
    rd.settledAt = now;

    var ex = rd.extra.load();
    if (teamReleased > 0) {
        ex.teamTransferRaw = teamReleased;
        rd.actionsSent = rd.actionsSent | ACTION_TEAM_TRANSFER;
        sendTeamTransfer(wallet, roundId, teamReleased, a.teamWallet);
    }
    val burnTotal: uint128 = rewardBurn + teamBurn + principalBurn;
    if (burnTotal > 0) {
        ex.burnRaw = burnTotal;
        rd.actionsSent = rd.actionsSent | ACTION_BURN;
        sendBurn(wallet, roundId, burnTotal);
    }
    rd.extra = ex.toCell();
    s.rounds.set(roundId, rd);
    if (roundId < MAX_ROUNDS) {
        s.rounds.set(roundId + 1, previewRound(now + (timing(s).previewSeconds as uint64)));
    }
    s.save();

    emitExternalEvent(RoundSettled {
        roundId,
        status: rd.status,
        qualifiedCandles: rd.qualifiedCandles,
        candlesSeen: rd.candlesSeen,
        totalAcceptedStakeRaw: rd.totalStakeRaw,
        tierAfter: s.successCount + 1,
        rewardBurnRaw: rewardBurn,
        teamBurnRaw: teamBurn,
        principalBurnRaw: principalBurn,
        teamReleasedRaw: teamReleased,
        rewardBudgetRaw: budget,
        carryAfterRaw: s.carryRaw,
    });
    if (teamReleased > 0) {
        emitExternalEvent(TeamReleased { roundId, amountRaw: teamReleased });
    }
}

fun sendTeamTransfer(wallet: address, roundId: uint8, amount: uint128, teamWallet: address) {
    sendFromBalance(wallet, buildJettonTransferBody(settleQueryId(roundId, ACTION_TEAM_TRANSFER), amount as coins, teamWallet, contract.getAddress()));
}

fun sendBurn(wallet: address, roundId: uint8, amount: uint128) {
    sendFromBalance(wallet, buildJettonBurnBody(settleQueryId(roundId, ACTION_BURN), amount as coins, contract.getAddress()));
}

fun handleRetrySettlement(roundId: uint8, valueCoins: coins) {
    assert (valueCoins >= MIN_RETRY_VALUE) throw Errors.NotEnoughValue;
    var s = lazy Storage.load();
    val rr = s.rounds.get(roundId);
    assert (roundId >= 1 && rr.isFound) throw Errors.BadRoundId;
    var rd = rr.loadValue();
    assert (rd.retryMask != 0) throw Errors.NothingToRetry;
    val ex = rd.extra.load();
    val wallet = ownWallet(s);
    if ((rd.retryMask & ACTION_TEAM_TRANSFER) != 0) {
        sendTeamTransfer(wallet, roundId, ex.teamTransferRaw, addresses(s).teamWallet);
    }
    if ((rd.retryMask & ACTION_BURN) != 0) {
        sendBurn(wallet, roundId, ex.burnRaw);
    }
    rd.retryMask = 0;
    s.rounds.set(roundId, rd);
    s.save();
}

// Anyone, 30 days after round 10: pays the last success's pending team quota.
fun handleReleaseTeam(valueCoins: coins) {
    assert (valueCoins >= MIN_CLAIM_VALUE) throw Errors.NotEnoughValue;
    var s = lazy Storage.load();
    assert (s.endAt != 0 && now64() >= s.endAt + (timing(s).fallbackUnlockSeconds as uint64)) throw Errors.TooEarly;
    val amount = s.teamPendingRaw;
    assert (amount > 0) throw Errors.NothingToClaim;
    s.teamPendingRaw = 0;
    s.save();
    sendTeamTransfer(ownWallet(s), 0, amount, addresses(s).teamWallet);
    emitExternalEvent(TeamReleased { roundId: 0, amountRaw: amount });
}

// Liveness escape (anyone):
//   * current round still STAKING_OPEN/OBSERVING abortTimeout after its expected end
//   * next round still PREVIEW abortTimeout after its staking should have opened
// Principal becomes claimable through tickets; the budget is carried; the tier is kept.
fun handleAbortTechnical() {
    var s = lazy Storage.load();
    val now = now64();
    val t = timing(s);
    val e = econ(s);
    var roundId = s.currentRoundId;
    assert (roundId >= 1) throw Errors.BadRoundId;
    var rd = s.rounds.get(roundId).loadValue();
    val timeout = t.abortTimeoutSeconds as uint64;
    var reason: uint8 = 0;

    if ((rd.status == STATUS_STAKING_OPEN || rd.status == STATUS_OBSERVING) &&
        now >= rd.stakeCloseAt + observationSeconds(t) + timeout) {
        reason = ABORT_REASON_OBSERVATION_TIMEOUT;
        s.carryRaw += rd.rewardBudgetRaw;
    } else if (isSettled(rd.status) && roundId < MAX_ROUNDS) {
        val nr = s.rounds.get(roundId + 1);
        if (nr.isFound) {
            val next = nr.loadValue();
            if (next.status == STATUS_PREVIEW && now >= next.stakeOpenAt + timeout) {
                roundId += 1;
                rd = next;
                reason = ABORT_REASON_PREVIEW_TIMEOUT;
                s.carryRaw += e.roundRewardRaw; // never opened: its own 7e8 rolls on
            }
        }
    }
    assert (reason != 0) throw Errors.TooEarly;

    rd.status = STATUS_TECHNICAL_ABORTED;
    rd.settledAt = now;
    s.currentRoundId = roundId;
    var burned: uint128 = 0;
    if (roundId == MAX_ROUNDS) {
        s.endAt = now;
        if (s.carryRaw > 0) {
            burned = s.carryRaw;
            var ex = rd.extra.load();
            ex.burnRaw = s.carryRaw;
            rd.extra = ex.toCell();
            rd.actionsSent = rd.actionsSent | ACTION_BURN;
            sendBurn(ownWallet(s), roundId, s.carryRaw);
            s.carryRaw = 0;
        }
    }
    s.rounds.set(roundId, rd);
    if (roundId < MAX_ROUNDS) {
        s.rounds.set(roundId + 1, previewRound(now + (t.previewSeconds as uint64)));
    }
    s.save();
    emitExternalEvent(TechnicalAborted { roundId, reason, at: now, burnRaw: burned });
}

// ===========================================================================
// Ticket requests: claim (principal + 20% now, locked 80% as it unlocks) or restake.
// Every refusal throws before any state change: the request bounces back to the
// ticket, which clears its pending flag.
// ===========================================================================

fun handleTicketRequest(sender: address, msg: TicketRequest, valueCoins: coins) {
    var s = lazy Storage.load();
    val ticketCode = codes(s).ticketCode;
    assert (sender == calcTicketAddress(contract.getAddress(), msg.owner, msg.roundId, ticketCode)) throw Errors.NotTicket;
    // Too little TON must fail in the compute phase (bounces to the ticket, clearing pending).
    assert (valueCoins >= (msg.restake ? MIN_RC_RESTAKE_VALUE : MIN_RC_REQUEST_VALUE)) throw Errors.NotEnoughValue;
    val rr = s.rounds.get(msg.roundId);
    assert (rr.isFound) throw Errors.BadRoundId;
    val rd = rr.loadValue();
    val now = now64();

    var principal: uint128 = 0;
    var reward: uint128 = 0;
    var principalDone = msg.principalDone;
    var lockedClaimed = msg.lockedClaimedRaw;
    if (rd.status == STATUS_SUCCEEDED) {
        val split = rewardSplit(rd, msg.weightRaw);
        if (!principalDone) {
            principal = msg.amountRaw;
            reward += split.immediate;
            principalDone = true;
        }
        val unlocked = unlockedLocked(s, msg.roundId, split.locked, now);
        if (unlocked > lockedClaimed) {
            reward += unlocked - lockedClaimed;
            lockedClaimed = unlocked;
        }
    } else if (rd.status == STATUS_TECHNICAL_ABORTED) {
        if (!principalDone) {
            principal = msg.amountRaw;
            principalDone = true;
        }
    }

    // Keep the RC's own TON balance: everything sent below comes out of the request's value
    // (the original balance already includes the inbound value, so subtract it).
    // +BOUNCE_ON_ACTION_FAIL everywhere below: an action-phase failure bounces the request to the
    // ticket (clearing pending) instead of leaving it stuck (A9-V11-02).
    reserveToncoinsOnBalance(contract.getOriginalBalance() - valueCoins, RESERVE_MODE_AT_MOST | RESERVE_MODE_BOUNCE_ON_ACTION_FAIL);
    val wallet = ownWallet(s);

    if (msg.restake) {
        assert (principal > 0) throw Errors.NothingToClaim;
        val cur = s.currentRoundId;
        assert (cur != msg.roundId) throw Errors.RestakeNotOpen;
        var cr = s.rounds.get(cur).loadValue();
        assert (inStakingWindow(cr, now)) throw Errors.RestakeNotOpen;
        val weight: uint128 = principal * timingBps(cr, timing(s), now) / BPS;
        cr.totalStakeRaw += principal;
        cr.totalWeightRaw += weight;
        cr.stakeCount += 1;
        s.rounds.set(cur, cr);
        s.save();
        // events first: the last send carries the whole remaining balance
        emitExternalEvent(Restaked { owner: msg.owner, fromRound: msg.roundId, toRound: cur, amountRaw: principal, weightRaw: weight });
        emitExternalEvent(DepositAccepted {
            roundId: cur,
            owner: msg.owner,
            amountRaw: principal,
            weightRaw: weight,
            totalAcceptedStakeRaw: cr.totalStakeRaw,
            totalWeightRaw: cr.totalWeightRaw,
        });
        sendTicketUpdate(sender, principalDone, lockedClaimed);
        if (reward > 0) {
            emitExternalEvent(Claimed { owner: msg.owner, roundId: msg.roundId, principalRaw: 0, rewardRaw: reward });
            sendAddStake(s, msg.owner, cur, principal, weight, VALUE_TICKET_DEPLOY, SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
            sendClaimTransfer(wallet, reward, msg.owner);
        } else {
            // SAFETY: original balance reserved above; only the request's TON is forwarded.
            sendAddStake(s, msg.owner, cur, principal, weight, 0, SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
        }
        return;
    }

    assert (principal + reward > 0) throw Errors.NothingToClaim;
    emitExternalEvent(Claimed { owner: msg.owner, roundId: msg.roundId, principalRaw: principal, rewardRaw: reward });
    sendTicketUpdate(sender, principalDone, lockedClaimed);
    sendClaimTransfer(wallet, principal + reward, msg.owner);
}

fun sendTicketUpdate(ticket: address, principalDone: bool, lockedClaimed: uint128) {
    val out = createMessage({
        bounce: BounceMode.NoBounce,
        value: VALUE_TICKET_MSG,
        dest: ticket,
        body: TicketUpdate { queryId: 0, principalDone, lockedClaimedRaw: lockedClaimed },
    });
    out.send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
}

// Last message of a request: carries everything above the reserved original balance.
fun sendClaimTransfer(wallet: address, amount: uint128, owner: address) {
    val out = createMessage({
        bounce: BounceMode.Only256BitsOfBody,
        value: 0,
        dest: wallet,
        body: buildJettonTransferBody(CLAIM_QUERY_TAG, amount as coins, owner, owner),
    });
    // SAFETY: a reserve of the RC's original balance (minus this request's value) is set
    // before any send in handleTicketRequest, so CARRY_ALL_BALANCE only forwards the
    // request's own TON; RC jettons are not affected by TON modes.
    out.send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
}

// ===========================================================================
// Get methods (v8.9/v10-compatible shapes where they survive)
// ===========================================================================

get fun get_protocol_config(): ProtocolConfigView {
    val s = lazy Storage.load();
    val a = addresses(s);
    val e = econ(s);
    val t = timing(s);
    return {
        admin: a.keeper,
        oracle: a.keeper,
        jettonMaster: a.jettonMaster,
        stakingJettonWallet: ownWallet(s),
        teamVault: a.teamWallet,
        p0UsdE8: e.p0UsdE8,
        priceMultiplier: PRICE_MULTIPLIER,
        roundRewardRaw: e.roundRewardRaw,
        teamRoundRaw: e.teamRoundRaw,
        minStakeRaw: e.minStakeRaw,
        maxStakePerAddressBps: 0, // v11: no per-address cap
        maxTotalStakeRaw: 0,      // v11: no round cap
        previewSeconds: t.previewSeconds,
        stakeDurationSeconds: t.stakeDurationSeconds,
        candleSeconds: t.candleSeconds,
        candleCount: t.candleCount,
        minQualifiedCandles: t.minQualifiedCandles,
        observationSeconds: observationSeconds(t) as uint32,
        techAbortPauseSeconds: t.abortTimeoutSeconds,
        techAbortObsTimeoutSeconds: t.abortTimeoutSeconds,
        riskDisclosureVersion: t.riskDisclosureVersion,
        configVersion: t.configVersion,
    };
}

get fun get_protocol_state(): ProtocolStateView {
    val s = lazy Storage.load();
    return {
        carryRaw: s.carryRaw,
        lastSuccessRound: s.lastSuccessRound,
        teamPendingRaw: s.teamPendingRaw,
        endAt: s.endAt,
        successCount: s.successCount,
        currentRoundId: s.currentRoundId,
        fallbackUnlockSeconds: timing(s).fallbackUnlockSeconds,
    };
}

get fun get_jetton_wallet_address(): address {
    val s = lazy Storage.load();
    return ownWallet(s);
}

get fun get_jetton_wallet_code_hash(): uint256 {
    val s = lazy Storage.load();
    return codes(s).jettonWalletCode.hash();
}

get fun get_ticket_code_hash(): uint256 {
    val s = lazy Storage.load();
    return codes(s).ticketCode.hash();
}

get fun get_ticket_address(owner: address, roundId: uint8): address {
    val s = lazy Storage.load();
    return calcTicketAddress(contract.getAddress(), owner, roundId, codes(s).ticketCode);
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
    val rd = found.isFound ? found.loadValue() : emptyRound();
    val ex = rd.extra.load();
    val e = econ(s);
    val t = timing(s);
    val opened = rd.status != STATUS_UNOPENED && rd.status != STATUS_PREVIEW;
    val teamOk = (rd.actionsSent & ACTION_TEAM_TRANSFER) != 0 && (rd.retryMask & ACTION_TEAM_TRANSFER) == 0;
    val burnOk = (rd.actionsSent & ACTION_BURN) != 0 && (rd.retryMask & ACTION_BURN) == 0;
    val failed = rd.status == STATUS_FAILED_PERMANENT;
    // PREVIEW shows the budget it will open with
    val budget: uint128 = opened ? rd.rewardBudgetRaw :
        (rd.status == STATUS_PREVIEW ? e.roundRewardRaw + s.carryRaw : 0 as uint128);
    return {
        roundId,
        status: rd.status,
        targetTier: rd.targetTier,
        targetPriceUsdE8: rd.targetPriceUsdE8,
        targetTwap24hUsdE8: ex.targetTwap24hUsdE8,
        targetWrittenAt: opened ? rd.stakeOpenAt : 0,
        rewardBudgetRaw: budget,
        stakeOpenAt: rd.stakeOpenAt,
        stakeCloseAt: opened ? rd.stakeCloseAt : 0,
        observationStart: opened ? rd.stakeCloseAt : 0,
        observationEnd: opened ? rd.stakeCloseAt + observationSeconds(t) : 0,
        candlesSeen: rd.candlesSeen,
        qualifiedCandles: rd.qualifiedCandles,
        totalAcceptedStakeRaw: rd.totalStakeRaw,
        settledAt: rd.settledAt,
        teamReleaseConfirmed: teamOk,
        teamBurnConfirmed: failed && burnOk,
        rewardBurnConfirmed: burnOk,
        principalBurnConfirmed: failed && burnOk,
        failureBurnId: 0 as uint256,
        candleHash: ex.candleHash,
        totalWeight: rd.totalWeightRaw,
    };
}

get fun get_round_status(roundId: uint8): uint8 {
    val s = lazy Storage.load();
    val found = s.rounds.get(roundId);
    return found.isFound ? found.loadValue().status : STATUS_UNOPENED;
}

get fun get_round_target_price(roundId: uint8): uint128 {
    val s = lazy Storage.load();
    val found = s.rounds.get(roundId);
    return found.isFound ? found.loadValue().targetPriceUsdE8 : 0;
}

get fun get_round_total_stake(roundId: uint8): uint128 {
    val s = lazy Storage.load();
    val found = s.rounds.get(roundId);
    return found.isFound ? found.loadValue().totalStakeRaw : 0;
}

// v11: number of accepted deposits (tickets are separate contracts, not counted by address)
get fun get_round_staker_count(roundId: uint8): uint32 {
    val s = lazy Storage.load();
    val found = s.rounds.get(roundId);
    return found.isFound ? found.loadValue().stakeCount : 0;
}

// What a ticket with `weightRaw` in `roundId` is owed (frontends read the ticket's
// weight and lockedClaimedRaw from get_ticket_data, then subtract).
get fun get_reward_preview(roundId: uint8, weightRaw: uint128): RewardPreview {
    val s = lazy Storage.load();
    val found = s.rounds.get(roundId);
    if (!found.isFound) {
        return { rewardRaw: 0, immediateRaw: 0, lockedRaw: 0, unlockedLockedRaw: 0 };
    }
    val split = rewardSplit(found.loadValue(), weightRaw);
    return {
        rewardRaw: split.reward,
        immediateRaw: split.immediate,
        lockedRaw: split.locked,
        unlockedLockedRaw: unlockedLocked(s, roundId, split.locked, now64()),
    };
}
