// F1: ordinary wallet sends AskToTransfer to RC's JettonWallet with sendExcessesTo=RC; expect NotOwner.
import "@stdlib/strings"
import "@acton/build"
import "@acton/env"
import "@acton/emulation/network"
import "@acton/emulation/scripts"
import "@acton/io"
import "@acton/fmt"
import "@contracts/types"

fun main() {
    val wallet = env<address>("A9_RC_JETTON_WALLET");
    val rc = env<address>("ROUND_CONTROLLER_ADDRESS");
    if (wallet == null || rc == null) { throw 400; }
    val signer = scripts.wallet(env<string>("A9_SIGNER_WALLET") ?? "a9-test-a");
    net.send(signer.address, createMessage({
        bounce: true,
        value: ton("0.1"),
        dest: wallet!,
        body: AskToTransfer {
            queryId: 0,
            jettonAmount: 1,
            transferRecipient: rc!,
            sendExcessesTo: rc,
            customPayload: null,
            forwardTonAmount: 0,
            forwardPayload: beginCell().storeUint(0, 1).toSlice(),
        },
    }));
    println("F1 probe sent to {}", wallet);
}
