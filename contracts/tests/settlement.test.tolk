import "@acton/build"
import "@acton/emulation/network"
import "@acton/emulation/testing"
import "@acton/testing/expect"
import "@acton/types/big_array"
import "@acton/types/transaction"

import "@contracts/constants"
import "@contracts/types"
import "test-utils"

const AMOUNT_ALICE: coins = 100000000000000; // 100,000 A9
const AMOUNT_BOB: coins = 300000000000000; // 300,000 A9
const TOTAL_TWO: coins = 400000000000000; // 400,000 A9

// ===========================================================================
// Success settlement + claims
// ===========================================================================

get fun `test success round: 12/18 candles -> SETTLING_SUCCESS -> SUCCEEDED with team release`() {
    val f = setupProtocol();
    val alice = testing.treasury("alice");
    val bob = testing.treasury("bob");
    val keeper = testing.treasury("keeper");

    expect(openRound(f.rc, f.admin, 0)).toHaveSuccessfulTx<OpenRound>({
        from: f.admin,
        to: f.rc.address,
    });
    stakeOk(f, 1, alice.address, AMOUNT_ALICE, 1);
    stakeOk(f, 1, bob.address, AMOUNT_BOB, 1);

    advance(STAKE_DURATION_SECONDS as int);
    expect(closeStaking(f.rc, f.admin, 0)).toHaveSuccessfulTx<CloseStaking>({
        from: f.admin,
        to: f.rc.address,
    });
    expect(startObservation(f.rc, keeper.address, 1)).toHaveSuccessfulTx<StartObservation>({
        from: keeper.address,
        to: f.rc.address,
    });
    expect(rcStatus(f.rc, 1)).toEqual(STATUS_OBSERVING);

    val target = rcRound(f.rc, 1).targetPriceUsdE8;
    submitAllCandles(f.rc, keeper.address, 1, 12, target);

    val settling = rcRound(f.rc, 1);
    expect(settling.status).toEqual(STATUS_SETTLING_SUCCESS);
    expect(settling.candlesSeen).toEqual(18);
    expect(settling.qualifiedCandles).toEqual(12);
    expect(settling.totalAcceptedStakeRaw).toEqual(TOTAL_TWO as uint128);
    expect(settling.teamReleaseConfirmed).toBeTrue();
    expect(teamVaultState(f.tv).totalReleasedRaw).toEqual(TEAM_ROUND_RAW);

    expect(finalizeRound(f.rc, keeper.address, 1)).toHaveSuccessfulTx<FinalizeRound>({
        from: keeper.address,
        to: f.rc.address,
    });
    val settled = rcRound(f.rc, 1);
    expect(settled.status).toEqual(STATUS_SUCCEEDED);
    expect(settled.settledAt).toEqual(1518400);
    expect(net.runGetMethod<uint8>(f.rc.address, "get_success_count")).toEqual(1);

    // 24h PREVIEW: next round automatically created with stakeOpenAt = settledAt + 24h
    val next = rcRound(f.rc, 2);
    expect(next.status).toEqual(STATUS_PREVIEW);
    expect(next.stakeOpenAt).toEqual(1518400 + 86400);
    expect(next.rewardBudgetRaw).toEqual(ROUND_REWARD_RAW);
}

get fun `test reward estimate + claimAll combines principal and reward exactly once`() {
    val f = setupProtocol();
    val alice = testing.treasury("alice");
    val bob = testing.treasury("bob");
    val keeper = testing.treasury("keeper");

    expect(openRound(f.rc, f.admin, 0)).toHaveSuccessfulTx<OpenRound>({ from: f.admin, to: f.rc.address });
    stakeOk(f, 1, alice.address, AMOUNT_ALICE, 1);
    stakeOk(f, 1, bob.address, AMOUNT_BOB, 1);
    advance(STAKE_DURATION_SECONDS as int);
    expect(closeStaking(f.rc, f.admin, 0)).toHaveSuccessfulTx<CloseStaking>({ from: f.admin, to: f.rc.address });
    expect(startObservation(f.rc, keeper.address, 1)).toHaveSuccessfulTx<StartObservation>({ from: keeper.address, to: f.rc.address });
    submitAllCandles(f.rc, keeper.address, 1, 12, rcRound(f.rc, 1).targetPriceUsdE8);
    expect(finalizeRound(f.rc, keeper.address, 1)).toHaveSuccessfulTx<FinalizeRound>({ from: keeper.address, to: f.rc.address });

    // alice 25% of 700,000,000 A9
    val aliceReward = net.runGetMethod<uint128>(f.rc.address, "get_user_reward_estimate", [1 as uint8, alice.address]);
    expect(aliceReward).toEqual(175000000000000000 as uint128);
    val bobReward = net.runGetMethod<uint128>(f.rc.address, "get_user_reward_estimate", [1 as uint8, bob.address]);
    expect(bobReward).toEqual(525000000000000000 as uint128);

    val claimable = rcClaimable(f.rc, alice.address);
    expect(claimable.principalRaw).toEqual(AMOUNT_ALICE as uint128);
    expect(claimable.rewardRaw).toEqual(aliceReward);
    expect(claimable.roundsMask).toEqual(1);

    val expectedTotal: coins = AMOUNT_ALICE + (aliceReward as coins);
    expect(claimAll(f.rc, alice.address, 0)).toHaveSuccessfulTx<ClaimAll>({
        from: alice.address,
        to: f.rc.address,
    });
    val ms1 = mockState(f.rcWallet);
    expect(ms1.transferCount).toEqual(1);
    expect(ms1.lastTransferDest).toEqual(alice.address);
    expect(ms1.lastTransferAmount).toEqual(expectedTotal);

    // duplicate claimAll: nothing left, no extra transfer
    expect(claimAll(f.rc, alice.address, 0)).toHaveSuccessfulTx<ClaimAll>({
        from: alice.address,
        to: f.rc.address,
    });
    expect(mockState(f.rcWallet).transferCount).toEqual(1);
    expect(rcClaimable(f.rc, alice.address).principalRaw).toEqual(0 as uint128);
}

get fun `test separate ClaimReward / ClaimPrincipal are idempotent`() {
    val f = setupProtocol();
    val alice = testing.treasury("alice");
    val bob = testing.treasury("bob");
    val keeper = testing.treasury("keeper");

    expect(openRound(f.rc, f.admin, 0)).toHaveSuccessfulTx<OpenRound>({ from: f.admin, to: f.rc.address });
    stakeOk(f, 1, alice.address, AMOUNT_ALICE, 1);
    stakeOk(f, 1, bob.address, AMOUNT_BOB, 1);
    advance(STAKE_DURATION_SECONDS as int);
    expect(closeStaking(f.rc, f.admin, 0)).toHaveSuccessfulTx<CloseStaking>({ from: f.admin, to: f.rc.address });
    expect(startObservation(f.rc, keeper.address, 1)).toHaveSuccessfulTx<StartObservation>({ from: keeper.address, to: f.rc.address });
    submitAllCandles(f.rc, keeper.address, 1, 12, rcRound(f.rc, 1).targetPriceUsdE8);
    expect(finalizeRound(f.rc, keeper.address, 1)).toHaveSuccessfulTx<FinalizeRound>({ from: keeper.address, to: f.rc.address });

    expect(claimReward(f.rc, bob.address, 1)).toHaveSuccessfulTx<ClaimReward>({ from: bob.address, to: f.rc.address });
    expect(mockState(f.rcWallet).transferCount).toEqual(1);
    expect(claimReward(f.rc, bob.address, 1)).toHaveFailedTx<ClaimReward>({
        from: bob.address,
        to: f.rc.address,
        exitCode: Errors.AlreadyClaimed,
    });
    expect(claimPrincipal(f.rc, bob.address, 1)).toHaveSuccessfulTx<ClaimPrincipal>({ from: bob.address, to: f.rc.address });
    expect(mockState(f.rcWallet).transferCount).toEqual(2);
    expect(mockState(f.rcWallet).lastTransferAmount).toEqual(AMOUNT_BOB);
    expect(claimPrincipal(f.rc, bob.address, 1)).toHaveFailedTx<ClaimPrincipal>({
        from: bob.address,
        to: f.rc.address,
        exitCode: Errors.AlreadyClaimed,
    });
}

// ===========================================================================
// Failure settlement (three burns + acks)
// ===========================================================================

get fun `test failure round: 11/18 -> three burns, acks required, permanent close, same-tier retry`() {
    val f = setupProtocol();
    val alice = testing.treasury("alice");
    val bob = testing.treasury("bob");
    val keeper = testing.treasury("keeper");

    expect(openRound(f.rc, f.admin, 0)).toHaveSuccessfulTx<OpenRound>({ from: f.admin, to: f.rc.address });
    stakeOk(f, 1, alice.address, AMOUNT_ALICE, 1);
    stakeOk(f, 1, bob.address, AMOUNT_BOB, 1);
    advance(STAKE_DURATION_SECONDS as int);
    expect(closeStaking(f.rc, f.admin, 0)).toHaveSuccessfulTx<CloseStaking>({ from: f.admin, to: f.rc.address });
    expect(startObservation(f.rc, keeper.address, 1)).toHaveSuccessfulTx<StartObservation>({ from: keeper.address, to: f.rc.address });

    submitAllCandles(f.rc, keeper.address, 1, 11, rcRound(f.rc, 1).targetPriceUsdE8);

    val settling = rcRound(f.rc, 1);
    expect(settling.status).toEqual(STATUS_SETTLING_FAILURE);
    expect(settling.qualifiedCandles).toEqual(11);
    // team burn ack comes back synchronously through TeamVault
    expect(settling.teamBurnConfirmed).toBeTrue();
    // reward + principal burns are requested from RC's own Jetton wallet
    val burns = mockState(f.rcWallet);
    expect(burns.burnCount).toEqual(2);
    expect(teamVaultState(f.tv).totalBurnedRaw).toEqual(TEAM_ROUND_RAW);

    expect(finalizeRound(f.rc, keeper.address, 1)).toHaveFailedTx<FinalizeRound>({
        from: keeper.address,
        to: f.rc.address,
        exitCode: Errors.BurnsNotConfirmed,
    });

    val status = burnStatus(f.rc, 1);
    expect(status.rewardBurnConfirmed).toBeFalse();
    expect(status.principalBurnConfirmed).toBeFalse();
    expect(status.teamBurnConfirmed).toBeTrue();
    val burnId = status.failureBurnId;

    // wrong amount is rejected
    expect(sendBurnAck(f.rc, f.jettonMaster, 1, BURN_KIND_REWARD, 123 as uint128, burnId))
        .toHaveFailedTx<BurnAck>({
            from: f.jettonMaster,
            to: f.rc.address,
            exitCode: Errors.BurnAmountMismatch,
        });
    // non-master ack is rejected
    val attacker = testing.treasury("attacker");
    expect(sendBurnAck(f.rc, attacker.address, 1, BURN_KIND_REWARD, ROUND_REWARD_RAW, burnId))
        .toHaveFailedTx<BurnAck>({
            from: attacker.address,
            to: f.rc.address,
            exitCode: Errors.NotJettonMaster,
        });

    // principal ack only -> still not finalizable
    expect(sendBurnAck(f.rc, f.jettonMaster, 1, BURN_KIND_PRINCIPAL, TOTAL_TWO as uint128, burnId))
        .toHaveSuccessfulTx<BurnAck>({ from: f.jettonMaster, to: f.rc.address });
    expect(finalizeRound(f.rc, keeper.address, 1)).toHaveFailedTx<FinalizeRound>({
        from: keeper.address,
        to: f.rc.address,
        exitCode: Errors.BurnsNotConfirmed,
    });
    // reward ack completes the set
    expect(sendBurnAck(f.rc, f.jettonMaster, 1, BURN_KIND_REWARD, ROUND_REWARD_RAW, burnId))
        .toHaveSuccessfulTx<BurnAck>({ from: f.jettonMaster, to: f.rc.address });

    expect(finalizeRound(f.rc, keeper.address, 1)).toHaveSuccessfulTx<FinalizeRound>({
        from: keeper.address,
        to: f.rc.address,
    });
    val failed = rcRound(f.rc, 1);
    expect(failed.status).toEqual(STATUS_FAILED_PERMANENT);
    expect(net.runGetMethod<uint8>(f.rc.address, "get_success_count")).toEqual(0);
    expect(teamVaultState(f.tv).totalReleasedRaw).toEqual(0 as uint128);

    // duplicate ack is idempotent
    expect(sendBurnAck(f.rc, f.jettonMaster, 1, BURN_KIND_REWARD, ROUND_REWARD_RAW, burnId))
        .toHaveSuccessfulTx<BurnAck>({ from: f.jettonMaster, to: f.rc.address });

    // failed round is not claimable
    expect(claimAll(f.rc, alice.address, 0)).toHaveSuccessfulTx<ClaimAll>({
        from: alice.address,
        to: f.rc.address,
    });
    expect(mockState(f.rcWallet).transferCount).toEqual(0);
    expect(claimReward(f.rc, alice.address, 1)).toHaveFailedTx<ClaimReward>({
        from: alice.address,
        to: f.rc.address,
        exitCode: Errors.NotClaimable,
    });

    // same tier retry: round 2 target is still 2 x P0 (tier unchanged)
    advance(86400 + 1);
    expect(openRound(f.rc, f.admin, 0)).toHaveSuccessfulTx<OpenRound>({ from: f.admin, to: f.rc.address });
    val r2 = rcRound(f.rc, 2);
    expect(r2.status).toEqual(STATUS_STAKING_OPEN);
    expect(r2.targetTier).toEqual(1);
    expect(r2.targetPriceUsdE8).toEqual(232000 as uint128);
}

// ===========================================================================
// 0-stake success (D-18b)
// ===========================================================================

get fun `test 0-stake success burns the round reward and still releases team quota`() {
    val f = setupProtocol();
    val keeper = testing.treasury("keeper");
    val target = openAndCloseFirstRound(f, 0);
    expect(startObservation(f.rc, keeper.address, 1)).toHaveSuccessfulTx<StartObservation>({ from: keeper.address, to: f.rc.address });
    submitAllCandles(f.rc, keeper.address, 1, 12, target);

    val settling = rcRound(f.rc, 1);
    expect(settling.status).toEqual(STATUS_SETTLING_SUCCESS);
    expect(settling.totalAcceptedStakeRaw).toEqual(0 as uint128);
    expect(settling.teamReleaseConfirmed).toBeTrue();
    expect(settling.rewardBurnConfirmed).toBeFalse();
    expect(mockState(f.rcWallet).burnCount).toEqual(1);
    expect(teamVaultState(f.tv).totalReleasedRaw).toEqual(TEAM_ROUND_RAW);

    expect(finalizeRound(f.rc, keeper.address, 1)).toHaveFailedTx<FinalizeRound>({
        from: keeper.address,
        to: f.rc.address,
        exitCode: Errors.RewardBurnNotConfirmed,
    });

    val status = burnStatus(f.rc, 1);
    expect(sendBurnAck(f.rc, f.jettonMaster, 1, BURN_KIND_REWARD, ROUND_REWARD_RAW, status.failureBurnId))
        .toHaveSuccessfulTx<BurnAck>({ from: f.jettonMaster, to: f.rc.address });
    expect(finalizeRound(f.rc, keeper.address, 1)).toHaveSuccessfulTx<FinalizeRound>({
        from: keeper.address,
        to: f.rc.address,
    });
    expect(rcRound(f.rc, 1).status).toEqual(STATUS_SUCCEEDED);
    expect(net.runGetMethod<uint8>(f.rc.address, "get_success_count")).toEqual(1);

    // nothing for anyone to claim
    val alice = testing.treasury("alice");
    expect(claimAll(f.rc, alice.address, 0)).toHaveSuccessfulTx<ClaimAll>({
        from: alice.address,
        to: f.rc.address,
    });
    expect(mockState(f.rcWallet).transferCount).toEqual(0);
}

// ===========================================================================
// Technical abort
// ===========================================================================

get fun `test technical abort after 14 days of oracle pause refunds principal, no burns, tier unchanged`() {
    val f = setupProtocol();
    val alice = testing.treasury("alice");
    val keeper = testing.treasury("keeper");

    expect(openRound(f.rc, f.admin, 0)).toHaveSuccessfulTx<OpenRound>({ from: f.admin, to: f.rc.address });
    stakeOk(f, 1, alice.address, AMOUNT_ALICE, 1);
    advance(STAKE_DURATION_SECONDS as int);
    expect(closeStaking(f.rc, f.admin, 0)).toHaveSuccessfulTx<CloseStaking>({ from: f.admin, to: f.rc.address });
    expect(startObservation(f.rc, keeper.address, 1)).toHaveSuccessfulTx<StartObservation>({ from: keeper.address, to: f.rc.address });

    expect(pauseOracle(f.rc, f.oracle)).toHaveSuccessfulTx<PauseOracle>({ from: f.oracle, to: f.rc.address });
    expect(rcStatus(f.rc, 1)).toEqual(STATUS_ORACLE_PAUSED);
    expect(abortTechnical(f.rc, alice.address)).toHaveFailedTx<AbortTechnical>({
        from: alice.address,
        to: f.rc.address,
        exitCode: Errors.TooEarly,
    });

    advance(TECH_ABORT_PAUSE_SECONDS as int);
    expect(abortTechnical(f.rc, alice.address)).toHaveSuccessfulTx<AbortTechnical>({
        from: alice.address,
        to: f.rc.address,
    });
    val aborted = rcRound(f.rc, 1);
    expect(aborted.status).toEqual(STATUS_TECHNICAL_ABORTED);
    expect(mockState(f.rcWallet).burnCount).toEqual(0);
    expect(teamVaultState(f.tv).totalBurnedRaw).toEqual(0 as uint128);

    // principal claimable, reward not
    val claimable = rcClaimable(f.rc, alice.address);
    expect(claimable.principalRaw).toEqual(AMOUNT_ALICE as uint128);
    expect(claimable.rewardRaw).toEqual(0 as uint128);
    expect(claimAll(f.rc, alice.address, 0)).toHaveSuccessfulTx<ClaimAll>({
        from: alice.address,
        to: f.rc.address,
    });
    expect(mockState(f.rcWallet).transferCount).toEqual(1);
    expect(mockState(f.rcWallet).lastTransferAmount).toEqual(AMOUNT_ALICE);

    // tier not consumed: round 2 uses the same tier 1
    advance(86400 + 1);
    expect(openRound(f.rc, f.admin, 0)).toHaveSuccessfulTx<OpenRound>({ from: f.admin, to: f.rc.address });
    expect(rcRound(f.rc, 2).targetTier).toEqual(1);
    expect(rcRound(f.rc, 2).targetPriceUsdE8).toEqual(232000 as uint128);
}

get fun `test technical abort after observation timeout (7 days) is permissionless`() {
    val f = setupProtocol();
    val alice = testing.treasury("alice");
    val keeper = testing.treasury("keeper");

    expect(openRound(f.rc, f.admin, 0)).toHaveSuccessfulTx<OpenRound>({ from: f.admin, to: f.rc.address });
    stakeOk(f, 1, alice.address, AMOUNT_ALICE, 1);
    advance(STAKE_DURATION_SECONDS as int);
    expect(closeStaking(f.rc, f.admin, 0)).toHaveSuccessfulTx<CloseStaking>({ from: f.admin, to: f.rc.address });
    expect(startObservation(f.rc, keeper.address, 1)).toHaveSuccessfulTx<StartObservation>({ from: keeper.address, to: f.rc.address });

    // only 3 candles arrive, then the window times out
    submitCandle(f.rc, keeper.address, 1, 0, 300000);
    submitCandle(f.rc, keeper.address, 1, 1, 300000);
    submitCandle(f.rc, keeper.address, 1, 2, 300000);
    advance(259200 - 3 * 14400);
    expect(abortTechnical(f.rc, alice.address)).toHaveFailedTx<AbortTechnical>({
        from: alice.address,
        to: f.rc.address,
        exitCode: Errors.TooEarly,
    });
    advance(TECH_ABORT_OBS_TIMEOUT_SECONDS as int + 1);
    expect(abortTechnical(f.rc, alice.address)).toHaveSuccessfulTx<AbortTechnical>({
        from: alice.address,
        to: f.rc.address,
    });
    expect(rcStatus(f.rc, 1)).toEqual(STATUS_TECHNICAL_ABORTED);
    expect(rcClaimable(f.rc, alice.address).principalRaw).toEqual(AMOUNT_ALICE as uint128);
}

// ===========================================================================
// Pause / resume restarts the observation window
// ===========================================================================

get fun `test pause then resume restarts a full 18-candle observation`() {
    val f = setupProtocol();
    val alice = testing.treasury("alice");
    val keeper = testing.treasury("keeper");

    val target = openAndCloseFirstRound(f, 0);
    stakeOk(f, 1, alice.address, AMOUNT_ALICE, 1);
    expect(startObservation(f.rc, keeper.address, 1)).toHaveSuccessfulTx<StartObservation>({ from: keeper.address, to: f.rc.address });

    expect(submitCandle(f.rc, keeper.address, 1, 0, target)).toHaveSuccessfulTx<SubmitCandle>({ from: keeper.address, to: f.rc.address });
    expect(submitCandle(f.rc, keeper.address, 1, 1, target)).toHaveSuccessfulTx<SubmitCandle>({ from: keeper.address, to: f.rc.address });
    expect(submitCandle(f.rc, keeper.address, 1, 2, target)).toHaveSuccessfulTx<SubmitCandle>({ from: keeper.address, to: f.rc.address });
    expect(rcRound(f.rc, 1).candlesSeen).toEqual(3);

    expect(pauseOracle(f.rc, f.oracle)).toHaveSuccessfulTx<PauseOracle>({ from: f.oracle, to: f.rc.address });
    expect(resumeOracle(f.rc, f.oracle)).toHaveSuccessfulTx<ResumeOracle>({ from: f.oracle, to: f.rc.address });
    val resumed = rcRound(f.rc, 1);
    expect(resumed.status).toEqual(STATUS_OBSERVING);
    expect(resumed.candlesSeen).toEqual(0);
    expect(resumed.qualifiedCandles).toEqual(0);

    submitAllCandles(f.rc, keeper.address, 1, 12, target);
    expect(rcRound(f.rc, 1).status).toEqual(STATUS_SETTLING_SUCCESS);
}

// ===========================================================================
// Candle validation
// ===========================================================================

get fun `test candle validation: index, period, duplicate, not closed yet`() {
    val f = setupProtocol();
    val keeper = testing.treasury("keeper");
    val target = openAndCloseFirstRound(f, 0);
    expect(startObservation(f.rc, keeper.address, 1)).toHaveSuccessfulTx<StartObservation>({ from: keeper.address, to: f.rc.address });

    val rd = rcRound(f.rc, 1);
    val start = rd.observationStart;
    testing.setNow(start as uint32);

    // index 18 is out of range (checked before time bounds)
    expect(net.send(f.admin, createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: f.rc.address,
        body: SubmitCandle {
            queryId: 0,
            roundId: 1,
            candleIndex: 18,
            periodStart: start as uint32,
            periodEnd: (start + 14400) as uint32,
            twapPriceUsdE8: target,
            dataDigest: 0 as uint256,
        },
    }))).toHaveFailedTx<SubmitCandle>({
        from: f.admin,
        to: f.rc.address,
        exitCode: Errors.CandleIndexOutOfRange,
    });

    // candle period not finished yet (now == periodStart)
    expect(net.send(f.admin, createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: f.rc.address,
        body: SubmitCandle {
            queryId: 0,
            roundId: 1,
            candleIndex: 0,
            periodStart: start as uint32,
            periodEnd: (start + 14400) as uint32,
            twapPriceUsdE8: target,
            dataDigest: 0 as uint256,
        },
    }))).toHaveFailedTx<SubmitCandle>({
        from: f.admin,
        to: f.rc.address,
        exitCode: Errors.CandleNotClosedYet,
    });

    // period mismatch (time moves forward only)
    testing.setNow((start + 14400) as uint32);
    expect(net.send(f.admin, createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: f.rc.address,
        body: SubmitCandle {
            queryId: 0,
            roundId: 1,
            candleIndex: 0,
            periodStart: (start + 1) as uint32,
            periodEnd: (start + 14401) as uint32,
            twapPriceUsdE8: target,
            dataDigest: 0 as uint256,
        },
    }))).toHaveFailedTx<SubmitCandle>({
        from: f.admin,
        to: f.rc.address,
        exitCode: Errors.CandlePeriodMismatch,
    });

    // valid then duplicate
    expect(submitCandle(f.rc, keeper.address, 1, 0, target)).toHaveSuccessfulTx<SubmitCandle>({
        from: keeper.address,
        to: f.rc.address,
    });
    expect(submitCandle(f.rc, keeper.address, 1, 0, target)).toHaveFailedTx<SubmitCandle>({
        from: keeper.address,
        to: f.rc.address,
        exitCode: Errors.CandleAlreadySeen,
    });
}

get fun `test 17 candles is not enough to settle; 18th decides`() {
    val f = setupProtocol();
    val keeper = testing.treasury("keeper");
    val target = openAndCloseFirstRound(f, 0);
    expect(startObservation(f.rc, keeper.address, 1)).toHaveSuccessfulTx<StartObservation>({ from: keeper.address, to: f.rc.address });

    var i: uint8 = 0;
    while (i < 17) {
        expect(submitCandle(f.rc, keeper.address, 1, i, target)).toHaveSuccessfulTx<SubmitCandle>({
            from: keeper.address,
            to: f.rc.address,
        });
        i += 1;
    }
    expect(rcStatus(f.rc, 1)).toEqual(STATUS_OBSERVING);
    expect(submitCandle(f.rc, keeper.address, 1, 17, target)).toHaveSuccessfulTx<SubmitCandle>({
        from: keeper.address,
        to: f.rc.address,
    });
    expect(rcStatus(f.rc, 1)).toEqual(STATUS_SETTLING_SUCCESS);
}

// ===========================================================================
// Early close on touch price
// ===========================================================================

get fun `test touch-price early close and refunds after close`() {
    val f = setupProtocol();
    val alice = testing.treasury("alice");
    expect(openRound(f.rc, f.admin, 0)).toHaveSuccessfulTx<OpenRound>({ from: f.admin, to: f.rc.address });
    val target = rcRound(f.rc, 1).targetPriceUsdE8;
    val openAt = rcRound(f.rc, 1).stakeOpenAt;

    advance(3600);
    // below target -> cannot close early
    expect(closeStaking(f.rc, f.admin, target - 1)).toHaveFailedTx<CloseStaking>({
        from: f.admin,
        to: f.rc.address,
        exitCode: Errors.TooEarly,
    });
    expect(closeStaking(f.rc, f.admin, target)).toHaveSuccessfulTx<CloseStaking>({
        from: f.admin,
        to: f.rc.address,
    });
    val rd = rcRound(f.rc, 1);
    expect(rd.status).toEqual(STATUS_STAKING_CLOSED);
    expect(rd.stakeCloseAt).toEqual(openAt + 3600);
    expect(rd.observationStart).toEqual(openAt + 3600);
    expect(rd.observationEnd).toEqual(openAt + 3600 + 259200);

    // staking after early close is refunded
    expect(sendStake(f.rc, f.rcWallet.address, alice.address, AMOUNT_ALICE, buildStakePayload(1, 1, 1, 1)))
        .toHaveSuccessfulTx<TransferNotification>({ from: f.rcWallet.address, to: f.rc.address });
    expect(rcUserStake(f.rc, 1, alice.address).amountRaw).toEqual(0 as uint128);
    expect(mockState(f.rcWallet).transferCount).toEqual(1);
}
