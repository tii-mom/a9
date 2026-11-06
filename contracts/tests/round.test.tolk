// v11 RoundController + StakeTicket: lifecycle, timing weight, tickets, unlock chain,
// rollover, delayed team quota, restake, aborts, retries (real Jetton contracts).
import "@acton/emulation/network"
import "@acton/emulation/testing"
import "@acton/testing/expect"
import "@acton/types/transaction"
import "@contracts/constants"
import "@contracts/types"
import "@contracts/ticket"
import "helpers"

fun immediateOf(reward: coins): coins { return reward * IMMEDIATE_SHARE / 10000; }

get fun `test deploy derives its own jetton wallet, no caps, holds the funding`() {
    val env = setup();
    val c = net.runGetMethod<ProtocolConfigView>(env.rc, "get_protocol_config");
    expect(c.stakingJettonWallet).toEqual(env.rcWallet);
    expect(c.admin).toEqual(env.keeper);
    expect(c.teamVault).toEqual(env.teamWallet);
    expect(c.maxStakePerAddressBps).toEqual(0);
    expect(c.maxTotalStakeRaw).toEqual(0);
    expect(c.minStakeRaw).toEqual(MIN_STAKE as uint128);
    expect(currentRound(env)).toEqual(0);
    expect(balanceOf(env, env.rc)).toEqual(RC_FUNDING);
}

get fun `test only the keeper opens rounds and target is max(ladder, 2x twap)`() {
    val env = setup();
    val alice = user(env, "alice", MIN_STAKE);
    expect(openRound(env, alice, P0)).toHaveFailedTx<OpenRound>({ to: env.rc, exitCode: Errors.NotKeeper });
    openNext(env, 100000);
    expect(round(env, 1).targetPriceUsdE8).toEqual(232000);
    expect(round(env, 1).status).toEqual(STATUS_STAKING_OPEN);
    expect(round(env, 1).rewardBudgetRaw).toEqual(ROUND_REWARD as uint128);
}

get fun `test target follows a high opening twap`() {
    val env = setup();
    openNext(env, 500000);
    expect(round(env, 1).targetPriceUsdE8).toEqual(1000000);
}

get fun `test deposit before round 1 is refunded instantly`() {
    val env = setup();
    val alice = user(env, "alice", MIN_STAKE);
    stake(env, alice, 1, MIN_STAKE);
    expect(balanceOf(env, alice)).toEqual(MIN_STAKE);
    expect(balanceOf(env, env.rc)).toEqual(RC_FUNDING);
}

get fun `test deposit creates a ticket; weight follows the timing thirds; no caps`() {
    val env = setup();
    openNext(env, 0);
    val big: coins = ROUND_REWARD * 2; // far above any v10 cap
    val alice = user(env, "alice", big + MIN_STAKE * 2);
    expect(stake(env, alice, 1, big)).toHaveSuccessfulTx<TransferNotification>({ to: env.rc });
    var t = ticketData(env, alice, 1);
    expect(t.owner).toEqual(alice);
    expect(t.roundId).toEqual(1);
    expect(t.amountRaw).toEqual(big as uint128);
    expect(t.weightRaw).toEqual((big * 15000 / 10000) as uint128);
    // second third: x1.2, last third: x1.0 (same ticket accumulates)
    advanceTo((T0 as uint64) + (STAKE_WINDOW as uint64) / 3);
    stake(env, alice, 1, MIN_STAKE);
    advanceTo((T0 as uint64) + (STAKE_WINDOW as uint64) * 2 / 3);
    stake(env, alice, 1, MIN_STAKE);
    t = ticketData(env, alice, 1);
    expect(t.amountRaw).toEqual((big + MIN_STAKE * 2) as uint128);
    expect(t.weightRaw).toEqual((big * 15000 / 10000 + MIN_STAKE * 12000 / 10000 + MIN_STAKE) as uint128);
    val rd = round(env, 1);
    expect(rd.totalAcceptedStakeRaw).toEqual((big + MIN_STAKE * 2) as uint128);
    expect(rd.totalWeight).toEqual(t.weightRaw);
    expect(net.runGetMethod<uint32>(env.rc, "get_round_staker_count", [1 as uint8])).toEqual(3);
}

get fun `test invalid deposits are refunded; without TON they are kept`() {
    val env = setup();
    openNext(env, 0);
    val bob = user(env, "bob", MIN_STAKE * 4);
    stake(env, bob, 1, MIN_STAKE - 1);                                      // below minimum
    stakeRaw(env, bob, MIN_STAKE, stakePayload(2, 1, 1), ton("0.15"));      // wrong round
    stakeRaw(env, bob, MIN_STAKE, stakePayload(1, 9, 1), ton("0.15"));      // wrong risk version
    stakeRaw(env, bob, MIN_STAKE, stakePayload(1, 1, 0), ton("0.15"));      // burn not accepted
    stakeRaw(env, bob, MIN_STAKE, emptyPayload(), ton("0.15"));             // no payload
    val mc = address.fromWorkchainAndHash(-1, 4242);
    stakeRaw(env, bob, MIN_STAKE, stakePayloadFor(1, 1, 1, mc), ton("0.15")); // masterchain beneficiary
    expect(balanceOf(env, bob)).toEqual(MIN_STAKE * 4);
    expect(ticketExists(env, bob, 1)).toEqual(false);
    // valid payload but forward TON below 0.1 -> not accepted, and kept (documented)
    stakeRaw(env, bob, MIN_STAKE, stakePayload(1, 1, 1), ton("0.05"));
    expect(balanceOf(env, bob)).toEqual(MIN_STAKE * 3);
    expect(ticketExists(env, bob, 1)).toEqual(false);
    advanceTo((T0 as uint64) + (STAKE_WINDOW as uint64));
    stake(env, bob, 1, MIN_STAKE);                                          // window over
    expect(balanceOf(env, bob)).toEqual(MIN_STAKE * 3);
}

get fun `test beneficiary owns the ticket and only the owner can claim`() {
    val env = setup();
    openNext(env, 0);
    val carol = user(env, "carol", MIN_STAKE);
    val dave = testing.treasury("dave").address;
    stakeFor(env, carol, dave, 1, MIN_STAKE);
    expect(ticketExists(env, carol, 1)).toEqual(false);
    expect(stakedAmount(env, 1, dave)).toEqual(MIN_STAKE as uint128);
    observe(env, MIN_QUALIFIED);
    // carol sends a claim to dave's ticket: refused by the ticket
    val forged = createMessage({ bounce: true, value: ton("0.2"), dest: ticketOf(env, dave, 1), body: TicketClaim { queryId: 1 } });
    expect(net.send(carol, forged)).toHaveFailedTx<TicketClaim>({ to: ticketOf(env, dave, 1), exitCode: Errors.NotOwner });
    expect(claimTicket(env, dave, 1)).toHaveSuccessfulTx<TicketRequest>({ to: env.rc });
    expect(balanceOf(env, dave)).toEqual(MIN_STAKE + immediateOf(ROUND_REWARD));
}

get fun `test a forged ticket request is rejected by the RC`() {
    val env = setup();
    openNext(env, 0);
    val alice = user(env, "alice", MIN_STAKE);
    stake(env, alice, 1, MIN_STAKE);
    observe(env, MIN_QUALIFIED);
    val req = createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: env.rc,
        body: TicketRequest {
            queryId: 1,
            owner: alice,
            roundId: 1,
            amountRaw: (MIN_STAKE * 1000) as uint128,
            weightRaw: (MIN_STAKE * 1000) as uint128,
            principalDone: false,
            lockedClaimedRaw: 0,
            restake: false,
        },
    });
    expect(net.send(alice, req)).toHaveFailedTx<TicketRequest>({ to: env.rc, exitCode: Errors.NotTicket });
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

get fun `test success pays principal + 20% now, 80% at the next success; team quota one round late`() {
    val env = setup();
    openNext(env, 0);
    val alice = user(env, "alice", MIN_STAKE * 3);
    val bob = user(env, "bob", MIN_STAKE);
    stake(env, alice, 1, MIN_STAKE * 3);
    stake(env, bob, 1, MIN_STAKE);
    val supply = totalSupply(env);
    observe(env, MIN_QUALIFIED);

    val rd = round(env, 1);
    expect(rd.status).toEqual(STATUS_SUCCEEDED);
    expect(totalSupply(env)).toEqual(supply);
    expect(balanceOf(env, env.teamWallet)).toEqual(0);            // D-47: not yet
    expect(pstate(env).teamPendingRaw).toEqual(TEAM_ROUND as uint128);
    expect(pstate(env).lastSuccessRound).toEqual(1);

    val aliceReward = ROUND_REWARD * 3 / 4;
    val p = preview(env, 1, ticketData(env, alice, 1).weightRaw);
    expect(p.rewardRaw).toEqual(aliceReward as uint128);
    expect(p.immediateRaw).toEqual(immediateOf(aliceReward) as uint128);
    expect(p.unlockedLockedRaw).toEqual(0);
    expect(claimTicket(env, alice, 1)).toHaveSuccessfulTx<TicketRequest>({ to: env.rc });
    expect(balanceOf(env, alice)).toEqual(MIN_STAKE * 3 + immediateOf(aliceReward));
    var t = ticketData(env, alice, 1);
    expect(t.principalDone).toEqual(true);
    expect(t.pending).toEqual(false);
    // nothing more claimable: the RC refuses, the bounce clears pending
    expect(claimTicket(env, alice, 1)).toHaveFailedTx<TicketRequest>({ to: env.rc, exitCode: Errors.NothingToClaim });
    expect(ticketData(env, alice, 1).pending).toEqual(false);

    // round 2 succeeds (nobody staked): round 1's locked 80% unlocks, team gets round 1's quota
    openNext(env, 0);
    observe(env, MIN_QUALIFIED);
    expect(balanceOf(env, env.teamWallet)).toEqual(TEAM_ROUND);
    expect(claimTicket(env, alice, 1)).toHaveSuccessfulTx<TicketRequest>({ to: env.rc });
    expect(balanceOf(env, alice)).toEqual(MIN_STAKE * 3 + aliceReward);
    expect(ticketData(env, alice, 1).lockedClaimedRaw).toEqual((aliceReward - immediateOf(aliceReward)) as uint128);
    expect(claimTicket(env, bob, 1)).toHaveSuccessfulTx<TicketRequest>({ to: env.rc });
    expect(balanceOf(env, bob)).toEqual(MIN_STAKE + ROUND_REWARD / 4);
}

get fun `test failure burns half the budget + team + principal and carries the other half`() {
    val env = setup();
    openNext(env, 0);
    val alice = user(env, "alice", MIN_STAKE * 2);
    stake(env, alice, 1, MIN_STAKE * 2);
    val supply = totalSupply(env);
    observe(env, MIN_QUALIFIED - 1);

    val rd = round(env, 1);
    expect(rd.status).toEqual(STATUS_FAILED_PERMANENT);
    expect(rd.rewardBurnConfirmed).toEqual(true);
    expect(totalSupply(env)).toEqual(supply - ROUND_REWARD / 2 - TEAM_ROUND - MIN_STAKE * 2);
    expect(pstate(env).carryRaw).toEqual((ROUND_REWARD / 2) as uint128);
    expect(round(env, 2).rewardBudgetRaw).toEqual((ROUND_REWARD + ROUND_REWARD / 2) as uint128); // preview shows it
    expect(claimTicket(env, alice, 1)).toHaveFailedTx<TicketRequest>({ to: env.rc, exitCode: Errors.NothingToClaim });
    openNext(env, 0);
    expect(round(env, 2).targetTier).toEqual(1);
    expect(round(env, 2).rewardBudgetRaw).toEqual((ROUND_REWARD + ROUND_REWARD / 2) as uint128);
    expect(pstate(env).carryRaw).toEqual(0);
}

get fun `test zero-stake success carries the whole budget and levels up`() {
    val env = setup();
    openNext(env, 0);
    val supply = totalSupply(env);
    observe(env, CANDLES);
    expect(round(env, 1).status).toEqual(STATUS_SUCCEEDED);
    expect(totalSupply(env)).toEqual(supply);
    expect(pstate(env).carryRaw).toEqual(ROUND_REWARD as uint128);
    openNext(env, 0);
    expect(round(env, 2).targetTier).toEqual(2);
    expect(round(env, 2).targetPriceUsdE8).toEqual(464000);
    expect(round(env, 2).rewardBudgetRaw).toEqual((ROUND_REWARD * 2) as uint128);
}

get fun `test zero-stake failure burns half the budget and the team quota`() {
    val env = setup();
    openNext(env, 0);
    val supply = totalSupply(env);
    observe(env, 0);
    expect(round(env, 1).status).toEqual(STATUS_FAILED_PERMANENT);
    expect(totalSupply(env)).toEqual(supply - ROUND_REWARD / 2 - TEAM_ROUND);
}

get fun `test observation timeout abort refunds principal via the ticket and carries the budget`() {
    val env = setup();
    openNext(env, 0);
    val alice = user(env, "alice", MIN_STAKE);
    stake(env, alice, 1, MIN_STAKE);
    val rd = round(env, 1);
    val abort = createMessage({ bounce: true, value: ton("0.1"), dest: env.rc, body: AbortTechnical { queryId: 1 } });
    advanceTo(rd.observationEnd + (ABORT_TIMEOUT as uint64) - 1);
    expect(net.send(alice, abort)).toHaveFailedTx<AbortTechnical>({ to: env.rc, exitCode: Errors.TooEarly });
    advanceTo(rd.observationEnd + (ABORT_TIMEOUT as uint64));
    val supply = totalSupply(env);
    expect(net.send(alice, abort)).toHaveSuccessfulTx<AbortTechnical>({ to: env.rc });
    expect(round(env, 1).status).toEqual(STATUS_TECHNICAL_ABORTED);
    expect(pstate(env).carryRaw).toEqual(ROUND_REWARD as uint128);
    expect(claimTicket(env, alice, 1)).toHaveSuccessfulTx<TicketRequest>({ to: env.rc });
    expect(balanceOf(env, alice)).toEqual(MIN_STAKE);
    expect(totalSupply(env)).toEqual(supply);
    openNext(env, 0);
    expect(round(env, 2).targetTier).toEqual(1);
    expect(round(env, 2).rewardBudgetRaw).toEqual((ROUND_REWARD * 2) as uint128);
}

get fun `test preview timeout abort advances past a dead keeper and carries that round's 7e8`() {
    val env = setup();
    openNext(env, 0);
    val alice = user(env, "alice", MIN_STAKE);
    stake(env, alice, 1, MIN_STAKE);
    observe(env, MIN_QUALIFIED);
    val next = round(env, 2);
    val abort = createMessage({ bounce: true, value: ton("0.1"), dest: env.rc, body: AbortTechnical { queryId: 1 } });
    advanceTo(next.stakeOpenAt + (ABORT_TIMEOUT as uint64));
    expect(net.send(env.treasury, abort)).toHaveSuccessfulTx<AbortTechnical>({ to: env.rc });
    expect(currentRound(env)).toEqual(2);
    expect(round(env, 2).status).toEqual(STATUS_TECHNICAL_ABORTED);
    expect(round(env, 3).status).toEqual(STATUS_PREVIEW);
    expect(pstate(env).carryRaw).toEqual(ROUND_REWARD as uint128);
}

get fun `test bounced settlement burn is retried by anyone`() {
    // RC wallet underfunded: the failure burn bounces.
    val env = setupWith(A9);
    openNext(env, 0);
    val supply = totalSupply(env);
    observe(env, 0);
    val rd = round(env, 1);
    expect(rd.status).toEqual(STATUS_FAILED_PERMANENT);
    expect(rd.rewardBurnConfirmed).toEqual(false);
    expect(totalSupply(env)).toEqual(supply);
    expect(round(env, 2).status).toEqual(STATUS_PREVIEW);

    val retry = createMessage({ bounce: true, value: ton("0.5"), dest: env.rc, body: RetrySettlement { queryId: 1, roundId: 1 } });
    transfer(env.treasury, env.treasuryWallet, env.rc, ROUND_REWARD + TEAM_ROUND, 0, emptyPayload(), ton("0.2"));
    expect(net.send(env.treasury, retry)).toHaveSuccessfulTx<RetrySettlement>({ to: env.rc });
    expect(totalSupply(env)).toEqual(supply - ROUND_REWARD / 2 - TEAM_ROUND);
    expect(round(env, 1).rewardBurnConfirmed).toEqual(true);
    expect(net.send(env.treasury, retry)).toHaveFailedTx<RetrySettlement>({ to: env.rc, exitCode: Errors.NothingToRetry });
}

get fun `test ticket claim needs enough TON and nothing is claimable while observing`() {
    val env = setup();
    openNext(env, 0);
    val alice = user(env, "alice", MIN_STAKE);
    stake(env, alice, 1, MIN_STAKE);
    expect(claimTicket(env, alice, 1)).toHaveFailedTx<TicketRequest>({ to: env.rc, exitCode: Errors.NothingToClaim });
    expect(ticketData(env, alice, 1).pending).toEqual(false);
    val cheap = createMessage({ bounce: true, value: ton("0.05"), dest: ticketOf(env, alice, 1), body: TicketClaim { queryId: 1 } });
    expect(net.send(alice, cheap)).toHaveFailedTx<TicketClaim>({ to: ticketOf(env, alice, 1), exitCode: Errors.NotEnoughValue });
}

get fun `test one-tap restake moves principal into the open round and pays the 20% now`() {
    val env = setup();
    openNext(env, 0);
    val alice = user(env, "alice", MIN_STAKE * 2);
    stake(env, alice, 1, MIN_STAKE * 2);
    observe(env, MIN_QUALIFIED);
    // round 2 is in PREVIEW: restake refused, ticket stays usable
    expect(restakeTicket(env, alice, 1)).toHaveFailedTx<TicketRequest>({ to: env.rc, exitCode: Errors.RestakeNotOpen });
    expect(ticketData(env, alice, 1).pending).toEqual(false);
    openNext(env, 0);
    advanceTo(round(env, 2).stakeOpenAt + (STAKE_WINDOW as uint64) / 3); // second third: x1.2
    expect(restakeTicket(env, alice, 1)).toHaveSuccessfulTx<TicketRequest>({ to: env.rc });
    expect(balanceOf(env, alice)).toEqual(immediateOf(ROUND_REWARD));
    expect(ticketData(env, alice, 1).principalDone).toEqual(true);
    val t2 = ticketData(env, alice, 2);
    expect(t2.amountRaw).toEqual((MIN_STAKE * 2) as uint128);
    expect(t2.weightRaw).toEqual((MIN_STAKE * 2 * 12000 / 10000) as uint128);
    expect(round(env, 2).totalAcceptedStakeRaw).toEqual((MIN_STAKE * 2) as uint128);
    // principal cannot be restaked twice
    expect(restakeTicket(env, alice, 1)).toHaveFailedTx<TicketRequest>({ to: env.rc, exitCode: Errors.NothingToClaim });
    // round 2 succeeds: principal + 20% of round 2, and round 1's locked 80% unlocks
    observe(env, MIN_QUALIFIED);
    expect(claimTicket(env, alice, 1)).toHaveSuccessfulTx<TicketRequest>({ to: env.rc });
    expect(claimTicket(env, alice, 2)).toHaveSuccessfulTx<TicketRequest>({ to: env.rc });
    expect(balanceOf(env, alice)).toEqual(ROUND_REWARD + MIN_STAKE * 2 + immediateOf(ROUND_REWARD));
}

get fun `test after round 10 the last locked reward unlocks linearly over 30 days`() {
    val env = setup();
    val alice = user(env, "alice", MIN_STAKE);
    var r: uint8 = 1;
    while (r <= MAX_ROUNDS) {
        openNext(env, 0);
        if (r == MAX_ROUNDS) {
            stake(env, alice, r, MIN_STAKE);
        }
        observe(env, r == MAX_ROUNDS ? MIN_QUALIFIED : 0);
        r += 1;
    }
    // each failure carries half its budget: b(n+1) = 7e8 + b(n)/2, converging to 14e8
    var b: coins = ROUND_REWARD;
    var k = 1;
    while (k < 10) {
        b = ROUND_REWARD + (b - b / 2);
        k += 1;
    }
    val budget = round(env, 10).rewardBudgetRaw;
    expect(budget).toEqual(b as uint128);
    val endAt = pstate(env).endAt;
    expect(endAt).toEqual(round(env, 10).settledAt);
    val locked = (budget as coins) - immediateOf(budget as coins);
    expect(claimTicket(env, alice, 10)).toHaveSuccessfulTx<TicketRequest>({ to: env.rc });
    expect(balanceOf(env, alice)).toEqual(MIN_STAKE + immediateOf(budget as coins));
    advanceTo(endAt + FALLBACK / 2);
    expect(claimTicket(env, alice, 10)).toHaveSuccessfulTx<TicketRequest>({ to: env.rc });
    expect(balanceOf(env, alice)).toEqual(MIN_STAKE + immediateOf(budget as coins) + locked / 2);
    advanceTo(endAt + FALLBACK);
    expect(claimTicket(env, alice, 10)).toHaveSuccessfulTx<TicketRequest>({ to: env.rc });
    expect(balanceOf(env, alice)).toEqual(MIN_STAKE + (budget as coins));
}

get fun `test ten rounds conserve every token: rewards, carry, burns, team quotas`() {
    val env = setup();
    val alice = user(env, "alice", MIN_STAKE * 10);
    val supply0 = totalSupply(env);
    var r: uint8 = 1;
    while (r <= MAX_ROUNDS) {
        openNext(env, 0);
        stake(env, alice, r, MIN_STAKE);
        // odd rounds succeed, even rounds fail
        observe(env, (r % 2 == 1) ? MIN_QUALIFIED : 0);
        r += 1;
    }
    expect(net.runGetMethod<uint8>(env.rc, "get_success_count")).toEqual(5);
    expect(openRound(env, env.keeper, 0)).toHaveFailedTx<OpenRound>({ to: env.rc, exitCode: Errors.MaxRoundsReached });
    // budgets: R1 7, R3/R5/R7/R9 10.5 paid = 49e8; burned: 4 x 3.5 + R10 7 = 21e8
    expect(round(env, 3).rewardBudgetRaw).toEqual((ROUND_REWARD * 3 / 2) as uint128);
    // team: R1/R3/R5/R7 quotas paid at the next success; R9's still pending
    expect(balanceOf(env, env.teamWallet)).toEqual(TEAM_ROUND * 4);
    expect(totalSupply(env)).toEqual(supply0 - ROUND_REWARD * 3 - TEAM_ROUND * 5 - MIN_STAKE * 5);

    val release = createMessage({ bounce: true, value: ton("0.2"), dest: env.rc, body: ReleaseTeam { queryId: 1 } });
    expect(net.send(alice, release)).toHaveFailedTx<ReleaseTeam>({ to: env.rc, exitCode: Errors.TooEarly });
    advanceTo(pstate(env).endAt + FALLBACK);
    r = 1;
    while (r <= MAX_ROUNDS) {
        if (r % 2 == 1) {
            expect(claimTicket(env, alice, r)).toHaveSuccessfulTx<TicketRequest>({ to: env.rc });
        }
        r += 1;
    }
    expect(net.send(alice, release)).toHaveSuccessfulTx<ReleaseTeam>({ to: env.rc });
    expect(net.send(alice, release)).toHaveFailedTx<ReleaseTeam>({ to: env.rc, exitCode: Errors.NothingToClaim });
    expect(balanceOf(env, env.teamWallet)).toEqual(TEAM_ROUND * 5);
    expect(balanceOf(env, alice)).toEqual(MIN_STAKE * 5 + ROUND_REWARD * 7);
    expect(balanceOf(env, env.rc)).toEqual(0);
}

get fun `test standard TEP-74 transfers with third-party response destination work (DEX payouts)`() {
    val env = setup();
    val router = user(env, "dex-router", MIN_STAKE);
    val buyer = testing.treasury("dex-buyer").address;
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

get fun `test RC storage does not grow with the number of stakers`() {
    val env = setup();
    openNext(env, 0);
    stake(env, user(env, "first", MIN_STAKE), 1, MIN_STAKE);
    val before = testing.getAccountState(env.rc)!.storageStat.used.cells;
    var i = 0;
    while (i < 100) {
        val u = address.fromWorkchainAndHash(0, 777000 + i * 1000003);
        transfer(env.treasury, env.treasuryWallet, u, MIN_STAKE, 0, emptyPayload(), ton("0.3"));
        stake(env, u, 1, MIN_STAKE);
        i += 1;
    }
    val after = testing.getAccountState(env.rc)!.storageStat.used.cells;
    expect(after).toEqual(before);
    expect(round(env, 1).totalAcceptedStakeRaw).toEqual((MIN_STAKE * 101) as uint128);
}
