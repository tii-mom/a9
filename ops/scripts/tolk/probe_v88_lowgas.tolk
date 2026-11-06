// v8.8 M4 attack probe: invalid stake (version=2) with forward TON 0.05 < 0.12 -> refundStake -> round0 ledger.
import "@stdlib/strings"
import "@acton/build"
import "@acton/env"
import "@acton/emulation/network"
import "@acton/emulation/scripts"
import "@acton/io"
import "@acton/fmt"
import "@contracts/types"

fun main() {
    val master = env<address>("JETTON_MASTER_ADDRESS");
    val rc = env<address>("ROUND_CONTROLLER_ADDRESS");
    if (master == null || rc == null) { throw 400; }
    val signer = scripts.wallet(env<string>("A9_SIGNER_WALLET") ?? "a9-test-a");
    val wallet = net.runGetMethod<address>(master!, "get_wallet_address", [signer.address]);
    val payload = beginCell()
        .storeUint(0, 1)
        .storeUint(0x5254000F, 32)
        .storeUint(2, 8)     // invalid version -> refundStake
        .storeUint(1, 8)
        .storeUint(910200, 64)
        .storeUint(1, 16)
        .storeUint(1, 8)
        .toSlice();
    net.send(signer.address, createMessage({
        bounce: true,
        value: ton("0.2"),
        dest: wallet,
        body: AskToTransfer {
            queryId: 910200,
            jettonAmount: 200000000000000,
            transferRecipient: rc!,
            sendExcessesTo: signer.address,
            customPayload: null,
            forwardTonAmount: ton("0.05"),
            forwardPayload: payload,
        },
    }));
    println("M4 Y=200k sent");
}
