// Architecture-review fixes M-1 (escape hatches) and S-3 (TV release bounce).
import "@acton/emulation/network"
import "@acton/emulation/testing"
import "@acton/testing/expect"

import "@contracts/constants"
import "@contracts/types"
import "test-utils"

const AMOUNT: coins = 100000000000000;

fun openF(f: ProtocolFixture) {
    expect(openRound(f.rc, f.admin, 0)).toHaveSuccessfulTx<OpenRound>({ from: f.admin, to: f.rc.address });
}
fun stakeAccount(f: ProtocolFixture, roundId: uint8, owner: address, nonce: uint64) {
    expect(sendStake(f.rc, f.rcWallet.address, owner, AMOUNT, buildStakePayload(roundId, nonce, 1, 1)))
        .toHaveSuccessfulTx<TransferNotification>({ from: f.rcWallet.address, to: f.rc.address });
}
fun finishSuccess(f: ProtocolFixture, roundId: uint8) {
    advance(STAKE_DURATION_SECONDS as int);
    expect(closeStaking(f.rc, f.admin, 0)).toHaveSuccessfulTx<CloseStaking>({ from: f.admin, to: f.rc.address });
    expect(startObservation(f.rc, f.keeper.address, roundId)).toHaveSuccessfulTx<StartObservation>({ from: f.keeper.address, to: f.rc.address });
    submitAllCandles(f.rc, f.keeper.address, roundId, 16, rcRound(f.rc, roundId).targetPriceUsdE8);
    expect(finalizeRound(f.rc, f.keeper.address, roundId)).toHaveSuccessfulTx<FinalizeRound>({ from: f.keeper.address, to: f.rc.address });
}
fun currentRound(f: ProtocolFixture): uint8 {
    return net.runGetMethod<uint8>(f.rc.address, "get_current_round");
}

// ============================== M-1 ==============================

get fun `test M-1 natural staking close is permissionless`() {
    val f = setupProtocol();
    val outsider = testing.treasury("m1-outsider");
    openF(f);
    advance(STAKE_DURATION_SECONDS as int);
    expect(closeStaking(f.rc, outsider.address, 0)).toHaveSuccessfulTx<CloseStaking>({
        from: outsider.address,
        to: f.rc.address,
    });
    expect(rcStatus(f.rc, 1)).toEqual(STATUS_STAKING_CLOSED);
}

get fun `test M-1 early close still requires admin/oracle + twap`() {
    val f = setupProtocol();
    val outsider = testing.treasury("m1-outsider");
    openF(f);
    val target = rcRound(f.rc, 1).targetPriceUsdE8;
    expect(closeStaking(f.rc, outsider.address, target)).toHaveFailedTx<CloseStaking>({
        from: outsider.address,
        to: f.rc.address,
        exitCode: Errors.NotOracle,
    });
    expect(closeStaking(f.rc, f.admin, target)).toHaveSuccessfulTx<CloseStaking>({
        from: f.admin,
        to: f.rc.address,
    });
    expect(rcStatus(f.rc, 1)).toEqual(STATUS_STAKING_CLOSED);
}

get fun `test M-1 PREVIEW timeout escape releases rolled principal`() {
    val f = setupProtocol();
    val alice = testing.treasury("m1-alice");
    val outsider = testing.treasury("m1-outsider");
    openF(f);
    stakeAccount(f, 1, alice.address, 1);
    finishSuccess(f, 1);
    // roll into the next round while it is still PREVIEW
    expect(rollReward(f.rc, alice.address, 1)).toHaveSuccessfulTx<RollReward>({ from: alice.address, to: f.rc.address });
    expect(rcStatus(f.rc, 2)).toEqual(STATUS_PREVIEW);
    expect(currentRound(f)).toEqual(1);

    topUpForTimeJump(f, ton("500"));
    advance((PREVIEW_SECONDS as int) + (TECH_ABORT_PAUSE_SECONDS as int) + 1);
    expect(abortTechnical(f.rc, outsider.address)).toHaveSuccessfulTx<AbortTechnical>({
        from: outsider.address,
        to: f.rc.address,
    });
    // the pending preview becomes current and is aborted
    expect(currentRound(f)).toEqual(2);
    expect(rcStatus(f.rc, 2)).toEqual(STATUS_TECHNICAL_ABORTED);
    expect(claimPrincipal(f.rc, alice.address, 2)).toHaveSuccessfulTx<ClaimPrincipal>({
        from: alice.address,
        to: f.rc.address,
    });
    expect(rcUserStake(f.rc, 2, alice.address).principalClaimed).toBeTrue();
}

get fun `test M-1 STAKING_OPEN fallback can be aborted after timeout`() {
    val f = setupProtocol();
    val alice = testing.treasury("m1-alice");
    val outsider = testing.treasury("m1-outsider");
    openF(f);
    stakeAccount(f, 1, alice.address, 1);
    topUpForTimeJump(f, ton("500"));
    advance((STAKE_DURATION_SECONDS + TECH_ABORT_OBS_TIMEOUT_SECONDS) as int + 1);
    expect(abortTechnical(f.rc, outsider.address)).toHaveSuccessfulTx<AbortTechnical>({
        from: outsider.address,
        to: f.rc.address,
    });
    expect(rcStatus(f.rc, 1)).toEqual(STATUS_TECHNICAL_ABORTED);
    expect(claimPrincipal(f.rc, alice.address, 1)).toHaveSuccessfulTx<ClaimPrincipal>({
        from: alice.address,
        to: f.rc.address,
    });
}

// ============================== S-3 ==============================

get fun `test S-3 release confirms through ReturnExcesses and acks`() {
    val f = setupTeamVault((TEAM_ROUND_RAW * 2) as coins);
    val res = sendRelease(f.vault, f.rc, 1);
    expect(res).toHaveSuccessfulTx<ReleaseTeamQuota>({ from: f.rc, to: f.vault.address });
    val st = teamVaultState(f.vault);
    expect(st.totalReleasedRaw).toEqual(TEAM_ROUND_RAW);
    expect(st.releasedCount).toEqual(1);
    expect(teamRoundState(f.vault, 1).released).toBeTrue();
    expect(mockState(f.wallet).transferCount).toEqual(1);
    expect(res.findTransaction<TeamReleasedAck>({ from: f.vault.address, to: f.rc, success: true })).toBeNotNull();
}

get fun `test S-3 release bounce clears pending and can be retried`() {
    val f = setupTeamVault((TEAM_ROUND_RAW * 2) as coins);
    setMockAutoAck(f.wallet, false);
    val first = sendRelease(f.vault, f.rc, 1);
    expect(first).toHaveSuccessfulTx<ReleaseTeamQuota>({ from: f.rc, to: f.vault.address });
    // pending: no ack, no totals yet
    expect(teamVaultState(f.vault).totalReleasedRaw).toEqual(0 as uint128);
    expect(first.findTransaction<TeamReleasedAck>({ from: f.vault.address, to: f.rc, success: true })).toBeNull();

    bounceTeamRelease(f.vault, f.wallet.address, 1);
    expect(teamRoundState(f.vault, 1).amountRaw).toEqual(0 as uint128);
    expect(teamVaultState(f.vault).totalReleasedRaw).toEqual(0 as uint128);

    setMockAutoAck(f.wallet, true);
    val retry = sendRelease(f.vault, f.rc, 1);
    expect(retry).toHaveSuccessfulTx<ReleaseTeamQuota>({ from: f.rc, to: f.vault.address });
    expect(teamVaultState(f.vault).totalReleasedRaw).toEqual(TEAM_ROUND_RAW);
    expect(retry.findTransaction<TeamReleasedAck>({ from: f.vault.address, to: f.rc, success: true })).toBeNotNull();
}

get fun `test S-3 release duplicate after success is idempotent`() {
    val f = setupTeamVault((TEAM_ROUND_RAW * 2) as coins);
    expect(sendRelease(f.vault, f.rc, 2)).toHaveSuccessfulTx<ReleaseTeamQuota>({ from: f.rc, to: f.vault.address });
    val dup = sendRelease(f.vault, f.rc, 2);
    expect(dup).toHaveSuccessfulTx<ReleaseTeamQuota>({ from: f.rc, to: f.vault.address });
    expect(teamVaultState(f.vault).totalReleasedRaw).toEqual(TEAM_ROUND_RAW);
    expect(mockState(f.wallet).transferCount).toEqual(1);
    expect(dup.findTransaction<TeamReleasedAck>({ from: f.vault.address, to: f.rc, success: true })).toBeNotNull();
}
