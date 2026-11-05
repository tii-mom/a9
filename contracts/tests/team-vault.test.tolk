import "@acton/emulation/network"
import "@acton/emulation/testing"
import "@acton/testing/expect"
import "@acton/testing/assert"
import "@acton/tlb/either"
import "@acton/types/transaction"

import "@contracts/constants"
import "@contracts/types"
import "test-utils"

// ===========================================================================
// Deployment / initialization
// ===========================================================================

get fun `test TeamVault deploys with controller unset and correct params`() {
    val admin = testing.treasury("admin");
    val teamWallet = testing.treasury("team-wallet");
    val vault = deployTeamVault(admin.address, teamWallet.address);

    val st = teamVaultState(vault);
    expect(st.controller).toBeNull();
    expect(st.teamWallet).toEqual(teamWallet.address);
    expect(st.teamRoundRaw).toEqual(TEAM_ROUND_RAW);
    expect(st.totalReleasedRaw).toEqual(0 as uint128);
    expect(st.totalBurnedRaw).toEqual(0 as uint128);
}

get fun `test SetJettonWallet is admin-only and must precede InitController`() {
    val admin = testing.treasury("admin");
    val notAdmin = testing.treasury("not-admin");
    val teamWallet = testing.treasury("team-wallet");
    val vault = deployTeamVault(admin.address, teamWallet.address);
    val mockOwner = testing.treasury("mock-owner");
    val wallet = deployMockWallet(mockOwner.address, ton("0"));

    val bad = setTeamVaultWallet(vault, notAdmin.address, wallet.address);
    expect(bad).toHaveFailedTx<SetJettonWallet>({
        from: notAdmin.address,
        to: vault.address,
        exitCode: Errors.NotAdmin,
    });
    expect(setTeamVaultWallet(vault, admin.address, wallet.address)).toHaveSuccessfulTx<SetJettonWallet>({
        from: admin.address,
        to: vault.address,
    });
    expect(teamVaultState(vault).jettonWallet).toEqual(wallet.address);

    // after controller is wired, wallet address is immutable
    val rc = testing.treasury("rc");
    expect(sendInitController(vault, admin.address, rc.address)).toHaveSuccessfulTx<InitController>({
        from: admin.address,
        to: vault.address,
    });
    val late = setTeamVaultWallet(vault, admin.address, mockOwner.address);
    expect(late).toHaveFailedTx<SetJettonWallet>({
        from: admin.address,
        to: vault.address,
        exitCode: Errors.AlreadyInitialized,
    });
}

get fun `test InitController is admin-only and one-time`() {
    val admin = testing.treasury("admin");
    val notAdmin = testing.treasury("not-admin");
    val rc = testing.treasury("rc");
    val teamWallet = testing.treasury("team-wallet");
    val vault = deployTeamVault(admin.address, teamWallet.address);

    val r1 = sendInitController(vault, notAdmin.address, rc.address);
    expect(r1).toHaveFailedTx<InitController>({
        from: notAdmin.address,
        to: vault.address,
        exitCode: Errors.NotAdmin,
    });
    expect(teamVaultState(vault).controller).toBeNull();

    expect(sendInitController(vault, admin.address, rc.address)).toHaveSuccessfulTx<InitController>({
        from: admin.address,
        to: vault.address,
    });
    expect(teamVaultState(vault).controller).toEqual(rc.address);

    val r3 = sendInitController(vault, admin.address, notAdmin.address);
    expect(r3).toHaveFailedTx<InitController>({
        from: admin.address,
        to: vault.address,
        exitCode: Errors.AlreadyInitialized,
    });
    expect(teamVaultState(vault).controller).toEqual(rc.address);
}

// ===========================================================================
// Authorization
// ===========================================================================

get fun `test non-controller cannot release or burn`() {
    val f = setupTeamVault(TEAM_ROUND_RAW as coins);
    val attacker = testing.treasury("attacker");

    expect(sendRelease(f.vault, attacker.address, 1)).toHaveFailedTx<ReleaseTeamQuota>({
        from: attacker.address,
        to: f.vault.address,
        exitCode: Errors.NotController,
    });
    expect(sendBurn(f.vault, attacker.address, 1, 0xdead as uint256)).toHaveFailedTx<BurnTeamQuota>({
        from: attacker.address,
        to: f.vault.address,
        exitCode: Errors.NotController,
    });

    val st = teamVaultState(f.vault);
    expect(st.totalReleasedRaw).toEqual(0 as uint128);
    expect(st.totalBurnedRaw).toEqual(0 as uint128);
    expect(mockState(f.wallet).transferCount).toEqual(0);
    expect(mockState(f.wallet).burnCount).toEqual(0);
}

get fun `test release before initialization is rejected`() {
    val admin = testing.treasury("admin");
    val teamWallet = testing.treasury("team-wallet");
    val vault = deployTeamVault(admin.address, teamWallet.address);
    val wallet = deployMockWallet(vault.address, TEAM_ROUND_RAW as coins);
    expect(setTeamVaultWallet(vault, admin.address, wallet.address)).toHaveSuccessfulTx<SetJettonWallet>({
        from: admin.address,
        to: vault.address,
    });

    expect(sendRelease(vault, admin.address, 1)).toHaveFailedTx<ReleaseTeamQuota>({
        from: admin.address,
        to: vault.address,
        exitCode: Errors.NotInitialized,
    });
}

// ===========================================================================
// Release
// ===========================================================================

get fun `test release round 1 transfers exactly 1.2e8 and acknowledges`() {
    val f = setupTeamVault(TEAM_ROUND_RAW as coins);
    val res = sendRelease(f.vault, f.rc, 1);
    expect(res).toHaveSuccessfulTx<ReleaseTeamQuota>({ from: f.rc, to: f.vault.address });

    val st = teamVaultState(f.vault);
    expect(st.totalReleasedRaw).toEqual(TEAM_ROUND_RAW);
    expect(st.releasedCount).toEqual(1);
    expect(st.totalBurnedRaw).toEqual(0 as uint128);

    val rs = teamRoundState(f.vault, 1);
    expect(rs.released).toBeTrue();
    expect(rs.burned).toBeFalse();
    expect(rs.amountRaw).toEqual(TEAM_ROUND_RAW);

    val ms = mockState(f.wallet);
    expect(ms.transferCount).toEqual(1);
    expect(ms.lastTransferDest).toEqual(f.teamWallet);
    expect(ms.lastTransferAmount).toEqual(TEAM_ROUND_RAW as coins);
    expect(ms.balance).toEqual(0 as coins);

    val ackTx = res.findTransaction<TeamReleasedAck>({
        from: f.vault.address,
        to: f.rc,
        success: true,
    });
    expect(ackTx).toBeNotNull();
    val ack = ackTx!.loadBody<TeamReleasedAck>();
    expect(ack.roundId).toEqual(1);
    expect(ack.amountRaw).toEqual(TEAM_ROUND_RAW);

    val ev = res.findExternalOutMessage<TeamReleased>({ from: f.vault.address });
    expect(ev).toBeNotNull();
    if (ev != null) {
        val body = match (ev!.body) {
            TlbEitherLeft => ev!.body.value,
            TlbEitherRight => {
                Assert.fail("expected inline external-out body");
            },
        };
        expect(body.roundId).toEqual(1);
        expect(body.amountRaw).toEqual(TEAM_ROUND_RAW);
        expect(body.to).toEqual(f.teamWallet);
    }
}

get fun `test duplicate release is idempotent (no second transfer)`() {
    val f = setupTeamVault((TEAM_ROUND_RAW * 2) as coins);
    expect(sendRelease(f.vault, f.rc, 1)).toHaveSuccessfulTx<ReleaseTeamQuota>({
        from: f.rc,
        to: f.vault.address,
    });
    val res2 = sendRelease(f.vault, f.rc, 1);
    expect(res2).toHaveSuccessfulTx<ReleaseTeamQuota>({ from: f.rc, to: f.vault.address });

    val st = teamVaultState(f.vault);
    expect(st.totalReleasedRaw).toEqual(TEAM_ROUND_RAW);
    expect(st.releasedCount).toEqual(1);
    expect(mockState(f.wallet).transferCount).toEqual(1);

    val ackTx = res2.findTransaction<TeamReleasedAck>({
        from: f.vault.address,
        to: f.rc,
        success: true,
    });
    expect(ackTx).toBeNotNull();
}

// ===========================================================================
// Burn
// ===========================================================================

get fun `test burn round 2 burns exactly 1.2e8 and acknowledges`() {
    val f = setupTeamVault(TEAM_ROUND_RAW as coins);
    val burnId = 0x1234 as uint256;
    val res = sendBurn(f.vault, f.rc, 2, burnId);
    expect(res).toHaveSuccessfulTx<BurnTeamQuota>({ from: f.rc, to: f.vault.address });

    val st = teamVaultState(f.vault);
    expect(st.totalBurnedRaw).toEqual(TEAM_ROUND_RAW);
    expect(st.burnedCount).toEqual(1);
    expect(st.totalReleasedRaw).toEqual(0 as uint128);

    val ms = mockState(f.wallet);
    expect(ms.burnCount).toEqual(1);
    expect(ms.lastBurnAmount).toEqual(TEAM_ROUND_RAW as coins);
    expect(ms.balance).toEqual(0 as coins);

    val ackTx = res.findTransaction<TeamBurnedAck>({
        from: f.vault.address,
        to: f.rc,
        success: true,
    });
    expect(ackTx).toBeNotNull();
    val ack = ackTx!.loadBody<TeamBurnedAck>();
    expect(ack.roundId).toEqual(2);
    expect(ack.amountRaw).toEqual(TEAM_ROUND_RAW);
    expect(ack.burnId).toEqual(burnId);

    val ev = res.findExternalOutMessage<TeamBurned>({ from: f.vault.address });
    expect(ev).toBeNotNull();
    if (ev != null) {
        val body = match (ev!.body) {
            TlbEitherLeft => ev!.body.value,
            TlbEitherRight => {
                Assert.fail("expected inline external-out body");
            },
        };
        expect(body.roundId).toEqual(2);
        expect(body.amountRaw).toEqual(TEAM_ROUND_RAW);
        expect(body.burnId).toEqual(burnId);
    }
}

get fun `test duplicate burn is idempotent (no second burn)`() {
    val f = setupTeamVault((TEAM_ROUND_RAW * 2) as coins);
    val burnId = 0x55 as uint256;
    expect(sendBurn(f.vault, f.rc, 3, burnId)).toHaveSuccessfulTx<BurnTeamQuota>({
        from: f.rc,
        to: f.vault.address,
    });
    expect(sendBurn(f.vault, f.rc, 3, burnId)).toHaveSuccessfulTx<BurnTeamQuota>({
        from: f.rc,
        to: f.vault.address,
    });

    val st = teamVaultState(f.vault);
    expect(st.totalBurnedRaw).toEqual(TEAM_ROUND_RAW);
    expect(st.burnedCount).toEqual(1);
    expect(mockState(f.wallet).burnCount).toEqual(1);
}

// ===========================================================================
// Mutual exclusion
// ===========================================================================

get fun `test release then burn on the same round is rejected`() {
    val f = setupTeamVault((TEAM_ROUND_RAW * 2) as coins);
    expect(sendRelease(f.vault, f.rc, 4)).toHaveSuccessfulTx<ReleaseTeamQuota>({
        from: f.rc,
        to: f.vault.address,
    });
    expect(sendBurn(f.vault, f.rc, 4, 0x99 as uint256)).toHaveFailedTx<BurnTeamQuota>({
        from: f.rc,
        to: f.vault.address,
        exitCode: Errors.TeamRoundConflict,
    });

    val st = teamVaultState(f.vault);
    expect(st.totalReleasedRaw).toEqual(TEAM_ROUND_RAW);
    expect(st.totalBurnedRaw).toEqual(0 as uint128);
    expect(mockState(f.wallet).burnCount).toEqual(0);
}

get fun `test burn then release on the same round is rejected`() {
    val f = setupTeamVault((TEAM_ROUND_RAW * 2) as coins);
    expect(sendBurn(f.vault, f.rc, 5, 0x77 as uint256)).toHaveSuccessfulTx<BurnTeamQuota>({
        from: f.rc,
        to: f.vault.address,
    });
    expect(sendRelease(f.vault, f.rc, 5)).toHaveFailedTx<ReleaseTeamQuota>({
        from: f.rc,
        to: f.vault.address,
        exitCode: Errors.TeamRoundConflict,
    });
    expect(mockState(f.wallet).transferCount).toEqual(0);
}

// ===========================================================================
// Round range + totals
// ===========================================================================

get fun `test round id must be 1..10`() {
    val f = setupTeamVault(TEAM_ROUND_RAW as coins);
    expect(sendRelease(f.vault, f.rc, 0)).toHaveFailedTx<ReleaseTeamQuota>({
        from: f.rc,
        to: f.vault.address,
        exitCode: Errors.BadRoundId,
    });
    expect(sendRelease(f.vault, f.rc, 11)).toHaveFailedTx<ReleaseTeamQuota>({
        from: f.rc,
        to: f.vault.address,
        exitCode: Errors.BadRoundId,
    });
}

get fun `test ten rounds: release 5 + burn 5 = 12e8 total`() {
    val f = setupTeamVault((TEAM_ROUND_RAW * 10) as coins);
    var i: uint8 = 1;
    while (i <= 10) {
        if (i <= 5) {
            expect(sendRelease(f.vault, f.rc, i)).toHaveSuccessfulTx<ReleaseTeamQuota>({
                from: f.rc,
                to: f.vault.address,
            });
        } else {
            expect(sendBurn(f.vault, f.rc, i, i as uint256)).toHaveSuccessfulTx<BurnTeamQuota>({
                from: f.rc,
                to: f.vault.address,
            });
        }
        i += 1;
    }

    val st = teamVaultState(f.vault);
    expect(st.totalReleasedRaw).toEqual(TEAM_ROUND_RAW * 5);
    expect(st.totalBurnedRaw).toEqual(TEAM_ROUND_RAW * 5);
    expect(st.releasedCount).toEqual(5);
    expect(st.burnedCount).toEqual(5);
    expect(mockState(f.wallet).transferCount).toEqual(5);
    expect(mockState(f.wallet).burnCount).toEqual(5);
    expect(mockState(f.wallet).balance).toEqual(0 as coins);
}
