// V8 (docs/17_REWARD_V2.md) tests: weighted rewards, 3-state rewards, referrals,
// rolling hash candles and the unlock pool.
//
// Run: acton test tests/rewards-v8.test.tolk

import "@acton/emulation/network"
import "@acton/emulation/testing"
import "@acton/testing/expect"
import "@acton/types/big_array"
import "@acton/types/transaction"
import "@acton/io"

import "@contracts/constants"
import "@contracts/types"
import "test-utils"

const AMOUNT: coins = 100000000000000; // 100,000 A9
const REWARD_RAW: uint128 = 700000000000000000; // 700M A9
const MAX_PER_ADDR: uint128 = 20000000000000000; // 20M A9
const MAX_TOTAL: uint128 = 200000000000000000; // 200M A9
const MONTH_SECONDS: int = 2592000; // 30 days (1/12 of the 360-day unlock window)

fun openF(f: ProtocolFixture, twap: uint128) {
    expect(openRound(f.rc, f.admin, twap)).toHaveSuccessfulTx<OpenRound>({
        from: f.admin,
        to: f.rc.address,
    });
}

fun openNext(f: ProtocolFixture) {
    advance((PREVIEW_SECONDS as int) + 1);
    openF(f, 0);
}

fun stakeAccount(f: ProtocolFixture, roundId: uint8, owner: address, amount: coins, nonce: uint64) {
    expect(sendStake(f.rc, f.rcWallet.address, owner, amount, buildStakePayload(roundId, nonce, 1, 1)))
        .toHaveSuccessfulTx<TransferNotification>({
            from: f.rcWallet.address,
            to: f.rc.address,
        });
}

fun finishSuccess(f: ProtocolFixture, roundId: uint8, keeper: address, qualified: uint8) {
    advance(STAKE_DURATION_SECONDS as int);
    expect(closeStaking(f.rc, f.admin, 0)).toHaveSuccessfulTx<CloseStaking>({
        from: f.admin,
        to: f.rc.address,
    });
    expect(startObservation(f.rc, keeper, roundId)).toHaveSuccessfulTx<StartObservation>({
        from: keeper,
        to: f.rc.address,
    });
    submitAllCandles(f.rc, keeper, roundId, qualified, rcRound(f.rc, roundId).targetPriceUsdE8);
    expect(finalizeRound(f.rc, keeper, roundId)).toHaveSuccessfulTx<FinalizeRound>({
        from: keeper,
        to: f.rc.address,
    });
}

fun finishFailure(f: ProtocolFixture, roundId: uint8, keeper: address) {
    advance(STAKE_DURATION_SECONDS as int);
    expect(closeStaking(f.rc, f.admin, 0)).toHaveSuccessfulTx<CloseStaking>({
        from: f.admin,
        to: f.rc.address,
    });
    expect(startObservation(f.rc, keeper, roundId)).toHaveSuccessfulTx<StartObservation>({
        from: keeper,
        to: f.rc.address,
    });
    submitAllCandles(f.rc, keeper, roundId, 15, rcRound(f.rc, roundId).targetPriceUsdE8);
    confirmTeamBurn(f, roundId);
    val burn = burnStatus(f.rc, roundId);
    val totalStake = rcRound(f.rc, roundId).totalAcceptedStakeRaw;
    expect(sendBurnAck(f.rc, f.jettonMaster, roundId, BURN_KIND_REWARD, REWARD_RAW, burn.failureBurnId))
        .toHaveSuccessfulTx<BurnAck>({ from: f.jettonMaster, to: f.rc.address });
    expect(sendBurnAck(f.rc, f.jettonMaster, roundId, BURN_KIND_PRINCIPAL, totalStake, burn.failureBurnId))
        .toHaveSuccessfulTx<BurnAck>({ from: f.jettonMaster, to: f.rc.address });
    expect(finalizeRound(f.rc, keeper, roundId)).toHaveSuccessfulTx<FinalizeRound>({
        from: keeper,
        to: f.rc.address,
    });
}

fun gasOf(res: SendResultList, dest: address): int {
    var i = 0;
    while (i < res.size()) {
        val item = res.at(i);
        if (item.tx.load().getAccountAddress() == dest) {
            return item.gasUsed;
        }
        i += 1;
    }
    return 0;
}

fun expectedWeight(amountRaw: uint128, streak: uint8): uint128 {
    val capped: int = (streak as int) > (STREAK_MAX as int) ? (STREAK_MAX as int) : (streak as int);
    return amountRaw * ((10000 + 1000 * capped) as uint128) / 10000;
}

// ===========================================================================
// 1. Weight tiers 1/2/3/5/10 + streak persistence over 10 rounds
// ===========================================================================

get fun `test weight tiers 1/2/3/5/10 across ten consecutive rounds`() {
    val f = setupProtocol();
    val alice = testing.treasury("v8-alice");
    val keeper = f.keeper;
    openF(f, 0);

    var r: uint8 = 1;
    while (r <= 10) {
        if (r > 1) {
            openNext(f);
        }
        stakeAccount(f, r, alice.address, AMOUNT, 1);
        val expected = expectedWeight(AMOUNT as uint128, r);
        expect(rcUserWeight(f.rc, r, alice.address)).toEqual(expected);
        expect(rcStreak(f.rc, alice.address).count).toEqual(r);
        finishSuccess(f, r, keeper.address, 16);
        r += 1;
    }
}

// ===========================================================================
// 2. Streak reset when a round is skipped
// ===========================================================================

get fun `test skipped round resets streak to 1`() {
    val f = setupProtocol();
    val alice = testing.treasury("v8-alice");
    val bob = testing.treasury("v8-bob");
    val keeper = f.keeper;

    openF(f, 0);
    stakeAccount(f, 1, alice.address, AMOUNT, 1);
    finishSuccess(f, 1, keeper.address, 16);

    openNext(f);
    stakeAccount(f, 2, bob.address, AMOUNT, 1);
    finishSuccess(f, 2, keeper.address, 16);

    openNext(f);
    stakeAccount(f, 3, alice.address, AMOUNT, 1);
    expect(rcStreak(f.rc, alice.address).count).toEqual(1);
    expect(rcUserWeight(f.rc, 3, alice.address)).toEqual(expectedWeight(AMOUNT as uint128, 1));
}

// ===========================================================================
// 3. Referral bonus: 20%, capped by referrer stake, one-time binding
// ===========================================================================

get fun `test referral bonus is 20 percent capped by referrer own stake`() {
    val f = setupProtocol();
    val alice = testing.treasury("v8-alice");
    val bob = testing.treasury("v8-bob");
    openF(f, 0);

    expect(setReferrer(f.rc, bob.address, alice.address)).toHaveSuccessfulTx<SetReferrer>({
        from: bob.address,
        to: f.rc.address,
    });
    stakeAccount(f, 1, alice.address, AMOUNT, 1);
    stakeAccount(f, 1, bob.address, 1000000000000000 as coins, 1); // 1M A9

    // raw bonus = 20% * 1M = 200k, capped by alice's own stake (100k)
    expect(rcUserWeight(f.rc, 1, alice.address)).toEqual(expectedWeight(AMOUNT as uint128, 1) + (AMOUNT as uint128));
    val referral = rcReferral(f.rc, alice.address);
    expect(referral.referredStakeThisRound).toEqual(1000000000000000 as uint128);
    expect(referral.bonusThisRound).toEqual(AMOUNT as uint128);
    val totalExpected: uint128 = expectedWeight(AMOUNT as uint128, 1) +
        expectedWeight(1000000000000000 as uint128, 1) + (AMOUNT as uint128);
    expect(rcTotalWeight(f.rc, 1)).toEqual(totalExpected);
}

get fun `test self referral / mutual referral / duplicate binding are rejected`() {
    val f = setupProtocol();
    val alice = testing.treasury("v8-alice");
    val bob = testing.treasury("v8-bob");

    expect(setReferrer(f.rc, alice.address, alice.address)).toHaveFailedTx<SetReferrer>({
        from: alice.address,
        to: f.rc.address,
        exitCode: Errors.SelfReferral,
    });
    expect(setReferrer(f.rc, alice.address, bob.address)).toHaveSuccessfulTx<SetReferrer>({
        from: alice.address,
        to: f.rc.address,
    });
    // bob -> alice would create a mutual pair
    expect(setReferrer(f.rc, bob.address, alice.address)).toHaveFailedTx<SetReferrer>({
        from: bob.address,
        to: f.rc.address,
        exitCode: Errors.MutualReferral,
    });
    // alice cannot change her referrer
    expect(setReferrer(f.rc, alice.address, bob.address)).toHaveFailedTx<SetReferrer>({
        from: alice.address,
        to: f.rc.address,
        exitCode: Errors.AlreadyReferred,
    });
}

get fun `test invitee below minimum stake produces no referral bonus`() {
    val f = setupProtocol();
    val alice = testing.treasury("v8-alice");
    val bob = testing.treasury("v8-bob");
    openF(f, 0);
    expect(setReferrer(f.rc, bob.address, alice.address)).toHaveSuccessfulTx<SetReferrer>({
        from: bob.address,
        to: f.rc.address,
    });
    stakeAccount(f, 1, alice.address, AMOUNT, 1);
    // 5,000 A9 < minStake 10,000 -> refunded, no bonus
    expect(sendStake(f.rc, f.rcWallet.address, bob.address, 5000000000000 as coins, buildStakePayload(1, 1, 1, 1)))
        .toHaveSuccessfulTx<TransferNotification>({ from: f.rcWallet.address, to: f.rc.address });
    expect(rcReferral(f.rc, alice.address).bonusThisRound).toEqual(0 as uint128);
    expect(rcUserWeight(f.rc, 1, alice.address)).toEqual(expectedWeight(AMOUNT as uint128, 1));
}

// ===========================================================================
// 4. Reward states: ROLLED / EARLY / mutual exclusion
// ===========================================================================

get fun `test roll reward credits next round stake (capped at 20M) and keeps streak`() {
    val f = setupProtocol();
    val alice = testing.treasury("v8-alice");
    val keeper = f.keeper;
    openF(f, 0);
    stakeAccount(f, 1, alice.address, AMOUNT, 1);
    finishSuccess(f, 1, keeper.address, 16);

    expect(rollReward(f.rc, alice.address, 1)).toHaveSuccessfulTx<RollReward>({
        from: alice.address,
        to: f.rc.address,
    });
    val state = rcRewardState(f.rc, alice.address, 1);
    expect(state.state).toEqual(REWARD_STATE_ROLLED);
    // reward 700M, per-address cap 20M -> roll 20M, excess locked
    expect(rcUserStake(f.rc, 2, alice.address).amountRaw).toEqual(MAX_PER_ADDR);
    expect(rcUnlockInfo(f.rc, alice.address).totalLockedRaw).toEqual(REWARD_RAW - MAX_PER_ADDR);
    expect(rcStreak(f.rc, alice.address).count).toEqual(2);
    expect(rcUserWeight(f.rc, 2, alice.address)).toEqual(expectedWeight(MAX_PER_ADDR, 2));

    // state is immutable: early claim / second roll are rejected
    expect(claimRewardEarly(f.rc, alice.address, 1)).toHaveFailedTx<ClaimRewardEarly>({
        from: alice.address,
        to: f.rc.address,
        exitCode: Errors.AlreadyClaimed,
    });
    expect(rollReward(f.rc, alice.address, 1)).toHaveFailedTx<RollReward>({
        from: alice.address,
        to: f.rc.address,
        exitCode: Errors.AlreadyClaimed,
    });
}

get fun `test early claim pays exactly 50 percent and locks the rest`() {
    val f = setupProtocol();
    val alice = testing.treasury("v8-alice");
    val keeper = f.keeper;
    openF(f, 0);
    stakeAccount(f, 1, alice.address, AMOUNT, 1);
    finishSuccess(f, 1, keeper.address, 16);

    expect(claimRewardEarly(f.rc, alice.address, 1)).toHaveSuccessfulTx<ClaimRewardEarly>({
        from: alice.address,
        to: f.rc.address,
    });
    val state = rcRewardState(f.rc, alice.address, 1);
    expect(state.state).toEqual(REWARD_STATE_EARLY);
    expect(mockState(f.rcWallet).lastTransferAmount).toEqual((REWARD_RAW / 2) as coins);
    expect(rcUnlockInfo(f.rc, alice.address).totalLockedRaw).toEqual(REWARD_RAW - REWARD_RAW / 2);

    // mutually exclusive: roll after early is rejected
    expect(rollReward(f.rc, alice.address, 1)).toHaveFailedTx<RollReward>({
        from: alice.address,
        to: f.rc.address,
        exitCode: Errors.AlreadyClaimed,
    });
    expect(claimRewardEarly(f.rc, alice.address, 1)).toHaveFailedTx<ClaimRewardEarly>({
        from: alice.address,
        to: f.rc.address,
        exitCode: Errors.AlreadyClaimed,
    });
}

get fun `test reward state operation before settlement is rejected`() {
    val f = setupProtocol();
    val alice = testing.treasury("v8-alice");
    openF(f, 0);
    stakeAccount(f, 1, alice.address, AMOUNT, 1);
    expect(rollReward(f.rc, alice.address, 1)).toHaveFailedTx<RollReward>({
        from: alice.address,
        to: f.rc.address,
        exitCode: Errors.NotClaimable,
    });
    expect(claimRewardEarly(f.rc, alice.address, 1)).toHaveFailedTx<ClaimRewardEarly>({
        from: alice.address,
        to: f.rc.address,
        exitCode: Errors.NotClaimable,
    });
}

// ===========================================================================
// 5. Roll caps: per-address and round total
// ===========================================================================

get fun `test roll is truncated when the address already staked the 20M cap`() {
    val f = setupProtocol();
    val alice = testing.treasury("v8-alice");
    val keeper = f.keeper;
    openF(f, 0);
    stakeAccount(f, 1, alice.address, AMOUNT, 1);
    finishSuccess(f, 1, keeper.address, 16);

    openNext(f); // R2 STAKING_OPEN
    stakeAccount(f, 2, alice.address, MAX_PER_ADDR as coins, 1);
    // F-05: no room -> reject, keep PENDING (no ROLLED state, no lost early-claim right)
    expect(rollReward(f.rc, alice.address, 1)).toHaveFailedTx<RollReward>({
        from: alice.address,
        to: f.rc.address,
        exitCode: Errors.RollNotAvailable,
    });
    expect(rcUserStake(f.rc, 2, alice.address).amountRaw).toEqual(MAX_PER_ADDR);
    expect(rcRewardState(f.rc, alice.address, 1).state).toEqual(REWARD_STATE_PENDING);
    expect(rcUserStake(f.rc, 1, alice.address).rewardClaimed).toBeFalse();
}

get fun `test roll is truncated when the round total already hit 200M`() {
    val f = setupProtocol();
    val alice = testing.treasury("v8-alice");
    val keeper = f.keeper;
    openF(f, 0);
    stakeAccount(f, 1, alice.address, AMOUNT, 1);
    finishSuccess(f, 1, keeper.address, 16);

    openNext(f); // R2 open, fill to the 200M total cap with 10 addresses x 20M
    val owners: array<address> = [
        testing.treasury("v8-cap-0").address,
        testing.treasury("v8-cap-1").address,
        testing.treasury("v8-cap-2").address,
        testing.treasury("v8-cap-3").address,
        testing.treasury("v8-cap-4").address,
        testing.treasury("v8-cap-5").address,
        testing.treasury("v8-cap-6").address,
        testing.treasury("v8-cap-7").address,
        testing.treasury("v8-cap-8").address,
        testing.treasury("v8-cap-9").address,
    ];
    var i = 0;
    while (i < 10) {
        stakeAccount(f, 2, owners.get(i), MAX_PER_ADDR as coins, 1);
        i += 1;
    }
    expect(rcRound(f.rc, 2).totalAcceptedStakeRaw).toEqual(MAX_TOTAL);

    expect(rollReward(f.rc, alice.address, 1)).toHaveFailedTx<RollReward>({
        from: alice.address,
        to: f.rc.address,
        exitCode: Errors.RollNotAvailable,
    });
    expect(rcRound(f.rc, 2).totalAcceptedStakeRaw).toEqual(MAX_TOTAL);
    expect(rcUserStake(f.rc, 2, alice.address).amountRaw).toEqual(0 as uint128);
    expect(rcRewardState(f.rc, alice.address, 1).state).toEqual(REWARD_STATE_PENDING);
}

// ===========================================================================
// 6. Rolled stake follows the normal failure burn path
// ===========================================================================

get fun `test rolled stake is burned when the next round fails`() {
    val f = setupProtocol();
    val alice = testing.treasury("v8-alice");
    val keeper = f.keeper;
    openF(f, 0);
    stakeAccount(f, 1, alice.address, AMOUNT, 1);
    finishSuccess(f, 1, keeper.address, 16);

    // roll into R2 before opening (R2 is PREVIEW)
    expect(rollReward(f.rc, alice.address, 1)).toHaveSuccessfulTx<RollReward>({
        from: alice.address,
        to: f.rc.address,
    });
    openNext(f); // open R2 (rolled 20M is already in the ledger)
    expect(rcRound(f.rc, 2).totalAcceptedStakeRaw).toEqual(MAX_PER_ADDR);
    finishFailure(f, 2, keeper.address);

    // principal burn (2nd burn) amount == R2 total stake (rolled amount only)
    expect(mockState(f.rcWallet).lastBurnAmount).toEqual(MAX_PER_ADDR as coins);
    expect(rcStatus(f.rc, 2)).toEqual(STATUS_FAILED_PERMANENT);
}

// ===========================================================================
// 7. Unlock pool: R10 gate + linear release
// ===========================================================================

get fun `test claim unlocked is rejected before round 10 settles`() {
    val f = setupProtocol();
    val alice = testing.treasury("v8-alice");
    val keeper = f.keeper;
    openF(f, 0);
    stakeAccount(f, 1, alice.address, AMOUNT, 1);
    finishSuccess(f, 1, keeper.address, 16);
    expect(claimUnlocked(f.rc, alice.address)).toHaveFailedTx<ClaimUnlocked>({
        from: alice.address,
        to: f.rc.address,
        exitCode: Errors.UnlockNotStarted,
    });
}

get fun `test round 10 unlock releases 1/12 per month linearly`() {
    val f = setupProtocol();
    val alice = testing.treasury("v8-alice");
    val keeper = f.keeper;
    openF(f, 0);

    var r: uint8 = 1;
    while (r <= 10) {
        if (r > 1) {
            openNext(f);
        }
        stakeAccount(f, r, alice.address, AMOUNT, 1);
        finishSuccess(f, r, keeper.address, 16);
        r += 1;
    }

    val info0 = rcUnlockInfo(f.rc, alice.address);
    expect(info0.unlockStart > 0).toBeTrue();
    expect(info0.totalLockedRaw).toEqual(REWARD_RAW * 10);
    // at t == unlockStart nothing is vested yet
    expect(claimUnlocked(f.rc, alice.address)).toHaveFailedTx<ClaimUnlocked>({
        from: alice.address,
        to: f.rc.address,
        exitCode: Errors.NothingUnlocked,
    });

    topUpForTimeJump(f, ton("500"));
    advance(MONTH_SECONDS);
    val expectedFirst: uint128 = (REWARD_RAW * 10) * (MONTH_SECONDS as uint128) / (UNLOCK_DURATION_SECONDS as uint128);
    expect(rcUnlockInfo(f.rc, alice.address).claimableRaw).toEqual(expectedFirst);
    expect(claimUnlocked(f.rc, alice.address)).toHaveSuccessfulTx<ClaimUnlocked>({
        from: alice.address,
        to: f.rc.address,
    });
    expect(mockState(f.rcWallet).lastTransferAmount).toEqual(expectedFirst as coins);
    expect(rcUnlockInfo(f.rc, alice.address).claimedRaw).toEqual(expectedFirst);

    // same month -> nothing left
    expect(claimUnlocked(f.rc, alice.address)).toHaveFailedTx<ClaimUnlocked>({
        from: alice.address,
        to: f.rc.address,
        exitCode: Errors.NothingUnlocked,
    });
}

get fun `test early-claim forfeited half is part of the unlock pool`() {
    val f = setupProtocol();
    val alice = testing.treasury("v8-alice");
    val keeper = f.keeper;
    openF(f, 0);
    stakeAccount(f, 1, alice.address, AMOUNT, 1);
    finishSuccess(f, 1, keeper.address, 16);
    expect(claimRewardEarly(f.rc, alice.address, 1)).toHaveSuccessfulTx<ClaimRewardEarly>({
        from: alice.address,
        to: f.rc.address,
    });
    val lockedHalf: uint128 = REWARD_RAW - REWARD_RAW / 2;
    expect(rcUnlockInfo(f.rc, alice.address).totalLockedRaw).toEqual(lockedHalf);
    // unlockStart not set until R10 -> cannot claim
    expect(rcUnlockInfo(f.rc, alice.address).claimableRaw).toEqual(0 as uint128);
}

// ===========================================================================
// 8. Reward pool invariants
// ===========================================================================

get fun `test equal weights split exactly 700M (no overspend)`() {
    val f = setupProtocol();
    val alice = testing.treasury("v8-alice");
    val bob = testing.treasury("v8-bob");
    val keeper = f.keeper;
    openF(f, 0);
    stakeAccount(f, 1, alice.address, AMOUNT, 1);
    stakeAccount(f, 1, bob.address, AMOUNT, 1);
    finishSuccess(f, 1, keeper.address, 16);

    val a = net.runGetMethod<uint128>(f.rc.address, "get_user_reward_estimate", [1 as uint8, alice.address]);
    val b = net.runGetMethod<uint128>(f.rc.address, "get_user_reward_estimate", [1 as uint8, bob.address]);
    expect(a).toEqual(REWARD_RAW / 2);
    expect(b).toEqual(REWARD_RAW / 2);
    expect(a + b).toEqual(REWARD_RAW);
}

get fun `test three weight groups never exceed the 700M pool`() {
    val f = setupProtocol();
    val alice = testing.treasury("v8-alice");
    val bob = testing.treasury("v8-bob");
    val carol = testing.treasury("v8-carol");
    val keeper = f.keeper;
    openF(f, 0);
    stakeAccount(f, 1, alice.address, AMOUNT, 1);
    stakeAccount(f, 1, bob.address, AMOUNT, 1);
    stakeAccount(f, 1, carol.address, AMOUNT, 1);
    finishSuccess(f, 1, keeper.address, 16);

    val a = net.runGetMethod<uint128>(f.rc.address, "get_user_reward_estimate", [1 as uint8, alice.address]);
    val b = net.runGetMethod<uint128>(f.rc.address, "get_user_reward_estimate", [1 as uint8, bob.address]);
    val c = net.runGetMethod<uint128>(f.rc.address, "get_user_reward_estimate", [1 as uint8, carol.address]);
    val total: uint128 = a + b + c;
    expect(total <= REWARD_RAW).toBeTrue();
    // floor rounding leaves only dust (< number of positions) in the vault
    expect((REWARD_RAW - total) < 3).toBeTrue();
}

get fun `test roll amount + locked amount always equals the full reward`() {
    val f = setupProtocol();
    val alice = testing.treasury("v8-alice");
    val keeper = f.keeper;
    openF(f, 0);
    stakeAccount(f, 1, alice.address, AMOUNT, 1);
    finishSuccess(f, 1, keeper.address, 16);
    expect(rollReward(f.rc, alice.address, 1)).toHaveSuccessfulTx<RollReward>({
        from: alice.address,
        to: f.rc.address,
    });
    val rolled: uint128 = rcUserStake(f.rc, 2, alice.address).amountRaw;
    val locked: uint128 = rcUnlockInfo(f.rc, alice.address).totalLockedRaw;
    expect(rolled + locked).toEqual(REWARD_RAW);
    expect(rolled <= MAX_PER_ADDR).toBeTrue();
    expect(locked < REWARD_RAW).toBeTrue(); // rolled pool < 700M, never over-issues
}

// ===========================================================================
// 9. Gas report (informational; also guards O(1) claim/roll paths)
// ===========================================================================

get fun `test gas report stake and early claim`() {
    val f = setupProtocol();
    val alice = testing.treasury("v8-alice");
    val keeper = f.keeper;
    openF(f, 0);

    val stakeRes = sendStake(f.rc, f.rcWallet.address, alice.address, AMOUNT, buildStakePayload(1, 1, 1, 1));
    expect(stakeRes).toHaveSuccessfulTx<TransferNotification>({ from: f.rcWallet.address, to: f.rc.address });
    val stakeGas = gasOf(stakeRes, f.rc.address);
    finishSuccess(f, 1, keeper.address, 16);

    val earlyRes = claimRewardEarly(f.rc, alice.address, 1);
    expect(earlyRes).toHaveSuccessfulTx<ClaimRewardEarly>({ from: alice.address, to: f.rc.address });
    val earlyGas = gasOf(earlyRes, f.rc.address);
    println("GAS stake={} early={}", stakeGas, earlyGas);
    expect(stakeGas > 0).toBeTrue();
    expect(earlyGas > 0).toBeTrue();
}

get fun `test gas report roll reward`() {
    val f = setupProtocol();
    val bob = testing.treasury("v8-bob2");
    val keeper = f.keeper;
    openF(f, 0);
    stakeAccount(f, 1, bob.address, AMOUNT, 1);
    finishSuccess(f, 1, keeper.address, 16);
    val rollRes = rollReward(f.rc, bob.address, 1);
    expect(rollRes).toHaveSuccessfulTx<RollReward>({ from: bob.address, to: f.rc.address });
    val rollGas = gasOf(rollRes, f.rc.address);
    println("GAS roll={}", rollGas);
    expect(rollGas > 0).toBeTrue();
}

get fun `test gas report legacy claim reward`() {
    val f = setupProtocol();
    val carol = testing.treasury("v8-carol2");
    val keeper = f.keeper;
    openF(f, 0);
    stakeAccount(f, 1, carol.address, AMOUNT, 1);
    finishSuccess(f, 1, keeper.address, 16);
    val claimRes = claimReward(f.rc, carol.address, 1);
    expect(claimRes).toHaveSuccessfulTx<ClaimReward>({ from: carol.address, to: f.rc.address });
    val claimGas = gasOf(claimRes, f.rc.address);
    println("GAS legacyClaim={}", claimGas);
    expect(claimGas > 0).toBeTrue();
}


// ===========================================================================
// 10. Legacy ABI must not bypass the three-state lock (lead decision)
// ===========================================================================

get fun `test legacy ClaimReward pays only 50 percent in ladder period`() {
    val f = setupProtocol();
    val alice = testing.treasury("v8-legacy-reward");
    val keeper = f.keeper;
    openF(f, 0);
    stakeAccount(f, 1, alice.address, AMOUNT, 1);
    finishSuccess(f, 1, keeper.address, 16);

    val res = claimReward(f.rc, alice.address, 1);
    expect(res).toHaveSuccessfulTx<ClaimReward>({ from: alice.address, to: f.rc.address });
    expect(mockState(f.rcWallet).lastTransferAmount).toEqual((REWARD_RAW / 2) as coins);
    expect(rcUnlockInfo(f.rc, alice.address).totalLockedRaw).toEqual(REWARD_RAW - REWARD_RAW / 2);
    expect(rcRewardState(f.rc, alice.address, 1).state).toEqual(REWARD_STATE_EARLY);
    // second legacy claim is rejected (idempotent)
    expect(claimReward(f.rc, alice.address, 1)).toHaveFailedTx<ClaimReward>({
        from: alice.address,
        to: f.rc.address,
        exitCode: Errors.AlreadyClaimed,
    });
}

get fun `test legacy ClaimAll pays principal 100 percent and reward 50 percent`() {
    val f = setupProtocol();
    val alice = testing.treasury("v8-legacy-all");
    val bob = testing.treasury("v8-legacy-all-bob");
    val keeper = f.keeper;
    openF(f, 0);
    stakeAccount(f, 1, alice.address, AMOUNT, 1);
    stakeAccount(f, 1, bob.address, AMOUNT, 1);
    finishSuccess(f, 1, keeper.address, 16);

    val aliceReward = net.runGetMethod<uint128>(f.rc.address, "get_user_reward_estimate", [1 as uint8, alice.address]);
    val res = claimAll(f.rc, alice.address, 0);
    expect(res).toHaveSuccessfulTx<ClaimAll>({ from: alice.address, to: f.rc.address });
    // principal 100% + reward 50% in one transfer
    expect(mockState(f.rcWallet).lastTransferAmount).toEqual(((AMOUNT as uint128) + aliceReward / 2) as coins);
    expect(rcUnlockInfo(f.rc, alice.address).totalLockedRaw).toEqual(aliceReward - aliceReward / 2);
    // principal already returned by ClaimAll
    expect(claimPrincipal(f.rc, alice.address, 1)).toHaveFailedTx<ClaimPrincipal>({
        from: alice.address,
        to: f.rc.address,
        exitCode: Errors.AlreadyClaimed,
    });
}
