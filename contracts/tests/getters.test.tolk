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
    val f = setupTeamVault((TEAM_ROUND_RAW * 2) as coins);
    // placeholder until SetTeamWalletJettonWallet is called
    expect(net.runGetMethod<address>(f.vault.address, "get_team_wallet_jetton_wallet")).toEqual(f.admin);

    val wallet = testing.treasury("getter-team-wallet").address;
    expect(setTeamWalletJettonWallet(f.vault, f.admin, wallet)).toHaveSuccessfulTx<SetTeamWalletJettonWallet>({
        from: f.admin,
        to: f.vault.address,
    });
    expect(net.runGetMethod<address>(f.vault.address, "get_team_wallet_jetton_wallet")).toEqual(wallet);
}
