// A9-F6: inbound TON minimum checks for claims.
import "@acton/emulation/network"
import "@acton/emulation/testing"
import "@acton/testing/expect"

import "@contracts/constants"
import "@contracts/types"
import "test-utils"

get fun `test F6 low-value ClaimPrincipal is rejected before any state change`() {
    val f = setupProtocol();
    val alice = testing.treasury("f6-alice");
    openRound(f.rc, f.admin, 0);
    expect(sendStake(f.rc, f.rcWallet.address, alice.address, 100000000000000 as coins, buildStakePayload(1, 1, 1, 1)))
        .toHaveSuccessfulTx<TransferNotification>({ from: f.rcWallet.address, to: f.rc.address });
    advance(STAKE_DURATION_SECONDS as int);
    expect(closeStaking(f.rc, f.admin, 0)).toHaveSuccessfulTx<CloseStaking>({ from: f.admin, to: f.rc.address });
    expect(startObservation(f.rc, f.keeper.address, 1)).toHaveSuccessfulTx<StartObservation>({ from: f.keeper.address, to: f.rc.address });
    submitAllCandles(f.rc, f.keeper.address, 1, 16, rcRound(f.rc, 1).targetPriceUsdE8);
    expect(finalizeRound(f.rc, f.keeper.address, 1)).toHaveSuccessfulTx<FinalizeRound>({ from: f.keeper.address, to: f.rc.address });

    val low = net.send(alice.address, createMessage({
        bounce: true, value: ton("0.01"), dest: f.rc.address,
        body: ClaimPrincipal { queryId: 0, roundId: 1 },
    }));
    expect(low).toHaveFailedTx<ClaimPrincipal>({
        from: alice.address, to: f.rc.address, exitCode: Errors.BadConfig,
    });
    expect(rcUserStake(f.rc, 1, alice.address).principalClaimed).toBeFalse();
    // enough gas still works
    expect(claimPrincipal(f.rc, alice.address, 1)).toHaveSuccessfulTx<ClaimPrincipal>({
        from: alice.address, to: f.rc.address,
    });
}

get fun `test F6 low-value ClaimAll and ClaimUnlocked are rejected`() {
    val f = setupProtocol();
    val alice = testing.treasury("f6-alice");
    openRound(f.rc, f.admin, 0);
    expect(sendStake(f.rc, f.rcWallet.address, alice.address, 100000000000000 as coins, buildStakePayload(1, 1, 1, 1)))
        .toHaveSuccessfulTx<TransferNotification>({ from: f.rcWallet.address, to: f.rc.address });
    advance(STAKE_DURATION_SECONDS as int);
    expect(closeStaking(f.rc, f.admin, 0)).toHaveSuccessfulTx<CloseStaking>({ from: f.admin, to: f.rc.address });
    expect(startObservation(f.rc, f.keeper.address, 1)).toHaveSuccessfulTx<StartObservation>({ from: f.keeper.address, to: f.rc.address });
    submitAllCandles(f.rc, f.keeper.address, 1, 16, rcRound(f.rc, 1).targetPriceUsdE8);
    expect(finalizeRound(f.rc, f.keeper.address, 1)).toHaveSuccessfulTx<FinalizeRound>({ from: f.keeper.address, to: f.rc.address });

    val lowAll = net.send(alice.address, createMessage({
        bounce: true, value: ton("0.01"), dest: f.rc.address,
        body: ClaimAll { queryId: 0, roundId: 0 },
    }));
    expect(lowAll).toHaveFailedTx<ClaimAll>({
        from: alice.address, to: f.rc.address, exitCode: Errors.BadConfig,
    });
    val lowUnlock = net.send(alice.address, createMessage({
        bounce: true, value: ton("0.01"), dest: f.rc.address,
        body: ClaimUnlocked { queryId: 0 },
    }));
    expect(lowUnlock).toHaveFailedTx<ClaimUnlocked>({
        from: alice.address, to: f.rc.address, exitCode: Errors.BadConfig,
    });
}
