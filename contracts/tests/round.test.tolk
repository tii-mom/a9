// v10 RoundController: lifecycle, settlement, claims, refunds, aborts (real Jetton).
import "@acton/emulation/network"
import "@acton/emulation/testing"
import "@acton/testing/expect"
import "@acton/types/transaction"
import "@contracts/constants"
import "@contracts/types"
import "helpers"

get fun `test deploy derives its own jetton wallet and holds the funding`() {
    val env = setup();
    val c = net.runGetMethod<ProtocolConfigView>(env.rc, "get_protocol_config");
    expect(c.stakingJettonWallet).toEqual(env.rcWallet);
    expect(c.admin).toEqual(env.keeper);
    expect(c.teamVault).toEqual(env.teamWallet);
    expect(c.maxStakePerAddressBps).toEqual(1000);
    expect(c.observationSeconds).toEqual(86400);
    expect(currentRound(env)).toEqual(0);
    expect(balanceOf(env, env.rc)).toEqual(RC_FUNDING);
}

get fun `test only the keeper opens rounds and target is max(ladder, 2x twap)`() {
    val env = setup();
    val alice = user(env, "alice", MIN_STAKE);
    expect(openRound(env, alice, P0)).toHaveFailedTx<OpenRound>({ to: env.rc, exitCode: Errors.NotKeeper });
    openNext(env, 100000); // 2 * 100000 < 232000 ladder
    expect(round(env, 1).targetPriceUsdE8).toEqual(232000);
    expect(round(env, 1).status).toEqual(STATUS_STAKING_OPEN);
    expect(round(env, 1).stakeCloseAt).toEqual((T0 as uint64) + (STAKE_WINDOW as uint64));
}

get fun `test target follows a high opening twap`() {
    val env = setup();
    openNext(env, 500000);
    expect(round(env, 1).targetPriceUsdE8).toEqual(1000000);
}

get fun `test deposit before round 1 is refunded instantly`() {
    val env = setup();
    val alice = user(env, "alice", MIN_STAKE);
    stake(env, alice, 1, MIN_STAKE, 1);
    expect(balanceOf(env, alice)).toEqual(MIN_STAKE);
    expect(balanceOf(env, env.rc)).toEqual(RC_FUNDING);
}

get fun `test valid deposits are recorded and capped`() {
    val env = setup();
    openNext(env, 0);
    val alice = user(env, "alice", MAX_PER_ADDRESS + MIN_STAKE);
    expect(stake(env, alice, 1, MIN_STAKE, 1)).toHaveSuccessfulTx<TransferNotification>({ to: env.rc });
    expect(stakedAmount(env, 1, alice)).toEqual(MIN_STAKE as uint128);
    // same nonce -> refunded
    stake(env, alice, 1, MIN_STAKE, 1);
    expect(stakedAmount(env, 1, alice)).toEqual(MIN_STAKE as uint128);
    // over the per-address cap -> refunded
    stake(env, alice, 1, MAX_PER_ADDRESS, 2);
    expect(stakedAmount(env, 1, alice)).toEqual(MIN_STAKE as uint128);
    // up to the cap -> accepted
    stake(env, alice, 1, MAX_PER_ADDRESS - MIN_STAKE, 3);
    expect(stakedAmount(env, 1, alice)).toEqual(MAX_PER_ADDRESS as uint128);
    expect(balanceOf(env, alice)).toEqual(MIN_STAKE);
    expect(round(env, 1).totalAcceptedStakeRaw).toEqual(MAX_PER_ADDRESS as uint128);
    expect(net.runGetMethod<uint16>(env.rc, "get_round_staker_count", [1 as uint8])).toEqual(1);
}

get fun `test invalid deposits are refunded`() {
    val env = setup();
    openNext(env, 0);
    val bob = user(env, "bob", MIN_STAKE * 3);
    stake(env, bob, 1, MIN_STAKE - 1, 1);                                   // below minimum
    stakeRaw(env, bob, MIN_STAKE, stakePayload(2, 1, 1, 1), ton("0.15"));   // wrong round
    stakeRaw(env, bob, MIN_STAKE, stakePayload(1, 1, 9, 1), ton("0.15"));   // wrong risk version
    stakeRaw(env, bob, MIN_STAKE, stakePayload(1, 1, 1, 0), ton("0.15"));   // burn not accepted
    stakeRaw(env, bob, MIN_STAKE, emptyPayload(), ton("0.15"));             // no payload
    expect(balanceOf(env, bob)).toEqual(MIN_STAKE * 3);
    expect(stakedAmount(env, 1, bob)).toEqual(0);
    advanceTo((T0 as uint64) + (STAKE_WINDOW as uint64));
    stake(env, bob, 1, MIN_STAKE, 1);                                       // window over
    expect(balanceOf(env, bob)).toEqual(MIN_STAKE * 3);
}

get fun `test total cap refunds the overflowing deposit`() {
    val env = setup();
    openNext(env, 0);
    var i = 0;
    while (i < 10) {
        val u = address.fromWorkchainAndHash(0, 555000 + i * 1000003);
        transfer(env.treasury, env.treasuryWallet, u, MAX_PER_ADDRESS, 0, emptyPayload(), ton("0.2"));
        stake(env, u, 1, MAX_PER_ADDRESS, 1);
        i += 1;
    }
    expect(round(env, 1).totalAcceptedStakeRaw).toEqual(MAX_TOTAL as uint128);
    val late = user(env, "late", MIN_STAKE);
    stake(env, late, 1, MIN_STAKE, 1);
    expect(balanceOf(env, late)).toEqual(MIN_STAKE);
}

get fun `test refund without TON goes to the ledger and dust is kept`() {
    val env = setup();
    openNext(env, 0);
    val carol = user(env, "carol", MIN_STAKE * 2);
    // forward TON below 0.1 and wrong round -> ledger credit (>= minStake)
    stakeRaw(env, carol, MIN_STAKE, stakePayload(2, 1, 1, 1), ton("0.05"));
    expect(balanceOf(env, carol)).toEqual(MIN_STAKE);
    expect(stakedAmount(env, 0, carol)).toEqual(MIN_STAKE as uint128);
    expect(claimable(env, carol).principalRaw).toEqual(MIN_STAKE as uint128);
    expect(claim(env, carol, 0)).toHaveSuccessfulTx<Claim>({ to: env.rc });
    expect(balanceOf(env, carol)).toEqual(MIN_STAKE * 2);
    expect(stakedAmount(env, 0, carol)).toEqual(0);
    expect(claim(env, carol, 0)).toHaveFailedTx<Claim>({ to: env.rc, exitCode: Errors.NothingToClaim });
    // dust below the minimum without TON is kept by the contract
    stakeRaw(env, carol, 5 * A9, stakePayload(2, 1, 1, 1), ton("0.05"));
    expect(stakedAmount(env, 0, carol)).toEqual(0);
    expect(balanceOf(env, carol)).toEqual(MIN_STAKE * 2 - 5 * A9);
}

get fun `test candles are keeper-only, ordered, aligned and closed`() {
    val env = setup();
    openNext(env, 0);
    val rd = round(env, 1);
    val alice = user(env, "alice", MIN_STAKE);
    advanceTo(rd.stakeCloseAt + (CANDLE as uint64));
    expect(submitCandle(env, alice, 1, 0, rd.targetPriceUsdE8)).toHaveFailedTx<SubmitCandle>({ to: env.rc, exitCode: Errors.NotKeeper });
    expect(submitCandle(env, env.keeper, 1, 1, rd.targetPriceUsdE8)).toHaveFailedTx<SubmitCandle>({ to: env.rc, exitCode: Errors.CandleOutOfOrder });
    expect(submitCandle(env, env.keeper, 1, 0, 0)).toHaveFailedTx<SubmitCandle>({ to: env.rc, exitCode: Errors.CandleBadPrice });
    expect(submitCandle(env, env.keeper, 1, 0, rd.targetPriceUsdE8)).toHaveSuccessfulTx<SubmitCandle>({ to: env.rc });
    expect(round(env, 1).status).toEqual(STATUS_OBSERVING);
    expect(submitCandle(env, env.keeper, 1, 1, rd.targetPriceUsdE8)).toHaveFailedTx<SubmitCandle>({ to: env.rc, exitCode: Errors.CandleNotClosedYet });
}

get fun `test anyone closes staking after the window`() {
    val env = setup();
    openNext(env, 0);
    val alice = user(env, "alice", MIN_STAKE);
    val close = createMessage({ bounce: true, value: ton("0.1"), dest: env.rc, body: CloseStaking { queryId: 1, twap1hUsdE8: 0 } });
    expect(net.send(alice, close)).toHaveFailedTx<CloseStaking>({ to: env.rc, exitCode: Errors.TooEarly });
    advanceTo(round(env, 1).stakeCloseAt);
    expect(net.send(alice, close)).toHaveSuccessfulTx<CloseStaking>({ to: env.rc });
    expect(round(env, 1).status).toEqual(STATUS_OBSERVING);
}

get fun `test success pays principal plus pro-rata reward and releases team quota`() {
    val env = setup();
    openNext(env, 0);
    val alice = user(env, "alice", MIN_STAKE * 3);
    val bob = user(env, "bob", MIN_STAKE);
    stake(env, alice, 1, MIN_STAKE * 3, 1);
    stake(env, bob, 1, MIN_STAKE, 1);
    val supply = totalSupply(env);
    observe(env, MIN_QUALIFIED);

    val rd = round(env, 1);
    expect(rd.status).toEqual(STATUS_SUCCEEDED);
    expect(rd.teamReleaseConfirmed).toEqual(true);
    expect(balanceOf(env, env.teamWallet)).toEqual(TEAM_ROUND);
    expect(totalSupply(env)).toEqual(supply);
    expect(round(env, 2).status).toEqual(STATUS_PREVIEW);
    expect(round(env, 2).stakeOpenAt).toEqual(rd.settledAt + (PREVIEW as uint64));
    expect(net.runGetMethod<uint8>(env.rc, "get_success_count")).toEqual(1);

    val aliceReward = ROUND_REWARD * 3 / 4;
    expect(claimable(env, alice).rewardRaw).toEqual(aliceReward as uint128);
    expect(claimable(env, alice).roundsMask).toEqual(1);
    expect(claim(env, alice, 1)).toHaveSuccessfulTx<Claim>({ to: env.rc });
    expect(balanceOf(env, alice)).toEqual(MIN_STAKE * 3 + aliceReward);
    expect(claim(env, alice, 1)).toHaveFailedTx<Claim>({ to: env.rc, exitCode: Errors.NothingToClaim });
    expect(claimAll(env, bob)).toHaveSuccessfulTx<ClaimAll>({ to: env.rc });
    expect(balanceOf(env, bob)).toEqual(MIN_STAKE + ROUND_REWARD / 4);
    expect(balanceOf(env, env.rc)).toEqual(RC_FUNDING - ROUND_REWARD - TEAM_ROUND);
}

get fun `test failure burns reward team and principal in one burn`() {
    val env = setup();
    openNext(env, 0);
    val alice = user(env, "alice", MIN_STAKE * 2);
    stake(env, alice, 1, MIN_STAKE * 2, 1);
    val supply = totalSupply(env);
    observe(env, MIN_QUALIFIED - 1);

    val rd = round(env, 1);
    expect(rd.status).toEqual(STATUS_FAILED_PERMANENT);
    expect(rd.rewardBurnConfirmed).toEqual(true);
    expect(rd.principalBurnConfirmed).toEqual(true);
    expect(totalSupply(env)).toEqual(supply - ROUND_REWARD - TEAM_ROUND - MIN_STAKE * 2);
    expect(balanceOf(env, env.rc)).toEqual(RC_FUNDING - ROUND_REWARD - TEAM_ROUND);
    expect(balanceOf(env, env.teamWallet)).toEqual(0);
    expect(claim(env, alice, 1)).toHaveFailedTx<Claim>({ to: env.rc, exitCode: Errors.NothingToClaim });
    // same tier retry
    openNext(env, 0);
    expect(round(env, 2).targetTier).toEqual(1);
    expect(round(env, 2).targetPriceUsdE8).toEqual(232000);
}

get fun `test zero-stake success burns the reward and releases the team quota`() {
    val env = setup();
    openNext(env, 0);
    val supply = totalSupply(env);
    observe(env, CANDLES);
    expect(round(env, 1).status).toEqual(STATUS_SUCCEEDED);
    expect(totalSupply(env)).toEqual(supply - ROUND_REWARD);
    expect(balanceOf(env, env.teamWallet)).toEqual(TEAM_ROUND);
    openNext(env, 0);
    expect(round(env, 2).targetTier).toEqual(2);
    expect(round(env, 2).targetPriceUsdE8).toEqual(464000);
}

get fun `test zero-stake failure burns reward and team quota`() {
    val env = setup();
    openNext(env, 0);
    val supply = totalSupply(env);
    observe(env, 0);
    expect(round(env, 1).status).toEqual(STATUS_FAILED_PERMANENT);
    expect(totalSupply(env)).toEqual(supply - ROUND_REWARD - TEAM_ROUND);
}

get fun `test observation timeout abort refunds principal and burns nothing`() {
    val env = setup();
    openNext(env, 0);
    val alice = user(env, "alice", MIN_STAKE);
    stake(env, alice, 1, MIN_STAKE, 1);
    val rd = round(env, 1);
    val abort = createMessage({ bounce: true, value: ton("0.1"), dest: env.rc, body: AbortTechnical { queryId: 1 } });
    advanceTo(rd.observationEnd + (ABORT_TIMEOUT as uint64) - 1);
    expect(net.send(alice, abort)).toHaveFailedTx<AbortTechnical>({ to: env.rc, exitCode: Errors.TooEarly });
    advanceTo(rd.observationEnd + (ABORT_TIMEOUT as uint64));
    val supply = totalSupply(env);
    expect(net.send(alice, abort)).toHaveSuccessfulTx<AbortTechnical>({ to: env.rc });
    expect(round(env, 1).status).toEqual(STATUS_TECHNICAL_ABORTED);
    expect(round(env, 2).status).toEqual(STATUS_PREVIEW);
    expect(claimable(env, alice).rewardRaw).toEqual(0);
    expect(claimAll(env, alice)).toHaveSuccessfulTx<ClaimAll>({ to: env.rc });
    expect(balanceOf(env, alice)).toEqual(MIN_STAKE);
    expect(totalSupply(env)).toEqual(supply);
    openNext(env, 0);
    expect(round(env, 2).targetTier).toEqual(1);
}

get fun `test preview timeout abort advances past a dead keeper`() {
    val env = setup();
    openNext(env, 0);
    observe(env, MIN_QUALIFIED);
    val next = round(env, 2);
    val abort = createMessage({ bounce: true, value: ton("0.1"), dest: env.rc, body: AbortTechnical { queryId: 1 } });
    advanceTo(next.stakeOpenAt + (ABORT_TIMEOUT as uint64));
    expect(net.send(env.treasury, abort)).toHaveSuccessfulTx<AbortTechnical>({ to: env.rc });
    expect(currentRound(env)).toEqual(2);
    expect(round(env, 2).status).toEqual(STATUS_TECHNICAL_ABORTED);
    expect(round(env, 3).status).toEqual(STATUS_PREVIEW);
}

get fun `test bounced settlement is retried by anyone`() {
    // RC wallet underfunded: both the team transfer and the reward burn bounce.
    val env = setupWith(A9);
    openNext(env, 0);
    val supply = totalSupply(env);
    observe(env, CANDLES);
    val rd = round(env, 1);
    expect(rd.status).toEqual(STATUS_SUCCEEDED);
    expect(rd.teamReleaseConfirmed).toEqual(false);
    expect(rd.rewardBurnConfirmed).toEqual(false);
    expect(balanceOf(env, env.teamWallet)).toEqual(0);
    expect(totalSupply(env)).toEqual(supply);
    // the round already settled: the next round is not blocked by the bounce
    expect(round(env, 2).status).toEqual(STATUS_PREVIEW);

    val retry = createMessage({ bounce: true, value: ton("0.5"), dest: env.rc, body: RetrySettlement { queryId: 1, roundId: 1 } });
    transfer(env.treasury, env.treasuryWallet, env.rc, ROUND_REWARD + TEAM_ROUND, 0, emptyPayload(), ton("0.2"));
    expect(net.send(env.treasury, retry)).toHaveSuccessfulTx<RetrySettlement>({ to: env.rc });
    expect(balanceOf(env, env.teamWallet)).toEqual(TEAM_ROUND);
    expect(totalSupply(env)).toEqual(supply - ROUND_REWARD);
    expect(round(env, 1).teamReleaseConfirmed).toEqual(true);
    expect(round(env, 1).rewardBurnConfirmed).toEqual(true);
    expect(net.send(env.treasury, retry)).toHaveFailedTx<RetrySettlement>({ to: env.rc, exitCode: Errors.NothingToRetry });
}

get fun `test claim needs enough TON and nothing is claimable while observing`() {
    val env = setup();
    openNext(env, 0);
    val alice = user(env, "alice", MIN_STAKE);
    stake(env, alice, 1, MIN_STAKE, 1);
    expect(claim(env, alice, 1)).toHaveFailedTx<Claim>({ to: env.rc, exitCode: Errors.NothingToClaim });
    val cheap = createMessage({ bounce: true, value: ton("0.05"), dest: env.rc, body: ClaimAll { queryId: 1, roundId: 0 } });
    expect(net.send(alice, cheap)).toHaveFailedTx<ClaimAll>({ to: env.rc, exitCode: Errors.NotEnoughValue });
}

get fun `test ten rounds with claims across rounds then round 11 is rejected`() {
    val env = setup();
    val alice = user(env, "alice", MIN_STAKE * 10);
    var r: uint8 = 1;
    var expectedReward: coins = 0;
    while (r <= MAX_ROUNDS) {
        openNext(env, 0);
        stake(env, alice, r, MIN_STAKE, 1);
        // odd rounds succeed, even rounds fail
        observe(env, (r % 2 == 1) ? MIN_QUALIFIED : 0);
        if (r % 2 == 1) {
            expectedReward += ROUND_REWARD;
        }
        r += 1;
    }
    expect(net.runGetMethod<uint8>(env.rc, "get_success_count")).toEqual(5);
    expect(round(env, 10).status).toEqual(STATUS_FAILED_PERMANENT);
    expect(openRound(env, env.keeper, 0)).toHaveFailedTx<OpenRound>({ to: env.rc, exitCode: Errors.MaxRoundsReached });
    val c = claimable(env, alice);
    expect(c.principalRaw).toEqual((MIN_STAKE * 5) as uint128);
    expect(c.rewardRaw).toEqual(expectedReward as uint128);
    expect(c.roundsMask).toEqual(0x155);
    expect(claimAll(env, alice)).toHaveSuccessfulTx<ClaimAll>({ to: env.rc });
    expect(balanceOf(env, alice)).toEqual(MIN_STAKE * 5 + expectedReward);
    // 5 successes: 5 team releases + 5 rewards paid; 5 failures: reward+team burned
    expect(balanceOf(env, env.rc)).toEqual(0);
    expect(balanceOf(env, env.teamWallet)).toEqual(TEAM_ROUND * 5);
}

get fun `test standard TEP-74 transfers with third-party response destination work (DEX payouts)`() {
    val env = setup();
    val router = user(env, "dex-router", MIN_STAKE);
    val buyer = testing.treasury("dex-buyer").address;
    // STON.fi-style payout: response_destination = buyer, not the wallet owner
    net.send(router, createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: walletOf(env.master, router),
        body: AskToTransferMsg {
            queryId: 9,
            jettonAmount: MIN_STAKE,
            transferRecipient: buyer,
            sendExcessesTo: buyer,
            customPayload: null,
            forwardTonAmount: 0,
            forwardPayload: emptyPayload(),
        },
    }));
    expect(balanceOf(env, buyer)).toEqual(MIN_STAKE);
}

get fun `test masterchain claimer is rejected before anything is marked`() {
    val env = setup();
    val mc = address.fromWorkchainAndHash(-1, 4242);
    expect(claimAll(env, mc)).toHaveFailedTx<ClaimAll>({ to: env.rc, exitCode: Errors.WrongWorkchain });
}

get fun `test storage per staker stays at about two cells`() {
    val env = setup();
    openNext(env, 0);
    val before = testing.getAccountState(env.rc)!.storageStat.used.cells;
    var i = 0;
    while (i < 100) {
        val u = address.fromWorkchainAndHash(0, 777000 + i * 1000003);
        transfer(env.treasury, env.treasuryWallet, u, MIN_STAKE, 0, emptyPayload(), ton("0.2"));
        stake(env, u, 1, MIN_STAKE, 1);
        i += 1;
    }
    val after = testing.getAccountState(env.rc)!.storageStat.used.cells;
    // 100 positions -> ~200 cells (dictionary leaf + fork). Worst case: 10 rounds x
    // (2e8 / 1e5) positions x 2 = 40,000 cells < 65,536 account limit.
    expect((after - before) <= 205).toEqual(true);
    expect((after - before) >= 190).toEqual(true);
}
