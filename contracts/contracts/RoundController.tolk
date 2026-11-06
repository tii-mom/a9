// A9 Protocol v10 — RoundController (the only self-developed contract).
//
//   * 10 rounds: PREVIEW 12h -> STAKING_OPEN 36h -> OBSERVING 24 x 1h -> settled
//   * target locked at open: max(P0 * 2^tier, 2 * opening 24h TWAP); tier = 1 + successes
//   * judged on the 24th candle (>= 16 qualified): SUCCEEDED or FAILED_PERMANENT, no
//     intermediate settling states
//   * success: stakers share the round reward pro rata, 100% claimable at once;
//     1.2e8 team quota is transferred to the team wallet
//   * failure: one burn of reward + team quota + all principal (supply really drops)
//   * 0-stake success: the round reward is burned, team quota released
//   * technical abort (anyone, after timeouts): principal refunded, nothing burned
//   * holds reward pool (7e9) + team quota (1.2e9) + principal in ONE Jetton Wallet
//
// Trust model: a single operator key opens rounds (opening TWAP) and submits candles.
// There is no admin, no upgrade, no withdrawal function, no parameter setter.
// Storage is bounded: each position needs >= minStake and each round holds at most
// maxTotalStake, so positions <= 10 * maxTotal / minStake.

import "types"
import "constants"
import "jetton"
import "jetton/jetton-utils"

contract RoundController {
    author: "A9 Protocol"
    version: "10.0.0"
    description: "A9 round state machine, stake ledger, settlement and pull claims."
    storage: Storage
    incomingMessages: RoundControllerMessage
}

type RoundControllerMessage =
    | TransferNotification
    | OpenRound
    | CloseStaking
    | SubmitCandle
    | Claim
    | ClaimAll
    | AbortTechnical
    | RetrySettlement
    | ReturnExcessesBack
    | TopUpTons

fun onInternalMessage(in: InMessage) {
    val msg = lazy RoundControllerMessage.fromSlice(in.body);
    match (msg) {
        TransferNotification => { handleDeposit(in.senderAddress, msg, in.valueCoins); }
        OpenRound => { handleOpenRound(in.senderAddress, msg); }
        CloseStaking => { handleCloseStaking(); }
        SubmitCandle => { handleSubmitCandle(in.senderAddress, msg); }
        Claim => { handleClaim(in.senderAddress, msg.roundId, false, in.valueCoins); }
        ClaimAll => { handleClaim(in.senderAddress, 0, true, in.valueCoins); }
        AbortTechnical => { handleAbortTechnical(); }
        RetrySettlement => { handleRetrySettlement(msg.roundId, in.valueCoins); }
        ReturnExcessesBack => {}
        TopUpTons => {}
        else => throw Errors.UnknownMessage,
    }
}

// A bounced settlement transfer/burn is marked for RetrySettlement. Claims and
// refunds cannot bounce in practice (fixed RC wallet balance invariant, enough TON,
// basechain recipient checked up front); if one ever does, the tokens stay in the
// RC wallet and an event is emitted for reconciliation.
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
        val found = s.rounds.get(roundId);
        if (found.isFound) {
            var rd = found.loadValue();
            if ((rd.actionsSent & action) != 0) {
                rd.retryMask = rd.retryMask | action;
                s.rounds.set(roundId, rd);
                s.save();
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

// The RC's canonical Jetton Wallet, derived on-chain (no wiring step, no admin).
fun ownWallet(s: Storage): address {
    val c = cfg(s);
    return calcAddressOfJettonWallet(contract.getAddress(), c.addresses.load().jettonMaster, c.jettonWalletCode);
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

fun rewardOf(rd: RoundData, rewardBudget: uint128, amount: uint128): uint128 {
    if (rd.status != STATUS_SUCCEEDED || rd.totalStakeRaw == 0) {
        return 0;
    }
    return rewardBudget * amount / rd.totalStakeRaw; // floor; dust stays in the vault
}

// roundsMask layout (unchanged from v8.9): bit (r-1) = round r; bit 15 = refund ledger.
fun maskBit(roundId: uint8): uint16 {
    return roundId == 0 ? (1 as uint16) << 15 : (1 as uint16) << ((roundId - 1) as uint16);
}

fun settleQueryId(roundId: uint8, action: uint8): uint64 {
    return SETTLE_QUERY_TAG | ((roundId as uint64) << 8) | (action as uint64);
}

fun stakesOf(s: Storage, roundId: uint8): map<address, StakePosition> {
    val r = s.stakes.get(roundId);
    return r.isFound ? r.loadValue() : [];
}

// A new PREVIEW round; its staking window opens once now >= stakeOpenAt.
fun previewRound(openAt: uint64): RoundData {
    var next = emptyRound();
    next.status = STATUS_PREVIEW;
    next.stakeOpenAt = openAt;
    return next;
}

// ===========================================================================
// Deposits (TEP-74 transfer_notification from the RC's own Jetton Wallet)
// After the sender check this handler never throws: every invalid deposit is refunded.
// ===========================================================================

fun handleDeposit(sender: address, msg: TransferNotification, valueCoins: coins) {
    var s = lazy Storage.load();
    val wallet = ownWallet(s);
    assert (sender == wallet) throw Errors.NotJettonWallet;

    val owner = msg.transferInitiator;
    val amount = msg.jettonAmount as uint128;
    if (amount == 0) {
        return;
    }

    var payload = unwrapForwardPayload(msg.forwardPayload);
    var ok = false;
    var payloadRound: uint8 = 0;
    var nonce: uint64 = 0;
    if (payload.remainingBitsCount() == 136 && payload.remainingRefsCount() == 0) {
        val op = payload.loadUint(32);
        val version = payload.loadUint(8);
        payloadRound = payload.loadUint(8) as uint8;
        nonce = payload.loadUint(64) as uint64;
        val riskVersion = payload.loadUint(16);
        val acceptBurn = payload.loadUint(8);
        ok = op == OP_STAKE_DEPOSIT && version == 1 && acceptBurn == 1 &&
            riskVersion == timing(s).riskDisclosureVersion;
    }

    val e = econ(s);
    val now = now64();
    val roundId = s.currentRoundId;
    var rd = emptyRound();
    if (ok && roundId >= 1) {
        val rr = s.rounds.get(roundId);
        if (rr.isFound) {
            rd = rr.loadValue();
        }
        ok = rd.status == STATUS_STAKING_OPEN && payloadRound == roundId &&
            now >= rd.stakeOpenAt && now < rd.stakeCloseAt && amount >= e.minStakeRaw;
    } else {
        ok = false;
    }

    var inner: map<address, StakePosition> = [];
    var pos = StakePosition { amountRaw: 0, lastDepositNonce: 0, claimed: false };
    var isNew = true;
    if (ok) {
        inner = stakesOf(s, roundId);
        val prev = inner.get(owner);
        if (prev.isFound) {
            pos = prev.loadValue();
            isNew = false;
        }
        ok = nonce > pos.lastDepositNonce &&
            pos.amountRaw + amount <= e.maxStakePerAddressRaw &&
            rd.totalStakeRaw + amount <= e.maxTotalStakeRaw;
    }

    if (!ok) {
        refundDeposit(mutate s, wallet, owner, amount, valueCoins, e.minStakeRaw);
        return;
    }

    pos.amountRaw += amount;
    pos.lastDepositNonce = nonce;
    inner.set(owner, pos);
    s.stakes.set(roundId, inner);
    rd.totalStakeRaw += amount;
    if (isNew) {
        rd.stakerCount += 1;
    }
    s.rounds.set(roundId, rd);
    s.save();
    emitExternalEvent(DepositAccepted { roundId, owner, amountRaw: amount, totalAcceptedStakeRaw: rd.totalStakeRaw });
}

// Instant refund paid by the deposit's own forward TON. Without enough TON the
// amount is credited to the refund ledger (round 0) if it is at least minStake;
// smaller dust without TON is kept (keeps storage bounded; documented behaviour).
fun refundDeposit(mutate s: Storage, wallet: address, owner: address, amount: uint128, valueCoins: coins, minStake: uint128) {
    if (valueCoins >= MIN_REFUND_VALUE && owner.getWorkchain() == BASECHAIN) {
        sendWithInboundValue(wallet, buildJettonTransferBody(REFUND_QUERY_TAG, amount as coins, owner, owner));
        emitExternalEvent(DepositRefunded { owner, amountRaw: amount, instant: true, recorded: true });
        return;
    }
    if (amount < minStake) {
        emitExternalEvent(DepositRefunded { owner, amountRaw: amount, instant: false, recorded: false });
        return;
    }
    var ledger = stakesOf(s, 0);
    val prev = ledger.get(owner);
    var pos = prev.isFound ? prev.loadValue() : StakePosition { amountRaw: 0, lastDepositNonce: 0, claimed: false };
    pos.amountRaw += amount;
    ledger.set(owner, pos);
    s.stakes.set(0, ledger);
    s.save();
    emitExternalEvent(DepositRefunded { owner, amountRaw: amount, instant: false, recorded: true });
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

    rd.status = STATUS_STAKING_OPEN;
    rd.targetTier = tier;
    rd.targetPriceUsdE8 = target;
    rd.targetTwap24hUsdE8 = msg.twap24hUsdE8;
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

    rd.candleHash = beginCell()
        .storeUint(rd.candleHash, 256)
        .storeUint(msg.candleIndex, 8)
        .storeUint(msg.twapPriceUsdE8, 128)
        .storeUint(msg.dataDigest, 256)
        .endCell()
        .hash();
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
        candleHash: rd.candleHash,
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
    var rewardBurn: uint128 = 0;
    var teamBurn: uint128 = 0;
    var principalBurn: uint128 = 0;
    var teamReleased: uint128 = 0;

    if (success) {
        rd.status = STATUS_SUCCEEDED;
        s.successCount += 1;
        teamReleased = e.teamRoundRaw;
        if (rd.totalStakeRaw == 0) {
            rewardBurn = e.roundRewardRaw; // D-18b: nobody to pay -> burn the reward
        }
    } else {
        rd.status = STATUS_FAILED_PERMANENT;
        rewardBurn = e.roundRewardRaw;
        teamBurn = e.teamRoundRaw;
        principalBurn = rd.totalStakeRaw;
    }
    rd.settledAt = now;
    if (teamReleased > 0) {
        rd.actionsSent = rd.actionsSent | ACTION_TEAM_TRANSFER;
        sendTeamTransfer(wallet, roundId, teamReleased, a.teamWallet);
    }
    val burnTotal: uint128 = rewardBurn + teamBurn + principalBurn;
    if (burnTotal > 0) {
        rd.actionsSent = rd.actionsSent | ACTION_BURN;
        sendBurn(wallet, roundId, burnTotal);
    }
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
    });
}

fun sendTeamTransfer(wallet: address, roundId: uint8, amount: uint128, teamWallet: address) {
    sendFromBalance(wallet, buildJettonTransferBody(settleQueryId(roundId, ACTION_TEAM_TRANSFER), amount as coins, teamWallet, contract.getAddress()));
}

fun sendBurn(wallet: address, roundId: uint8, amount: uint128) {
    sendFromBalance(wallet, buildJettonBurnBody(settleQueryId(roundId, ACTION_BURN), amount as coins, contract.getAddress()));
}

// The burn amount is recomputed from round state, never stored.
fun burnAmountOf(rd: RoundData, e: ProtocolEcon): uint128 {
    if (rd.status == STATUS_FAILED_PERMANENT) {
        return e.roundRewardRaw + e.teamRoundRaw + rd.totalStakeRaw;
    }
    if (rd.status == STATUS_SUCCEEDED && rd.totalStakeRaw == 0) {
        return e.roundRewardRaw;
    }
    return 0;
}

fun handleRetrySettlement(roundId: uint8, valueCoins: coins) {
    assert (valueCoins >= MIN_RETRY_VALUE) throw Errors.NotEnoughValue;
    var s = lazy Storage.load();
    val rr = s.rounds.get(roundId);
    assert (roundId >= 1 && rr.isFound) throw Errors.BadRoundId;
    var rd = rr.loadValue();
    assert (rd.retryMask != 0) throw Errors.NothingToRetry;
    val e = econ(s);
    val wallet = ownWallet(s);
    if ((rd.retryMask & ACTION_TEAM_TRANSFER) != 0) {
        sendTeamTransfer(wallet, roundId, e.teamRoundRaw, addresses(s).teamWallet);
    }
    if ((rd.retryMask & ACTION_BURN) != 0) {
        sendBurn(wallet, roundId, burnAmountOf(rd, e));
    }
    rd.retryMask = 0;
    s.rounds.set(roundId, rd);
    s.save();
}

// Liveness escape (anyone):
//   * current round still STAKING_OPEN/OBSERVING abortTimeout after its expected end
//   * next round still PREVIEW abortTimeout after its staking should have opened
// Principal becomes claimable; nothing is burned; the tier is not consumed.
fun handleAbortTechnical() {
    var s = lazy Storage.load();
    val now = now64();
    val t = timing(s);
    var roundId = s.currentRoundId;
    assert (roundId >= 1) throw Errors.BadRoundId;
    var rd = s.rounds.get(roundId).loadValue();
    val timeout = t.abortTimeoutSeconds as uint64;
    var reason: uint8 = 0;

    if ((rd.status == STATUS_STAKING_OPEN || rd.status == STATUS_OBSERVING) &&
        now >= rd.stakeCloseAt + observationSeconds(t) + timeout) {
        reason = ABORT_REASON_OBSERVATION_TIMEOUT;
    } else if (isSettled(rd.status) && roundId < MAX_ROUNDS) {
        val nr = s.rounds.get(roundId + 1);
        if (nr.isFound) {
            val next = nr.loadValue();
            if (next.status == STATUS_PREVIEW && now >= next.stakeOpenAt + timeout) {
                roundId += 1;
                rd = next;
                reason = ABORT_REASON_PREVIEW_TIMEOUT;
            }
        }
    }
    assert (reason != 0) throw Errors.TooEarly;

    rd.status = STATUS_TECHNICAL_ABORTED;
    rd.settledAt = now;
    s.currentRoundId = roundId;
    s.rounds.set(roundId, rd);
    if (roundId < MAX_ROUNDS) {
        s.rounds.set(roundId + 1, previewRound(now + (t.previewSeconds as uint64)));
    }
    s.save();
    emitExternalEvent(TechnicalAborted { roundId, reason, at: now });
}

// ===========================================================================
// Claims: principal + reward in one go, paid by the claimant's TON.
// ===========================================================================

struct ClaimResult {
    principal: uint128
    reward: uint128
    mask: uint16
}

// Marks one round's position as claimed and returns what it pays; zero if nothing.
fun takeRound(mutate s: Storage, roundId: uint8, owner: address, rewardBudget: uint128): ClaimResult {
    val none = ClaimResult { principal: 0, reward: 0, mask: 0 };
    var claimable = roundId == 0;
    var rd = emptyRound();
    if (roundId != 0) {
        val rr = s.rounds.get(roundId);
        if (!rr.isFound) {
            return none;
        }
        rd = rr.loadValue();
        claimable = rd.status == STATUS_SUCCEEDED || rd.status == STATUS_TECHNICAL_ABORTED;
    }
    if (!claimable) {
        return none;
    }
    var inner = stakesOf(s, roundId);
    val found = inner.get(owner);
    if (!found.isFound) {
        return none;
    }
    var pos = found.loadValue();
    if (pos.claimed || pos.amountRaw == 0) {
        return none;
    }
    val reward = roundId == 0 ? 0 as uint128 : rewardOf(rd, rewardBudget, pos.amountRaw);
    if (roundId == 0) {
        inner.delete(owner); // refund ledger entries are removed once paid
    } else {
        pos.claimed = true;
        inner.set(owner, pos);
    }
    s.stakes.set(roundId, inner);
    return { principal: pos.amountRaw, reward, mask: maskBit(roundId) };
}

fun handleClaim(sender: address, roundId: uint8, all: bool, valueCoins: coins) {
    assert (valueCoins >= MIN_CLAIM_VALUE) throw Errors.NotEnoughValue;
    assert (sender.getWorkchain() == BASECHAIN) throw Errors.WrongWorkchain;
    assert (roundId <= MAX_ROUNDS) throw Errors.BadRoundId;
    var s = lazy Storage.load();
    val budget = econ(s).roundRewardRaw;

    var principal: uint128 = 0;
    var reward: uint128 = 0;
    var mask: uint16 = 0;
    var r: uint8 = all ? 0 : roundId;
    val last: uint8 = all ? MAX_ROUNDS : roundId;
    while (r <= last) {
        val res = takeRound(mutate s, r, sender, budget);
        principal += res.principal;
        reward += res.reward;
        mask = mask | res.mask;
        r += 1;
    }
    assert (mask != 0) throw Errors.NothingToClaim;
    s.save();

    sendWithInboundValue(ownWallet(s), buildJettonTransferBody(CLAIM_QUERY_TAG, (principal + reward) as coins, sender, sender));
    emitExternalEvent(Claimed { owner: sender, roundsMask: mask, principalRaw: principal, rewardRaw: reward });
}

// ===========================================================================
// Get methods (v8.9-compatible shapes)
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
        maxStakePerAddressBps: (e.maxStakePerAddressRaw * 10000 / e.maxTotalStakeRaw) as uint16,
        maxTotalStakeRaw: e.maxTotalStakeRaw,
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

get fun get_jetton_wallet_address(): address {
    val s = lazy Storage.load();
    return ownWallet(s);
}

get fun get_jetton_wallet_code_hash(): uint256 {
    val s = lazy Storage.load();
    return cfg(s).jettonWalletCode.hash();
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
    val e = econ(s);
    val t = timing(s);
    val opened = rd.status != STATUS_UNOPENED && rd.status != STATUS_PREVIEW;
    val teamOk = (rd.actionsSent & ACTION_TEAM_TRANSFER) != 0 && (rd.retryMask & ACTION_TEAM_TRANSFER) == 0;
    val burnOk = (rd.actionsSent & ACTION_BURN) != 0 && (rd.retryMask & ACTION_BURN) == 0;
    val failed = rd.status == STATUS_FAILED_PERMANENT;
    return {
        roundId,
        status: rd.status,
        targetTier: rd.targetTier,
        targetPriceUsdE8: rd.targetPriceUsdE8,
        targetTwap24hUsdE8: rd.targetTwap24hUsdE8,
        targetWrittenAt: opened ? rd.stakeOpenAt : 0,
        rewardBudgetRaw: rd.status == STATUS_UNOPENED ? 0 as uint128 : e.roundRewardRaw,
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
        candleHash: rd.candleHash,
        totalWeight: rd.totalStakeRaw,
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

get fun get_round_staker_count(roundId: uint8): uint16 {
    val s = lazy Storage.load();
    val found = s.rounds.get(roundId);
    return found.isFound ? found.loadValue().stakerCount : 0;
}

get fun get_user_stake(roundId: uint8, owner: address): StakePositionView {
    val s = lazy Storage.load();
    val found = stakesOf(s, roundId).get(owner);
    val pos = found.isFound ? found.loadValue() : StakePosition { amountRaw: 0, lastDepositNonce: 0, claimed: false };
    return {
        amountRaw: pos.amountRaw,
        lastDepositNonce: pos.lastDepositNonce,
        principalClaimed: pos.claimed,
        rewardClaimed: pos.claimed,
        weight: pos.amountRaw,
        rewardState: 0,
    };
}

get fun get_user_reward_estimate(roundId: uint8, owner: address): uint128 {
    val s = lazy Storage.load();
    val rr = s.rounds.get(roundId);
    if (!rr.isFound) {
        return 0;
    }
    val found = stakesOf(s, roundId).get(owner);
    if (!found.isFound) {
        return 0;
    }
    return rewardOf(rr.loadValue(), econ(s).roundRewardRaw, found.loadValue().amountRaw);
}

// Everything ClaimAll would pay right now (roundsMask: bit r-1 = round r, bit 15 = refunds).
get fun get_claimable_all(owner: address): Claimable {
    var s = lazy Storage.load();
    val budget = econ(s).roundRewardRaw;
    var principal: uint128 = 0;
    var reward: uint128 = 0;
    var mask: uint16 = 0;
    var r: uint8 = 0;
    while (r <= MAX_ROUNDS) {
        val res = takeRound(mutate s, r, owner, budget); // local copy only; never saved
        principal += res.principal;
        reward += res.reward;
        mask = mask | res.mask;
        r += 1;
    }
    return { principalRaw: principal, rewardRaw: reward, roundsMask: mask };
}
