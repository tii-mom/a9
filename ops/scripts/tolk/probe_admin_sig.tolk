// Probe: a brand-new Acton v4r2 wallet can sign an outgoing transfer (self TopUp).
import "@stdlib/strings"
import "@acton/build"
import "@acton/env"
import "@acton/emulation/network"
import "@acton/emulation/scripts"
import "@acton/io"
import "@acton/fmt"
import "@contracts/types"

fun main() {
    val signer = scripts.wallet(env<string>("A9_SIGNER_WALLET") ?? "a9-01-admin");
    net.send(signer.address, createMessage({
        bounce: false,
        value: ton("0.01"),
        dest: signer.address,
        body: TopUpTons {},
    })).waitForTrace();
    println("signed self-transfer from {} ok", signer.address);
}
