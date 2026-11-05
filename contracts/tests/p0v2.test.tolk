// P0 follow-up / P1 / P2 regression tests (task-27).
import "@acton/emulation/network"
import "@acton/emulation/testing"
import "@acton/testing/expect"

import "@contracts/constants"
import "@contracts/types"
import "test-utils"

const AMOUNT: coins = 100000000000000;

fun hasPendingClaim(rc: RoundControllerHandle, queryId: uint64): bool {
    return net.runGetMethod<bool>(rc.address, "has_pending_claim", [queryId]);
}

fun openF(f: ProtocolFixture) {
    expect(openRound(f.rc, f.admin, 0)).toHaveSuccessfulTx<OpenRound>({ from: f.admin, to: f.rc.address });
}
fun stakeAccount(f: ProtocolFixture, roundId: uint8, owner: address, nonce: uint64) {
    expect(sendStake(f.rc, f.rcWallet.address, owner, AMOUNT, buildStakePayload(roundId, nonce, 1, 1)))
        .toHaveSuccessfulTx<TransferNotification>({ from: f.rcWallet.address, to: f.rc.address });
}
fun makeFailure(f: ProtocolFixture) {
    openF(f);
    val alice = testing.treasury("p0v2-alice");
    stakeAccount(f, 1, alice.address, 1);
    advance(STAKE_DURATION_SECONDS as int);
    expect(closeStaking(f.rc, f.admin, 0)).toHaveSuccessfulTx<CloseStaking>({ from: f.admin, to: f.rc.address });
    expect(startObservation(f.rc, f.keeper.address, 1)).toHaveSuccessfulTx<StartObservation>({ from: f.keeper.address, to: f.rc.address });
    submitAllCandles(f.rc, f.keeper.address, 1, 15, rcRound(f.rc, 1).targetPriceUsdE8);
    confirmTeamBurn(f, 1);
    expect(rcStatus(f.rc, 1)).toEqual(STATUS_SETTLING_FAILURE);
}

// P1-2: anyone can unstick SETTLING_* if they pay >= 0.3 TON
get fun `test P1-2 retry is permissionless with enough value`() {
    val f = setupProtocol();
    val alice = testing.treasury("p0v2-alice");
    makeFailure(f);
    expect(retryPendingActions(f.rc, alice.address, 1)).toHaveSuccessfulTx<RetryPendingActions>({
        from: alice.address,
        to: f.rc.address,
    });
}

get fun `test P1-2 retry below 0.3 TON is rejected`() {
    val f = setupProtocol();
    val alice = testing.treasury("p0v2-alice");
    makeFailure(f);
    val res = net.send(alice.address, createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: f.rc.address,
        body: RetryPendingActions { queryId: 0, roundId: 1 },
    }));
    expect(res).toHaveFailedTx<RetryPendingActions>({
        from: alice.address,
        to: f.rc.address,
        exitCode: Errors.BadConfig,
    });
}

// P2-1: at most one oracle pause per round
get fun `test P2-1 second pause in the same round is rejected`() {
    val f = setupProtocol();
    openF(f);
    advance(STAKE_DURATION_SECONDS as int);
    expect(closeStaking(f.rc, f.admin, 0)).toHaveSuccessfulTx<CloseStaking>({ from: f.admin, to: f.rc.address });
    expect(startObservation(f.rc, f.keeper.address, 1)).toHaveSuccessfulTx<StartObservation>({ from: f.keeper.address, to: f.rc.address });
    expect(pauseOracle(f.rc, f.oracle)).toHaveSuccessfulTx<PauseOracle>({ from: f.oracle, to: f.rc.address });
    expect(resumeOracle(f.rc, f.oracle)).toHaveSuccessfulTx<ResumeOracle>({ from: f.oracle, to: f.rc.address });
    expect(pauseOracle(f.rc, f.oracle)).toHaveFailedTx<PauseOracle>({
        from: f.oracle,
        to: f.rc.address,
        exitCode: Errors.BadRoundStatus,
    });
}

// P2-2: burn while release is pending must conflict
get fun `test P2-2 burn during pending release conflicts`() {
    val f = setupTeamVault((TEAM_ROUND_RAW * 2) as coins);
    setMockAutoAck(f.wallet, false);
    expect(sendRelease(f.vault, f.rc, 1)).toHaveSuccessfulTx<ReleaseTeamQuota>({ from: f.rc, to: f.vault.address });
    expect(teamRoundState(f.vault, 1).released).toBeFalse();
    expect(sendBurn(f.vault, f.rc, 1, 0x1234 as uint256)).toHaveFailedTx<BurnTeamQuota>({
        from: f.rc,
        to: f.vault.address,
        exitCode: Errors.TeamRoundConflict,
    });
}

// P1-1: tracked transfer carries 0.1 TON for the return hop
get fun `test P1-1 release transfer carries 0.1 TON`() {
    val f = setupTeamVault((TEAM_ROUND_RAW * 2) as coins);
    val before = testing.getAccountBalance(f.wallet.address);
    setMockAutoAck(f.wallet, false);
    expect(sendRelease(f.vault, f.rc, 1)).toHaveSuccessfulTx<ReleaseTeamQuota>({ from: f.rc, to: f.vault.address });
    val delta = testing.getAccountBalance(f.wallet.address) - before;
    expect(delta > ton("0.09")).toBeTrue();
}

// P0 regression: a foreign sender cannot clear a pending claim
get fun `test P0 foreign ReturnExcessesBack cannot settle a pending claim`() {
    val f = setupProtocol();
    val alice = testing.treasury("p0v2-alice");
    val attacker = testing.treasury("p0v2-attacker");
    openF(f);
    stakeAccount(f, 1, alice.address, 1);
    advance(STAKE_DURATION_SECONDS as int);
    expect(closeStaking(f.rc, f.admin, 0)).toHaveSuccessfulTx<CloseStaking>({ from: f.admin, to: f.rc.address });
    expect(startObservation(f.rc, f.keeper.address, 1)).toHaveSuccessfulTx<StartObservation>({ from: f.keeper.address, to: f.rc.address });
    submitAllCandles(f.rc, f.keeper.address, 1, 16, rcRound(f.rc, 1).targetPriceUsdE8);
    expect(finalizeRound(f.rc, f.keeper.address, 1)).toHaveSuccessfulTx<FinalizeRound>({ from: f.keeper.address, to: f.rc.address });

    setMockAutoAck(f.rcWallet, false);
    expect(claimPrincipal(f.rc, alice.address, 1)).toHaveSuccessfulTx<ClaimPrincipal>({ from: alice.address, to: f.rc.address });
    val q = ((1 as uint64) << 32) | ((CLAIM_KIND_PRINCIPAL as uint64) << 24);
    expect(hasPendingClaim(f.rc, q)).toBeTrue();
    val res = net.send(attacker.address, createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: f.rc.address,
        body: ReturnExcessesBack { queryId: q },
    }));
    expect(res).toHaveFailedTx<ReturnExcessesBack>({
        from: attacker.address,
        to: f.rc.address,
        exitCode: Errors.NotJettonMaster,
    });
    expect(hasPendingClaim(f.rc, q)).toBeTrue();
}
