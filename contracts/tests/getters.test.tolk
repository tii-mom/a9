// Read-only getters for deployment verification (task-30).
import "@acton/build"
import "@acton/emulation/network"
import "@acton/emulation/testing"
import "@acton/testing/expect"

import "@contracts/types"
import "test-utils"

get fun `test RC get_jetton_wallet_code_hash is 0 before wiring then returns code hash`() {
    val f = setupProtocol();
    expect(net.runGetMethod<uint256>(f.rc.address, "get_jetton_wallet_code_hash")).toEqual(0 as uint256);

    val code = build("JettonWallet");
    expect(setRcWalletCode(f.rc, f.admin, code)).toHaveSuccessfulTx<SetJettonWalletCode>({
        from: f.admin,
        to: f.rc.address,
    });
    expect(net.runGetMethod<uint256>(f.rc.address, "get_jetton_wallet_code_hash")).toEqual(code.hash());
}

get fun `test TV get_team_wallet_jetton_wallet updates after wiring`() {
    val admin = testing.treasury("getter-admin");
    val teamWallet = testing.treasury("getter-team");
    val master = testing.treasury("getter-master");
    val vault = deployTeamVault(admin.address, teamWallet.address, master.address);
    // placeholder until SetTeamWalletJettonWallet is called (controller still null)
    expect(net.runGetMethod<address>(vault.address, "get_team_wallet_jetton_wallet")).toEqual(admin.address);

    val wallet = testing.treasury("getter-team-wallet").address;
    expect(setTeamWalletJettonWallet(vault, admin.address, wallet)).toHaveSuccessfulTx<SetTeamWalletJettonWallet>({
        from: admin.address,
        to: vault.address,
    });
    expect(net.runGetMethod<address>(vault.address, "get_team_wallet_jetton_wallet")).toEqual(wallet);
}
