import "@acton/emulation/network"
import "@acton/emulation/testing"
import "@acton/testing/expect"
import "@acton/testing/assert"
import "@acton/tlb/either"

import "@contracts/constants"
import "@contracts/types"
import "test-utils"

const AMOUNT: coins = 100000000000000; // 100,000 A9

// ===========================================================================
// Events
// ===========================================================================

get fun `test TargetPriceSet / DepositAccepted / RoundSettled events are emitted`() {
    val f = setupProtocol();
    val alice = testing.treasury("alice");
    val keeper = f.keeper;

    val openRes = openRound(f.rc, f.admin, 200000);
    expect(openRes).toHaveSuccessfulTx<OpenRound>({ from: f.admin, to: f.rc.address });
    val ev = openRes.findExternalOutMessage<TargetPriceSet>({ from: f.rc.address });
    expect(ev).toBeNotNull();
    if (ev != null) {
        val body = match (ev!.body) {
            TlbEitherLeft => ev!.body.value,
            TlbEitherRight => {
                Assert.fail("expected inline external-out body");
            },
        };
        expect(body.roundId).toEqual(1);
        expect(body.tier).toEqual(1);
        expect(body.targetPriceUsdE8).toEqual(400000 as uint128);
        expect(body.twap24hUsdE8).toEqual(200000 as uint128);
    }

    val stakeRes = sendStake(f.rc, f.rcWallet.address, alice.address, AMOUNT, buildStakePayload(1, 1, 1, 1));
    expect(stakeRes).toHaveSuccessfulTx<TransferNotification>({ from: f.rcWallet.address, to: f.rc.address });
    val dep = stakeRes.findExternalOutMessage<DepositAccepted>({ from: f.rc.address });
    expect(dep).toBeNotNull();
    if (dep != null) {
        val body = match (dep!.body) {
            TlbEitherLeft => dep!.body.value,
            TlbEitherRight => {
                Assert.fail("expected inline external-out body");
            },
        };
        expect(body.roundId).toEqual(1);
        expect(body.owner).toEqual(alice.address);
        expect(body.amountRaw).toEqual(AMOUNT as uint128);
        expect(body.totalAcceptedStakeRaw).toEqual(AMOUNT as uint128);
    }

    advance(STAKE_DURATION_SECONDS as int);
    expect(closeStaking(f.rc, f.admin, 0)).toHaveSuccessfulTx<CloseStaking>({ from: f.admin, to: f.rc.address });
    expect(startObservation(f.rc, keeper.address, 1)).toHaveSuccessfulTx<StartObservation>({ from: keeper.address, to: f.rc.address });
    submitAllCandles(f.rc, keeper.address, 1, 16, 400000 as uint128);
    val finRes = finalizeRound(f.rc, keeper.address, 1);
    expect(finRes).toHaveSuccessfulTx<FinalizeRound>({ from: keeper.address, to: f.rc.address });
    val settledEv = finRes.findExternalOutMessage<RoundSettled>({ from: f.rc.address });
    expect(settledEv).toBeNotNull();
    if (settledEv != null) {
        val body = match (settledEv!.body) {
            TlbEitherLeft => settledEv!.body.value,
            TlbEitherRight => {
                Assert.fail("expected inline external-out body");
            },
        };
        expect(body.roundId).toEqual(1);
        expect(body.status).toEqual(STATUS_SUCCEEDED);
        expect(body.qualifiedCandles).toEqual(16);
        expect(body.candlesSeen).toEqual(24);
        expect(body.tierAfter).toEqual(2);
    }
}

// ===========================================================================
// Tier progression (D-28)
// ===========================================================================

get fun `test success increments tier: R1 2xP0 -> R2 4xP0 -> R3 8xP0`() {
    val f = setupProtocol();
    val alice = testing.treasury("alice");
    val keeper = f.keeper;

    runSuccessRound(f, 1, alice.address, keeper.address, AMOUNT);
    expect(net.runGetMethod<uint8>(f.rc.address, "get_success_count")).toEqual(1);
    advance(PREVIEW_SECONDS as int);
    expect(openRound(f.rc, f.admin, 0)).toHaveSuccessfulTx<OpenRound>({ from: f.admin, to: f.rc.address });
    val r2 = rcRound(f.rc, 2);
    expect(r2.targetTier).toEqual(2);
    expect(r2.targetPriceUsdE8).toEqual(464000 as uint128);
    // finish R2 successfully
    stakeOk(f, 2, alice.address, AMOUNT, 1);
    advance(STAKE_DURATION_SECONDS as int);
    expect(closeStaking(f.rc, f.admin, 0)).toHaveSuccessfulTx<CloseStaking>({ from: f.admin, to: f.rc.address });
    expect(startObservation(f.rc, keeper.address, 2)).toHaveSuccessfulTx<StartObservation>({ from: keeper.address, to: f.rc.address });
    submitAllCandles(f.rc, keeper.address, 2, 16, 464000 as uint128);
    expect(finalizeRound(f.rc, keeper.address, 2)).toHaveSuccessfulTx<FinalizeRound>({ from: keeper.address, to: f.rc.address });
    expect(net.runGetMethod<uint8>(f.rc.address, "get_success_count")).toEqual(2);
    advance(PREVIEW_SECONDS as int);
    expect(openRound(f.rc, f.admin, 0)).toHaveSuccessfulTx<OpenRound>({ from: f.admin, to: f.rc.address });
    val r3 = rcRound(f.rc, 3);
    expect(r3.targetTier).toEqual(3);
    expect(r3.targetPriceUsdE8).toEqual(928000 as uint128);
}

// ===========================================================================
// 0-stake failure
// ===========================================================================

get fun `test 0-stake failure burns reward + team only and stays permanent`() {
    val f = setupProtocol();
    val keeper = f.keeper;
    val target = openAndCloseFirstRound(f, 0);
    expect(startObservation(f.rc, keeper.address, 1)).toHaveSuccessfulTx<StartObservation>({ from: keeper.address, to: f.rc.address });
    submitAllCandles(f.rc, keeper.address, 1, 15, target);
    confirmTeamBurn(f, 1);

    val settling = rcRound(f.rc, 1);
    expect(settling.status).toEqual(STATUS_SETTLING_FAILURE);
    expect(settling.totalAcceptedStakeRaw).toEqual(0 as uint128);
    expect(settling.principalBurnConfirmed).toBeTrue(); // nothing to burn
    expect(settling.teamBurnConfirmed).toBeTrue();
    expect(settling.rewardBurnConfirmed).toBeFalse();
    expect(mockState(f.rcWallet).burnCount).toEqual(1); // reward only

    expect(finalizeRound(f.rc, keeper.address, 1)).toHaveFailedTx<FinalizeRound>({
        from: keeper.address,
        to: f.rc.address,
        exitCode: Errors.BurnsNotConfirmed,
    });
    val status = burnStatus(f.rc, 1);
    expect(sendBurnAck(f.rc, f.jettonMaster, 1, BURN_KIND_REWARD, ROUND_REWARD_RAW, status.failureBurnId))
        .toHaveSuccessfulTx<BurnAck>({ from: f.jettonMaster, to: f.rc.address });
    expect(finalizeRound(f.rc, keeper.address, 1)).toHaveSuccessfulTx<FinalizeRound>({
        from: keeper.address,
        to: f.rc.address,
    });
    expect(rcStatus(f.rc, 1)).toEqual(STATUS_FAILED_PERMANENT);
    expect(net.runGetMethod<uint8>(f.rc.address, "get_success_count")).toEqual(0);
    expect(teamVaultState(f.tv).totalBurnedRaw).toEqual(TEAM_ROUND_RAW);
    expect(teamVaultState(f.tv).totalReleasedRaw).toEqual(0 as uint128);
}

// ===========================================================================
// Cross-round claimAll
// ===========================================================================

get fun `test cross-round claimAll merges two rounds into a single transfer`() {
    val f = setupProtocol();
    val alice = testing.treasury("alice");
    val keeper = f.keeper;

    runSuccessRound(f, 1, alice.address, keeper.address, AMOUNT);
    advance(PREVIEW_SECONDS as int);
    runSuccessRound(f, 2, alice.address, keeper.address, AMOUNT);

    val claimable = rcClaimable(f.rc, alice.address);
    expect(claimable.roundsMask).toEqual(3); // bits for rounds 1 and 2
    val expectedPrincipal: uint128 = (AMOUNT as uint128) * 2;
    val expectedReward: uint128 = ROUND_REWARD_RAW; // 2 rounds x 700M; legacy ClaimAll pays 50% now
    expect(claimable.principalRaw).toEqual(expectedPrincipal);
    expect(claimable.rewardRaw).toEqual(expectedReward);

    expect(claimAll(f.rc, alice.address, 0)).toHaveSuccessfulTx<ClaimAll>({
        from: alice.address,
        to: f.rc.address,
    });
    val ms = mockState(f.rcWallet);
    expect(ms.transferCount).toEqual(1);
    expect(ms.lastTransferAmount).toEqual((expectedPrincipal + expectedReward) as coins);
    expect(rcUnlockInfo(f.rc, alice.address).totalLockedRaw).toEqual(ROUND_REWARD_RAW * 2 - expectedReward);
    expect(ms.lastTransferDest).toEqual(alice.address);

    // second call: nothing left
    expect(claimAll(f.rc, alice.address, 0)).toHaveSuccessfulTx<ClaimAll>({
        from: alice.address,
        to: f.rc.address,
    });
    expect(mockState(f.rcWallet).transferCount).toEqual(1);
}

get fun `test claimAll with a specific roundId only claims that round`() {
    val f = setupProtocol();
    val alice = testing.treasury("alice");
    val keeper = f.keeper;

    runSuccessRound(f, 1, alice.address, keeper.address, AMOUNT);
    advance(PREVIEW_SECONDS as int);
    runSuccessRound(f, 2, alice.address, keeper.address, AMOUNT);

    expect(claimAll(f.rc, alice.address, 2)).toHaveSuccessfulTx<ClaimAll>({
        from: alice.address,
        to: f.rc.address,
    });
    expect(mockState(f.rcWallet).transferCount).toEqual(1);
    expect(rcClaimable(f.rc, alice.address).roundsMask).toEqual(1); // round 1 remains
    expect(claimAll(f.rc, alice.address, 1)).toHaveSuccessfulTx<ClaimAll>({
        from: alice.address,
        to: f.rc.address,
    });
    expect(mockState(f.rcWallet).transferCount).toEqual(2);
    expect(rcClaimable(f.rc, alice.address).principalRaw).toEqual(0 as uint128);
}

// ===========================================================================
// Retry path
// ===========================================================================

get fun `test RetryPendingActions resends missing failure burns`() {
    val f = setupProtocol();
    val alice = testing.treasury("alice");
    val keeper = f.keeper;

    expect(openRound(f.rc, f.admin, 0)).toHaveSuccessfulTx<OpenRound>({ from: f.admin, to: f.rc.address });
    stakeOk(f, 1, alice.address, AMOUNT, 1);
    advance(STAKE_DURATION_SECONDS as int);
    expect(closeStaking(f.rc, f.admin, 0)).toHaveSuccessfulTx<CloseStaking>({ from: f.admin, to: f.rc.address });
    expect(startObservation(f.rc, keeper.address, 1)).toHaveSuccessfulTx<StartObservation>({ from: keeper.address, to: f.rc.address });
    submitAllCandles(f.rc, keeper.address, 1, 15, rcRound(f.rc, 1).targetPriceUsdE8);
    confirmTeamBurn(f, 1);
    expect(rcStatus(f.rc, 1)).toEqual(STATUS_SETTLING_FAILURE);
    expect(mockState(f.rcWallet).burnCount).toEqual(2);

    // admin-only
    expect(retryPendingActions(f.rc, alice.address, 1)).toHaveFailedTx<RetryPendingActions>({
        from: alice.address,
        to: f.rc.address,
        exitCode: Errors.NotAdmin,
    });
    // resends reward + principal burns (team already confirmed)
    expect(retryPendingActions(f.rc, f.admin, 1)).toHaveSuccessfulTx<RetryPendingActions>({
        from: f.admin,
        to: f.rc.address,
    });
    expect(mockState(f.rcWallet).burnCount).toEqual(4);
}

// ===========================================================================
// 10 rounds hard cap
// ===========================================================================

get fun `test ten successful rounds: tier 10 target is 1024 x P0 and round 11 is rejected`() {
    val f = setupProtocol();
    val alice = testing.treasury("alice");
    val keeper = f.keeper;

    var roundId: uint8 = 1;
    while (roundId <= 10) {
        if (roundId > 1) {
            advance(PREVIEW_SECONDS as int);
        }
        runSuccessRound(f, roundId, alice.address, keeper.address, AMOUNT);
        roundId += 1;
    }

    expect(net.runGetMethod<uint8>(f.rc.address, "get_success_count")).toEqual(10);
    expect(net.runGetMethod<uint8>(f.rc.address, "get_current_round")).toEqual(10);
    expect(rcRound(f.rc, 10).targetTier).toEqual(10);
    // 116000 * 2^10 = 118,784,000 USD_E8 = $1.18784 (matches docs/01 ladder R10)
    expect(rcRound(f.rc, 10).targetPriceUsdE8).toEqual(118784000 as uint128);
    expect(teamVaultState(f.tv).totalReleasedRaw).toEqual(TEAM_ROUND_RAW * 10);

    expect(openRound(f.rc, f.admin, 0)).toHaveFailedTx<OpenRound>({
        from: f.admin,
        to: f.rc.address,
        exitCode: Errors.MaxRoundsReached,
    });
}
