// Send a raw opcode (decimal env A9_OP) to target for behavior probing.
import "@stdlib/strings"
import "@acton/build"
import "@acton/env"
import "@acton/emulation/network"
import "@acton/emulation/scripts"
import "@acton/io"
import "@acton/fmt"

fun main() {
    val target = env<address>("A9_TARGET_ADDRESS");
    val op = env<int>("A9_OP");
    if (target == null || op == null) { throw 400; }
    val signer = scripts.wallet(env<string>("A9_SIGNER_WALLET") ?? "a9-test-a");
    net.send(signer.address, createMessage({
        bounce: true,
        value: ton("0.05"),
        dest: target!,
        body: beginCell().storeUint(op!, 32).storeUint(0, 64).endCell().beginParse(),
    })).waitForTrace();
    println("probe op={} -> {}", op!, target);
}
