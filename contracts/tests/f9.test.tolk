// A9-F9 regression test.
import "@acton/emulation/network"
import "@acton/emulation/testing"
import "@acton/testing/expect"
import "@contracts/constants"
import "@contracts/types"
import "test-utils"

get fun `test F9 open round always anchors a full 36h staking window`() {
    val f = setupProtocol();
    val alice = testing.treasury("f9-alice");
    expect(openRound(f.rc, f.admin, 0)).toHaveSuccessfulTx<OpenRound>({ from: f.admin, to: f.rc.address });
    expect(sendStake(f.rc, f.rcWallet.address, alice.address, 100000000000000 as coins, buildStakePayload(1, 1, 1, 1)))
        .toHaveSuccessfulTx<TransferNotification>({ from: f.rcWallet.address, to: f.rc.address });
    advance(STAKE_DURATION_SECONDS as int);
    expect(closeStaking(f.rc, f.admin, 0)).toHaveSuccessfulTx<CloseStaking>({ from: f.admin, to: f.rc.address });
    expect(startObservation(f.rc, f.keeper.address, 1)).toHaveSuccessfulTx<StartObservation>({ from: f.keeper.address, to: f.rc.address });
    submitAllCandles(f.rc, f.keeper.address, 1, 16, rcRound(f.rc, 1).targetPriceUsdE8);
    expect(finalizeRound(f.rc, f.keeper.address, 1)).toHaveSuccessfulTx<FinalizeRound>({ from: f.keeper.address, to: f.rc.address });

    // R2 is PREVIEW; open it ~35h late
    advance((PREVIEW_SECONDS as int) + 35 * 3600);
    expect(openRound(f.rc, f.admin, 0)).toHaveSuccessfulTx<OpenRound>({ from: f.admin, to: f.rc.address });
    val rd = rcRound(f.rc, 2);
    expect(rd.stakeCloseAt - rd.stakeOpenAt).toEqual(STAKE_DURATION_SECONDS as uint64);
}
