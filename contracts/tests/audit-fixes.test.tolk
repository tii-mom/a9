// Audit fixes F-01..F-06 regression tests (task-24).
import "@acton/emulation/network"
import "@acton/emulation/testing"
import "@acton/testing/expect"

import "@contracts/constants"
import "@contracts/types"
import "test-utils"

const AMOUNT: coins = 100000000000000;
const REWARD_RAW: uint128 = 700000000000000000;
const MAX_PER_ADDR: coins = 20000000000000000;

fun openF(f: ProtocolFixture) {
    expect(openRound(f.rc, f.admin, 0)).toHaveSuccessfulTx<OpenRound>({ from: f.admin, to: f.rc.address });
}
fun openNext(f: ProtocolFixture) {
    advance((PREVIEW_SECONDS as int) + 1);
    openF(f);
}
fun stakeAccount(f: ProtocolFixture, roundId: uint8, owner: address, nonce: uint64) {
    expect(sendStake(f.rc, f.rcWallet.address, owner, AMOUNT, buildStakePayload(roundId, nonce, 1, 1)))
        .toHaveSuccessfulTx<TransferNotification>({ from: f.rcWallet.address, to: f.rc.address });
}
fun stakeWith(f: ProtocolFixture, roundId: uint8, owner: address, amount: coins, nonce: uint64) {
    expect(sendStake(f.rc, f.rcWallet.address, owner, amount, buildStakePayload(roundId, nonce, 1, 1)))
        .toHaveSuccessfulTx<TransferNotification>({ from: f.rcWallet.address, to: f.rc.address });
}
fun finishSuccess(f: ProtocolFixture, roundId: uint8) {
    advance(STAKE_DURATION_SECONDS as int);
    expect(closeStaking(f.rc, f.admin, 0)).toHaveSuccessfulTx<CloseStaking>({ from: f.admin, to: f.rc.address });
    expect(startObservation(f.rc, f.keeper.address, roundId)).toHaveSuccessfulTx<StartObservation>({ from: f.keeper.address, to: f.rc.address });
    submitAllCandles(f.rc, f.keeper.address, roundId, 16, rcRound(f.rc, roundId).targetPriceUsdE8);
    expect(finalizeRound(f.rc, f.keeper.address, roundId)).toHaveSuccessfulTx<FinalizeRound>({ from: f.keeper.address, to: f.rc.address });
}
fun finishFailure(f: ProtocolFixture, roundId: uint8) {
    advance(STAKE_DURATION_SECONDS as int);
    expect(closeStaking(f.rc, f.admin, 0)).toHaveSuccessfulTx<CloseStaking>({ from: f.admin, to: f.rc.address });
    expect(startObservation(f.rc, f.keeper.address, roundId)).toHaveSuccessfulTx<StartObservation>({ from: f.keeper.address, to: f.rc.address });
    submitAllCandles(f.rc, f.keeper.address, roundId, 15, rcRound(f.rc, roundId).targetPriceUsdE8);
    confirmTeamBurn(f, roundId);
}
fun claimCounter(f: ProtocolFixture): uint64 {
    return net.runGetMethod<uint64>(f.rc.address, "get_claim_counter");
}
fun claimQ(roundId: uint8, kind: uint8, counter: uint64): uint64 {
    return ((roundId as uint64) << 32) | ((kind as uint64) << 24) | counter;
}
fun burnQ(roundId: uint8, kind: uint8): uint64 {
    return ((roundId as uint64) << 16) | ((kind as uint64) << 8);
}
fun sendReturnExcesses(f: ProtocolFixture, from: address, queryId: uint64): SendResultList {
    return net.send(from, createMessage({
        bounce: true,
        value: ton("0.1"),
        dest: f.rc.address,
        body: ReturnExcessesBack { queryId },
    }));
}
fun bounceClaim(f: ProtocolFixture, queryId: uint64) {
    val body = beginCell().storeUint(0xFFFFFFFF, 32).storeUint(OP_JETTON_TRANSFER, 32).storeUint(queryId, 64).endCell();
    val msg = createMessage({ bounce: false, value: ton("0.1"), dest: f.rc.address, body }).bounced();
    testing.processSingleTraceStep(f.rcWallet.address, msg);
}
fun bounceBurn(f: ProtocolFixture, queryId: uint64) {
    val body = beginCell().storeUint(0xFFFFFFFF, 32).storeUint(OP_JETTON_BURN, 32).storeUint(queryId, 64).endCell();
    val msg = createMessage({ bounce: false, value: ton("0.1"), dest: f.rc.address, body }).bounced();
    testing.processSingleTraceStep(f.rcWallet.address, msg);
}
fun runTen(f: ProtocolFixture, alice: Treasury) {
    openF(f);
    var r: uint8 = 1;
    while (r <= 10) {
        if (r > 1) { openNext(f); }
        stakeAccount(f, r, alice.address, 1);
        finishSuccess(f, r);
        r += 1;
    }
}

// ============================== F-01 ==============================

get fun `test F-01 unlock double-bounce cannot inflate locked pool`() {
    val f = setupProtocol();
    val alice = testing.treasury("f01-alice");
    runTen(f, alice);
    val lockedBefore = rcUnlockInfo(f.rc, alice.address).totalLockedRaw;
    expect(lockedBefore).toEqual(REWARD_RAW * 10);
    topUpForTimeJump(f, ton("500"));
    advance(2592000);

    setMockAutoAck(f.rcWallet, false);
    val q1 = claimQ(10, CLAIM_KIND_UNLOCK, claimCounter(f));
    expect(claimUnlocked(f.rc, alice.address)).toHaveSuccessfulTx<ClaimUnlocked>({ from: alice.address, to: f.rc.address });
    // per-owner pending mutex: no second in-flight unlock
    expect(claimUnlocked(f.rc, alice.address)).toHaveFailedTx<ClaimUnlocked>({
        from: alice.address, to: f.rc.address, exitCode: Errors.ClaimPending,
    });

    bounceClaim(f, q1);
    // audit path: rollback restores PENDING stakes and must keep total locked == F
    expect(rcUnlockInfo(f.rc, alice.address).totalLockedRaw).toEqual(lockedBefore);
    expect(rcUnlockInfo(f.rc, alice.address).claimedRaw).toEqual(0 as uint128);
    // fold once more: still F, never 2F
    expect(claimUnlocked(f.rc, alice.address)).toHaveSuccessfulTx<ClaimUnlocked>({ from: alice.address, to: f.rc.address });
    expect(rcUnlockInfo(f.rc, alice.address).totalLockedRaw).toEqual(lockedBefore);
}

get fun `test F-01 pending claim blocks a second claim and roll`() {
    val f = setupProtocol();
    val alice = testing.treasury("f01-alice");
    openF(f);
    stakeAccount(f, 1, alice.address, 1);
    finishSuccess(f, 1);

    setMockAutoAck(f.rcWallet, false);
    expect(claimPrincipal(f.rc, alice.address, 1)).toHaveSuccessfulTx<ClaimPrincipal>({ from: alice.address, to: f.rc.address });
    expect(claimReward(f.rc, alice.address, 1)).toHaveFailedTx<ClaimReward>({
        from: alice.address, to: f.rc.address, exitCode: Errors.ClaimPending,
    });
    openNext(f);
    expect(rollReward(f.rc, alice.address, 1)).toHaveFailedTx<RollReward>({
        from: alice.address, to: f.rc.address, exitCode: Errors.ClaimPending,
    });
}

// ============================== F-02 ==============================

get fun `test F-02 retried reward burn uses canonical queryId and confirms`() {
    val f = setupProtocol();
    val alice = testing.treasury("f02-alice");
    openF(f);
    stakeAccount(f, 1, alice.address, 1);
    finishFailure(f, 1);
    expect(mockState(f.rcWallet).burnCount).toEqual(2);

    bounceBurn(f, burnQ(1, BURN_QUERY_REWARD));
    expect(retryPendingActions(f.rc, f.admin, 1)).toHaveSuccessfulTx<RetryPendingActions>({ from: f.admin, to: f.rc.address });
    expect(mockState(f.rcWallet).burnCount).toEqual(3);
    // canonical queryId is required for the master confirmation to land
    expect(sendReturnExcesses(f, f.jettonMaster, burnQ(1, BURN_QUERY_REWARD)))
        .toHaveSuccessfulTx<ReturnExcessesBack>({ from: f.jettonMaster, to: f.rc.address });
    expect(burnStatus(f.rc, 1).rewardBurnConfirmed).toBeTrue();
}

get fun `test F-02 retried principal burn uses canonical queryId and confirms`() {
    val f = setupProtocol();
    val alice = testing.treasury("f02-alice");
    openF(f);
    stakeAccount(f, 1, alice.address, 1);
    finishFailure(f, 1);

    bounceBurn(f, burnQ(1, BURN_QUERY_PRINCIPAL));
    expect(retryPendingActions(f.rc, f.admin, 1)).toHaveSuccessfulTx<RetryPendingActions>({ from: f.admin, to: f.rc.address });
    expect(sendReturnExcesses(f, f.jettonMaster, burnQ(1, BURN_QUERY_PRINCIPAL)))
        .toHaveSuccessfulTx<ReturnExcessesBack>({ from: f.jettonMaster, to: f.rc.address });
    expect(burnStatus(f.rc, 1).principalBurnConfirmed).toBeTrue();
}

// ============================== F-03 ==============================

get fun `test F-03 retry does not resend in-flight burns`() {
    val f = setupProtocol();
    val alice = testing.treasury("f03-alice");
    openF(f);
    stakeAccount(f, 1, alice.address, 1);
    finishFailure(f, 1);
    expect(mockState(f.rcWallet).burnCount).toEqual(2);
    expect(retryPendingActions(f.rc, f.admin, 1)).toHaveSuccessfulTx<RetryPendingActions>({ from: f.admin, to: f.rc.address });
    expect(mockState(f.rcWallet).burnCount).toEqual(2);
}

get fun `test F-03 burn bounce clears dispatched and allows exactly one resend`() {
    val f = setupProtocol();
    val alice = testing.treasury("f03-alice");
    openF(f);
    stakeAccount(f, 1, alice.address, 1);
    finishFailure(f, 1);

    bounceBurn(f, burnQ(1, BURN_QUERY_REWARD));
    bounceBurn(f, burnQ(1, BURN_QUERY_PRINCIPAL));
    expect(retryPendingActions(f.rc, f.admin, 1)).toHaveSuccessfulTx<RetryPendingActions>({ from: f.admin, to: f.rc.address });
    expect(mockState(f.rcWallet).burnCount).toEqual(4);
    // dispatched again -> another retry must not double-burn
    expect(retryPendingActions(f.rc, f.admin, 1)).toHaveSuccessfulTx<RetryPendingActions>({ from: f.admin, to: f.rc.address });
    expect(mockState(f.rcWallet).burnCount).toEqual(4);
}

// ============================== F-04 ==============================

get fun `test F-04 burn carries 0.1 TON for the confirmation hop`() {
    val f = setupProtocol();
    val alice = testing.treasury("f04-alice");
    openF(f);
    stakeAccount(f, 1, alice.address, 1);
    advance(STAKE_DURATION_SECONDS as int);
    expect(closeStaking(f.rc, f.admin, 0)).toHaveSuccessfulTx<CloseStaking>({ from: f.admin, to: f.rc.address });
    expect(startObservation(f.rc, f.keeper.address, 1)).toHaveSuccessfulTx<StartObservation>({ from: f.keeper.address, to: f.rc.address });
    val before = testing.getAccountBalance(f.rcWallet.address);
    submitAllCandles(f.rc, f.keeper.address, 1, 15, rcRound(f.rc, 1).targetPriceUsdE8);
    val delta = testing.getAccountBalance(f.rcWallet.address) - before;
    // two burns x 0.1 TON (minus storage) must arrive at the wallet
    expect(delta > ton("0.15")).toBeTrue();
}

// ============================== F-05 ==============================

get fun `test F-05 zero-room roll keeps PENDING and early-claim right`() {
    val f = setupProtocol();
    val alice = testing.treasury("f05-alice");
    openF(f);
    stakeAccount(f, 1, alice.address, 1);
    finishSuccess(f, 1);
    openNext(f);
    stakeWith(f, 2, alice.address, MAX_PER_ADDR, 1);
    expect(rollReward(f.rc, alice.address, 1)).toHaveFailedTx<RollReward>({
        from: alice.address, to: f.rc.address, exitCode: Errors.RollNotAvailable,
    });
    expect(rcRewardState(f.rc, alice.address, 1).state).toEqual(REWARD_STATE_PENDING);
    expect(rcUserStake(f.rc, 1, alice.address).rewardClaimed).toBeFalse();
    // still allowed to take the 50% early claim
    expect(claimRewardEarly(f.rc, alice.address, 1)).toHaveSuccessfulTx<ClaimRewardEarly>({ from: alice.address, to: f.rc.address });
}

// ============================== F-06 ==============================

get fun `test F-06 referrer later stake tops up own bonus`() {
    val f = setupProtocol();
    val alice = testing.treasury("f06-alice");
    val bob = testing.treasury("f06-bob");
    openF(f);
    expect(setReferrer(f.rc, bob.address, alice.address)).toHaveSuccessfulTx<SetReferrer>({ from: bob.address, to: f.rc.address });
    stakeAccount(f, 1, alice.address, 1);                 // alice own 100k
    stakeWith(f, 1, bob.address, (AMOUNT * 10) as coins, 2); // bob 1M -> referred 1M
    // 20% * 1M = 200k, but capped by alice own 100k
    expect(rcReferral(f.rc, alice.address).bonusThisRound).toEqual(AMOUNT as uint128);
    // alice adds 1M later: target = min(200k, 1.1M) = 200k
    stakeWith(f, 1, alice.address, (AMOUNT * 10) as coins, 3);
    expect(rcReferral(f.rc, alice.address).bonusThisRound).toEqual(200000000000000 as uint128);
}

get fun `test F-06 referrer roll tops up next-round bonus`() {
    val f = setupProtocol();
    val alice = testing.treasury("f06-alice");
    val bob = testing.treasury("f06-bob");
    openF(f);
    expect(setReferrer(f.rc, bob.address, alice.address)).toHaveSuccessfulTx<SetReferrer>({ from: bob.address, to: f.rc.address });
    stakeAccount(f, 1, alice.address, 1);
    stakeAccount(f, 1, bob.address, 2);
    finishSuccess(f, 1);
    openNext(f);
    // bob rolls first -> alice's referred stake in R2 becomes bob's rolled amount
    expect(rollReward(f.rc, bob.address, 1)).toHaveSuccessfulTx<RollReward>({ from: bob.address, to: f.rc.address });
    expect(rollReward(f.rc, alice.address, 1)).toHaveSuccessfulTx<RollReward>({ from: alice.address, to: f.rc.address });
    // bonus = min(20% * referred, own rolled stake); both are capped at 20M
    val info = rcReferral(f.rc, alice.address);
    expect(info.bonusThisRound).toEqual(4000000000000000 as uint128);
}
