// P0 security-fix tests (task-22): permissions, real burn confirmation, claim rollback.
//
// Run: acton test tests/p0-fixes.test.tolk

import "@acton/emulation/network"
import "@acton/emulation/testing"
import "@acton/testing/expect"

import "@contracts/constants"
import "@contracts/types"
import "test-utils"

const AMOUNT: coins = 100000000000000; // 100,000 A9
const REWARD_RAW: uint128 = 700000000000000000;

fun openF(f: ProtocolFixture) {
    expect(openRound(f.rc, f.admin, 0)).toHaveSuccessfulTx<OpenRound>({
        from: f.admin,
        to: f.rc.address,
    });
}

fun openNext(f: ProtocolFixture) {
    advance((PREVIEW_SECONDS as int) + 1);
    openF(f);
}

fun stakeAccount(f: ProtocolFixture, roundId: uint8, owner: address, nonce: uint64) {
    expect(sendStake(f.rc, f.rcWallet.address, owner, AMOUNT, buildStakePayload(roundId, nonce, 1, 1)))
        .toHaveSuccessfulTx<TransferNotification>({
            from: f.rcWallet.address,
            to: f.rc.address,
        });
}

fun finishRound(f: ProtocolFixture, roundId: uint8, qualified: uint8) {
    advance(STAKE_DURATION_SECONDS as int);
    expect(closeStaking(f.rc, f.admin, 0)).toHaveSuccessfulTx<CloseStaking>({
        from: f.admin,
        to: f.rc.address,
    });
    expect(startObservation(f.rc, f.keeper.address, roundId)).toHaveSuccessfulTx<StartObservation>({
        from: f.keeper.address,
        to: f.rc.address,
    });
    submitAllCandles(f.rc, f.keeper.address, roundId, qualified, rcRound(f.rc, roundId).targetPriceUsdE8);
}

fun finishSuccess(f: ProtocolFixture, roundId: uint8) {
    finishRound(f, roundId, 16);
    expect(finalizeRound(f.rc, f.keeper.address, roundId)).toHaveSuccessfulTx<FinalizeRound>({
        from: f.keeper.address,
        to: f.rc.address,
    });
}

fun claimCounter(f: ProtocolFixture): uint64 {
    return net.runGetMethod<uint64>(f.rc.address, "get_claim_counter");
}

fun hasPending(f: ProtocolFixture, queryId: uint64): bool {
    return net.runGetMethod<bool>(f.rc.address, "has_pending_claim", [queryId]);
}

fun sendReturnExcesses(f: ProtocolFixture, from: address, queryId: uint64): SendResultList {
    return net.send(from, createMessage({
        bounce: true,
        value: ton("0.1"),
        dest: f.rc.address,
        body: ReturnExcessesBack { queryId },
    }));
}

// Simulates the claim transfer bouncing back from the RC Jetton Wallet.
fun bounceClaim(f: ProtocolFixture, queryId: uint64) {
    val body = beginCell()
        .storeUint(0xFFFFFFFF, 32) // bounced prefix
        .storeUint(OP_JETTON_TRANSFER, 32)
        .storeUint(queryId, 64)
        .endCell();
    val msg = createMessage({
        bounce: false,
        value: ton("0.1"),
        dest: f.rc.address,
        body,
    }).bounced();
    testing.processSingleTraceStep(f.rcWallet.address, msg);
}

fun claimQ(roundId: uint8, kind: uint8, counter: uint64): uint64 {
    return ((roundId as uint64) << 32) | ((kind as uint64) << 24) | counter;
}

fun burnQ(roundId: uint8, kind: uint8): uint64 {
    return ((roundId as uint64) << 16) | ((kind as uint64) << 8);
}

// ===========================================================================
// P0-1: CloseStaking / SubmitCandle must be admin-or-oracle only
// ===========================================================================

get fun `test P0-1 submit candle from an unauthorized address is rejected`() {
    val f = setupProtocol();
    val outsider = f.teamWallet;
    openF(f);
    advance(STAKE_DURATION_SECONDS as int);
    expect(closeStaking(f.rc, f.admin, 0)).toHaveSuccessfulTx<CloseStaking>({
        from: f.admin,
        to: f.rc.address,
    });
    expect(startObservation(f.rc, f.keeper.address, 1)).toHaveSuccessfulTx<StartObservation>({
        from: f.keeper.address,
        to: f.rc.address,
    });
    val start = rcRound(f.rc, 1).observationStart;
    // outsider: must fail before touching the candle ledger
    val bad = net.send(outsider, createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: f.rc.address,
        body: SubmitCandle {
            queryId: 0,
            roundId: 1,
            candleIndex: 0,
            periodStart: start as uint32,
            periodEnd: (start + 3600) as uint32,
            twapPriceUsdE8: 300000 as uint128,
            dataDigest: 1 as uint256,
        },
    }));
    expect(bad).toHaveFailedTx<SubmitCandle>({
        from: outsider,
        to: f.rc.address,
        exitCode: Errors.NotOracle,
    });
    expect(rcRound(f.rc, 1).candlesSeen).toEqual(0);

    // admin is allowed
    expect(submitCandle(f.rc, f.admin, 1, 0, 300000)).toHaveSuccessfulTx<SubmitCandle>({
        from: f.admin,
        to: f.rc.address,
    });
    expect(rcRound(f.rc, 1).candlesSeen).toEqual(1);
}

get fun `test P0-1 close staking from an unauthorized address is rejected`() {
    val f = setupProtocol();
    val outsider = f.teamWallet;
    openF(f);
    val target = rcRound(f.rc, 1).targetPriceUsdE8;
    advance(600);
    expect(closeStaking(f.rc, outsider, target)).toHaveFailedTx<CloseStaking>({
        from: outsider,
        to: f.rc.address,
        exitCode: Errors.NotOracle,
    });
    expect(rcStatus(f.rc, 1)).toEqual(STATUS_STAKING_OPEN);
    expect(closeStaking(f.rc, f.admin, target)).toHaveSuccessfulTx<CloseStaking>({
        from: f.admin,
        to: f.rc.address,
    });
    expect(rcStatus(f.rc, 1)).toEqual(STATUS_STAKING_CLOSED);
}

// ===========================================================================
// P0-2: real Jetton Master burn confirmation via ReturnExcessesBack
// ===========================================================================

fun prepareFailure(f: ProtocolFixture): uint8 {
    openF(f);
    stakeAccount(f, 1, testing.treasury("p0-alice").address, 1);
    finishRound(f, 1, 15);
    confirmTeamBurn(f, 1);
    expect(rcStatus(f.rc, 1)).toEqual(STATUS_SETTLING_FAILURE);
    return 1;
}

get fun `test P0-2 failed round confirms burns via ReturnExcessesBack from Jetton Master`() {
    val f = setupProtocol();
    val roundId = prepareFailure(f);

    expect(sendReturnExcesses(f, f.jettonMaster, burnQ(roundId, BURN_QUERY_REWARD)))
        .toHaveSuccessfulTx<ReturnExcessesBack>({ from: f.jettonMaster, to: f.rc.address });
    expect(sendReturnExcesses(f, f.jettonMaster, burnQ(roundId, BURN_QUERY_PRINCIPAL)))
        .toHaveSuccessfulTx<ReturnExcessesBack>({ from: f.jettonMaster, to: f.rc.address });

    val burn = burnStatus(f.rc, roundId);
    expect(burn.rewardBurnConfirmed).toBeTrue();
    expect(burn.principalBurnConfirmed).toBeTrue();
    expect(burn.teamBurnConfirmed).toBeTrue();

    expect(finalizeRound(f.rc, f.keeper.address, roundId)).toHaveSuccessfulTx<FinalizeRound>({
        from: f.keeper.address,
        to: f.rc.address,
    });
    expect(rcStatus(f.rc, roundId)).toEqual(STATUS_FAILED_PERMANENT);
}

get fun `test P0-2 ReturnExcessesBack from a wrong sender or wrong round does not confirm`() {
    val f = setupProtocol();
    val roundId = prepareFailure(f);
    val attacker = testing.treasury("p0-attacker");

    expect(sendReturnExcesses(f, attacker.address, burnQ(roundId, BURN_QUERY_REWARD)))
        .toHaveFailedTx<ReturnExcessesBack>({
            from: attacker.address,
            to: f.rc.address,
            exitCode: Errors.NotJettonMaster,
        });
    // wrong round encoded -> BadRoundId
    expect(sendReturnExcesses(f, f.jettonMaster, burnQ(2, BURN_QUERY_REWARD)))
        .toHaveFailedTx<ReturnExcessesBack>({
            from: f.jettonMaster,
            to: f.rc.address,
            exitCode: Errors.BadRoundId,
        });
    val burn = burnStatus(f.rc, roundId);
    expect(burn.rewardBurnConfirmed).toBeFalse();
    expect(burn.principalBurnConfirmed).toBeFalse();
}

// ===========================================================================
// P0-3: claim bounce rollback
// ===========================================================================

get fun `test P0-3 bounced ClaimPrincipal rolls back and can be retried`() {
    val f = setupProtocol();
    val alice = testing.treasury("p0-alice");
    openF(f);
    stakeAccount(f, 1, alice.address, 1);
    finishSuccess(f, 1);

    val q = claimQ(1, CLAIM_KIND_PRINCIPAL, claimCounter(f));
    expect(claimPrincipal(f.rc, alice.address, 1)).toHaveSuccessfulTx<ClaimPrincipal>({
        from: alice.address,
        to: f.rc.address,
    });
    expect(rcUserStake(f.rc, 1, alice.address).principalClaimed).toBeTrue();
    expect(hasPending(f, q)).toBeTrue();

    bounceClaim(f, q);
    expect(rcUserStake(f.rc, 1, alice.address).principalClaimed).toBeFalse();
    expect(hasPending(f, q)).toBeFalse();

    // retry succeeds
    expect(claimPrincipal(f.rc, alice.address, 1)).toHaveSuccessfulTx<ClaimPrincipal>({
        from: alice.address,
        to: f.rc.address,
    });
}

get fun `test P0-3 bounced ClaimReward rolls back state and locked amount`() {
    val f = setupProtocol();
    val alice = testing.treasury("p0-alice");
    openF(f);
    stakeAccount(f, 1, alice.address, 1);
    finishSuccess(f, 1);

    val q = claimQ(1, CLAIM_KIND_REWARD, claimCounter(f));
    expect(claimReward(f.rc, alice.address, 1)).toHaveSuccessfulTx<ClaimReward>({
        from: alice.address,
        to: f.rc.address,
    });
    expect(rcRewardState(f.rc, alice.address, 1).state).toEqual(REWARD_STATE_EARLY);
    expect(rcUnlockInfo(f.rc, alice.address).totalLockedRaw).toEqual(REWARD_RAW / 2);

    bounceClaim(f, q);
    val state = rcRewardState(f.rc, alice.address, 1);
    expect(state.state).toEqual(REWARD_STATE_PENDING);
    expect(rcUserStake(f.rc, 1, alice.address).rewardClaimed).toBeFalse();
    // reward is PENDING again, so it is back in the unlock info (700M)
    expect(rcUnlockInfo(f.rc, alice.address).totalLockedRaw).toEqual(REWARD_RAW);
}

get fun `test P0-3 bounced ClaimAll rolls back principal and reward`() {
    val f = setupProtocol();
    val alice = testing.treasury("p0-alice");
    openF(f);
    stakeAccount(f, 1, alice.address, 1);
    finishSuccess(f, 1);

    val q = claimQ(1, CLAIM_KIND_CLAIM_ALL, claimCounter(f));
    expect(claimAll(f.rc, alice.address, 0)).toHaveSuccessfulTx<ClaimAll>({
        from: alice.address,
        to: f.rc.address,
    });
    expect(rcUserStake(f.rc, 1, alice.address).principalClaimed).toBeTrue();
    expect(rcUserStake(f.rc, 1, alice.address).rewardClaimed).toBeTrue();

    bounceClaim(f, q);
    val pos = rcUserStake(f.rc, 1, alice.address);
    expect(pos.principalClaimed).toBeFalse();
    expect(pos.rewardClaimed).toBeFalse();
    expect(rcRewardState(f.rc, alice.address, 1).state).toEqual(REWARD_STATE_PENDING);
    expect(rcUnlockInfo(f.rc, alice.address).totalLockedRaw).toEqual(REWARD_RAW);
}

get fun `test P0-3 wallet ReturnExcessesBack clears the pending claim (success path)`() {
    val f = setupProtocol();
    val alice = testing.treasury("p0-alice");
    openF(f);
    stakeAccount(f, 1, alice.address, 1);
    finishSuccess(f, 1);

    val q = claimQ(1, CLAIM_KIND_PRINCIPAL, claimCounter(f));
    expect(claimPrincipal(f.rc, alice.address, 1)).toHaveSuccessfulTx<ClaimPrincipal>({
        from: alice.address,
        to: f.rc.address,
    });
    expect(hasPending(f, q)).toBeTrue();
    expect(sendReturnExcesses(f, f.rcWallet.address, q)).toHaveSuccessfulTx<ReturnExcessesBack>({
        from: f.rcWallet.address,
        to: f.rc.address,
    });
    expect(hasPending(f, q)).toBeFalse();
    expect(rcUserStake(f.rc, 1, alice.address).principalClaimed).toBeTrue();
}

get fun `test P0-3 bounced ClaimUnlocked rolls back claimed amount and folded rewards`() {
    val f = setupProtocol();
    val alice = testing.treasury("p0-alice");
    openF(f);
    var r: uint8 = 1;
    while (r <= 10) {
        if (r > 1) {
            openNext(f);
        }
        stakeAccount(f, r, alice.address, 1);
        finishSuccess(f, r);
        r += 1;
    }
    val lockedBefore = rcUnlockInfo(f.rc, alice.address).totalLockedRaw;
    expect(lockedBefore).toEqual(REWARD_RAW * 10);

    topUpForTimeJump(f, ton("500"));
    advance(2592000); // one month -> 1/12 vested
    val q = claimQ(10, CLAIM_KIND_UNLOCK, claimCounter(f));
    expect(claimUnlocked(f.rc, alice.address)).toHaveSuccessfulTx<ClaimUnlocked>({
        from: alice.address,
        to: f.rc.address,
    });
    expect(rcUnlockInfo(f.rc, alice.address).claimedRaw > 0).toBeTrue();
    expect(hasPending(f, q)).toBeTrue();

    bounceClaim(f, q);
    val info = rcUnlockInfo(f.rc, alice.address);
    expect(info.claimedRaw).toEqual(0 as uint128);
    expect(info.totalLockedRaw).toEqual(lockedBefore);
    // pending reward positions are claimable again through the unlock pool
    expect(info.claimableRaw > 0).toBeTrue();
}
