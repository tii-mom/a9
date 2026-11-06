// A9-F7 regression test.
import "@acton/emulation/network"
import "@acton/emulation/testing"
import "@acton/testing/expect"

import "@contracts/constants"
import "@contracts/types"
import "test-utils"

get fun `test F7 SetTeamWalletJettonWallet is locked after controller wiring`() {
    val f = setupProtocol();
    val other = testing.treasury("f7-other").address;
    expect(setTeamWalletJettonWallet(f.tv, f.admin, other)).toHaveFailedTx<SetTeamWalletJettonWallet>({
        from: f.admin, to: f.tv.address, exitCode: Errors.AlreadyInitialized,
    });
}
