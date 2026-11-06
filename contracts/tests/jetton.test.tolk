// Standard TEP-74 jetton with one-time 100e9 mint.
import "@acton/emulation/network"
import "@acton/emulation/testing"
import "@acton/testing/expect"
import "@contracts/jetton/storage"
import "helpers"

struct (0x595f07bc) AskToBurnMsg {
    queryId: uint64
    jettonAmount: coins
    sendExcessesTo: address?
    customPayload: cell?
}

get fun `test mint is one-shot and closes admin`() {
    val env = setup();
    expect(totalSupply(env)).toEqual(SUPPLY);
    val data = net.runGetMethod<JettonDataReply>(env.master, "get_jetton_data");
    expect(data.mintable).toEqual(false);
    expect(data.adminAddress == null).toEqual(true);
    expect(net.send(env.treasury, createMessage({
        bounce: true,
        value: ton("1"),
        dest: env.master,
        body: MintOnceMsg { queryId: 2, recipient: env.treasury, tonAmount: ton("0.3"), jettonAmount: SUPPLY, totalTonAmount: ton("0.5"), forwardPayload: emptyPayload() },
    }))).toHaveFailedTx<MintOnceMsg>({ to: env.master, exitCode: 75 });
}

get fun `test holder burn reduces total supply`() {
    val env = setup();
    val alice = user(env, "alice", MIN_STAKE);
    net.send(alice, createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: walletOf(env.master, alice),
        body: AskToBurnMsg { queryId: 1, jettonAmount: MIN_STAKE, sendExcessesTo: alice, customPayload: null },
    }));
    expect(balanceOf(env, alice)).toEqual(0);
    expect(totalSupply(env)).toEqual(SUPPLY - MIN_STAKE);
}

get fun `test non-owner cannot move a wallet`() {
    val env = setup();
    val alice = user(env, "alice", MIN_STAKE);
    val mallory = testing.treasury("mallory").address;
    expect(transfer(mallory, walletOf(env.master, alice), mallory, MIN_STAKE, 0, emptyPayload(), ton("0.2")))
        .toHaveFailedTx<AskToTransferMsg>({ exitCode: 73 });
    expect(balanceOf(env, alice)).toEqual(MIN_STAKE);
}
